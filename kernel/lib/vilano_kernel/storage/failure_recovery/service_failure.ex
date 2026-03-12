defmodule VilanoKernel.Storage.FailureRecovery.ServiceFailure do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{RunControl, ServiceSupport, Support}

  import Support
  import ServiceSupport

  def stop_service_run_instance!(service_run, error_body, reason, now, lease_id \\ nil)
  def stop_service_run_instance!(nil, _error_body, _reason, _now, _lease_id), do: nil

  def stop_service_run_instance!(service_run, error_body, reason, now, lease_id) do
    if service_run["status"] == "stopped" do
      %{
        "run" => service_run,
        "stoppedEnvelopeCount" => 0,
        "cancelledWaitCount" => 0,
        "cancelledChildRunCount" => 0,
        "cancelledServiceAskCount" => 0,
        "hadInFlightTurn" => false,
        "hadActiveLease" => false
      }
    else
      open_envelopes = list_open_service_envelopes(service_run["id"])
      had_in_flight_turn = Enum.any?(open_envelopes, &(&1["status"] == "processing"))

      if is_binary(lease_id) and lease_id != "" do
        RunControl.ensure_fenced_run_write!(
          service_run["id"],
          lease_id,
          now,
          """
          update runs
          set
            status = 'stopped',
            lease_id = null,
            lease_auth_token = null,
            lease_worker_id = null,
            lease_expires_at = null,
            output_json = null,
            error_json = ?,
            updated_at = ?
          where id = ?
          """,
          [Jason.encode!(error_body), now, service_run["id"]]
        )
      else
        SQL.query!(
          Repo,
          """
          update runs
          set
            status = 'stopped',
            lease_id = null,
            lease_auth_token = null,
            lease_worker_id = null,
            lease_expires_at = null,
            output_json = null,
            error_json = ?,
            updated_at = ?
          where id = ?
          """,
          [Jason.encode!(error_body), now, service_run["id"]]
        )
      end

      Enum.each(open_envelopes, fn envelope ->
        fail_service_open_envelope!(service_run, envelope, error_body, reason, now, true)
      end)

      cancelled_wait_count =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_waiting_waits!(
          service_run["id"],
          error_body,
          now
        )

      _cancelled_step_count =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_running_steps!(
          service_run["id"],
          error_body,
          now
        )

      _cancelled_exec_count =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_running_execs!(
          service_run["id"],
          error_body,
          now
        )

      cancelled_service_ask_count =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_outbound_service_asks!(
          service_run["id"],
          error_body,
          reason,
          now
        )

      cancelled_child_run_count =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_child_runs_for_parent!(
          service_run["id"],
          error_body,
          reason,
          now
        )

      append_event!(
        service_run["id"],
        "ServiceStopped",
        %{
          "reason" => reason,
          "hadActiveLease" => not is_nil(service_run["leaseId"]),
          "hadInFlightTurn" => had_in_flight_turn,
          "stoppedEnvelopeCount" => length(open_envelopes),
          "cancelledWaitCount" => cancelled_wait_count,
          "cancelledChildRunCount" => cancelled_child_run_count,
          "cancelledServiceAskCount" => cancelled_service_ask_count
        },
        now
      )

      VilanoKernel.Storage.AgentRelationships.maybe_trigger_relationships_for_terminal_run!(service_run["id"], now)

      %{
        "run" => get_service_run_by_id(service_run["id"]),
        "stoppedEnvelopeCount" => length(open_envelopes),
        "cancelledWaitCount" => cancelled_wait_count,
        "cancelledChildRunCount" => cancelled_child_run_count,
        "cancelledServiceAskCount" => cancelled_service_ask_count,
        "hadInFlightTurn" => had_in_flight_turn,
        "hadActiveLease" => not is_nil(service_run["leaseId"]),
        "activeLeaseWorkerId" => service_run["leaseWorkerId"]
      }
    end
  end

  def timeout_result_for_run!(run, error_body, now, lease_id) do
    case run["definitionKind"] do
      "workflow" ->
        VilanoKernel.Storage.FailureRecovery.WorkflowFailure.fail_workflow_run_instance!(
          run,
          error_body,
          now,
          lease_id
        )

      "service" ->
        case get_processing_service_envelope_for_run(run["id"]) do
          nil ->
            if is_binary(lease_id) and lease_id != "" do
              RunControl.ensure_fenced_run_write!(
                run["id"],
                lease_id,
                now,
                """
                update runs
                set
                  status = 'idle',
                  lease_id = null,
                  lease_auth_token = null,
                  lease_worker_id = null,
                  lease_expires_at = null,
                  updated_at = ?
                where id = ?
                """,
                [now, run["id"]]
              )
            else
              SQL.query!(
                Repo,
                """
                update runs
                set
                  status = 'idle',
                  lease_id = null,
                  lease_auth_token = null,
                  lease_worker_id = null,
                  lease_expires_at = null,
                  updated_at = ?
                where id = ?
                """,
                [now, run["id"]]
              )
            end

            %{
              "run" => VilanoKernel.Storage.get_run(run["id"]),
              "status" => "idle",
              "activeLeaseWorkerId" => run["leaseWorkerId"]
            }

          envelope ->
            SQL.query!(
              Repo,
              """
              update service_envelopes
              set
                status = 'failed',
                error_json = ?,
                wake_at = null,
                updated_at = ?
              where id = ?
              """,
              [Jason.encode!(error_body), now, envelope["id"]]
            )

            append_event!(
              run["id"],
              "TurnFailed",
              %{
                "envelopeId" => envelope["id"],
                "kind" => envelope["kind"],
                "name" => envelope["name"],
                "error" => error_body
              },
              now
            )

            if envelope["kind"] == "ask" do
              wake_service_ask_waiter!(envelope["correlation_id"], "failed", error_body, now)
            end

            next_status = service_next_status(run["id"], false)

            SQL.query!(
              Repo,
              """
              update runs
              set
                status = ?,
                lease_id = null,
                lease_auth_token = null,
                lease_worker_id = null,
                lease_expires_at = null,
                updated_at = ?
              where id = ?
              """,
              [next_status, now, run["id"]]
            )

            %{
              "run" => VilanoKernel.Storage.get_run(run["id"]),
              "status" => next_status,
              "activeLeaseWorkerId" => run["leaseWorkerId"]
            }
        end
    end
  end

  def fail_service_open_envelope!(service_run, envelope, error_body, reason, now, wake_waiter?) do
    SQL.query!(
      Repo,
      """
      update service_envelopes
      set
        status = 'failed',
        error_json = ?,
        wake_at = null,
        updated_at = ?
      where id = ?
      """,
      [Jason.encode!(error_body), now, envelope["id"]]
    )

    if wake_waiter? and envelope["kind"] == "ask" and envelope["correlation_id"] do
      wake_service_ask_waiter!(envelope["correlation_id"], "failed", error_body, now)
    end

    if envelope["status"] == "processing" do
      append_event!(
        service_run["id"],
        "TurnFailed",
        %{
          "envelopeId" => envelope["id"],
          "kind" => envelope["kind"],
          "name" => envelope["name"],
          "error" => error_body
        },
        now
      )

      _ =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_waiting_waits!(
          service_run["id"],
          error_body,
          now
        )

      _ =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_running_steps!(
          service_run["id"],
          error_body,
          now
        )

      _ =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_running_execs!(
          service_run["id"],
          error_body,
          now
        )

      _ =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_outbound_service_asks!(
          service_run["id"],
          error_body,
          reason,
          now
        )

      _ =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_child_runs_for_parent!(
          service_run["id"],
          error_body,
          reason,
          now
        )
    end

    next_status = service_next_status(service_run["id"], false)

    SQL.query!(
      Repo,
      """
      update runs
      set
        status = ?,
        lease_id = null,
        lease_auth_token = null,
        lease_worker_id = null,
        lease_expires_at = null,
        updated_at = ?
      where id = ? and status != 'stopped'
      """,
      [next_status, now, service_run["id"]]
    )
  end
end
