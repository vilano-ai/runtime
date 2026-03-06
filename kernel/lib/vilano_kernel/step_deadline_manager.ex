defmodule VilanoKernel.StepDeadlineManager do
  @moduledoc false

  use GenServer

  alias VilanoKernel.ManagedWorker
  alias VilanoKernel.Storage
  alias VilanoKernel.WaitManager

  def start_link(_arg) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def schedule_step(step) do
    GenServer.cast(__MODULE__, {:schedule_step, step})
  end

  def clear_step(run_id, op_key) do
    GenServer.cast(__MODULE__, {:clear_step, run_id, op_key})
  end

  @impl true
  def init(_arg) do
    send(self(), :bootstrap)
    {:ok, %{}}
  end

  @impl true
  def handle_info(:bootstrap, state) do
    next_state =
      Storage.list_active_timed_steps()
      |> Enum.reduce(state, fn step, acc -> schedule_timer(step, acc) end)

    {:noreply, next_state}
  end

  def handle_info({:step_timeout, run_id, op_key, lease_id, step_name, timeout_ms}, state) do
    error_body = timeout_error(run_id, op_key, step_name, timeout_ms)

    case Storage.timeout_step(lease_id, op_key, error_body) do
      %{"wait" => wait, "activeLeaseWorkerId" => worker_id} when is_binary(worker_id) ->
        WaitManager.schedule_timed_wait(wait)
        _ = ManagedWorker.kill_worker(worker_id, {:step_timeout, run_id, op_key})

      %{"wait" => wait} ->
        WaitManager.schedule_timed_wait(wait)

      %{"activeLeaseWorkerId" => worker_id} when is_binary(worker_id) ->
        _ = ManagedWorker.kill_worker(worker_id, {:step_timeout, run_id, op_key})

      _ ->
        :ok
    end

    {:noreply, Map.delete(state, {run_id, op_key})}
  end

  @impl true
  def handle_cast({:schedule_step, step}, state) do
    {:noreply, schedule_timer(step, state)}
  end

  def handle_cast({:clear_step, run_id, op_key}, state) do
    {:noreply, cancel_timer({run_id, op_key}, state)}
  end

  defp schedule_timer(step, state) do
    key = {step["runId"], step["key"]}
    next_state = cancel_timer(key, state)
    delay_ms = step_delay_ms(step["startedAt"], step["timeoutMs"])

    timer_ref =
      Process.send_after(
        self(),
        {:step_timeout, step["runId"], step["key"], step["leaseId"], step["name"], step["timeoutMs"]},
        delay_ms
      )

    Map.put(next_state, key, timer_ref)
  end

  defp cancel_timer(key, state) do
    case Map.pop(state, key) do
      {nil, next_state} ->
        next_state

      {timer_ref, next_state} ->
        Process.cancel_timer(timer_ref)
        next_state
    end
  end

  defp step_delay_ms(nil, _timeout_ms), do: 0
  defp step_delay_ms(_started_at, nil), do: 0

  defp step_delay_ms(started_at_iso8601, timeout_ms) do
    {:ok, started_at, _offset} = DateTime.from_iso8601(started_at_iso8601)
    deadline = DateTime.add(started_at, timeout_ms, :millisecond)
    diff = DateTime.diff(deadline, DateTime.utc_now(), :millisecond)
    max(diff, 0)
  end

  defp timeout_error(run_id, op_key, step_name, timeout_ms) do
    %{
      "name" => "StepError",
      "stepName" => step_name,
      "key" => op_key,
      "message" => "Step '#{step_name}' timed out after #{timeout_ms}ms",
      "timedOut" => true,
      "retryable" => true,
      "family" => "timeout",
      "timeoutMs" => timeout_ms,
      "forcedTermination" => true,
      "source" => "kernel_deadline_manager",
      "runId" => run_id
    }
  end
end
