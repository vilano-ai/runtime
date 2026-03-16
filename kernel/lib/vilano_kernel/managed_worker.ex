defmodule VilanoKernel.ManagedWorker do
  @moduledoc false

  use GenServer

  require Logger

  alias VilanoKernel.Storage

  @idle_poll_ms 100
  @restart_backoff_ms 200

  def start_link(index) when is_integer(index) do
    GenServer.start_link(__MODULE__, index, name: via_name(index))
  end

  def kill_worker(worker_id, reason \\ :requested)

  def kill_worker("managed-local-" <> _rest = worker_id, reason) do
    case managed_worker_index(worker_id) do
      {:ok, index} ->
        via_name(index)
        |> GenServer.whereis()
        |> case do
          nil -> :not_found
          pid -> GenServer.call(pid, {:kill_worker, worker_id, reason}, 5_000)
        end

      _ ->
        :unmanaged
    end
  end

  def kill_worker(_worker_id, _reason), do: :unmanaged

  def child_spec(index) do
    %{
      id: {:managed_worker, index},
      start: {__MODULE__, :start_link, [index]},
      restart: :permanent,
      shutdown: 5_000,
      type: :worker
    }
  end

  @impl true
  def init(index) do
    Process.flag(:trap_exit, true)

    runtime = Application.fetch_env!(:vilano_kernel, :runtime)
    worker_runtime = runtime.managed_worker_runtime || "bun"
    worker_mode = normalize_managed_worker_mode(runtime.managed_worker_mode)
    worker_root_dir = Path.join([runtime.project_root, "worker"])
    worker_source_dir = Path.join([worker_root_dir, worker_runtime, "src"])
    worker_entry = Path.join(worker_source_dir, "cli.ts")
    shared_source_dir = Path.join([worker_root_dir, "shared", "src"])
    executable = runtime_executable(runtime, worker_runtime)

    case {executable, File.exists?(worker_entry), File.exists?(shared_source_dir)} do
      {nil, _, _} ->
        Logger.warning(
          "Managed worker #{index} not started because '#{worker_runtime}' is not available on PATH"
        )

        :ignore

      {_runtime_path, false, _} ->
        Logger.warning(
          "Managed worker #{index} not started because #{worker_entry} does not exist"
        )

        :ignore

      {_runtime_path, _, false} ->
        Logger.warning(
          "Managed worker #{index} not started because #{shared_source_dir} does not exist"
        )

        :ignore

      {runtime_path, true, true} ->
        cached_worker_entry =
          materialize_worker_entry!(runtime.home_dir, worker_root_dir, worker_runtime)

        state = %{
          index: index,
          runtime: runtime,
          worker_runtime: worker_runtime,
          worker_mode: worker_mode,
          runtime_path: runtime_path,
          worker_entry: cached_worker_entry,
          port: nil,
          os_pid: nil,
          worker_id: nil,
          generation: 0,
          poll_timer: nil
        }

        next_state =
          case worker_mode do
            "pooled" -> spawn_worker(state)
            _ -> schedule_poll(state, 0)
          end

        {:ok, next_state}
    end
  end

  @impl true
  def handle_info({_port, {:data, _data}}, state) do
    {:noreply, state}
  end

  @impl true
  def handle_info(:maybe_spawn, state) do
    next_state = %{state | poll_timer: nil}
    updated_state =
      try do
        cond do
          is_port(next_state.port) ->
            next_state

          next_state.worker_mode == "pooled" ->
            spawn_worker(next_state)

          runnable_activation_available?() ->
            spawn_worker(next_state)

          true ->
            schedule_poll(next_state, @idle_poll_ms)
        end
      rescue
        _error ->
          schedule_poll(next_state, @idle_poll_ms)
      end

    {:noreply, updated_state}
  end

  def handle_info({port, {:exit_status, status}}, %{port: current_port} = state)
      when is_port(port) and port == current_port do
    if status != 0 or state.worker_mode == "pooled" do
      Logger.warning(
        "Managed worker #{state.index} (#{state.worker_id || "unknown"}) exited with status #{status}"
      )
    end

    next_state =
      state
      |> clear_worker()
      |> schedule_poll(exit_poll_delay_ms(state.worker_mode, status))

    {:noreply, next_state}
  end

  def handle_info(_message, state) do
    {:noreply, state}
  end

  @impl true
  def handle_call({:kill_worker, worker_id, reason}, _from, state) do
    cond do
      worker_id != state.worker_id ->
        {:reply, :stale, state}

      true ->
        Logger.warning(
          "Managed worker #{state.index} terminating #{worker_id} due to #{inspect(reason)}"
        )

        next_state =
          state
          |> clear_worker("-KILL")
          |> schedule_poll(@restart_backoff_ms)

        {:reply, :ok, next_state}
    end
  end

  @impl true
  def terminate(_reason, state) do
    _ = cancel_poll(state)
    _ = clear_worker(state)
    :ok
  end

  defp via_name(index), do: String.to_atom("vilano_managed_worker_#{index}")

  defp spawn_worker(%{port: port} = state) when is_port(port), do: state

  defp spawn_worker(state) do
    worker_id = next_worker_id(state)

    port =
      start_port(
        state.runtime_path,
        state.worker_entry,
        state.runtime,
        worker_id,
        state.worker_mode == "per_activation"
      )

    state
    |> cancel_poll()
    |> Map.merge(%{
      port: port,
      os_pid: port_os_pid(port),
      worker_id: worker_id,
      generation: state.generation + 1
    })
  end

  defp start_port(executable_path, worker_entry, runtime, worker_id, once?) do
    server_url = "http://127.0.0.1:#{runtime.port}"
    worker_home = Path.join(runtime.execution_home_dir, "worker-home")

    File.mkdir_p!(worker_home)

    args =
      [worker_entry, "--server", server_url, "--worker-id", worker_id] ++
        if(once?, do: ["--once"], else: [])

    Port.open(
      {:spawn_executable, String.to_charlist(executable_path)},
      [
        :binary,
        :use_stdio,
        :stderr_to_stdout,
        :exit_status,
        :hide,
        {:cd, String.to_charlist(worker_home)},
        {:env, worker_env(runtime)},
        {:args, Enum.map(args, &String.to_charlist/1)}
      ]
    )
  end

  defp worker_env(runtime) do
    base_env = [
      {~c"VILANO_WORKER_ARTIFACT_HOME", String.to_charlist(runtime.artifact_home_dir)},
      {~c"VILANO_WORKER_HOME",
       String.to_charlist(Path.join(runtime.execution_home_dir, "worker-home"))},
      {~c"VILANO_KERNEL_PORT", String.to_charlist(Integer.to_string(runtime.port))}
    ]

    case runtime.worker_auth_token do
      token when is_binary(token) and token != "" ->
        [{~c"VILANO_WORKER_TOKEN", String.to_charlist(token)} | base_env]

      _ ->
        base_env
    end
  end

  defp materialize_worker_entry!(home_dir, worker_root_dir, worker_runtime) do
    version = worker_source_version(worker_root_dir)
    cache_root = Path.join([home_dir, "runtime-cache", "managed-workers", version])
    cached_worker_root_dir = Path.join([cache_root, "worker"])

    unless File.exists?(cached_worker_root_dir) do
      File.mkdir_p!(Path.dirname(cached_worker_root_dir))
      File.cp_r!(worker_root_dir, cached_worker_root_dir)
    end

    Path.join([cached_worker_root_dir, worker_runtime, "src", "cli.ts"])
  end

  defp worker_source_version(worker_root_dir) do
    digest =
      worker_root_dir
      |> list_worker_files!()
      |> Enum.sort()
      |> Enum.reduce(:crypto.hash_init(:sha256), fn relative_path, hash ->
        path = Path.join(worker_root_dir, relative_path)

        contents =
          case File.read(path) do
            {:ok, binary} -> binary
            {:error, reason} -> "missing:#{inspect(reason)}"
          end

        hash
        |> :crypto.hash_update(relative_path)
        |> :crypto.hash_update(<<0>>)
        |> :crypto.hash_update(contents)
        |> :crypto.hash_update(<<0>>)
      end)
      |> :crypto.hash_final()

    digest
    |> Base.encode16(case: :lower)
    |> binary_part(0, 16)
  end

  defp list_worker_files!(worker_root_dir) do
    worker_root_dir
    |> Path.join("**/*")
    |> Path.wildcard(match_dot: true)
    |> Enum.filter(&File.regular?/1)
    |> Enum.map(&Path.relative_to(&1, worker_root_dir))
  end

  defp port_os_pid(port) do
    case Port.info(port, :os_pid) do
      {:os_pid, os_pid} when is_integer(os_pid) -> os_pid
      _ -> nil
    end
  end

  defp clear_worker(state, signal \\ "-TERM") do
    maybe_kill_os_process(state[:os_pid], signal)

    if is_port(state[:port]) do
      safe_close_port(state.port)
    end

    %{state | port: nil, os_pid: nil, worker_id: nil}
  end

  defp schedule_poll(state, delay_ms) do
    next_state = cancel_poll(state)
    timer_ref = Process.send_after(self(), :maybe_spawn, delay_ms)
    %{next_state | poll_timer: timer_ref}
  end

  defp cancel_poll(%{poll_timer: nil} = state), do: state

  defp cancel_poll(%{poll_timer: timer_ref} = state) do
    Process.cancel_timer(timer_ref)
    %{state | poll_timer: nil}
  end

  defp safe_close_port(port) do
    Port.close(port)
  rescue
    _ -> :ok
  end

  defp runnable_activation_available? do
    Storage.runnable_activation_available?()
  end

  defp next_worker_id(%{worker_mode: "pooled", index: index}) do
    slot_worker_id(index)
  end

  defp next_worker_id(%{index: index, generation: generation}) do
    slot_worker_id(index) <> ":run-" <> Integer.to_string(generation + 1)
  end

  defp slot_worker_id(index), do: "managed-local-" <> Integer.to_string(index)

  defp exit_poll_delay_ms("per_activation", 0), do: 0
  defp exit_poll_delay_ms(_worker_mode, _status), do: @restart_backoff_ms

  defp maybe_kill_os_process(nil, _signal), do: :ok

  defp maybe_kill_os_process(os_pid, signal) when is_integer(os_pid) do
    os_pid
    |> process_tree_pids()
    |> Enum.reverse()
    |> Enum.each(fn pid ->
      System.cmd("kill", [signal, Integer.to_string(pid)], stderr_to_stdout: true)
    end)

    System.cmd("kill", [signal, Integer.to_string(os_pid)], stderr_to_stdout: true)
    :ok
  rescue
    _ -> :ok
  end

  defp process_tree_pids(os_pid) when is_integer(os_pid) do
    case System.cmd("pgrep", ["-P", Integer.to_string(os_pid)], stderr_to_stdout: true) do
      {output, 0} ->
        output
        |> String.split("\n", trim: true)
        |> Enum.map(&String.trim/1)
        |> Enum.map(&Integer.parse/1)
        |> Enum.flat_map(fn
          {pid, ""} when pid > 0 -> [pid | process_tree_pids(pid)]
          _ -> []
        end)

      _ ->
        []
    end
  rescue
    _ -> []
  end

  defp runtime_executable(runtime, "bun") do
    bundled_bun = Path.join([runtime.install_root_dir, "current", "bun", "bun"])

    if File.regular?(bundled_bun) do
      bundled_bun
    else
      System.find_executable("bun")
    end
  end

  defp runtime_executable(_runtime, "node"), do: System.find_executable("node")
  defp runtime_executable(_runtime, _worker_runtime), do: nil

  defp normalize_managed_worker_mode("pooled"), do: "pooled"
  defp normalize_managed_worker_mode(_mode), do: "per_activation"

  defp managed_worker_index("managed-local-" <> rest) do
    [index_text | _suffix] = String.split(rest, ":", parts: 2)
    parse_managed_worker_index(index_text)
  end

  defp parse_managed_worker_index(index_text) do
    case Integer.parse(index_text) do
      {index, ""} when index > 0 ->
        runtime = Application.fetch_env!(:vilano_kernel, :runtime)

        if index <= runtime.managed_worker_count do
          {:ok, index}
        else
          :error
        end

      _ ->
        :error
    end
  end
end
