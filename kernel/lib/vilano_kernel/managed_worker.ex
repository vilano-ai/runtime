defmodule VilanoKernel.ManagedWorker do
  @moduledoc false

  use GenServer

  require Logger

  alias VilanoKernel.ManagedWorker.Launcher
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

    case Launcher.prepare(runtime, worker_runtime) do
      {:ok, launch_spec} ->
        state = %{
          index: index,
          runtime: runtime,
          worker_runtime: worker_runtime,
          worker_mode: worker_mode,
          launch_spec: launch_spec,
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

      {:error, reason} ->
        log_prepare_error(index, reason)
        :ignore
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

    launch =
      Launcher.spawn(
        state.launch_spec,
        state.runtime,
        worker_id,
        state.worker_mode == "per_activation"
      )

    state
    |> cancel_poll()
    |> Map.merge(%{
      port: launch.port,
      os_pid: launch.os_pid,
      worker_id: worker_id,
      generation: state.generation + 1
    })
  end

  defp clear_worker(state, signal \\ "-TERM") do
    Launcher.terminate(state, signal)

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

  defp log_prepare_error(index, {:missing_runtime, worker_runtime}) do
    Logger.warning(
      "Managed worker #{index} not started because '#{worker_runtime}' is not available on PATH"
    )
  end

  defp log_prepare_error(index, {:missing_worker_entry, worker_entry}) do
    Logger.warning("Managed worker #{index} not started because #{worker_entry} does not exist")
  end

  defp log_prepare_error(index, {:missing_shared_source_dir, shared_source_dir}) do
    Logger.warning(
      "Managed worker #{index} not started because #{shared_source_dir} does not exist"
    )
  end

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
