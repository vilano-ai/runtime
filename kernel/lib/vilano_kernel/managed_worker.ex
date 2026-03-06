defmodule VilanoKernel.ManagedWorker do
  @moduledoc false

  use GenServer

  require Logger

  def start_link(index) when is_integer(index) do
    GenServer.start_link(__MODULE__, index, name: via_name(index))
  end

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
    worker_entry = Path.join([runtime.project_root, "worker", "bun", "src", "cli.ts"])

    case {System.find_executable("bun"), File.exists?(worker_entry)} do
      {nil, _} ->
        Logger.warning("Managed worker #{index} not started because 'bun' is not available on PATH")
        :ignore

      {_bun_path, false} ->
        Logger.warning("Managed worker #{index} not started because #{worker_entry} does not exist")
        :ignore

      {bun_path, true} ->
        port = start_port(bun_path, worker_entry, runtime, index)

        state = %{
          index: index,
          port: port,
          os_pid: port_os_pid(port)
        }

        {:ok, state}
    end
  end

  @impl true
  def handle_info({_port, {:data, _data}}, state) do
    {:noreply, state}
  end

  def handle_info({port, {:exit_status, status}}, %{port: port, index: index} = state) do
    Logger.warning("Managed worker #{index} exited with status #{status}")
    {:stop, {:worker_exit, status}, state}
  end

  def handle_info(_message, state) do
    {:noreply, state}
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

  defp start_port(bun_path, worker_entry, runtime, index) do
    server_url = "http://127.0.0.1:#{runtime.port}"
    worker_id = "managed-local-#{index}"

    Port.open(
      {:spawn_executable, String.to_charlist(bun_path)},
      [
        :binary,
        :use_stdio,
        :stderr_to_stdout,
        :exit_status,
        :hide,
        {:cd, String.to_charlist(runtime.project_root)},
        {:args,
         Enum.map(
           [worker_entry, "--server", server_url, "--worker-id", worker_id],
           &String.to_charlist/1
         )}
      ]
    )
  end

  defp port_os_pid(port) do
    case Port.info(port, :os_pid) do
      {:os_pid, os_pid} when is_integer(os_pid) -> os_pid
      _ -> nil
    end
  end

  defp maybe_kill_os_process(nil), do: :ok

  defp maybe_kill_os_process(os_pid) when is_integer(os_pid) do
    System.cmd("kill", ["-TERM", Integer.to_string(os_pid)], stderr_to_stdout: true)
    :ok
  rescue
    _ -> :ok
  end
end
