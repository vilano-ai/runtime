import type {
  RunChildRecord,
  RunEnvelopeRecord,
  RunEventRecord,
  RunExecRecord,
  RunRecord,
  RunRetrySeriesRecord,
  RunSignalRecord,
  RunStepRecord,
  RunTurnRecord,
  RunWaitRecord,
} from "../types.ts";
import { renderRun } from "./base.ts";
import { buildRunExplain, renderRunExplainSummary } from "./explain.ts";
import { deriveRetrySeries, renderRetrySeries } from "./retry.ts";
import { asRecord, renderEventSummary, retryFieldsFromEventBody } from "./shared.ts";

export function renderRunInspect(
  run: RunRecord,
  events: RunEventRecord[],
  steps: RunStepRecord[],
  execs: RunExecRecord[],
  waits: RunWaitRecord[],
  signals: RunSignalRecord[],
  children: RunChildRecord[],
  envelopes: RunEnvelopeRecord[],
  turns: RunTurnRecord[],
  retrySeries: RunRetrySeriesRecord[]
): string {
  const eventLines =
    events.length === 0
      ? ["events: none"]
      : [
          "events:",
          ...events.map(
            (event) =>
              `  ${event.seq}. ${event.type}\t${event.createdAt}${renderEventSummary(event)}`
          ),
        ];
  const stepLines =
    steps.length === 0
      ? ["steps: none"]
      : [
          "steps:",
          ...steps.map((step) => {
            const parts = [
              `  ${step.name}`,
              `key=${step.key}`,
              `status=${step.status}`,
              `attempts=${step.attempts ?? 1}`,
            ];

            if (step.lastEventType) {
              parts.push(`last_event=${step.lastEventType}`);
            }

            if (step.timeoutMs !== null) {
              parts.push(`timeout_ms=${step.timeoutMs}`);
            }

            if (step.status === "failed") {
              const error = asRecord(step.error);
              if (error.timedOut === true) {
                parts.push("timed_out=true");
              }
            }

            if (step.retryDecision) {
              parts.push(`retry=${step.retryDecision}`);
            }

            if (step.retryFamily) {
              parts.push(`family=${step.retryFamily}`);
            }

            if (step.retryable === false) {
              parts.push("retryable=false");
            }

            if (step.willRetry === true) {
              parts.push("will_retry=true");
            }

            if (typeof step.nextAttempt === "number") {
              parts.push(`next_attempt=${step.nextAttempt}`);
            }

            return parts.join("\t");
          }),
        ];
  const execLines =
    execs.length === 0
      ? ["execs: none"]
      : [
          "execs:",
          ...execs.map((exec) => {
            const refs = [exec.stdoutRef, exec.stderrRef].filter(Boolean).join(",");
            const parts = [
              `  ${exec.name}`,
              `key=${exec.key}`,
              `status=${exec.status}`,
              `attempts=${exec.attempts ?? exec.attempt}`,
              `cmd=${[exec.cmd, ...exec.args].join(" ")}`,
            ];

            if (exec.lastEventType) {
              parts.push(`last_event=${exec.lastEventType}`);
            }

            if (exec.exitCode !== null) {
              parts.push(`exit_code=${exec.exitCode}`);
            }

            if (exec.signalCode) {
              parts.push(`signal=${exec.signalCode}`);
            }

            if (refs) {
              parts.push(`refs=${refs}`);
            }

            if (exec.retryDecision) {
              parts.push(`retry=${exec.retryDecision}`);
            }

            if (exec.retryFamily) {
              parts.push(`family=${exec.retryFamily}`);
            }

            if (exec.retryable === false) {
              parts.push("retryable=false");
            }

            if (exec.willRetry === true) {
              parts.push("will_retry=true");
            }

            if (typeof exec.nextAttempt === "number") {
              parts.push(`next_attempt=${exec.nextAttempt}`);
            }

            return parts.join("\t");
          }),
        ];
  const waitLines =
    waits.length === 0
      ? ["waits: none"]
      : [
          "waits:",
          ...waits.map(
            (wait) =>
              `  ${wait.kind}\tkey=${wait.key}\tstatus=${wait.status}${wait.wakeAt ? `\twake_at=${wait.wakeAt}` : ""}${wait.name !== wait.kind ? `\tname=${wait.name}` : ""}`
          ),
        ];
  const signalLines =
    signals.length === 0
      ? ["signals: none"]
      : [
          "signals:",
          ...signals.map(
            (signal) =>
              `  ${signal.name}\tcreated_at=${signal.createdAt}${signal.consumedAt ? `\tconsumed_at=${signal.consumedAt}` : ""}`
          ),
        ];
  const childLines =
    children.length === 0
      ? ["children: none"]
      : [
          "children:",
          ...children.map(
            (child) =>
              `  ${child.definitionName}\tkey=${child.key}\tchild_run=${child.childRunId}\tstatus=${child.status}`
          ),
        ];
  const envelopeLines =
    envelopes.length === 0
      ? ["envelopes: none"]
      : [
          "envelopes:",
          ...envelopes.map((envelope) => {
            const parts = [
              `  ${envelope.kind}`,
              `name=${envelope.name}`,
              `status=${envelope.status}`,
            ];

            if (envelope.correlationId) {
              parts.push(`correlation=${envelope.correlationId}`);
            }

            if (envelope.senderRunId) {
              parts.push(`sender=${envelope.senderRunId}`);
            }

            return parts.join("\t");
          }),
        ];
  const turnLines =
    turns.length === 0
      ? ["turns: none"]
      : [
          "turns:",
          ...turns.map((turn) => {
            const parts = [
              `  ${turn.kind}`,
              `name=${turn.name}`,
              `envelope=${turn.envelopeId}`,
              `status=${turn.status}`,
              `phase=${turn.phase}`,
              `attempts=${turn.attempts}`,
            ];

            if (turn.waitKind && turn.waitKey) {
              parts.push(`waiting=${turn.waitKind}:${turn.waitKey}`);
            }

            if (turn.lastResumeReason) {
              parts.push(`resumed=${turn.lastResumeReason}`);
            }

            if (turn.correlationId) {
              parts.push(`correlation=${turn.correlationId}`);
            }

            if (turn.retryDecision) {
              parts.push(`retry=${turn.retryDecision}`);
            }

            if (turn.retryFamily) {
              parts.push(`family=${turn.retryFamily}`);
            }

            if (turn.retryable === false) {
              parts.push("retryable=false");
            }

            if (turn.willRetry === true) {
              parts.push("will_retry=true");
            }

            if (typeof turn.nextAttempt === "number") {
              parts.push(`next_attempt=${turn.nextAttempt}`);
            }

            return parts.join("\t");
          }),
        ];
  const retrySeriesLines = renderRetrySeries(retrySeries);

  return [
    renderRun(run),
    ...renderRunExplainSummary(buildRunExplain(run, steps, execs, waits, children, envelopes, turns)),
    ...eventLines,
    ...turnLines,
    ...retrySeriesLines,
    ...stepLines,
    ...execLines,
    ...waitLines,
    ...signalLines,
    ...childLines,
    ...envelopeLines,
  ].join("\n");
}

export function decorateRunInspect<T extends {
  events: RunEventRecord[];
  steps: RunStepRecord[];
  execs: RunExecRecord[];
  envelopes: RunEnvelopeRecord[];
}>(body: T): T & { turns: RunTurnRecord[]; retrySeries: RunRetrySeriesRecord[] } {
  return {
    ...body,
    steps: deriveStepViews(body.steps, body.events),
    execs: deriveExecViews(body.execs, body.events),
    turns: deriveServiceTurns(body.events, body.envelopes),
    retrySeries: deriveRetrySeries(body.events),
  };
}

function deriveStepViews(steps: RunStepRecord[], events: RunEventRecord[]): RunStepRecord[] {
  const attempts = new Map<string, number>();
  const lastEvent = new Map<string, { type: string; at: string }>();
  const lastFailure = new Map<string, ReturnType<typeof retryFieldsFromEventBody>>();

  for (const event of events) {
    const body = asRecord(event.body);
    const key = typeof body.key === "string" ? body.key : null;
    if (!key) {
      continue;
    }

    if (event.type === "StepStarted") {
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      lastEvent.set(key, { type: event.type, at: event.createdAt });
    }

    if (event.type === "StepCompleted" || event.type === "StepCancelled" || event.type === "StepFailed") {
      lastEvent.set(key, { type: event.type, at: event.createdAt });
    }

    if (event.type === "StepFailed") {
      lastFailure.set(key, retryFieldsFromEventBody(body));
    }
  }

  return steps.map((step) => ({
    ...step,
    attempts: attempts.get(step.key) ?? step.attempt ?? 1,
    lastEventType: lastEvent.get(step.key)?.type ?? null,
    lastEventAt: lastEvent.get(step.key)?.at ?? null,
    ...lastFailure.get(step.key),
  }));
}

function deriveExecViews(execs: RunExecRecord[], events: RunEventRecord[]): RunExecRecord[] {
  const attempts = new Map<string, number>();
  const lastEvent = new Map<string, { type: string; at: string }>();
  const lastFailure = new Map<string, ReturnType<typeof retryFieldsFromEventBody>>();

  for (const event of events) {
    const body = asRecord(event.body);
    const key = typeof body.key === "string" ? body.key : null;
    if (!key) {
      continue;
    }

    if (event.type === "ProcessStarted") {
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      lastEvent.set(key, { type: event.type, at: event.createdAt });
    }

    if (event.type === "ProcessCompleted" || event.type === "ProcessFailed" || event.type === "ProcessCancelled") {
      lastEvent.set(key, { type: event.type, at: event.createdAt });
    }

    if (event.type === "ProcessFailed") {
      lastFailure.set(key, retryFieldsFromEventBody(body));
    }
  }

  return execs.map((exec) => ({
    ...exec,
    attempts: attempts.get(exec.key) ?? exec.attempt,
    lastEventType: lastEvent.get(exec.key)?.type ?? null,
    lastEventAt: lastEvent.get(exec.key)?.at ?? null,
    ...lastFailure.get(exec.key),
  }));
}

function deriveServiceTurns(events: RunEventRecord[], envelopes: RunEnvelopeRecord[]): RunTurnRecord[] {
  const turns = new Map<string, RunTurnRecord>();

  for (const envelope of envelopes) {
    turns.set(envelope.id, {
      envelopeId: envelope.id,
      kind: envelope.kind,
      name: envelope.name,
      status: envelope.status,
      phase: envelope.status,
      attempts: envelope.attempt ?? 0,
      correlationId: envelope.correlationId,
      senderRunId: envelope.senderRunId,
      waitKind: null,
      waitKey: null,
      waitName: null,
      lastResumeReason: null,
      lastEventType: null,
      lastEventAt: null,
      reply: envelope.reply,
      error: envelope.error,
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
    });
  }

  for (const event of events) {
    const body = asRecord(event.body);
    const envelopeId = typeof body.envelopeId === "string" ? body.envelopeId : null;
    if (!envelopeId) {
      continue;
    }

    const turn = turns.get(envelopeId);
    if (!turn) {
      continue;
    }

    turn.lastEventType = event.type;
    turn.lastEventAt = event.createdAt;

    if (event.type === "TurnStarted" || event.type === "TurnResumed") {
      turn.phase = "running";
    }

    if (event.type === "TurnWaiting") {
      turn.phase = "waiting";
      turn.waitKind = typeof body.waitKind === "string" ? body.waitKind : null;
      turn.waitKey = typeof body.key === "string" ? body.key : null;
      turn.waitName = typeof body.name === "string" ? body.name : null;
    }

    if (event.type === "TurnResumed") {
      turn.lastResumeReason = typeof body.reason === "string" ? body.reason : null;
      turn.waitKind = null;
      turn.waitKey = null;
      turn.waitName = null;
    }

    if (event.type === "TurnCompleted") {
      turn.phase = "completed";
      turn.waitKind = null;
      turn.waitKey = null;
      turn.waitName = null;
    }

    if (event.type === "TurnFailed") {
      turn.phase = "failed";
      Object.assign(turn, retryFieldsFromEventBody(body));
    }
  }

  return Array.from(turns.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
