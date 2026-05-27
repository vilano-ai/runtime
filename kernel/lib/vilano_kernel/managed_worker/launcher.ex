defmodule VilanoKernel.ManagedWorker.Launcher do
  @moduledoc false

  def prepare(runtime, worker_runtime) do
    worker_root_dir = Path.join([runtime.project_root, "worker"])
    worker_source_dir = Path.join([worker_root_dir, worker_runtime, "src"])
    worker_entry = Path.join(worker_source_dir, "cli.ts")
    shared_source_dir = Path.join([worker_root_dir, "shared", "src"])

    case runtime_executable(runtime, worker_runtime) do
      nil ->
        {:error, {:missing_runtime, worker_runtime}}

      runtime_path ->
        cond do
          not File.exists?(worker_entry) ->
            {:error, {:missing_worker_entry, worker_entry}}

          not File.exists?(shared_source_dir) ->
            {:error, {:missing_shared_source_dir, shared_source_dir}}

          true ->
            {:ok,
             %{
               runtime_path: runtime_path,
               worker_entry:
                 materialize_worker_entry!(runtime.home_dir, worker_root_dir, worker_runtime)
             }}
        end
    end
  end

  def worker_cache_version(runtime) do
    runtime.project_root
    |> Path.join("worker")
    |> worker_source_version()
  end

  def spawn(launch_spec, runtime, worker_id, once?) do
    port =
      start_port(
        launch_spec.runtime_path,
        launch_spec.worker_entry,
        runtime,
        worker_id,
        once?
      )

    %{
      port: port,
      os_pid: port_os_pid(port)
    }
  end

  def terminate(state, signal \\ "-TERM") do
    maybe_kill_os_process(state[:os_pid], signal)

    if is_port(state[:port]) do
      safe_close_port(state.port)
    end

    :ok
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
    base_env =
      [
        {~c"VILANO_WORKER_ARTIFACT_HOME", String.to_charlist(runtime.artifact_home_dir)},
        {~c"VILANO_WORKER_HOME",
         String.to_charlist(Path.join(runtime.execution_home_dir, "worker-home"))},
        {~c"VILANO_KERNEL_PORT", String.to_charlist(Integer.to_string(runtime.port))}
      ] ++
        optional_env("VILANO_EXEC_CAPTURE_MAX_BYTES") ++
        optional_env("VILANO_EXEC_ARTIFACT_MAX_BYTES")

    case runtime.worker_auth_token do
      token when is_binary(token) and token != "" ->
        [{~c"VILANO_WORKER_TOKEN", String.to_charlist(token)} | base_env]

      _ ->
        base_env
    end
  end

  defp optional_env(name) do
    case System.get_env(name) do
      value when is_binary(value) and value != "" ->
        [{String.to_charlist(name), String.to_charlist(value)}]

      _ ->
        []
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

  defp safe_close_port(port) do
    Port.close(port)
  rescue
    _ -> :ok
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
end
