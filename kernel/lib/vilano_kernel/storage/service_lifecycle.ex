defmodule VilanoKernel.Storage.ServiceLifecycle do
  @moduledoc false

  def enqueue_status("stopped", _lease_expires_at, _now), do: "stopped"

  def enqueue_status("active", lease_expires_at, now)
      when is_binary(lease_expires_at) and is_binary(now) do
    if lease_expires_at >= now, do: "active", else: "pending"
  end

  def enqueue_status("waiting", _lease_expires_at, _now), do: "waiting"
  def enqueue_status(_current_status, _lease_expires_at, _now), do: "pending"

  def next_status("stopped", _has_queued_envelopes, _stop?), do: "stopped"
  def next_status(_current_status, _has_queued_envelopes, true), do: "stopped"
  def next_status(_current_status, true, false), do: "pending"
  def next_status(_current_status, false, false), do: "idle"

  def resume_reason(candidate) do
    cond do
      candidate["run_status"] == "pending" ->
        "wait_satisfied"

      candidate["run_status"] == "active" and not is_nil(candidate["run_lease_expires_at"]) ->
        "lease_expired"

      true ->
        "retry"
    end
  end
end
