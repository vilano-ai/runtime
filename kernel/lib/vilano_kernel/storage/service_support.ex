defmodule VilanoKernel.Storage.ServiceSupport do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage.{Infrastructure, ReadModels, ServiceLifecycle}

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
        now
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
             now
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
        now
      ) do
    envelope_id = "env_" <> Ecto.UUID.generate()
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
        maybe_encode_json(payload),
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

    append_event!(
      service_run_id,
      "InboundEnqueued",
      %{
        "envelopeId" => envelope_id,
        "kind" => kind,
        "name" => name,
        "payload" => payload,
        "correlationId" => correlation_id,
        "senderRunId" => sender_run_id
      },
      now
    )

    envelope_id
  end

  def maybe_append_service_turn_waiting!(run, wait_body, now) do
    if run["definitionKind"] == "service" do
      case get_processing_service_envelope_for_run(run["id"]) do
        nil ->
          :ok

        envelope ->
          append_event!(
            run["id"],
            "TurnWaiting",
            Map.merge(wait_body, %{
              "envelopeId" => envelope["id"],
              "kind" => envelope["kind"],
              "turnName" => envelope["name"],
              "correlationId" => envelope["correlation_id"]
            }),
            now
          )
      end
    else
      :ok
    end
  end

  def wake_service_ask_waiter!(correlation_id, status, payload, now) do
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

    if op && op["status"] == "waiting" do
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

      append_event!(
        op["caller_run_id"],
        "WaitSatisfied",
        %{
          "kind" => "ask_reply",
          "key" => wait_key,
          "correlationId" => correlation_id,
          "payload" => payload
        },
        now
      )
    end
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
