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

  alias VilanoKernel.Storage.{Infrastructure, RunControl, ServiceSupport, Support}

  import Support
  import ServiceSupport

  def resolve_service_send(lease_id, service_run_id, name, op_key, payload) do
    now = Infrastructure.now_iso8601()

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
              RunControl.ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

              case maybe_insert_service_envelope(
                     service_run,
                     "send",
                     name,
                     payload,
                     nil,
                     caller_run["id"],
                     now
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
                    ) values (?, ?, ?, 'send', ?, null, 'completed', ?, null, null, ?, ?)
                    """,
                    [
                      caller_run["id"],
                      op_key,
                      service_run_id,
                      name,
                      Jason.encode!(payload),
                      now,
                      now
                    ]
                  )

                  append_event!(
                    caller_run["id"],
                    "MessageSent",
                    %{
                      "key" => op_key,
                      "serviceRunId" => service_run_id,
                      "name" => name,
                      "payload" => payload
                    },
                    now
                  )

                  RunControl.ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

                  %{"status" => "completed"}

                {:error, error} ->
                  persist_failed_service_op!(
                    caller_run["id"],
                    op_key,
                    service_run_id,
                    "send",
                    name,
                    nil,
                    payload,
                    error,
                    now
                  )

                  %{"status" => "failed", "error" => error}
              end
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_service_signal(lease_id, service_run_id, name, op_key, payload) do
    now = Infrastructure.now_iso8601()

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
              RunControl.ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

              case maybe_insert_service_envelope(
                     service_run,
                     "signal",
                     name,
                     payload,
                     nil,
                     caller_run["id"],
                     now
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
                    ) values (?, ?, ?, 'signal', ?, null, 'completed', ?, null, null, ?, ?)
                    """,
                    [
                      caller_run["id"],
                      op_key,
                      service_run_id,
                      name,
                      Jason.encode!(payload),
                      now,
                      now
                    ]
                  )

                  append_event!(
                    caller_run["id"],
                    "SignalSent",
                    %{
                      "key" => op_key,
                      "serviceRunId" => service_run_id,
                      "signal" => name,
                      "payload" => payload
                    },
                    now
                  )

                  RunControl.ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

                  %{"status" => "completed"}

                {:error, error} ->
                  persist_failed_service_op!(
                    caller_run["id"],
                    op_key,
                    service_run_id,
                    "signal",
                    name,
                    nil,
                    payload,
                    error,
                    now
                  )

                  %{"status" => "failed", "error" => error}
              end
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_service_ask(lease_id, service_run_id, name, op_key, payload, timeout_ms \\ nil) do
    now = Infrastructure.now_iso8601()
    wake_at = wait_deadline(now, timeout_ms)

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
              RunControl.ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

              case maybe_insert_service_envelope(
                     service_run,
                     "ask",
                     name,
                     payload,
                     correlation_id,
                     caller_run["id"],
                     now
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
                      Jason.encode!(payload),
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

                  append_event!(
                    caller_run["id"],
                    "AskRequested",
                    %{
                      "key" => op_key,
                      "serviceRunId" => service_run_id,
                      "name" => name,
                      "correlationId" => correlation_id,
                      "payload" => payload
                    },
                    now
                  )

                  append_event!(
                    caller_run["id"],
                    "WaitRegistered",
                    %{
                      "kind" => "ask_reply",
                      "key" => "ask_reply:" <> correlation_id,
                      "correlationId" => correlation_id,
                      "wakeAt" => wake_at
                    },
                    now
                  )

                  append_event!(
                    caller_run["id"],
                    "RunSuspended",
                    %{
                      "reason" => "ask_reply",
                      "key" => "ask_reply:" <> correlation_id,
                      "correlationId" => correlation_id
                    },
                    now
                  )

                  maybe_append_service_turn_waiting!(
                    caller_run,
                    %{
                      "waitKind" => "ask_reply",
                      "key" => "ask_reply:" <> correlation_id,
                      "name" => correlation_id,
                      "correlationId" => correlation_id,
                      "wakeAt" => wake_at
                    },
                    now
                  )

                  RunControl.ensure_fenced_run_write!(
                    caller_run["id"],
                    lease_id,
                    now,
                    """
                    update runs
                    set
                      status = 'waiting',
                      lease_id = null,
                      lease_auth_token = null,
                      lease_worker_id = null,
                      lease_expires_at = null,
                      updated_at = ?
                    where id = ?
                    """,
                    [now, caller_run["id"]]
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
                  persist_failed_service_op!(
                    caller_run["id"],
                    op_key,
                    service_run_id,
                    "ask",
                    name,
                    correlation_id,
                    payload,
                    error,
                    now
                  )

                  %{"status" => "failed", "error" => error}
              end
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def complete_service_turn(lease_id, envelope_id, body) do
    now = Infrastructure.now_iso8601()

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
              append_event!(
                service_run["id"],
                "ServiceInitialized",
                %{"state" => state},
                now
              )
            end

            if state_commit in [:initialized, :updated] do
              append_event!(
                service_run["id"],
                "ServiceStateCommitted",
                %{"state" => state},
                now
              )
            end

            if envelope["kind"] == "ask" do
              append_event!(
                service_run["id"],
                "AskReplyCommitted",
                %{
                  "envelopeId" => envelope_id,
                  "correlationId" => envelope["correlation_id"],
                  "reply" => Map.get(body, "reply")
                },
                now
              )

              wake_service_ask_waiter!(
                envelope["correlation_id"],
                "completed",
                Map.get(body, "reply"),
                now
              )
            end

            append_event!(
              service_run["id"],
              "TurnCompleted",
              %{
                "envelopeId" => envelope_id,
                "kind" => envelope["kind"],
                "name" => envelope["name"]
              },
              now
            )

            if Map.get(body, "stop") == true do
              _ =
                VilanoKernel.Storage.FailureRecovery.stop_service_run_instance!(
                  get_service_run_by_id(service_run["id"]),
                  VilanoKernel.Storage.FailureRecovery.cancellation_error(
                    "Service stopped",
                    "handler_stop"
                  ),
                  "handler_stop",
                  now,
                  lease_id
                )
            else
              next_status = service_next_status(service_run["id"], false)

              RunControl.ensure_fenced_run_write!(
                service_run["id"],
                lease_id,
                now,
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
                [next_status, now, service_run["id"]]
              )
            end

            VilanoKernel.Storage.get_run(service_run["id"])
          else
            nil
          end
      end
    end)
    |> unwrap_transaction_result()
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

            RunControl.ensure_fenced_run_write!(
              service_run["id"],
              lease_id,
              now,
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
              [next_status, now, service_run["id"]]
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

            RunControl.ensure_fenced_run_write!(
              service_run["id"],
              lease_id,
              now,
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
              [next_status, now, service_run["id"]]
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
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case {RunControl.get_fenced_run_by_lease(lease_id, now), get_service_envelope(envelope_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {service_run, envelope} ->
          if envelope["service_run_id"] == service_run["id"] do
            VilanoKernel.Storage.FailureRecovery.fail_service_turn_attempt!(
              service_run,
              envelope,
              error_body,
              retry_options,
              now,
              lease_id
            )
          else
            nil
          end
      end
    end)
    |> unwrap_transaction_result()
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
