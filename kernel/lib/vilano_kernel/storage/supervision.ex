defmodule VilanoKernel.Storage.Supervision do
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

  def resolve_supervision_group(
        lease_id,
        op_key,
        strategy,
        max_restarts,
        window_ms,
        on_exhausted
      ) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        owner_run ->
          case AgentKernel.get_run_supervision_group(owner_run["id"], op_key) do
            nil ->
              RunControl.ensure_fenced_run_ownership!(owner_run["id"], lease_id, now)
              group_id = "supg_" <> Ecto.UUID.generate()

              SQL.query!(
                Repo,
                """
                insert into run_supervision_groups (
                  id,
                  owner_run_id,
                  op_key,
                  strategy,
                  max_restarts,
                  window_ms,
                  on_exhausted,
                  status,
                  created_at,
                  updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
                """,
                [
                  group_id,
                  owner_run["id"],
                  op_key,
                  strategy,
                  max_restarts,
                  window_ms,
                  on_exhausted,
                  now,
                  now
                ]
              )

              append_event!(
                owner_run["id"],
                "SupervisionGroupRegistered",
                %{
                  "groupId" => group_id,
                  "key" => op_key,
                  "strategy" => strategy,
                  "maxRestarts" => max_restarts,
                  "windowMs" => window_ms,
                  "onExhausted" => on_exhausted
                },
                now
              )

              AgentKernel.supervision_group_from_row(
                AgentKernel.get_run_supervision_group_by_id(group_id)
              )

            group ->
              AgentKernel.supervision_group_from_row(group)
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_supervised_spawn(lease_id, group_id, definition_name, member_key, input) do
    now = Infrastructure.now_iso8601()
    input = input || %{}

    run_started_event =
      prepare_supervised_spawn_run_started_event(
        lease_id,
        group_id,
        definition_name,
        member_key,
        input
      )

    try do
      Infrastructure.transaction_with_busy_retry(fn ->
        case RunControl.get_fenced_run_by_lease(lease_id, now) do
          nil ->
            nil

          owner_run ->
            case AgentKernel.get_run_supervision_group_for_owner(owner_run["id"], group_id) do
              nil ->
                nil

              group ->
                if group["status"] != "active" do
                  nil
                else
                  case AgentKernel.get_run_supervision_member(group_id, member_key) do
                    nil when is_nil(run_started_event) ->
                      nil

                    nil ->
                      RunControl.ensure_fenced_run_ownership!(owner_run["id"], lease_id, now)

                      definition =
                        owner_run
                        |> project_definitions_for_run()
                        |> definition_from_project_definitions!("workflow", definition_name)

                      member =
                        create_supervision_member_generation!(
                          owner_run,
                          group,
                          member_key,
                          definition,
                          input,
                          1,
                          now,
                          "SupervisionMemberSpawned",
                          run_started_event
                        )

                      AgentKernel.supervision_member_runtime_state(
                        member,
                        &VilanoKernel.Storage.get_run/1
                      )

                    member ->
                      AgentKernel.supervision_member_runtime_state(
                        member,
                        &VilanoKernel.Storage.get_run/1
                      )
                  end
                end
            end
        end
      end)
      |> unwrap_transaction_result()
    after
      discard_prepared_payload(run_started_event)
    end
  end

  defp prepare_supervised_spawn_run_started_event(
         lease_id,
         group_id,
         definition_name,
         member_key,
         input
       ) do
    now = Infrastructure.now_iso8601()

    Infrastructure.run_with_busy_retry(
      fn ->
        case RunControl.get_fenced_run_by_lease(lease_id, now) do
          nil ->
            nil

          owner_run ->
            with %{"status" => "active"} <-
                   AgentKernel.get_run_supervision_group_for_owner(owner_run["id"], group_id),
                 nil <- AgentKernel.get_run_supervision_member(group_id, member_key) do
              definition =
                owner_run
                |> project_definitions_for_run()
                |> definition_from_project_definitions!("workflow", definition_name)

              SqlSupport.prepare_workflow_run_started_event!(
                project_record_for_run(owner_run),
                definition,
                input
              )
            else
              _ -> nil
            end
        end
      end,
      :public_read
    )
  end

  defp discard_prepared_payload(nil), do: :ok
  defp discard_prepared_payload(storage), do: EventPayloads.discard_prepared_payload!(storage)

  def resolve_supervision_member_result_wait(lease_id, group_id, member_key, op_key) do
    now = Infrastructure.now_iso8601()
    wait_name = AgentKernel.supervision_member_wait_name(group_id, member_key)

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        owner_run ->
          case supervision_member_result_state(owner_run["id"], group_id, member_key) do
            nil ->
              nil

            {:completed, output} ->
              %{"status" => "completed", "output" => output}

            {:failed, error} ->
              %{"status" => "failed", "error" => error}

            :waiting ->
              existing = get_run_wait(owner_run["id"], op_key)

              if existing && existing["status"] == "waiting" do
                %{
                  "status" => "suspended",
                  "wait" => %{
                    "runId" => owner_run["id"],
                    "key" => op_key,
                    "kind" => "supervision_member_result",
                    "name" => wait_name,
                    "status" => "waiting",
                    "wakeAt" => nil,
                    "output" => nil
                  }
                }
              else
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
                  ) values (?, ?, 'supervision_member_result', ?, 'waiting', null, null, ?, ?)
                  on conflict(run_id, op_key) do update set
                    wait_kind = excluded.wait_kind,
                    wait_name = excluded.wait_name,
                    status = 'waiting',
                    wake_at = null,
                    output_json = null,
                    updated_at = excluded.updated_at
                  """,
                  [owner_run["id"], op_key, wait_name, now, now]
                )

                run_storage_test_hook(:supervision_member_wait_registered, %{
                  "runId" => owner_run["id"],
                  "groupId" => group_id,
                  "memberKey" => member_key,
                  "waitKey" => op_key,
                  "leaseId" => lease_id
                })

                case supervision_member_result_state(owner_run["id"], group_id, member_key) do
                  {:completed, output} ->
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
                      [Jason.encode!(output), now, owner_run["id"], op_key]
                    )

                    %{
                      "status" => "completed",
                      "wait" => wait_from_row(get_run_wait(owner_run["id"], op_key)),
                      "output" => output
                    }

                  {:failed, error} ->
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
                      [Jason.encode!(error), now, owner_run["id"], op_key]
                    )

                    %{
                      "status" => "failed",
                      "wait" => wait_from_row(get_run_wait(owner_run["id"], op_key)),
                      "error" => error
                    }

                  :waiting ->
                    RunControl.ensure_fenced_run_write!(
                      owner_run["id"],
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
                      [now, owner_run["id"]]
                    )

                    append_event!(
                      owner_run["id"],
                      "WaitRegistered",
                      %{
                        "kind" => "supervision_member_result",
                        "key" => op_key,
                        "groupId" => group_id,
                        "memberKey" => member_key
                      },
                      now
                    )

                    append_event!(
                      owner_run["id"],
                      "RunSuspended",
                      %{
                        "reason" => "supervision_member_result",
                        "key" => op_key,
                        "groupId" => group_id,
                        "memberKey" => member_key
                      },
                      now
                    )

                    maybe_append_service_turn_waiting!(
                      owner_run,
                      %{
                        "waitKind" => "supervision_member_result",
                        "key" => op_key,
                        "name" => wait_name
                      },
                      now
                    )

                    %{
                      "status" => "suspended",
                      "wait" => %{
                        "runId" => owner_run["id"],
                        "key" => op_key,
                        "kind" => "supervision_member_result",
                        "name" => wait_name,
                        "status" => "waiting",
                        "wakeAt" => nil,
                        "output" => nil
                      }
                    }
                end
              end
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def get_supervision_member_status(lease_id, group_id, member_key) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        owner_run ->
          case AgentKernel.get_run_supervision_group_for_owner(owner_run["id"], group_id) do
            nil ->
              nil

            _group ->
              AgentKernel.get_run_supervision_member(group_id, member_key)
              |> AgentKernel.supervision_member_runtime_state(&VilanoKernel.Storage.get_run/1)
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def list_supervision_members(lease_id, group_id) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        owner_run ->
          case AgentKernel.get_run_supervision_group_for_owner(owner_run["id"], group_id) do
            nil ->
              nil

            _group ->
              group_id
              |> AgentKernel.list_run_supervision_members()
              |> Enum.map(fn member ->
                AgentKernel.supervision_member_runtime_state(
                  member,
                  &VilanoKernel.Storage.get_run/1
                )
              end)
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def maybe_apply_supervision_for_terminal_run!(
        run_id,
        now,
        restart_events \\ nil,
        sibling_cancellations \\ nil,
        terminal_supervision_events \\ nil
      ) do
    case AgentKernel.get_run_supervision_member_by_child(run_id) do
      nil ->
        :ok

      member ->
        case {AgentKernel.get_run_supervision_group_by_id(member["group_id"]),
              VilanoKernel.Storage.get_run(run_id)} do
          {nil, _} ->
            :ok

          {_, nil} ->
            :ok

          {group, child_run} ->
            case VilanoKernel.Storage.get_run_for_inspect(group["owner_run_id"]) do
              nil ->
                :ok

              owner_run ->
                if group["status"] != "active" or
                     VilanoKernel.Storage.FailureRecovery.terminal_run_status?(
                       owner_run["status"]
                     ) or
                     member["current_child_run_id"] != run_id or
                     not VilanoKernel.Storage.FailureRecovery.terminal_run_status?(
                       child_run["status"]
                     ) do
                  :ok
                else
                  apply_supervision_policy!(
                    owner_run,
                    group,
                    member,
                    child_run,
                    now,
                    restart_events,
                    sibling_cancellations,
                    terminal_supervision_events
                  )
                end
            end
        end
    end
  end

  def prepare_terminal_restart_run_started_events(run_id, terminal_status, now) do
    Infrastructure.run_with_busy_retry(
      fn -> do_prepare_terminal_restart_run_started_events(run_id, terminal_status, now) end,
      :public_read
    )
  end

  def discard_prepared_restart_events(nil), do: :ok

  def discard_prepared_restart_events(prepared_events) when is_map(prepared_events) do
    prepared_events
    |> Map.values()
    |> Enum.each(&discard_prepared_restart_event/1)
  end

  defp discard_prepared_restart_event(%{
         run_started_event: run_started_event,
         member_event: member_event
       }) do
    discard_prepared_payload(run_started_event)
    discard_prepared_payload(member_event)
  end

  defp discard_prepared_restart_event(prepared_event),
    do: discard_prepared_payload(prepared_event)

  def prepare_terminal_sibling_cancellations(
        run_id,
        terminal_status,
        now,
        visited_run_ids \\ MapSet.new()
      ) do
    Infrastructure.run_with_busy_retry(
      fn ->
        do_prepare_terminal_sibling_cancellations(
          run_id,
          terminal_status,
          now,
          MapSet.put(visited_run_ids, run_id)
        )
      end,
      :public_read
    )
  end

  def discard_prepared_sibling_cancellations(nil), do: :ok

  def discard_prepared_sibling_cancellations(prepared_cancellations)
      when is_map(prepared_cancellations) do
    prepared_cancellations
    |> Map.values()
    |> Enum.each(&VilanoKernel.Storage.FailureRecovery.discard_prepared_workflow_cancellation/1)
  end

  def prepare_terminal_supervision_events(
        run_id,
        terminal_status,
        payload,
        now,
        visited_run_ids \\ MapSet.new()
      ) do
    Infrastructure.run_with_busy_retry(
      fn ->
        do_prepare_terminal_supervision_events(
          run_id,
          terminal_status,
          payload,
          now,
          MapSet.put(visited_run_ids, run_id)
        )
      end,
      :public_read
    )
  end

  def discard_prepared_terminal_supervision_events(nil), do: :ok

  def discard_prepared_terminal_supervision_events(prepared_events)
      when is_map(prepared_events) do
    prepared_events
    |> Map.get(:member_completed_event)
    |> discard_prepared_payload()

    prepared_events
    |> Map.get(:member_result_wait_events, %{})
    |> discard_prepared_wait_events()

    prepared_events
    |> Map.get(:group_exhausted_event)
    |> discard_prepared_payload()

    prepared_events
    |> Map.get(:owner_terminal)
    |> discard_prepared_owner_terminal()
  end

  defp do_prepare_terminal_restart_run_started_events(run_id, terminal_status, now) do
    with member when not is_nil(member) <-
           AgentKernel.get_run_supervision_member_by_child(run_id),
         group when not is_nil(group) <-
           AgentKernel.get_run_supervision_group_by_id(member["group_id"]),
         child_run when not is_nil(child_run) <- VilanoKernel.Storage.get_run(run_id),
         owner_run when not is_nil(owner_run) <-
           VilanoKernel.Storage.get_run_for_inspect(group["owner_run_id"]) do
      cond do
        group["status"] != "active" ->
          %{}

        VilanoKernel.Storage.FailureRecovery.terminal_run_status?(owner_run["status"]) ->
          %{}

        member["current_child_run_id"] != run_id ->
          %{}

        not AgentKernel.abnormal_terminal_status?(terminal_status) ->
          %{}

        not supervision_restart_allowed?(group, now) ->
          %{}

        group["strategy"] == "one_for_all" ->
          members =
            group["id"]
            |> AgentKernel.list_run_supervision_members()
            |> Enum.filter(&member_selected_for_one_for_all_restart?(&1, member))

          prepared_events = prepare_restart_events_for_members(members, owner_run)

          try do
            Map.put(
              prepared_events,
              :group_restarting_event,
              EventPayloads.prepare_body_for_storage!(
                supervision_group_restarting_body(group, member, child_run, members)
              )
            )
          rescue
            error ->
              discard_prepared_restart_events(prepared_events)
              reraise error, __STACKTRACE__
          end

        true ->
          prepare_restart_events_for_members([member], owner_run)
      end
    else
      _ -> %{}
    end
  end

  defp do_prepare_terminal_sibling_cancellations(
         run_id,
         terminal_status,
         now,
         visited_run_ids
       ) do
    with member when not is_nil(member) <-
           AgentKernel.get_run_supervision_member_by_child(run_id),
         group when not is_nil(group) <-
           AgentKernel.get_run_supervision_group_by_id(member["group_id"]),
         child_run when not is_nil(child_run) <- VilanoKernel.Storage.get_run(run_id),
         owner_run when not is_nil(owner_run) <-
           VilanoKernel.Storage.get_run_for_inspect(group["owner_run_id"]) do
      terminal_child_run = Map.put(child_run, "status", terminal_status)

      cond do
        group["status"] != "active" ->
          %{}

        VilanoKernel.Storage.FailureRecovery.terminal_run_status?(owner_run["status"]) ->
          %{}

        member["current_child_run_id"] != run_id ->
          %{}

        not AgentKernel.abnormal_terminal_status?(terminal_status) ->
          %{}

        supervision_restart_allowed?(group, now) and group["strategy"] == "one_for_all" ->
          error_body = supervision_restart_error(group, member, terminal_child_run)

          group["id"]
          |> AgentKernel.list_run_supervision_members()
          |> Enum.filter(&member_selected_for_one_for_all_restart?(&1, member))
          |> prepare_sibling_cancellations_for_members(
            member,
            error_body,
            "supervision_restart",
            now,
            visited_run_ids
          )

        supervision_restart_allowed?(group, now) ->
          %{}

        true ->
          error_body = supervision_exhausted_error(group, member, terminal_child_run)

          group["id"]
          |> AgentKernel.list_run_supervision_members()
          |> prepare_sibling_cancellations_for_members(
            member,
            error_body,
            "supervision_exhausted",
            now,
            visited_run_ids
          )
      end
    else
      _ -> %{}
    end
  end

  defp do_prepare_terminal_supervision_events(
         run_id,
         terminal_status,
         payload,
         now,
         visited_run_ids
       ) do
    with member when not is_nil(member) <-
           AgentKernel.get_run_supervision_member_by_child(run_id),
         group when not is_nil(group) <-
           AgentKernel.get_run_supervision_group_by_id(member["group_id"]),
         child_run when not is_nil(child_run) <- VilanoKernel.Storage.get_run(run_id),
         owner_run when not is_nil(owner_run) <-
           VilanoKernel.Storage.get_run_for_inspect(group["owner_run_id"]) do
      terminal_child_run =
        child_run
        |> Map.put("status", terminal_status)
        |> put_terminal_payload(terminal_status, payload)

      cond do
        group["status"] != "active" ->
          %{}

        VilanoKernel.Storage.FailureRecovery.terminal_run_status?(owner_run["status"]) ->
          %{}

        member["current_child_run_id"] != run_id ->
          %{}

        terminal_status == "completed" ->
          prepare_completed_supervision_events!(group, member, terminal_child_run, payload)

        not AgentKernel.abnormal_terminal_status?(terminal_status) ->
          %{}

        supervision_restart_allowed?(group, now) ->
          %{}

        true ->
          prepare_exhausted_supervision_events!(
            group,
            member,
            terminal_child_run,
            owner_run,
            now,
            visited_run_ids
          )
      end
    else
      _ -> %{}
    end
  end

  defp prepare_completed_supervision_events!(group, member, child_run, payload) do
    member_completed_event =
      EventPayloads.prepare_body_for_storage!(
        supervision_member_completed_body(group, member, child_run, payload)
      )

    try do
      %{
        member_completed_event: member_completed_event,
        member_result_wait_events:
          prepare_supervision_member_result_wait_events(
            group["id"],
            member["member_key"],
            "completed",
            payload
          )
      }
    rescue
      error ->
        discard_prepared_payload(member_completed_event)
        reraise error, __STACKTRACE__
    end
  end

  defp prepare_exhausted_supervision_events!(
         group,
         member,
         child_run,
         owner_run,
         now,
         visited_run_ids
       ) do
    error_body = supervision_exhausted_error(group, member, child_run)

    group_exhausted_event =
      EventPayloads.prepare_body_for_storage!(
        supervision_group_exhausted_body(group, member, child_run, error_body)
      )

    try do
      %{
        group_exhausted_event: group_exhausted_event,
        owner_terminal:
          prepare_owner_terminal_event(group, owner_run, error_body, now, visited_run_ids)
      }
    rescue
      error ->
        discard_prepared_payload(group_exhausted_event)
        reraise error, __STACKTRACE__
    end
  end

  defp prepare_owner_terminal_event(
         %{"on_exhausted" => "fail_self"},
         owner_run,
         error_body,
         now,
         visited_run_ids
       ) do
    next_visited_run_ids = MapSet.put(visited_run_ids, owner_run["id"])

    case owner_run["definitionKind"] do
      "service" ->
        %{
          kind: :service_stop,
          prepared:
            VilanoKernel.Storage.FailureRecovery.ServiceFailure.prepare_service_stop!(
              owner_run,
              error_body,
              "supervision_exhausted",
              now,
              next_visited_run_ids
            )
        }

      _ ->
        %{
          kind: :workflow_failure,
          prepared:
            VilanoKernel.Storage.FailureRecovery.WorkflowFailure.prepare_workflow_failure!(
              owner_run,
              error_body,
              now,
              next_visited_run_ids
            )
        }
    end
  end

  defp prepare_owner_terminal_event(_group, _owner_run, _error_body, _now, _visited_run_ids),
    do: nil

  defp prepare_sibling_cancellations_for_members(
         members,
         triggering_member,
         error_body,
         reason,
         now,
         visited_run_ids
       ) do
    do_prepare_sibling_cancellations_for_members(
      members,
      triggering_member,
      error_body,
      reason,
      now,
      visited_run_ids,
      %{}
    )
  end

  defp do_prepare_sibling_cancellations_for_members(
         [],
         _triggering_member,
         _error_body,
         _reason,
         _now,
         _visited_run_ids,
         prepared_cancellations
       ),
       do: prepared_cancellations

  defp do_prepare_sibling_cancellations_for_members(
         [member | rest],
         triggering_member,
         error_body,
         reason,
         now,
         visited_run_ids,
         prepared_cancellations
       ) do
    try do
      next_prepared_cancellations =
        if member["member_key"] == triggering_member["member_key"] or
             not is_binary(member["current_child_run_id"]) do
          prepared_cancellations
        else
          case VilanoKernel.Storage.get_run(member["current_child_run_id"]) do
            nil ->
              prepared_cancellations

            sibling_run ->
              if VilanoKernel.Storage.FailureRecovery.terminal_run_status?(sibling_run["status"]) or
                   MapSet.member?(visited_run_ids, sibling_run["id"]) do
                prepared_cancellations
              else
                Map.put(
                  prepared_cancellations,
                  sibling_run["id"],
                  VilanoKernel.Storage.FailureRecovery.WorkflowFailure.prepare_workflow_cancellation!(
                    sibling_run,
                    error_body,
                    reason,
                    now,
                    MapSet.put(visited_run_ids, sibling_run["id"])
                  )
                )
              end
          end
        end

      do_prepare_sibling_cancellations_for_members(
        rest,
        triggering_member,
        error_body,
        reason,
        now,
        visited_run_ids,
        next_prepared_cancellations
      )
    rescue
      error ->
        discard_prepared_sibling_cancellations(prepared_cancellations)
        reraise error, __STACKTRACE__
    end
  end

  defp prepare_restart_events_for_members(members, owner_run) do
    do_prepare_restart_events_for_members(members, owner_run, %{})
  end

  defp do_prepare_restart_events_for_members([], _owner_run, prepared_events), do: prepared_events

  defp do_prepare_restart_events_for_members([member | rest], owner_run, prepared_events) do
    try do
      definition =
        owner_run
        |> project_definitions_for_run()
        |> definition_from_project_definitions!("workflow", member["definition_name"])

      input = decode_json_value(member["input_json"], %{})
      generation = member["generation"] + 1
      child_run_id = "run_" <> Ecto.UUID.generate()

      run_started_event =
        SqlSupport.prepare_workflow_run_started_event!(
          project_record_for_run(owner_run),
          definition,
          input
        )

      member_event =
        try do
          EventPayloads.prepare_body_for_storage!(
            supervision_member_generation_body(
              member["group_id"],
              member["member_key"],
              generation,
              child_run_id,
              definition,
              input
            )
          )
        rescue
          error ->
            discard_prepared_payload(run_started_event)
            reraise error, __STACKTRACE__
        end

      do_prepare_restart_events_for_members(
        rest,
        owner_run,
        Map.put(prepared_events, member["member_key"], %{
          child_run_id: child_run_id,
          current_child_run_id: member["current_child_run_id"],
          definition_name: member["definition_name"],
          generation: generation,
          group_id: member["group_id"],
          input_json: member["input_json"],
          member_key: member["member_key"],
          run_started_event: run_started_event,
          member_event: member_event
        })
      )
    rescue
      exception ->
        discard_prepared_restart_events(prepared_events)
        reraise exception, __STACKTRACE__
    end
  end

  def create_supervision_member_generation!(
        owner_run,
        group,
        member_key,
        definition,
        input,
        generation,
        now,
        event_type
      ) do
    run_started_event =
      SqlSupport.prepare_workflow_run_started_event!(
        project_record_for_run(owner_run),
        definition,
        input || %{}
      )

    try do
      create_supervision_member_generation!(
        owner_run,
        group,
        member_key,
        definition,
        input,
        generation,
        now,
        event_type,
        run_started_event
      )
    after
      EventPayloads.discard_prepared_payload!(run_started_event)
    end
  end

  def create_supervision_member_generation!(
        owner_run,
        group,
        member_key,
        definition,
        input,
        generation,
        now,
        event_type,
        run_started_event
      ) do
    child_run_id = prepared_restart_child_run_id(run_started_event)
    run_started_payload = prepared_restart_run_started_event(run_started_event)

    SqlSupport.insert_workflow_run!(
      child_run_id,
      project_record_for_run(owner_run),
      definition,
      input || %{},
      now,
      run_started_payload
    )

    SQL.query!(
      Repo,
      """
      insert into run_children (
        parent_run_id,
        op_key,
        child_run_id,
        definition_name,
        status,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, 'pending', ?, ?)
      """,
      [
        owner_run["id"],
        supervised_child_op_key(group["id"], member_key, generation),
        child_run_id,
        Map.fetch!(definition, "name"),
        now,
        now
      ]
    )

    encoded_input = Jason.encode!(input || %{})

    case AgentKernel.get_run_supervision_member(group["id"], member_key) do
      nil ->
        SQL.query!(
          Repo,
          """
          insert into run_supervision_members (
            group_id,
            member_key,
            definition_name,
            input_json,
            current_child_run_id,
            generation,
            status,
            created_at,
            updated_at
          ) values (?, ?, ?, ?, ?, ?, 'active', ?, ?)
          """,
          [
            group["id"],
            member_key,
            Map.fetch!(definition, "name"),
            encoded_input,
            child_run_id,
            generation,
            now,
            now
          ]
        )

      _member ->
        SQL.query!(
          Repo,
          """
          update run_supervision_members
          set
            definition_name = ?,
            input_json = ?,
            current_child_run_id = ?,
            generation = ?,
            status = 'active',
            updated_at = ?
          where group_id = ? and member_key = ?
          """,
          [
            Map.fetch!(definition, "name"),
            encoded_input,
            child_run_id,
            generation,
            now,
            group["id"],
            member_key
          ]
        )
    end

    append_supervision_member_generation_event!(
      owner_run["id"],
      event_type,
      supervision_member_generation_body(
        group["id"],
        member_key,
        generation,
        child_run_id,
        definition,
        input
      ),
      now,
      prepared_restart_member_event(run_started_event)
    )

    AgentKernel.get_run_supervision_member(group["id"], member_key)
  end

  defp supervision_member_generation_body(
         group_id,
         member_key,
         generation,
         child_run_id,
         definition,
         input
       ) do
    %{
      "groupId" => group_id,
      "memberKey" => member_key,
      "generation" => generation,
      "childRunId" => child_run_id,
      "definitionName" => Map.fetch!(definition, "name"),
      "input" => input || %{}
    }
  end

  defp prepared_restart_child_run_id(%{child_run_id: child_run_id}), do: child_run_id
  defp prepared_restart_child_run_id(_prepared_event), do: "run_" <> Ecto.UUID.generate()

  defp prepared_restart_run_started_event(%{run_started_event: run_started_event}),
    do: run_started_event

  defp prepared_restart_run_started_event(run_started_event), do: run_started_event

  defp prepared_restart_member_event(%{member_event: member_event}), do: member_event
  defp prepared_restart_member_event(_prepared_event), do: nil

  defp append_supervision_member_generation_event!(run_id, event_type, body, now, nil) do
    append_event!(run_id, event_type, body, now)
  end

  defp append_supervision_member_generation_event!(
         run_id,
         event_type,
         _body,
         now,
         prepared_event
       ) do
    SqlSupport.append_prepared_event!(run_id, event_type, prepared_event, now)
  end

  def supervised_child_op_key(group_id, member_key, generation) do
    "supervision:" <> group_id <> ":" <> member_key <> ":" <> Integer.to_string(generation)
  end

  def supervision_member_result_state(owner_run_id, group_id, member_key) do
    case AgentKernel.get_run_supervision_group_for_owner(owner_run_id, group_id) do
      nil ->
        nil

      _group ->
        case AgentKernel.get_run_supervision_member(group_id, member_key) do
          nil ->
            nil

          member ->
            child_run =
              if is_binary(member["current_child_run_id"]) do
                VilanoKernel.Storage.get_run(member["current_child_run_id"])
              else
                nil
              end

            cond do
              is_map(child_run) and child_run["status"] == "completed" ->
                {:completed, child_run["output"]}

              is_map(child_run) and child_run["status"] in ["failed", "cancelled"] and
                  member["status"] in ["failed", "exhausted"] ->
                {:failed, child_run["error"]}

              member["status"] == "completed" ->
                {:completed, nil}

              member["status"] in ["failed", "exhausted"] ->
                {:failed,
                 %{
                   "name" => "SupervisionMemberFailed",
                   "message" => "Supervised member '#{member_key}' failed",
                   "reason" => "supervision_member_failed",
                   "groupId" => group_id,
                   "memberKey" => member_key
                 }}

              true ->
                :waiting
            end
        end
    end
  end

  def apply_supervision_policy!(
        owner_run,
        group,
        member,
        child_run,
        now,
        restart_events \\ nil,
        sibling_cancellations \\ nil,
        terminal_supervision_events \\ nil
      ) do
    cond do
      child_run["status"] == "completed" ->
        SQL.query!(
          Repo,
          """
          update run_supervision_members
          set
            status = 'completed',
            updated_at = ?
          where group_id = ? and member_key = ?
          """,
          [now, group["id"], member["member_key"]]
        )

        member_completed_body =
          supervision_member_completed_body(group, member, child_run, child_run["output"])

        append_prepared_or_inline_event!(
          owner_run["id"],
          "SupervisionMemberCompleted",
          member_completed_body,
          now,
          prepared_terminal_supervision_event!(
            terminal_supervision_events,
            :member_completed_event
          )
        )

        wake_waiting_supervision_member_results!(
          group["id"],
          member["member_key"],
          "completed",
          child_run["output"],
          now,
          prepared_terminal_supervision_wait_events(terminal_supervision_events)
        )

      AgentKernel.abnormal_terminal_status?(child_run["status"]) and
          supervision_restart_allowed?(group, now) ->
        record_supervision_restart!(group["id"], member["member_key"], child_run["id"], now)

        case group["strategy"] do
          "one_for_all" ->
            restart_supervision_group_members!(
              owner_run,
              group,
              member,
              child_run,
              now,
              restart_events,
              sibling_cancellations
            )

          _ ->
            restart_supervision_member!(owner_run, group, member, now, restart_events)
        end

      AgentKernel.abnormal_terminal_status?(child_run["status"]) ->
        exhaust_supervision_group!(
          owner_run,
          group,
          member,
          child_run,
          now,
          sibling_cancellations,
          terminal_supervision_events
        )

      true ->
        :ok
    end
  end

  def supervision_restart_allowed?(group, now) do
    AgentKernel.count_recent_supervision_restarts(
      group["id"],
      shift_milliseconds(now, -group["window_ms"])
    ) < group["max_restarts"]
  end

  def record_supervision_restart!(group_id, member_key, child_run_id, now) do
    SQL.query!(
      Repo,
      """
      insert into run_supervision_restarts (
        id,
        group_id,
        member_key,
        child_run_id,
        created_at
      ) values (?, ?, ?, ?, ?)
      on conflict(child_run_id) do nothing
      """,
      ["supr_" <> Ecto.UUID.generate(), group_id, member_key, child_run_id, now]
    )

    :ok
  end

  def restart_supervision_member!(owner_run, group, member, now, restart_events \\ nil) do
    validate_prepared_restart_member_plan!(restart_events, member)

    SQL.query!(
      Repo,
      """
      update run_supervision_members
      set
        current_child_run_id = null,
        status = 'restarting',
        updated_at = ?
      where group_id = ? and member_key = ?
      """,
      [now, group["id"], member["member_key"]]
    )

    definition =
      owner_run
      |> project_definitions_for_run()
      |> definition_from_project_definitions!("workflow", member["definition_name"])

    create_generation =
      &create_supervision_member_generation!(
        owner_run,
        group,
        member["member_key"],
        definition,
        decode_json_value(member["input_json"], %{}),
        member["generation"] + 1,
        now,
        "SupervisionMemberRestarted",
        &1
      )

    _ =
      case prepared_restart_generation_event!(restart_events, member["member_key"]) do
        nil ->
          create_supervision_member_generation!(
            owner_run,
            group,
            member["member_key"],
            definition,
            decode_json_value(member["input_json"], %{}),
            member["generation"] + 1,
            now,
            "SupervisionMemberRestarted"
          )

        prepared_event ->
          create_generation.(prepared_event)
      end

    :ok
  end

  def restart_supervision_group_members!(
        owner_run,
        group,
        triggering_member,
        child_run,
        now,
        restart_events \\ nil,
        sibling_cancellations \\ nil
      ) do
    members =
      group["id"]
      |> AgentKernel.list_run_supervision_members()
      |> Enum.filter(&member_selected_for_one_for_all_restart?(&1, triggering_member))

    validate_prepared_restart_group_plan!(restart_events, members)

    Enum.each(members, fn member ->
      SQL.query!(
        Repo,
        """
        update run_supervision_members
        set
          current_child_run_id = null,
          status = 'restarting',
          updated_at = ?
        where group_id = ? and member_key = ?
        """,
        [now, group["id"], member["member_key"]]
      )
    end)

    append_prepared_or_inline_event!(
      owner_run["id"],
      "SupervisionGroupRestarting",
      supervision_group_restarting_body(group, triggering_member, child_run, members),
      now,
      prepared_group_restarting_event!(restart_events)
    )

    Enum.each(members, fn member ->
      if member["current_child_run_id"] != child_run["id"] and
           is_binary(member["current_child_run_id"]) do
        case VilanoKernel.Storage.get_run(member["current_child_run_id"]) do
          nil ->
            :ok

          sibling_run ->
            unless VilanoKernel.Storage.FailureRecovery.terminal_run_status?(
                     sibling_run["status"]
                   ) do
              _ =
                VilanoKernel.Storage.FailureRecovery.cancel_workflow_run_instance!(
                  sibling_run,
                  supervision_restart_error(group, triggering_member, child_run),
                  "supervision_restart",
                  now,
                  prepared_sibling_cancellation!(sibling_cancellations, sibling_run)
                )

              :ok
            end
        end
      end
    end)

    Enum.each(members, fn member ->
      definition =
        owner_run
        |> project_definitions_for_run()
        |> definition_from_project_definitions!("workflow", member["definition_name"])

      input = decode_json_value(member["input_json"], %{})

      _ =
        case prepared_restart_generation_event!(restart_events, member["member_key"]) do
          nil ->
            create_supervision_member_generation!(
              owner_run,
              group,
              member["member_key"],
              definition,
              input,
              member["generation"] + 1,
              now,
              "SupervisionMemberRestarted"
            )

          prepared_event ->
            create_supervision_member_generation!(
              owner_run,
              group,
              member["member_key"],
              definition,
              input,
              member["generation"] + 1,
              now,
              "SupervisionMemberRestarted",
              prepared_event
            )
        end

      :ok
    end)

    :ok
  end

  def member_selected_for_one_for_all_restart?(member, triggering_member) do
    member["member_key"] == triggering_member["member_key"] or
      (is_binary(member["current_child_run_id"]) and
         case VilanoKernel.Storage.get_run(member["current_child_run_id"]) do
           nil ->
             false

           child_run ->
             not VilanoKernel.Storage.FailureRecovery.terminal_run_status?(child_run["status"])
         end)
  end

  defp supervision_group_restarting_body(group, triggering_member, child_run, members) do
    %{
      "groupId" => group["id"],
      "strategy" => group["strategy"],
      "triggeringMemberKey" => triggering_member["member_key"],
      "triggeringChildRunId" => child_run["id"],
      "memberKeys" => Enum.map(members, & &1["member_key"])
    }
  end

  defp prepared_restart_generation_event!(nil, _member_key), do: nil

  defp prepared_restart_generation_event!(restart_events, member_key)
       when is_map(restart_events) do
    case Map.fetch(restart_events, member_key) do
      {:ok, prepared_event} -> prepared_event
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_group_restarting_event!(nil), do: nil

  defp prepared_group_restarting_event!(restart_events) when is_map(restart_events) do
    case Map.fetch(restart_events, :group_restarting_event) do
      {:ok, prepared_event} -> prepared_event
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp validate_prepared_restart_member_plan!(nil, _member), do: :ok

  defp validate_prepared_restart_member_plan!(restart_events, member)
       when is_map(restart_events) do
    if Map.has_key?(restart_events, :group_restarting_event) do
      Repo.rollback(:stale_cancellation_plan)
    end

    validate_prepared_restart_members!(restart_events, [member])
  end

  defp validate_prepared_restart_group_plan!(nil, _members), do: :ok

  defp validate_prepared_restart_group_plan!(restart_events, members)
       when is_map(restart_events) do
    unless Map.has_key?(restart_events, :group_restarting_event) do
      Repo.rollback(:stale_cancellation_plan)
    end

    validate_prepared_restart_members!(restart_events, members)
  end

  defp validate_prepared_restart_members!(restart_events, members) do
    prepared_keys =
      restart_events
      |> Map.keys()
      |> Enum.reject(&(&1 == :group_restarting_event))
      |> Enum.map(&prepared_restart_member_key!/1)
      |> Enum.sort()

    member_keys =
      members
      |> Enum.map(& &1["member_key"])
      |> Enum.sort()

    if prepared_keys == member_keys do
      Enum.each(members, fn member ->
        restart_events
        |> prepared_restart_generation_event!(member["member_key"])
        |> validate_prepared_restart_generation!(member)
      end)
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_restart_member_key!(member_key) when is_binary(member_key), do: member_key
  defp prepared_restart_member_key!(_member_key), do: Repo.rollback(:stale_cancellation_plan)

  defp validate_prepared_restart_generation!(
         %{
           current_child_run_id: current_child_run_id,
           definition_name: definition_name,
           generation: generation,
           group_id: group_id,
           input_json: input_json,
           member_key: member_key
         },
         member
       ) do
    if current_child_run_id == member["current_child_run_id"] and
         definition_name == member["definition_name"] and
         generation == member["generation"] + 1 and
         group_id == member["group_id"] and
         input_json == member["input_json"] and
         member_key == member["member_key"] do
      :ok
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp validate_prepared_restart_generation!(_prepared_event, _member),
    do: Repo.rollback(:stale_cancellation_plan)

  defp prepared_sibling_cancellation!(nil, _run), do: nil

  defp prepared_sibling_cancellation!(prepared_cancellations, run)
       when is_map(prepared_cancellations) do
    case Map.fetch(prepared_cancellations, run["id"]) do
      {:ok, prepared_cancellation} -> prepared_cancellation
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  def exhaust_supervision_group!(
        owner_run,
        group,
        member,
        child_run,
        now,
        sibling_cancellations \\ nil,
        terminal_supervision_events \\ nil
      ) do
    error_body = supervision_exhausted_error(group, member, child_run)
    group_exhausted_body = supervision_group_exhausted_body(group, member, child_run, error_body)

    SQL.query!(
      Repo,
      """
      update run_supervision_groups
      set
        status = 'exhausted',
        updated_at = ?
      where id = ?
      """,
      [now, group["id"]]
    )

    SQL.query!(
      Repo,
      """
      update run_supervision_members
      set
        status = 'exhausted',
        updated_at = ?
      where group_id = ?
      """,
      [now, group["id"]]
    )

    append_prepared_or_inline_event!(
      owner_run["id"],
      "SupervisionGroupExhausted",
      group_exhausted_body,
      now,
      prepared_terminal_supervision_event!(
        terminal_supervision_events,
        :group_exhausted_event
      )
    )

    Enum.each(AgentKernel.list_run_supervision_members(group["id"]), fn current_member ->
      if current_member["member_key"] != member["member_key"] and
           is_binary(current_member["current_child_run_id"]) do
        case VilanoKernel.Storage.get_run(current_member["current_child_run_id"]) do
          nil ->
            :ok

          open_child ->
            unless VilanoKernel.Storage.FailureRecovery.terminal_run_status?(open_child["status"]) do
              _ =
                VilanoKernel.Storage.FailureRecovery.cancel_workflow_run_instance!(
                  open_child,
                  error_body,
                  "supervision_exhausted",
                  now,
                  prepared_sibling_cancellation!(sibling_cancellations, open_child)
                )
            end
        end
      end
    end)

    case group["on_exhausted"] do
      "fail_self" ->
        prepared_owner_terminal =
          prepared_owner_terminal_event!(terminal_supervision_events, owner_run)

        case owner_run["definitionKind"] do
          "service" ->
            VilanoKernel.Storage.FailureRecovery.stop_service_run_instance!(
              owner_run,
              error_body,
              "supervision_exhausted",
              now,
              nil,
              prepared_owner_terminal
            )

          _ ->
            VilanoKernel.Storage.FailureRecovery.fail_workflow_run_instance!(
              owner_run,
              error_body,
              now,
              nil,
              prepared_owner_terminal
            )
        end

      _ ->
        :ok
    end
  end

  def supervision_restart_error(group, member, child_run) do
    %{
      "name" => "SupervisionRestartError",
      "message" =>
        "Supervision group '#{group["id"]}' restarted after member '#{member["member_key"]}' exited with status #{child_run["status"]}",
      "reason" => "supervision_restart",
      "groupId" => group["id"],
      "memberKey" => member["member_key"],
      "childRunId" => child_run["id"],
      "childStatus" => child_run["status"]
    }
  end

  def supervision_exhausted_error(group, member, child_run) do
    %{
      "name" => "SupervisionExhaustedError",
      "message" =>
        "Supervision group '#{group["id"]}' exhausted its restart budget after member '#{member["member_key"]}' exited with status #{child_run["status"]}",
      "reason" => "supervision_exhausted",
      "groupId" => group["id"],
      "strategy" => group["strategy"],
      "memberKey" => member["member_key"],
      "childRunId" => child_run["id"],
      "childStatus" => child_run["status"],
      "maxRestarts" => group["max_restarts"],
      "windowMs" => group["window_ms"]
    }
  end

  def wake_waiting_supervision_member_results!(
        group_id,
        member_key,
        result_status,
        payload,
        now,
        prepared_wait_events \\ nil
      ) do
    wait_name = AgentKernel.supervision_member_wait_name(group_id, member_key)
    waiting_rows = supervision_member_result_waiting_rows(wait_name)
    validate_prepared_wait_events!(prepared_wait_events, waiting_rows)

    Enum.each(waiting_rows, fn wait ->
      wait_row_status = if result_status == "completed", do: "completed", else: "failed"

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
        [wait_row_status, Jason.encode!(payload), now, wait["run_id"], wait["op_key"]]
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
          "kind" => "supervision_member_result",
          "key" => wait["op_key"],
          "groupId" => group_id,
          "memberKey" => member_key,
          "status" => result_status,
          "payload" => payload
        },
        now,
        prepared_wait_events,
        wait
      )
    end)
  end

  defp prepare_supervision_member_result_wait_events(
         group_id,
         member_key,
         result_status,
         payload
       ) do
    group_id
    |> AgentKernel.supervision_member_wait_name(member_key)
    |> supervision_member_result_waiting_rows()
    |> prepare_wait_satisfied_events(fn wait ->
      %{
        "kind" => "supervision_member_result",
        "key" => wait["op_key"],
        "groupId" => group_id,
        "memberKey" => member_key,
        "status" => result_status,
        "payload" => payload
      }
    end)
  end

  defp supervision_member_result_waiting_rows(wait_name) do
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
      where wait_kind = 'supervision_member_result' and wait_name = ? and status = 'waiting'
      """,
      [wait_name]
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
        discard_prepared_wait_events(acc)
        reraise error, __STACKTRACE__
    end
  end

  defp discard_prepared_wait_events(prepared_events) when is_map(prepared_events) do
    prepared_events
    |> Map.values()
    |> Enum.each(&discard_prepared_payload/1)
  end

  defp discard_prepared_wait_events(_prepared_events), do: :ok

  defp append_prepared_or_inline_event!(run_id, event_type, body, now, nil) do
    append_event!(run_id, event_type, body, now)
  end

  defp append_prepared_or_inline_event!(run_id, event_type, _body, now, prepared_event) do
    SqlSupport.append_prepared_event!(run_id, event_type, prepared_event, now)
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

  defp prepared_terminal_supervision_event!(nil, _field), do: nil

  defp prepared_terminal_supervision_event!(prepared_events, field) do
    case Map.fetch(prepared_events, field) do
      {:ok, nil} -> Repo.rollback(:stale_cancellation_plan)
      {:ok, prepared_event} -> prepared_event
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_terminal_supervision_wait_events(nil), do: nil

  defp prepared_terminal_supervision_wait_events(prepared_events) do
    Map.get(prepared_events, :member_result_wait_events, %{})
  end

  defp prepared_owner_terminal_event!(nil, _owner_run), do: nil

  defp prepared_owner_terminal_event!(prepared_events, %{"definitionKind" => "service"}) do
    case Map.get(prepared_events, :owner_terminal) do
      %{kind: :service_stop, prepared: prepared} -> prepared
      _ -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_owner_terminal_event!(prepared_events, _owner_run) do
    case Map.get(prepared_events, :owner_terminal) do
      %{kind: :workflow_failure, prepared: prepared} -> prepared
      _ -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp discard_prepared_owner_terminal(%{kind: :service_stop, prepared: prepared}) do
    VilanoKernel.Storage.FailureRecovery.ServiceFailure.discard_prepared_service_stop(prepared)
  end

  defp discard_prepared_owner_terminal(%{kind: :workflow_failure, prepared: prepared}) do
    VilanoKernel.Storage.FailureRecovery.WorkflowFailure.discard_prepared_workflow_failure(
      prepared
    )
  end

  defp discard_prepared_owner_terminal(_owner_terminal), do: :ok

  defp supervision_member_completed_body(group, member, child_run, output) do
    %{
      "groupId" => group["id"],
      "memberKey" => member["member_key"],
      "childRunId" => child_run["id"],
      "generation" => member["generation"],
      "output" => output
    }
  end

  defp supervision_group_exhausted_body(group, member, child_run, error_body) do
    %{
      "groupId" => group["id"],
      "strategy" => group["strategy"],
      "memberKey" => member["member_key"],
      "childRunId" => child_run["id"],
      "error" => error_body
    }
  end

  defp put_terminal_payload(run, "completed", payload), do: Map.put(run, "output", payload)
  defp put_terminal_payload(run, _terminal_status, payload), do: Map.put(run, "error", payload)

  defp prepared_wait_key(wait), do: wait["run_id"] <> ":" <> wait["op_key"]
end
