import type {
  RunChildRecord,
  RunEnvelopeRecord,
  RunEventRecord,
  RunExecRecord,
  RunRecord,
  RunReplayEntry,
  RunRetrySeriesRecord,
  RunSignalRecord,
  RunStepRecord,
  RunTurnRecord,
  RunWaitRecord,
} from "./types.ts";

export function renderRun(run: RunRecord): string {
  const lines = [
    `run: ${run.id}`,
    `project: ${run.project}`,
    `kind: ${run.definitionKind}`,
    `definition: ${run.definitionName}`,
    `status: ${run.status}`,
    `created_at: ${run.createdAt}`,
    `updated_at: ${run.updatedAt}`,
    `input: ${JSON.stringify(run.input)}`,
  ];

  if (run.serviceKey) {
    lines.push(`service_key: ${run.serviceKey}`);
  }

  if (run.state !== undefined) {
    lines.push(`state: ${JSON.stringify(run.state)}`);
  }

  return lines.join("\n");
}

export function renderRunList(project: string | null, runs: RunRecord[]): string {
  if (runs.length === 0) {
    return project ? `No runs found in project ${project}.` : "No runs found.";
  }

  const header = project ? `runs in ${project}` : "runs";
  return [
    header,
    ...runs.map(
      (run) =>
        `${run.id}\t${run.project}/${run.definitionName}\tstatus=${run.status}\tcreated_at=${run.createdAt}`
    ),
  ].join("\n");
}

export function renderServiceRunList(
  project: string | null,
  activeOnly: boolean,
  runs: RunRecord[]
): string {
  if (runs.length === 0) {
    if (project) {
      return activeOnly
        ? `No active service instances found in project ${project}.`
        : `No service instances found in project ${project}.`;
    }

    return activeOnly ? "No active service instances found." : "No service instances found.";
  }

  const header = project
    ? activeOnly
      ? `active service instances in ${project}`
      : `service instances in ${project}`
    : activeOnly
      ? "active service instances"
      : "service instances";

  return [
    header,
    ...runs.map(
      (run) =>
        `${run.id}\t${run.project}/${run.definitionName}\tservice_key=${run.serviceKey ?? "unknown"}\tstatus=${run.status}\tupdated_at=${run.updatedAt}`
    ),
  ].join("\n");
}

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
      : ["events:", ...events.map((event) => `  ${event.seq}. ${event.type}\t${event.createdAt}${renderEventSummary(event)}`)];
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
          ...waits.map((wait) =>
            `  ${wait.kind}\tkey=${wait.key}\tstatus=${wait.status}${wait.wakeAt ? `\twake_at=${wait.wakeAt}` : ""}${wait.name !== wait.kind ? `\tname=${wait.name}` : ""}`
          ),
        ];
  const signalLines =
    signals.length === 0
      ? ["signals: none"]
      : [
          "signals:",
          ...signals.map((signal) =>
            `  ${signal.name}\tcreated_at=${signal.createdAt}${signal.consumedAt ? `\tconsumed_at=${signal.consumedAt}` : ""}`
          ),
        ];
  const childLines =
    children.length === 0
      ? ["children: none"]
      : [
          "children:",
          ...children.map((child) =>
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

export function renderRunReplay(
  run: RunRecord,
  timeline: RunReplayEntry[],
  retrySeries: RunRetrySeriesRecord[]
): string {
  const timelineLines =
    timeline.length === 0
      ? ["timeline: none"]
      : [
          "timeline:",
          ...timeline.map((entry) =>
            `  ${entry.seq}. ${entry.createdAt}\t${entry.type}${entry.summary ? `\t${entry.summary}` : ""}`
          ),
        ];
  const retrySeriesLines = renderRetrySeries(retrySeries);

  return [
    renderRun(run),
    ...retrySeriesLines,
    ...timelineLines,
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

    if (
      event.type === "StepCompleted" ||
      event.type === "StepCancelled" ||
      event.type === "StepFailed"
    ) {
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

    if (
      event.type === "ProcessCompleted" ||
      event.type === "ProcessFailed" ||
      event.type === "ProcessCancelled"
    ) {
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

function deriveServiceTurns(
  events: RunEventRecord[],
  envelopes: RunEnvelopeRecord[]
): RunTurnRecord[] {
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

function deriveRetrySeries(events: RunEventRecord[]): RunRetrySeriesRecord[] {
  const series = new Map<string, RunRetrySeriesRecord>();

  for (const event of events) {
    const body = asRecord(event.body);
    const source = retrySeriesSourceFromEvent(event.type, body);
    if (!source) {
      continue;
    }

    let record = series.get(source.seriesKey);
    if (!record) {
      record = {
        seriesKey: source.seriesKey,
        operationKind: source.operationKind,
        operationKey: source.operationKey,
        name: source.name,
        retryOn: source.retryOn,
        attempts: [],
        lastDecision: null,
        lastFamily: null,
      };
      series.set(source.seriesKey, record);
    } else {
      if (!record.name && source.name) {
        record.name = source.name;
      }

      if (record.retryOn.length === 0 && source.retryOn.length > 0) {
        record.retryOn = source.retryOn;
      }
    }

    let attemptRecord = record.attempts.find((entry) => entry.attempt === source.attempt);
    if (!attemptRecord) {
      attemptRecord = {
        attempt: source.attempt,
        failureEventType: null,
        failureAt: null,
        scheduledAt: null,
      };
      record.attempts.push(attemptRecord);
    }

    const retryFields = retryFieldsFromEventBody(body);
    const backoffFields = retryBackoffFieldsFromEventBody(body);

    if (event.type === "RetryScheduled") {
      attemptRecord.scheduledAt = event.createdAt;
    } else {
      attemptRecord.failureEventType = event.type;
      attemptRecord.failureAt = event.createdAt;
    }

    Object.assign(attemptRecord, retryFields, backoffFields);
    record.lastDecision = attemptRecord.retryDecision ?? record.lastDecision ?? null;
    record.lastFamily = attemptRecord.retryFamily ?? record.lastFamily ?? null;
  }

  return Array.from(series.values())
    .map((record) => ({
      ...record,
      attempts: record.attempts.sort((left, right) => left.attempt - right.attempt),
    }))
    .sort((left, right) => left.seriesKey.localeCompare(right.seriesKey));
}

function retrySeriesSourceFromEvent(
  eventType: string,
  body: Record<string, unknown>
):
  | {
      seriesKey: string;
      operationKind: string;
      operationKey: string;
      name: string;
      attempt: number;
      retryOn: string[];
    }
  | null {
  const retryOn = stringArrayFromUnknown(body.retryOn);

  switch (eventType) {
    case "StepFailed": {
      const operationKey = typeof body.key === "string" ? body.key : null;
      const attempt = typeof body.attempt === "number" ? body.attempt : null;
      if (!operationKey || attempt === null) {
        return null;
      }

      return {
        seriesKey: `step:${operationKey}`,
        operationKind: "step",
        operationKey,
        name: typeof body.name === "string" ? body.name : operationKey,
        attempt,
        retryOn,
      };
    }
    case "ProcessFailed": {
      const operationKey = typeof body.key === "string" ? body.key : null;
      const attempt = typeof body.attempt === "number" ? body.attempt : null;
      if (!operationKey || attempt === null) {
        return null;
      }

      return {
        seriesKey: `exec:${operationKey}`,
        operationKind: "exec",
        operationKey,
        name: typeof body.name === "string" ? body.name : operationKey,
        attempt,
        retryOn,
      };
    }
    case "TurnFailed": {
      const operationKey = typeof body.envelopeId === "string" ? body.envelopeId : null;
      const attempt = typeof body.attempt === "number" ? body.attempt : null;
      if (!operationKey || attempt === null) {
        return null;
      }

      return {
        seriesKey: `service_turn:${operationKey}`,
        operationKind: "service_turn",
        operationKey,
        name: typeof body.name === "string" ? body.name : operationKey,
        attempt,
        retryOn,
      };
    }
    case "RetryScheduled": {
      const operationKind = typeof body.kind === "string" ? body.kind : null;
      const operationKey = typeof body.operationKey === "string" ? body.operationKey : null;
      const attempt = typeof body.attempt === "number" ? body.attempt : null;
      if (!operationKind || !operationKey || attempt === null) {
        return null;
      }

      return {
        seriesKey: `${operationKind}:${operationKey}`,
        operationKind,
        operationKey,
        name: typeof body.name === "string" ? body.name : operationKey,
        attempt,
        retryOn,
      };
    }
    default:
      return null;
  }
}

function renderRetrySeries(retrySeries: RunRetrySeriesRecord[]): string[] {
  if (retrySeries.length === 0) {
    return ["retry_series: none"];
  }

  return [
    "retry_series:",
    ...retrySeries.flatMap((series) => {
      const headerParts = [
        `  ${series.operationKind}`,
        `name=${series.name}`,
        `key=${series.operationKey}`,
        `attempts=${series.attempts.length}`,
      ];

      if (series.retryOn.length > 0) {
        headerParts.push(`retry_on=${series.retryOn.join(",")}`);
      }

      if (series.lastDecision) {
        headerParts.push(`last_decision=${series.lastDecision}`);
      }

      const attemptLines = series.attempts.map((attempt) => {
        const parts = [`    attempt=${attempt.attempt}`];

        if (attempt.retryDecision) {
          parts.push(`decision=${attempt.retryDecision}`);
        }

        if (attempt.retryFamily) {
          parts.push(`family=${attempt.retryFamily}`);
        }

        if (attempt.failureEventType) {
          parts.push(`failure=${attempt.failureEventType}`);
        }

        if (attempt.backoffKind) {
          parts.push(`backoff=${attempt.backoffKind}:${attempt.backoffMs ?? 0}ms`);
        }

        if (typeof attempt.backoffBaseMs === "number") {
          parts.push(`base_ms=${attempt.backoffBaseMs}`);
        }

        if (typeof attempt.backoffCappedMs === "number") {
          parts.push(`capped_ms=${attempt.backoffCappedMs}`);
        }

        if (typeof attempt.backoffCapMs === "number") {
          parts.push(`cap_ms=${attempt.backoffCapMs}`);
        }

        if (attempt.backoffJitterKind) {
          parts.push(`jitter=${attempt.backoffJitterKind}`);
        }

        if (typeof attempt.backoffJitterRatio === "number") {
          parts.push(`jitter_ratio=${attempt.backoffJitterRatio}`);
        }

        if (typeof attempt.backoffJitterMs === "number") {
          parts.push(`jitter_ms=${attempt.backoffJitterMs}`);
        }

        if (typeof attempt.nextAttempt === "number") {
          parts.push(`next_attempt=${attempt.nextAttempt}`);
        }

        if (attempt.retryWakeAt) {
          parts.push(`wake_at=${attempt.retryWakeAt}`);
        }

        return parts.join("\t");
      });

      return [headerParts.join("\t"), ...attemptLines];
    }),
  ];
}

function renderEventSummary(event: RunEventRecord): string {
  const body = asRecord(event.body);

  switch (event.type) {
    case "TurnStarted":
      return formatSummary({
        envelope: body.envelopeId,
        kind: body.kind,
        name: body.name,
      });
    case "TurnWaiting":
      return formatSummary({
        envelope: body.envelopeId,
        wait: body.waitKind,
        key: body.key,
        name: body.turnName ?? body.name,
      });
    case "TurnResumed":
      return formatSummary({
        envelope: body.envelopeId,
        reason: body.reason,
        name: body.name,
      });
    case "TurnCompleted":
    case "TurnFailed":
      return formatSummary({
        envelope: body.envelopeId,
        kind: body.kind,
        name: body.name,
        family: body.retryFamily,
        retry: body.retryDecision,
        retryable: body.retryable,
        willRetry: body.willRetry,
        backoffKind: body.backoffKind,
        backoffMs: body.backoffMs,
        backoffBaseMs: body.backoffBaseMs,
        backoffCappedMs: body.backoffCappedMs,
        backoffJitterKind: body.backoffJitterKind,
        backoffJitterMs: body.backoffJitterMs,
      });
    case "RunCancelled":
      return formatSummary({
        reason: body.reason,
        waits: body.cancelledWaitCount,
        children: body.cancelledChildRunCount,
        asks: body.cancelledServiceAskCount,
      });
    case "ServiceStopped":
      return formatSummary({
        reason: body.reason,
        waits: body.cancelledWaitCount,
        children: body.cancelledChildRunCount,
        asks: body.cancelledServiceAskCount,
      });
    case "StepCancelled":
    case "StepFailed":
    case "ProcessFailed":
    case "ProcessCancelled":
      return formatSummary({
        key: body.key,
        name: body.name,
        family: body.retryFamily,
        retry: body.retryDecision,
        retryable: body.retryable,
        willRetry: body.willRetry,
        backoffKind: body.backoffKind,
        backoffMs: body.backoffMs,
        backoffBaseMs: body.backoffBaseMs,
        backoffCappedMs: body.backoffCappedMs,
        backoffJitterKind: body.backoffJitterKind,
        backoffJitterMs: body.backoffJitterMs,
      });
    case "WaitSatisfied":
      return formatSummary({
        kind: body.kind,
        key: body.key,
      });
    case "RunSuspended":
      return formatSummary({
        reason: body.reason,
        key: body.key,
      });
    default:
      return "";
  }
}

function formatSummary(fields: Record<string, unknown>): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`);

  return parts.length > 0 ? `\t${parts.join("\t")}` : "";
}

function retryFieldsFromEventBody(body: Record<string, unknown>): {
  retryDecision?: string | null;
  retryFamily?: string | null;
  retryable?: boolean | null;
  willRetry?: boolean | null;
  nextAttempt?: number | null;
  retryWakeAt?: string | null;
} {
  return {
    retryDecision: typeof body.retryDecision === "string" ? body.retryDecision : null,
    retryFamily: typeof body.retryFamily === "string" ? body.retryFamily : null,
    retryable: typeof body.retryable === "boolean" ? body.retryable : null,
    willRetry: typeof body.willRetry === "boolean" ? body.willRetry : null,
    nextAttempt: typeof body.nextAttempt === "number" ? body.nextAttempt : null,
    retryWakeAt: typeof body.wakeAt === "string" ? body.wakeAt : null,
  };
}

function retryBackoffFieldsFromEventBody(body: Record<string, unknown>): {
  backoffKind?: string | null;
  backoffMs?: number | null;
  backoffBaseMs?: number | null;
  backoffCappedMs?: number | null;
  backoffCapMs?: number | null;
  backoffJitterKind?: string | null;
  backoffJitterRatio?: number | null;
  backoffJitterMs?: number | null;
} {
  return {
    backoffKind: typeof body.backoffKind === "string" ? body.backoffKind : null,
    backoffMs: typeof body.backoffMs === "number" ? body.backoffMs : null,
    backoffBaseMs: typeof body.backoffBaseMs === "number" ? body.backoffBaseMs : null,
    backoffCappedMs: typeof body.backoffCappedMs === "number" ? body.backoffCappedMs : null,
    backoffCapMs: typeof body.backoffCapMs === "number" ? body.backoffCapMs : null,
    backoffJitterKind:
      typeof body.backoffJitterKind === "string" ? body.backoffJitterKind : null,
    backoffJitterRatio:
      typeof body.backoffJitterRatio === "number" ? body.backoffJitterRatio : null,
    backoffJitterMs: typeof body.backoffJitterMs === "number" ? body.backoffJitterMs : null,
  };
}

function stringArrayFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
