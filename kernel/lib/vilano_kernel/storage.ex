defmodule VilanoKernel.Storage do
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

  alias VilanoKernel.Storage.{
    AgentKernel,
    Infrastructure,
    Projects,
    ReadModels,
    RetryPolicy,
    RuntimeMetadata,
    ServiceSupport,
    ServiceLifecycle,
    Support
  }

  import Support
  import ServiceSupport

  def init! do
    Infrastructure.init!()
  end

  def project_count, do: Projects.project_count()

  def schema_state, do: RuntimeMetadata.schema_state()

  def runtime_metadata, do: RuntimeMetadata.runtime_metadata()

  def list_projects, do: Projects.list_projects()

  def list_referenced_snapshot_paths(project_name \\ nil) do
    args =
      case project_name do
        nil -> []
        value -> [value, value]
      end

    where_clause =
      case project_name do
        nil ->
          """
          where snapshot_path is not null
          union
          select distinct project_snapshot_path as snapshot_path
          from runs
          where
            project_snapshot_path is not null
            and status in ('pending', 'running', 'waiting', 'active', 'idle')
          """

        _ ->
          """
          where snapshot_path is not null and name = ?
          union
          select distinct project_snapshot_path as snapshot_path
          from runs
          where
            project_snapshot_path is not null
            and project_name = ?
            and status in ('pending', 'running', 'waiting', 'active', 'idle')
          """
      end

    Repo
    |> SQL.query!(
      """
      select distinct snapshot_path
      from projects
      #{where_clause}
      order by snapshot_path asc
      """,
      args
    )
    |> rows_to_maps()
    |> Enum.map(& &1["snapshot_path"])
    |> Enum.filter(&is_binary/1)
  end

  def get_project(name), do: Projects.get_project(name)

  def create_project!(project), do: Projects.create_project(project)

  def upsert_project!(project), do: Projects.upsert_project!(project)

  def remove_project(name), do: Projects.remove_project(name)

  def valid_lease_auth_token?(lease_id, lease_auth_token),
    do: lease_auth_token_valid?(lease_id, lease_auth_token)

  def list_definitions(kind, project_name \\ nil),
    do: Projects.list_definitions(kind, project_name)

  def get_definition(project_name, kind, definition_name),
    do: Projects.get_definition(project_name, kind, definition_name)

  def get_active_run_by_lease(lease_id), do: get_run_by_lease(lease_id)

  def create_workflow_run!(project, definition, input) do
    now = Infrastructure.now_iso8601()
    run_id = "run_" <> Ecto.UUID.generate()

    Repo.transaction(fn ->
      insert_workflow_run!(run_id, project, definition, input || %{}, now)
    end)

    get_run(run_id)
  end

  def ensure_service_run!(
        project,
        definition,
        service_key,
        key_input,
        lease_id \\ nil,
        must_exist \\ false
      ) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      caller_run =
        case lease_id do
          value when is_binary(value) and value != "" ->
            get_fenced_run_by_lease(value, now)

          _ ->
            nil
        end

      if is_binary(lease_id) and lease_id != "" and is_nil(caller_run) do
        nil
      else
        ensure_service_run_in_tx!(
          project,
          definition,
          service_key,
          key_input,
          now,
          caller_run && caller_run["id"],
          lease_id,
          must_exist
        )
      end
    end)
    |> unwrap_transaction_result()
  end

  def find_service_run(project_name, definition_name, service_key) do
    get_service_run(project_name, definition_name, service_key)
  end

  def get_related_run_status(lease_id, run_id) do
    now = Infrastructure.now_iso8601()

    with caller_run when not is_nil(caller_run) <- get_fenced_run_by_lease(lease_id, now),
         true <- related_run?(caller_run["id"], run_id),
         run when not is_nil(run) <- get_run(run_id) do
      %{"status" => run["status"]}
    else
      _ -> nil
    end
  end

  def send_child_run_signal(lease_id, child_run_id, signal_name, payload) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      with caller_run when not is_nil(caller_run) <- get_fenced_run_by_lease(lease_id, now),
           child_ref when not is_nil(child_ref) <-
             get_run_child_by_child(caller_run["id"], child_run_id) do
        _ = child_ref
        ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)
        result = send_run_signal(child_run_id, signal_name, payload)
        ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)
        result
      else
        _ -> nil
      end
    end)
    |> unwrap_transaction_result()
  end

  def enqueue_service_envelope!(project, definition, service_key, key_input, kind, name, payload) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      service_run =
        ensure_service_run_in_tx!(
          project,
          definition,
          service_key,
          key_input || %{},
          now
        )

      case maybe_insert_service_envelope(service_run, kind, name, payload, nil, nil, now) do
        {:ok, envelope_id} ->
          %{
            "run" => get_service_run_by_id(service_run["id"]),
            "envelope" => service_envelope_from_row(get_service_envelope(envelope_id))
          }

        {:error, error} ->
          {:error, error}
      end
    end)
    |> unwrap_transaction_result()
  end

  def find_service_envelope(envelope_id) do
    case get_service_envelope(envelope_id) do
      nil -> nil
      row -> service_envelope_from_row(row)
    end
  end

  def stop_service_run(project_name, definition_name, service_key) do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case get_service_run(project_name, definition_name, service_key) do
        nil ->
          nil

        service_run ->
          stop_service_run_instance!(
            service_run,
            cancellation_error("Service stopped", "cli_stop"),
            "cli_stop",
            now
          )
      end
    end)
    |> unwrap_transaction_result()
  end

  def cancel_run(run_id, reason \\ "cli_cancel") do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case get_run(run_id) do
        nil ->
          nil

        %{"definitionKind" => "service"} ->
          service_run = get_service_run_by_id(run_id)

          stop_service_run_instance!(
            service_run,
            cancellation_error("Service stopped", reason),
            reason,
            now
          )

        run ->
          cancel_workflow_run_instance!(
            run,
            cancellation_error("Run cancelled", reason),
            reason,
            now
          )
      end
    end)
    |> unwrap_transaction_result()
  end

  def list_service_runs(project_name \\ nil, active_only \\ false) do
    {where_sql, args} =
      case {project_name, active_only} do
        {nil, false} ->
          {"where r.definition_kind = 'service'", []}

        {nil, true} ->
          {"where r.definition_kind = 'service' and r.status not in ('idle', 'stopped')", []}

        {project, false} ->
          {"where r.definition_kind = 'service' and r.project_name = ?", [project]}

        {project, true} ->
          {"where r.definition_kind = 'service' and r.project_name = ? and r.status not in ('idle', 'stopped')",
           [project]}
      end

    Repo
    |> SQL.query!(
      """
      select
        r.id,
        r.project_name,
        r.definition_kind,
        r.definition_name,
        r.status,
        r.lease_id,
        r.lease_worker_id,
        r.lease_expires_at,
        r.input_json,
        r.output_json,
        r.error_json,
        r.created_at,
        r.updated_at,
        s.service_key,
        s.key_input_json,
        s.state_json,
        s.created_at as service_created_at,
        s.updated_at as service_updated_at
      from runs r
      join service_runs s on s.run_id = r.id
      #{where_sql}
      order by r.created_at desc
      """,
      args
    )
    |> rows_to_maps()
    |> Enum.map(&service_run_from_row(&1, &1))
    |> Enum.map(&decorate_service_passivation/1)
  end

  def resolve_spawn(lease_id, definition_name, op_key, child_run_id, input) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        parent_run ->
          existing_child = get_run_child(parent_run["id"], op_key)

          if existing_child do
            %{"status" => "existing", "childRun" => get_run(existing_child["child_run_id"])}
          else
            ensure_fenced_run_ownership!(parent_run["id"], lease_id, now)

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

            ensure_fenced_run_ownership!(parent_run["id"], lease_id, now)

            %{"status" => "created", "childRun" => get_run(child_run_id)}
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_child_result_wait(lease_id, child_run_id, op_key) do
    now = Infrastructure.now_iso8601()
    wait_key = "child_result:" <> child_run_id

    Repo.transaction(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
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
                case get_run(child_run_id) do
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

                          maybe_run_storage_test_hook(:child_wait_registered, %{
                            "parentRunId" => parent_run["id"],
                            "childRunId" => child_run_id,
                            "waitKey" => wait_key,
                            "leaseId" => lease_id
                          })

                          case get_run(child_run_id) do
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
                                  ensure_fenced_run_write!(
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

  def resolve_service_send(lease_id, service_run_id, name, op_key, payload) do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case {get_fenced_run_by_lease(lease_id, now), get_service_run_by_id(service_run_id)} do
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
              ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

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

                  ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

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

    Repo.transaction(fn ->
      case {get_fenced_run_by_lease(lease_id, now), get_service_run_by_id(service_run_id)} do
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
              ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

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
                      "name" => name,
                      "payload" => payload
                    },
                    now
                  )

                  ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

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

    Repo.transaction(fn ->
      case {get_fenced_run_by_lease(lease_id, now), get_service_run_by_id(service_run_id)} do
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
              ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

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

                  ensure_fenced_run_write!(
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

    Repo.transaction(fn ->
      case {get_fenced_run_by_lease(lease_id, now), get_service_envelope(envelope_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {service_run, envelope} ->
          if envelope["service_run_id"] == service_run["id"] do
            ensure_fenced_run_ownership!(service_run["id"], lease_id, now)
            state = Map.get(body, "state")

            state_commit = maybe_commit_service_state!(service_run["id"], state, now, lease_id)

            ensure_fenced_related_write!(
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
                stop_service_run_instance!(
                  get_service_run_by_id(service_run["id"]),
                  cancellation_error("Service stopped", "handler_stop"),
                  "handler_stop",
                  now,
                  lease_id
                )
            else
              next_status = service_next_status(service_run["id"], false)

              ensure_fenced_run_write!(
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

            get_run(service_run["id"])
          else
            nil
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def get_service_turn_mailbox(lease_id, envelope_id) do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case {get_fenced_run_by_lease(lease_id, now), get_service_envelope(envelope_id)} do
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

    Repo.transaction(fn ->
      case {get_fenced_run_by_lease(lease_id, now), get_service_envelope(envelope_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {service_run, envelope} ->
          if envelope["service_run_id"] == service_run["id"] and
               envelope["status"] == "processing" do
            ensure_fenced_run_ownership!(service_run["id"], lease_id, now)
            next_attempt = (envelope["attempt"] || 1) + 1

            ensure_fenced_related_write!(
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

            ensure_fenced_run_write!(
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
              "run" => get_run(service_run["id"])
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

    Repo.transaction(fn ->
      case {get_fenced_run_by_lease(lease_id, now), get_service_envelope(envelope_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {service_run, envelope} ->
          if envelope["service_run_id"] == service_run["id"] and
               envelope["status"] == "processing" do
            ensure_fenced_run_ownership!(service_run["id"], lease_id, now)

            ensure_fenced_related_write!(
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

            ensure_fenced_run_write!(
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

            get_run(service_run["id"])
          else
            nil
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def fail_service_turn(lease_id, envelope_id, error_body, retry_options \\ %{}) do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case {get_fenced_run_by_lease(lease_id, now), get_service_envelope(envelope_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {service_run, envelope} ->
          if envelope["service_run_id"] == service_run["id"] do
            fail_service_turn_attempt!(
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

  def lease_next_run(worker_id), do: do_lease_next_run(worker_id, 3)

  defp do_lease_next_run(_worker_id, 0), do: nil

  defp do_lease_next_run(worker_id, attempts_remaining) do
    now = Infrastructure.now_iso8601()
    expires_at = shift_seconds(now, Infrastructure.lease_duration_seconds())

    case Infrastructure.transaction_with_busy_retry(fn ->
           case next_activation_candidate(now) do
             nil ->
               nil

             {:workflow, candidate} ->
               lease_id = "lease_" <> Ecto.UUID.generate()
               lease_auth_token = "ltok_" <> Ecto.UUID.generate()
               run_id = candidate["id"]

               claimed_rows =
                 write_changes!(
                   """
                   update runs
                   set
                     status = 'running',
                     lease_id = ?,
                     lease_auth_token = ?,
                     lease_worker_id = ?,
                     lease_expires_at = ?,
                     updated_at = ?
                   where
                     id = ?
                     and definition_kind = 'workflow'
                     and status in ('pending', 'running')
                     and (lease_expires_at is null or lease_expires_at < ?)
                   """,
                   [lease_id, lease_auth_token, worker_id, expires_at, now, run_id, now]
                 )

               if claimed_rows != 1 do
                 Repo.rollback(:stale_candidate)
               end

               append_event!(
                 run_id,
                 "RunLeaseGranted",
                 %{
                   leaseId: lease_id,
                   workerId: worker_id,
                   leaseExpiresAt: expires_at
                 },
                 now
               )

               run = get_run(run_id)

               case ensure_run_activation_pinned!(run) do
                 {:ok, pinned_run} ->
                   %{
                     lease_id: lease_id,
                     lease_auth_token: lease_auth_token,
                     lease_expires_at: expires_at,
                     activation_kind: "workflow",
                     run: pinned_run
                   }

                 {:error, {:unresumable_candidate, unpinned_run}} ->
                   Repo.rollback({:unresumable_candidate, unpinned_run})
               end

             {:service_turn, candidate} ->
               lease_id = "lease_" <> Ecto.UUID.generate()
               lease_auth_token = "ltok_" <> Ecto.UUID.generate()
               run_id = candidate["service_run_id"]
               envelope_id = candidate["id"]

               attempt =
                 cond do
                   candidate["envelope_status"] == "queued" ->
                     candidate["attempt"] || 1

                   candidate["run_status"] == "active" and
                       not is_nil(candidate["run_lease_expires_at"]) ->
                     (candidate["attempt"] || 0) + 1

                   true ->
                     candidate["attempt"] || 1
                 end

               envelope_rows =
                 case candidate["envelope_status"] do
                   "queued" ->
                     write_changes!(
                       """
                       update service_envelopes
                       set
                         status = 'processing',
                         attempt = ?,
                         wake_at = null,
                         updated_at = ?
                       where id = ? and status = 'queued'
                       """,
                       [attempt, now, envelope_id]
                     )

                   _ ->
                     write_changes!(
                       """
                       update service_envelopes
                       set
                         attempt = ?,
                         updated_at = ?
                       where id = ? and status = 'processing'
                       """,
                       [attempt, now, envelope_id]
                     )
                 end

               if envelope_rows != 1 do
                 Repo.rollback(:stale_candidate)
               end

               claimed_rows =
                 write_changes!(
                   """
                   update runs
                   set
                     status = 'active',
                     lease_id = ?,
                     lease_auth_token = ?,
                     lease_worker_id = ?,
                     lease_expires_at = ?,
                     updated_at = ?
                   where
                     id = ?
                     and definition_kind = 'service'
                     and status in ('idle', 'pending', 'active')
                     and (lease_expires_at is null or lease_expires_at < ?)
                   """,
                   [lease_id, lease_auth_token, worker_id, expires_at, now, run_id, now]
                 )

               if claimed_rows != 1 do
                 Repo.rollback(:stale_candidate)
               end

               if candidate["envelope_status"] == "queued" do
                 append_event!(
                   run_id,
                   "TurnStarted",
                   %{
                     "envelopeId" => envelope_id,
                     "kind" => candidate["kind"],
                     "name" => candidate["name"],
                     "correlationId" => candidate["correlation_id"],
                     "attempt" => attempt
                   },
                   now
                 )
               else
                 append_event!(
                   run_id,
                   "TurnResumed",
                   %{
                     "envelopeId" => envelope_id,
                     "kind" => candidate["kind"],
                     "name" => candidate["name"],
                     "correlationId" => candidate["correlation_id"],
                     "reason" => ServiceLifecycle.resume_reason(candidate),
                     "attempt" => attempt
                   },
                   now
                 )
               end

               run = get_run(run_id)

               case ensure_run_activation_pinned!(run) do
                 {:ok, pinned_run} ->
                   %{
                     lease_id: lease_id,
                     lease_auth_token: lease_auth_token,
                     lease_expires_at: expires_at,
                     activation_kind: "service_turn",
                     run: pinned_run,
                     service: get_service_run_by_id(run_id),
                     envelope: service_envelope_from_row(get_service_envelope(envelope_id))
                   }

                 {:error, {:unresumable_candidate, unpinned_run}} ->
                   Repo.rollback({:unresumable_candidate, unpinned_run})
               end
           end
         end) do
      {:ok, value} ->
        value

      {:error, :stale_candidate} ->
        do_lease_next_run(worker_id, attempts_remaining - 1)

      {:error, {:unresumable_candidate, run}} ->
        invalidate_unpinned_run!(run, Infrastructure.now_iso8601())
        do_lease_next_run(worker_id, attempts_remaining - 1)

      {:error, reason} ->
        raise(reason)
    end
  end

  def heartbeat_lease(lease_id, worker_id) do
    now = Infrastructure.now_iso8601()
    expires_at = shift_seconds(now, Infrastructure.lease_duration_seconds())

    updated_rows =
      write_changes!(
        """
        update runs
        set lease_expires_at = ?, updated_at = ?
        where
          lease_id = ?
          and lease_worker_id = ?
          and status in ('running', 'active')
          and lease_expires_at is not null
          and lease_expires_at >= ?
        """,
        [expires_at, now, lease_id, worker_id, now]
      )

    if updated_rows > 0, do: %{"leaseExpiresAt" => expires_at}, else: nil
  end

  def lease_status(lease_id) do
    now = Infrastructure.now_iso8601()

    row =
      Repo
      |> SQL.query!(
        """
        select
          id,
          project_name,
          definition_kind,
          definition_name,
          status,
          lease_id,
          lease_worker_id,
          lease_expires_at,
          input_json,
          output_json,
          error_json,
          created_at,
          updated_at
        from runs
        where
          lease_id = ?
          and status in ('running', 'active')
          and lease_expires_at is not null
          and lease_expires_at >= ?
        limit 1
        """,
        [lease_id, now]
      )
      |> rows_to_maps()
      |> List.first()

    case row do
      nil ->
        %{"active" => false}

      active_row ->
        run = run_from_row(active_row)

        %{
          "active" => true,
          "runId" => run["id"],
          "status" => run["status"],
          "definitionKind" => run["definitionKind"],
          "leaseExpiresAt" => run["leaseExpiresAt"]
        }
    end
  end

  def complete_run_lease(lease_id, result) do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          ensure_fenced_run_write!(
            run["id"],
            lease_id,
            now,
            """
            update runs
            set
              status = 'completed',
              lease_id = null,
              lease_auth_token = null,
              lease_worker_id = null,
              lease_expires_at = null,
              output_json = ?,
              error_json = null,
              updated_at = ?
            where id = ?
            """,
            [Jason.encode!(result), now, run["id"]]
          )

          append_event!(run["id"], "RunCompleted", %{"result" => result}, now)
          wake_waiting_parents_for_child!(run["id"], "completed", result, now)
          maybe_apply_supervision_for_terminal_run!(run["id"], now)
          maybe_trigger_relationships_for_terminal_run!(run["id"], now)
          get_run(run["id"])
      end
    end)
    |> unwrap_transaction_result()
  end

  def fail_run_lease(lease_id, error_body) do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          ensure_fenced_run_write!(
            run["id"],
            lease_id,
            now,
            """
            update runs
            set
              status = 'failed',
              lease_id = null,
              lease_auth_token = null,
              lease_worker_id = null,
              lease_expires_at = null,
              error_json = ?,
              updated_at = ?
            where id = ?
            """,
            [Jason.encode!(error_body), now, run["id"]]
          )

          append_event!(run["id"], "RunFailed", %{"error" => error_body}, now)
          wake_waiting_parents_for_child!(run["id"], "failed", error_body, now)
          maybe_apply_supervision_for_terminal_run!(run["id"], now)
          maybe_trigger_relationships_for_terminal_run!(run["id"], now)
          get_run(run["id"])
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_step(lease_id, name, op_key) do
    resolve_step(lease_id, name, op_key, nil, %{})
  end

  def resolve_step(lease_id, name, op_key, timeout_ms) do
    resolve_step(lease_id, name, op_key, timeout_ms, %{})
  end

  def resolve_step(lease_id, name, op_key, timeout_ms, retry_policy) do
    now = Infrastructure.now_iso8601()

    result =
      Repo.transaction(fn ->
        case get_fenced_run_by_lease(lease_id, now) do
          nil ->
            nil

          run ->
            existing =
              Repo
              |> SQL.query!(
                """
                select
                  run_id,
                  op_key,
                  name,
                  status,
                  attempt,
                  max_attempts,
                  backoff_kind,
                  backoff_ms,
                  backoff_step_ms,
                  backoff_factor,
                  max_backoff_ms,
                  backoff_jitter_kind,
                  backoff_jitter_ratio,
                  retry_on_json,
                  timeout_ms,
                  output_json,
                  error_json,
                  created_at,
                  updated_at
                from run_steps
                where run_id = ? and op_key = ?
                """,
                [run["id"], op_key]
              )
              |> rows_to_maps()
              |> List.first()

            cond do
              existing && existing["status"] == "completed" ->
                %{
                  "status" => "completed",
                  "output" => decode_json_value(existing["output_json"], nil)
                }

              existing && existing["status"] == "failed" ->
                %{
                  "status" => "failed",
                  "error" => decode_json_value(existing["error_json"], nil)
                }

              true ->
                attempt =
                  case existing do
                    nil -> 1
                    row -> (row["attempt"] || 0) + 1
                  end

                persisted_max_attempts =
                  cond do
                    is_integer(Map.get(retry_policy, "maxAttempts")) and
                        Map.get(retry_policy, "maxAttempts") > 0 ->
                      Map.get(retry_policy, "maxAttempts")

                    existing && is_integer(existing["max_attempts"]) &&
                        existing["max_attempts"] > 0 ->
                      existing["max_attempts"]

                    true ->
                      RetryPolicy.normalize_max_attempts(nil)
                  end

                persisted_backoff_kind =
                  cond do
                    is_binary(Map.get(retry_policy, "backoffKind")) ->
                      RetryPolicy.normalize_backoff_kind(Map.get(retry_policy, "backoffKind"))

                    existing && is_binary(existing["backoff_kind"]) ->
                      RetryPolicy.normalize_backoff_kind(existing["backoff_kind"])

                    true ->
                      RetryPolicy.normalize_backoff_kind(nil)
                  end

                persisted_backoff_ms =
                  cond do
                    is_integer(Map.get(retry_policy, "backoffMs")) and
                        Map.get(retry_policy, "backoffMs") >= 0 ->
                      Map.get(retry_policy, "backoffMs")

                    existing && is_integer(existing["backoff_ms"]) && existing["backoff_ms"] >= 0 ->
                      existing["backoff_ms"]

                    true ->
                      RetryPolicy.normalize_backoff_ms(nil)
                  end

                persisted_backoff_step_ms =
                  cond do
                    is_integer(Map.get(retry_policy, "backoffStepMs")) and
                        Map.get(retry_policy, "backoffStepMs") >= 0 ->
                      Map.get(retry_policy, "backoffStepMs")

                    existing && is_integer(existing["backoff_step_ms"]) &&
                        existing["backoff_step_ms"] >= 0 ->
                      existing["backoff_step_ms"]

                    true ->
                      nil
                  end

                persisted_backoff_factor =
                  cond do
                    is_number(Map.get(retry_policy, "backoffFactor")) and
                        Map.get(retry_policy, "backoffFactor") > 0 ->
                      Map.get(retry_policy, "backoffFactor")

                    existing && is_number(existing["backoff_factor"]) &&
                        existing["backoff_factor"] > 0 ->
                      existing["backoff_factor"]

                    true ->
                      nil
                  end

                persisted_max_backoff_ms =
                  cond do
                    is_integer(Map.get(retry_policy, "maxBackoffMs")) and
                        Map.get(retry_policy, "maxBackoffMs") >= 0 ->
                      Map.get(retry_policy, "maxBackoffMs")

                    existing && is_integer(existing["max_backoff_ms"]) &&
                        existing["max_backoff_ms"] >= 0 ->
                      existing["max_backoff_ms"]

                    true ->
                      nil
                  end

                persisted_backoff_jitter_kind =
                  cond do
                    is_binary(Map.get(retry_policy, "backoffJitterKind")) ->
                      RetryPolicy.normalize_backoff_jitter_kind(
                        Map.get(retry_policy, "backoffJitterKind")
                      )

                    existing && is_binary(existing["backoff_jitter_kind"]) ->
                      RetryPolicy.normalize_backoff_jitter_kind(existing["backoff_jitter_kind"])

                    true ->
                      nil
                  end

                persisted_backoff_jitter_ratio =
                  cond do
                    is_number(Map.get(retry_policy, "backoffJitterRatio")) ->
                      RetryPolicy.normalize_backoff_jitter_ratio(
                        Map.get(retry_policy, "backoffJitterRatio"),
                        persisted_backoff_jitter_kind
                      )

                    existing && is_number(existing["backoff_jitter_ratio"]) ->
                      RetryPolicy.normalize_backoff_jitter_ratio(
                        existing["backoff_jitter_ratio"],
                        persisted_backoff_jitter_kind
                      )

                    true ->
                      RetryPolicy.normalize_backoff_jitter_ratio(
                        nil,
                        persisted_backoff_jitter_kind
                      )
                  end

                persisted_retry_on =
                  cond do
                    is_list(Map.get(retry_policy, "retryOn")) ->
                      RetryPolicy.normalize_retry_on(Map.get(retry_policy, "retryOn"))

                    existing ->
                      decode_json_list(existing["retry_on_json"])

                    true ->
                      []
                  end

                SQL.query!(
                  Repo,
                  """
                  insert into run_steps (
                    run_id,
                    op_key,
                    name,
                    status,
                    attempt,
                    max_attempts,
                    backoff_kind,
                    backoff_ms,
                    backoff_step_ms,
                    backoff_factor,
                    max_backoff_ms,
                    backoff_jitter_kind,
                    backoff_jitter_ratio,
                    retry_on_json,
                    timeout_ms,
                    output_json,
                    error_json,
                    created_at,
                    updated_at
                  ) values (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?)
                  on conflict(run_id, op_key) do update set
                    name = excluded.name,
                    status = 'running',
                    attempt = excluded.attempt,
                    max_attempts = excluded.max_attempts,
                    backoff_kind = excluded.backoff_kind,
                    backoff_ms = excluded.backoff_ms,
                    backoff_step_ms = excluded.backoff_step_ms,
                    backoff_factor = excluded.backoff_factor,
                    max_backoff_ms = excluded.max_backoff_ms,
                    backoff_jitter_kind = excluded.backoff_jitter_kind,
                    backoff_jitter_ratio = excluded.backoff_jitter_ratio,
                    retry_on_json = excluded.retry_on_json,
                    timeout_ms = excluded.timeout_ms,
                    error_json = null,
                    output_json = null,
                    updated_at = excluded.updated_at
                  """,
                  [
                    run["id"],
                    op_key,
                    name,
                    attempt,
                    persisted_max_attempts,
                    persisted_backoff_kind,
                    persisted_backoff_ms,
                    persisted_backoff_step_ms,
                    persisted_backoff_factor,
                    persisted_max_backoff_ms,
                    persisted_backoff_jitter_kind,
                    persisted_backoff_jitter_ratio,
                    Jason.encode!(persisted_retry_on),
                    timeout_ms,
                    now,
                    now
                  ]
                )

                append_event!(
                  run["id"],
                  "StepStarted",
                  %{
                    "name" => name,
                    "key" => op_key,
                    "attempt" => attempt,
                    "maxAttempts" => persisted_max_attempts,
                    "backoffKind" => persisted_backoff_kind,
                    "backoffMs" => persisted_backoff_ms,
                    "backoffStepMs" => persisted_backoff_step_ms,
                    "backoffFactor" => persisted_backoff_factor,
                    "maxBackoffMs" => persisted_max_backoff_ms,
                    "backoffJitterKind" => persisted_backoff_jitter_kind,
                    "backoffJitterRatio" => persisted_backoff_jitter_ratio,
                    "retryOn" => persisted_retry_on,
                    "timeoutMs" => timeout_ms
                  },
                  now
                )

                %{
                  "status" => "pending",
                  "runId" => run["id"],
                  "leaseId" => lease_id,
                  "name" => name,
                  "key" => op_key,
                  "attempt" => attempt,
                  "timeoutMs" => timeout_ms,
                  "startedAt" => now
                }
            end
        end
      end)
      |> unwrap_transaction_result()

    if is_map(result) && result["status"] == "pending" && is_integer(result["timeoutMs"]) do
      VilanoKernel.StepDeadlineManager.schedule_step(result)
    end

    result
  end

  def complete_step(lease_id, name, op_key, output) do
    now = Infrastructure.now_iso8601()

    result =
      Repo.transaction(fn ->
        case get_fenced_run_by_lease(lease_id, now) do
          nil ->
            nil

          run ->
            case get_run_step_row(run["id"], op_key) do
              nil ->
                nil

              _step ->
                ensure_fenced_related_write!(
                  run["id"],
                  lease_id,
                  now,
                  """
                  update run_steps
                  set
                    name = ?,
                    status = 'completed',
                    output_json = ?,
                    error_json = null,
                    updated_at = ?
                  where
                    run_id = ?
                    and op_key = ?
                    and #{@fenced_run_exists_sql}
                  """,
                  [name, Jason.encode!(output), now, run["id"], op_key]
                )

                append_event!(
                  run["id"],
                  "StepCompleted",
                  %{"name" => name, "key" => op_key, "output" => output},
                  now
                )

                %{
                  "status" => "completed",
                  "output" => output,
                  "runId" => run["id"],
                  "key" => op_key
                }
            end
        end
      end)
      |> unwrap_transaction_result()

    if is_map(result) && result["status"] == "completed" do
      VilanoKernel.StepDeadlineManager.clear_step(result["runId"], result["key"])
    end

    result
  end

  def fail_step(lease_id, name, op_key, error_body) do
    now = Infrastructure.now_iso8601()

    result =
      Repo.transaction(fn ->
        case get_fenced_run_by_lease(lease_id, now) do
          nil ->
            nil

          run ->
            case get_run_step_row(run["id"], op_key) do
              nil ->
                nil

              step ->
                fail_step_attempt!(run, step, name, error_body, now, lease_id)
            end
        end
      end)
      |> unwrap_transaction_result()

    if is_map(result) && result["status"] in ["failed", "retry_waiting"] do
      VilanoKernel.StepDeadlineManager.clear_step(result["runId"], result["key"])
    end

    result
  end

  def timeout_step(lease_id, op_key, expected_attempt, error_body) do
    now = Infrastructure.now_iso8601()

    result =
      Repo.transaction(fn ->
        case get_fenced_run_by_lease(lease_id, now) do
          nil ->
            nil

          run ->
            case get_run_step_row(run["id"], op_key) do
              nil ->
                nil

              step ->
                if step["status"] != "running" or step["attempt"] != expected_attempt do
                  nil
                else
                  case fail_step_attempt!(run, step, step["name"], error_body, now, lease_id) do
                    %{"status" => "retry_waiting", "wait" => wait} ->
                      %{
                        "run" => get_run(run["id"]),
                        "status" => "waiting",
                        "activeLeaseWorkerId" => run["leaseWorkerId"],
                        "wait" => wait
                      }

                    _ ->
                      timeout_result_for_run!(run, error_body, now, lease_id)
                  end
                end
            end
        end
      end)
      |> unwrap_transaction_result()

    if is_map(result) && result["status"] in ["failed", "idle", "pending", "waiting"] do
      VilanoKernel.StepDeadlineManager.clear_step(result["run"]["id"], op_key)
    end

    result
  end

  def resolve_exec(lease_id, name, op_key, exec_spec) do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          existing = get_run_exec(run["id"], op_key)

          cond do
            existing && existing["status"] == "completed" ->
              exec = exec_from_row(existing)
              %{"status" => "completed", "output" => exec["output"], "exec" => exec}

            existing && existing["status"] == "failed" ->
              exec = exec_from_row(existing)
              %{"status" => "failed", "error" => exec["error"], "exec" => exec}

            true ->
              attempt =
                case existing do
                  nil -> 1
                  row -> row["attempt"] + 1
                end

              args = Map.get(exec_spec, "args", [])
              env_map = Map.get(exec_spec, "env")

              env_keys_json =
                if is_map(env_map) do
                  env_map
                  |> Map.keys()
                  |> Enum.sort()
                  |> Jason.encode!()
                else
                  nil
                end

              SQL.query!(
                Repo,
                """
                insert into run_execs (
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
                ) values (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, null, null, null, null, null, null, null, ?, ?)
                on conflict(run_id, op_key) do update set
                  name = excluded.name,
                  status = 'running',
                  cmd = excluded.cmd,
                  args_json = excluded.args_json,
                  cwd = excluded.cwd,
                  env_json = excluded.env_json,
                  timeout_ms = excluded.timeout_ms,
                  attempt = excluded.attempt,
                  exit_code = null,
                  signal_code = null,
                  stdout_ref = null,
                  stderr_ref = null,
                  artifacts_json = null,
                  output_json = null,
                  error_json = null,
                  updated_at = excluded.updated_at
                """,
                [
                  run["id"],
                  op_key,
                  name,
                  Map.fetch!(exec_spec, "cmd"),
                  Jason.encode!(args),
                  Map.get(exec_spec, "cwd"),
                  env_keys_json,
                  Map.get(exec_spec, "timeoutMs"),
                  attempt,
                  now,
                  now
                ]
              )

              append_event!(
                run["id"],
                "ProcessStarted",
                %{
                  "name" => name,
                  "key" => op_key,
                  "attempt" => attempt,
                  "cmd" => Map.fetch!(exec_spec, "cmd"),
                  "args" => args,
                  "cwd" => Map.get(exec_spec, "cwd"),
                  "timeoutMs" => Map.get(exec_spec, "timeoutMs")
                },
                now
              )

              %{"status" => "execute", "attempt" => attempt}
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def complete_exec(lease_id, name, op_key, body) do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          case get_run_exec(run["id"], op_key) do
            nil ->
              nil

            existing ->
              ensure_fenced_related_write!(
                run["id"],
                lease_id,
                now,
                """
                update run_execs
                set
                  name = ?,
                  status = 'completed',
                  exit_code = ?,
                  signal_code = ?,
                  stdout_ref = ?,
                  stderr_ref = ?,
                  artifacts_json = ?,
                  output_json = ?,
                  error_json = null,
                  updated_at = ?
                where
                  run_id = ?
                  and op_key = ?
                  and #{@fenced_run_exists_sql}
                """,
                [
                  name,
                  Map.get(body, "exitCode"),
                  Map.get(body, "signalCode"),
                  Map.get(body, "stdoutRef"),
                  Map.get(body, "stderrRef"),
                  Jason.encode!(Map.get(body, "artifacts", [])),
                  Jason.encode!(Map.get(body, "output")),
                  now,
                  run["id"],
                  op_key
                ]
              )

              append_event!(
                run["id"],
                "ProcessCompleted",
                %{
                  "name" => name,
                  "key" => op_key,
                  "attempt" => existing["attempt"],
                  "exitCode" => Map.get(body, "exitCode"),
                  "signalCode" => Map.get(body, "signalCode"),
                  "stdoutRef" => Map.get(body, "stdoutRef"),
                  "stderrRef" => Map.get(body, "stderrRef"),
                  "artifacts" => Map.get(body, "artifacts", [])
                },
                now
              )

              exec = get_run_exec(run["id"], op_key)
              %{"status" => "completed", "output" => decode_json_value(exec["output_json"], nil)}
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def fail_exec(lease_id, name, op_key, body) do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          case get_run_exec(run["id"], op_key) do
            nil ->
              nil

            existing ->
              fail_exec_attempt!(run, existing, name, op_key, body, now, lease_id)
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_sleep_wait(lease_id, op_key, duration_ms) do
    now = Infrastructure.now_iso8601()
    wake_at = shift_milliseconds(now, duration_ms)

    Repo.transaction(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
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

              ensure_fenced_run_write!(
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

    Repo.transaction(fn ->
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

    Repo.transaction(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
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

              maybe_run_storage_test_hook(:signal_wait_registered, %{
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
                      ensure_fenced_run_write!(
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

  def resolve_run_monitor(lease_id, target_run_id, op_key) do
    resolve_run_relationship(lease_id, target_run_id, op_key, "monitor", "all")
  end

  def resolve_run_link(lease_id, target_run_id, op_key, propagate \\ "abnormal") do
    resolve_run_relationship(lease_id, target_run_id, op_key, "link", propagate)
  end

  def set_trap_exits(lease_id, enabled) do
    now = Infrastructure.now_iso8601()
    trap_value = if enabled, do: 1, else: 0

    Repo.transaction(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          current_value = AgentKernel.run_trap_exits_value(run["id"])

          if current_value != trap_value do
            ensure_fenced_run_write!(
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

          get_run(run["id"])
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_exit_wait(lease_id, op_key) do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
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

              maybe_run_storage_test_hook(:exit_wait_registered, %{
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
                        ensure_fenced_run_write!(
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
      case get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        owner_run ->
          case AgentKernel.get_run_supervision_group(owner_run["id"], op_key) do
            nil ->
              ensure_fenced_run_ownership!(owner_run["id"], lease_id, now)
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
      case get_fenced_run_by_lease(lease_id, now) do
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
                    ensure_fenced_run_ownership!(owner_run["id"], lease_id, now)

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

                    AgentKernel.supervision_member_runtime_state(member, &get_run/1)

                  member ->
                    AgentKernel.supervision_member_runtime_state(member, &get_run/1)
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
      case get_fenced_run_by_lease(lease_id, now) do
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

                maybe_run_storage_test_hook(:supervision_member_wait_registered, %{
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
                    ensure_fenced_run_write!(
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

    Repo.transaction(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        owner_run ->
          case AgentKernel.get_run_supervision_group_for_owner(owner_run["id"], group_id) do
            nil ->
              nil

            _group ->
              AgentKernel.get_run_supervision_member(group_id, member_key)
              |> AgentKernel.supervision_member_runtime_state(&get_run/1)
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def list_supervision_members(lease_id, group_id) do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
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
                AgentKernel.supervision_member_runtime_state(member, &get_run/1)
              end)
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def lookup_singleton_service(lease_id, role, key_input) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        owner_run ->
          case find_singleton_service_definition(project_definitions_for_run(owner_run), role) do
            nil ->
              nil

            definition ->
              service_run =
                owner_run["project"]
                |> list_service_runs_by_definition(Map.fetch!(definition, "name"))
                |> Enum.find(&(&1["keyInput"] == (key_input || %{})))

              case service_run do
                nil ->
                  nil

                resolved ->
                  ensure_fenced_run_ownership!(owner_run["id"], lease_id, now)
                  record_service_ref!(owner_run["id"], resolved["id"], now)
                  ensure_fenced_run_ownership!(owner_run["id"], lease_id, now)
                  resolved
              end
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_topic_publish(lease_id, topic, op_key, payload) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        caller_run ->
          case AgentKernel.get_run_topic_publish(caller_run["id"], op_key) do
            nil ->
              ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)
              publish_id = "pub_" <> Ecto.UUID.generate()

              subscriptions =
                AgentKernel.list_topic_subscription_targets(caller_run["project"], topic)

              {enqueued_count, rejected_count} =
                Enum.reduce(subscriptions, {0, 0}, fn subscription, {enqueued, rejected} ->
                  service_run = service_run_from_row(subscription, subscription)

                  delivery_payload = %{
                    "topic" => topic,
                    "payload" => payload,
                    "publishId" => publish_id,
                    "publisherRunId" => caller_run["id"],
                    "publishedAt" => now
                  }

                  case maybe_insert_service_envelope(
                         service_run,
                         "signal",
                         subscription["signal_name"],
                         delivery_payload,
                         nil,
                         caller_run["id"],
                         now
                       ) do
                    {:ok, _envelope_id} -> {enqueued + 1, rejected}
                    {:error, _error} -> {enqueued, rejected + 1}
                  end
                end)

              matched_count = length(subscriptions)

              SQL.query!(
                Repo,
                """
                insert into run_topic_publishes (
                  caller_run_id,
                  op_key,
                  publish_id,
                  topic,
                  payload_json,
                  matched_count,
                  enqueued_count,
                  rejected_count,
                  created_at,
                  updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                  caller_run["id"],
                  op_key,
                  publish_id,
                  topic,
                  maybe_encode_json(payload),
                  matched_count,
                  enqueued_count,
                  rejected_count,
                  now,
                  now
                ]
              )

              append_event!(
                caller_run["id"],
                "TopicPublished",
                %{
                  "key" => op_key,
                  "publishId" => publish_id,
                  "topic" => topic,
                  "matched" => matched_count,
                  "enqueued" => enqueued_count,
                  "rejected" => rejected_count
                },
                now
              )

              ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

              AgentKernel.topic_publish_from_row(
                AgentKernel.get_run_topic_publish(caller_run["id"], op_key)
              )

            publish ->
              AgentKernel.topic_publish_from_row(publish)
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def subscribe_service_topic(lease_id, topic, signal_name) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      with service_run when not is_nil(service_run) <- get_fenced_run_by_lease(lease_id, now),
           "service" <- service_run["definitionKind"] do
        ensure_fenced_run_ownership!(service_run["id"], lease_id, now)
        existing = AgentKernel.get_topic_subscription(topic, service_run["id"], signal_name)

        _changes =
          write_changes!(
            """
            insert into topic_subscriptions (
              topic,
              service_run_id,
              signal_name,
              created_at,
              updated_at
            ) values (?, ?, ?, ?, ?)
            on conflict(topic, service_run_id, signal_name) do update set
              updated_at = excluded.updated_at
            """,
            [topic, service_run["id"], signal_name, now, now]
          )

        if is_nil(existing) do
          append_event!(
            service_run["id"],
            "TopicSubscribed",
            %{"topic" => topic, "signal" => signal_name},
            now
          )
        end

        ensure_fenced_run_ownership!(service_run["id"], lease_id, now)

        AgentKernel.topic_subscription_from_row(
          AgentKernel.get_topic_subscription(topic, service_run["id"], signal_name)
        )
      else
        _ -> nil
      end
    end)
    |> unwrap_transaction_result()
  end

  def unsubscribe_service_topic(lease_id, topic, signal_name) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      with service_run when not is_nil(service_run) <- get_fenced_run_by_lease(lease_id, now),
           "service" <- service_run["definitionKind"] do
        ensure_fenced_run_ownership!(service_run["id"], lease_id, now)

        deleted =
          write_changes!(
            """
            delete from topic_subscriptions
            where topic = ? and service_run_id = ? and signal_name = ?
            """,
            [topic, service_run["id"], signal_name]
          )

        if deleted > 0 do
          append_event!(
            service_run["id"],
            "TopicUnsubscribed",
            %{"topic" => topic, "signal" => signal_name},
            now
          )
        end

        ensure_fenced_run_ownership!(service_run["id"], lease_id, now)
        %{"ok" => true}
      else
        _ -> nil
      end
    end)
    |> unwrap_transaction_result()
  end

  def send_run_signal(run_id, signal_name, payload) do
    now = Infrastructure.now_iso8601()
    signal_id = "sig_" <> Ecto.UUID.generate()
    payload_json = Jason.encode!(payload)

    Repo.transaction(fn ->
      case get_run(run_id) do
        nil ->
          nil

        _run ->
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
            [signal_id, run_id, signal_name, payload_json, now]
          )

          append_event!(
            run_id,
            "SignalReceived",
            %{"signal" => signal_name, "payload" => payload},
            now
          )

          wait =
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

          if wait do
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
              [payload_json, now, run_id, wait["op_key"]]
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
                "key" => wait["op_key"],
                "signal" => signal_name,
                "payload" => payload
              },
              now
            )
          end

          %{
            "id" => signal_id,
            "runId" => run_id,
            "name" => signal_name,
            "payload" => payload,
            "consumedAt" => if(wait, do: now, else: nil),
            "createdAt" => now
          }
      end
    end)
    |> unwrap_transaction_result()
  end

  def list_runs(project_name \\ nil), do: ReadModels.list_runs(project_name)

  def get_run(run_id), do: ReadModels.get_run(run_id)

  def get_run_for_inspect(run_id) do
    case get_run(run_id) do
      nil ->
        nil

      %{"definitionKind" => "service"} ->
        run_id
        |> get_service_run_by_id()
        |> Kernel.||(get_run(run_id))
        |> decorate_service_passivation()

      run ->
        run
    end
  end

  def runnable_activation_available? do
    now = Infrastructure.now_iso8601()
    not is_nil(next_activation_candidate(now))
  end

  def list_run_events(run_id), do: ReadModels.list_run_events(run_id)

  def list_run_steps(run_id), do: ReadModels.list_run_steps(run_id)

  def list_active_timed_steps, do: ReadModels.list_active_timed_steps()

  def list_run_execs(run_id), do: ReadModels.list_run_execs(run_id)

  def list_run_waits(run_id), do: ReadModels.list_run_waits(run_id)

  def list_run_signals(run_id), do: ReadModels.list_run_signals(run_id)

  def list_run_children(run_id), do: ReadModels.list_run_children(run_id)

  def list_service_envelopes(service_run_id),
    do: ReadModels.list_service_envelopes(service_run_id)

  def ensure_column!(table_name, column_name, definition) do
    Support.ensure_column!(table_name, column_name, definition)
  end


  defp decorate_service_passivation(nil), do: nil

  defp decorate_service_passivation(%{"definitionKind" => "service"} = run) do
    now = Infrastructure.now_iso8601()
    queued = queued_mailbox_summary(run["id"], now)
    waits = list_waiting_wait_rows(run["id"])
    wake_on = waits |> Enum.map(&passivation_wake_kind(&1["wait_kind"])) |> Enum.uniq()
    next_wait_wake_at = earliest_wake_at(Enum.map(waits, & &1["wake_at"]))

    passivation =
      case run["status"] do
        "active" ->
          %{
            "state" => "active",
            "reason" => "leased",
            "wakeOn" => [],
            "queuedMessages" => queued["total"] || 0,
            "nextWakeAt" => earliest_wake_at([queued["nextWakeAt"], next_wait_wake_at])
          }

        "pending" ->
          %{
            "state" => "ready",
            "reason" => "mailbox_ready",
            "wakeOn" => ["mailbox"],
            "queuedMessages" => queued["total"] || 0,
            "nextWakeAt" => earliest_wake_at([queued["nextWakeAt"], next_wait_wake_at])
          }

        "waiting" ->
          %{
            "state" => "passivated",
            "reason" => if(wake_on == [], do: "durable_wait", else: Enum.join(wake_on, ",")),
            "wakeOn" => wake_on,
            "queuedMessages" => queued["total"] || 0,
            "nextWakeAt" => earliest_wake_at([queued["nextWakeAt"], next_wait_wake_at])
          }

        "stopped" ->
          %{
            "state" => "stopped",
            "reason" => "stopped",
            "wakeOn" => [],
            "queuedMessages" => queued["total"] || 0,
            "nextWakeAt" => nil
          }

        _ ->
          %{
            "state" => "passivated",
            "reason" =>
              if((queued["total"] || 0) > 0, do: "mailbox_deferred", else: "mailbox_empty"),
            "wakeOn" => ["mailbox"],
            "queuedMessages" => queued["total"] || 0,
            "nextWakeAt" => earliest_wake_at([queued["nextWakeAt"], next_wait_wake_at])
          }
      end

    Map.put(run, "passivation", passivation)
  end

  defp decorate_service_passivation(run), do: run

  defp ensure_service_run_in_tx!(
         project,
         definition,
         service_key,
         key_input,
         now,
         caller_run_id \\ nil,
         lease_id \\ nil,
         must_exist \\ false
       ) do
    project_name = Map.fetch!(project, "name")
    definition_name = Map.fetch!(definition, "name")

    if is_binary(caller_run_id) and caller_run_id != "" and is_binary(lease_id) and lease_id != "" do
      ensure_fenced_run_ownership!(caller_run_id, lease_id, now)
    end

    service_run =
      case get_service_run(project_name, definition_name, service_key) do
        nil when must_exist ->
          nil

        nil ->
          run_id = deterministic_service_run_id(project_name, definition_name, service_key)
          definitions_json = Jason.encode!(Map.fetch!(project, "definitions"))

          SQL.query!(
            Repo,
            """
            insert or ignore into runs (
              id,
              project_name,
              definition_kind,
              definition_name,
              project_snapshot_path,
              project_definitions_json,
              definition_file,
              definition_export_name,
              definition_runtime_kind,
              definition_source_language,
              status,
              lease_id,
              lease_worker_id,
              lease_expires_at,
              input_json,
              output_json,
              error_json,
              created_at,
              updated_at
            ) values (?, ?, 'service', ?, ?, ?, ?, ?, ?, ?, 'idle', null, null, null, ?, null, null, ?, ?)
            """,
            [
              run_id,
              project_name,
              definition_name,
              Map.get(project, "snapshotPath") || Map.fetch!(project, "path"),
              definitions_json,
              Map.fetch!(definition, "file"),
              Map.fetch!(definition, "exportName"),
              Map.fetch!(definition, "runtimeKind"),
              Map.fetch!(definition, "sourceLanguage"),
              Jason.encode!(key_input || %{}),
              now,
              now
            ]
          )

          inserted_service_rows =
            write_changes!(
              """
              insert or ignore into service_runs (
                run_id,
                service_key,
                key_input_json,
                state_json,
                created_at,
                updated_at
              ) values (?, ?, ?, null, ?, ?)
              """,
              [run_id, service_key, Jason.encode!(key_input || %{}), now, now]
            )

          if inserted_service_rows == 1 do
            append_event!(
              run_id,
              "ServiceInstantiated",
              %{
                "serviceKey" => service_key,
                "definitionName" => definition_name,
                "keyInput" => key_input || %{}
              },
              now
            )
          end

          get_service_run(project_name, definition_name, service_key)

        service_run ->
          service_run
      end

    case service_run do
      nil ->
        nil

      resolved ->
        record_service_ref!(caller_run_id, resolved["id"], now)

        if is_binary(caller_run_id) and caller_run_id != "" and is_binary(lease_id) and
             lease_id != "" do
          ensure_fenced_run_ownership!(caller_run_id, lease_id, now)
        end

        resolved
    end
  end

  defp get_run_by_lease(lease_id) do
    now = Infrastructure.now_iso8601()

    Repo
    |> SQL.query!(
      """
      select
        id,
        project_name,
        definition_kind,
        definition_name,
        project_snapshot_path,
        project_definitions_json,
        definition_file,
        definition_export_name,
        definition_runtime_kind,
        definition_source_language,
        status,
        lease_id,
        lease_auth_token,
        lease_worker_id,
        lease_expires_at,
        input_json,
        output_json,
        error_json,
        created_at,
        updated_at
      from runs
      where
        lease_id = ?
        and status in ('running', 'active')
        and lease_expires_at is not null
        and lease_expires_at >= ?
      """,
      [lease_id, now]
    )
    |> rows_to_maps()
    |> List.first()
    |> case do
      nil -> nil
      row -> run_from_row(row)
    end
  end

  defp get_fenced_run_by_lease(lease_id, now) do
    case get_run_by_lease(lease_id) do
      nil ->
        nil

      run ->
        if acquire_lease_write_fence(run["id"], lease_id, now) do
          run
        else
          nil
        end
    end
  end

  defp acquire_lease_write_fence(run_id, lease_id, now) do
    write_changes!(
      """
      update runs
      set updated_at = updated_at
      where
        id = ?
        and lease_id = ?
        and status in ('running', 'active')
        and lease_expires_at is not null
        and lease_expires_at >= ?
      """,
      [run_id, lease_id, now]
    ) == 1
  end

  defp ensure_fenced_run_write!(run_id, lease_id, now, query, params) do
    if acquire_lease_write_fence(run_id, lease_id, now) do
      SQL.query!(Repo, query, params)
      :ok
    else
      Repo.rollback(:stale_candidate)
    end
  end

  defp ensure_fenced_run_ownership!(run_id, lease_id, now) do
    if acquire_lease_write_fence(run_id, lease_id, now) do
      :ok
    else
      Repo.rollback(:stale_candidate)
    end
  end

  defp ensure_fenced_related_write!(
         run_id,
         lease_id,
         now,
         query,
         params,
         expected_rows \\ 1
       ) do
    changed_rows =
      write_changes!(
        query,
        params ++ [run_id, lease_id, now]
      )

    if changed_rows == expected_rows do
      :ok
    else
      Repo.rollback(:stale_candidate)
    end
  end

  defp lease_auth_token_valid?(lease_id, lease_auth_token)
       when is_binary(lease_id) and lease_id != "" and is_binary(lease_auth_token) and
              lease_auth_token != "" do
    now = Infrastructure.now_iso8601()

    Repo
    |> SQL.query!(
      """
      select 1
      from runs
      where
        lease_id = ?
        and lease_auth_token = ?
        and status in ('running', 'active')
        and lease_expires_at is not null
        and lease_expires_at >= ?
      limit 1
      """,
      [lease_id, lease_auth_token, now]
    )
    |> first_integer() == 1
  end

  defp lease_auth_token_valid?(_lease_id, _lease_auth_token), do: false

  defp ensure_run_activation_pinned!(run) do
    if activation_pinned?(run) do
      {:ok, run}
    else
      {:error, {:unresumable_candidate, run}}
    end
  end

  defp activation_pinned?(run) do
    is_binary(run["projectSnapshotPath"]) and run["projectSnapshotPath"] != "" and
      is_map(run["definition"]) and
      is_binary(get_in(run, ["definition", "file"])) and get_in(run, ["definition", "file"]) != "" and
      is_binary(get_in(run, ["definition", "exportName"])) and
      get_in(run, ["definition", "exportName"]) != "" and
      is_binary(get_in(run, ["definition", "runtimeKind"])) and
      get_in(run, ["definition", "runtimeKind"]) != "" and
      is_binary(get_in(run, ["definition", "sourceLanguage"])) and
      get_in(run, ["definition", "sourceLanguage"]) != ""
  end

  defp invalidate_unpinned_run!(%{"definitionKind" => "service"} = run, now) do
    _ =
      stop_service_run_instance!(
        get_service_run_by_id(run["id"]),
        legacy_run_error(),
        "missing_pinned_definition",
        now
      )

    :ok
  end

  defp invalidate_unpinned_run!(run, now) do
    SQL.query!(
      Repo,
      """
      update runs
      set
        status = 'failed',
        lease_id = null,
        lease_auth_token = null,
        lease_worker_id = null,
        lease_expires_at = null,
        error_json = ?,
        updated_at = ?
      where id = ?
      """,
      [Jason.encode!(legacy_run_error()), now, run["id"]]
    )

    append_event!(run["id"], "RunFailed", %{"error" => legacy_run_error()}, now)
    wake_waiting_parents_for_child!(run["id"], "failed", legacy_run_error(), now)
    maybe_apply_supervision_for_terminal_run!(run["id"], now)
    maybe_trigger_relationships_for_terminal_run!(run["id"], now)
    :ok
  end

  defp legacy_run_error do
    %{
      "message" =>
        "Run cannot be resumed safely because this runtime did not record an immutable project snapshot and definition payload when it started",
      "reason" => "missing_pinned_definition"
    }
  end


  defp create_supervision_member_generation!(
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

  defp supervised_child_op_key(group_id, member_key, generation) do
    "supervision:" <> group_id <> ":" <> member_key <> ":" <> Integer.to_string(generation)
  end

  defp supervision_member_result_state(owner_run_id, group_id, member_key) do
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
                get_run(member["current_child_run_id"])
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

  defp fail_workflow_run_instance!(run, error_body, now, lease_id \\ nil) do
    if terminal_run_status?(run["status"]) do
      %{
        "run" => get_run(run["id"]),
        "status" => run["status"],
        "activeLeaseWorkerId" => run["leaseWorkerId"]
      }
    else
      if is_binary(lease_id) and lease_id != "" do
        ensure_fenced_run_write!(
          run["id"],
          lease_id,
          now,
          """
          update runs
          set
            status = 'failed',
            lease_id = null,
            lease_auth_token = null,
            lease_worker_id = null,
            lease_expires_at = null,
            output_json = null,
            error_json = ?,
            updated_at = ?
          where id = ?
          """,
          [Jason.encode!(error_body), now, run["id"]]
        )
      else
        SQL.query!(
          Repo,
          """
          update runs
          set
            status = 'failed',
            lease_id = null,
            lease_auth_token = null,
            lease_worker_id = null,
            lease_expires_at = null,
            output_json = null,
            error_json = ?,
            updated_at = ?
          where id = ?
          """,
          [Jason.encode!(error_body), now, run["id"]]
        )
      end

      append_event!(run["id"], "RunFailed", %{"error" => error_body}, now)
      wake_waiting_parents_for_child!(run["id"], "failed", error_body, now)
      maybe_apply_supervision_for_terminal_run!(run["id"], now)
      maybe_trigger_relationships_for_terminal_run!(run["id"], now)

      %{
        "run" => get_run(run["id"]),
        "status" => "failed",
        "activeLeaseWorkerId" => run["leaseWorkerId"]
      }
    end
  end

  defp cancel_workflow_run_instance!(run, error_body, reason, now) do
    if terminal_run_status?(run["status"]) do
      %{
        "run" => get_run(run["id"]),
        "cancelledWaitCount" => 0,
        "cancelledChildRunCount" => 0,
        "cancelledServiceAskCount" => 0,
        "hadActiveLease" => false
      }
    else
      SQL.query!(
        Repo,
        """
        update runs
        set
          status = 'cancelled',
          lease_id = null,
          lease_auth_token = null,
          lease_worker_id = null,
          lease_expires_at = null,
          output_json = null,
          error_json = ?,
          updated_at = ?
        where id = ?
        """,
        [Jason.encode!(error_body), now, run["id"]]
      )

      cancelled_wait_count = cancel_waiting_waits!(run["id"], error_body, now)
      _cancelled_step_count = cancel_running_steps!(run["id"], error_body, now)
      _cancelled_exec_count = cancel_running_execs!(run["id"], error_body, now)

      cancelled_service_ask_count =
        cancel_outbound_service_asks!(run["id"], error_body, reason, now)

      cancelled_child_run_count =
        cancel_child_runs_for_parent!(run["id"], error_body, reason, now)

      append_event!(
        run["id"],
        "RunCancelled",
        %{
          "reason" => reason,
          "hadActiveLease" => not is_nil(run["leaseId"]),
          "cancelledWaitCount" => cancelled_wait_count,
          "cancelledChildRunCount" => cancelled_child_run_count,
          "cancelledServiceAskCount" => cancelled_service_ask_count,
          "error" => error_body
        },
        now
      )

      wake_waiting_parents_for_child!(run["id"], "cancelled", error_body, now)
      maybe_apply_supervision_for_terminal_run!(run["id"], now)
      maybe_trigger_relationships_for_terminal_run!(run["id"], now)

      %{
        "run" => get_run(run["id"]),
        "cancelledWaitCount" => cancelled_wait_count,
        "cancelledChildRunCount" => cancelled_child_run_count,
        "cancelledServiceAskCount" => cancelled_service_ask_count,
        "hadActiveLease" => not is_nil(run["leaseId"]),
        "activeLeaseWorkerId" => run["leaseWorkerId"]
      }
    end
  end

  defp stop_service_run_instance!(service_run, error_body, reason, now, lease_id \\ nil)

  defp stop_service_run_instance!(nil, _error_body, _reason, _now, _lease_id), do: nil

  defp stop_service_run_instance!(service_run, error_body, reason, now, lease_id) do
    if service_run["status"] == "stopped" do
      %{
        "run" => service_run,
        "stoppedEnvelopeCount" => 0,
        "cancelledWaitCount" => 0,
        "cancelledChildRunCount" => 0,
        "cancelledServiceAskCount" => 0,
        "hadInFlightTurn" => false,
        "hadActiveLease" => false
      }
    else
      open_envelopes = list_open_service_envelopes(service_run["id"])
      had_in_flight_turn = Enum.any?(open_envelopes, &(&1["status"] == "processing"))

      if is_binary(lease_id) and lease_id != "" do
        ensure_fenced_run_write!(
          service_run["id"],
          lease_id,
          now,
          """
          update runs
          set
            status = 'stopped',
            lease_id = null,
            lease_auth_token = null,
            lease_worker_id = null,
            lease_expires_at = null,
            output_json = null,
            error_json = ?,
            updated_at = ?
          where id = ?
          """,
          [Jason.encode!(error_body), now, service_run["id"]]
        )
      else
        SQL.query!(
          Repo,
          """
          update runs
          set
            status = 'stopped',
            lease_id = null,
            lease_auth_token = null,
            lease_worker_id = null,
            lease_expires_at = null,
            output_json = null,
            error_json = ?,
            updated_at = ?
          where id = ?
          """,
          [Jason.encode!(error_body), now, service_run["id"]]
        )
      end

      Enum.each(open_envelopes, fn envelope ->
        fail_service_open_envelope!(service_run, envelope, error_body, reason, now, true)
      end)

      cancelled_wait_count = cancel_waiting_waits!(service_run["id"], error_body, now)
      _cancelled_step_count = cancel_running_steps!(service_run["id"], error_body, now)
      _cancelled_exec_count = cancel_running_execs!(service_run["id"], error_body, now)

      cancelled_service_ask_count =
        cancel_outbound_service_asks!(service_run["id"], error_body, reason, now)

      cancelled_child_run_count =
        cancel_child_runs_for_parent!(service_run["id"], error_body, reason, now)

      append_event!(
        service_run["id"],
        "ServiceStopped",
        %{
          "reason" => reason,
          "hadActiveLease" => not is_nil(service_run["leaseId"]),
          "hadInFlightTurn" => had_in_flight_turn,
          "stoppedEnvelopeCount" => length(open_envelopes),
          "cancelledWaitCount" => cancelled_wait_count,
          "cancelledChildRunCount" => cancelled_child_run_count,
          "cancelledServiceAskCount" => cancelled_service_ask_count
        },
        now
      )

      maybe_trigger_relationships_for_terminal_run!(service_run["id"], now)

      %{
        "run" => get_service_run_by_id(service_run["id"]),
        "stoppedEnvelopeCount" => length(open_envelopes),
        "cancelledWaitCount" => cancelled_wait_count,
        "cancelledChildRunCount" => cancelled_child_run_count,
        "cancelledServiceAskCount" => cancelled_service_ask_count,
        "hadInFlightTurn" => had_in_flight_turn,
        "hadActiveLease" => not is_nil(service_run["leaseId"]),
        "activeLeaseWorkerId" => service_run["leaseWorkerId"]
      }
    end
  end

  defp timeout_result_for_run!(run, error_body, now, lease_id) do
    case run["definitionKind"] do
      "workflow" ->
        fail_workflow_run_instance!(run, error_body, now, lease_id)

      "service" ->
        case get_processing_service_envelope_for_run(run["id"]) do
          nil ->
            if is_binary(lease_id) and lease_id != "" do
              ensure_fenced_run_write!(
                run["id"],
                lease_id,
                now,
                """
                update runs
                set
                  status = 'idle',
                  lease_id = null,
                  lease_auth_token = null,
                  lease_worker_id = null,
                  lease_expires_at = null,
                  updated_at = ?
                where id = ?
                """,
                [now, run["id"]]
              )
            else
              SQL.query!(
                Repo,
                """
                update runs
                set
                  status = 'idle',
                  lease_id = null,
                  lease_auth_token = null,
                  lease_worker_id = null,
                  lease_expires_at = null,
                  updated_at = ?
                where id = ?
                """,
                [now, run["id"]]
              )
            end

            %{
              "run" => get_run(run["id"]),
              "status" => "idle",
              "activeLeaseWorkerId" => run["leaseWorkerId"]
            }

          envelope ->
            SQL.query!(
              Repo,
              """
              update service_envelopes
              set
                status = 'failed',
                error_json = ?,
                wake_at = null,
                updated_at = ?
              where id = ?
              """,
              [Jason.encode!(error_body), now, envelope["id"]]
            )

            append_event!(
              run["id"],
              "TurnFailed",
              %{
                "envelopeId" => envelope["id"],
                "kind" => envelope["kind"],
                "name" => envelope["name"],
                "error" => error_body
              },
              now
            )

            if envelope["kind"] == "ask" do
              wake_service_ask_waiter!(envelope["correlation_id"], "failed", error_body, now)
            end

            next_status = service_next_status(run["id"], false)

            SQL.query!(
              Repo,
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
              [next_status, now, run["id"]]
            )

            %{
              "run" => get_run(run["id"]),
              "status" => next_status,
              "activeLeaseWorkerId" => run["leaseWorkerId"]
            }
        end
    end
  end

  defp fail_step_attempt!(run, step, name, error_body, now, lease_id) do
    ensure_fenced_run_ownership!(run["id"], lease_id, now)

    encoded_error = Jason.encode!(error_body)
    attempt = step_attempt(step)
    max_attempts = RetryPolicy.normalize_max_attempts(step["max_attempts"])
    retry_on = decode_json_list(step["retry_on_json"])

    backoff =
      compute_backoff_details(
        %{
          "backoffKind" => step["backoff_kind"],
          "backoffMs" => step["backoff_ms"],
          "backoffStepMs" => step["backoff_step_ms"],
          "backoffFactor" => step["backoff_factor"],
          "maxBackoffMs" => step["max_backoff_ms"],
          "backoffJitterKind" => step["backoff_jitter_kind"],
          "backoffJitterRatio" => step["backoff_jitter_ratio"]
        },
        attempt,
        {"step", run["id"], step["op_key"]}
      )

    backoff_kind = backoff["backoffKind"]
    backoff_ms = backoff["backoffMs"]
    decision = retry_decision(error_body, attempt, max_attempts, retry_on)
    wake_at = if decision["willRetry"], do: shift_milliseconds(now, backoff_ms), else: nil

    append_event!(
      run["id"],
      "StepFailed",
      %{
        "name" => name,
        "key" => step["op_key"],
        "attempt" => attempt,
        "maxAttempts" => max_attempts,
        "backoffKind" => backoff_kind,
        "backoffMs" => backoff_ms,
        "backoffBaseMs" => backoff["backoffBaseMs"],
        "backoffCappedMs" => backoff["backoffCappedMs"],
        "backoffCapMs" => backoff["backoffCapMs"],
        "backoffJitterKind" => backoff["backoffJitterKind"],
        "backoffJitterRatio" => backoff["backoffJitterRatio"],
        "backoffJitterMs" => backoff["backoffJitterMs"],
        "retryOn" => retry_on,
        "retryFamily" => decision["retryFamily"],
        "retryable" => decision["retryable"],
        "willRetry" => decision["willRetry"],
        "retryDecision" => decision["retryDecision"],
        "nextAttempt" => if(decision["willRetry"], do: attempt + 1, else: nil),
        "wakeAt" => wake_at,
        "error" => error_body
      },
      now
    )

    if decision["willRetry"] do
      wait_key = retry_wait_key("step", step["op_key"])

      ensure_fenced_related_write!(
        run["id"],
        lease_id,
        now,
        """
        update run_steps
        set
          name = ?,
          status = 'retry_waiting',
          error_json = ?,
          updated_at = ?
        where
          run_id = ?
          and op_key = ?
          and #{@fenced_run_exists_sql}
        """,
        [name, encoded_error, now, run["id"], step["op_key"]]
      )

      schedule_retry_wait!(
        run,
        wait_key,
        %{
          "operationKind" => "step",
          "operationKey" => step["op_key"],
          "operationName" => name,
          "attempt" => attempt,
          "nextAttempt" => attempt + 1,
          "maxAttempts" => max_attempts,
          "backoffKind" => backoff_kind,
          "backoffMs" => backoff_ms,
          "backoffBaseMs" => backoff["backoffBaseMs"],
          "backoffCappedMs" => backoff["backoffCappedMs"],
          "backoffCapMs" => backoff["backoffCapMs"],
          "backoffJitterKind" => backoff["backoffJitterKind"],
          "backoffJitterRatio" => backoff["backoffJitterRatio"],
          "backoffJitterMs" => backoff["backoffJitterMs"],
          "retryOn" => retry_on,
          "wakeAt" => wake_at
        },
        now,
        lease_id
      )

      %{
        "status" => "retry_waiting",
        "runId" => run["id"],
        "key" => step["op_key"],
        "wait" => %{
          "runId" => run["id"],
          "key" => wait_key,
          "kind" => "retry_backoff",
          "name" => name,
          "status" => "waiting",
          "wakeAt" => wake_at
        }
      }
    else
      ensure_fenced_related_write!(
        run["id"],
        lease_id,
        now,
        """
        update run_steps
        set
          name = ?,
          status = 'failed',
          error_json = ?,
          updated_at = ?
        where
          run_id = ?
          and op_key = ?
          and #{@fenced_run_exists_sql}
        """,
        [name, encoded_error, now, run["id"], step["op_key"]]
      )

      %{
        "status" => "failed",
        "error" => error_body,
        "runId" => run["id"],
        "key" => step["op_key"]
      }
    end
  end

  defp fail_exec_attempt!(run, exec, name, op_key, body, now, lease_id) do
    ensure_fenced_run_ownership!(run["id"], lease_id, now)

    error_body = Map.get(body, "error", %{})
    encoded_error = Jason.encode!(error_body)
    attempt = exec["attempt"] || 1
    max_attempts = RetryPolicy.normalize_max_attempts(Map.get(body, "maxAttempts"))
    retry_on = RetryPolicy.normalize_retry_on(Map.get(body, "retryOn"))
    backoff = compute_backoff_details(body, attempt, {"exec", run["id"], op_key})
    backoff_kind = backoff["backoffKind"]
    backoff_ms = backoff["backoffMs"]
    decision = retry_decision(error_body, attempt, max_attempts, retry_on)
    wake_at = if decision["willRetry"], do: shift_milliseconds(now, backoff_ms), else: nil

    append_event!(
      run["id"],
      "ProcessFailed",
      %{
        "name" => name,
        "key" => op_key,
        "attempt" => attempt,
        "maxAttempts" => max_attempts,
        "backoffKind" => backoff_kind,
        "backoffMs" => backoff_ms,
        "backoffBaseMs" => backoff["backoffBaseMs"],
        "backoffCappedMs" => backoff["backoffCappedMs"],
        "backoffCapMs" => backoff["backoffCapMs"],
        "backoffJitterKind" => backoff["backoffJitterKind"],
        "backoffJitterRatio" => backoff["backoffJitterRatio"],
        "backoffJitterMs" => backoff["backoffJitterMs"],
        "retryOn" => retry_on,
        "retryFamily" => decision["retryFamily"],
        "retryable" => decision["retryable"],
        "willRetry" => decision["willRetry"],
        "retryDecision" => decision["retryDecision"],
        "nextAttempt" => if(decision["willRetry"], do: attempt + 1, else: nil),
        "wakeAt" => wake_at,
        "exitCode" => Map.get(body, "exitCode"),
        "signalCode" => Map.get(body, "signalCode"),
        "stdoutRef" => Map.get(body, "stdoutRef"),
        "stderrRef" => Map.get(body, "stderrRef"),
        "artifacts" => Map.get(body, "artifacts", []),
        "error" => error_body
      },
      now
    )

    if decision["willRetry"] do
      wait_key = retry_wait_key("exec", op_key)

      ensure_fenced_related_write!(
        run["id"],
        lease_id,
        now,
        """
        update run_execs
        set
          name = ?,
          status = 'retry_waiting',
          exit_code = ?,
          signal_code = ?,
          stdout_ref = ?,
          stderr_ref = ?,
          artifacts_json = ?,
          output_json = null,
          error_json = ?,
          updated_at = ?
        where
          run_id = ?
          and op_key = ?
          and #{@fenced_run_exists_sql}
        """,
        [
          name,
          Map.get(body, "exitCode"),
          Map.get(body, "signalCode"),
          Map.get(body, "stdoutRef"),
          Map.get(body, "stderrRef"),
          Jason.encode!(Map.get(body, "artifacts", [])),
          encoded_error,
          now,
          run["id"],
          op_key
        ]
      )

      schedule_retry_wait!(
        run,
        wait_key,
        %{
          "operationKind" => "exec",
          "operationKey" => op_key,
          "operationName" => name,
          "attempt" => attempt,
          "nextAttempt" => attempt + 1,
          "maxAttempts" => max_attempts,
          "backoffKind" => backoff_kind,
          "backoffMs" => backoff_ms,
          "backoffBaseMs" => backoff["backoffBaseMs"],
          "backoffCappedMs" => backoff["backoffCappedMs"],
          "backoffCapMs" => backoff["backoffCapMs"],
          "backoffJitterKind" => backoff["backoffJitterKind"],
          "backoffJitterRatio" => backoff["backoffJitterRatio"],
          "backoffJitterMs" => backoff["backoffJitterMs"],
          "retryOn" => retry_on,
          "wakeAt" => wake_at
        },
        now,
        lease_id
      )

      %{
        "status" => "retry_waiting",
        "error" => error_body,
        "wait" => %{
          "runId" => run["id"],
          "key" => wait_key,
          "kind" => "retry_backoff",
          "name" => name,
          "status" => "waiting",
          "wakeAt" => wake_at
        }
      }
    else
      ensure_fenced_related_write!(
        run["id"],
        lease_id,
        now,
        """
        update run_execs
        set
          name = ?,
          status = 'failed',
          exit_code = ?,
          signal_code = ?,
          stdout_ref = ?,
          stderr_ref = ?,
          artifacts_json = ?,
          output_json = null,
          error_json = ?,
          updated_at = ?
        where
          run_id = ?
          and op_key = ?
          and #{@fenced_run_exists_sql}
        """,
        [
          name,
          Map.get(body, "exitCode"),
          Map.get(body, "signalCode"),
          Map.get(body, "stdoutRef"),
          Map.get(body, "stderrRef"),
          Jason.encode!(Map.get(body, "artifacts", [])),
          encoded_error,
          now,
          run["id"],
          op_key
        ]
      )

      exec = get_run_exec(run["id"], op_key)
      %{"status" => "failed", "error" => decode_json_value(exec["error_json"], nil)}
    end
  end

  defp fail_service_turn_attempt!(service_run, envelope, error_body, retry_options, now, lease_id) do
    ensure_fenced_run_ownership!(service_run["id"], lease_id, now)

    max_attempts = RetryPolicy.normalize_max_attempts(Map.get(retry_options, "maxAttempts"))
    attempt = envelope["attempt"] || 1
    retry_on = RetryPolicy.normalize_retry_on(Map.get(retry_options, "retryOn"))

    backoff =
      compute_backoff_details(
        retry_options,
        attempt,
        {"service_turn", service_run["id"], envelope["id"]}
      )

    backoff_kind = backoff["backoffKind"]
    backoff_ms = backoff["backoffMs"]
    decision = retry_decision(error_body, attempt, max_attempts, retry_on)
    wake_at = if decision["willRetry"], do: shift_milliseconds(now, backoff_ms), else: nil

    append_event!(
      service_run["id"],
      "TurnFailed",
      %{
        "envelopeId" => envelope["id"],
        "kind" => envelope["kind"],
        "name" => envelope["name"],
        "attempt" => attempt,
        "maxAttempts" => max_attempts,
        "backoffKind" => backoff_kind,
        "backoffMs" => backoff_ms,
        "backoffBaseMs" => backoff["backoffBaseMs"],
        "backoffCappedMs" => backoff["backoffCappedMs"],
        "backoffCapMs" => backoff["backoffCapMs"],
        "backoffJitterKind" => backoff["backoffJitterKind"],
        "backoffJitterRatio" => backoff["backoffJitterRatio"],
        "backoffJitterMs" => backoff["backoffJitterMs"],
        "retryOn" => retry_on,
        "retryFamily" => decision["retryFamily"],
        "retryable" => decision["retryable"],
        "willRetry" => decision["willRetry"],
        "retryDecision" => decision["retryDecision"],
        "nextAttempt" => if(decision["willRetry"], do: attempt + 1, else: nil),
        "wakeAt" => wake_at,
        "error" => error_body
      },
      now
    )

    if decision["willRetry"] do
      next_attempt = attempt + 1
      wait_key = retry_wait_key("turn", envelope["id"])

      ensure_fenced_related_write!(
        service_run["id"],
        lease_id,
        now,
        """
        update service_envelopes
        set
          attempt = ?,
          error_json = ?,
          wake_at = null,
          updated_at = ?
        where
          id = ?
          and #{@fenced_run_exists_sql}
        """,
        [next_attempt, maybe_encode_json(error_body), now, envelope["id"]]
      )

      schedule_retry_wait!(
        service_run,
        wait_key,
        %{
          "operationKind" => "service_turn",
          "operationKey" => envelope["id"],
          "operationName" => envelope["name"],
          "attempt" => attempt,
          "nextAttempt" => next_attempt,
          "maxAttempts" => max_attempts,
          "backoffKind" => backoff_kind,
          "backoffMs" => backoff_ms,
          "backoffBaseMs" => backoff["backoffBaseMs"],
          "backoffCappedMs" => backoff["backoffCappedMs"],
          "backoffCapMs" => backoff["backoffCapMs"],
          "backoffJitterKind" => backoff["backoffJitterKind"],
          "backoffJitterRatio" => backoff["backoffJitterRatio"],
          "backoffJitterMs" => backoff["backoffJitterMs"],
          "retryOn" => retry_on,
          "wakeAt" => wake_at
        },
        now,
        lease_id
      )

      %{
        "status" => "retry_waiting",
        "run" => get_run(service_run["id"]),
        "wait" => %{
          "runId" => service_run["id"],
          "key" => wait_key,
          "kind" => "retry_backoff",
          "name" => envelope["name"],
          "status" => "waiting",
          "wakeAt" => wake_at
        }
      }
    else
      ensure_fenced_related_write!(
        service_run["id"],
        lease_id,
        now,
        """
        update service_envelopes
        set
          status = 'failed',
          error_json = ?,
          wake_at = null,
          updated_at = ?
        where
          id = ?
          and #{@fenced_run_exists_sql}
        """,
        [Jason.encode!(error_body), now, envelope["id"]]
      )

      if envelope["kind"] == "ask" do
        wake_service_ask_waiter!(envelope["correlation_id"], "failed", error_body, now)
      end

      next_status = service_next_status(service_run["id"], false)

      ensure_fenced_run_write!(
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

      get_run(service_run["id"])
    end
  end

  defp schedule_retry_wait!(run, wait_key, body, now, lease_id) do
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
      ) values (?, ?, 'retry_backoff', ?, 'waiting', ?, null, ?, ?)
      on conflict(run_id, op_key) do update set
        wait_kind = excluded.wait_kind,
        wait_name = excluded.wait_name,
        status = 'waiting',
        wake_at = excluded.wake_at,
        output_json = null,
        updated_at = excluded.updated_at
      """,
      [
        run["id"],
        wait_key,
        Map.fetch!(body, "operationName"),
        Map.fetch!(body, "wakeAt"),
        now,
        now
      ]
    )

    ensure_fenced_run_write!(
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
      "RetryScheduled",
      %{
        "kind" => Map.fetch!(body, "operationKind"),
        "operationKey" => Map.fetch!(body, "operationKey"),
        "name" => Map.fetch!(body, "operationName"),
        "attempt" => Map.fetch!(body, "attempt"),
        "nextAttempt" => Map.fetch!(body, "nextAttempt"),
        "maxAttempts" => Map.fetch!(body, "maxAttempts"),
        "backoffKind" => Map.get(body, "backoffKind"),
        "backoffMs" => Map.fetch!(body, "backoffMs"),
        "backoffBaseMs" => Map.get(body, "backoffBaseMs"),
        "backoffCappedMs" => Map.get(body, "backoffCappedMs"),
        "backoffCapMs" => Map.get(body, "backoffCapMs"),
        "backoffJitterKind" => Map.get(body, "backoffJitterKind"),
        "backoffJitterRatio" => Map.get(body, "backoffJitterRatio"),
        "backoffJitterMs" => Map.get(body, "backoffJitterMs"),
        "retryOn" => Map.get(body, "retryOn"),
        "waitKey" => wait_key,
        "wakeAt" => Map.fetch!(body, "wakeAt")
      },
      now
    )

    append_event!(
      run["id"],
      "WaitRegistered",
      %{
        "kind" => "retry_backoff",
        "key" => wait_key,
        "name" => Map.fetch!(body, "operationName"),
        "operationKind" => Map.fetch!(body, "operationKind"),
        "operationKey" => Map.fetch!(body, "operationKey"),
        "attempt" => Map.fetch!(body, "attempt"),
        "nextAttempt" => Map.fetch!(body, "nextAttempt"),
        "backoffKind" => Map.get(body, "backoffKind"),
        "backoffMs" => Map.get(body, "backoffMs"),
        "backoffBaseMs" => Map.get(body, "backoffBaseMs"),
        "backoffCappedMs" => Map.get(body, "backoffCappedMs"),
        "backoffCapMs" => Map.get(body, "backoffCapMs"),
        "backoffJitterKind" => Map.get(body, "backoffJitterKind"),
        "backoffJitterRatio" => Map.get(body, "backoffJitterRatio"),
        "backoffJitterMs" => Map.get(body, "backoffJitterMs"),
        "wakeAt" => Map.fetch!(body, "wakeAt")
      },
      now
    )

    append_event!(
      run["id"],
      "RunSuspended",
      %{
        "reason" => "retry_backoff",
        "key" => wait_key,
        "operationKind" => Map.fetch!(body, "operationKind"),
        "operationKey" => Map.fetch!(body, "operationKey"),
        "name" => Map.fetch!(body, "operationName"),
        "backoffKind" => Map.get(body, "backoffKind"),
        "backoffMs" => Map.get(body, "backoffMs"),
        "backoffBaseMs" => Map.get(body, "backoffBaseMs"),
        "backoffCappedMs" => Map.get(body, "backoffCappedMs"),
        "backoffCapMs" => Map.get(body, "backoffCapMs"),
        "backoffJitterKind" => Map.get(body, "backoffJitterKind"),
        "backoffJitterRatio" => Map.get(body, "backoffJitterRatio"),
        "backoffJitterMs" => Map.get(body, "backoffJitterMs"),
        "wakeAt" => Map.fetch!(body, "wakeAt")
      },
      now
    )

    maybe_append_service_turn_waiting!(
      run,
      %{
        "waitKind" => "retry_backoff",
        "key" => wait_key,
        "name" => Map.fetch!(body, "operationName"),
        "operationKind" => Map.fetch!(body, "operationKind"),
        "operationKey" => Map.fetch!(body, "operationKey"),
        "wakeAt" => Map.fetch!(body, "wakeAt")
      },
      now
    )
  end

  defp step_attempt(step), do: step["attempt"] || 1

  defp retry_wait_key(kind, op_key), do: "retry:" <> kind <> ":" <> op_key

  defp retry_decision(error_body, attempt, max_attempts, retry_on),
    do: RetryPolicy.retry_decision(error_body, attempt, max_attempts, retry_on)

  defp compute_backoff_details(policy, attempt, seed),
    do: RetryPolicy.compute_backoff_details(policy, attempt, seed)

  defp cancel_waiting_waits!(run_id, error_body, now) do
    waits = list_waiting_wait_rows(run_id)

    Enum.each(waits, fn wait ->
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
        [maybe_encode_json(error_body), now, wait["run_id"], wait["op_key"]]
      )
    end)

    length(waits)
  end

  defp cancel_running_steps!(run_id, error_body, now) do
    steps = list_running_step_rows(run_id)

    Enum.each(steps, fn step ->
      VilanoKernel.StepDeadlineManager.clear_step(step["run_id"], step["op_key"])

      SQL.query!(
        Repo,
        """
        update run_steps
        set
          status = 'cancelled',
          error_json = ?,
          updated_at = ?
        where run_id = ? and op_key = ?
        """,
        [maybe_encode_json(error_body), now, step["run_id"], step["op_key"]]
      )

      append_event!(
        run_id,
        "StepCancelled",
        %{
          "name" => step["name"],
          "key" => step["op_key"],
          "error" => error_body
        },
        now
      )
    end)

    length(steps)
  end

  defp cancel_running_execs!(run_id, error_body, now) do
    execs = list_running_exec_rows(run_id)

    Enum.each(execs, fn exec ->
      SQL.query!(
        Repo,
        """
        update run_execs
        set
          status = 'cancelled',
          error_json = ?,
          updated_at = ?
        where run_id = ? and op_key = ?
        """,
        [maybe_encode_json(error_body), now, exec["run_id"], exec["op_key"]]
      )

      append_event!(
        run_id,
        "ProcessCancelled",
        %{
          "name" => exec["name"],
          "key" => exec["op_key"],
          "attempt" => exec["attempt"],
          "error" => error_body
        },
        now
      )
    end)

    length(execs)
  end

  defp cancel_outbound_service_asks!(caller_run_id, error_body, reason, now) do
    ops = list_waiting_service_ask_ops(caller_run_id)

    Enum.each(ops, fn op ->
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
        [maybe_encode_json(error_body), now, op["caller_run_id"], op["op_key"]]
      )

      if is_binary(op["correlation_id"]) do
        cancel_service_envelope_by_correlation!(
          op["service_run_id"],
          op["correlation_id"],
          error_body,
          reason,
          now
        )
      end
    end)

    length(ops)
  end

  defp cancel_service_envelope_by_correlation!(
         service_run_id,
         correlation_id,
         error_body,
         reason,
         now
       ) do
    case get_open_service_envelope_by_correlation(service_run_id, correlation_id) do
      nil ->
        :ok

      envelope ->
        service_run = get_service_run_by_id(service_run_id)

        if service_run do
          fail_service_open_envelope!(service_run, envelope, error_body, reason, now, false)
        end
    end
  end

  defp fail_service_open_envelope!(service_run, envelope, error_body, reason, now, wake_waiter?) do
    SQL.query!(
      Repo,
      """
      update service_envelopes
      set
        status = 'failed',
        error_json = ?,
        wake_at = null,
        updated_at = ?
      where id = ?
      """,
      [Jason.encode!(error_body), now, envelope["id"]]
    )

    if wake_waiter? and envelope["kind"] == "ask" and envelope["correlation_id"] do
      wake_service_ask_waiter!(envelope["correlation_id"], "failed", error_body, now)
    end

    if envelope["status"] == "processing" do
      append_event!(
        service_run["id"],
        "TurnFailed",
        %{
          "envelopeId" => envelope["id"],
          "kind" => envelope["kind"],
          "name" => envelope["name"],
          "error" => error_body
        },
        now
      )

      _ = cancel_waiting_waits!(service_run["id"], error_body, now)
      _ = cancel_running_steps!(service_run["id"], error_body, now)
      _ = cancel_running_execs!(service_run["id"], error_body, now)
      _ = cancel_outbound_service_asks!(service_run["id"], error_body, reason, now)
      _ = cancel_child_runs_for_parent!(service_run["id"], error_body, reason, now)
    end

    next_status = service_next_status(service_run["id"], false)

    SQL.query!(
      Repo,
      """
      update runs
      set
        status = ?,
        lease_id = null,
        lease_auth_token = null,
        lease_worker_id = null,
        lease_expires_at = null,
        updated_at = ?
      where id = ? and status != 'stopped'
      """,
      [next_status, now, service_run["id"]]
    )
  end

  defp cancel_child_runs_for_parent!(parent_run_id, error_body, reason, now) do
    children = list_open_child_rows(parent_run_id)

    Enum.each(children, fn child ->
      case get_run(child["child_run_id"]) do
        nil ->
          :ok

        child_run ->
          _ = cancel_workflow_run_instance!(child_run, error_body, reason, now)
      end
    end)

    length(children)
  end

  defp terminal_run_status?(status), do: status in ["completed", "failed", "cancelled", "stopped"]

  defp cancellation_error(message, reason) do
    %{
      "name" => "CancelledError",
      "message" => message,
      "reason" => reason
    }
  end

  defp next_activation_candidate(now) do
    workflow_candidate = next_workflow_activation_candidate(now)
    service_candidate = next_service_activation_candidate(now)

    cond do
      workflow_candidate == nil and service_candidate == nil ->
        nil

      workflow_candidate == nil ->
        {:service_turn, service_candidate}

      service_candidate == nil ->
        {:workflow, workflow_candidate}

      workflow_candidate["created_at"] <= service_candidate["created_at"] ->
        {:workflow, workflow_candidate}

      true ->
        {:service_turn, service_candidate}
    end
  end

  defp next_workflow_activation_candidate(now) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        project_name,
        definition_kind,
        definition_name,
        status,
        lease_id,
        lease_worker_id,
        lease_expires_at,
        input_json,
        output_json,
        error_json,
        created_at,
        updated_at
      from runs
      where
        definition_kind = 'workflow'
        and status in ('pending', 'running')
        and (lease_expires_at is null or lease_expires_at < ?)
      order by created_at asc
      limit 1
      """,
      [now]
    )
    |> rows_to_maps()
    |> List.first()
  end

  defp next_service_activation_candidate(now) do
    Repo
    |> SQL.query!(
      """
      select
        e.id,
        e.service_run_id,
        e.kind,
        e.name,
        e.attempt,
        e.payload_json,
        e.correlation_id,
        e.sender_run_id,
        e.status as envelope_status,
        e.reply_json,
        e.error_json,
        e.wake_at,
        e.created_at,
        e.updated_at,
        r.status as run_status,
        r.lease_expires_at as run_lease_expires_at
      from service_envelopes e
      join runs r on r.id = e.service_run_id
      where
        (e.status = 'processing' or (e.status = 'queued' and (e.wake_at is null or e.wake_at <= ?)))
        and r.definition_kind = 'service'
        and r.status in ('idle', 'pending', 'active')
        and (r.lease_expires_at is null or r.lease_expires_at < ?)
      order by
        case when e.status = 'processing' then 0 else 1 end asc,
        e.created_at asc
      limit 1
      """,
      [now, now]
    )
    |> rows_to_maps()
    |> List.first()
  end

  defp maybe_commit_service_state!(_run_id, nil, _now, _lease_id), do: :unchanged

  defp maybe_commit_service_state!(run_id, state, now, lease_id) do
    current = get_service_run_by_id(run_id)
    encoded_state = Jason.encode!(state)
    initial? = is_nil(current["state"])

    ensure_fenced_related_write!(
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

  defp resolve_run_relationship(lease_id, target_run_id, op_key, kind, propagate) do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        owner_run ->
          cond do
            not related_run_visible?(owner_run["id"], target_run_id) ->
              nil

            true ->
              case get_run_for_inspect(target_run_id) do
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

  defp maybe_apply_supervision_for_terminal_run!(run_id, now) do
    case AgentKernel.get_run_supervision_member_by_child(run_id) do
      nil ->
        :ok

      member ->
        case {AgentKernel.get_run_supervision_group_by_id(member["group_id"]), get_run(run_id)} do
          {nil, _} ->
            :ok

          {_, nil} ->
            :ok

          {group, child_run} ->
            case get_run_for_inspect(group["owner_run_id"]) do
              nil ->
                :ok

              owner_run ->
                if group["status"] != "active" or terminal_run_status?(owner_run["status"]) or
                     member["current_child_run_id"] != run_id or
                     not terminal_run_status?(child_run["status"]) do
                  :ok
                else
                  apply_supervision_policy!(owner_run, group, member, child_run, now)
                end
            end
        end
    end
  end

  defp apply_supervision_policy!(owner_run, group, member, child_run, now) do
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

  defp supervision_restart_allowed?(group, now) do
    AgentKernel.count_recent_supervision_restarts(
      group["id"],
      shift_milliseconds(now, -group["window_ms"])
    ) <
      group["max_restarts"]
  end

  defp record_supervision_restart!(group_id, member_key, child_run_id, now) do
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

  defp restart_supervision_member!(owner_run, group, member, now) do
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

  defp restart_supervision_group_members!(owner_run, group, triggering_member, child_run, now) do
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
        case get_run(member["current_child_run_id"]) do
          nil ->
            :ok

          sibling_run ->
            unless terminal_run_status?(sibling_run["status"]) do
              _ =
                cancel_workflow_run_instance!(
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

  defp member_selected_for_one_for_all_restart?(member, triggering_member) do
    member["member_key"] == triggering_member["member_key"] or
      (is_binary(member["current_child_run_id"]) and
         case get_run(member["current_child_run_id"]) do
           nil -> false
           child_run -> not terminal_run_status?(child_run["status"])
         end)
  end

  defp exhaust_supervision_group!(owner_run, group, member, child_run, now) do
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
        case get_run(current_member["current_child_run_id"]) do
          nil ->
            :ok

          open_child ->
            unless terminal_run_status?(open_child["status"]) do
              _ =
                cancel_workflow_run_instance!(
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
            stop_service_run_instance!(owner_run, error_body, "supervision_exhausted", now)

          _ ->
            fail_workflow_run_instance!(owner_run, error_body, now)
        end

      _ ->
        :ok
    end
  end

  defp supervision_restart_error(group, member, child_run) do
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

  defp supervision_exhausted_error(group, member, child_run) do
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

  defp maybe_trigger_relationships_for_terminal_run!(run_id, now) do
    case get_run_for_inspect(run_id) do
      nil ->
        :ok

      target_run ->
        Enum.each(AgentKernel.list_active_run_relationships_for_target(run_id), fn relationship ->
          maybe_trigger_run_relationship!(relationship, target_run, now)
        end)
    end
  end

  defp maybe_trigger_run_relationship!(relationship, target_run, now) do
    if relationship["status"] != "active" or not terminal_run_status?(target_run["status"]) do
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

      case get_run_for_inspect(relationship["owner_run_id"]) do
        nil ->
          :ok

        owner_run ->
          if terminal_run_status?(owner_run["status"]) do
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

  defp queue_exit_event!(run_id, relationship_id, event, now) do
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

  defp deliver_oldest_pending_exit_event!(run_id, now) do
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

  defp propagate_linked_exit!(owner_run, target_run, event, now) do
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
        stop_service_run_instance!(owner_run, error_body, "linked_exit", now)

      _ ->
        _ = cancel_workflow_run_instance!(owner_run, error_body, "linked_exit", now)
        :ok
    end
  end

  defp linked_exit_error(target_run, event) do
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

  defp maybe_run_storage_test_hook(name, payload) do
    hooks = Application.get_env(:vilano_kernel, :storage_test_hooks, %{})

    case Map.get(hooks, name) do
      hook when is_function(hook, 1) -> hook.(payload)
      _ -> :ok
    end
  end

  defp wake_waiting_parents_for_child!(child_run_id, child_status, payload, now) do
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

  defp wake_waiting_supervision_member_results!(group_id, member_key, result_status, payload, now) do
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

  defp unwrap_transaction_result({:ok, value}), do: value
  defp unwrap_transaction_result({:error, reason}), do: raise(reason)
end
