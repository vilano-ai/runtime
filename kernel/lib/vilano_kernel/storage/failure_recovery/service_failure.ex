defmodule VilanoKernel.Storage.FailureRecovery.ServiceFailure do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{EventPayloads, RunControl, ServiceSupport, Support}
  alias VilanoKernel.Storage.Support.Sql, as: SqlSupport

  import Support
  import ServiceSupport

  def stop_service_run_instance!(service_run, error_body, reason, now, lease_id \\ nil)
  def stop_service_run_instance!(nil, _error_body, _reason, _now, _lease_id), do: nil

  def stop_service_run_instance!(service_run, error_body, reason, now, lease_id) do
    stop_service_run_instance!(service_run, error_body, reason, now, lease_id, nil)
  end

  def stop_service_run_instance!(nil, _error_body, _reason, _now, _lease_id, _prepared_stop),
    do: nil

  def stop_service_run_instance!(service_run, error_body, reason, now, lease_id, nil) do
    if service_run["status"] == "stopped" do
      stop_service_run_instance!(service_run, error_body, reason, now, lease_id, %{})
    else
      prepared_stop = prepare_service_stop!(service_run, error_body, reason, now)

      try do
        stop_service_run_instance!(service_run, error_body, reason, now, lease_id, prepared_stop)
      after
        discard_prepared_service_stop(prepared_stop)
      end
    end
  end

  def stop_service_run_instance!(service_run, error_body, reason, now, lease_id, prepared_stop) do
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
        fail_service_open_envelope_for_stop!(
          service_run,
          envelope,
          error_body,
          now,
          prepared_stop.turn_failed_events,
          prepared_stop.ask_waiter_events
        )
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
          now,
          prepared_stop.step_cancelled_events
        )

      _cancelled_exec_count =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_running_execs!(
          service_run["id"],
          error_body,
          now,
          prepared_stop.exec_cancelled_events
        )

      cancelled_service_ask_count =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_outbound_service_asks!(
          service_run["id"],
          error_body,
          reason,
          now,
          prepared_stop.outbound_service_ask_cancellations
        )

      cancelled_child_run_count =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_child_runs_for_parent!(
          service_run["id"],
          error_body,
          reason,
          now,
          prepared_stop.child_cancellations
        )

      validate_prepared_service_stop_plan!(
        prepared_stop,
        open_envelopes,
        cancelled_wait_count,
        cancelled_child_run_count,
        cancelled_service_ask_count,
        not is_nil(service_run["leaseId"])
      )

      SqlSupport.append_prepared_event!(
        service_run["id"],
        "ServiceStopped",
        prepared_stop.service_stopped_event,
        now
      )

      VilanoKernel.Storage.AgentRelationships.maybe_trigger_relationships_for_terminal_run!(
        service_run["id"],
        now,
        prepared_stop.linked_exit_cancellations
      )

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

  def prepare_service_stop!(service_run, error_body, reason, now) do
    prepare_service_stop!(service_run, error_body, reason, now, MapSet.new(), [])
  end

  def prepare_service_stop!(service_run, error_body, reason, now, visited_run_ids) do
    prepare_service_stop!(service_run, error_body, reason, now, visited_run_ids, [])
  end

  def prepare_service_stop!(service_run, error_body, reason, now, visited_run_ids, opts) do
    excluded_envelope_ids = Keyword.get(opts, :excluded_envelope_ids, MapSet.new())

    open_envelopes =
      service_run["id"]
      |> list_open_service_envelopes()
      |> Enum.reject(&MapSet.member?(excluded_envelope_ids, &1["id"]))

    had_in_flight_turn = Enum.any?(open_envelopes, &(&1["status"] == "processing"))

    snapshot =
      VilanoKernel.Storage.FailureRecovery.Cancellation.workflow_cancellation_snapshot(
        service_run["id"]
      )
      |> exclude_snapshot_children(Keyword.get(opts, :excluded_child_run_ids, MapSet.new()))

    service_stopped_event =
      EventPayloads.prepare_body_for_storage!(
        service_stopped_event_body(
          service_run,
          reason,
          open_envelopes,
          had_in_flight_turn,
          snapshot
        )
      )

    turn_failed_events =
      try do
        prepare_turn_failed_events!(open_envelopes, error_body)
      rescue
        error ->
          EventPayloads.discard_prepared_payload!(service_stopped_event)
          reraise error, __STACKTRACE__
      end

    step_cancelled_events =
      try do
        prepare_step_cancelled_events!(snapshot["runningSteps"], error_body)
      rescue
        error ->
          discard_prepared_events(turn_failed_events)
          EventPayloads.discard_prepared_payload!(service_stopped_event)
          reraise error, __STACKTRACE__
      end

    exec_cancelled_events =
      try do
        prepare_exec_cancelled_events!(snapshot["runningExecs"], error_body)
      rescue
        error ->
          discard_prepared_events(step_cancelled_events)
          discard_prepared_events(turn_failed_events)
          EventPayloads.discard_prepared_payload!(service_stopped_event)
          reraise error, __STACKTRACE__
      end

    ask_waiter_events =
      try do
        prepare_service_ask_waiter_events!(open_envelopes, "failed", error_body)
      rescue
        error ->
          discard_prepared_events(exec_cancelled_events)
          discard_prepared_events(step_cancelled_events)
          discard_prepared_events(turn_failed_events)
          EventPayloads.discard_prepared_payload!(service_stopped_event)
          reraise error, __STACKTRACE__
      end

    outbound_service_ask_cancellations =
      try do
        VilanoKernel.Storage.FailureRecovery.Cancellation.prepare_outbound_service_ask_cancellations!(
          snapshot["waitingServiceAskOps"],
          error_body,
          reason,
          now,
          MapSet.put(visited_run_ids, service_run["id"])
        )
      rescue
        error ->
          discard_prepared_service_ask_waiter_events(ask_waiter_events)
          discard_prepared_events(exec_cancelled_events)
          discard_prepared_events(step_cancelled_events)
          discard_prepared_events(turn_failed_events)
          EventPayloads.discard_prepared_payload!(service_stopped_event)
          reraise error, __STACKTRACE__
      end

    child_cancellations =
      try do
        prepare_child_cancellations!(
          snapshot["openChildren"],
          error_body,
          reason,
          now,
          MapSet.put(visited_run_ids, service_run["id"])
        )
      rescue
        error ->
          VilanoKernel.Storage.FailureRecovery.Cancellation.discard_prepared_outbound_service_ask_cancellations(
            outbound_service_ask_cancellations
          )

          discard_prepared_service_ask_waiter_events(ask_waiter_events)
          discard_prepared_events(exec_cancelled_events)
          discard_prepared_events(step_cancelled_events)
          discard_prepared_events(turn_failed_events)
          EventPayloads.discard_prepared_payload!(service_stopped_event)
          reraise error, __STACKTRACE__
      end

    try do
      %{
        service_stopped_event: service_stopped_event,
        turn_failed_events: turn_failed_events,
        ask_waiter_events: ask_waiter_events,
        step_cancelled_events: step_cancelled_events,
        exec_cancelled_events: exec_cancelled_events,
        outbound_service_ask_cancellations: outbound_service_ask_cancellations,
        child_cancellations: child_cancellations,
        linked_exit_cancellations:
          VilanoKernel.Storage.AgentRelationships.prepare_terminal_linked_exit_cancellations(
            service_run["id"],
            "stopped",
            now,
            MapSet.put(visited_run_ids, service_run["id"]),
            error_body
          ),
        expected_open_envelope_ids: Enum.map(open_envelopes, & &1["id"]) |> Enum.sort(),
        expected_counts: %{
          "cancelledWaitCount" => snapshot["cancelledWaitCount"],
          "cancelledChildRunCount" => snapshot["cancelledChildRunCount"],
          "cancelledServiceAskCount" => snapshot["cancelledServiceAskCount"]
        },
        expected_had_active_lease: not is_nil(service_run["leaseId"])
      }
    rescue
      error ->
        discard_prepared_child_cancellations(child_cancellations)

        VilanoKernel.Storage.FailureRecovery.Cancellation.discard_prepared_outbound_service_ask_cancellations(
          outbound_service_ask_cancellations
        )

        discard_prepared_service_ask_waiter_events(ask_waiter_events)
        discard_prepared_events(exec_cancelled_events)
        discard_prepared_events(step_cancelled_events)
        discard_prepared_events(turn_failed_events)
        EventPayloads.discard_prepared_payload!(service_stopped_event)
        reraise error, __STACKTRACE__
    end
  end

  def discard_prepared_service_stop(nil), do: :ok

  def discard_prepared_service_stop(%{} = prepared) do
    prepared
    |> Map.get(:service_stopped_event)
    |> discard_prepared_payload()

    prepared
    |> Map.get(:turn_failed_events, %{})
    |> discard_prepared_events()

    prepared
    |> Map.get(:ask_waiter_events, %{})
    |> discard_prepared_service_ask_waiter_events()

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
    |> Map.get(:linked_exit_cancellations, %{})
    |> VilanoKernel.Storage.AgentRelationships.discard_prepared_linked_exit_cancellations()
  end

  def prepare_service_open_envelope_failure!(
        service_run,
        envelope,
        error_body,
        reason,
        now,
        wake_waiter?,
        visited_run_ids
      ) do
    processing? = envelope["status"] == "processing"
    visited_run_ids = MapSet.put(visited_run_ids, service_run["id"])

    snapshot =
      if processing? do
        VilanoKernel.Storage.FailureRecovery.Cancellation.workflow_cancellation_snapshot(
          service_run["id"]
        )
      else
        empty_cancellation_snapshot()
      end

    ask_waiter_event =
      if wake_waiter? and envelope["kind"] == "ask" and is_binary(envelope["correlation_id"]) do
        prepare_service_ask_waiter_event(envelope["correlation_id"], "failed", error_body)
      end

    turn_failed_event =
      try do
        if processing? do
          EventPayloads.prepare_body_for_storage!(%{
            "envelopeId" => envelope["id"],
            "kind" => envelope["kind"],
            "name" => envelope["name"],
            "error" => error_body
          })
        end
      rescue
        error ->
          discard_prepared_service_ask_waiter_event(ask_waiter_event)
          reraise error, __STACKTRACE__
      end

    step_cancelled_events =
      try do
        prepare_step_cancelled_events!(snapshot["runningSteps"], error_body)
      rescue
        error ->
          discard_prepared_payload(turn_failed_event)
          discard_prepared_service_ask_waiter_event(ask_waiter_event)
          reraise error, __STACKTRACE__
      end

    exec_cancelled_events =
      try do
        prepare_exec_cancelled_events!(snapshot["runningExecs"], error_body)
      rescue
        error ->
          discard_prepared_events(step_cancelled_events)
          discard_prepared_payload(turn_failed_event)
          discard_prepared_service_ask_waiter_event(ask_waiter_event)
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
          discard_prepared_payload(turn_failed_event)
          discard_prepared_service_ask_waiter_event(ask_waiter_event)
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
          discard_prepared_payload(turn_failed_event)
          discard_prepared_service_ask_waiter_event(ask_waiter_event)
          reraise error, __STACKTRACE__
      end

    %{
      service_run_id: service_run["id"],
      envelope_id: envelope["id"],
      envelope_status: envelope["status"],
      wake_waiter?: wake_waiter?,
      ask_waiter_event: ask_waiter_event,
      turn_failed_event: turn_failed_event,
      step_cancelled_events: step_cancelled_events,
      exec_cancelled_events: exec_cancelled_events,
      outbound_service_ask_cancellations: outbound_service_ask_cancellations,
      child_cancellations: child_cancellations
    }
  end

  def discard_prepared_service_open_envelope_failure(nil), do: :ok

  def discard_prepared_service_open_envelope_failure(%{} = prepared) do
    prepared
    |> Map.get(:ask_waiter_event)
    |> discard_prepared_service_ask_waiter_event()

    prepared
    |> Map.get(:turn_failed_event)
    |> discard_prepared_payload()

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
  end

  defp service_stopped_event_body(
         service_run,
         reason,
         open_envelopes,
         had_in_flight_turn,
         snapshot
       ) do
    %{
      "reason" => reason,
      "hadActiveLease" => not is_nil(service_run["leaseId"]),
      "hadInFlightTurn" => had_in_flight_turn,
      "stoppedEnvelopeCount" => length(open_envelopes),
      "cancelledWaitCount" => snapshot["cancelledWaitCount"],
      "cancelledChildRunCount" => snapshot["cancelledChildRunCount"],
      "cancelledServiceAskCount" => snapshot["cancelledServiceAskCount"]
    }
  end

  defp prepare_turn_failed_events!(open_envelopes, error_body) do
    open_envelopes
    |> Enum.filter(&(&1["status"] == "processing"))
    |> do_prepare_turn_failed_events!(error_body, %{})
  end

  defp do_prepare_turn_failed_events!([], _error_body, acc), do: acc

  defp do_prepare_turn_failed_events!([envelope | rest], error_body, acc) do
    try do
      storage =
        EventPayloads.prepare_body_for_storage!(%{
          "envelopeId" => envelope["id"],
          "kind" => envelope["kind"],
          "name" => envelope["name"],
          "error" => error_body
        })

      do_prepare_turn_failed_events!(
        rest,
        error_body,
        Map.put(acc, envelope["id"], storage)
      )
    rescue
      error ->
        discard_prepared_events(acc)
        reraise error, __STACKTRACE__
    end
  end

  defp prepare_service_ask_waiter_events!(open_envelopes, status, payload) do
    open_envelopes
    |> Enum.filter(&(&1["kind"] == "ask" and is_binary(&1["correlation_id"])))
    |> do_prepare_service_ask_waiter_events!(status, payload, %{})
  end

  defp do_prepare_service_ask_waiter_events!([], _status, _payload, acc), do: acc

  defp do_prepare_service_ask_waiter_events!([envelope | rest], status, payload, acc) do
    try do
      prepared =
        prepare_service_ask_waiter_event(envelope["correlation_id"], status, payload)

      do_prepare_service_ask_waiter_events!(
        rest,
        status,
        payload,
        Map.put(acc, envelope["id"], prepared)
      )
    rescue
      error ->
        discard_prepared_service_ask_waiter_events(acc)
        reraise error, __STACKTRACE__
    end
  end

  defp prepare_step_cancelled_events!(steps, error_body) do
    prepare_preflight_events!(steps, "op_key", fn step ->
      EventPayloads.prepare_body_for_storage!(%{
        "name" => step["name"],
        "key" => step["op_key"],
        "error" => error_body
      })
    end)
  end

  defp prepare_exec_cancelled_events!(execs, error_body) do
    prepare_preflight_events!(execs, "op_key", fn exec ->
      EventPayloads.prepare_body_for_storage!(%{
        "name" => exec["name"],
        "key" => exec["op_key"],
        "attempt" => exec["attempt"],
        "error" => error_body
      })
    end)
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
            if VilanoKernel.Storage.FailureRecovery.terminal_run_status?(child_run["status"]) or
                 MapSet.member?(visited_run_ids, child_run["id"]) do
              acc
            else
              Map.put(
                acc,
                child_run["id"],
                VilanoKernel.Storage.FailureRecovery.WorkflowFailure.prepare_workflow_cancellation!(
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

  defp validate_prepared_service_stop_plan!(
         %{
           expected_open_envelope_ids: expected_open_envelope_ids,
           expected_counts: expected_counts,
           expected_had_active_lease: expected_had_active_lease
         },
         open_envelopes,
         cancelled_wait_count,
         cancelled_child_run_count,
         cancelled_service_ask_count,
         had_active_lease
       ) do
    open_envelope_ids = Enum.map(open_envelopes, & &1["id"]) |> Enum.sort()

    counts = %{
      "cancelledWaitCount" => cancelled_wait_count,
      "cancelledChildRunCount" => cancelled_child_run_count,
      "cancelledServiceAskCount" => cancelled_service_ask_count
    }

    if expected_open_envelope_ids == open_envelope_ids and expected_counts == counts and
         expected_had_active_lease == had_active_lease do
      :ok
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp validate_prepared_service_stop_plan!(
         _prepared,
         _open_envelopes,
         _waits,
         _children,
         _asks,
         _lease
       ),
       do: :ok

  defp discard_prepared_payload(nil), do: :ok
  defp discard_prepared_payload(storage), do: EventPayloads.discard_prepared_payload!(storage)

  defp discard_prepared_events(prepared_events) when is_map(prepared_events) do
    prepared_events
    |> Map.values()
    |> Enum.each(&discard_prepared_payload/1)
  end

  defp discard_prepared_events(_prepared_events), do: :ok

  defp exclude_snapshot_children(snapshot, excluded_child_run_ids) do
    open_children =
      snapshot["openChildren"]
      |> Enum.reject(&MapSet.member?(excluded_child_run_ids, &1["child_run_id"]))

    snapshot
    |> Map.put("openChildren", open_children)
    |> Map.put("cancelledChildRunCount", length(open_children))
  end

  defp discard_prepared_child_cancellations(child_cancellations)
       when is_map(child_cancellations) do
    Enum.each(child_cancellations, fn {_run_id, prepared} ->
      VilanoKernel.Storage.FailureRecovery.discard_prepared_workflow_cancellation(prepared)
    end)
  end

  defp discard_prepared_child_cancellations(_child_cancellations), do: :ok

  def prepare_timeout_result_for_run!(run, error_body, now) do
    case run["definitionKind"] do
      "workflow" ->
        %{
          kind: :workflow_failure,
          run_id: run["id"],
          run_status: run["status"],
          prepared_failure:
            VilanoKernel.Storage.FailureRecovery.WorkflowFailure.prepare_workflow_failure!(
              run,
              error_body,
              now
            )
        }

      "service" ->
        case get_processing_service_envelope_for_run(run["id"]) do
          nil ->
            %{
              kind: :service_idle,
              run_id: run["id"],
              run_status: run["status"]
            }

          envelope ->
            ask_waiter_event =
              if envelope["kind"] == "ask" and is_binary(envelope["correlation_id"]) do
                prepare_service_ask_waiter_event(
                  envelope["correlation_id"],
                  "failed",
                  error_body
                )
              end

            turn_failed_event =
              try do
                EventPayloads.prepare_body_for_storage!(%{
                  "envelopeId" => envelope["id"],
                  "kind" => envelope["kind"],
                  "name" => envelope["name"],
                  "error" => error_body
                })
              rescue
                error ->
                  discard_prepared_service_ask_waiter_event(ask_waiter_event)
                  reraise error, __STACKTRACE__
              end

            %{
              kind: :service_turn_failed,
              run_id: run["id"],
              run_status: run["status"],
              envelope_id: envelope["id"],
              envelope_status: envelope["status"],
              envelope_kind: envelope["kind"],
              correlation_id: envelope["correlation_id"],
              turn_failed_event: turn_failed_event,
              ask_waiter_event: ask_waiter_event
            }
        end

      _ ->
        %{kind: :none, run_id: run["id"], run_status: run["status"]}
    end
  end

  def discard_prepared_timeout_result(nil), do: :ok

  def discard_prepared_timeout_result(%{kind: :workflow_failure} = prepared) do
    prepared
    |> Map.get(:prepared_failure)
    |> VilanoKernel.Storage.FailureRecovery.WorkflowFailure.discard_prepared_workflow_failure()
  end

  def discard_prepared_timeout_result(%{kind: :service_turn_failed} = prepared) do
    prepared
    |> Map.get(:ask_waiter_event)
    |> discard_prepared_service_ask_waiter_event()

    prepared
    |> Map.get(:turn_failed_event)
    |> discard_prepared_payload()
  end

  def discard_prepared_timeout_result(_prepared), do: :ok

  def timeout_result_for_run!(run, error_body, now, lease_id, prepared_timeout \\ nil) do
    case run["definitionKind"] do
      "workflow" ->
        VilanoKernel.Storage.FailureRecovery.WorkflowFailure.fail_workflow_run_instance!(
          run,
          error_body,
          now,
          lease_id,
          prepared_timeout_workflow_failure!(prepared_timeout, run)
        )

      "service" ->
        case get_processing_service_envelope_for_run(run["id"]) do
          nil ->
            validate_prepared_timeout_service_idle!(prepared_timeout, run)

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
            prepared_turn_failure =
              prepared_timeout_service_turn_failure!(prepared_timeout, run, envelope)

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

            append_timeout_turn_failed_event!(
              run["id"],
              envelope,
              %{
                "envelopeId" => envelope["id"],
                "kind" => envelope["kind"],
                "name" => envelope["name"],
                "error" => error_body
              },
              now,
              prepared_turn_failure
            )

            if envelope["kind"] == "ask" do
              wake_service_ask_waiter!(
                envelope["correlation_id"],
                "failed",
                error_body,
                now,
                prepared_timeout_ask_waiter_event(prepared_turn_failure)
              )
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

  defp prepared_timeout_workflow_failure!(nil, _run), do: nil

  defp prepared_timeout_workflow_failure!(
         %{kind: :workflow_failure, run_id: run_id, run_status: run_status} = prepared,
         %{"id" => run_id, "status" => run_status}
       ) do
    Map.fetch!(prepared, :prepared_failure)
  end

  defp prepared_timeout_workflow_failure!(_prepared_timeout, _run),
    do: Repo.rollback(:stale_cancellation_plan)

  defp validate_prepared_timeout_service_idle!(nil, _run), do: :ok

  defp validate_prepared_timeout_service_idle!(
         %{kind: :service_idle, run_id: run_id, run_status: run_status},
         %{"id" => run_id, "status" => run_status}
       ),
       do: :ok

  defp validate_prepared_timeout_service_idle!(_prepared_timeout, _run),
    do: Repo.rollback(:stale_cancellation_plan)

  defp prepared_timeout_service_turn_failure!(nil, _run, _envelope), do: nil

  defp prepared_timeout_service_turn_failure!(
         %{
           kind: :service_turn_failed,
           run_id: run_id,
           run_status: run_status,
           envelope_id: envelope_id,
           envelope_status: envelope_status,
           envelope_kind: envelope_kind,
           correlation_id: correlation_id
         } = prepared,
         %{"id" => run_id, "status" => run_status},
         %{
           "id" => envelope_id,
           "status" => envelope_status,
           "kind" => envelope_kind,
           "correlation_id" => correlation_id
         }
       ) do
    prepared
  end

  defp prepared_timeout_service_turn_failure!(_prepared_timeout, _run, _envelope),
    do: Repo.rollback(:stale_cancellation_plan)

  defp append_timeout_turn_failed_event!(run_id, _envelope, body, now, nil) do
    append_event!(run_id, "TurnFailed", body, now)
  end

  defp append_timeout_turn_failed_event!(
         run_id,
         _envelope,
         _body,
         now,
         %{turn_failed_event: storage}
       ) do
    SqlSupport.append_prepared_event!(run_id, "TurnFailed", storage, now)
  end

  defp prepared_timeout_ask_waiter_event(nil), do: nil

  defp prepared_timeout_ask_waiter_event(prepared_turn_failure) do
    Map.get(prepared_turn_failure, :ask_waiter_event)
  end

  defp fail_service_open_envelope_for_stop!(
         service_run,
         envelope,
         error_body,
         now,
         turn_failed_events,
         ask_waiter_events
       ) do
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

    if envelope["kind"] == "ask" and envelope["correlation_id"] do
      wake_service_ask_waiter!(
        envelope["correlation_id"],
        "failed",
        error_body,
        now,
        prepared_ask_waiter_event_for_envelope!(ask_waiter_events, envelope)
      )
    end

    if envelope["status"] == "processing" do
      case Map.fetch(turn_failed_events, envelope["id"]) do
        {:ok, prepared_event} ->
          SqlSupport.append_prepared_event!(
            service_run["id"],
            "TurnFailed",
            prepared_event,
            now
          )

        :error ->
          Repo.rollback(:stale_cancellation_plan)
      end
    end
  end

  defp prepared_ask_waiter_event_for_envelope!(nil, _envelope), do: nil

  defp prepared_ask_waiter_event_for_envelope!(ask_waiter_events, envelope) do
    case Map.fetch(ask_waiter_events, envelope["id"]) do
      {:ok, prepared} -> prepared
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp empty_cancellation_snapshot do
    %{
      "cancelledWaitCount" => 0,
      "cancelledChildRunCount" => 0,
      "cancelledServiceAskCount" => 0,
      "runningSteps" => [],
      "runningExecs" => [],
      "openChildren" => [],
      "waitingServiceAskOps" => []
    }
  end

  def fail_service_open_envelope!(service_run, envelope, error_body, reason, now, wake_waiter?) do
    fail_service_open_envelope!(service_run, envelope, error_body, reason, now, wake_waiter?, nil)
  end

  def fail_service_open_envelope!(
        service_run,
        envelope,
        error_body,
        reason,
        now,
        wake_waiter?,
        prepared_failure
      ) do
    validate_prepared_service_open_envelope_failure!(
      prepared_failure,
      service_run,
      envelope,
      wake_waiter?
    )

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
      wake_service_ask_waiter!(
        envelope["correlation_id"],
        "failed",
        error_body,
        now,
        prepared_open_envelope_ask_waiter_event(prepared_failure)
      )
    end

    if envelope["status"] == "processing" do
      append_open_envelope_turn_failed_event!(
        service_run["id"],
        envelope,
        error_body,
        now,
        prepared_failure
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
          now,
          prepared_open_envelope_events(prepared_failure, :step_cancelled_events)
        )

      _ =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_running_execs!(
          service_run["id"],
          error_body,
          now,
          prepared_open_envelope_events(prepared_failure, :exec_cancelled_events)
        )

      _ =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_outbound_service_asks!(
          service_run["id"],
          error_body,
          reason,
          now,
          prepared_open_envelope_events(
            prepared_failure,
            :outbound_service_ask_cancellations
          )
        )

      _ =
        VilanoKernel.Storage.FailureRecovery.Cancellation.cancel_child_runs_for_parent!(
          service_run["id"],
          error_body,
          reason,
          now,
          prepared_open_envelope_events(prepared_failure, :child_cancellations)
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

  defp validate_prepared_service_open_envelope_failure!(
         nil,
         _service_run,
         _envelope,
         _wake_waiter?
       ),
       do: :ok

  defp validate_prepared_service_open_envelope_failure!(
         %{
           service_run_id: service_run_id,
           envelope_id: envelope_id,
           envelope_status: envelope_status,
           wake_waiter?: wake_waiter?
         },
         %{"id" => service_run_id},
         %{"id" => envelope_id, "status" => envelope_status},
         wake_waiter?
       ),
       do: :ok

  defp validate_prepared_service_open_envelope_failure!(
         _prepared_failure,
         _service_run,
         _envelope,
         _wake_waiter?
       ),
       do: Repo.rollback(:stale_cancellation_plan)

  defp prepared_open_envelope_ask_waiter_event(nil), do: nil

  defp prepared_open_envelope_ask_waiter_event(prepared_failure) do
    case Map.fetch(prepared_failure, :ask_waiter_event) do
      {:ok, event} -> event
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp append_open_envelope_turn_failed_event!(run_id, envelope, error_body, now, nil) do
    append_event!(
      run_id,
      "TurnFailed",
      %{
        "envelopeId" => envelope["id"],
        "kind" => envelope["kind"],
        "name" => envelope["name"],
        "error" => error_body
      },
      now
    )
  end

  defp append_open_envelope_turn_failed_event!(
         run_id,
         _envelope,
         _error_body,
         now,
         prepared_failure
       ) do
    case Map.fetch(prepared_failure, :turn_failed_event) do
      {:ok, nil} -> Repo.rollback(:stale_cancellation_plan)
      {:ok, storage} -> SqlSupport.append_prepared_event!(run_id, "TurnFailed", storage, now)
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_open_envelope_events(nil, _key), do: nil

  defp prepared_open_envelope_events(prepared_failure, key) do
    case Map.fetch(prepared_failure, key) do
      {:ok, events} -> events
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end
end
