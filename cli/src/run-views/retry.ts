import type { RunEventRecord, RunRetrySeriesRecord } from "../types.ts";
import {
  asRecord,
  retryBackoffFieldsFromEventBody,
  retryFieldsFromEventBody,
  stringArrayFromUnknown,
} from "./shared.ts";

export function deriveRetrySeries(events: RunEventRecord[]): RunRetrySeriesRecord[] {
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

export function renderRetrySeries(retrySeries: RunRetrySeriesRecord[]): string[] {
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
