defmodule VilanoKernel.Storage.FailureRecovery.WorkflowFailure do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{EventPayloads, RunControl}
  alias VilanoKernel.Storage.Support.Sql, as: SqlSupport

  def fail_workflow_run_instance!(run, error_body, now, lease_id \\ nil) do
    fail_workflow_run_instance!(run, error_body, now, lease_id, nil)
  end

  def fail_workflow_run_instance!(run, error_body, now, lease_id, prepared_failure) do
    if terminal_run_status?(run["status"]) do
      %{
        "run" => VilanoKernel.Storage.get_run(run["id"]),
        "status" => run["status"],
        "activeLeaseWorkerId" => run["leaseWorkerId"]
      }
    else
      fail_with_prepared_workflow_failure!(run, error_body, now, lease_id, prepared_failure)
    end
  end

  def prepare_workflow_failure!(run, error_body, now) do
    prepare_workflow_failure!(run, error_body, now, MapSet.new())
  end

  def prepare_workflow_failure!(run, error_body, now, visited_run_ids) do
    visited_run_ids = MapSet.put(visited_run_ids, run["id"])
    run_id = run["id"]
    failed_event = EventPayloads.prepare_body_for_storage!(%{"error" => error_body})

    child_wait_events =
      try do
        VilanoKernel.Storage.AgentRelationships.prepare_child_result_wait_satisfied_events(
          run_id,
          "failed",
          error_body
        )
      rescue
        error ->
          discard_prepared_payload(failed_event)
          reraise error, __STACKTRACE__
      end

    restart_events =
      try do
        VilanoKernel.Storage.Supervision.prepare_terminal_restart_run_started_events(
          run_id,
          "failed",
          now
        )
      rescue
        error ->
          VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events(
            child_wait_events
          )

          discard_prepared_payload(failed_event)
          reraise error, __STACKTRACE__
      end

    supervision_cancellations =
      try do
        VilanoKernel.Storage.Supervision.prepare_terminal_sibling_cancellations(
          run_id,
          "failed",
          now,
          visited_run_ids
        )
      rescue
        error ->
          VilanoKernel.Storage.Supervision.discard_prepared_restart_events(restart_events)

          VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events(
            child_wait_events
          )

          discard_prepared_payload(failed_event)
          reraise error, __STACKTRACE__
      end

    supervision_events =
      try do
        VilanoKernel.Storage.Supervision.prepare_terminal_supervision_events(
          run_id,
          "failed",
          error_body,
          now,
          visited_run_ids
        )
      rescue
        error ->
          VilanoKernel.Storage.Supervision.discard_prepared_sibling_cancellations(
            supervision_cancellations
          )

          VilanoKernel.Storage.Supervision.discard_prepared_restart_events(restart_events)

          VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events(
            child_wait_events
          )

          discard_prepared_payload(failed_event)
          reraise error, __STACKTRACE__
      end

    try do
      linked_exit_cancellations =
        VilanoKernel.Storage.AgentRelationships.prepare_terminal_linked_exit_cancellations(
          run_id,
          "failed",
          now,
          visited_run_ids,
          error_body
        )

      %{
        failed_event: failed_event,
        child_wait_events: child_wait_events,
        restart_events: restart_events,
        supervision_cancellations: supervision_cancellations,
        supervision_events: supervision_events,
        linked_exit_cancellations: linked_exit_cancellations
      }
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

        discard_prepared_payload(failed_event)
        reraise error, __STACKTRACE__
    end
  end

  def discard_prepared_workflow_failure(nil), do: :ok

  def discard_prepared_workflow_failure(%{} = prepared) do
    prepared
    |> Map.get(:failed_event)
    |> discard_prepared_payload()

    prepared
    |> Map.get(:child_wait_events, %{})
    |> VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events()

    prepared
    |> Map.get(:restart_events, %{})
    |> VilanoKernel.Storage.Supervision.discard_prepared_restart_events()

    prepared
    |> Map.get(:supervision_cancellations, %{})
    |> VilanoKernel.Storage.Supervision.discard_prepared_sibling_cancellations()

    prepared
    |> Map.get(:supervision_events, %{})
    |> VilanoKernel.Storage.Supervision.discard_prepared_terminal_supervision_events()

    prepared
    |> Map.get(:linked_exit_cancellations, %{})
    |> VilanoKernel.Storage.AgentRelationships.discard_prepared_linked_exit_cancellations()
  end

  defp fail_with_prepared_workflow_failure!(run, error_body, now, lease_id, nil) do
    prepared = prepare_workflow_failure!(run, error_body, now)

    try do
      do_fail_workflow_run_instance!(run, error_body, now, lease_id, prepared)
    after
      discard_prepared_workflow_failure(prepared)
    end
  end

  defp fail_with_prepared_workflow_failure!(run, error_body, now, lease_id, prepared) do
    do_fail_workflow_run_instance!(run, error_body, now, lease_id, prepared)
  end

  defp do_fail_workflow_run_instance!(
         run,
         error_body,
         now,
         lease_id,
         prepared
       ) do
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

    SqlSupport.append_prepared_event!(run["id"], "RunFailed", prepared.failed_event, now)

    VilanoKernel.Storage.AgentRelationships.wake_waiting_parents_for_child!(
      run["id"],
      "failed",
      error_body,
      now,
      prepared.child_wait_events
    )

    VilanoKernel.Storage.Supervision.maybe_apply_supervision_for_terminal_run!(
      run["id"],
      now,
      prepared.restart_events,
      prepared.supervision_cancellations,
      prepared.supervision_events
    )

    VilanoKernel.Storage.AgentRelationships.maybe_trigger_relationships_for_terminal_run!(
      run["id"],
      now,
      prepared.linked_exit_cancellations
    )

    %{
      "run" => VilanoKernel.Storage.get_run(run["id"]),
      "status" => "failed",
      "activeLeaseWorkerId" => run["leaseWorkerId"]
    }
  end

  def prepare_workflow_cancellation!(run, error_body, reason, now) do
    prepare_workflow_cancellation!(run, error_body, reason, now, MapSet.new(), [])
  end

  def prepare_workflow_cancellation!(run, error_body, reason, now, visited_run_ids) do
    prepare_workflow_cancellation!(run, error_body, reason, now, visited_run_ids, [])
  end

  def prepare_workflow_cancellation!(run, error_body, reason, now, visited_run_ids, opts) do
    visited_run_ids = MapSet.put(visited_run_ids, run["id"])

    snapshot =
      VilanoKernel.Storage.FailureRecovery.Cancellation.workflow_cancellation_snapshot(run["id"])
      |> exclude_snapshot_children(Keyword.get(opts, :excluded_child_run_ids, MapSet.new()))

    cancelled_event =
      EventPayloads.prepare_body_for_storage!(
        workflow_cancelled_event_body(run, error_body, reason, snapshot)
      )

    step_cancelled_events =
      try do
        prepare_step_cancelled_events!(snapshot["runningSteps"], error_body)
      rescue
        error ->
          discard_prepared_payload(cancelled_event)
          reraise error, __STACKTRACE__
      end

    exec_cancelled_events =
      try do
        prepare_exec_cancelled_events!(snapshot["runningExecs"], error_body)
      rescue
        error ->
          discard_prepared_events(step_cancelled_events)
          discard_prepared_payload(cancelled_event)
          reraise error, __STACKTRACE__
      end

    outbound_service_ask_cancellations =
      try do
        VilanoKernel.Storage.FailureRecovery.Cancellation.prepare_outbound_service_ask_cancellations!(
          snapshot["waitingServiceAskOps"],
          error_body,
          reason,
          now,
          visited_run_ids
        )
      rescue
        error ->
          discard_prepared_events(exec_cancelled_events)
          discard_prepared_events(step_cancelled_events)
          discard_prepared_payload(cancelled_event)
          reraise error, __STACKTRACE__
      end

    child_cancellations =
      try do
        prepare_child_cancellations!(
          snapshot["openChildren"],
          error_body,
          reason,
          now,
          visited_run_ids
        )
      rescue
        error ->
          VilanoKernel.Storage.FailureRecovery.Cancellation.discard_prepared_outbound_service_ask_cancellations(
            outbound_service_ask_cancellations
          )

          discard_prepared_events(exec_cancelled_events)
          discard_prepared_events(step_cancelled_events)
          discard_prepared_payload(cancelled_event)
          reraise error, __STACKTRACE__
      end

    child_wait_events =
      try do
        VilanoKernel.Storage.AgentRelationships.prepare_child_result_wait_satisfied_events(
          run["id"],
          "cancelled",
          error_body
        )
      rescue
        error ->
          discard_prepared_child_cancellations(child_cancellations)

          VilanoKernel.Storage.FailureRecovery.Cancellation.discard_prepared_outbound_service_ask_cancellations(
            outbound_service_ask_cancellations
          )

          discard_prepared_events(exec_cancelled_events)
          discard_prepared_events(step_cancelled_events)
          discard_prepared_payload(cancelled_event)
          reraise error, __STACKTRACE__
      end

    restart_events =
      try do
        VilanoKernel.Storage.Supervision.prepare_terminal_restart_run_started_events(
          run["id"],
          "cancelled",
          now
        )
      rescue
        error ->
          VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events(
            child_wait_events
          )

          discard_prepared_child_cancellations(child_cancellations)

          VilanoKernel.Storage.FailureRecovery.Cancellation.discard_prepared_outbound_service_ask_cancellations(
            outbound_service_ask_cancellations
          )

          discard_prepared_events(exec_cancelled_events)
          discard_prepared_events(step_cancelled_events)
          discard_prepared_payload(cancelled_event)
          reraise error, __STACKTRACE__
      end

    supervision_cancellations =
      try do
        VilanoKernel.Storage.Supervision.prepare_terminal_sibling_cancellations(
          run["id"],
          "cancelled",
          now,
          visited_run_ids
        )
      rescue
        error ->
          VilanoKernel.Storage.Supervision.discard_prepared_restart_events(restart_events)

          VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events(
            child_wait_events
          )

          discard_prepared_child_cancellations(child_cancellations)

          VilanoKernel.Storage.FailureRecovery.Cancellation.discard_prepared_outbound_service_ask_cancellations(
            outbound_service_ask_cancellations
          )

          discard_prepared_events(exec_cancelled_events)
          discard_prepared_events(step_cancelled_events)
          discard_prepared_payload(cancelled_event)
          reraise error, __STACKTRACE__
      end

    supervision_events =
      try do
        VilanoKernel.Storage.Supervision.prepare_terminal_supervision_events(
          run["id"],
          "cancelled",
          error_body,
          now,
          visited_run_ids
        )
      rescue
        error ->
          VilanoKernel.Storage.Supervision.discard_prepared_sibling_cancellations(
            supervision_cancellations
          )

          VilanoKernel.Storage.Supervision.discard_prepared_restart_events(restart_events)

          VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events(
            child_wait_events
          )

          discard_prepared_child_cancellations(child_cancellations)

          VilanoKernel.Storage.FailureRecovery.Cancellation.discard_prepared_outbound_service_ask_cancellations(
            outbound_service_ask_cancellations
          )

          discard_prepared_events(exec_cancelled_events)
          discard_prepared_events(step_cancelled_events)
          discard_prepared_payload(cancelled_event)
          reraise error, __STACKTRACE__
      end

    linked_exit_cancellations =
      try do
        VilanoKernel.Storage.AgentRelationships.prepare_terminal_linked_exit_cancellations(
          run["id"],
          "cancelled",
          now,
          visited_run_ids,
          error_body
        )
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

          discard_prepared_child_cancellations(child_cancellations)

          VilanoKernel.Storage.FailureRecovery.Cancellation.discard_prepared_outbound_service_ask_cancellations(
            outbound_service_ask_cancellations
          )

          discard_prepared_events(exec_cancelled_events)
          discard_prepared_events(step_cancelled_events)
          discard_prepared_payload(cancelled_event)
          reraise error, __STACKTRACE__
      end

    %{
      cancelled_event: cancelled_event,
      child_wait_events: child_wait_events,
      restart_events: restart_events,
      supervision_cancellations: supervision_cancellations,
      supervision_events: supervision_events,
      linked_exit_cancellations: linked_exit_cancellations,
      step_cancelled_events: step_cancelled_events,
      exec_cancelled_events: exec_cancelled_events,
      outbound_service_ask_cancellations: outbound_service_ask_cancellations,
      child_cancellations: child_cancellations,
      expected_counts: cancellation_counts(snapshot),
      expected_had_active_lease: not is_nil(run["leaseId"])
    }
  end

  def discard_prepared_workflow_cancellation(nil), do: :ok

  def discard_prepared_workflow_cancellation(%{} = prepared) do
    prepared
    |> Map.get(:cancelled_event)
    |> discard_prepared_payload()

    prepared
    |> Map.get(:child_wait_events, %{})
    |> VilanoKernel.Storage.AgentRelationships.discard_prepared_child_result_wait_events()

    prepared
    |> Map.get(:step_cancelled_events, %{})
    |> discard_prepared_events()

    prepared
    |> Map.get(:exec_cancelled_events, %{})
    |> discard_prepared_events()

    prepared
    |> Map.get(:outbound_service_ask_cancellations, %{})
    |> VilanoKernel.Storage.FailureRecovery.Cancellation.discard_prepared_outbound_service_ask_cancellations()

    prepared
    |> Map.get(:child_cancellations, %{})
    |> discard_prepared_child_cancellations()

    prepared
    |> Map.get(:restart_events, %{})
    |> VilanoKernel.Storage.Supervision.discard_prepared_restart_events()

    prepared
    |> Map.get(:supervision_cancellations, %{})
    |> VilanoKernel.Storage.Supervision.discard_prepared_sibling_cancellations()

    prepared
    |> Map.get(:supervision_events, %{})
    |> VilanoKernel.Storage.Supervision.discard_prepared_terminal_supervision_events()

    prepared
    |> Map.get(:linked_exit_cancellations, %{})
    |> VilanoKernel.Storage.AgentRelationships.discard_prepared_linked_exit_cancellations()
  end

  def cancel_workflow_run_instance!(run, error_body, reason, now, prepared_cancellation \\ nil) do
    if terminal_run_status?(run["status"]) do
      %{
        "run" => VilanoKernel.Storage.get_run(run["id"]),
        "cancelledWaitCount" => 0,
        "cancelledChildRunCount" => 0,
        "cancelledServiceAskCount" => 0,
        "hadActiveLease" => false
      }
    else
      cancel_with_prepared_workflow_cancellation!(
        run,
        error_body,
        reason,
        now,
        prepared_cancellation
      )
    end
  end

  defp cancel_with_prepared_workflow_cancellation!(
         run,
         error_body,
         reason,
         now,
         nil
       ) do
    prepared = prepare_workflow_cancellation!(run, error_body, reason, now)

    try do
      do_cancel_workflow_run_instance!(run, error_body, reason, now, prepared)
    after
      discard_prepared_workflow_cancellation(prepared)
    end
  end

  defp cancel_with_prepared_workflow_cancellation!(
         run,
         error_body,
         reason,
         now,
         prepared
       ) do
    do_cancel_workflow_run_instance!(run, error_body, reason, now, prepared)
  end

  defp do_cancel_workflow_run_instance!(run, error_body, reason, now, prepared) do
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
        now,
        prepared.step_cancelled_events
      )

    _cancelled_exec_count =
      VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_running_execs!(
        run["id"],
        error_body,
        now,
        prepared.exec_cancelled_events
      )

    cancelled_service_ask_count =
      VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_outbound_service_asks!(
        run["id"],
        error_body,
        reason,
        now,
        prepared.outbound_service_ask_cancellations
      )

    cancelled_child_run_count =
      VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_child_runs_for_parent!(
        run["id"],
        error_body,
        reason,
        now,
        prepared.child_cancellations
      )

    counts = %{
      "cancelledWaitCount" => cancelled_wait_count,
      "cancelledChildRunCount" => cancelled_child_run_count,
      "cancelledServiceAskCount" => cancelled_service_ask_count
    }

    validate_prepared_cancellation_plan!(prepared, counts, not is_nil(run["leaseId"]))
    SqlSupport.append_prepared_event!(run["id"], "RunCancelled", prepared.cancelled_event, now)

    VilanoKernel.Storage.AgentRelationships.wake_waiting_parents_for_child!(
      run["id"],
      "cancelled",
      error_body,
      now,
      prepared.child_wait_events
    )

    VilanoKernel.Storage.Supervision.maybe_apply_supervision_for_terminal_run!(
      run["id"],
      now,
      prepared.restart_events,
      Map.get(prepared, :supervision_cancellations),
      Map.get(prepared, :supervision_events)
    )

    VilanoKernel.Storage.AgentRelationships.maybe_trigger_relationships_for_terminal_run!(
      run["id"],
      now,
      Map.get(prepared, :linked_exit_cancellations)
    )

    %{
      "run" => VilanoKernel.Storage.get_run(run["id"]),
      "cancelledWaitCount" => cancelled_wait_count,
      "cancelledChildRunCount" => cancelled_child_run_count,
      "cancelledServiceAskCount" => cancelled_service_ask_count,
      "hadActiveLease" => not is_nil(run["leaseId"]),
      "activeLeaseWorkerId" => run["leaseWorkerId"]
    }
  end

  defp prepare_step_cancelled_events!(steps, error_body) do
    prepare_preflight_events!(steps, "op_key", fn step ->
      body = %{"name" => step["name"], "key" => step["op_key"], "error" => error_body}
      EventPayloads.prepare_body_for_storage!(body)
    end)
  end

  defp prepare_exec_cancelled_events!(execs, error_body) do
    prepare_preflight_events!(execs, "op_key", fn exec ->
      body = %{
        "name" => exec["name"],
        "key" => exec["op_key"],
        "attempt" => exec["attempt"],
        "error" => error_body
      }

      EventPayloads.prepare_body_for_storage!(body)
    end)
  end

  defp prepare_child_cancellations!(children, error_body, reason, now, visited_run_ids) do
    do_prepare_child_cancellations!(children, error_body, reason, now, visited_run_ids, %{})
  end

  defp do_prepare_child_cancellations!([], _error_body, _reason, _now, _visited_run_ids, acc),
    do: acc

  defp do_prepare_child_cancellations!(
         [child | rest],
         error_body,
         reason,
         now,
         visited_run_ids,
         acc
       ) do
    try do
      next_acc =
        case VilanoKernel.Storage.get_run(child["child_run_id"]) do
          nil ->
            acc

          child_run ->
            if terminal_run_status?(child_run["status"]) or
                 MapSet.member?(visited_run_ids, child_run["id"]) do
              acc
            else
              Map.put(
                acc,
                child_run["id"],
                prepare_workflow_cancellation!(
                  child_run,
                  error_body,
                  reason,
                  now,
                  MapSet.put(visited_run_ids, child_run["id"])
                )
              )
            end
        end

      do_prepare_child_cancellations!(
        rest,
        error_body,
        reason,
        now,
        visited_run_ids,
        next_acc
      )
    rescue
      error ->
        discard_prepared_child_cancellations(acc)
        reraise error, __STACKTRACE__
    end
  end

  defp prepare_preflight_events!(rows, key, prepare_fun) do
    do_prepare_preflight_events!(rows, key, prepare_fun, %{})
  end

  defp do_prepare_preflight_events!([], _key, _prepare_fun, acc), do: acc

  defp do_prepare_preflight_events!([row | rest], key, prepare_fun, acc) do
    try do
      storage = prepare_fun.(row)
      do_prepare_preflight_events!(rest, key, prepare_fun, Map.put(acc, row[key], storage))
    rescue
      error ->
        discard_prepared_events(acc)
        reraise error, __STACKTRACE__
    end
  end

  defp cancellation_counts(snapshot) do
    %{
      "cancelledWaitCount" => snapshot["cancelledWaitCount"],
      "cancelledChildRunCount" => snapshot["cancelledChildRunCount"],
      "cancelledServiceAskCount" => snapshot["cancelledServiceAskCount"]
    }
  end

  defp exclude_snapshot_children(snapshot, excluded_child_run_ids) do
    open_children =
      snapshot["openChildren"]
      |> Enum.reject(&MapSet.member?(excluded_child_run_ids, &1["child_run_id"]))

    snapshot
    |> Map.put("openChildren", open_children)
    |> Map.put("cancelledChildRunCount", length(open_children))
  end

  defp workflow_cancelled_event_body(run, error_body, reason, counts) do
    %{
      "reason" => reason,
      "hadActiveLease" => not is_nil(run["leaseId"]),
      "cancelledWaitCount" => counts["cancelledWaitCount"],
      "cancelledChildRunCount" => counts["cancelledChildRunCount"],
      "cancelledServiceAskCount" => counts["cancelledServiceAskCount"],
      "error" => error_body
    }
  end

  defp validate_prepared_cancellation_plan!(
         %{
           expected_counts: expected_counts,
           expected_had_active_lease: expected_had_active_lease
         },
         counts,
         had_active_lease
       )
       when is_map(expected_counts) do
    if expected_counts == counts and expected_had_active_lease == had_active_lease do
      :ok
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp validate_prepared_cancellation_plan!(_prepared, _counts, _had_active_lease), do: :ok

  defp discard_prepared_payload(nil), do: :ok
  defp discard_prepared_payload(storage), do: EventPayloads.discard_prepared_payload!(storage)

  defp discard_prepared_events(events) when is_map(events) do
    Enum.each(events, fn {_key, storage} -> discard_prepared_payload(storage) end)
  end

  defp discard_prepared_events(_events), do: :ok

  defp discard_prepared_child_cancellations(child_cancellations)
       when is_map(child_cancellations) do
    Enum.each(child_cancellations, fn {_run_id, prepared} ->
      discard_prepared_workflow_cancellation(prepared)
    end)
  end

  defp discard_prepared_child_cancellations(_child_cancellations), do: :ok

  def terminal_run_status?(status), do: status in ["completed", "failed", "cancelled", "stopped"]

  def cancellation_error(message, reason) do
    %{
      "name" => "CancelledError",
      "message" => message,
      "reason" => reason
    }
  end
end
