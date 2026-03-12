import type { RunEventRecord } from "../types.ts";

export function renderEventSummary(event: RunEventRecord): string {
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

export function formatSummary(fields: Record<string, unknown>): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`);

  return parts.length > 0 ? `\t${parts.join("\t")}` : "";
}

export function retryFieldsFromEventBody(body: Record<string, unknown>): {
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

export function retryBackoffFieldsFromEventBody(body: Record<string, unknown>): {
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

export function stringArrayFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
