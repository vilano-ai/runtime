defmodule VilanoKernel.Storage.ServiceSupport do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage.{EventPayloads, Infrastructure, ReadModels, ServiceLifecycle}
  alias VilanoKernel.Storage.Support.Sql, as: SqlSupport

  import VilanoKernel.Storage.Support

  def list_open_service_envelopes(service_run_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        service_run_id,
        kind,
        name,
        attempt,
        payload_json,
        correlation_id,
        sender_run_id,
        status,
        reply_json,
        error_json,
        wake_at,
        created_at,
        updated_at
      from service_envelopes
      where service_run_id = ? and status in ('queued', 'processing')
      order by created_at asc
      """,
      [service_run_id]
    )
    |> rows_to_maps()
  end

  def list_waiting_wait_rows(run_id) do
    Repo
    |> SQL.query!(
      """
      select
        run_id,
        op_key,
        wait_kind,
        wait_name,
        status,
        wake_at,
        output_json,
        created_at,
        updated_at
      from run_waits
      where run_id = ? and status = 'waiting'
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
  end

  def list_running_step_rows(run_id) do
    Repo
    |> SQL.query!(
      """
      select
        run_id,
        op_key,
        name,
        status,
        output_json,
        created_at,
        updated_at
      from run_steps
      where run_id = ? and status = 'running'
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
  end

  def list_running_exec_rows(run_id) do
    Repo
    |> SQL.query!(
      """
      select
        run_id,
        op_key,
        name,
        status,
        cmd,
        args_json,
        cwd,
        env_json,
        timeout_ms,
        attempt,
        exit_code,
        signal_code,
        stdout_ref,
        stderr_ref,
        artifacts_json,
        output_json,
        error_json,
        created_at,
        updated_at
      from run_execs
      where run_id = ? and status = 'running'
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
  end

  def list_waiting_service_ask_ops(caller_run_id) do
    Repo
    |> SQL.query!(
      """
      select
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
      from run_service_ops
      where caller_run_id = ? and op_kind = 'ask' and status = 'waiting'
      order by created_at asc
      """,
      [caller_run_id]
    )
    |> rows_to_maps()
  end

  def list_open_child_rows(parent_run_id) do
    Repo
    |> SQL.query!(
      """
      select
        parent_run_id,
        op_key,
        child_run_id,
        definition_name,
        status,
        created_at,
        updated_at
      from run_children
      where parent_run_id = ? and status not in ('completed', 'failed', 'cancelled')
      order by created_at asc
      """,
      [parent_run_id]
    )
    |> rows_to_maps()
  end

  def get_open_service_envelope_by_correlation(service_run_id, correlation_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        service_run_id,
        kind,
        name,
        attempt,
        payload_json,
        correlation_id,
        sender_run_id,
        status,
        reply_json,
        error_json,
        wake_at,
        created_at,
        updated_at
      from service_envelopes
      where
        service_run_id = ?
        and correlation_id = ?
        and status in ('queued', 'processing')
      order by
        case when status = 'processing' then 0 else 1 end asc,
        created_at asc
      limit 1
      """,
      [service_run_id, correlation_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def service_has_ready_queued_envelopes?(service_run_id) do
    now = Infrastructure.now_iso8601()

    Repo
    |> SQL.query!(
      """
      select count(*)
      from service_envelopes
      where
        service_run_id = ?
        and status = 'queued'
        and (wake_at is null or wake_at <= ?)
      """,
      [service_run_id, now]
    )
    |> first_integer()
    |> Kernel.>(0)
  end

  def queued_mailbox_summary(service_run_id, now) do
    Repo
    |> SQL.query!(
      """
      select
        count(*) as total,
        sum(case when wake_at is null or wake_at <= ? then 1 else 0 end) as ready,
        sum(case when wake_at is not null and wake_at > ? then 1 else 0 end) as deferred,
        sum(case when kind = 'ask' then 1 else 0 end) as asks,
        sum(case when kind = 'send' then 1 else 0 end) as sends,
        sum(case when kind = 'signal' then 1 else 0 end) as signals,
        min(created_at) as oldest_at,
        min(case when wake_at is not null and wake_at > ? then wake_at end) as next_wake_at
      from service_envelopes
      where service_run_id = ? and status = 'queued'
      """,
      [now, now, now, service_run_id]
    )
    |> rows_to_maps()
    |> List.first()
    |> then(fn row ->
      %{
        "total" => row["total"] || 0,
        "ready" => row["ready"] || 0,
        "deferred" => row["deferred"] || 0,
        "asks" => row["asks"] || 0,
        "sends" => row["sends"] || 0,
        "signals" => row["signals"] || 0,
        "oldestAt" => row["oldest_at"],
        "nextWakeAt" => row["next_wake_at"]
      }
    end)
  end

  def passivation_wake_kind("sleep"), do: "timer"
  def passivation_wake_kind("retry_backoff"), do: "timer"
  def passivation_wake_kind(kind) when is_binary(kind), do: kind
  def passivation_wake_kind(_kind), do: "durable_wait"

  def earliest_wake_at(values) do
    values
    |> Enum.filter(&is_binary/1)
    |> Enum.sort()
    |> List.first()
  end

  def service_mailbox_config(service_run) do
    definition =
      project_definitions_for_run(service_run)
      |> Map.get("services", [])
      |> Enum.find(&(&1["name"] == service_run["definitionName"]))

    mailbox = Map.get(definition || %{}, "mailbox") || %{}
    max_queued = Map.get(mailbox, "maxQueued")

    %{
      "maxQueued" => if(is_integer(max_queued) and max_queued > 0, do: max_queued, else: nil),
      "overload" =>
        case Map.get(mailbox, "overload") do
          "reject_new" -> "reject_new"
          _ when is_integer(max_queued) and max_queued > 0 -> "reject_new"
          _ -> nil
        end
    }
  end

  def maybe_insert_service_envelope(
        service_run,
        kind,
        name,
        payload,
        correlation_id,
        sender_run_id,
        now,
        prepared_event \\ nil
      ) do
    if service_run["status"] == "stopped" do
      {:error,
       %{
         "message" => "Service is stopped",
         "reason" => "service_stopped",
         "serviceRunId" => service_run["id"],
         "serviceKey" => service_run["serviceKey"],
         "kind" => kind,
         "name" => name
       }}
    else
      case maybe_reject_service_envelope(service_run, kind, name, now) do
        nil ->
          {:ok,
           insert_service_envelope!(
             service_run["id"],
             kind,
             name,
             payload,
             correlation_id,
             sender_run_id,
             now,
             prepared_event
           )}

        {:error, error} ->
          {:error, error}
      end
    end
  end

  def maybe_reject_service_envelope(service_run, kind, name, now) do
    mailbox = service_mailbox_config(service_run)
    max_queued = mailbox["maxQueued"]
    queued = queued_mailbox_summary(service_run["id"], now)["total"] || 0

    if is_integer(max_queued) and max_queued > 0 and queued >= max_queued do
      error = %{
        "message" => "Service mailbox overloaded",
        "reason" => "service_overloaded",
        "serviceRunId" => service_run["id"],
        "serviceKey" => service_run["serviceKey"],
        "kind" => kind,
        "name" => name,
        "queued" => queued,
        "maxQueued" => max_queued,
        "overload" => mailbox["overload"] || "reject_new"
      }

      append_event!(
        service_run["id"],
        "InboundRejected",
        %{
          "reason" => "service_overloaded",
          "kind" => kind,
          "name" => name,
          "queued" => queued,
          "maxQueued" => max_queued,
          "overload" => mailbox["overload"] || "reject_new"
        },
        now
      )

      {:error, error}
    else
      nil
    end
  end

  def insert_service_envelope!(
        service_run_id,
        kind,
        name,
        payload,
        correlation_id,
        sender_run_id,
        now,
        prepared_event \\ nil
      ) do
    envelope_id = prepared_service_envelope_id(prepared_event)
    payload_json = prepared_service_envelope_payload_json(prepared_event, payload)
    current_run = ReadModels.get_run(service_run_id)

    next_status =
      ServiceLifecycle.enqueue_status(current_run["status"], current_run["leaseExpiresAt"], now)

    SQL.query!(
      Repo,
      """
      insert into service_envelopes (
        id,
        service_run_id,
        kind,
        name,
        attempt,
        payload_json,
        correlation_id,
        sender_run_id,
        status,
        reply_json,
        error_json,
        wake_at,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, 1, ?, ?, ?, 'queued', null, null, null, ?, ?)
      """,
      [
        envelope_id,
        service_run_id,
        kind,
        name,
        payload_json,
        correlation_id,
        sender_run_id,
        now,
        now
      ]
    )

    SQL.query!(
      Repo,
      """
      update runs
      set
        status = ?,
        updated_at = ?
      where id = ?
      """,
      [next_status, now, service_run_id]
    )

    append_inbound_enqueued_event!(
      service_run_id,
      kind,
      name,
      payload,
      correlation_id,
      sender_run_id,
      envelope_id,
      now,
      prepared_event
    )

    envelope_id
  end

  def prepare_service_envelope_enqueue_event(
        service_run,
        kind,
        name,
        payload,
        correlation_id,
        sender_run_id
      ) do
    service_run_id = service_run["id"] || service_run["run_id"]
    envelope_id = "env_" <> Ecto.UUID.generate()
    body = inbound_enqueued_body(envelope_id, kind, name, payload, correlation_id, sender_run_id)

    %{
      service_run_id: service_run_id,
      envelope_id: envelope_id,
      kind: kind,
      name: name,
      correlation_id: correlation_id,
      sender_run_id: sender_run_id,
      payload_json: maybe_encode_json(payload),
      body: body,
      storage: EventPayloads.prepare_body_for_storage!(body)
    }
  end

  def discard_prepared_service_envelope_enqueue_event(nil), do: :ok

  def discard_prepared_service_envelope_enqueue_event(%{storage: storage}) do
    EventPayloads.discard_prepared_payload!(storage)
  end

  defp prepared_service_envelope_id(%{envelope_id: envelope_id}) when is_binary(envelope_id),
    do: envelope_id

  defp prepared_service_envelope_id(_prepared_event), do: "env_" <> Ecto.UUID.generate()

  defp prepared_service_envelope_payload_json(%{payload_json: payload_json}, _payload)
       when is_binary(payload_json) or is_nil(payload_json),
       do: payload_json

  defp prepared_service_envelope_payload_json(_prepared_event, payload),
    do: maybe_encode_json(payload)

  defp inbound_enqueued_body(envelope_id, kind, name, payload, correlation_id, sender_run_id) do
    %{
      "envelopeId" => envelope_id,
      "kind" => kind,
      "name" => name,
      "payload" => payload,
      "correlationId" => correlation_id,
      "senderRunId" => sender_run_id
    }
  end

  defp append_inbound_enqueued_event!(
         service_run_id,
         kind,
         name,
         payload,
         correlation_id,
         sender_run_id,
         envelope_id,
         now,
         nil
       ) do
    append_event!(
      service_run_id,
      "InboundEnqueued",
      inbound_enqueued_body(envelope_id, kind, name, payload, correlation_id, sender_run_id),
      now
    )
  end

  defp append_inbound_enqueued_event!(
         service_run_id,
         kind,
         name,
         payload,
         correlation_id,
         sender_run_id,
         envelope_id,
         now,
         %{body: body, storage: storage} = prepared_event
       ) do
    expected_body =
      inbound_enqueued_body(envelope_id, kind, name, payload, correlation_id, sender_run_id)

    if prepared_event.service_run_id == service_run_id and
         prepared_event.envelope_id == envelope_id and
         prepared_event.kind == kind and
         prepared_event.name == name and
         prepared_event.correlation_id == correlation_id and
         prepared_event.sender_run_id == sender_run_id and
         body == expected_body do
      SqlSupport.append_prepared_event!(service_run_id, "InboundEnqueued", storage, now)
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp append_inbound_enqueued_event!(
         _service_run_id,
         _kind,
         _name,
         _payload,
         _correlation_id,
         _sender_run_id,
         _envelope_id,
         _now,
         _prepared_event
       ),
       do: Repo.rollback(:stale_cancellation_plan)

  def prepare_service_turn_waiting_event(run, wait_body) do
    if run["definitionKind"] == "service" do
      case get_processing_service_envelope_for_run(run["id"]) do
        nil ->
          %{run_id: run["id"], envelope_id: nil, storage: nil}

        envelope ->
          %{
            run_id: run["id"],
            envelope_id: envelope["id"],
            storage:
              EventPayloads.prepare_body_for_storage!(
                service_turn_waiting_body(wait_body, envelope)
              )
          }
      end
    end
  end

  def discard_prepared_service_turn_waiting_event(nil), do: :ok
  def discard_prepared_service_turn_waiting_event(%{storage: nil}), do: :ok

  def discard_prepared_service_turn_waiting_event(%{storage: storage}) do
    EventPayloads.discard_prepared_payload!(storage)
  end

  def maybe_append_service_turn_waiting!(run, wait_body, now, prepared_event \\ nil) do
    if run["definitionKind"] == "service" do
      case get_processing_service_envelope_for_run(run["id"]) do
        nil ->
          validate_no_prepared_service_turn_waiting_event!(prepared_event, run)
          :ok

        envelope ->
          append_service_turn_waiting_event!(
            run["id"],
            service_turn_waiting_body(wait_body, envelope),
            now,
            prepared_event,
            envelope
          )
      end
    else
      if is_map(prepared_event), do: Repo.rollback(:stale_cancellation_plan)
      :ok
    end
  end

  defp validate_no_prepared_service_turn_waiting_event!(nil, _run), do: :ok

  defp validate_no_prepared_service_turn_waiting_event!(
         %{run_id: run_id, envelope_id: nil, storage: nil},
         %{"id" => run_id}
       ),
       do: :ok

  defp validate_no_prepared_service_turn_waiting_event!(_prepared_event, _run),
    do: Repo.rollback(:stale_cancellation_plan)

  defp service_turn_waiting_body(wait_body, envelope) do
    Map.merge(wait_body, %{
      "envelopeId" => envelope["id"],
      "kind" => envelope["kind"],
      "turnName" => envelope["name"],
      "correlationId" => envelope["correlation_id"]
    })
  end

  defp append_service_turn_waiting_event!(run_id, body, now, nil, _envelope) do
    append_event!(run_id, "TurnWaiting", body, now)
  end

  defp append_service_turn_waiting_event!(
         run_id,
         _body,
         now,
         %{run_id: run_id, envelope_id: envelope_id, storage: storage},
         %{"id" => envelope_id}
       ) do
    SqlSupport.append_prepared_event!(run_id, "TurnWaiting", storage, now)
  end

  defp append_service_turn_waiting_event!(_run_id, _body, _now, _prepared_event, _envelope),
    do: Repo.rollback(:stale_cancellation_plan)

  def prepare_service_ask_waiter_event(correlation_id, status, payload) do
    Infrastructure.run_with_busy_retry(
      fn ->
        correlation_id
        |> service_ask_waiter_op()
        |> prepare_service_ask_waiter_event(correlation_id, status, payload)
      end,
      :public_read
    )
  end

  def discard_prepared_service_ask_waiter_event(nil), do: :ok

  def discard_prepared_service_ask_waiter_event(%{storage: nil}), do: :ok

  def discard_prepared_service_ask_waiter_event(%{storage: storage}) do
    EventPayloads.discard_prepared_payload!(storage)
  end

  def discard_prepared_service_ask_waiter_events(prepared_events) when is_map(prepared_events) do
    prepared_events
    |> Map.values()
    |> Enum.each(&discard_prepared_service_ask_waiter_event/1)
  end

  def discard_prepared_service_ask_waiter_events(_prepared_events), do: :ok

  def wake_service_ask_waiter!(correlation_id, status, payload, now, prepared_event \\ nil) do
    op = service_ask_waiter_op(correlation_id)

    validate_prepared_service_ask_waiter_event!(
      prepared_event,
      op,
      correlation_id,
      status
    )

    if op && op["status"] == "waiting" do
      do_wake_service_ask_waiter!(op, correlation_id, status, payload, now, prepared_event)
    end
  end

  defp service_ask_waiter_op(correlation_id) do
    op =
      Repo
      |> SQL.query!(
        """
        select
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
        from run_service_ops
        where correlation_id = ?
        limit 1
        """,
        [correlation_id]
      )
      |> rows_to_maps()
      |> List.first()

    op
  end

  defp prepare_service_ask_waiter_event(
         %{"status" => "waiting"} = op,
         correlation_id,
         status,
         payload
       ) do
    wait_key = "ask_reply:" <> correlation_id

    %{
      kind: :service_ask_waiter,
      expected_caller_run_id: op["caller_run_id"],
      expected_op_key: op["op_key"],
      expected_correlation_id: correlation_id,
      expected_status: status,
      storage:
        EventPayloads.prepare_body_for_storage!(%{
          "kind" => "ask_reply",
          "key" => wait_key,
          "correlationId" => correlation_id,
          "payload" => payload
        })
    }
  end

  defp prepare_service_ask_waiter_event(_op, correlation_id, status, _payload) do
    %{
      kind: :service_ask_waiter,
      expected_correlation_id: correlation_id,
      expected_status: status,
      storage: nil
    }
  end

  defp validate_prepared_service_ask_waiter_event!(nil, _op, _correlation_id, _status), do: :ok

  defp validate_prepared_service_ask_waiter_event!(
         %{
           kind: :service_ask_waiter,
           expected_correlation_id: correlation_id,
           expected_status: status,
           storage: nil
         },
         op,
         correlation_id,
         status
       ) do
    if is_nil(op) or op["status"] != "waiting" do
      :ok
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp validate_prepared_service_ask_waiter_event!(
         %{
           kind: :service_ask_waiter,
           expected_caller_run_id: caller_run_id,
           expected_op_key: op_key,
           expected_correlation_id: correlation_id,
           expected_status: status,
           storage: storage
         },
         %{"status" => "waiting"} = op,
         correlation_id,
         status
       )
       when not is_nil(storage) do
    if op["caller_run_id"] == caller_run_id and op["op_key"] == op_key do
      :ok
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp validate_prepared_service_ask_waiter_event!(
         _prepared_event,
         _op,
         _correlation_id,
         _status
       ),
       do: Repo.rollback(:stale_cancellation_plan)

  defp do_wake_service_ask_waiter!(op, correlation_id, status, payload, now, prepared_event) do
    case status do
      "completed" ->
        SQL.query!(
          Repo,
          """
          update run_service_ops
          set
            status = 'completed',
            response_json = ?,
            error_json = null,
            updated_at = ?
          where caller_run_id = ? and op_key = ?
          """,
          [maybe_encode_json(payload), now, op["caller_run_id"], op["op_key"]]
        )

      "failed" ->
        SQL.query!(
          Repo,
          """
          update run_service_ops
          set
            status = 'failed',
            response_json = null,
            error_json = ?,
            updated_at = ?
          where caller_run_id = ? and op_key = ?
          """,
          [maybe_encode_json(payload), now, op["caller_run_id"], op["op_key"]]
        )
    end

    wait_key = "ask_reply:" <> correlation_id
    wait_status = if status == "completed", do: "completed", else: "failed"

    SQL.query!(
      Repo,
      """
      update run_waits
      set
        status = ?,
        output_json = ?,
        updated_at = ?
      where run_id = ? and op_key = ?
      """,
      [wait_status, maybe_encode_json(payload), now, op["caller_run_id"], wait_key]
    )

    SQL.query!(
      Repo,
      """
      update runs
      set
        status = 'pending',
        updated_at = ?
      where id = ? and status = 'waiting'
      """,
      [now, op["caller_run_id"]]
    )

    append_service_ask_wait_satisfied_event!(
      op["caller_run_id"],
      %{
        "kind" => "ask_reply",
        "key" => wait_key,
        "correlationId" => correlation_id,
        "payload" => payload
      },
      now,
      prepared_event
    )
  end

  defp append_service_ask_wait_satisfied_event!(run_id, body, now, nil) do
    append_event!(run_id, "WaitSatisfied", body, now)
  end

  defp append_service_ask_wait_satisfied_event!(run_id, _body, now, %{storage: storage}) do
    SqlSupport.append_prepared_event!(run_id, "WaitSatisfied", storage, now)
  end

  def timeout_service_ask_wait!(run_id, op_key, wait, now) do
    correlation_id = wait["wait_name"]

    error_body = %{
      "message" => "Service ask timed out",
      "reason" => "ask_timeout",
      "correlationId" => correlation_id
    }

    SQL.query!(
      Repo,
      """
      update run_service_ops
      set
        status = 'failed',
        response_json = null,
        error_json = ?,
        updated_at = ?
      where caller_run_id = ? and correlation_id = ? and status = 'waiting'
      """,
      [maybe_encode_json(error_body), now, run_id, correlation_id]
    )

    SQL.query!(
      Repo,
      """
      update run_waits
      set
        status = 'failed',
        output_json = ?,
        updated_at = ?
      where run_id = ? and op_key = ?
      """,
      [maybe_encode_json(error_body), now, run_id, op_key]
    )

    SQL.query!(
      Repo,
      """
      update runs
      set
        status = 'pending',
        updated_at = ?
      where id = ? and status = 'waiting'
      """,
      [now, run_id]
    )

    append_event!(
      run_id,
      "TimerFired",
      %{"kind" => wait["wait_kind"], "key" => op_key, "wakeAt" => wait["wake_at"]},
      now
    )

    append_event!(
      run_id,
      "AskTimedOut",
      %{"key" => op_key, "correlationId" => correlation_id, "wakeAt" => wait["wake_at"]},
      now
    )

    append_event!(
      run_id,
      "WaitFailed",
      %{
        "kind" => wait["wait_kind"],
        "key" => op_key,
        "name" => wait["wait_name"],
        "wakeAt" => wait["wake_at"],
        "error" => error_body
      },
      now
    )

    wait_from_row(get_run_wait(run_id, op_key))
  end

  def service_next_status(service_run_id, stop?) do
    current_run = ReadModels.get_run(service_run_id)

    ServiceLifecycle.next_status(
      current_run["status"],
      service_has_ready_queued_envelopes?(service_run_id),
      stop?
    )
  end
end
