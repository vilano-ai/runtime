defmodule VilanoKernel.Storage.WorkflowOps do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{Infrastructure, RunControl, Support}

  import Support
  import VilanoKernel.Storage.ServiceSupport

  def resolve_spawn(lease_id, definition_name, op_key, child_run_id, input) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        parent_run ->
          existing_child = get_run_child(parent_run["id"], op_key)

          if existing_child do
            %{"status" => "existing", "childRun" => VilanoKernel.Storage.get_run(existing_child["child_run_id"])}
          else
            RunControl.ensure_fenced_run_ownership!(parent_run["id"], lease_id, now)

            definition =
              parent_run
              |> project_definitions_for_run()
              |> definition_from_project_definitions!("workflow", definition_name)

            insert_workflow_run!(
              child_run_id,
              project_record_for_run(parent_run),
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
              [parent_run["id"], op_key, child_run_id, definition_name, now, now]
            )

            append_event!(
              parent_run["id"],
              "ChildRunSpawned",
              %{
                "key" => op_key,
                "childRunId" => child_run_id,
                "definitionName" => definition_name,
                "input" => input || %{}
              },
              now
            )

            RunControl.ensure_fenced_run_ownership!(parent_run["id"], lease_id, now)

            %{"status" => "created", "childRun" => VilanoKernel.Storage.get_run(child_run_id)}
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_child_result_wait(lease_id, child_run_id, op_key) do
    now = Infrastructure.now_iso8601()
    wait_key = "child_result:" <> child_run_id

    Repo.transaction(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        parent_run ->
          case get_run_child_by_child(parent_run["id"], child_run_id) do
            nil ->
              nil

            child_link ->
              if child_link["op_key"] != op_key do
                nil
              else
                case VilanoKernel.Storage.get_run(child_run_id) do
                  nil ->
                    nil

                  child_run ->
                    cond do
                      child_run["status"] == "completed" ->
                        %{"status" => "completed", "output" => child_run["output"]}

                      child_run["status"] in ["failed", "cancelled"] ->
                        %{"status" => "failed", "error" => child_run["error"]}

                      true ->
                        existing_wait = get_run_wait(parent_run["id"], wait_key)

                        if existing_wait && existing_wait["status"] == "waiting" do
                          %{
                            "status" => "suspended",
                            "wait" => %{
                              "runId" => parent_run["id"],
                              "key" => wait_key,
                              "kind" => "child_result",
                              "name" => child_run_id,
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
                            ) values (?, ?, 'child_result', ?, 'waiting', null, null, ?, ?)
                            on conflict(run_id, op_key) do update set
                              wait_kind = excluded.wait_kind,
                              wait_name = excluded.wait_name,
                              status = 'waiting',
                              wake_at = null,
                              output_json = null,
                              updated_at = excluded.updated_at
                            """,
                            [parent_run["id"], wait_key, child_run_id, now, now]
                          )

                          run_storage_test_hook(:child_wait_registered, %{
                            "parentRunId" => parent_run["id"],
                            "childRunId" => child_run_id,
                            "waitKey" => wait_key,
                            "leaseId" => lease_id
                          })

                          case VilanoKernel.Storage.get_run(child_run_id) do
                            nil ->
                              nil

                            rechecked_child_run ->
                              cond do
                                rechecked_child_run["status"] == "completed" ->
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
                                    [
                                      maybe_encode_json(rechecked_child_run["output"]),
                                      now,
                                      parent_run["id"],
                                      wait_key
                                    ]
                                  )

                                  append_event!(
                                    parent_run["id"],
                                    "WaitRegistered",
                                    %{
                                      "kind" => "child_result",
                                      "key" => wait_key,
                                      "childRunId" => child_run_id
                                    },
                                    now
                                  )

                                  append_event!(
                                    parent_run["id"],
                                    "WaitSatisfied",
                                    %{
                                      "kind" => "child_result",
                                      "key" => wait_key,
                                      "childRunId" => child_run_id,
                                      "childStatus" => "completed",
                                      "payload" => rechecked_child_run["output"]
                                    },
                                    now
                                  )

                                  %{
                                    "status" => "completed",
                                    "output" => rechecked_child_run["output"]
                                  }

                                rechecked_child_run["status"] in ["failed", "cancelled"] ->
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
                                    [
                                      maybe_encode_json(rechecked_child_run["error"]),
                                      now,
                                      parent_run["id"],
                                      wait_key
                                    ]
                                  )

                                  append_event!(
                                    parent_run["id"],
                                    "WaitRegistered",
                                    %{
                                      "kind" => "child_result",
                                      "key" => wait_key,
                                      "childRunId" => child_run_id
                                    },
                                    now
                                  )

                                  append_event!(
                                    parent_run["id"],
                                    "WaitSatisfied",
                                    %{
                                      "kind" => "child_result",
                                      "key" => wait_key,
                                      "childRunId" => child_run_id,
                                      "childStatus" => rechecked_child_run["status"],
                                      "payload" => rechecked_child_run["error"]
                                    },
                                    now
                                  )

                                  %{"status" => "failed", "error" => rechecked_child_run["error"]}

                                true ->
                                  RunControl.ensure_fenced_run_write!(
                                    parent_run["id"],
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
                                    [now, parent_run["id"]]
                                  )

                                  append_event!(
                                    parent_run["id"],
                                    "WaitRegistered",
                                    %{
                                      "kind" => "child_result",
                                      "key" => wait_key,
                                      "childRunId" => child_run_id
                                    },
                                    now
                                  )

                                  append_event!(
                                    parent_run["id"],
                                    "RunSuspended",
                                    %{
                                      "reason" => "child_result",
                                      "key" => wait_key,
                                      "childRunId" => child_run_id
                                    },
                                    now
                                  )

                                  maybe_append_service_turn_waiting!(
                                    parent_run,
                                    %{
                                      "waitKind" => "child_result",
                                      "key" => wait_key,
                                      "name" => child_run_id,
                                      "childRunId" => child_run_id
                                    },
                                    now
                                  )

                                  %{
                                    "status" => "suspended",
                                    "wait" => %{
                                      "runId" => parent_run["id"],
                                      "key" => wait_key,
                                      "kind" => "child_result",
                                      "name" => child_run_id,
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
              end
          end
      end
    end)
    |> unwrap_transaction_result()
  end
end
