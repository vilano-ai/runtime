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

  def resolve_step(lease_id, name, op_key, timeout_ms),
    do: resolve_step(lease_id, name, op_key, timeout_ms, %{})

  def resolve_step(lease_id, name, op_key, timeout_ms, retry_policy) do
    now = Infrastructure.now_iso8601()

    result =
      Infrastructure.transaction_with_busy_retry(fn ->
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
      Infrastructure.transaction_with_busy_retry(fn ->
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
    result =
      fail_step_with_prepared_failure_retry(lease_id, name, op_key, error_body, 3)

    if is_map(result) && result["status"] in ["failed", "retry_waiting"] do
      VilanoKernel.StepDeadlineManager.clear_step(result["runId"], result["key"])
    end

    result
  end

  defp fail_step_with_prepared_failure_retry(lease_id, name, op_key, error_body, attempts_left) do
    now = Infrastructure.now_iso8601()
    prepared_failure = prepare_step_failure_plan!(lease_id, name, op_key, error_body, now)

    try do
      case fail_step_transaction(lease_id, name, op_key, error_body, now, prepared_failure) do
        {:ok, result} ->
          result

        {:error, :stale_cancellation_plan} when attempts_left > 1 ->
          fail_step_with_prepared_failure_retry(
            lease_id,
            name,
            op_key,
            error_body,
            attempts_left - 1
          )

        {:error, error} ->
          unwrap_transaction_result({:error, error})
      end
    after
      VilanoKernel.Storage.FailureRecovery.RetryRecovery.discard_prepared_step_attempt_failure(
        prepared_failure
      )
    end
  end

  defp fail_step_transaction(lease_id, name, op_key, error_body, now, prepared_failure) do
    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        run ->
          case get_run_step_row(run["id"], op_key) do
            nil ->
              if is_map(prepared_failure), do: Repo.rollback(:stale_cancellation_plan)
              nil

            step ->
              if is_nil(prepared_failure), do: Repo.rollback(:stale_cancellation_plan)

              VilanoKernel.Storage.FailureRecovery.fail_step_attempt!(
                run,
                step,
                name,
                error_body,
                now,
                lease_id,
                prepared_failure
              )
          end
      end
    end)
  end

  defp prepare_step_failure_plan!(lease_id, name, op_key, error_body, now) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case RunControl.get_run_by_lease(lease_id) do
          nil ->
            nil

          run ->
            case get_run_step_row(run["id"], op_key) do
              nil ->
                nil

              step ->
                VilanoKernel.Storage.FailureRecovery.RetryRecovery.prepare_step_attempt_failure!(
                  run,
                  step,
                  name,
                  error_body,
                  now
                )
            end
        end
      end,
      :public_read
    )
  end

  def timeout_step(lease_id, op_key, expected_attempt, error_body) do
    result =
      timeout_step_with_prepared_result_retry(lease_id, op_key, expected_attempt, error_body, 3)

    if is_map(result) && result["status"] in ["failed", "idle", "pending", "waiting"] do
      VilanoKernel.StepDeadlineManager.clear_step(result["run"]["id"], op_key)
    end

    result
  end

  defp timeout_step_with_prepared_result_retry(
         lease_id,
         op_key,
         expected_attempt,
         error_body,
         attempts_left
       ) do
    now = Infrastructure.now_iso8601()

    prepared_timeout =
      prepare_timeout_step_plan!(lease_id, op_key, expected_attempt, error_body, now)

    try do
      case timeout_step_transaction(
             lease_id,
             op_key,
             expected_attempt,
             error_body,
             now,
             prepared_timeout
           ) do
        {:ok, result} ->
          result

        {:error, :stale_cancellation_plan} when attempts_left > 1 ->
          timeout_step_with_prepared_result_retry(
            lease_id,
            op_key,
            expected_attempt,
            error_body,
            attempts_left - 1
          )

        {:error, error} ->
          unwrap_transaction_result({:error, error})
      end
    after
      VilanoKernel.Storage.FailureRecovery.ServiceFailure.discard_prepared_timeout_result(
        prepared_timeout_result(prepared_timeout)
      )

      VilanoKernel.Storage.FailureRecovery.RetryRecovery.discard_prepared_step_attempt_failure(
        prepared_step_failure(prepared_timeout)
      )
    end
  end

  defp timeout_step_transaction(
         lease_id,
         op_key,
         expected_attempt,
         error_body,
         now,
         prepared_timeout
       ) do
    Infrastructure.transaction_with_busy_retry(fn ->
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
                if is_nil(prepared_step_failure(prepared_timeout)) do
                  Repo.rollback(:stale_cancellation_plan)
                end

                case VilanoKernel.Storage.FailureRecovery.fail_step_attempt!(
                       run,
                       step,
                       step["name"],
                       error_body,
                       now,
                       lease_id,
                       prepared_step_failure(prepared_timeout)
                     ) do
                  %{"status" => "retry_waiting", "wait" => wait} ->
                    %{
                      "run" => VilanoKernel.Storage.get_run(run["id"]),
                      "status" => "waiting",
                      "activeLeaseWorkerId" => run["leaseWorkerId"],
                      "wait" => wait
                    }

                  _ ->
                    if is_nil(prepared_timeout_result(prepared_timeout)) do
                      Repo.rollback(:stale_cancellation_plan)
                    end

                    VilanoKernel.Storage.FailureRecovery.timeout_result_for_run!(
                      run,
                      error_body,
                      now,
                      lease_id,
                      prepared_timeout_result(prepared_timeout)
                    )
                end
              end
          end
      end
    end)
  end

  defp prepare_timeout_step_plan!(lease_id, op_key, expected_attempt, error_body, now) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case RunControl.get_run_by_lease(lease_id) do
          nil ->
            nil

          run ->
            case get_run_step_row(run["id"], op_key) do
              %{"status" => "running", "attempt" => ^expected_attempt} = step ->
                step_failure =
                  VilanoKernel.Storage.FailureRecovery.RetryRecovery.prepare_step_attempt_failure!(
                    run,
                    step,
                    step["name"],
                    error_body,
                    now
                  )

                timeout_result =
                  try do
                    unless VilanoKernel.Storage.FailureRecovery.RetryRecovery.prepared_step_attempt_will_retry?(
                             step_failure
                           ) do
                      VilanoKernel.Storage.FailureRecovery.ServiceFailure.prepare_timeout_result_for_run!(
                        run,
                        error_body,
                        now
                      )
                    end
                  rescue
                    error ->
                      VilanoKernel.Storage.FailureRecovery.RetryRecovery.discard_prepared_step_attempt_failure(
                        step_failure
                      )

                      reraise error, __STACKTRACE__
                  end

                %{step_failure: step_failure, timeout_result: timeout_result}

              _ ->
                nil
            end
        end
      end,
      :public_read
    )
  end

  defp prepared_step_failure(nil), do: nil
  defp prepared_step_failure(%{step_failure: step_failure}), do: step_failure

  defp prepared_timeout_result(nil), do: nil
  defp prepared_timeout_result(%{timeout_result: timeout_result}), do: timeout_result
end
