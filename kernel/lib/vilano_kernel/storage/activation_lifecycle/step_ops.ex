defmodule VilanoKernel.Storage.ActivationLifecycle.StepOps do
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

  alias VilanoKernel.Storage.{Infrastructure, RetryPolicy, RunControl, Support}

  import Support

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
end
