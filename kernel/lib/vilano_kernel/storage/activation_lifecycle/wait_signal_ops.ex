defmodule VilanoKernel.Storage.ActivationLifecycle.WaitSignalOps do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{Infrastructure, RunControl, ServiceSupport, Support}

  import Support
  import ServiceSupport

  def resolve_sleep_wait(lease_id, op_key, duration_ms) do
    now = Infrastructure.now_iso8601()
    wake_at = shift_milliseconds(now, duration_ms)

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          existing = get_run_wait(run["id"], op_key)

          cond do
            existing && existing["status"] == "completed" ->
              %{"status" => "completed", "wait" => wait_from_row(existing), "output" => nil}

            true ->
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
                ) values (?, ?, 'sleep', 'sleep', 'waiting', ?, null, ?, ?)
                on conflict(run_id, op_key) do update set
                  wait_kind = excluded.wait_kind,
                  wait_name = excluded.wait_name,
                  status = 'waiting',
                  wake_at = excluded.wake_at,
                  output_json = null,
                  updated_at = excluded.updated_at
                """,
                [run["id"], op_key, wake_at, now, now]
              )

              RunControl.update_fenced_run!(
                run["id"],
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

              append_event!(
                run["id"],
                "WaitRegistered",
                %{"kind" => "sleep", "key" => op_key, "wakeAt" => wake_at},
                now
              )

              append_event!(
                run["id"],
                "RunSuspended",
                %{"reason" => "sleep", "key" => op_key, "wakeAt" => wake_at},
                now
              )

              maybe_append_service_turn_waiting!(
                run,
                %{
                  "waitKind" => "sleep",
                  "key" => op_key,
                  "name" => "sleep",
                  "wakeAt" => wake_at
                },
                now
              )

              %{
                "status" => "suspended",
                "wait" => %{
                  "runId" => run["id"],
                  "key" => op_key,
                  "kind" => "sleep",
                  "name" => "sleep",
                  "status" => "waiting",
                  "wakeAt" => wake_at,
                  "output" => nil
                }
              }
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def satisfy_timed_wait(run_id, op_key, expected_wake_at) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case get_run_wait(run_id, op_key) do
        nil ->
          nil

        wait ->
          if wait["status"] != "waiting" or is_nil(wait["wake_at"]) or
               wait["wake_at"] != expected_wake_at do
            nil
          else
            case wait["wait_kind"] do
              "ask_reply" ->
                timeout_service_ask_wait!(run_id, op_key, wait, now)

              _ ->
                SQL.query!(
                  Repo,
                  """
                  update run_waits
                  set
                    status = 'completed',
                    updated_at = ?
                  where run_id = ? and op_key = ?
                  """,
                  [now, run_id, op_key]
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
                  "WaitSatisfied",
                  %{
                    "kind" => wait["wait_kind"],
                    "key" => op_key,
                    "name" => wait["wait_name"],
                    "wakeAt" => wait["wake_at"]
                  },
                  now
                )

                wait_from_row(get_run_wait(run_id, op_key))
            end
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def list_waiting_timed_waits do
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
      where wake_at is not null and status = 'waiting'
      order by wake_at asc
      """,
      []
    )
    |> rows_to_maps()
    |> Enum.map(&wait_from_row/1)
  end

  def resolve_signal_wait(lease_id, name, op_key) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          existing = get_run_wait(run["id"], op_key)

          cond do
            existing && existing["status"] == "completed" ->
              %{
                "status" => "completed",
                "wait" => wait_from_row(existing),
                "output" => decode_json_value(existing["output_json"], nil)
              }

            true ->
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
                ) values (?, ?, 'signal', ?, 'waiting', null, null, ?, ?)
                on conflict(run_id, op_key) do update set
                  wait_kind = excluded.wait_kind,
                  wait_name = excluded.wait_name,
                  status = 'waiting',
                  wake_at = null,
                  output_json = null,
                  updated_at = excluded.updated_at
                """,
                [run["id"], op_key, name, now, now]
              )

              run_storage_test_hook(:signal_wait_registered, %{
                "runId" => run["id"],
                "signal" => name,
                "opKey" => op_key,
                "leaseId" => lease_id
              })

              current_wait = get_run_wait(run["id"], op_key)

              cond do
                current_wait && current_wait["status"] == "completed" ->
                  %{
                    "status" => "completed",
                    "wait" => wait_from_row(current_wait),
                    "output" => decode_json_value(current_wait["output_json"], nil)
                  }

                true ->
                  case get_pending_signal(run["id"], name) do
                    nil ->
                      RunControl.update_fenced_run!(
                        run["id"],
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

                      append_event!(
                        run["id"],
                        "WaitRegistered",
                        %{"kind" => "signal", "key" => op_key, "signal" => name},
                        now
                      )

                      append_event!(
                        run["id"],
                        "RunSuspended",
                        %{"reason" => "signal", "key" => op_key, "signal" => name},
                        now
                      )

                      maybe_append_service_turn_waiting!(
                        run,
                        %{
                          "waitKind" => "signal",
                          "key" => op_key,
                          "name" => name,
                          "signal" => name
                        },
                        now
                      )

                      %{
                        "status" => "suspended",
                        "wait" => %{
                          "runId" => run["id"],
                          "key" => op_key,
                          "kind" => "signal",
                          "name" => name,
                          "status" => "waiting",
                          "wakeAt" => nil,
                          "output" => nil
                        }
                      }

                    signal ->
                      SQL.query!(
                        Repo,
                        """
                        update run_signals
                        set consumed_at = ?
                        where id = ?
                        """,
                        [now, signal["id"]]
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
                        ) values (?, ?, 'signal', ?, 'completed', null, ?, ?, ?)
                        on conflict(run_id, op_key) do update set
                          wait_kind = excluded.wait_kind,
                          wait_name = excluded.wait_name,
                          status = 'completed',
                          wake_at = null,
                          output_json = excluded.output_json,
                          updated_at = excluded.updated_at
                        """,
                        [run["id"], op_key, name, signal["payload_json"], now, now]
                      )

                      append_event!(
                        run["id"],
                        "WaitRegistered",
                        %{"kind" => "signal", "key" => op_key, "signal" => name},
                        now
                      )

                      append_event!(
                        run["id"],
                        "WaitSatisfied",
                        %{
                          "kind" => "signal",
                          "key" => op_key,
                          "signal" => name,
                          "payload" => decode_json_value(signal["payload_json"], nil)
                        },
                        now
                      )

                      %{
                        "status" => "completed",
                        "wait" => wait_from_row(get_run_wait(run["id"], op_key)),
                        "output" => decode_json_value(signal["payload_json"], nil)
                      }
                  end
              end
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def send_run_signal(run_id, signal_name, payload) do
    now = Infrastructure.now_iso8601()
    signal_id = "sig_" <> Ecto.UUID.generate()

    Infrastructure.transaction_with_busy_retry(fn ->
      SQL.query!(
        Repo,
        """
        insert into run_signals (
          id,
          run_id,
          signal_name,
          payload_json,
          consumed_at,
          created_at
        ) values (?, ?, ?, ?, null, ?)
        """,
        [signal_id, run_id, signal_name, maybe_encode_json(payload), now]
      )

      append_event!(
        run_id,
        "SignalReceived",
        %{"signal" => signal_name, "payload" => payload},
        now
      )

      waiting_rows =
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
          where run_id = ? and wait_kind = 'signal' and wait_name = ? and status = 'waiting'
          order by created_at asc
          limit 1
          """,
          [run_id, signal_name]
        )
        |> rows_to_maps()
        |> List.first()

      if waiting_rows do
        SQL.query!(
          Repo,
          """
          update run_signals
          set consumed_at = ?
          where id = ?
          """,
          [now, signal_id]
        )

        SQL.query!(
          Repo,
          """
          update run_waits
          set
            status = 'completed',
            output_json = ?,
            updated_at = ?
          where run_id = ? and op_key = ?
          """,
          [maybe_encode_json(payload), now, run_id, waiting_rows["op_key"]]
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
          "WaitSatisfied",
          %{
            "kind" => "signal",
            "key" => waiting_rows["op_key"],
            "signal" => signal_name,
            "payload" => payload
          },
          now
        )
      end

      %{"ok" => true}
    end)
    |> unwrap_transaction_result()
  end
end
