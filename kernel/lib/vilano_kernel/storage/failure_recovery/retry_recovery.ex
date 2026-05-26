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

  alias VilanoKernel.Storage.{EventPayloads, RetryPolicy, RunControl, ServiceSupport, Support}
  alias VilanoKernel.Storage.Support.Sql, as: SqlSupport

  import Support
  import ServiceSupport

  def fail_step_attempt!(run, step, name, error_body, now, lease_id, prepared_failure \\ nil) do
    RunControl.ensure_fenced_run_ownership!(run["id"], lease_id, now)

    encoded_error = Jason.encode!(error_body)
    context = step_failure_context(run, step, name, error_body, now)
    context = prepared_step_failure_context!(prepared_failure, run, step, name, context)

    append_step_failed_event!(run["id"], context.step_failed_body, now, prepared_failure)

    if context.decision["willRetry"] do
      wait_key = context.wait_key

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
        context.retry_wait_body,
        now,
        lease_id,
        prepared_retry_wait_events(prepared_failure)
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
          "wakeAt" => context.wake_at
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

  def prepare_step_attempt_failure!(run, step, name, error_body, now) do
    context = step_failure_context(run, step, name, error_body, now)
    step_failed_event = EventPayloads.prepare_body_for_storage!(context.step_failed_body)

    retry_wait_events =
      try do
        if context.decision["willRetry"] do
          prepare_retry_wait_events!(run, context.wait_key, context.retry_wait_body)
        else
          nil
        end
      rescue
        error ->
          EventPayloads.discard_prepared_payload!(step_failed_event)
          reraise error, __STACKTRACE__
      end

    %{
      kind: :step_attempt_failure,
      run_id: run["id"],
      run_status: run["status"],
      step_key: step["op_key"],
      step_status: step["status"],
      step_attempt: step["attempt"],
      name: name,
      context: context,
      step_failed_event: step_failed_event,
      retry_wait_events: retry_wait_events
    }
  end

  def prepared_step_attempt_will_retry?(%{context: %{decision: %{"willRetry" => will_retry?}}}),
    do: will_retry?

  def discard_prepared_step_attempt_failure(nil), do: :ok

  def discard_prepared_step_attempt_failure(%{} = prepared) do
    prepared
    |> Map.get(:step_failed_event)
    |> discard_prepared_payload()

    prepared
    |> Map.get(:retry_wait_events)
    |> discard_prepared_retry_wait_events()
  end

  defp step_failure_context(run, step, name, error_body, now) do
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

    step_failed_body = %{
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
    }

    retry_wait_body =
      if decision["willRetry"] do
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
        }
      end

    %{
      attempt: attempt,
      decision: decision,
      wait_key: retry_wait_key("step", step["op_key"]),
      wake_at: wake_at,
      step_failed_body: step_failed_body,
      retry_wait_body: retry_wait_body
    }
  end

  defp prepared_step_failure_context!(nil, _run, _step, _name, context), do: context

  defp prepared_step_failure_context!(
         %{
           kind: :step_attempt_failure,
           run_id: run_id,
           run_status: run_status,
           step_key: step_key,
           step_status: step_status,
           step_attempt: step_attempt,
           name: name,
           context: context
         },
         %{"id" => run_id, "status" => run_status},
         %{"op_key" => step_key, "status" => step_status, "attempt" => step_attempt},
         name,
         _context
       ),
       do: context

  defp prepared_step_failure_context!(_prepared, _run, _step, _name, _context),
    do: Repo.rollback(:stale_cancellation_plan)

  defp append_step_failed_event!(run_id, body, now, nil) do
    append_event!(run_id, "StepFailed", body, now)
  end

  defp append_step_failed_event!(run_id, _body, now, %{step_failed_event: storage}) do
    SqlSupport.append_prepared_event!(run_id, "StepFailed", storage, now)
  end

  defp prepared_retry_wait_events(nil), do: nil

  defp prepared_retry_wait_events(prepared_failure),
    do: Map.get(prepared_failure, :retry_wait_events)

  defp prepared_service_turn_waiting_event(nil), do: nil

  defp prepared_service_turn_waiting_event(prepared_events) do
    case Map.fetch(prepared_events, :service_turn_waiting_event) do
      {:ok, event} -> event
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  def fail_exec_attempt!(run, exec, name, op_key, body, now, lease_id, prepared_failure \\ nil) do
    RunControl.ensure_fenced_run_ownership!(run["id"], lease_id, now)

    error_body = Map.get(body, "error", %{})
    encoded_error = Jason.encode!(error_body)
    context = exec_failure_context(run, exec, name, op_key, body, now)
    context = prepared_exec_failure_context!(prepared_failure, run, exec, name, op_key, context)

    append_process_failed_event!(run["id"], context.process_failed_body, now, prepared_failure)

    if context.decision["willRetry"] do
      wait_key = context.wait_key

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
        context.retry_wait_body,
        now,
        lease_id,
        prepared_retry_wait_events(prepared_failure)
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
          "wakeAt" => context.wake_at
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

  def prepare_exec_attempt_failure!(run, exec, name, op_key, body, now) do
    context = exec_failure_context(run, exec, name, op_key, body, now)
    process_failed_event = EventPayloads.prepare_body_for_storage!(context.process_failed_body)

    retry_wait_events =
      try do
        if context.decision["willRetry"] do
          prepare_retry_wait_events!(run, context.wait_key, context.retry_wait_body)
        end
      rescue
        error ->
          discard_prepared_payload(process_failed_event)
          reraise error, __STACKTRACE__
      end

    %{
      kind: :exec_attempt_failure,
      run_id: run["id"],
      run_status: run["status"],
      exec_key: op_key,
      exec_status: exec["status"],
      exec_attempt: exec["attempt"],
      name: name,
      context: context,
      process_failed_event: process_failed_event,
      retry_wait_events: retry_wait_events
    }
  end

  def discard_prepared_exec_attempt_failure(nil), do: :ok

  def discard_prepared_exec_attempt_failure(%{} = prepared) do
    prepared
    |> Map.get(:process_failed_event)
    |> discard_prepared_payload()

    prepared
    |> Map.get(:retry_wait_events)
    |> discard_prepared_retry_wait_events()
  end

  defp exec_failure_context(run, exec, name, op_key, body, now) do
    error_body = Map.get(body, "error", %{})
    attempt = exec["attempt"] || 1
    max_attempts = RetryPolicy.normalize_max_attempts(Map.get(body, "maxAttempts"))
    retry_on = RetryPolicy.normalize_retry_on(Map.get(body, "retryOn"))
    backoff = compute_backoff_details(body, attempt, {"exec", run["id"], op_key})
    backoff_kind = backoff["backoffKind"]
    backoff_ms = backoff["backoffMs"]
    decision = retry_decision(error_body, attempt, max_attempts, retry_on)
    wake_at = if decision["willRetry"], do: shift_milliseconds(now, backoff_ms), else: nil

    process_failed_body = %{
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
    }

    retry_wait_body =
      if decision["willRetry"] do
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
        }
      end

    %{
      decision: decision,
      wait_key: retry_wait_key("exec", op_key),
      wake_at: wake_at,
      process_failed_body: process_failed_body,
      retry_wait_body: retry_wait_body
    }
  end

  defp prepared_exec_failure_context!(nil, _run, _exec, _name, _op_key, context), do: context

  defp prepared_exec_failure_context!(
         %{
           kind: :exec_attempt_failure,
           run_id: run_id,
           run_status: run_status,
           exec_key: op_key,
           exec_status: exec_status,
           exec_attempt: exec_attempt,
           name: name,
           context: context
         },
         %{"id" => run_id, "status" => run_status},
         %{"op_key" => op_key, "status" => exec_status, "attempt" => exec_attempt},
         name,
         op_key,
         _context
       ),
       do: context

  defp prepared_exec_failure_context!(_prepared, _run, _exec, _name, _op_key, _context),
    do: Repo.rollback(:stale_cancellation_plan)

  defp append_process_failed_event!(run_id, body, now, nil) do
    append_event!(run_id, "ProcessFailed", body, now)
  end

  defp append_process_failed_event!(run_id, _body, now, %{process_failed_event: storage}) do
    SqlSupport.append_prepared_event!(run_id, "ProcessFailed", storage, now)
  end

  def fail_service_turn_attempt!(
        service_run,
        envelope,
        error_body,
        retry_options,
        now,
        lease_id,
        prepared_failure \\ nil
      ) do
    RunControl.ensure_fenced_run_ownership!(service_run["id"], lease_id, now)

    context = service_turn_failure_context(service_run, envelope, error_body, retry_options, now)

    context =
      prepared_service_turn_failure_context!(prepared_failure, service_run, envelope, context)

    append_service_turn_failed_event!(
      service_run["id"],
      context.turn_failed_body,
      now,
      prepared_failure
    )

    if context.decision["willRetry"] do
      next_attempt = context.next_attempt
      wait_key = context.wait_key

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
        context.retry_wait_body,
        now,
        lease_id,
        prepared_retry_wait_events(prepared_failure)
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
          "wakeAt" => context.wake_at
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
        wake_service_ask_waiter!(
          envelope["correlation_id"],
          "failed",
          error_body,
          now,
          prepared_service_turn_ask_waiter_event(prepared_failure)
        )
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

  def prepare_service_turn_attempt_failure!(
        service_run,
        envelope,
        error_body,
        retry_options,
        now
      ) do
    context = service_turn_failure_context(service_run, envelope, error_body, retry_options, now)
    turn_failed_event = EventPayloads.prepare_body_for_storage!(context.turn_failed_body)

    retry_wait_events =
      try do
        if context.decision["willRetry"] do
          prepare_retry_wait_events!(service_run, context.wait_key, context.retry_wait_body)
        end
      rescue
        error ->
          discard_prepared_payload(turn_failed_event)
          reraise error, __STACKTRACE__
      end

    ask_waiter_event =
      try do
        if not context.decision["willRetry"] and envelope["kind"] == "ask" do
          prepare_service_ask_waiter_event(envelope["correlation_id"], "failed", error_body)
        end
      rescue
        error ->
          discard_prepared_retry_wait_events(retry_wait_events)
          discard_prepared_payload(turn_failed_event)
          reraise error, __STACKTRACE__
      end

    %{
      kind: :service_turn_attempt_failure,
      run_id: service_run["id"],
      run_status: service_run["status"],
      envelope_id: envelope["id"],
      envelope_status: envelope["status"],
      envelope_kind: envelope["kind"],
      envelope_attempt: envelope["attempt"],
      correlation_id: envelope["correlation_id"],
      name: envelope["name"],
      context: context,
      turn_failed_event: turn_failed_event,
      retry_wait_events: retry_wait_events,
      ask_waiter_event: ask_waiter_event
    }
  end

  def discard_prepared_service_turn_attempt_failure(nil), do: :ok

  def discard_prepared_service_turn_attempt_failure(%{} = prepared) do
    prepared
    |> Map.get(:turn_failed_event)
    |> discard_prepared_payload()

    prepared
    |> Map.get(:retry_wait_events)
    |> discard_prepared_retry_wait_events()

    prepared
    |> Map.get(:ask_waiter_event)
    |> discard_prepared_service_ask_waiter_event()
  end

  defp service_turn_failure_context(service_run, envelope, error_body, retry_options, now) do
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
    next_attempt = if decision["willRetry"], do: attempt + 1, else: nil

    turn_failed_body = %{
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
      "nextAttempt" => next_attempt,
      "wakeAt" => wake_at,
      "error" => error_body
    }

    retry_wait_body =
      if decision["willRetry"] do
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
        }
      end

    %{
      decision: decision,
      wait_key: retry_wait_key("turn", envelope["id"]),
      wake_at: wake_at,
      next_attempt: next_attempt,
      turn_failed_body: turn_failed_body,
      retry_wait_body: retry_wait_body
    }
  end

  defp prepared_service_turn_failure_context!(nil, _service_run, _envelope, context),
    do: context

  defp prepared_service_turn_failure_context!(
         %{
           kind: :service_turn_attempt_failure,
           run_id: run_id,
           run_status: run_status,
           envelope_id: envelope_id,
           envelope_status: envelope_status,
           envelope_kind: envelope_kind,
           envelope_attempt: envelope_attempt,
           correlation_id: correlation_id,
           name: name,
           context: context
         },
         %{"id" => run_id, "status" => run_status},
         %{
           "id" => envelope_id,
           "status" => envelope_status,
           "kind" => envelope_kind,
           "attempt" => envelope_attempt,
           "correlation_id" => correlation_id,
           "name" => name
         },
         _context
       ),
       do: context

  defp prepared_service_turn_failure_context!(_prepared, _service_run, _envelope, _context),
    do: Repo.rollback(:stale_cancellation_plan)

  defp append_service_turn_failed_event!(run_id, body, now, nil) do
    append_event!(run_id, "TurnFailed", body, now)
  end

  defp append_service_turn_failed_event!(run_id, _body, now, %{turn_failed_event: storage}) do
    SqlSupport.append_prepared_event!(run_id, "TurnFailed", storage, now)
  end

  defp prepared_service_turn_ask_waiter_event(nil), do: nil

  defp prepared_service_turn_ask_waiter_event(prepared_failure) do
    case Map.fetch(prepared_failure, :ask_waiter_event) do
      {:ok, event} -> event
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  def schedule_retry_wait!(run, wait_key, body, now, lease_id, prepared_events \\ nil) do
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

    append_retry_wait_event!(
      run["id"],
      "RetryScheduled",
      retry_scheduled_body(wait_key, body),
      now,
      prepared_events,
      :retry_scheduled_event
    )

    append_retry_wait_event!(
      run["id"],
      "WaitRegistered",
      retry_wait_registered_body(wait_key, body),
      now,
      prepared_events,
      :wait_registered_event
    )

    append_retry_wait_event!(
      run["id"],
      "RunSuspended",
      retry_run_suspended_body(wait_key, body),
      now,
      prepared_events,
      :run_suspended_event
    )

    maybe_append_service_turn_waiting!(
      run,
      retry_service_turn_waiting_body(wait_key, body),
      now,
      prepared_service_turn_waiting_event(prepared_events)
    )
  end

  defp prepare_retry_wait_events!(run, wait_key, body) do
    retry_scheduled_event =
      EventPayloads.prepare_body_for_storage!(retry_scheduled_body(wait_key, body))

    wait_registered_event =
      try do
        EventPayloads.prepare_body_for_storage!(retry_wait_registered_body(wait_key, body))
      rescue
        error ->
          discard_prepared_payload(retry_scheduled_event)
          reraise error, __STACKTRACE__
      end

    run_suspended_event =
      try do
        EventPayloads.prepare_body_for_storage!(retry_run_suspended_body(wait_key, body))
      rescue
        error ->
          discard_prepared_payload(wait_registered_event)
          discard_prepared_payload(retry_scheduled_event)
          reraise error, __STACKTRACE__
      end

    service_turn_waiting_event =
      try do
        prepare_service_turn_waiting_event(run, retry_service_turn_waiting_body(wait_key, body))
      rescue
        error ->
          discard_prepared_payload(run_suspended_event)
          discard_prepared_payload(wait_registered_event)
          discard_prepared_payload(retry_scheduled_event)
          reraise error, __STACKTRACE__
      end

    %{
      retry_scheduled_event: retry_scheduled_event,
      wait_registered_event: wait_registered_event,
      run_suspended_event: run_suspended_event,
      service_turn_waiting_event: service_turn_waiting_event
    }
  end

  defp retry_scheduled_body(wait_key, body) do
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
    }
  end

  defp retry_wait_registered_body(wait_key, body) do
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
    }
  end

  defp retry_run_suspended_body(wait_key, body) do
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
    }
  end

  defp retry_service_turn_waiting_body(wait_key, body) do
    %{
      "waitKind" => "retry_backoff",
      "key" => wait_key,
      "name" => Map.fetch!(body, "operationName"),
      "operationKind" => Map.fetch!(body, "operationKind"),
      "operationKey" => Map.fetch!(body, "operationKey"),
      "wakeAt" => Map.fetch!(body, "wakeAt")
    }
  end

  defp append_retry_wait_event!(run_id, event_type, body, now, nil, _key) do
    append_event!(run_id, event_type, body, now)
  end

  defp append_retry_wait_event!(run_id, event_type, _body, now, prepared_events, key) do
    case Map.fetch(prepared_events, key) do
      {:ok, storage} -> SqlSupport.append_prepared_event!(run_id, event_type, storage, now)
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp discard_prepared_retry_wait_events(nil), do: :ok

  defp discard_prepared_retry_wait_events(prepared_events) when is_map(prepared_events) do
    prepared_events
    |> Map.delete(:service_turn_waiting_event)
    |> Map.values()
    |> Enum.each(&discard_prepared_payload/1)

    prepared_events
    |> Map.get(:service_turn_waiting_event)
    |> discard_prepared_service_turn_waiting_event()
  end

  defp discard_prepared_payload(nil), do: :ok
  defp discard_prepared_payload(storage), do: EventPayloads.discard_prepared_payload!(storage)

  def step_attempt(step), do: step["attempt"] || 1
  def retry_wait_key(kind, op_key), do: "retry:" <> kind <> ":" <> op_key

  def retry_decision(error_body, attempt, max_attempts, retry_on),
    do: RetryPolicy.retry_decision(error_body, attempt, max_attempts, retry_on)

  def compute_backoff_details(policy, attempt, seed),
    do: RetryPolicy.compute_backoff_details(policy, attempt, seed)
end
