import crypto from "node:crypto";

import type { RetryBackoff, RetryFamily, RetryJitter, RetryOptions } from "./runtime-sdk.ts";
import { parseDurationToMs } from "./runtime-process.ts";

export function deterministicChildRunId(parentRunId: string, key: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${parentRunId}:${key}`)
    .digest("hex")
    .slice(0, 32);
  return `run_${digest}`;
}

export function toRetryPolicy(
  retry?: RetryOptions,
  legacy?: { retries?: number; backoff?: RetryBackoff }
):
  | {
      maxAttempts?: number;
      backoffKind?: "fixed" | "linear" | "exponential";
      backoffMs?: number;
      backoffStepMs?: number;
      backoffFactor?: number;
      maxBackoffMs?: number;
      backoffJitterKind?: "full" | "half" | "ratio";
      backoffJitterRatio?: number;
      retryOn?: string[];
    }
  | undefined {
  const merged = mergeRetryOptions(retry, legacy);
  if (!merged) {
    return undefined;
  }

  const maxAttempts = toMaxAttempts(merged.retries);
  const backoff = resolveRetryBackoff(merged.backoff);
  const retryOn = normalizeRetryOn(merged.on);

  return {
    maxAttempts,
    backoffKind: backoff.backoffKind,
    backoffMs: backoff.backoffMs,
    backoffStepMs: backoff.backoffStepMs,
    backoffFactor: backoff.backoffFactor,
    maxBackoffMs: backoff.maxBackoffMs,
    backoffJitterKind: backoff.backoffJitterKind,
    backoffJitterRatio: backoff.backoffJitterRatio,
    retryOn,
  };
}

export function toMaxAttempts(retries?: number): number {
  if (!Number.isInteger(retries) || retries === undefined || retries < 0) {
    return 1;
  }

  return retries + 1;
}

export function mergeRetryOptions(
  retry?: RetryOptions,
  legacy?: { retries?: number; backoff?: RetryBackoff }
): RetryOptions | undefined {
  const retries = retry?.retries ?? legacy?.retries;
  const backoff = retry?.backoff ?? legacy?.backoff;
  const on = retry?.on;

  if (retries === undefined && backoff === undefined && on === undefined) {
    return undefined;
  }

  return {
    retries,
    backoff,
    on,
  };
}

export function resolveRetryBackoff(backoff?: RetryBackoff): {
  backoffKind: "fixed" | "linear" | "exponential";
  backoffMs: number;
  backoffStepMs?: number;
  backoffFactor?: number;
  maxBackoffMs?: number;
  backoffJitterKind?: "full" | "half" | "ratio";
  backoffJitterRatio?: number;
} {
  if (!backoff) {
    return {
      backoffKind: "fixed",
      backoffMs: 0,
    };
  }

  if (typeof backoff === "string") {
    return {
      backoffKind: "fixed",
      backoffMs: parseDurationToMs(backoff) ?? 0,
    };
  }

  switch (backoff.kind) {
    case "fixed":
      return {
        backoffKind: "fixed",
        backoffMs: parseDurationToMs(backoff.delay) ?? 0,
        ...resolveRetryJitter(backoff.jitter),
      };
    case "linear":
      return {
        backoffKind: "linear",
        backoffMs: parseDurationToMs(backoff.initial) ?? 0,
        backoffStepMs: parseDurationToMs(backoff.step ?? backoff.initial) ?? 0,
        maxBackoffMs: parseDurationToMs(backoff.max),
        ...resolveRetryJitter(backoff.jitter),
      };
    case "exponential":
      return {
        backoffKind: "exponential",
        backoffMs: parseDurationToMs(backoff.initial) ?? 0,
        backoffFactor:
          typeof backoff.factor === "number" && Number.isFinite(backoff.factor) && backoff.factor > 0
            ? backoff.factor
            : 2,
        maxBackoffMs: parseDurationToMs(backoff.max),
        ...resolveRetryJitter(backoff.jitter),
      };
  }
}

export function resolveRetryJitter(jitter?: RetryJitter): {
  backoffJitterKind?: "full" | "half" | "ratio";
  backoffJitterRatio?: number;
} {
  if (!jitter) {
    return {};
  }

  if (jitter === "full") {
    return {
      backoffJitterKind: "full",
      backoffJitterRatio: 1,
    };
  }

  if (jitter === "half") {
    return {
      backoffJitterKind: "half",
      backoffJitterRatio: 0.5,
    };
  }

  if (jitter.kind === "ratio") {
    const ratio = Math.min(Math.max(jitter.ratio, 0), 1);
    return {
      backoffJitterKind: "ratio",
      backoffJitterRatio: Number.isFinite(ratio) ? ratio : 0,
    };
  }

  return {};
}

export function normalizeRetryOn(on?: RetryFamily[]): string[] | undefined {
  if (!on || on.length === 0) {
    return undefined;
  }

  if (on.includes("always")) {
    return ["always"];
  }

  return Array.from(new Set(on));
}
