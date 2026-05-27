defmodule VilanoKernel.Storage.ServiceOps do
  @moduledoc false

  @fenced_run_exists_sql """
  exists (
    select 1
    from runs
    where
      id = ?
      and lease_id = ?
      and status in ('running', 'active')
      and lease_expires_at is not null
      and lease_expires_at >= ?
  )
  """

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{EventPayloads, Infrastructure, RunControl, ServiceSupport, Support}
  alias VilanoKernel.Storage.Support.Sql, as: SqlSupport

  import Support
  import ServiceSupport

  def resolve_service_send(lease_id, service_run_id, name, op_key, payload) do
    resolve_service_message_with_prepared_events_retry(
      lease_id,
      service_run_id,
      "send",
      name,
      op_key,
      payload,
      3
    )
  end

  def resolve_service_signal(lease_id, service_run_id, name, op_key, payload) do
    resolve_service_message_with_prepared_events_retry(
      lease_id,
      service_run_id,
      "signal",
      name,
      op_key,
      payload,
      3
    )
  end

  defp resolve_service_message_with_prepared_events_retry(
         lease_id,
         service_run_id,
         kind,
         name,
         op_key,
         payload,
         attempts_left
       ) do
    now = Infrastructure.now_iso8601()

    prepared_message =
      prepare_service_message_plan!(lease_id, service_run_id, kind, name, op_key, payload)

    try do
      case resolve_service_message_transaction(
             lease_id,
             service_run_id,
             kind,
             name,
             op_key,
             payload,
             now,
             prepared_message
           ) do
        {:ok, result} ->
          result

        {:error, :stale_cancellation_plan} when attempts_left > 1 ->
          resolve_service_message_with_prepared_events_retry(
            lease_id,
            service_run_id,
            kind,
            name,
            op_key,
            payload,
            attempts_left - 1
          )

        {:error, error} ->
          unwrap_transaction_result({:error, error})
      end
    after
      discard_prepared_service_message_events(prepared_message)
    end
  end

  defp resolve_service_message_transaction(
         lease_id,
         service_run_id,
         kind,
         name,
         op_key,
         payload,
         now,
         prepared_message
       ) do
    Infrastructure.transaction_with_busy_retry(fn ->
      case {RunControl.get_fenced_run_by_lease(lease_id, now),
            get_service_run_by_id(service_run_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {caller_run, service_run} ->
          case get_run_service_op(caller_run["id"], op_key) do
            existing when not is_nil(existing) ->
              if is_map(prepared_message), do: Repo.rollback(:stale_cancellation_plan)

              case existing["status"] do
                "failed" ->
                  %{
                    "status" => "failed",
                    "error" => decode_json_value(existing["error_json"], nil)
                  }

                _ ->
                  %{"status" => existing["status"]}
              end

            nil ->
              prepared_message =
                prepared_service_message_events!(
                  prepared_message,
                  caller_run,
                  service_run,
                  kind,
                  name,
                  op_key,
                  payload
                )

              RunControl.ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

              case maybe_insert_service_envelope(
                     service_run,
                     kind,
                     name,
                     payload,
                     nil,
                     caller_run["id"],
                     now,
                     prepared_message.inbound_enqueued_event
                   ) do
                {:ok, _envelope_id} ->
                  SQL.query!(
                    Repo,
                    """
                    insert into run_service_ops (
                      caller_run_id,
                      op_key,
                      service_run_id,
                      op_kind,
                      message_name,
                      correlation_id,
                      status,
                      payload_json,
                      response_json,
                      error_json,
                      created_at,
                      updated_at
                    ) values (?, ?, ?, ?, ?, null, 'completed', ?, null, null, ?, ?)
                    """,
                    [
                      caller_run["id"],
                      op_key,
                      service_run_id,
                      kind,
                      name,
                      prepared_message.payload_json,
                      now,
                      now
                    ]
                  )

                  SqlSupport.append_prepared_event!(
                    caller_run["id"],
                    service_message_event_type(kind),
                    prepared_message.caller_event,
                    now
                  )

                  RunControl.ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

                  %{"status" => "completed"}

                {:error, error} ->
                  persist_failed_service_op_json!(
                    caller_run["id"],
                    op_key,
                    service_run_id,
                    kind,
                    name,
                    nil,
                    prepared_message.payload_json,
                    maybe_encode_json(error),
                    now
                  )

                  %{"status" => "failed", "error" => error}
              end
          end
      end
    end)
  end

  defp prepare_service_message_plan!(lease_id, service_run_id, kind, name, op_key, payload) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case {RunControl.get_run_by_lease(lease_id), get_service_run_by_id(service_run_id)} do
          {%{} = caller_run, %{} = service_run} ->
            case get_run_service_op(caller_run["id"], op_key) do
              nil ->
                build_prepared_service_message_events!(
                  caller_run,
                  service_run,
                  kind,
                  name,
                  op_key,
                  payload
                )

              _existing ->
                nil
            end

          _ ->
            nil
        end
      end,
      :public_read
    )
  end

  defp build_prepared_service_message_events!(
         caller_run,
         service_run,
         kind,
         name,
         op_key,
         payload
       ) do
    service_run_id = service_run["id"]
    caller_body = service_message_body(kind, op_key, service_run_id, name, payload)
    caller_event = EventPayloads.prepare_body_for_storage!(caller_body)

    inbound_enqueued_event =
      try do
        prepare_service_envelope_enqueue_event(
          service_run,
          kind,
          name,
          payload,
          nil,
          caller_run["id"]
        )
      rescue
        error ->
          discard_prepared_service_turn_event(caller_event)
          reraise error, __STACKTRACE__
      end

    %{
      caller_run_id: caller_run["id"],
      caller_run_status: caller_run["status"],
      service_run_id: service_run_id,
      kind: kind,
      name: name,
      op_key: op_key,
      payload_json: Jason.encode!(payload),
      caller_body: caller_body,
      caller_event: caller_event,
      inbound_enqueued_event: inbound_enqueued_event
    }
  end

  defp discard_prepared_service_message_events(nil), do: :ok

  defp discard_prepared_service_message_events(%{} = prepared) do
    prepared
    |> Map.get(:caller_event)
    |> discard_prepared_service_turn_event()

    prepared
    |> Map.get(:inbound_enqueued_event)
    |> discard_prepared_service_envelope_enqueue_event()
  end

  defp prepared_service_message_events!(
         nil,
         _caller_run,
         _service_run,
         _kind,
         _name,
         _op_key,
         _payload
       ),
       do: Repo.rollback(:stale_cancellation_plan)

  defp prepared_service_message_events!(
         prepared,
         caller_run,
         service_run,
         kind,
         name,
         op_key,
         payload
       )
       when is_map(prepared) do
    service_run_id = service_run["id"]
    expected_caller_body = service_message_body(kind, op_key, service_run_id, name, payload)

    cond do
      prepared.caller_run_id != caller_run["id"] ->
        Repo.rollback(:stale_cancellation_plan)

      prepared.caller_run_status != caller_run["status"] ->
        Repo.rollback(:stale_cancellation_plan)

      prepared.service_run_id != service_run_id ->
        Repo.rollback(:stale_cancellation_plan)

      prepared.kind != kind or prepared.name != name or prepared.op_key != op_key ->
        Repo.rollback(:stale_cancellation_plan)

      prepared.caller_body != expected_caller_body ->
        Repo.rollback(:stale_cancellation_plan)

      true ->
        prepared
    end
  end

  defp service_message_event_type("send"), do: "MessageSent"
  defp service_message_event_type("signal"), do: "SignalSent"

  defp service_message_body("send", op_key, service_run_id, name, payload) do
    %{
      "key" => op_key,
      "serviceRunId" => service_run_id,
      "name" => name,
      "payload" => payload
    }
  end

  defp service_message_body("signal", op_key, service_run_id, name, payload) do
    %{
      "key" => op_key,
      "serviceRunId" => service_run_id,
      "signal" => name,
      "payload" => payload
    }
  end

  def resolve_service_ask(lease_id, service_run_id, name, op_key, payload, timeout_ms \\ nil) do
    resolve_service_ask_with_prepared_events_retry(
      lease_id,
      service_run_id,
      name,
      op_key,
      payload,
      timeout_ms,
      3
    )
  end

  defp resolve_service_ask_with_prepared_events_retry(
         lease_id,
         service_run_id,
         name,
         op_key,
         payload,
         timeout_ms,
         attempts_left
       ) do
    now = Infrastructure.now_iso8601()
    wake_at = wait_deadline(now, timeout_ms)

    prepared_ask =
      prepare_service_ask_plan!(lease_id, service_run_id, name, op_key, payload, wake_at)

    try do
      case resolve_service_ask_transaction(
             lease_id,
             service_run_id,
             name,
             op_key,
             payload,
             wake_at,
             now,
             prepared_ask
           ) do
        {:ok, result} ->
          result

        {:error, :stale_cancellation_plan} when attempts_left > 1 ->
          resolve_service_ask_with_prepared_events_retry(
            lease_id,
            service_run_id,
            name,
            op_key,
            payload,
            timeout_ms,
            attempts_left - 1
          )

        {:error, error} ->
          unwrap_transaction_result({:error, error})
      end
    after
      discard_prepared_service_ask_events(prepared_ask)
    end
  end

  defp resolve_service_ask_transaction(
         lease_id,
         service_run_id,
         name,
         op_key,
         payload,
         wake_at,
         now,
         prepared_ask
       ) do
    Infrastructure.transaction_with_busy_retry(fn ->
      case {RunControl.get_fenced_run_by_lease(lease_id, now),
            get_service_run_by_id(service_run_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {caller_run, service_run} ->
          correlation_id = "ask:" <> caller_run["id"] <> ":" <> op_key

          case get_run_service_op(caller_run["id"], op_key) do
            existing when not is_nil(existing) ->
              if is_map(prepared_ask), do: Repo.rollback(:stale_cancellation_plan)

              case existing["status"] do
                "completed" ->
                  %{
                    "status" => "completed",
                    "output" => decode_json_value(existing["response_json"], nil)
                  }

                "failed" ->
                  %{
                    "status" => "failed",
                    "error" => decode_json_value(existing["error_json"], nil)
                  }

                "waiting" ->
                  %{
                    "status" => "suspended",
                    "wait" => %{
                      "runId" => caller_run["id"],
                      "key" => "ask_reply:" <> correlation_id,
                      "kind" => "ask_reply",
                      "name" => correlation_id,
                      "status" => "waiting",
                      "wakeAt" => wake_at,
                      "output" => nil
                    }
                  }
              end

            nil ->
              prepared_ask =
                prepared_service_ask_events!(
                  prepared_ask,
                  caller_run,
                  service_run,
                  name,
                  op_key,
                  payload,
                  wake_at
                )

              RunControl.ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

              case maybe_insert_service_envelope(
                     service_run,
                     "ask",
                     name,
                     payload,
                     correlation_id,
                     caller_run["id"],
                     now,
                     prepared_ask.inbound_enqueued_event
                   ) do
                {:ok, _envelope_id} ->
                  SQL.query!(
                    Repo,
                    """
                    insert into run_service_ops (
                      caller_run_id,
                      op_key,
                      service_run_id,
                      op_kind,
                      message_name,
                      correlation_id,
                      status,
                      payload_json,
                      response_json,
                      error_json,
                      created_at,
                      updated_at
                    ) values (?, ?, ?, 'ask', ?, ?, 'waiting', ?, null, null, ?, ?)
                    """,
                    [
                      caller_run["id"],
                      op_key,
                      service_run_id,
                      name,
                      correlation_id,
                      prepared_ask.payload_json,
                      now,
                      now
                    ]
                  )

                  SQL.query!(
                    Repo,
                    """
                    insert into run_waits (
                      run_id,
                      op_key,
                      wait_kind,
                      wait_name,
                      status,
                      wake_at,
                      output_json,
                      created_at,
                      updated_at
                    ) values (?, ?, 'ask_reply', ?, 'waiting', ?, null, ?, ?)
                    on conflict(run_id, op_key) do update set
                      wait_kind = excluded.wait_kind,
                      wait_name = excluded.wait_name,
                      status = 'waiting',
                      wake_at = excluded.wake_at,
                      output_json = null,
                      updated_at = excluded.updated_at
                    """,
                    [
                      caller_run["id"],
                      "ask_reply:" <> correlation_id,
                      correlation_id,
                      wake_at,
                      now,
                      now
                    ]
                  )

                  append_service_ask_prepared_event!(
                    caller_run["id"],
                    "AskRequested",
                    ask_requested_body(op_key, service_run_id, name, correlation_id, payload),
                    now,
                    prepared_ask,
                    :ask_requested_event
                  )

                  append_service_ask_prepared_event!(
                    caller_run["id"],
                    "WaitRegistered",
                    ask_wait_registered_body(correlation_id, wake_at),
                    now,
                    prepared_ask,
                    :wait_registered_event
                  )

                  append_service_ask_prepared_event!(
                    caller_run["id"],
                    "RunSuspended",
                    ask_run_suspended_body(correlation_id),
                    now,
                    prepared_ask,
                    :run_suspended_event
                  )

                  maybe_append_service_turn_waiting!(
                    caller_run,
                    ask_service_turn_waiting_body(correlation_id, wake_at),
                    now,
                    prepared_ask.service_turn_waiting_event
                  )

                  RunControl.update_fenced_run!(
                    caller_run["id"],
                    lease_id,
                    now,
                    """
                    status = 'waiting',
                    lease_id = null,
                    lease_auth_token = null,
                    lease_worker_id = null,
                    lease_expires_at = null
                    """
                  )

                  %{
                    "status" => "suspended",
                    "wait" => %{
                      "runId" => caller_run["id"],
                      "key" => "ask_reply:" <> correlation_id,
                      "kind" => "ask_reply",
                      "name" => correlation_id,
                      "status" => "waiting",
                      "wakeAt" => wake_at,
                      "output" => nil
                    }
                  }

                {:error, error} ->
                  persist_failed_service_op_json!(
                    caller_run["id"],
                    op_key,
                    service_run_id,
                    "ask",
                    name,
                    correlation_id,
                    prepared_ask.payload_json,
                    maybe_encode_json(error),
                    now
                  )

                  %{"status" => "failed", "error" => error}
              end
          end
      end
    end)
  end

  defp prepare_service_ask_plan!(lease_id, service_run_id, name, op_key, payload, wake_at) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case {RunControl.get_run_by_lease(lease_id), get_service_run_by_id(service_run_id)} do
          {%{} = caller_run, %{} = service_run} ->
            correlation_id = "ask:" <> caller_run["id"] <> ":" <> op_key

            case get_run_service_op(caller_run["id"], op_key) do
              nil ->
                build_prepared_service_ask_events!(
                  caller_run,
                  service_run,
                  name,
                  op_key,
                  payload,
                  correlation_id,
                  wake_at
                )

              _existing ->
                nil
            end

          _ ->
            nil
        end
      end,
      :public_read
    )
  end

  defp build_prepared_service_ask_events!(
         caller_run,
         service_run,
         name,
         op_key,
         payload,
         correlation_id,
         wake_at
       ) do
    service_run_id = service_run["id"]
    wait_registered_body = ask_wait_registered_body(correlation_id, wake_at)
    run_suspended_body = ask_run_suspended_body(correlation_id)
    turn_waiting_body = ask_service_turn_waiting_body(correlation_id, wake_at)

    ask_requested_body = ask_requested_body(op_key, service_run_id, name, correlation_id, payload)
    ask_requested_event = EventPayloads.prepare_body_for_storage!(ask_requested_body)

    wait_registered_event =
      try do
        EventPayloads.prepare_body_for_storage!(wait_registered_body)
      rescue
        error ->
          discard_prepared_service_turn_event(ask_requested_event)
          reraise error, __STACKTRACE__
      end

    run_suspended_event =
      try do
        EventPayloads.prepare_body_for_storage!(run_suspended_body)
      rescue
        error ->
          discard_prepared_service_turn_event(wait_registered_event)
          discard_prepared_service_turn_event(ask_requested_event)
          reraise error, __STACKTRACE__
      end

    service_turn_waiting_event =
      try do
        prepare_service_turn_waiting_event(caller_run, turn_waiting_body)
      rescue
        error ->
          discard_prepared_service_turn_event(run_suspended_event)
          discard_prepared_service_turn_event(wait_registered_event)
          discard_prepared_service_turn_event(ask_requested_event)
          reraise error, __STACKTRACE__
      end

    inbound_enqueued_event =
      try do
        prepare_service_envelope_enqueue_event(
          service_run,
          "ask",
          name,
          payload,
          correlation_id,
          caller_run["id"]
        )
      rescue
        error ->
          discard_prepared_service_turn_waiting_event(service_turn_waiting_event)
          discard_prepared_service_turn_event(run_suspended_event)
          discard_prepared_service_turn_event(wait_registered_event)
          discard_prepared_service_turn_event(ask_requested_event)
          reraise error, __STACKTRACE__
      end

    %{
      caller_run_id: caller_run["id"],
      caller_run_status: caller_run["status"],
      service_run_id: service_run_id,
      name: name,
      op_key: op_key,
      correlation_id: correlation_id,
      wake_at: wake_at,
      payload_json: Jason.encode!(payload),
      ask_requested_body: ask_requested_body,
      wait_registered_body: wait_registered_body,
      run_suspended_body: run_suspended_body,
      turn_waiting_body: turn_waiting_body,
      ask_requested_event: ask_requested_event,
      wait_registered_event: wait_registered_event,
      run_suspended_event: run_suspended_event,
      service_turn_waiting_event: service_turn_waiting_event,
      inbound_enqueued_event: inbound_enqueued_event
    }
  end

  defp discard_prepared_service_ask_events(nil), do: :ok

  defp discard_prepared_service_ask_events(%{} = prepared) do
    prepared
    |> Map.take([:ask_requested_event, :wait_registered_event, :run_suspended_event])
    |> Map.values()
    |> Enum.each(&discard_prepared_service_turn_event/1)

    prepared
    |> Map.get(:service_turn_waiting_event)
    |> discard_prepared_service_turn_waiting_event()

    prepared
    |> Map.get(:inbound_enqueued_event)
    |> discard_prepared_service_envelope_enqueue_event()
  end

  defp prepared_service_ask_events!(
         nil,
         _caller_run,
         _service_run,
         _name,
         _op_key,
         _payload,
         _wake_at
       ),
       do: Repo.rollback(:stale_cancellation_plan)

  defp prepared_service_ask_events!(
         prepared,
         caller_run,
         service_run,
         name,
         op_key,
         payload,
         wake_at
       )
       when is_map(prepared) do
    correlation_id = "ask:" <> caller_run["id"] <> ":" <> op_key
    service_run_id = service_run["id"]

    expected_ask_requested_body =
      ask_requested_body(op_key, service_run_id, name, correlation_id, payload)

    cond do
      prepared.caller_run_id != caller_run["id"] ->
        Repo.rollback(:stale_cancellation_plan)

      prepared.caller_run_status != caller_run["status"] ->
        Repo.rollback(:stale_cancellation_plan)

      prepared.service_run_id != service_run_id ->
        Repo.rollback(:stale_cancellation_plan)

      prepared.name != name or prepared.op_key != op_key ->
        Repo.rollback(:stale_cancellation_plan)

      prepared.correlation_id != correlation_id or prepared.wake_at != wake_at ->
        Repo.rollback(:stale_cancellation_plan)

      prepared.ask_requested_body != expected_ask_requested_body ->
        Repo.rollback(:stale_cancellation_plan)

      prepared.wait_registered_body != ask_wait_registered_body(correlation_id, wake_at) ->
        Repo.rollback(:stale_cancellation_plan)

      prepared.run_suspended_body != ask_run_suspended_body(correlation_id) ->
        Repo.rollback(:stale_cancellation_plan)

      prepared.turn_waiting_body != ask_service_turn_waiting_body(correlation_id, wake_at) ->
        Repo.rollback(:stale_cancellation_plan)

      true ->
        prepared
    end
  end

  defp ask_requested_body(op_key, service_run_id, name, correlation_id, payload) do
    %{
      "key" => op_key,
      "serviceRunId" => service_run_id,
      "name" => name,
      "correlationId" => correlation_id,
      "payload" => payload
    }
  end

  defp ask_wait_registered_body(correlation_id, wake_at) do
    %{
      "kind" => "ask_reply",
      "key" => "ask_reply:" <> correlation_id,
      "correlationId" => correlation_id,
      "wakeAt" => wake_at
    }
  end

  defp ask_run_suspended_body(correlation_id) do
    %{
      "reason" => "ask_reply",
      "key" => "ask_reply:" <> correlation_id,
      "correlationId" => correlation_id
    }
  end

  defp ask_service_turn_waiting_body(correlation_id, wake_at) do
    %{
      "waitKind" => "ask_reply",
      "key" => "ask_reply:" <> correlation_id,
      "name" => correlation_id,
      "correlationId" => correlation_id,
      "wakeAt" => wake_at
    }
  end

  defp append_service_ask_prepared_event!(run_id, event_type, _body, now, prepared_events, key) do
    case Map.fetch(prepared_events, key) do
      {:ok, storage} when not is_nil(storage) ->
        SqlSupport.append_prepared_event!(run_id, event_type, storage, now)

      _ ->
        Repo.rollback(:stale_cancellation_plan)
    end
  end

  def complete_service_turn(lease_id, envelope_id, body) do
    if Map.get(body, "stop") == true do
      complete_service_turn_with_prepared_stop_retry(lease_id, envelope_id, body, 3)
    else
      complete_service_turn_with_prepared_completion_retry(lease_id, envelope_id, body, 3)
    end
  end

  defp complete_service_turn_with_prepared_completion_retry(
         lease_id,
         envelope_id,
         body,
         attempts_left
       ) do
    now = Infrastructure.now_iso8601()
    prepared_completion = prepare_service_turn_completion!(lease_id, envelope_id, body)

    try do
      case complete_service_turn_transaction(
             lease_id,
             envelope_id,
             body,
             now,
             prepared_completion
           ) do
        {:ok, result} ->
          result

        {:error, :stale_cancellation_plan} when attempts_left > 1 ->
          complete_service_turn_with_prepared_completion_retry(
            lease_id,
            envelope_id,
            body,
            attempts_left - 1
          )

        {:error, error} ->
          unwrap_transaction_result({:error, error})
      end
    after
      discard_prepared_service_turn_completion(prepared_completion)
    end
  end

  defp complete_service_turn_with_prepared_stop_retry(lease_id, envelope_id, body, attempts_left) do
    now = Infrastructure.now_iso8601()
    reason = "handler_stop"

    error_body =
      VilanoKernel.Storage.FailureRecovery.cancellation_error("Service stopped", reason)

    prepared_stop =
      prepare_service_turn_stop!(lease_id, envelope_id, body, error_body, reason, now)

    try do
      case complete_service_turn_transaction(lease_id, envelope_id, body, now, prepared_stop) do
        {:ok, result} ->
          result

        {:error, :stale_cancellation_plan} when attempts_left > 1 ->
          complete_service_turn_with_prepared_stop_retry(
            lease_id,
            envelope_id,
            body,
            attempts_left - 1
          )

        {:error, error} ->
          unwrap_transaction_result({:error, error})
      end
    after
      discard_prepared_service_turn_stop(prepared_stop)
    end
  end

  defp complete_service_turn_transaction(lease_id, envelope_id, body, now, prepared_stop) do
    Infrastructure.transaction_with_busy_retry(fn ->
      case {RunControl.get_fenced_run_by_lease(lease_id, now), get_service_envelope(envelope_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {service_run, envelope} ->
          if envelope["service_run_id"] == service_run["id"] do
            RunControl.ensure_fenced_run_ownership!(service_run["id"], lease_id, now)
            state = Map.get(body, "state")
            stopping? = Map.get(body, "stop") == true

            prepared_turn_events =
              prepared_service_turn_events!(prepared_stop, service_run, envelope)

            state_commit = maybe_commit_service_state!(service_run["id"], state, now, lease_id)

            RunControl.ensure_fenced_related_write!(
              service_run["id"],
              lease_id,
              now,
              """
              update service_envelopes
              set
                status = 'completed',
                reply_json = ?,
                error_json = null,
                wake_at = null,
                updated_at = ?
              where
                id = ?
                and #{@fenced_run_exists_sql}
              """,
              [maybe_encode_json(Map.get(body, "reply")), now, envelope_id]
            )

            if state_commit == :initialized do
              append_service_turn_prepared_event!(
                service_run["id"],
                "ServiceInitialized",
                %{"state" => state},
                now,
                prepared_turn_events,
                :service_initialized_event
              )
            end

            if state_commit in [:initialized, :updated] do
              append_service_turn_prepared_event!(
                service_run["id"],
                "ServiceStateCommitted",
                %{"state" => state},
                now,
                prepared_turn_events,
                :service_state_committed_event
              )
            end

            if envelope["kind"] == "ask" do
              append_service_turn_prepared_event!(
                service_run["id"],
                "AskReplyCommitted",
                %{
                  "envelopeId" => envelope_id,
                  "correlationId" => envelope["correlation_id"],
                  "reply" => Map.get(body, "reply")
                },
                now,
                prepared_turn_events,
                :ask_reply_committed_event
              )

              wake_service_ask_waiter!(
                envelope["correlation_id"],
                "completed",
                Map.get(body, "reply"),
                now,
                prepared_service_turn_ask_waiter_event(prepared_turn_events)
              )
            end

            append_service_turn_prepared_event!(
              service_run["id"],
              "TurnCompleted",
              %{
                "envelopeId" => envelope_id,
                "kind" => envelope["kind"],
                "name" => envelope["name"]
              },
              now,
              prepared_turn_events,
              :turn_completed_event
            )

            if stopping? do
              _ =
                VilanoKernel.Storage.FailureRecovery.stop_service_run_instance!(
                  get_service_run_by_id(service_run["id"]),
                  VilanoKernel.Storage.FailureRecovery.cancellation_error(
                    "Service stopped",
                    "handler_stop"
                  ),
                  "handler_stop",
                  now,
                  lease_id,
                  prepared_stop.service_stop
                )
            else
              next_status = service_next_status(service_run["id"], false)

              RunControl.update_fenced_run!(
                service_run["id"],
                lease_id,
                now,
                """
                status = ?,
                lease_id = null,
                lease_auth_token = null,
                lease_worker_id = null,
                lease_expires_at = null
                """,
                [next_status]
              )
            end

            VilanoKernel.Storage.get_run(service_run["id"])
          else
            nil
          end
      end
    end)
  end

  defp prepare_service_turn_completion!(lease_id, envelope_id, body) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case {RunControl.get_run_by_lease(lease_id), get_service_envelope(envelope_id)} do
          {%{"definitionKind" => "service"} = run, %{"service_run_id" => run_id} = envelope} ->
            if run_id == run["id"] do
              case get_service_run_by_id(run["id"]) do
                nil ->
                  nil

                service_run ->
                  %{
                    turn_events:
                      prepare_service_turn_completion_events!(service_run, envelope, body)
                  }
              end
            else
              nil
            end

          _ ->
            nil
        end
      end,
      :public_read
    )
  end

  defp prepare_service_turn_stop!(lease_id, envelope_id, body, error_body, reason, now) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case {RunControl.get_run_by_lease(lease_id), get_service_envelope(envelope_id)} do
          {%{"definitionKind" => "service"} = run, %{"service_run_id" => run_id} = envelope} ->
            if run_id == run["id"] do
              run["id"]
              |> get_service_run_by_id()
              |> case do
                nil ->
                  nil

                service_run ->
                  turn_events =
                    prepare_service_turn_completion_events!(service_run, envelope, body)

                  try do
                    service_stop =
                      VilanoKernel.Storage.FailureRecovery.ServiceFailure.prepare_service_stop!(
                        service_run,
                        error_body,
                        reason,
                        now,
                        MapSet.new(),
                        excluded_envelope_ids: MapSet.new([envelope_id])
                      )

                    %{service_stop: service_stop, turn_events: turn_events}
                  rescue
                    error ->
                      discard_prepared_service_turn_completion_events(turn_events)
                      reraise error, __STACKTRACE__
                  end
              end
            else
              nil
            end

          _ ->
            nil
        end
      end,
      :public_read
    )
  end

  defp prepare_service_turn_completion_events!(service_run, envelope, body) do
    state = Map.get(body, "state")
    reply = Map.get(body, "reply")

    service_initialized_event = prepare_optional_event(state, %{"state" => state})

    service_state_committed_event =
      try do
        prepare_optional_event(state, %{"state" => state})
      rescue
        error ->
          discard_prepared_service_turn_event(service_initialized_event)
          reraise error, __STACKTRACE__
      end

    ask_reply_committed_event =
      try do
        if envelope["kind"] == "ask" do
          EventPayloads.prepare_body_for_storage!(%{
            "envelopeId" => envelope["id"],
            "correlationId" => envelope["correlation_id"],
            "reply" => reply
          })
        end
      rescue
        error ->
          discard_prepared_service_turn_event(service_state_committed_event)
          discard_prepared_service_turn_event(service_initialized_event)
          reraise error, __STACKTRACE__
      end

    ask_waiter_event =
      try do
        if envelope["kind"] == "ask" and is_binary(envelope["correlation_id"]) do
          prepare_service_ask_waiter_event(envelope["correlation_id"], "completed", reply)
        end
      rescue
        error ->
          discard_prepared_service_turn_event(ask_reply_committed_event)
          discard_prepared_service_turn_event(service_state_committed_event)
          discard_prepared_service_turn_event(service_initialized_event)
          reraise error, __STACKTRACE__
      end

    turn_completed_event =
      try do
        EventPayloads.prepare_body_for_storage!(%{
          "envelopeId" => envelope["id"],
          "kind" => envelope["kind"],
          "name" => envelope["name"]
        })
      rescue
        error ->
          discard_prepared_service_ask_waiter_event(ask_waiter_event)
          discard_prepared_service_turn_event(ask_reply_committed_event)
          discard_prepared_service_turn_event(service_state_committed_event)
          discard_prepared_service_turn_event(service_initialized_event)
          reraise error, __STACKTRACE__
      end

    %{
      service_run_id: service_run["id"],
      envelope_id: envelope["id"],
      envelope_kind: envelope["kind"],
      correlation_id: envelope["correlation_id"],
      service_initialized_event: service_initialized_event,
      service_state_committed_event: service_state_committed_event,
      ask_reply_committed_event: ask_reply_committed_event,
      ask_waiter_event: ask_waiter_event,
      turn_completed_event: turn_completed_event
    }
  end

  defp prepare_optional_event(nil, _body), do: nil
  defp prepare_optional_event(_value, body), do: EventPayloads.prepare_body_for_storage!(body)

  defp discard_prepared_service_turn_stop(nil), do: :ok

  defp discard_prepared_service_turn_stop(%{} = prepared) do
    prepared
    |> Map.get(:turn_events)
    |> discard_prepared_service_turn_completion_events()

    prepared
    |> Map.get(:service_stop)
    |> VilanoKernel.Storage.FailureRecovery.ServiceFailure.discard_prepared_service_stop()
  end

  defp discard_prepared_service_turn_completion(nil), do: :ok

  defp discard_prepared_service_turn_completion(%{} = prepared) do
    prepared
    |> Map.get(:turn_events)
    |> discard_prepared_service_turn_completion_events()
  end

  defp discard_prepared_service_turn_completion_events(nil), do: :ok

  defp discard_prepared_service_turn_completion_events(%{} = prepared) do
    prepared
    |> Map.take([
      :service_initialized_event,
      :service_state_committed_event,
      :ask_reply_committed_event,
      :turn_completed_event
    ])
    |> Map.values()
    |> Enum.each(&discard_prepared_service_turn_event/1)

    prepared
    |> Map.get(:ask_waiter_event)
    |> discard_prepared_service_ask_waiter_event()
  end

  defp discard_prepared_service_turn_event(nil), do: :ok

  defp discard_prepared_service_turn_event(storage) do
    EventPayloads.discard_prepared_payload!(storage)
  end

  defp prepared_service_turn_events!(nil, _service_run, _envelope) do
    Repo.rollback(:stale_cancellation_plan)
  end

  defp prepared_service_turn_events!(
         %{turn_events: prepared},
         %{"id" => service_run_id},
         %{
           "id" => envelope_id,
           "kind" => envelope_kind,
           "correlation_id" => correlation_id
         }
       ) do
    if prepared.service_run_id == service_run_id and prepared.envelope_id == envelope_id and
         prepared.envelope_kind == envelope_kind and prepared.correlation_id == correlation_id do
      prepared
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_service_turn_events!(_prepared, _service_run, _envelope) do
    Repo.rollback(:stale_cancellation_plan)
  end

  defp append_service_turn_prepared_event!(
         run_id,
         event_type,
         body,
         now,
         nil,
         _event_key
       ) do
    append_event!(run_id, event_type, body, now)
  end

  defp append_service_turn_prepared_event!(
         run_id,
         event_type,
         _body,
         now,
         prepared_events,
         event_key
       ) do
    case Map.fetch(prepared_events, event_key) do
      {:ok, nil} -> Repo.rollback(:stale_cancellation_plan)
      {:ok, storage} -> SqlSupport.append_prepared_event!(run_id, event_type, storage, now)
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_service_turn_ask_waiter_event(nil), do: nil

  defp prepared_service_turn_ask_waiter_event(prepared_events) do
    case Map.fetch(prepared_events, :ask_waiter_event) do
      {:ok, event} -> event
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  def get_service_turn_mailbox(lease_id, envelope_id) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case {RunControl.get_fenced_run_by_lease(lease_id, now), get_service_envelope(envelope_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {service_run, envelope} ->
          if envelope["service_run_id"] == service_run["id"] and
               envelope["status"] == "processing" do
            %{
              "current" => mailbox_envelope_from_row(envelope),
              "queued" => queued_mailbox_summary(service_run["id"], now)
            }
          else
            nil
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def defer_service_turn(lease_id, envelope_id, delay_ms, reason \\ nil) do
    now = Infrastructure.now_iso8601()
    wake_at = shift_milliseconds(now, delay_ms)

    Infrastructure.transaction_with_busy_retry(fn ->
      case {RunControl.get_fenced_run_by_lease(lease_id, now), get_service_envelope(envelope_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {service_run, envelope} ->
          if envelope["service_run_id"] == service_run["id"] and
               envelope["status"] == "processing" do
            RunControl.ensure_fenced_run_ownership!(service_run["id"], lease_id, now)
            next_attempt = (envelope["attempt"] || 1) + 1

            RunControl.ensure_fenced_related_write!(
              service_run["id"],
              lease_id,
              now,
              """
              update service_envelopes
              set
                status = 'queued',
                attempt = ?,
                reply_json = null,
                error_json = null,
                wake_at = ?,
                updated_at = ?
              where
                id = ?
                and #{@fenced_run_exists_sql}
              """,
              [next_attempt, wake_at, now, envelope_id]
            )

            next_status = service_next_status(service_run["id"], false)

            RunControl.update_fenced_run!(
              service_run["id"],
              lease_id,
              now,
              """
              status = ?,
              lease_id = null,
              lease_auth_token = null,
              lease_worker_id = null,
              lease_expires_at = null
              """,
              [next_status]
            )

            append_event!(
              service_run["id"],
              "TurnDeferred",
              %{
                "envelopeId" => envelope_id,
                "kind" => envelope["kind"],
                "name" => envelope["name"],
                "reason" => reason,
                "delayMs" => delay_ms,
                "wakeAt" => wake_at,
                "nextAttempt" => next_attempt
              },
              now
            )

            %{
              "run" => VilanoKernel.Storage.get_run(service_run["id"])
            }
          else
            nil
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def reject_service_turn(lease_id, envelope_id, error_body) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case {RunControl.get_fenced_run_by_lease(lease_id, now), get_service_envelope(envelope_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {service_run, envelope} ->
          if envelope["service_run_id"] == service_run["id"] and
               envelope["status"] == "processing" do
            RunControl.ensure_fenced_run_ownership!(service_run["id"], lease_id, now)

            RunControl.ensure_fenced_related_write!(
              service_run["id"],
              lease_id,
              now,
              """
              update service_envelopes
              set
                status = 'failed',
                error_json = ?,
                reply_json = null,
                wake_at = null,
                updated_at = ?
              where
                id = ?
                and #{@fenced_run_exists_sql}
              """,
              [Jason.encode!(error_body), now, envelope_id]
            )

            if envelope["kind"] == "ask" do
              wake_service_ask_waiter!(envelope["correlation_id"], "failed", error_body, now)
            end

            append_event!(
              service_run["id"],
              "TurnRejected",
              %{
                "envelopeId" => envelope_id,
                "kind" => envelope["kind"],
                "name" => envelope["name"],
                "error" => error_body
              },
              now
            )

            next_status = service_next_status(service_run["id"], false)

            RunControl.update_fenced_run!(
              service_run["id"],
              lease_id,
              now,
              """
              status = ?,
              lease_id = null,
              lease_auth_token = null,
              lease_worker_id = null,
              lease_expires_at = null
              """,
              [next_status]
            )

            VilanoKernel.Storage.get_run(service_run["id"])
          else
            nil
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def fail_service_turn(lease_id, envelope_id, error_body, retry_options \\ %{}) do
    fail_service_turn_with_prepared_failure_retry(
      lease_id,
      envelope_id,
      error_body,
      retry_options,
      3
    )
  end

  defp fail_service_turn_with_prepared_failure_retry(
         lease_id,
         envelope_id,
         error_body,
         retry_options,
         attempts_left
       ) do
    now = Infrastructure.now_iso8601()

    prepared_failure =
      prepare_service_turn_failure_plan!(lease_id, envelope_id, error_body, retry_options, now)

    try do
      case fail_service_turn_transaction(
             lease_id,
             envelope_id,
             error_body,
             retry_options,
             now,
             prepared_failure
           ) do
        {:ok, result} ->
          result

        {:error, :stale_cancellation_plan} when attempts_left > 1 ->
          fail_service_turn_with_prepared_failure_retry(
            lease_id,
            envelope_id,
            error_body,
            retry_options,
            attempts_left - 1
          )

        {:error, error} ->
          unwrap_transaction_result({:error, error})
      end
    after
      VilanoKernel.Storage.FailureRecovery.RetryRecovery.discard_prepared_service_turn_attempt_failure(
        prepared_failure
      )
    end
  end

  defp fail_service_turn_transaction(
         lease_id,
         envelope_id,
         error_body,
         retry_options,
         now,
         prepared_failure
       ) do
    Infrastructure.transaction_with_busy_retry(fn ->
      case {RunControl.get_fenced_run_by_lease(lease_id, now), get_service_envelope(envelope_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          if is_map(prepared_failure), do: Repo.rollback(:stale_cancellation_plan)
          nil

        {service_run, envelope} ->
          if envelope["service_run_id"] == service_run["id"] do
            if is_nil(prepared_failure), do: Repo.rollback(:stale_cancellation_plan)

            VilanoKernel.Storage.FailureRecovery.fail_service_turn_attempt!(
              service_run,
              envelope,
              error_body,
              retry_options,
              now,
              lease_id,
              prepared_failure
            )
          else
            if is_map(prepared_failure), do: Repo.rollback(:stale_cancellation_plan)
            nil
          end
      end
    end)
  end

  defp prepare_service_turn_failure_plan!(lease_id, envelope_id, error_body, retry_options, now) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case {RunControl.get_run_by_lease(lease_id), get_service_envelope(envelope_id)} do
          {%{"id" => run_id} = service_run, %{"service_run_id" => run_id} = envelope} ->
            VilanoKernel.Storage.FailureRecovery.RetryRecovery.prepare_service_turn_attempt_failure!(
              service_run,
              envelope,
              error_body,
              retry_options,
              now
            )

          _ ->
            nil
        end
      end,
      :public_read
    )
  end

  def maybe_commit_service_state!(_run_id, nil, _now, _lease_id), do: :unchanged

  def maybe_commit_service_state!(run_id, state, now, lease_id) do
    current = get_service_run_by_id(run_id)
    encoded_state = Jason.encode!(state)
    initial? = is_nil(current["state"])

    RunControl.ensure_fenced_related_write!(
      run_id,
      lease_id,
      now,
      """
      update service_runs
      set
        state_json = ?,
        updated_at = ?
      where
        run_id = ?
        and #{@fenced_run_exists_sql}
      """,
      [encoded_state, now, run_id]
    )

    if initial?, do: :initialized, else: :updated
  end
end
