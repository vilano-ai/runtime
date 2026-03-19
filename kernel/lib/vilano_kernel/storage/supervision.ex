defmodule VilanoKernel.Storage.Supervision do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{AgentKernel, Infrastructure, RunControl, ServiceSupport, Support}

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
                        input || %{},
                        1,
                        now,
                        "SupervisionMemberSpawned"
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
  end

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

  def maybe_apply_supervision_for_terminal_run!(run_id, now) do
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
                  apply_supervision_policy!(owner_run, group, member, child_run, now)
                end
            end
        end
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
    child_run_id = "run_" <> Ecto.UUID.generate()

    insert_workflow_run!(
      child_run_id,
      project_record_for_run(owner_run),
      definition,
      input || %{},
      now
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

    append_event!(
      owner_run["id"],
      event_type,
      %{
        "groupId" => group["id"],
        "memberKey" => member_key,
        "generation" => generation,
        "childRunId" => child_run_id,
        "definitionName" => Map.fetch!(definition, "name"),
        "input" => input || %{}
      },
      now
    )

    AgentKernel.get_run_supervision_member(group["id"], member_key)
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

  def apply_supervision_policy!(owner_run, group, member, child_run, now) do
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

        append_event!(
          owner_run["id"],
          "SupervisionMemberCompleted",
          %{
            "groupId" => group["id"],
            "memberKey" => member["member_key"],
            "childRunId" => child_run["id"],
            "generation" => member["generation"],
            "output" => child_run["output"]
          },
          now
        )

        wake_waiting_supervision_member_results!(
          group["id"],
          member["member_key"],
          "completed",
          child_run["output"],
          now
        )

      AgentKernel.abnormal_terminal_status?(child_run["status"]) and
          supervision_restart_allowed?(group, now) ->
        record_supervision_restart!(group["id"], member["member_key"], child_run["id"], now)

        case group["strategy"] do
          "one_for_all" ->
            restart_supervision_group_members!(owner_run, group, member, child_run, now)

          _ ->
            restart_supervision_member!(owner_run, group, member, now)
        end

      AgentKernel.abnormal_terminal_status?(child_run["status"]) ->
        exhaust_supervision_group!(owner_run, group, member, child_run, now)

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

  def restart_supervision_member!(owner_run, group, member, now) do
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

    _ =
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

    :ok
  end

  def restart_supervision_group_members!(owner_run, group, triggering_member, child_run, now) do
    members =
      group["id"]
      |> AgentKernel.list_run_supervision_members()
      |> Enum.filter(&member_selected_for_one_for_all_restart?(&1, triggering_member))

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

    append_event!(
      owner_run["id"],
      "SupervisionGroupRestarting",
      %{
        "groupId" => group["id"],
        "strategy" => group["strategy"],
        "triggeringMemberKey" => triggering_member["member_key"],
        "triggeringChildRunId" => child_run["id"],
        "memberKeys" => Enum.map(members, & &1["member_key"])
      },
      now
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
                  now
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

      _ =
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

  def exhaust_supervision_group!(owner_run, group, member, child_run, now) do
    error_body = supervision_exhausted_error(group, member, child_run)

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

    append_event!(
      owner_run["id"],
      "SupervisionGroupExhausted",
      %{
        "groupId" => group["id"],
        "strategy" => group["strategy"],
        "memberKey" => member["member_key"],
        "childRunId" => child_run["id"],
        "error" => error_body
      },
      now
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
                  now
                )
            end
        end
      end
    end)

    case group["on_exhausted"] do
      "fail_self" ->
        case owner_run["definitionKind"] do
          "service" ->
            VilanoKernel.Storage.FailureRecovery.stop_service_run_instance!(
              owner_run,
              error_body,
              "supervision_exhausted",
              now
            )

          _ ->
            VilanoKernel.Storage.FailureRecovery.fail_workflow_run_instance!(
              owner_run,
              error_body,
              now
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

  def wake_waiting_supervision_member_results!(group_id, member_key, result_status, payload, now) do
    wait_name = AgentKernel.supervision_member_wait_name(group_id, member_key)

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
        where wait_kind = 'supervision_member_result' and wait_name = ? and status = 'waiting'
        """,
        [wait_name]
      )
      |> rows_to_maps()

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
        now
      )
    end)
  end
end
