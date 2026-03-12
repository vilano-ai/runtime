defmodule VilanoKernel.Storage.ActivationLifecycle do
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
    Infrastructure,
    RetryPolicy,
    RunControl,
    ServiceLifecycle,
    ServiceSupport,
    Support
  }

  import Support
  import ServiceSupport

  def lease_next_run(worker_id), do: do_lease_next_run(worker_id, 3)

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
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          RunControl.ensure_fenced_run_write!(
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
          VilanoKernel.Storage.AgentRelationships.wake_waiting_parents_for_child!(
            run["id"],
            "completed",
            result,
            now
          )

          VilanoKernel.Storage.Supervision.maybe_apply_supervision_for_terminal_run!(run["id"], now)
          VilanoKernel.Storage.AgentRelationships.maybe_trigger_relationships_for_terminal_run!(run["id"], now)
          VilanoKernel.Storage.get_run(run["id"])
      end
    end)
    |> unwrap_transaction_result()
  end

  def fail_run_lease(lease_id, error_body) do
    now = Infrastructure.now_iso8601()

    Repo.transaction(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          RunControl.ensure_fenced_run_write!(
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
          VilanoKernel.Storage.AgentRelationships.wake_waiting_parents_for_child!(
            run["id"],
            "failed",
            error_body,
            now
          )

          VilanoKernel.Storage.Supervision.maybe_apply_supervision_for_terminal_run!(run["id"], now)
          VilanoKernel.Storage.AgentRelationships.maybe_trigger_relationships_for_terminal_run!(run["id"], now)
          VilanoKernel.Storage.get_run(run["id"])
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_step(lease_id, name, op_key), do: resolve_step(lease_id, name, op_key, nil, %{})
  def resolve_step(lease_id, name, op_key, timeout_ms), do: resolve_step(lease_id, name, op_key, timeout_ms, %{})

  def resolve_step(lease_id, name, op_key, timeout_ms, retry_policy) do
    now = Infrastructure.now_iso8601()

    result =
      Repo.transaction(fn ->
        case RunControl.get_fenced_run_by_lease(lease_id, now) do
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
        case RunControl.get_fenced_run_by_lease(lease_id, now) do
          nil ->
            nil

          run ->
            case get_run_step_row(run["id"], op_key) do
              nil ->
                nil

              _step ->
                RunControl.ensure_fenced_related_write!(
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
        case RunControl.get_fenced_run_by_lease(lease_id, now) do
          nil ->
            nil

          run ->
            case get_run_step_row(run["id"], op_key) do
              nil ->
                nil

              step ->
                VilanoKernel.Storage.FailureRecovery.fail_step_attempt!(
                  run,
                  step,
                  name,
                  error_body,
                  now,
                  lease_id
                )
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
        case RunControl.get_fenced_run_by_lease(lease_id, now) do
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
                  case VilanoKernel.Storage.FailureRecovery.fail_step_attempt!(
                         run,
                         step,
                         step["name"],
                         error_body,
                         now,
                         lease_id
                       ) do
                    %{"status" => "retry_waiting", "wait" => wait} ->
                      %{
                        "run" => VilanoKernel.Storage.get_run(run["id"]),
                        "status" => "waiting",
                        "activeLeaseWorkerId" => run["leaseWorkerId"],
                        "wait" => wait
                      }

                    _ ->
                      VilanoKernel.Storage.FailureRecovery.timeout_result_for_run!(
                        run,
                        error_body,
                        now,
                        lease_id
                      )
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

    Repo.transaction(fn ->
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

    Repo.transaction(fn ->
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

  def resolve_sleep_wait(lease_id, op_key, duration_ms) do
    now = Infrastructure.now_iso8601()
    wake_at = shift_milliseconds(now, duration_ms)

    Repo.transaction(fn ->
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

    Repo.transaction(fn ->
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

  def runnable_activation_available? do
    now = Infrastructure.now_iso8601()
    not is_nil(next_activation_candidate(now))
  end

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

               run = VilanoKernel.Storage.get_run(run_id)

               case RunControl.ensure_run_activation_pinned!(run) do
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

               run = VilanoKernel.Storage.get_run(run_id)

               case RunControl.ensure_run_activation_pinned!(run) do
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
        RunControl.invalidate_unpinned_run!(run, Infrastructure.now_iso8601())
        do_lease_next_run(worker_id, attempts_remaining - 1)

      {:error, reason} ->
        raise(reason)
    end
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
end
