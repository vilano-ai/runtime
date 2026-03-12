defmodule VilanoKernel.Storage.FailureRecovery.RetryRecovery do
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

  alias VilanoKernel.Storage.{RetryPolicy, RunControl, ServiceSupport, Support}

  import Support
  import ServiceSupport

  def fail_step_attempt!(run, step, name, error_body, now, lease_id) do
    RunControl.ensure_fenced_run_ownership!(run["id"], lease_id, now)

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

      RunControl.ensure_fenced_related_write!(
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
      RunControl.ensure_fenced_related_write!(
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

  def fail_exec_attempt!(run, exec, name, op_key, body, now, lease_id) do
    RunControl.ensure_fenced_run_ownership!(run["id"], lease_id, now)

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

      RunControl.ensure_fenced_related_write!(
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
      RunControl.ensure_fenced_related_write!(
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

  def fail_service_turn_attempt!(service_run, envelope, error_body, retry_options, now, lease_id) do
    RunControl.ensure_fenced_run_ownership!(service_run["id"], lease_id, now)

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

      RunControl.ensure_fenced_related_write!(
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
        "run" => VilanoKernel.Storage.get_run(service_run["id"]),
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
      RunControl.ensure_fenced_related_write!(
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

      RunControl.ensure_fenced_run_write!(
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

      VilanoKernel.Storage.get_run(service_run["id"])
    end
  end

  def schedule_retry_wait!(run, wait_key, body, now, lease_id) do
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

  def step_attempt(step), do: step["attempt"] || 1
  def retry_wait_key(kind, op_key), do: "retry:" <> kind <> ":" <> op_key
  def retry_decision(error_body, attempt, max_attempts, retry_on), do: RetryPolicy.retry_decision(error_body, attempt, max_attempts, retry_on)
  def compute_backoff_details(policy, attempt, seed), do: RetryPolicy.compute_backoff_details(policy, attempt, seed)
end
