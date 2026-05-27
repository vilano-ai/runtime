defmodule VilanoKernel.Storage.AgentRelationships do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{
    AgentKernel,
    EventPayloads,
    Infrastructure,
    RunControl,
    ServiceSupport,
    Support
  }

  alias VilanoKernel.Storage.Support.Sql, as: SqlSupport

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

  def maybe_trigger_relationships_for_terminal_run!(
        run_id,
        now,
        prepared_relationships \\ nil
      ) do
    case VilanoKernel.Storage.get_run_for_inspect(run_id) do
      nil ->
        :ok

      target_run ->
        Enum.each(AgentKernel.list_active_run_relationships_for_target(run_id), fn relationship ->
          maybe_trigger_run_relationship!(
            relationship,
            target_run,
            now,
            prepared_relationships
          )
        end)
    end
  end

  def prepare_terminal_linked_exit_cancellations(
        run_id,
        terminal_status,
        now,
        visited_run_ids \\ MapSet.new(),
        terminal_payload \\ :current
      ) do
    Infrastructure.run_with_busy_retry(
      fn ->
        do_prepare_terminal_linked_exit_cancellations(
          run_id,
          terminal_status,
          now,
          MapSet.put(visited_run_ids, run_id),
          terminal_payload
        )
      end,
      :public_read
    )
  end

  def discard_prepared_linked_exit_cancellations(nil), do: :ok

  def discard_prepared_linked_exit_cancellations(%{
        linked_exit_plans: linked_exit_plans,
        relationship_events: relationship_events
      }) do
    relationship_events
    |> Map.values()
    |> Enum.each(&discard_prepared_relationship_event_plan/1)

    linked_exit_plans
    |> Map.values()
    |> Enum.each(&discard_prepared_linked_exit_plan/1)
  end

  def discard_prepared_linked_exit_cancellations(prepared_cancellations)
      when is_map(prepared_cancellations) do
    prepared_cancellations
    |> Map.values()
    |> Enum.each(&discard_prepared_linked_exit_plan/1)
  end

  defp do_prepare_terminal_linked_exit_cancellations(
         run_id,
         terminal_status,
         now,
         visited_run_ids,
         terminal_payload
       ) do
    case VilanoKernel.Storage.get_run_for_inspect(run_id) do
      nil ->
        empty_prepared_relationships()

      target_run ->
        target_run =
          target_run_with_terminal_payload(target_run, terminal_status, terminal_payload)

        run_id
        |> AgentKernel.list_active_run_relationships_for_target()
        |> prepare_relationships_for_target(target_run, now, visited_run_ids)
    end
  end

  defp prepare_resolve_relationships(lease_id, target_run_id, op_key, kind, propagate, now) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case {RunControl.get_run_by_lease(lease_id),
              VilanoKernel.Storage.get_run_for_inspect(target_run_id)} do
          {owner_run, target_run} when is_map(owner_run) and is_map(target_run) ->
            if related_run_visible?(owner_run["id"], target_run_id) and
                 VilanoKernel.Storage.FailureRecovery.terminal_run_status?(target_run["status"]) do
              relationship =
                AgentKernel.get_run_relationship(owner_run["id"], op_key) ||
                  %{
                    "owner_run_id" => owner_run["id"],
                    "op_key" => op_key,
                    "target_run_id" => target_run_id,
                    "kind" => kind,
                    "propagate" => propagate,
                    "status" => "active"
                  }

              prepare_relationships_for_target(
                [relationship],
                target_run,
                now,
                MapSet.new([target_run_id])
              )
            else
              empty_prepared_relationships()
            end

          _ ->
            empty_prepared_relationships()
        end
      end,
      :public_read
    )
  end

  defp prepare_relationships_for_target(
         relationships,
         target_run,
         now,
         visited_run_ids
       ) do
    do_prepare_relationships_for_target(
      relationships,
      target_run,
      now,
      visited_run_ids,
      empty_prepared_relationships()
    )
  end

  defp do_prepare_relationships_for_target(
         [],
         _target_run,
         _now,
         _visited_run_ids,
         acc
       ),
       do: acc

  defp do_prepare_relationships_for_target(
         [relationship | rest],
         target_run,
         now,
         visited_run_ids,
         acc
       ) do
    try do
      next_acc =
        case VilanoKernel.Storage.get_run_for_inspect(relationship["owner_run_id"]) do
          owner_run when is_map(owner_run) ->
            prepare_relationship_update!(
              acc,
              relationship,
              target_run,
              owner_run,
              now,
              visited_run_ids
            )

          _ ->
            acc
        end

      do_prepare_relationships_for_target(
        rest,
        target_run,
        now,
        visited_run_ids,
        next_acc
      )
    rescue
      error ->
        discard_prepared_linked_exit_cancellations(acc)
        reraise error, __STACKTRACE__
    end
  end

  defp prepare_relationship_update!(
         acc,
         relationship,
         target_run,
         owner_run,
         now,
         visited_run_ids
       ) do
    if VilanoKernel.Storage.FailureRecovery.terminal_run_status?(owner_run["status"]) do
      acc
    else
      event = AgentKernel.build_exit_event(target_run, relationship["kind"], now)
      event_plan = prepare_relationship_event_plan!(relationship, target_run, owner_run, event)

      try do
        linked_exit_plan =
          cond do
            not linked_exit_cancels_owner?(relationship, target_run, owner_run) ->
              nil

            MapSet.member?(visited_run_ids, owner_run["id"]) ->
              nil

            Map.has_key?(acc.linked_exit_plans, owner_run["id"]) ->
              nil

            true ->
              prepare_linked_exit_plan!(
                owner_run,
                linked_exit_error(target_run, event),
                now,
                MapSet.put(visited_run_ids, owner_run["id"]),
                excluded_child_run_ids: MapSet.new([target_run["id"]])
              )
          end

        acc
        |> put_prepared_relationship_event(relationship, event_plan)
        |> put_prepared_linked_exit_plan(owner_run, linked_exit_plan)
      rescue
        error ->
          discard_prepared_relationship_event_plan(event_plan)
          reraise error, __STACKTRACE__
      end
    end
  end

  defp prepare_relationship_event_plan!(relationship, target_run, owner_run, event) do
    cond do
      relationship_queues_exit?(relationship, target_run, owner_run) ->
        exit_notified_event = EventPayloads.prepare_body_for_storage!(event)

        try do
          %{
            kind: :queued_exit,
            exit_notified_event: exit_notified_event,
            exit_wait_satisfied_event: prepare_exit_wait_satisfied_event(owner_run["id"], event)
          }
        rescue
          error ->
            EventPayloads.discard_prepared_payload!(exit_notified_event)
            reraise error, __STACKTRACE__
        end

      linked_exit_cancels_owner?(relationship, target_run, owner_run) ->
        error_body = linked_exit_error(target_run, event)

        %{
          kind: :linked_exit,
          error: error_body,
          linked_exit_propagated_event:
            EventPayloads.prepare_body_for_storage!(
              linked_exit_propagated_body(target_run, error_body)
            )
        }

      true ->
        nil
    end
  end

  defp prepare_exit_wait_satisfied_event(run_id, new_event) do
    case AgentKernel.get_waiting_exit_wait(run_id) do
      nil ->
        nil

      wait ->
        event_json =
          case AgentKernel.get_pending_exit_event(run_id) do
            nil -> Jason.encode!(new_event)
            pending -> pending["event_json"]
          end

        %{
          expected_event: decode_json_value(event_json, %{}),
          expected_wait_key: wait["op_key"],
          storage:
            EventPayloads.prepare_body_for_storage!(%{
              "kind" => "exit",
              "key" => wait["op_key"],
              "event" => decode_json_value(event_json, %{})
            })
        }
    end
  end

  defp relationship_queues_exit?(relationship, target_run, owner_run) do
    relationship["kind"] == "monitor" or
      (AgentKernel.run_trap_exits_value(owner_run["id"]) == 1 and
         AgentKernel.should_queue_link_exit_event?(
           target_run["status"],
           Map.get(relationship, "propagate", "abnormal")
         ))
  end

  defp put_prepared_relationship_event(acc, _relationship, nil), do: acc

  defp put_prepared_relationship_event(acc, relationship, event_plan) do
    put_in(acc, [:relationship_events, prepared_relationship_key(relationship)], event_plan)
  end

  defp put_prepared_linked_exit_plan(acc, _owner_run, nil), do: acc

  defp put_prepared_linked_exit_plan(acc, owner_run, linked_exit_plan) do
    put_in(acc, [:linked_exit_plans, owner_run["id"]], linked_exit_plan)
  end

  defp empty_prepared_relationships, do: %{linked_exit_plans: %{}, relationship_events: %{}}

  defp target_run_with_terminal_payload(target_run, terminal_status, :current) do
    Map.put(target_run, "status", terminal_status)
  end

  defp target_run_with_terminal_payload(target_run, "completed", payload) do
    target_run
    |> Map.put("status", "completed")
    |> Map.put("output", payload)
    |> Map.put("error", nil)
  end

  defp target_run_with_terminal_payload(target_run, terminal_status, payload) do
    target_run
    |> Map.put("status", terminal_status)
    |> Map.put("output", nil)
    |> Map.put("error", payload)
  end

  defp linked_exit_cancels_owner?(relationship, target_run, owner_run) do
    relationship["kind"] == "link" and
      AgentKernel.abnormal_terminal_status?(target_run["status"]) and
      not VilanoKernel.Storage.FailureRecovery.terminal_run_status?(owner_run["status"]) and
      AgentKernel.run_trap_exits_value(owner_run["id"]) != 1
  end

  defp linked_exit_propagated_body(target_run, error_body) do
    %{
      "targetRunId" => target_run["id"],
      "targetStatus" => target_run["status"],
      "error" => error_body
    }
  end

  defp prepare_linked_exit_plan!(
         %{"definitionKind" => "service"} = owner_run,
         error_body,
         now,
         visited_run_ids,
         opts
       ) do
    %{
      kind: :service_stop,
      prepared:
        VilanoKernel.Storage.FailureRecovery.ServiceFailure.prepare_service_stop!(
          owner_run,
          error_body,
          "linked_exit",
          now,
          visited_run_ids,
          opts
        )
    }
  end

  defp prepare_linked_exit_plan!(owner_run, error_body, now, visited_run_ids, opts) do
    %{
      kind: :workflow_cancellation,
      prepared:
        VilanoKernel.Storage.FailureRecovery.WorkflowFailure.prepare_workflow_cancellation!(
          owner_run,
          error_body,
          "linked_exit",
          now,
          visited_run_ids,
          opts
        )
    }
  end

  defp discard_prepared_linked_exit_plan(%{kind: :service_stop, prepared: prepared}) do
    VilanoKernel.Storage.FailureRecovery.ServiceFailure.discard_prepared_service_stop(prepared)
  end

  defp discard_prepared_linked_exit_plan(%{kind: :workflow_cancellation, prepared: prepared}) do
    VilanoKernel.Storage.FailureRecovery.discard_prepared_workflow_cancellation(prepared)
  end

  defp discard_prepared_linked_exit_plan(prepared) do
    VilanoKernel.Storage.FailureRecovery.discard_prepared_workflow_cancellation(prepared)
  end

  defp discard_prepared_relationship_event_plan(nil), do: :ok

  defp discard_prepared_relationship_event_plan(%{kind: :queued_exit} = prepared) do
    prepared
    |> Map.get(:exit_notified_event)
    |> discard_prepared_payload()

    prepared
    |> get_in([:exit_wait_satisfied_event, :storage])
    |> discard_prepared_payload()
  end

  defp discard_prepared_relationship_event_plan(%{kind: :linked_exit} = prepared) do
    prepared
    |> Map.get(:linked_exit_propagated_event)
    |> discard_prepared_payload()
  end

  defp discard_prepared_payload(nil), do: :ok
  defp discard_prepared_payload(storage), do: EventPayloads.discard_prepared_payload!(storage)

  defp prepared_linked_exit_plan!(nil, _owner_run), do: nil

  defp prepared_linked_exit_plan!(prepared_cancellations, owner_run)
       when is_map(prepared_cancellations) do
    linked_exit_plans =
      Map.get(prepared_cancellations, :linked_exit_plans, prepared_cancellations)

    case Map.fetch(linked_exit_plans, owner_run["id"]) do
      {:ok, prepared_plan} -> prepared_plan
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_relationship_event_plan!(nil, _relationship), do: nil

  defp prepared_relationship_event_plan!(prepared_relationships, relationship)
       when is_map(prepared_relationships) do
    relationship_events = Map.get(prepared_relationships, :relationship_events, %{})

    case Map.fetch(relationship_events, prepared_relationship_key(relationship)) do
      {:ok, event_plan} -> event_plan
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_relationship_key(relationship) do
    relationship["owner_run_id"] <> ":" <> relationship["op_key"]
  end

  defp prepared_queued_exit_event_plan!(nil), do: nil

  defp prepared_queued_exit_event_plan!(%{kind: :queued_exit} = prepared), do: prepared

  defp prepared_queued_exit_event_plan!(_prepared),
    do: Repo.rollback(:stale_cancellation_plan)

  defp prepared_linked_exit_event_plan!(nil), do: nil

  defp prepared_linked_exit_event_plan!(%{kind: :linked_exit} = prepared), do: prepared

  defp prepared_linked_exit_event_plan!(_prepared),
    do: Repo.rollback(:stale_cancellation_plan)

  defp prepared_linked_exit_cancellation!(prepared_plan) do
    case prepared_plan do
      nil -> nil
      %{kind: :workflow_cancellation, prepared: prepared} -> prepared
      _ -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_linked_exit_service_stop!(prepared_plan) do
    case prepared_plan do
      nil -> nil
      %{kind: :service_stop, prepared: prepared} -> prepared
      _ -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp append_exit_notified_event!(run_id, event, now, nil) do
    append_event!(run_id, "ExitNotified", event, now)
  end

  defp append_exit_notified_event!(run_id, _event, now, %{kind: :queued_exit} = prepared) do
    SqlSupport.append_prepared_event!(run_id, "ExitNotified", prepared.exit_notified_event, now)
  end

  defp append_exit_wait_satisfied_event!(run_id, body, now, :inline, _event, _wait) do
    append_event!(run_id, "WaitSatisfied", body, now)
  end

  defp append_exit_wait_satisfied_event!(_run_id, _body, _now, nil, _event, _wait) do
    Repo.rollback(:stale_cancellation_plan)
  end

  defp append_exit_wait_satisfied_event!(run_id, _body, now, prepared, event, wait) do
    if prepared.expected_event == decode_json_value(event["event_json"], %{}) and
         prepared.expected_wait_key == wait["op_key"] do
      SqlSupport.append_prepared_event!(run_id, "WaitSatisfied", prepared.storage, now)
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp append_linked_exit_propagated_event!(run_id, body, now, nil) do
    append_event!(run_id, "LinkedExitPropagated", body, now)
  end

  defp append_linked_exit_propagated_event!(
         run_id,
         _body,
         now,
         %{kind: :linked_exit} = prepared
       ) do
    SqlSupport.append_prepared_event!(
      run_id,
      "LinkedExitPropagated",
      prepared.linked_exit_propagated_event,
      now
    )
  end

  def prepare_child_result_wait_satisfied_events(
        child_run_id,
        child_status,
        payload,
        excluded_run_ids \\ MapSet.new()
      ) do
    Infrastructure.run_with_busy_retry(
      fn ->
        child_run_id
        |> child_result_waiting_rows()
        |> Enum.reject(&MapSet.member?(excluded_run_ids, &1["run_id"]))
        |> prepare_wait_satisfied_events(fn wait ->
          %{
            "kind" => "child_result",
            "key" => wait["op_key"],
            "childRunId" => child_run_id,
            "childStatus" => child_status,
            "payload" => payload
          }
        end)
      end,
      :public_read
    )
  end

  def discard_prepared_child_result_wait_events(nil), do: :ok

  def discard_prepared_child_result_wait_events(prepared_events) when is_map(prepared_events) do
    prepared_events
    |> Map.values()
    |> Enum.each(&EventPayloads.discard_prepared_payload!/1)
  end

  def wake_waiting_parents_for_child!(
        child_run_id,
        child_status,
        payload,
        now,
        prepared_wait_events \\ nil
      ) do
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

    waiting_rows = child_result_waiting_rows(child_run_id)
    validate_prepared_wait_events!(prepared_wait_events, waiting_rows)

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
        now,
        prepared_wait_events,
        wait
      )
    end)
  end

  defp child_result_waiting_rows(child_run_id) do
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
  end

  defp prepare_wait_satisfied_events(waiting_rows, body_fun) do
    do_prepare_wait_satisfied_events(waiting_rows, body_fun, %{})
  end

  defp do_prepare_wait_satisfied_events([], _body_fun, acc), do: acc

  defp do_prepare_wait_satisfied_events([wait | rest], body_fun, acc) do
    try do
      storage = EventPayloads.prepare_body_for_storage!(body_fun.(wait))

      do_prepare_wait_satisfied_events(
        rest,
        body_fun,
        Map.put(acc, prepared_wait_key(wait), storage)
      )
    rescue
      error ->
        discard_prepared_child_result_wait_events(acc)
        reraise error, __STACKTRACE__
    end
  end

  defp append_event!(run_id, event_type, body, now, nil, _wait) do
    append_event!(run_id, event_type, body, now)
  end

  defp append_event!(run_id, event_type, _body, now, prepared_events, wait) do
    case Map.fetch(prepared_events, prepared_wait_key(wait)) do
      {:ok, storage} -> SqlSupport.append_prepared_event!(run_id, event_type, storage, now)
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp validate_prepared_wait_events!(nil, _waiting_rows), do: :ok

  defp validate_prepared_wait_events!(prepared_events, waiting_rows) do
    prepared_keys =
      prepared_events
      |> Map.keys()
      |> Enum.sort()

    waiting_keys =
      waiting_rows
      |> Enum.map(&prepared_wait_key/1)
      |> Enum.sort()

    if prepared_keys == waiting_keys do
      :ok
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_wait_key(wait), do: wait["run_id"] <> ":" <> wait["op_key"]

  def resolve_run_relationship(lease_id, target_run_id, op_key, kind, propagate) do
    resolve_run_relationship_with_prepared_payload_retry(
      lease_id,
      target_run_id,
      op_key,
      kind,
      propagate,
      3
    )
  end

  defp resolve_run_relationship_with_prepared_payload_retry(
         lease_id,
         target_run_id,
         op_key,
         kind,
         propagate,
         attempts_left
       ) do
    now = Infrastructure.now_iso8601()

    prepared_relationships =
      prepare_resolve_relationships(lease_id, target_run_id, op_key, kind, propagate, now)

    try do
      case Infrastructure.transaction_with_busy_retry(fn ->
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

                         maybe_trigger_run_relationship!(
                           relationship,
                           target_run,
                           now,
                           prepared_relationships
                         )

                         AgentKernel.relationship_from_row(
                           AgentKernel.get_run_relationship_by_id(relationship["id"])
                         )
                     end
                 end
             end
           end) do
        {:ok, result} ->
          result

        {:error, :stale_cancellation_plan} when attempts_left > 1 ->
          resolve_run_relationship_with_prepared_payload_retry(
            lease_id,
            target_run_id,
            op_key,
            kind,
            propagate,
            attempts_left - 1
          )

        {:error, error} ->
          unwrap_transaction_result({:error, error})
      end
    after
      discard_prepared_linked_exit_cancellations(prepared_relationships)
    end
  end

  def maybe_trigger_run_relationship!(
        relationship,
        target_run,
        now,
        prepared_relationships \\ nil
      ) do
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
              relationship_queues_exit?(relationship, target_run, owner_run) ->
                queue_exit_event!(
                  owner_run["id"],
                  relationship["id"],
                  event,
                  now,
                  prepared_queued_exit_event_plan!(
                    prepared_relationship_event_plan!(prepared_relationships, relationship)
                  )
                )

              linked_exit_cancels_owner?(relationship, target_run, owner_run) ->
                propagate_linked_exit!(
                  owner_run,
                  target_run,
                  event,
                  now,
                  prepared_linked_exit_event_plan!(
                    prepared_relationship_event_plan!(prepared_relationships, relationship)
                  ),
                  prepared_linked_exit_plan!(prepared_relationships, owner_run)
                )

              true ->
                :ok
            end
          end
      end
    end
  end

  def queue_exit_event!(run_id, relationship_id, event, now, prepared_event_plan \\ nil) do
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
      append_exit_notified_event!(run_id, event, now, prepared_event_plan)

      prepared_delivery =
        case prepared_event_plan do
          nil -> :inline
          %{kind: :queued_exit} -> Map.get(prepared_event_plan, :exit_wait_satisfied_event)
        end

      deliver_oldest_pending_exit_event!(run_id, now, prepared_delivery)
    else
      :ok
    end
  end

  def deliver_oldest_pending_exit_event!(run_id, now, prepared_event \\ :inline) do
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

        append_exit_wait_satisfied_event!(
          run_id,
          %{
            "kind" => "exit",
            "key" => wait["op_key"],
            "event" => decode_json_value(event["event_json"], %{})
          },
          now,
          prepared_event,
          event,
          wait
        )

        {:delivered, get_run_wait(run_id, wait["op_key"])}
    end
  end

  def propagate_linked_exit!(
        owner_run,
        target_run,
        event,
        now,
        prepared_event_plan \\ nil,
        prepared_linked_exit_plan \\ nil
      ) do
    error_body = linked_exit_error(target_run, event)
    body = linked_exit_propagated_body(target_run, error_body)

    if prepared_event_plan && Map.get(prepared_event_plan, :error) != error_body do
      Repo.rollback(:stale_cancellation_plan)
    end

    append_linked_exit_propagated_event!(owner_run["id"], body, now, prepared_event_plan)

    case owner_run["definitionKind"] do
      "service" ->
        VilanoKernel.Storage.FailureRecovery.stop_service_run_instance!(
          owner_run,
          error_body,
          "linked_exit",
          now,
          nil,
          prepared_linked_exit_service_stop!(prepared_linked_exit_plan)
        )

      _ ->
        _ =
          VilanoKernel.Storage.FailureRecovery.cancel_workflow_run_instance!(
            owner_run,
            error_body,
            "linked_exit",
            now,
            prepared_linked_exit_cancellation!(prepared_linked_exit_plan)
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
