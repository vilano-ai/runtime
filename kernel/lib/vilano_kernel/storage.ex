defmodule VilanoKernel.Storage do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  @lease_duration_seconds 30

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
    input_json = Jason.encode!(input || %{})

    Repo.transaction(fn ->
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
    end)

    get_run(run_id)
  end

  def lease_next_run(worker_id) do
    now = now_iso8601()
    expires_at = shift_seconds(now, @lease_duration_seconds)

    Repo.transaction(fn ->
      candidate =
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
            status in ('pending', 'running')
            and (lease_expires_at is null or lease_expires_at < ?)
          order by created_at asc
          limit 1
          """,
          [now]
        )
        |> rows_to_maps()
        |> List.first()

      if candidate do
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

        %{lease_id: lease_id, lease_expires_at: expires_at, run: get_run(run_id)}
      else
        nil
      end
    end)
    |> unwrap_transaction_result()
  end

  def heartbeat_lease(lease_id, worker_id) do
    now = now_iso8601()
    expires_at = shift_seconds(now, @lease_duration_seconds)

    updated_rows =
      SQL.query!(
        Repo,
        """
        update runs
        set lease_expires_at = ?, updated_at = ?
        where lease_id = ? and lease_worker_id = ? and status = 'running'
        """,
        [expires_at, now, lease_id, worker_id]
      ).num_rows

    if updated_rows > 0, do: %{"leaseExpiresAt" => expires_at}, else: nil
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
          get_run(run["id"])
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_step(lease_id, name, op_key) do
    now = now_iso8601()

    Repo.transaction(fn ->
      case get_run_by_lease(lease_id) do
        nil ->
          nil

        run ->
          existing =
            Repo
            |> SQL.query!(
              """
              select run_id, op_key, name, status, output_json, created_at, updated_at
              from run_steps
              where run_id = ? and op_key = ?
              """,
              [run["id"], op_key]
            )
            |> rows_to_maps()
            |> List.first()

          if existing && existing["status"] == "completed" do
            %{
              "status" => "completed",
              "output" => decode_json_value(existing["output_json"], nil)
            }
          else
            SQL.query!(
              Repo,
              """
              insert into run_steps (
                run_id,
                op_key,
                name,
                status,
                output_json,
                created_at,
                updated_at
              ) values (?, ?, ?, 'running', null, ?, ?)
              on conflict(run_id, op_key) do update set
                name = excluded.name,
                status = 'running',
                updated_at = excluded.updated_at
              """,
              [run["id"], op_key, name, now, now]
            )

            append_event!(run["id"], "StepStarted", %{"name" => name, "key" => op_key}, now)
            %{"status" => "pending"}
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def complete_step(lease_id, name, op_key, output) do
    now = now_iso8601()

    Repo.transaction(fn ->
      case get_run_by_lease(lease_id) do
        nil ->
          nil

        run ->
          SQL.query!(
            Repo,
            """
            insert into run_steps (
              run_id,
              op_key,
              name,
              status,
              output_json,
              created_at,
              updated_at
            ) values (?, ?, ?, 'completed', ?, ?, ?)
            on conflict(run_id, op_key) do update set
              name = excluded.name,
              status = 'completed',
              output_json = excluded.output_json,
              updated_at = excluded.updated_at
            """,
            [run["id"], op_key, name, Jason.encode!(output), now, now]
          )

          append_event!(
            run["id"],
            "StepCompleted",
            %{"name" => name, "key" => op_key, "output" => output},
            now
          )

          %{"status" => "completed", "output" => output}
      end
    end)
    |> unwrap_transaction_result()
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
                  Jason.encode!(Map.get(body, "error", %{})),
                  now,
                  run["id"],
                  op_key
                ]
              )

              append_event!(
                run["id"],
                "ProcessFailed",
                %{
                  "name" => name,
                  "key" => op_key,
                  "attempt" => existing["attempt"],
                  "exitCode" => Map.get(body, "exitCode"),
                  "signalCode" => Map.get(body, "signalCode"),
                  "stdoutRef" => Map.get(body, "stdoutRef"),
                  "stderrRef" => Map.get(body, "stderrRef"),
                  "artifacts" => Map.get(body, "artifacts", []),
                  "error" => Map.get(body, "error", %{})
                },
                now
              )

              exec = get_run_exec(run["id"], op_key)
              %{"status" => "failed", "error" => decode_json_value(exec["error_json"], nil)}
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

  def satisfy_sleep_wait(run_id, op_key) do
    now = now_iso8601()

    Repo.transaction(fn ->
      case get_run_wait(run_id, op_key) do
        nil ->
          nil

        wait ->
          if wait["status"] != "waiting" do
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

            append_event!(run_id, "TimerFired", %{"key" => op_key, "wakeAt" => wait["wake_at"]}, now)

            append_event!(
              run_id,
              "WaitSatisfied",
              %{"kind" => "sleep", "key" => op_key, "wakeAt" => wait["wake_at"]},
              now
            )

            wait_from_row(get_run_wait(run_id, op_key))
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def list_waiting_sleep_waits do
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
      where wait_kind = 'sleep' and status = 'waiting'
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
        output_json,
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
      "output" => decode_json_value(row["output_json"], nil),
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

  defp unwrap_transaction_result({:ok, value}), do: value
  defp unwrap_transaction_result({:error, reason}), do: raise(reason)

  defp now_iso8601 do
    DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end
end
