defmodule VilanoKernel.Storage.FailureRecovery do
  @moduledoc false

  alias VilanoKernel.Storage.FailureRecovery.{
    Cancellation,
    RetryRecovery,
    ServiceFailure,
    WorkflowFailure
  }

  defdelegate fail_workflow_run_instance!(run, error_body, now), to: WorkflowFailure
  defdelegate fail_workflow_run_instance!(run, error_body, now, lease_id), to: WorkflowFailure

  defdelegate fail_workflow_run_instance!(run, error_body, now, lease_id, prepared_failure),
    to: WorkflowFailure

  defdelegate cancel_workflow_run_instance!(run, error_body, reason, now), to: WorkflowFailure

  defdelegate cancel_workflow_run_instance!(run, error_body, reason, now, prepared_cancellation),
    to: WorkflowFailure

  defdelegate prepare_workflow_cancellation!(run, error_body, reason, now), to: WorkflowFailure
  defdelegate discard_prepared_workflow_cancellation(prepared_cancellation), to: WorkflowFailure
  defdelegate terminal_run_status?(status), to: WorkflowFailure
  defdelegate cancellation_error(message, reason), to: WorkflowFailure

  defdelegate stop_service_run_instance!(service_run, error_body, reason, now), to: ServiceFailure

  defdelegate stop_service_run_instance!(service_run, error_body, reason, now, lease_id),
    to: ServiceFailure

  defdelegate stop_service_run_instance!(
                service_run,
                error_body,
                reason,
                now,
                lease_id,
                prepared_stop
              ),
              to: ServiceFailure

  defdelegate timeout_result_for_run!(run, error_body, now, lease_id), to: ServiceFailure

  defdelegate timeout_result_for_run!(run, error_body, now, lease_id, prepared_timeout),
    to: ServiceFailure

  defdelegate fail_service_open_envelope!(
                service_run,
                envelope,
                error_body,
                reason,
                now,
                wake_waiter?
              ),
              to: ServiceFailure

  defdelegate fail_step_attempt!(run, step, name, error_body, now, lease_id), to: RetryRecovery

  defdelegate fail_step_attempt!(run, step, name, error_body, now, lease_id, prepared_failure),
    to: RetryRecovery

  defdelegate fail_exec_attempt!(run, exec, name, op_key, body, now, lease_id), to: RetryRecovery

  defdelegate fail_exec_attempt!(run, exec, name, op_key, body, now, lease_id, prepared_failure),
    to: RetryRecovery

  defdelegate fail_service_turn_attempt!(
                service_run,
                envelope,
                error_body,
                retry_options,
                now,
                lease_id
              ),
              to: RetryRecovery

  defdelegate fail_service_turn_attempt!(
                service_run,
                envelope,
                error_body,
                retry_options,
                now,
                lease_id,
                prepared_failure
              ),
              to: RetryRecovery

  defdelegate schedule_retry_wait!(run, wait_key, body, now, lease_id), to: RetryRecovery
  defdelegate step_attempt(step), to: RetryRecovery
  defdelegate retry_wait_key(kind, op_key), to: RetryRecovery
  defdelegate retry_decision(error_body, attempt, max_attempts, retry_on), to: RetryRecovery
  defdelegate compute_backoff_details(policy, attempt, seed), to: RetryRecovery

  defdelegate cancel_waiting_waits!(run_id, error_body, now), to: Cancellation
  defdelegate cancel_running_steps!(run_id, error_body, now), to: Cancellation
  defdelegate cancel_running_execs!(run_id, error_body, now), to: Cancellation

  defdelegate cancel_outbound_service_asks!(caller_run_id, error_body, reason, now),
    to: Cancellation

  defdelegate cancel_service_envelope_by_correlation!(
                service_run_id,
                correlation_id,
                error_body,
                reason,
                now
              ),
              to: Cancellation

  defdelegate cancel_child_runs_for_parent!(parent_run_id, error_body, reason, now),
    to: Cancellation
end
