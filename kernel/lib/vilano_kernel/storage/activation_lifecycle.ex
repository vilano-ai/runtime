defmodule VilanoKernel.Storage.ActivationLifecycle do
  @moduledoc false

  alias VilanoKernel.Storage.ActivationLifecycle.{ExecOps, LeaseOps, StepOps, WaitSignalOps}

  defdelegate lease_next_run(worker_id), to: LeaseOps
  defdelegate heartbeat_lease(lease_id, worker_id), to: LeaseOps
  defdelegate lease_status(lease_id), to: LeaseOps
  defdelegate complete_run_lease(lease_id, result), to: LeaseOps
  defdelegate fail_run_lease(lease_id, error_body), to: LeaseOps
  defdelegate runnable_activation_available?(), to: LeaseOps

  defdelegate resolve_step(lease_id, name, op_key), to: StepOps
  defdelegate resolve_step(lease_id, name, op_key, timeout_ms), to: StepOps
  defdelegate resolve_step(lease_id, name, op_key, timeout_ms, retry_policy), to: StepOps
  defdelegate complete_step(lease_id, name, op_key, output), to: StepOps
  defdelegate fail_step(lease_id, name, op_key, error_body), to: StepOps
  defdelegate timeout_step(lease_id, op_key, expected_attempt, error_body), to: StepOps

  defdelegate resolve_exec(lease_id, name, op_key, exec_spec), to: ExecOps
  defdelegate complete_exec(lease_id, name, op_key, body), to: ExecOps
  defdelegate fail_exec(lease_id, name, op_key, body), to: ExecOps

  defdelegate resolve_sleep_wait(lease_id, op_key, duration_ms), to: WaitSignalOps
  defdelegate satisfy_timed_wait(run_id, op_key, expected_wake_at), to: WaitSignalOps
  defdelegate list_waiting_timed_waits(), to: WaitSignalOps
  defdelegate resolve_signal_wait(lease_id, name, op_key), to: WaitSignalOps
  defdelegate send_run_signal(run_id, signal_name, payload), to: WaitSignalOps
end
