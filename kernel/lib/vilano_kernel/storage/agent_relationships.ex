defmodule VilanoKernel.Storage.AgentRelationships do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{AgentKernel, Infrastructure, RunControl, ServiceSupport, Support}

  import Support
  import ServiceSupport

  def resolve_run_monitor(lease_id, target_run_id, op_key) do
    resolve_run_relationship(lease_id, target_run_id, op_key, "monitor", "all")
  end

  def resolve_run_link(lease_id, target_run_id, op_key, propagate \\ "abnormal") do
    resolve_run_relationship(lease_id, target_run_id, op_key, "link", propagate)
  end

  def set_trap_exits(lease_id, enabled) do
    now = Infrastructure.now_iso8601()
    trap_value = if enabled, do: 1, else: 0

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          current_value = AgentKernel.run_trap_exits_value(run["id"])

          if current_value != trap_value do
            RunControl.ensure_fenced_run_write!(
              run["id"],
              lease_id,
              now,
              """
              update runs
              set
                trap_exits = ?,
                updated_at = ?
              where id = ?
              """,
              [trap_value, now, run["id"]]
            )

            append_event!(run["id"], "TrapExitsUpdated", %{"enabled" => enabled}, now)
          end

          VilanoKernel.Storage.get_run(run["id"])
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_exit_wait(lease_id, op_key) do
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
                ) values (?, ?, 'exit', 'next', 'waiting', null, null, ?, ?)
                on conflict(run_id, op_key) do update set
                  wait_kind = excluded.wait_kind,
                  wait_name = excluded.wait_name,
                  status = 'waiting',
                  wake_at = null,
                  output_json = null,
                  updated_at = excluded.updated_at
                """,
                [run["id"], op_key, now, now]
              )

              run_storage_test_hook(:exit_wait_registered, %{
                "runId" => run["id"],
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
                  case deliver_oldest_pending_exit_event!(run["id"], now) do
                    {:delivered, delivered_wait} ->
                      %{
                        "status" => "completed",
                        "wait" => wait_from_row(delivered_wait),
                        "output" => decode_json_value(delivered_wait["output_json"], nil)
                      }

                    :none ->
                      if existing && existing["status"] == "waiting" do
                        %{
                          "status" => "suspended",
                          "wait" => %{
                            "runId" => run["id"],
                            "key" => op_key,
                            "kind" => "exit",
                            "name" => "next",
                            "status" => "waiting",
                            "wakeAt" => nil,
                            "output" => nil
                          }
                        }
                      else
                        RunControl.ensure_fenced_run_write!(
                          run["id"],
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
                          [now, run["id"]]
                        )

                        append_event!(
                          run["id"],
                          "WaitRegistered",
                          %{"kind" => "exit", "key" => op_key},
                          now
                        )

                        append_event!(
                          run["id"],
                          "RunSuspended",
                          %{"reason" => "exit", "key" => op_key},
                          now
                        )

                        maybe_append_service_turn_waiting!(
                          run,
                          %{"waitKind" => "exit", "key" => op_key, "name" => "next"},
                          now
                        )

                        %{
                          "status" => "suspended",
                          "wait" => %{
                            "runId" => run["id"],
                            "key" => op_key,
                            "kind" => "exit",
                            "name" => "next",
                            "status" => "waiting",
                            "wakeAt" => nil,
                            "output" => nil
                          }
                        }
                      end
                  end
              end
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def maybe_trigger_relationships_for_terminal_run!(run_id, now) do
    case VilanoKernel.Storage.get_run_for_inspect(run_id) do
      nil ->
        :ok

      target_run ->
        Enum.each(AgentKernel.list_active_run_relationships_for_target(run_id), fn relationship ->
          maybe_trigger_run_relationship!(relationship, target_run, now)
        end)
    end
  end

  def wake_waiting_parents_for_child!(child_run_id, child_status, payload, now) do
    SQL.query!(
      Repo,
      """
      update run_children
      set
        status = ?,
        updated_at = ?
      where child_run_id = ?
      """,
      [child_status, now, child_run_id]
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
        where wait_kind = 'child_result' and wait_name = ? and status = 'waiting'
        """,
        [child_run_id]
      )
      |> rows_to_maps()

    Enum.each(waiting_rows, fn wait ->
      wait_status = if child_status == "completed", do: "completed", else: "failed"

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
        [wait_status, Jason.encode!(payload), now, wait["run_id"], wait["op_key"]]
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
        [now, wait["run_id"]]
      )

      append_event!(
        wait["run_id"],
        "WaitSatisfied",
        %{
          "kind" => "child_result",
          "key" => wait["op_key"],
          "childRunId" => child_run_id,
          "childStatus" => child_status,
          "payload" => payload
        },
        now
      )
    end)
  end

  def resolve_run_relationship(lease_id, target_run_id, op_key, kind, propagate) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        owner_run ->
          cond do
            not related_run_visible?(owner_run["id"], target_run_id) ->
              nil

            true ->
              case VilanoKernel.Storage.get_run_for_inspect(target_run_id) do
                nil ->
                  nil

                target_run ->
                  relationship =
                    case AgentKernel.get_run_relationship(owner_run["id"], op_key) do
                      nil ->
                        relationship_id = "rel_" <> Ecto.UUID.generate()

                        SQL.query!(
                          Repo,
                          """
                          insert into run_relationships (
                            id,
                            owner_run_id,
                            op_key,
                            target_run_id,
                            kind,
                            propagate,
                            status,
                            created_at,
                            updated_at
                          ) values (?, ?, ?, ?, ?, ?, 'active', ?, ?)
                          """,
                          [
                            relationship_id,
                            owner_run["id"],
                            op_key,
                            target_run_id,
                            kind,
                            propagate,
                            now,
                            now
                          ]
                        )

                        append_event!(
                          owner_run["id"],
                          "RunRelationshipRegistered",
                          %{
                            "key" => op_key,
                            "kind" => kind,
                            "targetRunId" => target_run_id,
                            "propagate" => propagate
                          },
                          now
                        )

                        AgentKernel.get_run_relationship_by_id(relationship_id)

                      existing ->
                        existing
                    end

                  maybe_trigger_run_relationship!(relationship, target_run, now)

                  AgentKernel.relationship_from_row(
                    AgentKernel.get_run_relationship_by_id(relationship["id"])
                  )
              end
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def maybe_trigger_run_relationship!(relationship, target_run, now) do
    if relationship["status"] != "active" or
         not VilanoKernel.Storage.FailureRecovery.terminal_run_status?(target_run["status"]) do
      :ok
    else
      SQL.query!(
        Repo,
        """
        update run_relationships
        set
          status = 'triggered',
          updated_at = ?
        where id = ? and status = 'active'
        """,
        [now, relationship["id"]]
      )

      case VilanoKernel.Storage.get_run_for_inspect(relationship["owner_run_id"]) do
        nil ->
          :ok

        owner_run ->
          if VilanoKernel.Storage.FailureRecovery.terminal_run_status?(owner_run["status"]) do
            :ok
          else
            event = AgentKernel.build_exit_event(target_run, relationship["kind"], now)

            cond do
              relationship["kind"] == "monitor" ->
                queue_exit_event!(owner_run["id"], relationship["id"], event, now)

              AgentKernel.run_trap_exits_value(owner_run["id"]) == 1 and
                  AgentKernel.should_queue_link_exit_event?(
                    target_run["status"],
                    relationship["propagate"]
                  ) ->
                queue_exit_event!(owner_run["id"], relationship["id"], event, now)

              relationship["kind"] == "link" and
                  AgentKernel.abnormal_terminal_status?(target_run["status"]) ->
                propagate_linked_exit!(owner_run, target_run, event, now)

              true ->
                :ok
            end
          end
      end
    end
  end

  def queue_exit_event!(run_id, relationship_id, event, now) do
    inserted_rows =
      write_changes!(
        """
        insert into run_exit_events (
          id,
          run_id,
          relationship_id,
          event_json,
          consumed_at,
          created_at
        ) values (?, ?, ?, ?, null, ?)
        on conflict(relationship_id) do nothing
        """,
        [
          "exit_" <> Ecto.UUID.generate(),
          run_id,
          relationship_id,
          Jason.encode!(event),
          now
        ]
      )

    if inserted_rows == 1 do
      append_event!(run_id, "ExitNotified", event, now)
      deliver_oldest_pending_exit_event!(run_id, now)
    else
      :ok
    end
  end

  def deliver_oldest_pending_exit_event!(run_id, now) do
    case {AgentKernel.get_pending_exit_event(run_id), AgentKernel.get_waiting_exit_wait(run_id)} do
      {nil, _} ->
        :none

      {_, nil} ->
        :none

      {event, wait} ->
        SQL.query!(
          Repo,
          """
          update run_exit_events
          set consumed_at = ?
          where id = ? and consumed_at is null
          """,
          [now, event["id"]]
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
          [event["event_json"], now, run_id, wait["op_key"]]
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
            "kind" => "exit",
            "key" => wait["op_key"],
            "event" => decode_json_value(event["event_json"], %{})
          },
          now
        )

        {:delivered, get_run_wait(run_id, wait["op_key"])}
    end
  end

  def propagate_linked_exit!(owner_run, target_run, event, now) do
    error_body = linked_exit_error(target_run, event)

    append_event!(
      owner_run["id"],
      "LinkedExitPropagated",
      %{
        "targetRunId" => target_run["id"],
        "targetStatus" => target_run["status"],
        "error" => error_body
      },
      now
    )

    case owner_run["definitionKind"] do
      "service" ->
        VilanoKernel.Storage.FailureRecovery.stop_service_run_instance!(
          owner_run,
          error_body,
          "linked_exit",
          now
        )

      _ ->
        _ =
          VilanoKernel.Storage.FailureRecovery.cancel_workflow_run_instance!(
            owner_run,
            error_body,
            "linked_exit",
            now
          )

        :ok
    end
  end

  def linked_exit_error(target_run, event) do
    %{
      "name" => "LinkedExitError",
      "message" =>
        "Linked #{target_run["definitionKind"]} '#{target_run["id"]}' exited with status #{target_run["status"]}",
      "reason" => "linked_exit",
      "targetRunId" => target_run["id"],
      "targetKind" => target_run["definitionKind"],
      "targetStatus" => target_run["status"],
      "event" => event
    }
  end
end
