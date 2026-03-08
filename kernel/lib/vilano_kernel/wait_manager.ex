defmodule VilanoKernel.WaitManager do
  @moduledoc false

  use GenServer

  alias VilanoKernel.Storage

  def start_link(_arg) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def schedule_timed_wait(wait) do
    GenServer.cast(__MODULE__, {:schedule_timed_wait, wait})
  end

  @impl true
  def init(_arg) do
    send(self(), :bootstrap)
    {:ok, %{}}
  end

  @impl true
  def handle_info(:bootstrap, state) do
    try do
      next_state =
        Storage.list_waiting_timed_waits()
        |> Enum.reduce(state, fn wait, acc -> schedule_timer(wait, acc) end)

      {:noreply, next_state}
    rescue
      _error ->
        Process.send_after(self(), :bootstrap, 100)
        {:noreply, state}
    end
  end

  def handle_info({:fire_timed_wait, run_id, op_key}, state) do
    _ = Storage.satisfy_timed_wait(run_id, op_key)
    {:noreply, Map.delete(state, {run_id, op_key})}
  end

  @impl true
  def handle_cast({:schedule_timed_wait, wait}, state) do
    {:noreply, schedule_timer(wait, state)}
  end

  defp schedule_timer(wait, state) do
    key = {wait["runId"], wait["key"]}

    case Map.get(state, key) do
      nil -> :ok
      existing_ref -> Process.cancel_timer(existing_ref)
    end

    delay_ms = wait_delay_ms(wait["wakeAt"])
    timer_ref = Process.send_after(self(), {:fire_timed_wait, wait["runId"], wait["key"]}, delay_ms)
    Map.put(state, key, timer_ref)
  end

  defp wait_delay_ms(nil), do: 0

  defp wait_delay_ms(iso8601) do
    {:ok, wake_at, _offset} = DateTime.from_iso8601(iso8601)
    diff = DateTime.diff(wake_at, DateTime.utc_now(), :millisecond)
    max(diff, 0)
  end
end
