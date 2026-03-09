defmodule VilanoKernel.Router.RunViews do
  @moduledoc false

  alias VilanoKernel.Storage

  def build_run_inspect_body(run, run_id) do
    %{
      ok: true,
      run: run,
      events: Storage.list_run_events(run_id),
      steps: Storage.list_run_steps(run_id),
      execs: Storage.list_run_execs(run_id),
      waits: Storage.list_run_waits(run_id),
      signals: Storage.list_run_signals(run_id),
      children: Storage.list_run_children(run_id),
      envelopes: Storage.list_service_envelopes(run_id)
    }
  end

  def build_run_replay_body(run, run_id) do
    inspect_body = build_run_inspect_body(run, run_id)
    Map.put(inspect_body, :timeline, derive_replay_entries(inspect_body.events))
  end

  defp derive_replay_entries(events) do
    Enum.map(events, fn event ->
      %{
        seq: Map.fetch!(event, "seq"),
        createdAt: Map.fetch!(event, "createdAt"),
        type: Map.fetch!(event, "type"),
        summary: summarize_replay_event(event),
        body: Map.fetch!(event, "body")
      }
    end)
  end

  defp summarize_replay_event(event) do
    body = body_record(Map.get(event, "body"))

    case Map.get(event, "type") do
      "RunStarted" ->
        format_summary(%{
          input: truncate_json(Map.get(body, "input"))
        })

      "RunLeaseGranted" ->
        format_summary(%{
          lease: Map.get(body, "leaseId"),
          worker: Map.get(body, "workerId"),
          expires: Map.get(body, "leaseExpiresAt")
        })

      "RunCompleted" ->
        format_summary(%{
          result: truncate_json(Map.get(body, "result"))
        })

      "RunFailed" ->
        format_summary(%{
          error: error_message(Map.get(body, "error"))
        })

      type when type in ["RunCancelled", "ServiceStopped"] ->
        format_summary(%{
          reason: Map.get(body, "reason"),
          waits: Map.get(body, "cancelledWaitCount"),
          children: Map.get(body, "cancelledChildRunCount"),
          asks: Map.get(body, "cancelledServiceAskCount")
        })

      "StepStarted" ->
        format_summary(%{
          name: Map.get(body, "name"),
          key: Map.get(body, "key"),
          attempt: Map.get(body, "attempt"),
          timeoutMs: Map.get(body, "timeoutMs"),
          maxAttempts: Map.get(body, "maxAttempts"),
          backoffMs: Map.get(body, "backoffMs")
        })

      "StepCompleted" ->
        format_summary(%{
          name: Map.get(body, "name"),
          key: Map.get(body, "key"),
          output: truncate_json(Map.get(body, "output"))
        })

      type when type in ["StepFailed", "StepCancelled"] ->
        format_summary(%{
          name: Map.get(body, "name"),
          key: Map.get(body, "key"),
          attempt: Map.get(body, "attempt"),
          timedOut: Map.get(body_record(Map.get(body, "error")), "timedOut"),
          family: Map.get(body, "retryFamily"),
          retry: Map.get(body, "retryDecision"),
          retryable: Map.get(body, "retryable"),
          willRetry: Map.get(body, "willRetry"),
          backoffKind: Map.get(body, "backoffKind"),
          backoffMs: Map.get(body, "backoffMs"),
          backoffBaseMs: Map.get(body, "backoffBaseMs"),
          backoffCappedMs: Map.get(body, "backoffCappedMs"),
          backoffJitterKind: Map.get(body, "backoffJitterKind"),
          backoffJitterMs: Map.get(body, "backoffJitterMs"),
          error: error_message(Map.get(body, "error"))
        })

      "ProcessStarted" ->
        format_summary(%{
          name: Map.get(body, "name"),
          key: Map.get(body, "key"),
          attempt: Map.get(body, "attempt"),
          cmd: Map.get(body, "cmd"),
          args:
            case Map.get(body, "args") do
              args when is_list(args) -> truncate_value(Enum.join(args, " "))
              _ -> nil
            end,
          timeoutMs: Map.get(body, "timeoutMs")
        })

      type when type in ["ProcessCompleted", "ProcessFailed", "ProcessCancelled"] ->
        format_summary(%{
          name: Map.get(body, "name"),
          key: Map.get(body, "key"),
          attempt: Map.get(body, "attempt"),
          exitCode: Map.get(body, "exitCode"),
          signal: Map.get(body, "signalCode"),
          stdout: Map.get(body, "stdoutRef"),
          stderr: Map.get(body, "stderrRef"),
          family: Map.get(body, "retryFamily"),
          retry: Map.get(body, "retryDecision"),
          retryable: Map.get(body, "retryable"),
          willRetry: Map.get(body, "willRetry"),
          backoffKind: Map.get(body, "backoffKind"),
          backoffMs: Map.get(body, "backoffMs"),
          backoffBaseMs: Map.get(body, "backoffBaseMs"),
          backoffCappedMs: Map.get(body, "backoffCappedMs"),
          backoffJitterKind: Map.get(body, "backoffJitterKind"),
          backoffJitterMs: Map.get(body, "backoffJitterMs"),
          error: if(type == "ProcessCompleted", do: nil, else: error_message(Map.get(body, "error")))
        })

      type when type in ["WaitRegistered", "WaitSatisfied"] ->
        format_summary(%{
          kind: Map.get(body, "kind"),
          key: Map.get(body, "key"),
          name: Map.get(body, "name") || Map.get(body, "signal"),
          wakeAt: Map.get(body, "wakeAt"),
          payload:
            if(Map.has_key?(body, "payload"), do: truncate_json(Map.get(body, "payload")), else: nil)
        })

      "RunSuspended" ->
        format_summary(%{
          reason: Map.get(body, "reason"),
          key: Map.get(body, "key"),
          operation: Map.get(body, "operationKind"),
          name: Map.get(body, "name"),
          wakeAt: Map.get(body, "wakeAt")
        })

      "RetryScheduled" ->
        format_summary(%{
          kind: Map.get(body, "kind"),
          name: Map.get(body, "name"),
          attempt: Map.get(body, "attempt"),
          nextAttempt: Map.get(body, "nextAttempt"),
          backoffKind: Map.get(body, "backoffKind"),
          backoffMs: Map.get(body, "backoffMs"),
          backoffBaseMs: Map.get(body, "backoffBaseMs"),
          backoffCappedMs: Map.get(body, "backoffCappedMs"),
          backoffCapMs: Map.get(body, "backoffCapMs"),
          backoffJitterKind: Map.get(body, "backoffJitterKind"),
          backoffJitterRatio: Map.get(body, "backoffJitterRatio"),
          backoffJitterMs: Map.get(body, "backoffJitterMs"),
          wakeAt: Map.get(body, "wakeAt")
        })

      type when type in ["SignalReceived", "SignalSent"] ->
        format_summary(%{
          signal: Map.get(body, "signal"),
          payload:
            if(Map.has_key?(body, "payload"), do: truncate_json(Map.get(body, "payload")), else: nil)
        })

      "ChildRunSpawned" ->
        format_summary(%{
          key: Map.get(body, "key"),
          childRunId: Map.get(body, "childRunId"),
          definition: Map.get(body, "definitionName"),
          status: Map.get(body, "childStatus")
        })

      "InboundEnqueued" ->
        format_summary(%{
          envelope: Map.get(body, "envelopeId"),
          kind: Map.get(body, "kind"),
          name: Map.get(body, "name"),
          correlation: Map.get(body, "correlationId"),
          sender: Map.get(body, "senderRunId")
        })

      type when type in ["TurnStarted", "TurnResumed", "TurnWaiting", "TurnCompleted", "TurnFailed"] ->
        format_summary(%{
          envelope: Map.get(body, "envelopeId"),
          kind: Map.get(body, "kind"),
          name: Map.get(body, "name") || Map.get(body, "turnName"),
          attempt: Map.get(body, "attempt"),
          reason: Map.get(body, "reason"),
          wait: Map.get(body, "waitKind"),
          key: Map.get(body, "key"),
          family: Map.get(body, "retryFamily"),
          retry: Map.get(body, "retryDecision"),
          retryable: Map.get(body, "retryable"),
          willRetry: Map.get(body, "willRetry"),
          backoffKind: Map.get(body, "backoffKind"),
          backoffMs: Map.get(body, "backoffMs"),
          backoffBaseMs: Map.get(body, "backoffBaseMs"),
          backoffCappedMs: Map.get(body, "backoffCappedMs"),
          backoffJitterKind: Map.get(body, "backoffJitterKind"),
          backoffJitterMs: Map.get(body, "backoffJitterMs"),
          error: if(type == "TurnFailed", do: error_message(Map.get(body, "error")), else: nil)
        })

      type
      when type in [
             "ServiceInstantiated",
             "ServiceInitialized",
             "ServiceStateCommitted",
             "AskRequested",
             "AskReplyCommitted",
             "MessageSent",
             "TimerFired"
           ] ->
        format_summary(body)

      _ ->
        format_summary(body)
    end
  end

  defp body_record(%{} = value), do: value
  defp body_record(_value), do: %{}

  defp format_summary(fields) do
    parts =
      fields
      |> Enum.filter(fn {_key, value} -> not is_nil(value) end)
      |> Enum.map(fn {key, value} -> "#{key}=#{format_value(value)}" end)

    case parts do
      [] -> ""
      _ -> "\t" <> Enum.join(parts, "\t")
    end
  end

  defp format_value(value) when is_binary(value), do: value
  defp format_value(value) when is_number(value) or is_boolean(value) or is_atom(value), do: to_string(value)
  defp format_value(value), do: value |> Jason.encode!() |> truncate_value()

  defp truncate_json(value, max_length \\ 120) do
    value
    |> Jason.encode!()
    |> truncate_value(max_length)
  end

  defp truncate_value(value, max_length \\ 120) when is_binary(value) do
    if String.length(value) <= max_length do
      value
    else
      String.slice(value, 0, max_length) <> "..."
    end
  end

  defp error_message(%{} = value), do: Map.get(value, "message")
  defp error_message(_value), do: nil
end
