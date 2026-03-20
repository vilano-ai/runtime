defmodule VilanoKernel.Storage.ActivationLifecycle.ExecOps do
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

  alias VilanoKernel.Storage.{Infrastructure, RunControl, Support}

  import Support

  def resolve_exec(lease_id, name, op_key, exec_spec) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
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

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          case get_run_exec(run["id"], op_key) do
            nil ->
              nil

            existing ->
              RunControl.ensure_fenced_related_write!(
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

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          case get_run_exec(run["id"], op_key) do
            nil ->
              nil

            existing ->
              VilanoKernel.Storage.FailureRecovery.fail_exec_attempt!(
                run,
                existing,
                name,
                op_key,
                body,
                now,
                lease_id
              )
          end
      end
    end)
    |> unwrap_transaction_result()
  end
end
