defmodule VilanoKernel.Storage.ActivationLifecycle.LeaseOps do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{
    EventPayloads,
    Infrastructure,
    RunControl,
    ServiceLifecycle,
    Support
  }

  alias VilanoKernel.Storage.Support.Sql, as: SqlSupport

  import Support

  def lease_next_run(worker_id), do: do_lease_next_run(worker_id, 3)

  def heartbeat_lease(lease_id, worker_id) do
    now = Infrastructure.now_iso8601()
    expires_at = shift_seconds(now, Infrastructure.lease_duration_seconds())

    updated_rows =
      Infrastructure.run_with_busy_retry(
        fn ->
          write_changes!(
            """
            update runs
            set lease_expires_at = ?, updated_at = ?
            where
              lease_id = ?
              and lease_worker_id = ?
              and status in ('running', 'active')
              and lease_expires_at is not null
              and lease_expires_at >= ?
            """,
            [expires_at, now, lease_id, worker_id, now]
          )
        end,
        :lease_maintenance
      )

    if updated_rows > 0, do: %{"leaseExpiresAt" => expires_at}, else: nil
  end

  def lease_status(lease_id) do
    now = Infrastructure.now_iso8601()

    row =
      Repo
      |> SQL.query!(
        """
        select
          id,
          project_name,
          definition_kind,
          definition_name,
          status,
          lease_id,
          lease_worker_id,
          lease_expires_at,
          input_json,
          output_json,
          error_json,
          created_at,
          updated_at
        from runs
        where
          lease_id = ?
          and status in ('running', 'active')
          and lease_expires_at is not null
          and lease_expires_at >= ?
        limit 1
        """,
        [lease_id, now]
      )
      |> rows_to_maps()
      |> List.first()

    case row do
      nil ->
        %{"active" => false}

      active_row ->
        run = run_from_row(active_row)

        %{
          "active" => true,
          "runId" => run["id"],
          "status" => run["status"],
          "definitionKind" => run["definitionKind"],
          "leaseExpiresAt" => run["leaseExpiresAt"]
        }
    end
  end

  def complete_run_lease(lease_id, result) do
    complete_run_lease_with_prepared_payload_retry(lease_id, result, 3)
  end

  defp complete_run_lease_with_prepared_payload_retry(lease_id, result, attempts_left) do
    now = Infrastructure.now_iso8601()

    {completed_event, child_wait_events, restart_events, supervision_cancellations,
     supervision_events,
     linked_exit_cancellations} =
      prepare_terminal_event_and_restart_events!(
        lease_id,
        %{"result" => result},
        "completed",
        now
      )

    try do
      case Infrastructure.transaction_with_busy_retry(fn ->
             case RunControl.get_fenced_run_by_lease(lease_id, now) do
               nil ->
                 nil

               run ->
                 RunControl.ensure_fenced_run_write!(
                   run["id"],
                   lease_id,
                   now,
                   """
                   update runs
                   set
                     status = 'completed',
                     lease_id = null,
                     lease_auth_token = null,
                     lease_worker_id = null,
                     lease_expires_at = null,
                     output_json = ?,
                     error_json = null,
                     updated_at = ?
                   where id = ?
                   """,
                   [Jason.encode!(result), now, run["id"]]
                 )

                 SqlSupport.append_prepared_event!(
                   run["id"],
                   "RunCompleted",
                   completed_event,
                   now
                 )

                 VilanoKernel.Storage.AgentRelationships.wake_waiting_parents_for_child!(
                   run["id"],
                   "completed",
                   result,
                   now,
                   child_wait_events
                 )

                 VilanoKernel.Storage.Supervision.maybe_apply_supervision_for_terminal_run!(
                   run["id"],
                   now,
                   restart_events,
                   supervision_cancellations,
                   supervision_events
                 )

                 VilanoKernel.Storage.AgentRelationships.maybe_trigger_relationships_for_terminal_run!(
                   run["id"],
                   now,
                   linked_exit_cancellations
                 )

                 VilanoKernel.Storage.get_run(run["id"])
             end
           end) do
        {:ok, result} ->
          result

        {:error, :stale_cancellation_plan} when attempts_left > 1 ->
          complete_run_lease_with_prepared_payload_retry(lease_id, result, attempts_left - 1)

        {:error, error} ->
          unwrap_transaction_result({:error, error})
      end
    after
      discard_prepared_payload(completed_event)

      VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events(
        child_wait_events
      )

      VilanoKernel.Storage.Supervision.discard_prepared_restart_events(restart_events)

      VilanoKernel.Storage.Supervision.discard_prepared_sibling_cancellations(
        supervision_cancellations
      )

      VilanoKernel.Storage.Supervision.discard_prepared_terminal_supervision_events(
        supervision_events
      )

      VilanoKernel.Storage.AgentRelationships.discard_prepared_linked_exit_cancellations(
        linked_exit_cancellations
      )
    end
  end

  def fail_run_lease(lease_id, error_body) do
    fail_run_lease_with_prepared_payload_retry(lease_id, error_body, 3)
  end

  defp fail_run_lease_with_prepared_payload_retry(lease_id, error_body, attempts_left) do
    now = Infrastructure.now_iso8601()

    {failed_event, child_wait_events, restart_events, supervision_cancellations,
     supervision_events,
     linked_exit_cancellations} =
      prepare_terminal_event_and_restart_events!(
        lease_id,
        %{"error" => error_body},
        "failed",
        now
      )

    try do
      case Infrastructure.transaction_with_busy_retry(fn ->
             case RunControl.get_fenced_run_by_lease(lease_id, now) do
               nil ->
                 nil

               run ->
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
                     error_json = ?,
                     updated_at = ?
                   where id = ?
                   """,
                   [Jason.encode!(error_body), now, run["id"]]
                 )

                 SqlSupport.append_prepared_event!(run["id"], "RunFailed", failed_event, now)

                 VilanoKernel.Storage.AgentRelationships.wake_waiting_parents_for_child!(
                   run["id"],
                   "failed",
                   error_body,
                   now,
                   child_wait_events
                 )

                 VilanoKernel.Storage.Supervision.maybe_apply_supervision_for_terminal_run!(
                   run["id"],
                   now,
                   restart_events,
                   supervision_cancellations,
                   supervision_events
                 )

                 VilanoKernel.Storage.AgentRelationships.maybe_trigger_relationships_for_terminal_run!(
                   run["id"],
                   now,
                   linked_exit_cancellations
                 )

                 VilanoKernel.Storage.get_run(run["id"])
             end
           end) do
        {:ok, result} ->
          result

        {:error, :stale_cancellation_plan} when attempts_left > 1 ->
          fail_run_lease_with_prepared_payload_retry(lease_id, error_body, attempts_left - 1)

        {:error, error} ->
          unwrap_transaction_result({:error, error})
      end
    after
      discard_prepared_payload(failed_event)

      VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events(
        child_wait_events
      )

      VilanoKernel.Storage.Supervision.discard_prepared_restart_events(restart_events)

      VilanoKernel.Storage.Supervision.discard_prepared_sibling_cancellations(
        supervision_cancellations
      )

      VilanoKernel.Storage.Supervision.discard_prepared_terminal_supervision_events(
        supervision_events
      )

      VilanoKernel.Storage.AgentRelationships.discard_prepared_linked_exit_cancellations(
        linked_exit_cancellations
      )
    end
  end

  defp prepare_terminal_restart_events_for_lease(lease_id, terminal_status, now) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case RunControl.get_fenced_run_by_lease(lease_id, now) do
          nil ->
            %{}

          run ->
            VilanoKernel.Storage.Supervision.prepare_terminal_restart_run_started_events(
              run["id"],
              terminal_status,
              now
            )
        end
      end,
      :public_read
    )
  end

  defp prepare_child_result_wait_events_for_lease(lease_id, terminal_status, payload, now) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case RunControl.get_fenced_run_by_lease(lease_id, now) do
          nil ->
            %{}

          run ->
            VilanoKernel.Storage.AgentRelationships.prepare_child_result_wait_satisfied_events(
              run["id"],
              terminal_status,
              payload
            )
        end
      end,
      :public_read
    )
  end

  defp prepare_terminal_sibling_cancellations_for_lease(lease_id, terminal_status, now) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case RunControl.get_fenced_run_by_lease(lease_id, now) do
          nil ->
            %{}

          run ->
            VilanoKernel.Storage.Supervision.prepare_terminal_sibling_cancellations(
              run["id"],
              terminal_status,
              now
            )
        end
      end,
      :public_read
    )
  end

  defp prepare_terminal_supervision_events_for_lease(lease_id, terminal_status, payload, now) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case RunControl.get_fenced_run_by_lease(lease_id, now) do
          nil ->
            %{}

          run ->
            VilanoKernel.Storage.Supervision.prepare_terminal_supervision_events(
              run["id"],
              terminal_status,
              payload,
              now
            )
        end
      end,
      :public_read
    )
  end

  defp prepare_terminal_linked_exit_cancellations_for_lease(
         lease_id,
         terminal_status,
         payload,
         now
       ) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case RunControl.get_fenced_run_by_lease(lease_id, now) do
          nil ->
            %{}

          run ->
            VilanoKernel.Storage.AgentRelationships.prepare_terminal_linked_exit_cancellations(
              run["id"],
              terminal_status,
              now,
              MapSet.new(),
              payload
            )
        end
      end,
      :public_read
    )
  end

  defp prepare_terminal_event_and_restart_events!(lease_id, event_body, terminal_status, now) do
    terminal_event = EventPayloads.prepare_body_for_storage!(event_body)

    payload = Map.get(event_body, "result", Map.get(event_body, "error"))

    child_wait_events =
      try do
        prepare_child_result_wait_events_for_lease(lease_id, terminal_status, payload, now)
      rescue
        error ->
          discard_prepared_payload(terminal_event)
          reraise error, __STACKTRACE__
      end

    restart_events =
      try do
        prepare_terminal_restart_events_for_lease(lease_id, terminal_status, now)
      rescue
        error ->
          VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events(
            child_wait_events
          )

          discard_prepared_payload(terminal_event)
          reraise error, __STACKTRACE__
      end

    supervision_cancellations =
      try do
        prepare_terminal_sibling_cancellations_for_lease(lease_id, terminal_status, now)
      rescue
        error ->
          VilanoKernel.Storage.Supervision.discard_prepared_restart_events(restart_events)

          VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events(
            child_wait_events
          )

          discard_prepared_payload(terminal_event)
          reraise error, __STACKTRACE__
      end

    supervision_events =
      try do
        prepare_terminal_supervision_events_for_lease(lease_id, terminal_status, payload, now)
      rescue
        error ->
          VilanoKernel.Storage.Supervision.discard_prepared_sibling_cancellations(
            supervision_cancellations
          )

          VilanoKernel.Storage.Supervision.discard_prepared_restart_events(restart_events)

          VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events(
            child_wait_events
          )

          discard_prepared_payload(terminal_event)
          reraise error, __STACKTRACE__
      end

    try do
      linked_exit_cancellations =
        prepare_terminal_linked_exit_cancellations_for_lease(
          lease_id,
          terminal_status,
          payload,
          now
        )

      {terminal_event, child_wait_events, restart_events, supervision_cancellations,
       supervision_events, linked_exit_cancellations}
    rescue
      error ->
        VilanoKernel.Storage.Supervision.discard_prepared_terminal_supervision_events(
          supervision_events
        )

        VilanoKernel.Storage.Supervision.discard_prepared_sibling_cancellations(
          supervision_cancellations
        )

        VilanoKernel.Storage.Supervision.discard_prepared_restart_events(restart_events)

        VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events(
          child_wait_events
        )

        discard_prepared_payload(terminal_event)
        reraise error, __STACKTRACE__
    end
  end

  defp discard_prepared_payload(storage), do: EventPayloads.discard_prepared_payload!(storage)

  def runnable_activation_available? do
    now = Infrastructure.now_iso8601()
    not is_nil(next_activation_candidate(now))
  end

  defp do_lease_next_run(_worker_id, 0), do: nil

  defp do_lease_next_run(worker_id, attempts_remaining) do
    now = Infrastructure.now_iso8601()
    expires_at = shift_seconds(now, Infrastructure.lease_duration_seconds())

    case Infrastructure.transaction_with_busy_retry(
           fn ->
             case next_activation_candidate(now) do
               nil ->
                 nil

               {:workflow, candidate} ->
                 lease_id = "lease_" <> Ecto.UUID.generate()
                 lease_auth_token = "ltok_" <> Ecto.UUID.generate()
                 run_id = candidate["id"]

                 claimed_rows =
                   write_changes!(
                     """
                     update runs
                     set
                       status = 'running',
                       lease_id = ?,
                       lease_auth_token = ?,
                       lease_worker_id = ?,
                       lease_expires_at = ?,
                       updated_at = ?
                     where
                       id = ?
                       and definition_kind = 'workflow'
                       and status in ('pending', 'running')
                       and (lease_expires_at is null or lease_expires_at < ?)
                     """,
                     [lease_id, lease_auth_token, worker_id, expires_at, now, run_id, now]
                   )

                 if claimed_rows != 1 do
                   Repo.rollback(:stale_candidate)
                 end

                 append_event!(
                   run_id,
                   "RunLeaseGranted",
                   %{
                     leaseId: lease_id,
                     workerId: worker_id,
                     leaseExpiresAt: expires_at
                   },
                   now
                 )

                 run = VilanoKernel.Storage.get_run(run_id)

                 case RunControl.ensure_run_activation_pinned!(run) do
                   {:ok, pinned_run} ->
                     %{
                       lease_id: lease_id,
                       lease_auth_token: lease_auth_token,
                       lease_expires_at: expires_at,
                       activation_kind: "workflow",
                       run: pinned_run
                     }

                   {:error, {:unresumable_candidate, unpinned_run}} ->
                     Repo.rollback({:unresumable_candidate, unpinned_run})
                 end

               {:service_turn, candidate} ->
                 lease_id = "lease_" <> Ecto.UUID.generate()
                 lease_auth_token = "ltok_" <> Ecto.UUID.generate()
                 run_id = candidate["service_run_id"]
                 envelope_id = candidate["id"]

                 attempt =
                   cond do
                     candidate["envelope_status"] == "queued" ->
                       candidate["attempt"] || 1

                     candidate["run_status"] == "active" and
                         not is_nil(candidate["run_lease_expires_at"]) ->
                       (candidate["attempt"] || 0) + 1

                     true ->
                       candidate["attempt"] || 1
                   end

                 envelope_rows =
                   case candidate["envelope_status"] do
                     "queued" ->
                       write_changes!(
                         """
                         update service_envelopes
                         set
                           status = 'processing',
                           attempt = ?,
                           wake_at = null,
                           updated_at = ?
                         where id = ? and status = 'queued'
                         """,
                         [attempt, now, envelope_id]
                       )

                     _ ->
                       write_changes!(
                         """
                         update service_envelopes
                         set
                           attempt = ?,
                           updated_at = ?
                         where id = ? and status = 'processing'
                         """,
                         [attempt, now, envelope_id]
                       )
                   end

                 if envelope_rows != 1 do
                   Repo.rollback(:stale_candidate)
                 end

                 claimed_rows =
                   write_changes!(
                     """
                     update runs
                     set
                       status = 'active',
                       lease_id = ?,
                       lease_auth_token = ?,
                       lease_worker_id = ?,
                       lease_expires_at = ?,
                       updated_at = ?
                     where
                       id = ?
                       and definition_kind = 'service'
                       and status in ('idle', 'pending', 'active')
                       and (lease_expires_at is null or lease_expires_at < ?)
                     """,
                     [lease_id, lease_auth_token, worker_id, expires_at, now, run_id, now]
                   )

                 if claimed_rows != 1 do
                   Repo.rollback(:stale_candidate)
                 end

                 if candidate["envelope_status"] == "queued" do
                   append_event!(
                     run_id,
                     "TurnStarted",
                     %{
                       "envelopeId" => envelope_id,
                       "kind" => candidate["kind"],
                       "name" => candidate["name"],
                       "correlationId" => candidate["correlation_id"],
                       "attempt" => attempt
                     },
                     now
                   )
                 else
                   append_event!(
                     run_id,
                     "TurnResumed",
                     %{
                       "envelopeId" => envelope_id,
                       "kind" => candidate["kind"],
                       "name" => candidate["name"],
                       "correlationId" => candidate["correlation_id"],
                       "reason" => ServiceLifecycle.resume_reason(candidate),
                       "attempt" => attempt
                     },
                     now
                   )
                 end

                 run = VilanoKernel.Storage.get_run(run_id)

                 case RunControl.ensure_run_activation_pinned!(run) do
                   {:ok, pinned_run} ->
                     %{
                       lease_id: lease_id,
                       lease_auth_token: lease_auth_token,
                       lease_expires_at: expires_at,
                       activation_kind: "service_turn",
                       run: pinned_run,
                       service: get_service_run_by_id(run_id),
                       envelope: service_envelope_from_row(get_service_envelope(envelope_id))
                     }

                   {:error, {:unresumable_candidate, unpinned_run}} ->
                     Repo.rollback({:unresumable_candidate, unpinned_run})
                 end
             end
           end,
           :lease_maintenance
         ) do
      {:ok, value} ->
        value

      {:error, :stale_candidate} ->
        do_lease_next_run(worker_id, attempts_remaining - 1)

      {:error, {:unresumable_candidate, run}} ->
        RunControl.invalidate_unpinned_run!(run, Infrastructure.now_iso8601())
        do_lease_next_run(worker_id, attempts_remaining - 1)

      {:error, reason} ->
        raise(reason)
    end
  end

  defp next_activation_candidate(now) do
    workflow_candidate = next_workflow_activation_candidate(now)
    service_candidate = next_service_activation_candidate(now)

    cond do
      workflow_candidate == nil and service_candidate == nil ->
        nil

      workflow_candidate == nil ->
        {:service_turn, service_candidate}

      service_candidate == nil ->
        {:workflow, workflow_candidate}

      workflow_candidate["created_at"] <= service_candidate["created_at"] ->
        {:workflow, workflow_candidate}

      true ->
        {:service_turn, service_candidate}
    end
  end

  defp next_workflow_activation_candidate(now) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        project_name,
        definition_kind,
        definition_name,
        status,
        lease_id,
        lease_worker_id,
        lease_expires_at,
        input_json,
        output_json,
        error_json,
        created_at,
        updated_at
      from runs
      where
        definition_kind = 'workflow'
        and status in ('pending', 'running')
        and (lease_expires_at is null or lease_expires_at < ?)
      order by created_at asc
      limit 1
      """,
      [now]
    )
    |> rows_to_maps()
    |> List.first()
  end

  defp next_service_activation_candidate(now) do
    Repo
    |> SQL.query!(
      """
      select
        e.id,
        e.service_run_id,
        e.kind,
        e.name,
        e.attempt,
        e.payload_json,
        e.correlation_id,
        e.sender_run_id,
        e.status as envelope_status,
        e.reply_json,
        e.error_json,
        e.wake_at,
        e.created_at,
        e.updated_at,
        r.status as run_status,
        r.lease_expires_at as run_lease_expires_at
      from service_envelopes e
      join runs r on r.id = e.service_run_id
      where
        (e.status = 'processing' or (e.status = 'queued' and (e.wake_at is null or e.wake_at <= ?)))
        and r.definition_kind = 'service'
        and r.status in ('idle', 'pending', 'active')
        and (r.lease_expires_at is null or r.lease_expires_at < ?)
      order by
        case when e.status = 'processing' then 0 else 1 end asc,
        e.created_at asc
      limit 1
      """,
      [now, now]
    )
    |> rows_to_maps()
    |> List.first()
  end
end
