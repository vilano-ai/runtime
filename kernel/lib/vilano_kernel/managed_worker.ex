defmodule VilanoKernel.ManagedWorker do
  @moduledoc false

  use GenServer

  require Logger

  def start_link(index) when is_integer(index) do
    GenServer.start_link(__MODULE__, index, name: via_name(index))
  end

  def kill_worker(worker_id, reason \\ :requested)

  def kill_worker("managed-local-" <> index_text, reason) do
    case parse_managed_worker_index(index_text) do
      {:ok, index} ->
        via_name(index)
        |> GenServer.whereis()
        |> case do
          nil -> :not_found
          pid -> GenServer.call(pid, {:kill_worker, reason}, 5_000)
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
    worker_root_dir = Path.join([runtime.project_root, "worker"])
    worker_source_dir = Path.join([worker_root_dir, worker_runtime, "src"])
    worker_entry = Path.join(worker_source_dir, "cli.ts")
    shared_source_dir = Path.join([worker_root_dir, "shared", "src"])
    executable = runtime_executable(worker_runtime)

    case {executable, File.exists?(worker_entry), File.exists?(shared_source_dir)} do
      {nil, _, _} ->
        Logger.warning(
          "Managed worker #{index} not started because '#{worker_runtime}' is not available on PATH"
        )
        :ignore

      {_runtime_path, false, _} ->
        Logger.warning("Managed worker #{index} not started because #{worker_entry} does not exist")
        :ignore

      {_runtime_path, _, false} ->
        Logger.warning("Managed worker #{index} not started because #{shared_source_dir} does not exist")
        :ignore

      {runtime_path, true, true} ->
        cached_worker_entry = materialize_worker_entry!(runtime.home_dir, worker_root_dir, worker_runtime)
        port = start_port(runtime_path, cached_worker_entry, runtime, index)

        state = %{
          index: index,
          port: port,
          os_pid: port_os_pid(port),
          runtime: worker_runtime
        }

        {:ok, state}
    end
  end

  @impl true
  def handle_info({_port, {:data, _data}}, state) do
    {:noreply, state}
  end

  @impl true
  def handle_info({port, {:exit_status, status}}, %{port: port, index: index} = state) do
    Logger.warning("Managed worker #{index} exited with status #{status}")
    {:stop, {:worker_exit, status}, state}
  end

  def handle_info(_message, state) do
    {:noreply, state}
  end

  @impl true
  def handle_call({:kill_worker, reason}, _from, state) do
    Logger.warning("Managed worker #{state.index} terminating due to #{inspect(reason)}")
    maybe_kill_os_process(state[:os_pid], "-KILL")
    {:stop, {:killed, reason}, :ok, state}
  end

  @impl true
  def terminate(_reason, state) do
    if is_port(state[:port]) do
      Port.close(state.port)
    end

    maybe_kill_os_process(state[:os_pid])

    :ok
  end

  defp via_name(index), do: String.to_atom("vilano_managed_worker_#{index}")

  defp start_port(executable_path, worker_entry, runtime, index) do
    server_url = "http://127.0.0.1:#{runtime.port}"
    worker_id = "managed-local-#{index}"
    worker_home = Path.join(runtime.execution_home_dir, "worker-home")

    File.mkdir_p!(worker_home)

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
        {:args,
         Enum.map(
           [worker_entry, "--server", server_url, "--worker-id", worker_id],
           &String.to_charlist/1
         )}
      ]
    )
  end

  defp worker_env(runtime) do
    base_env = [
      {~c"VILANO_RUNTIME_HOME", String.to_charlist(runtime.home_dir)},
      {~c"VILANO_WORKER_HOME", String.to_charlist(Path.join(runtime.execution_home_dir, "worker-home"))},
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
    files =
      worker_root_dir
      |> list_worker_files!()
      |> Enum.sort()
      |> Enum.map(fn relative_path ->
        path = Path.join(worker_root_dir, relative_path)

        case File.stat(path) do
          {:ok, stat} ->
            "#{relative_path}:#{stat.size}:#{inspect(stat.mtime)}"

          {:error, _reason} ->
            "#{relative_path}:missing"
        end
      end)
      |> Enum.join("|")

    :crypto.hash(:sha256, files)
    |> Base.encode16(case: :lower)
    |> binary_part(0, 16)
  end

  defp port_os_pid(port) do
    case Port.info(port, :os_pid) do
      {:os_pid, os_pid} when is_integer(os_pid) -> os_pid
      _ -> nil
    end
  end

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

  defp maybe_kill_os_process(os_pid), do: maybe_kill_os_process(os_pid, "-TERM")

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

  defp runtime_executable("bun"), do: System.find_executable("bun")
  defp runtime_executable("node"), do: System.find_executable("node")
  defp runtime_executable(_runtime), do: nil

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

  defp list_worker_files!(root_dir) do
    root_dir
    |> do_list_worker_files!("")
    |> Enum.reject(&String.ends_with?(&1, "/"))
  end

  defp do_list_worker_files!(root_dir, relative_dir) do
    current_dir =
      case relative_dir do
        "" -> root_dir
        _ -> Path.join(root_dir, relative_dir)
      end

    current_dir
    |> File.ls!()
    |> Enum.flat_map(fn entry ->
      relative_path =
        case relative_dir do
          "" -> entry
          _ -> Path.join(relative_dir, entry)
        end

      full_path = Path.join(root_dir, relative_path)

      case File.dir?(full_path) do
        true -> do_list_worker_files!(root_dir, relative_path)
        false -> [relative_path]
      end
    end)
  end
end
