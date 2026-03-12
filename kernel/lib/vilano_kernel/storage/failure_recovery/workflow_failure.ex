defmodule VilanoKernel.Storage.FailureRecovery.WorkflowFailure do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{RunControl, Support}

  import Support

  def fail_workflow_run_instance!(run, error_body, now, lease_id \\ nil) do
    if terminal_run_status?(run["status"]) do
      %{
        "run" => VilanoKernel.Storage.get_run(run["id"]),
        "status" => run["status"],
        "activeLeaseWorkerId" => run["leaseWorkerId"]
      }
    else
      if is_binary(lease_id) and lease_id != "" do
        RunControl.ensure_fenced_run_write!(
          run["id"],
          lease_id,
          now,
          """
          update runs
          set
            status = 'failed',
            lease_id = null,
            lease_auth_token = null,
            lease_worker_id = null,
            lease_expires_at = null,
            output_json = null,
            error_json = ?,
            updated_at = ?
          where id = ?
          """,
          [Jason.encode!(error_body), now, run["id"]]
        )
      else
        SQL.query!(
          Repo,
          """
          update runs
          set
            status = 'failed',
            lease_id = null,
            lease_auth_token = null,
            lease_worker_id = null,
            lease_expires_at = null,
            output_json = null,
            error_json = ?,
            updated_at = ?
          where id = ?
          """,
          [Jason.encode!(error_body), now, run["id"]]
        )
      end

      append_event!(run["id"], "RunFailed", %{"error" => error_body}, now)
      VilanoKernel.Storage.AgentRelationships.wake_waiting_parents_for_child!(
        run["id"],
        "failed",
        error_body,
        now
      )

      VilanoKernel.Storage.Supervision.maybe_apply_supervision_for_terminal_run!(run["id"], now)
      VilanoKernel.Storage.AgentRelationships.maybe_trigger_relationships_for_terminal_run!(run["id"], now)

      %{
        "run" => VilanoKernel.Storage.get_run(run["id"]),
        "status" => "failed",
        "activeLeaseWorkerId" => run["leaseWorkerId"]
      }
    end
  end

  def cancel_workflow_run_instance!(run, error_body, reason, now) do
    if terminal_run_status?(run["status"]) do
      %{
        "run" => VilanoKernel.Storage.get_run(run["id"]),
        "cancelledWaitCount" => 0,
        "cancelledChildRunCount" => 0,
        "cancelledServiceAskCount" => 0,
        "hadActiveLease" => false
      }
    else
      SQL.query!(
        Repo,
        """
        update runs
        set
          status = 'cancelled',
          lease_id = null,
          lease_auth_token = null,
          lease_worker_id = null,
          lease_expires_at = null,
          output_json = null,
          error_json = ?,
          updated_at = ?
        where id = ?
        """,
        [Jason.encode!(error_body), now, run["id"]]
      )

      cancelled_wait_count =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_waiting_waits!(
          run["id"],
          error_body,
          now
        )

      _cancelled_step_count =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_running_steps!(
          run["id"],
          error_body,
          now
        )

      _cancelled_exec_count =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_running_execs!(
          run["id"],
          error_body,
          now
        )

      cancelled_service_ask_count =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_outbound_service_asks!(
          run["id"],
          error_body,
          reason,
          now
        )

      cancelled_child_run_count =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_child_runs_for_parent!(
          run["id"],
          error_body,
          reason,
          now
        )

      append_event!(
        run["id"],
        "RunCancelled",
        %{
          "reason" => reason,
          "hadActiveLease" => not is_nil(run["leaseId"]),
          "cancelledWaitCount" => cancelled_wait_count,
          "cancelledChildRunCount" => cancelled_child_run_count,
          "cancelledServiceAskCount" => cancelled_service_ask_count,
          "error" => error_body
        },
        now
      )

      VilanoKernel.Storage.AgentRelationships.wake_waiting_parents_for_child!(
        run["id"],
        "cancelled",
        error_body,
        now
      )

      VilanoKernel.Storage.Supervision.maybe_apply_supervision_for_terminal_run!(run["id"], now)
      VilanoKernel.Storage.AgentRelationships.maybe_trigger_relationships_for_terminal_run!(run["id"], now)

      %{
        "run" => VilanoKernel.Storage.get_run(run["id"]),
        "cancelledWaitCount" => cancelled_wait_count,
        "cancelledChildRunCount" => cancelled_child_run_count,
        "cancelledServiceAskCount" => cancelled_service_ask_count,
        "hadActiveLease" => not is_nil(run["leaseId"]),
        "activeLeaseWorkerId" => run["leaseWorkerId"]
      }
    end
  end

  def terminal_run_status?(status), do: status in ["completed", "failed", "cancelled", "stopped"]

  def cancellation_error(message, reason) do
    %{
      "name" => "CancelledError",
      "message" => message,
      "reason" => reason
    }
  end
end
