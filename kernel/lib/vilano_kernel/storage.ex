defmodule VilanoKernel.Storage do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage.{RetryPolicy, ServiceLifecycle}

  def init! do
    SQL.query!(Repo, "pragma journal_mode = wal", [])
    SQL.query!(Repo, "pragma foreign_keys = on", [])
    SQL.query!(Repo, "pragma busy_timeout = 5000", [])

    SQL.query!(
      Repo,
      """
      create table if not exists projects (
        name text primary key,
        path text not null,
        last_synced_at text,
        definitions_manifest_hash text,
        workflows_json text not null,
        services_json text not null
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists runs (
        id text primary key,
        project_name text not null,
        definition_kind text not null,
        definition_name text not null,
        status text not null,
        lease_id text,
        lease_worker_id text,
        lease_expires_at text,
        input_json text not null,
        output_json text,
        error_json text,
        created_at text not null,
        updated_at text not null
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_events (
        id text primary key,
        run_id text not null,
        seq integer not null,
        event_type text not null,
        body_json text not null,
        created_at text not null,
        unique (run_id, seq)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_steps (
        run_id text not null,
        op_key text not null,
        name text not null,
        status text not null,
        attempt integer,
        max_attempts integer,
        backoff_kind text,
        backoff_ms integer,
        backoff_step_ms integer,
        backoff_factor real,
        max_backoff_ms integer,
        backoff_jitter_kind text,
        backoff_jitter_ratio real,
        retry_on_json text,
        timeout_ms integer,
        output_json text,
        error_json text,
        created_at text not null,
        updated_at text not null,
        primary key (run_id, op_key)
      )
      """,
      []
    )

    ensure_column!("run_steps", "attempt", "integer")
    ensure_column!("run_steps", "max_attempts", "integer")
    ensure_column!("run_steps", "backoff_kind", "text")
    ensure_column!("run_steps", "backoff_ms", "integer")
    ensure_column!("run_steps", "backoff_step_ms", "integer")
    ensure_column!("run_steps", "backoff_factor", "real")
    ensure_column!("run_steps", "max_backoff_ms", "integer")
    ensure_column!("run_steps", "backoff_jitter_kind", "text")
    ensure_column!("run_steps", "backoff_jitter_ratio", "real")
    ensure_column!("run_steps", "retry_on_json", "text")
    ensure_column!("run_steps", "timeout_ms", "integer")
    ensure_column!("run_steps", "error_json", "text")

    SQL.query!(
      Repo,
      """
      create table if not exists run_execs (
        run_id text not null,
        op_key text not null,
        name text not null,
        status text not null,
        cmd text not null,
        args_json text not null,
        cwd text,
        env_json text,
        timeout_ms integer,
        attempt integer not null,
        exit_code integer,
        signal_code text,
        stdout_ref text,
        stderr_ref text,
        artifacts_json text,
        output_json text,
        error_json text,
        created_at text not null,
        updated_at text not null,
        primary key (run_id, op_key)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_waits (
        run_id text not null,
        op_key text not null,
        wait_kind text not null,
        wait_name text not null,
        status text not null,
        wake_at text,
        output_json text,
        created_at text not null,
        updated_at text not null,
        primary key (run_id, op_key)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_children (
        parent_run_id text not null,
        op_key text not null,
        child_run_id text not null,
        definition_name text not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        primary key (parent_run_id, op_key),
        unique (child_run_id)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists service_runs (
        run_id text primary key,
        service_key text not null,
        key_input_json text not null,
        state_json text,
        created_at text not null,
        updated_at text not null,
        unique (run_id)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists service_envelopes (
        id text primary key,
        service_run_id text not null,
        kind text not null,
        name text not null,
        attempt integer,
        payload_json text,
        correlation_id text,
        sender_run_id text,
        status text not null,
        reply_json text,
        error_json text,
        created_at text not null,
        updated_at text not null
      )
      """,
      []
    )

    ensure_column!("service_envelopes", "attempt", "integer")

    SQL.query!(
      Repo,
      """
      create table if not exists run_service_ops (
        caller_run_id text not null,
        op_key text not null,
        service_run_id text not null,
        op_kind text not null,
        message_name text not null,
        correlation_id text,
        status text not null,
        payload_json text not null,
        response_json text,
        error_json text,
        created_at text not null,
        updated_at text not null,
        primary key (caller_run_id, op_key)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_signals (
        id text primary key,
        run_id text not null,
        signal_name text not null,
        payload_json text,
        consumed_at text,
        created_at text not null
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists runs_project_created_at_idx
      on runs(project_name, created_at desc)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_events_run_seq_idx
      on run_events(run_id, seq)
      """,
      []
    )
  end

  def project_count do
    Repo
    |> SQL.query!("select count(*) from projects", [])
    |> first_integer()
  end

  def list_projects do
    Repo
    |> SQL.query!(
      """
      select
        name,
        path,
        last_synced_at,
        definitions_manifest_hash,
        workflows_json,
        services_json
      from projects
      order by name asc
      """,
      []
    )
    |> rows_to_maps()
    |> Enum.map(&project_from_row/1)
  end

  def get_project(name) do
    Repo
    |> SQL.query!(
      """
      select
        name,
        path,
        last_synced_at,
        definitions_manifest_hash,
        workflows_json,
        services_json
      from projects
      where name = ?
      """,
      [name]
    )
    |> rows_to_maps()
    |> List.first()
    |> case do
      nil -> nil
      row -> project_from_row(row)
    end
  end

  def upsert_project!(project) do
    workflows_json = Jason.encode!(get_in(project, ["definitions", "workflows"]) || [])
    services_json = Jason.encode!(get_in(project, ["definitions", "services"]) || [])

    Repo.transaction(fn ->
      SQL.query!(
        Repo,
        """
        insert into projects (
          name,
          path,
          last_synced_at,
          definitions_manifest_hash,
          workflows_json,
          services_json
        ) values (?, ?, ?, ?, ?, ?)
        on conflict(name) do update set
          path = excluded.path,
          last_synced_at = excluded.last_synced_at,
          definitions_manifest_hash = excluded.definitions_manifest_hash,
          workflows_json = excluded.workflows_json,
          services_json = excluded.services_json
        """,
        [
          Map.fetch!(project, "name"),
          Map.fetch!(project, "path"),
          Map.get(project, "lastSyncedAt"),
          Map.get(project, "definitionsManifestHash"),
          workflows_json,
          services_json
        ]
      )
    end)

    get_project(Map.fetch!(project, "name"))
  end

  def remove_project(name) do
    project = get_project(name)

    if project do
      SQL.query!(Repo, "delete from projects where name = ?", [name])
    end

    project
  end

  def list_definitions(kind, project_name \\ nil)

  def list_definitions(kind, nil) do
    list_projects()
    |> Enum.flat_map(&definitions_for_kind(&1, kind))
  end

  def list_definitions(kind, project_name) do
    case get_project(project_name) do
      nil -> nil
      project -> definitions_for_kind(project, kind)
    end
  end

  def get_definition(project_name, kind, definition_name) do
    with project when not is_nil(project) <- get_project(project_name) do
      definitions_for_kind(project, kind)
      |> Enum.find(&(&1["name"] == definition_name))
    end
  end

  def create_workflow_run!(project_name, definition_name, input) do
    now = now_iso8601()
    run_id = "run_" <> Ecto.UUID.generate()

    Repo.transaction(fn ->
      insert_workflow_run!(run_id, project_name, definition_name, input || %{}, now)
    end)

    get_run(run_id)
  end

  def ensure_service_run!(project_name, definition_name, service_key, key_input) do
    now = now_iso8601()

    Repo.transaction(fn ->
      case get_service_run(project_name, definition_name, service_key) do
        nil ->
          run_id = "run_" <> Ecto.UUID.generate()

          SQL.query!(
            Repo,
            """
            insert into runs (
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
            ) values (?, ?, 'service', ?, 'idle', null, null, null, ?, null, null, ?, ?)
            """,
            [run_id, project_name, definition_name, Jason.encode!(key_input || %{}), now, now]
          )

          SQL.query!(
            Repo,
            """
            insert into service_runs (
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

          get_service_run(project_name, definition_name, service_key)

        service_run ->
          service_run
      end
    end)
    |> unwrap_transaction_result()
  end

  def find_service_run(project_name, definition_name, service_key) do
    get_service_run(project_name, definition_name, service_key)
  end

  def enqueue_service_envelope!(project_name, definition_name, service_key, key_input, kind, name, payload) do
    now = now_iso8601()

    Repo.transaction(fn ->
      service_run = ensure_service_run!(project_name, definition_name, service_key, key_input || %{})

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
    now = now_iso8601()

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
    now = now_iso8601()

    Repo.transaction(fn ->
      case get_run(run_id) do
        nil ->
          nil

        %{"definitionKind" => "service"} ->
          service_run = get_service_run_by_id(run_id)
          stop_service_run_instance!(service_run, cancellation_error("Service stopped", reason), reason, now)

        run ->
          cancel_workflow_run_instance!(run, cancellation_error("Run cancelled", reason), reason, now)
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
          {"where r.definition_kind = 'service' and r.project_name = ? and r.status not in ('idle', 'stopped')", [project]}
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
  end

  def resolve_spawn(lease_id, definition_name, op_key, child_run_id, input) do
    now = now_iso8601()

    Repo.transaction(fn ->
      case get_run_by_lease(lease_id) do
        nil ->
          nil

        parent_run ->
          existing_child = get_run_child(parent_run["id"], op_key)

          if existing_child do
            %{"status" => "existing", "childRun" => get_run(existing_child["child_run_id"])}
          else
            insert_workflow_run!(
              child_run_id,
              parent_run["project"],
              definition_name,
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

            %{"status" => "created", "childRun" => get_run(child_run_id)}
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_child_result_wait(lease_id, child_run_id, op_key) do
    now = now_iso8601()
    wait_key = "child_result:" <> child_run_id

    Repo.transaction(fn ->
      case get_run_by_lease(lease_id) do
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

                      child_run["status"] == "failed" ->
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

                          SQL.query!(
                            Repo,
                            """
                            update runs
                            set
                              status = 'waiting',
                              lease_id = null,
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
                            %{"kind" => "child_result", "key" => wait_key, "childRunId" => child_run_id},
                            now
                          )

                          append_event!(
                            parent_run["id"],
                            "RunSuspended",
                            %{"reason" => "child_result", "key" => wait_key, "childRunId" => child_run_id},
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
    end)
    |> unwrap_transaction_result()
  end

  def resolve_service_send(lease_id, service_run_id, name, op_key, payload) do
    now = now_iso8601()

    Repo.transaction(fn ->
      case {get_run_by_lease(lease_id), get_service_run_by_id(service_run_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {caller_run, service_run} ->
          case get_run_service_op(caller_run["id"], op_key) do
            existing when not is_nil(existing) ->
              %{"status" => existing["status"]}

            nil ->
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
                    [caller_run["id"], op_key, service_run_id, name, Jason.encode!(payload), now, now]
                  )

                  append_event!(
                    caller_run["id"],
                    "MessageSent",
                    %{"key" => op_key, "serviceRunId" => service_run_id, "name" => name, "payload" => payload},
                    now
                  )

                  %{"status" => "completed"}

                {:error, error} ->
                  %{"status" => "failed", "error" => error}
              end
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_service_signal(lease_id, service_run_id, name, op_key, payload) do
    now = now_iso8601()

    Repo.transaction(fn ->
      case {get_run_by_lease(lease_id), get_service_run_by_id(service_run_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {caller_run, service_run} ->
          case get_run_service_op(caller_run["id"], op_key) do
            existing when not is_nil(existing) ->
              %{"status" => existing["status"]}

            nil ->
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
                    [caller_run["id"], op_key, service_run_id, name, Jason.encode!(payload), now, now]
                  )

                  append_event!(
                    caller_run["id"],
                    "SignalSent",
                    %{"key" => op_key, "serviceRunId" => service_run_id, "name" => name, "payload" => payload},
                    now
                  )

                  %{"status" => "completed"}

                {:error, error} ->
                  %{"status" => "failed", "error" => error}
              end
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_service_ask(lease_id, service_run_id, name, op_key, payload) do
    now = now_iso8601()
    correlation_id = "ask:" <> op_key

    Repo.transaction(fn ->
      case {get_run_by_lease(lease_id), get_service_run_by_id(service_run_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {caller_run, service_run} ->
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
                      "wakeAt" => nil,
                      "output" => nil
                    }
                  }
              end

            nil ->
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
                    ) values (?, ?, 'ask_reply', ?, 'waiting', null, null, ?, ?)
                    on conflict(run_id, op_key) do update set
                      wait_kind = excluded.wait_kind,
                      wait_name = excluded.wait_name,
                      status = 'waiting',
                      wake_at = null,
                      output_json = null,
                      updated_at = excluded.updated_at
                    """,
                    [caller_run["id"], "ask_reply:" <> correlation_id, correlation_id, now, now]
                  )

                  SQL.query!(
                    Repo,
                    """
                    update runs
                    set
                      status = 'waiting',
                      lease_id = null,
                      lease_worker_id = null,
                      lease_expires_at = null,
                      updated_at = ?
                    where id = ?
                    """,
                    [now, caller_run["id"]]
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
                    %{"kind" => "ask_reply", "key" => "ask_reply:" <> correlation_id, "correlationId" => correlation_id},
                    now
                  )

                  append_event!(
                    caller_run["id"],
                    "RunSuspended",
                    %{"reason" => "ask_reply", "key" => "ask_reply:" <> correlation_id, "correlationId" => correlation_id},
                    now
                  )

                  maybe_append_service_turn_waiting!(
                    caller_run,
                    %{
                      "waitKind" => "ask_reply",
                      "key" => "ask_reply:" <> correlation_id,
                      "name" => correlation_id,
                      "correlationId" => correlation_id
                    },
                    now
                  )

                  %{
                    "status" => "suspended",
                    "wait" => %{
                      "runId" => caller_run["id"],
                      "key" => "ask_reply:" <> correlation_id,
                      "kind" => "ask_reply",
                      "name" => correlation_id,
                      "status" => "waiting",
                      "wakeAt" => nil,
                      "output" => nil
                    }
                  }

                {:error, error} ->
                  %{"status" => "failed", "error" => error}
              end
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def complete_service_turn(lease_id, envelope_id, body) do
    now = now_iso8601()

    Repo.transaction(fn ->
      case {get_run_by_lease(lease_id), get_service_envelope(envelope_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {service_run, envelope} ->
          if envelope["service_run_id"] == service_run["id"] do
            state = Map.get(body, "state")

            state_commit = maybe_commit_service_state!(service_run["id"], state, now)

            SQL.query!(
              Repo,
              """
              update service_envelopes
              set
                status = 'completed',
                reply_json = ?,
                error_json = null,
                updated_at = ?
              where id = ?
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

              wake_service_ask_waiter!(envelope["correlation_id"], "completed", Map.get(body, "reply"), now)
            end

            append_event!(
              service_run["id"],
              "TurnCompleted",
              %{"envelopeId" => envelope_id, "kind" => envelope["kind"], "name" => envelope["name"]},
              now
            )

            next_status = service_next_status(service_run["id"], Map.get(body, "stop") == true)

            SQL.query!(
              Repo,
              """
              update runs
              set
                status = ?,
                lease_id = null,
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
    now = now_iso8601()

    Repo.transaction(fn ->
      case {get_run_by_lease(lease_id), get_service_envelope(envelope_id)} do
        {nil, _} ->
          nil

        {_, nil} ->
          nil

        {service_run, envelope} ->
          if envelope["service_run_id"] == service_run["id"] do
            fail_service_turn_attempt!(service_run, envelope, error_body, retry_options, now)
          else
            nil
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def lease_next_run(worker_id) do
    now = now_iso8601()
    expires_at = shift_seconds(now, lease_duration_seconds())

    Repo.transaction(fn ->
      case next_activation_candidate(now) do
        nil ->
          nil

        {:workflow, candidate} ->
          lease_id = "lease_" <> Ecto.UUID.generate()
          run_id = candidate["id"]

          SQL.query!(
            Repo,
            """
            update runs
            set
              status = 'running',
              lease_id = ?,
              lease_worker_id = ?,
              lease_expires_at = ?,
              updated_at = ?
            where id = ?
            """,
            [lease_id, worker_id, expires_at, now, run_id]
          )

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

          %{lease_id: lease_id, lease_expires_at: expires_at, activation_kind: "workflow", run: get_run(run_id)}

        {:service_turn, candidate} ->
          lease_id = "lease_" <> Ecto.UUID.generate()
          run_id = candidate["service_run_id"]
          envelope_id = candidate["id"]
          attempt =
            cond do
              candidate["envelope_status"] == "queued" ->
                candidate["attempt"] || 1

              candidate["run_status"] == "active" and not is_nil(candidate["run_lease_expires_at"]) ->
                (candidate["attempt"] || 0) + 1

              true ->
                candidate["attempt"] || 1
            end

          SQL.query!(
            Repo,
            """
            update runs
            set
              status = 'active',
              lease_id = ?,
              lease_worker_id = ?,
              lease_expires_at = ?,
              updated_at = ?
            where id = ?
            """,
            [lease_id, worker_id, expires_at, now, run_id]
          )

          if candidate["envelope_status"] == "queued" do
            SQL.query!(
              Repo,
              """
              update service_envelopes
              set
                status = 'processing',
                attempt = ?,
                updated_at = ?
              where id = ?
              """,
              [attempt, now, envelope_id]
            )

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
            SQL.query!(
              Repo,
              """
              update service_envelopes
              set
                attempt = ?,
                updated_at = ?
              where id = ?
              """,
              [attempt, now, envelope_id]
            )

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

          %{
            lease_id: lease_id,
            lease_expires_at: expires_at,
            activation_kind: "service_turn",
            run: get_run(run_id),
            service: get_service_run_by_id(run_id),
            envelope: service_envelope_from_row(get_service_envelope(envelope_id))
          }
      end
    end)
    |> unwrap_transaction_result()
  end

  def heartbeat_lease(lease_id, worker_id) do
    now = now_iso8601()
    expires_at = shift_seconds(now, lease_duration_seconds())

    updated_rows =
      SQL.query!(
        Repo,
        """
        update runs
        set lease_expires_at = ?, updated_at = ?
        where lease_id = ? and lease_worker_id = ? and status in ('running', 'active')
        """,
        [expires_at, now, lease_id, worker_id]
      ).num_rows

    if updated_rows > 0, do: %{"leaseExpiresAt" => expires_at}, else: nil
  end

  def lease_status(lease_id) do
    now = now_iso8601()

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
    now = now_iso8601()

    Repo.transaction(fn ->
      case get_run_by_lease(lease_id) do
        nil ->
          nil

        run ->
          SQL.query!(
            Repo,
            """
            update runs
            set
              status = 'completed',
              lease_id = null,
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
          get_run(run["id"])
      end
    end)
    |> unwrap_transaction_result()
  end

  def fail_run_lease(lease_id, error_body) do
    now = now_iso8601()

    Repo.transaction(fn ->
      case get_run_by_lease(lease_id) do
        nil ->
          nil

        run ->
          SQL.query!(
            Repo,
            """
            update runs
            set
              status = 'failed',
              lease_id = null,
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
    now = now_iso8601()

    result =
      Repo.transaction(fn ->
        case get_run_by_lease(lease_id) do
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

                    existing && is_integer(existing["max_attempts"]) && existing["max_attempts"] > 0 ->
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
                    is_integer(Map.get(retry_policy, "backoffMs")) and Map.get(retry_policy, "backoffMs") >= 0 ->
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

                    existing && is_integer(existing["backoff_step_ms"]) && existing["backoff_step_ms"] >= 0 ->
                      existing["backoff_step_ms"]

                    true ->
                      nil
                  end

                persisted_backoff_factor =
                  cond do
                    is_number(Map.get(retry_policy, "backoffFactor")) and Map.get(retry_policy, "backoffFactor") > 0 ->
                      Map.get(retry_policy, "backoffFactor")

                    existing && is_number(existing["backoff_factor"]) && existing["backoff_factor"] > 0 ->
                      existing["backoff_factor"]

                    true ->
                      nil
                  end

                persisted_max_backoff_ms =
                  cond do
                    is_integer(Map.get(retry_policy, "maxBackoffMs")) and Map.get(retry_policy, "maxBackoffMs") >= 0 ->
                      Map.get(retry_policy, "maxBackoffMs")

                    existing && is_integer(existing["max_backoff_ms"]) && existing["max_backoff_ms"] >= 0 ->
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
                      RetryPolicy.normalize_backoff_jitter_ratio(nil, persisted_backoff_jitter_kind)
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
    now = now_iso8601()

    result =
      Repo.transaction(fn ->
        case get_run_by_lease(lease_id) do
          nil ->
            nil

        run ->
          case get_run_step_row(run["id"], op_key) do
            nil ->
              nil

            _step ->
              SQL.query!(
                Repo,
                """
                update run_steps
                set
                  name = ?,
                  status = 'completed',
                  output_json = ?,
                  error_json = null,
                  updated_at = ?
                where run_id = ? and op_key = ?
                """,
                [name, Jason.encode!(output), now, run["id"], op_key]
              )

              append_event!(
                run["id"],
                "StepCompleted",
                %{"name" => name, "key" => op_key, "output" => output},
                now
              )

              %{"status" => "completed", "output" => output, "runId" => run["id"], "key" => op_key}
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
    now = now_iso8601()

    result =
      Repo.transaction(fn ->
        case get_run_by_lease(lease_id) do
          nil ->
            nil

        run ->
          case get_run_step_row(run["id"], op_key) do
            nil ->
              nil

            step ->
              fail_step_attempt!(run, step, name, error_body, now)
          end
      end
    end)
    |> unwrap_transaction_result()

    if is_map(result) && result["status"] in ["failed", "retry_waiting"] do
      VilanoKernel.StepDeadlineManager.clear_step(result["runId"], result["key"])
    end

    result
  end

  def timeout_step(lease_id, op_key, error_body) do
    now = now_iso8601()

    result =
      Repo.transaction(fn ->
        case get_run_by_lease(lease_id) do
          nil ->
            nil

          run ->
            case get_run_step_row(run["id"], op_key) do
              nil ->
                nil

              step ->
                if step["status"] != "running" do
                  nil
                else
                  case fail_step_attempt!(run, step, step["name"], error_body, now) do
                    %{"status" => "retry_waiting", "wait" => wait} ->
                      %{
                        "run" => get_run(run["id"]),
                        "status" => "waiting",
                        "activeLeaseWorkerId" => run["leaseWorkerId"],
                        "wait" => wait
                      }

                    _ ->
                      timeout_result_for_run!(run, error_body, now)
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
    now = now_iso8601()

    Repo.transaction(fn ->
      case get_run_by_lease(lease_id) do
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
                  if(is_map(env_map), do: Jason.encode!(env_map), else: nil),
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
    now = now_iso8601()

    Repo.transaction(fn ->
      case get_run_by_lease(lease_id) do
        nil ->
          nil

        run ->
          case get_run_exec(run["id"], op_key) do
            nil ->
              nil

            existing ->
              SQL.query!(
                Repo,
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
                where run_id = ? and op_key = ?
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
    now = now_iso8601()

    Repo.transaction(fn ->
      case get_run_by_lease(lease_id) do
        nil ->
          nil

        run ->
          case get_run_exec(run["id"], op_key) do
            nil ->
              nil

            existing ->
              fail_exec_attempt!(run, existing, name, op_key, body, now)
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_sleep_wait(lease_id, op_key, duration_ms) do
    now = now_iso8601()
    wake_at = shift_milliseconds(now, duration_ms)

    Repo.transaction(fn ->
      case get_run_by_lease(lease_id) do
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

              SQL.query!(
                Repo,
                """
                update runs
                set
                  status = 'waiting',
                  lease_id = null,
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

  def satisfy_timed_wait(run_id, op_key) do
    now = now_iso8601()

    Repo.transaction(fn ->
      case get_run_wait(run_id, op_key) do
        nil ->
          nil

        wait ->
          if wait["status"] != "waiting" or is_nil(wait["wake_at"]) do
            nil
          else
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
    now = now_iso8601()

    Repo.transaction(fn ->
      case get_run_by_lease(lease_id) do
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
              case get_pending_signal(run["id"], name) do
                nil ->
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

                  SQL.query!(
                    Repo,
                    """
                    update runs
                    set
                      status = 'waiting',
                      lease_id = null,
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
    end)
    |> unwrap_transaction_result()
  end

  def send_run_signal(run_id, signal_name, payload) do
    now = now_iso8601()
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

  def list_runs(project_name \\ nil) do
    query =
      if is_nil(project_name) do
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
        order by created_at desc
        """
      else
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
        where project_name = ?
        order by created_at desc
        """
      end

    args = if is_nil(project_name), do: [], else: [project_name]

    Repo
    |> SQL.query!(query, args)
    |> rows_to_maps()
    |> Enum.map(&run_from_row/1)
  end

  def get_run(run_id) do
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
      where id = ?
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> List.first()
    |> case do
      nil -> nil
      row -> run_from_row(row)
    end
  end

  def get_run_for_inspect(run_id) do
    case get_run(run_id) do
      nil ->
        nil

      %{"definitionKind" => "service"} ->
        get_service_run_by_id(run_id) || get_run(run_id)

      run ->
        run
    end
  end

  def list_run_events(run_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        run_id,
        seq,
        event_type,
        body_json,
        created_at
      from run_events
      where run_id = ?
      order by seq asc
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&run_event_from_row/1)
  end

  def list_run_steps(run_id) do
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
      where run_id = ?
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&step_from_row/1)
  end

  def list_active_timed_steps do
    Repo
    |> SQL.query!(
      """
      select
        s.run_id,
        s.op_key,
        s.name,
        s.timeout_ms,
        s.updated_at,
        r.lease_id,
        r.lease_worker_id
      from run_steps s
      join runs r on r.id = s.run_id
      where
        s.status = 'running'
        and s.timeout_ms is not null
        and r.status in ('running', 'active')
        and r.lease_id is not null
      order by s.updated_at asc
      """,
      []
    )
    |> rows_to_maps()
    |> Enum.map(fn row ->
      %{
        "runId" => row["run_id"],
        "key" => row["op_key"],
        "name" => row["name"],
        "timeoutMs" => row["timeout_ms"],
        "startedAt" => row["updated_at"],
        "leaseId" => row["lease_id"],
        "leaseWorkerId" => row["lease_worker_id"]
      }
    end)
  end

  def list_run_execs(run_id) do
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
      where run_id = ?
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&exec_from_row/1)
  end

  def list_run_waits(run_id) do
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
      where run_id = ?
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&wait_from_row/1)
  end

  def list_run_signals(run_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        run_id,
        signal_name,
        payload_json,
        consumed_at,
        created_at
      from run_signals
      where run_id = ?
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&signal_from_row/1)
  end

  def list_run_children(run_id) do
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
      where parent_run_id = ?
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&child_from_row/1)
  end

  def list_service_envelopes(service_run_id) do
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
        created_at,
        updated_at
      from service_envelopes
      where service_run_id = ?
      order by created_at asc
      """,
      [service_run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&service_envelope_from_row/1)
  end

  defp definitions_for_kind(project, "workflow"), do: project["definitions"]["workflows"]
  defp definitions_for_kind(project, "service"), do: project["definitions"]["services"]

  defp project_from_row(row) do
    %{
      "name" => row["name"],
      "path" => row["path"],
      "lastSyncedAt" => row["last_synced_at"],
      "definitionsManifestHash" => row["definitions_manifest_hash"],
      "definitions" => %{
        "workflows" => decode_json_list(row["workflows_json"]),
        "services" => decode_json_list(row["services_json"])
      }
    }
  end

  defp run_from_row(row) do
    %{
      "id" => row["id"],
      "project" => row["project_name"],
      "definitionKind" => row["definition_kind"],
      "definitionName" => row["definition_name"],
      "status" => row["status"],
      "leaseId" => row["lease_id"],
      "leaseWorkerId" => row["lease_worker_id"],
      "leaseExpiresAt" => row["lease_expires_at"],
      "input" => decode_json_value(row["input_json"], %{}),
      "output" => decode_json_value(row["output_json"], nil),
      "error" => decode_json_value(row["error_json"], nil),
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  defp run_event_from_row(row) do
    %{
      "id" => row["id"],
      "runId" => row["run_id"],
      "seq" => row["seq"],
      "type" => row["event_type"],
      "body" => decode_json_value(row["body_json"], %{}),
      "createdAt" => row["created_at"]
    }
  end

  defp step_from_row(row) do
    %{
      "runId" => row["run_id"],
      "key" => row["op_key"],
      "name" => row["name"],
      "status" => row["status"],
      "attempt" => row["attempt"],
      "maxAttempts" => row["max_attempts"],
      "backoffKind" => row["backoff_kind"],
      "backoffMs" => row["backoff_ms"],
      "backoffStepMs" => row["backoff_step_ms"],
      "backoffFactor" => row["backoff_factor"],
      "maxBackoffMs" => row["max_backoff_ms"],
      "backoffJitterKind" => row["backoff_jitter_kind"],
      "backoffJitterRatio" => row["backoff_jitter_ratio"],
      "retryOn" => decode_json_list(row["retry_on_json"]),
      "timeoutMs" => row["timeout_ms"],
      "output" => decode_json_value(row["output_json"], nil),
      "error" => decode_json_value(row["error_json"], nil),
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  defp exec_from_row(row) do
    %{
      "runId" => row["run_id"],
      "key" => row["op_key"],
      "name" => row["name"],
      "status" => row["status"],
      "cmd" => row["cmd"],
      "args" => decode_json_list(row["args_json"]),
      "cwd" => row["cwd"],
      "env" => decode_json_value(row["env_json"], nil),
      "timeoutMs" => row["timeout_ms"],
      "attempt" => row["attempt"],
      "exitCode" => row["exit_code"],
      "signalCode" => row["signal_code"],
      "stdoutRef" => row["stdout_ref"],
      "stderrRef" => row["stderr_ref"],
      "artifacts" => decode_json_list(row["artifacts_json"]),
      "output" => decode_json_value(row["output_json"], nil),
      "error" => decode_json_value(row["error_json"], nil),
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  defp wait_from_row(row) do
    %{
      "runId" => row["run_id"],
      "key" => row["op_key"],
      "kind" => row["wait_kind"],
      "name" => row["wait_name"],
      "status" => row["status"],
      "wakeAt" => row["wake_at"],
      "output" => decode_json_value(row["output_json"], nil),
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  defp signal_from_row(row) do
    %{
      "id" => row["id"],
      "runId" => row["run_id"],
      "name" => row["signal_name"],
      "payload" => decode_json_value(row["payload_json"], nil),
      "consumedAt" => row["consumed_at"],
      "createdAt" => row["created_at"]
    }
  end

  defp child_from_row(row) do
    %{
      "parentRunId" => row["parent_run_id"],
      "key" => row["op_key"],
      "childRunId" => row["child_run_id"],
      "definitionName" => row["definition_name"],
      "status" => row["status"],
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  defp service_run_from_row(run_row, service_row) do
    run =
      run_from_row(run_row)
      |> Map.put("serviceKey", service_row["service_key"])
      |> Map.put("keyInput", decode_json_value(service_row["key_input_json"], %{}))
      |> Map.put("state", decode_json_value(service_row["state_json"], nil))

    run
  end

  defp service_envelope_from_row(row) do
    %{
      "id" => row["id"],
      "serviceRunId" => row["service_run_id"],
      "kind" => row["kind"],
      "name" => row["name"],
      "attempt" => row["attempt"],
      "payload" => decode_json_value(row["payload_json"], nil),
      "correlationId" => row["correlation_id"],
      "senderRunId" => row["sender_run_id"],
      "status" => row["status"],
      "reply" => decode_json_value(row["reply_json"], nil),
      "error" => decode_json_value(row["error_json"], nil),
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  defp rows_to_maps(%{columns: columns, rows: rows}) do
    Enum.map(rows, fn row ->
      Enum.zip(columns, row) |> Map.new()
    end)
  end

  defp first_integer(%{rows: [[value]]}) when is_integer(value), do: value
  defp first_integer(_), do: 0

  defp decode_json_list(nil), do: []
  defp decode_json_list(value) when is_binary(value), do: Jason.decode!(value)

  defp decode_json_value(nil, fallback), do: fallback
  defp decode_json_value(value, _fallback) when is_binary(value), do: Jason.decode!(value)

  defp maybe_encode_json(nil), do: nil
  defp maybe_encode_json(value), do: Jason.encode!(value)

  defp ensure_column!(table_name, column_name, definition) do
    existing_columns =
      Repo
      |> SQL.query!("pragma table_info(#{table_name})", [])
      |> rows_to_maps()
      |> Enum.map(& &1["name"])

    unless column_name in existing_columns do
      SQL.query!(Repo, "alter table #{table_name} add column #{column_name} #{definition}", [])
    end
  end

  defp get_run_by_lease(lease_id) do
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
      where lease_id = ?
      """,
      [lease_id]
    )
    |> rows_to_maps()
    |> List.first()
    |> case do
      nil -> nil
      row -> run_from_row(row)
    end
  end

  defp get_run_exec(run_id, op_key) do
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
      where run_id = ? and op_key = ?
      """,
      [run_id, op_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  defp get_run_step_row(run_id, op_key) do
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
      [run_id, op_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  defp get_run_wait(run_id, op_key) do
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
      where run_id = ? and op_key = ?
      """,
      [run_id, op_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  defp get_pending_signal(run_id, signal_name) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        run_id,
        signal_name,
        payload_json,
        consumed_at,
        created_at
      from run_signals
      where run_id = ? and signal_name = ? and consumed_at is null
      order by created_at asc
      limit 1
      """,
      [run_id, signal_name]
    )
    |> rows_to_maps()
    |> List.first()
  end

  defp get_run_child(parent_run_id, op_key) do
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
      where parent_run_id = ? and op_key = ?
      """,
      [parent_run_id, op_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  defp get_run_child_by_child(parent_run_id, child_run_id) do
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
      where parent_run_id = ? and child_run_id = ?
      """,
      [parent_run_id, child_run_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  defp get_service_run(project_name, definition_name, service_key) do
    query_service_run(
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
      where
        r.project_name = ?
        and r.definition_kind = 'service'
        and r.definition_name = ?
        and s.service_key = ?
      """,
      [project_name, definition_name, service_key]
    )
  end

  defp get_service_run_by_id(run_id) do
    query_service_run(
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
      where r.id = ?
      """,
      [run_id]
    )
  end

  defp query_service_run(sql, args) do
    Repo
    |> SQL.query!(sql, args)
    |> rows_to_maps()
    |> List.first()
    |> case do
      nil -> nil
      row -> service_run_from_row(row, row)
    end
  end

  defp get_service_envelope(envelope_id) do
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
        created_at,
        updated_at
      from service_envelopes
      where id = ?
      """,
      [envelope_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  defp get_processing_service_envelope_for_run(run_id) do
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
        created_at,
        updated_at
      from service_envelopes
      where service_run_id = ? and status = 'processing'
      order by updated_at desc, created_at desc
      limit 1
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  defp get_run_service_op(caller_run_id, op_key) do
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
      where caller_run_id = ? and op_key = ?
      """,
      [caller_run_id, op_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  defp append_event!(run_id, event_type, body, created_at) do
    next_seq =
      Repo
      |> SQL.query!("select coalesce(max(seq), 0) + 1 from run_events where run_id = ?", [run_id])
      |> first_integer()

    SQL.query!(
      Repo,
      """
      insert into run_events (
        id,
        run_id,
        seq,
        event_type,
        body_json,
        created_at
      ) values (?, ?, ?, ?, ?, ?)
      """,
      [
        "evt_" <> Ecto.UUID.generate(),
        run_id,
        next_seq,
        event_type,
        Jason.encode!(body),
        created_at
      ]
    )
  end

  defp shift_seconds(iso8601, seconds) do
    {:ok, datetime, _offset} = DateTime.from_iso8601(iso8601)
    datetime |> DateTime.add(seconds, :second) |> DateTime.to_iso8601()
  end

  defp shift_milliseconds(iso8601, milliseconds) do
    {:ok, datetime, _offset} = DateTime.from_iso8601(iso8601)
    datetime |> DateTime.add(milliseconds, :millisecond) |> DateTime.to_iso8601()
  end

  defp insert_workflow_run!(run_id, project_name, definition_name, input, now) do
    input_json = Jason.encode!(input || %{})

    SQL.query!(
      Repo,
      """
      insert into runs (
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
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      """,
      [
        run_id,
        project_name,
        "workflow",
        definition_name,
        "pending",
        nil,
        nil,
        nil,
        input_json,
        nil,
        nil,
        now,
        now
      ]
    )

    append_event!(
      run_id,
      "RunStarted",
      %{
        project: project_name,
        definitionKind: "workflow",
        definitionName: definition_name,
        input: input || %{}
      },
      now
    )
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
      cancelled_service_ask_count = cancel_outbound_service_asks!(run["id"], error_body, reason, now)
      cancelled_child_run_count = cancel_child_runs_for_parent!(run["id"], error_body, reason, now)

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

  defp stop_service_run_instance!(nil, _error_body, _reason, _now), do: nil

  defp stop_service_run_instance!(service_run, error_body, reason, now) do
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

      SQL.query!(
        Repo,
        """
        update runs
        set
          status = 'stopped',
          lease_id = null,
          lease_worker_id = null,
          lease_expires_at = null,
          output_json = null,
          error_json = ?,
          updated_at = ?
        where id = ?
        """,
        [Jason.encode!(error_body), now, service_run["id"]]
      )

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

  defp timeout_result_for_run!(run, error_body, now) do
    case run["definitionKind"] do
      "workflow" ->
        SQL.query!(
          Repo,
          """
          update runs
          set
            status = 'failed',
            lease_id = null,
            lease_worker_id = null,
            lease_expires_at = null,
            output_json = null,
            error_json = ?,
            updated_at = ?
          where id = ?
          """,
          [Jason.encode!(error_body), now, run["id"]]
        )

        append_event!(run["id"], "RunFailed", %{"error" => error_body}, now)
        wake_waiting_parents_for_child!(run["id"], "failed", error_body, now)

        %{
          "run" => get_run(run["id"]),
          "status" => "failed",
          "activeLeaseWorkerId" => run["leaseWorkerId"]
        }

      "service" ->
        case get_processing_service_envelope_for_run(run["id"]) do
          nil ->
            SQL.query!(
              Repo,
              """
              update runs
              set
                status = 'idle',
                lease_id = null,
                lease_worker_id = null,
                lease_expires_at = null,
                updated_at = ?
              where id = ?
              """,
              [now, run["id"]]
            )

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

  defp fail_step_attempt!(run, step, name, error_body, now) do
    encoded_error = Jason.encode!(error_body)
    attempt = step_attempt(step)
    max_attempts = RetryPolicy.normalize_max_attempts(step["max_attempts"])
    retry_on = decode_json_list(step["retry_on_json"])
    backoff = compute_backoff_details(%{
      "backoffKind" => step["backoff_kind"],
      "backoffMs" => step["backoff_ms"],
      "backoffStepMs" => step["backoff_step_ms"],
      "backoffFactor" => step["backoff_factor"],
      "maxBackoffMs" => step["max_backoff_ms"],
      "backoffJitterKind" => step["backoff_jitter_kind"],
      "backoffJitterRatio" => step["backoff_jitter_ratio"]
    }, attempt, {"step", run["id"], step["op_key"]})
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

      SQL.query!(
        Repo,
        """
        update run_steps
        set
          name = ?,
          status = 'retry_waiting',
          error_json = ?,
          updated_at = ?
        where run_id = ? and op_key = ?
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
        now
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
      SQL.query!(
        Repo,
        """
        update run_steps
        set
          name = ?,
          status = 'failed',
          error_json = ?,
          updated_at = ?
        where run_id = ? and op_key = ?
        """,
        [name, encoded_error, now, run["id"], step["op_key"]]
      )

      %{"status" => "failed", "error" => error_body, "runId" => run["id"], "key" => step["op_key"]}
    end
  end

  defp fail_exec_attempt!(run, exec, name, op_key, body, now) do
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

      SQL.query!(
        Repo,
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
        where run_id = ? and op_key = ?
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
        now
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
      SQL.query!(
        Repo,
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
        where run_id = ? and op_key = ?
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

  defp fail_service_turn_attempt!(service_run, envelope, error_body, retry_options, now) do
    max_attempts = RetryPolicy.normalize_max_attempts(Map.get(retry_options, "maxAttempts"))
    attempt = envelope["attempt"] || 1
    retry_on = RetryPolicy.normalize_retry_on(Map.get(retry_options, "retryOn"))
    backoff = compute_backoff_details(retry_options, attempt, {"service_turn", service_run["id"], envelope["id"]})
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

      SQL.query!(
        Repo,
        """
        update service_envelopes
        set
          attempt = ?,
          error_json = ?,
          updated_at = ?
        where id = ?
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
        now
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
      SQL.query!(
        Repo,
        """
        update service_envelopes
        set
          status = 'failed',
          error_json = ?,
          updated_at = ?
        where id = ?
        """,
        [Jason.encode!(error_body), now, envelope["id"]]
      )

      if envelope["kind"] == "ask" do
        wake_service_ask_waiter!(envelope["correlation_id"], "failed", error_body, now)
      end

      next_status = service_next_status(service_run["id"], false)

      SQL.query!(
        Repo,
        """
        update runs
        set
          status = ?,
          lease_id = null,
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

  defp schedule_retry_wait!(run, wait_key, body, now) do
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
      [run["id"], wait_key, Map.fetch!(body, "operationName"), Map.fetch!(body, "wakeAt"), now, now]
    )

    SQL.query!(
      Repo,
      """
      update runs
      set
        status = 'waiting',
        lease_id = null,
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

  defp list_open_service_envelopes(service_run_id) do
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

  defp list_waiting_wait_rows(run_id) do
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

  defp list_running_step_rows(run_id) do
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

  defp list_running_exec_rows(run_id) do
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

  defp list_waiting_service_ask_ops(caller_run_id) do
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

  defp list_open_child_rows(parent_run_id) do
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

  defp get_open_service_envelope_by_correlation(service_run_id, correlation_id) do
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
        e.created_at,
        e.updated_at,
        r.status as run_status,
        r.lease_expires_at as run_lease_expires_at
      from service_envelopes e
      join runs r on r.id = e.service_run_id
      where
        e.status in ('queued', 'processing')
        and r.definition_kind = 'service'
        and r.status in ('idle', 'pending', 'active')
        and (r.lease_expires_at is null or r.lease_expires_at < ?)
      order by
        case when e.status = 'processing' then 0 else 1 end asc,
        e.created_at asc
      limit 1
      """,
      [now]
    )
    |> rows_to_maps()
    |> List.first()
  end

  defp maybe_insert_service_envelope(service_run, kind, name, payload, correlation_id, sender_run_id, now) do
    if service_run["status"] == "stopped" do
      {:error,
       %{
         "message" => "Service is stopped",
         "serviceRunId" => service_run["id"],
         "serviceKey" => service_run["serviceKey"],
         "kind" => kind,
         "name" => name
       }}
    else
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
    end
  end

  defp insert_service_envelope!(service_run_id, kind, name, payload, correlation_id, sender_run_id, now) do
    envelope_id = "env_" <> Ecto.UUID.generate()
    current_run = get_run(service_run_id)
    next_status = ServiceLifecycle.enqueue_status(current_run["status"], current_run["leaseExpiresAt"], now)

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
        created_at,
        updated_at
      ) values (?, ?, ?, ?, 1, ?, ?, ?, 'queued', null, null, ?, ?)
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

  defp maybe_commit_service_state!(_run_id, nil, _now), do: :unchanged

  defp maybe_commit_service_state!(run_id, state, now) do
    current = get_service_run_by_id(run_id)
    encoded_state = Jason.encode!(state)
    initial? = is_nil(current["state"])

    SQL.query!(
      Repo,
      """
      update service_runs
      set
        state_json = ?,
        updated_at = ?
      where run_id = ?
      """,
      [encoded_state, now, run_id]
    )

    if initial?, do: :initialized, else: :updated
  end

  defp maybe_append_service_turn_waiting!(run, wait_body, now) do
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

  defp wake_service_ask_waiter!(correlation_id, status, payload, now) do
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

    if op do
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
        %{"kind" => "ask_reply", "key" => wait_key, "correlationId" => correlation_id, "payload" => payload},
        now
      )
    end
  end

  defp service_next_status(service_run_id, stop?) do
    current_run = get_run(service_run_id)
    ServiceLifecycle.next_status(current_run["status"], service_has_queued_envelopes?(service_run_id), stop?)
  end

  defp service_has_queued_envelopes?(service_run_id) do
    Repo
    |> SQL.query!(
      """
      select count(*)
      from service_envelopes
      where service_run_id = ? and status = 'queued'
      """,
      [service_run_id]
    )
    |> first_integer()
    |> Kernel.>(0)
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

  defp unwrap_transaction_result({:ok, value}), do: value
  defp unwrap_transaction_result({:error, reason}), do: raise(reason)

  defp now_iso8601 do
    DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end

  defp lease_duration_seconds do
    Application.fetch_env!(:vilano_kernel, :runtime).lease_duration_seconds
  end
end
