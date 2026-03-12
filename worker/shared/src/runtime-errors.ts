import type { ExecArtifact, RetryFamily } from "./runtime-sdk.ts";

export function toFailureBody(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const body: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    if ("retryable" in error && (error as { retryable?: unknown }).retryable === false) {
      body.retryable = false;
    }

    if ("family" in error && typeof (error as { family?: unknown }).family === "string") {
      body.family = (error as { family: string }).family;
    } else {
      body.family = "application";
    }

    if ("cause" in error) {
      body.cause = (error as Error & { cause?: unknown }).cause;
    }

    return body;
  }

  return {
    message: String(error),
    family: "application",
  };
}

export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return true;
  }

  if ("retryable" in error && (error as { retryable?: unknown }).retryable === false) {
    return false;
  }

  return true;
}

export function toExecError(name: string, error: unknown): Error {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return Object.assign(new Error((error as { message: string }).message), {
      cause: error,
      execName: name,
    });
  }

  return new Error(`Exec '${name}' failed`);
}

export function toStepError(name: string, error: unknown): Error {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return Object.assign(new Error((error as { message: string }).message), {
      cause: error,
      stepName: name,
    });
  }

  return new Error(`Step '${name}' failed`);
}

export function toChildRunError(childRunId: string, error: unknown): Error {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return Object.assign(new Error((error as { message: string }).message), {
      cause: error,
      childRunId,
    });
  }

  return new Error(`Child run '${childRunId}' failed`);
}

export function toServiceAskError(
  serviceRunId: string,
  messageName: string,
  error: unknown
): Error {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return Object.assign(new Error((error as { message: string }).message), {
      cause: error,
      serviceRunId,
      messageName,
    });
  }

  return new Error(`Service ask '${messageName}' failed on '${serviceRunId}'`);
}

export function toServiceCallError(
  serviceRunId: string,
  messageName: string,
  error: unknown,
  kind: "send" | "signal"
): Error {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return Object.assign(new Error((error as { message: string }).message), {
      cause: error,
      serviceRunId,
      messageName,
      kind,
    });
  }

  return new Error(`Service ${kind} '${messageName}' failed on '${serviceRunId}'`);
}

export function isInactiveActivationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.startsWith("Unknown active lease:") ||
    error.message.startsWith("Unknown active service turn:")
  );
}

export function throwAbortReason(reason: unknown): never {
  if (reason instanceof Error) {
    throw reason;
  }

  throw new Error(typeof reason === "string" ? reason : "Step aborted");
}

export class ActivationCancelledError extends Error {
  readonly reason: "lease_inactive";

  constructor(message: string, reason: "lease_inactive") {
    super(message);
    this.name = "ActivationCancelledError";
    this.reason = reason;
  }
}

export class StepControlError extends Error {
  override readonly cause?: unknown;
  readonly reason: "timeout" | "activation_cancelled";

  constructor(reason: "timeout" | "activation_cancelled", message: string, cause?: unknown) {
    super(message);
    this.name = "StepControlError";
    this.reason = reason;
    this.cause = cause;
  }

  toActivationCancelledError(): ActivationCancelledError {
    return new ActivationCancelledError(this.message, "lease_inactive");
  }
}

export class RunSuspendedError extends Error {
  readonly waitKind:
    | "sleep"
    | "signal"
    | "exit"
    | "child_result"
    | "supervision_member_result"
    | "ask_reply"
    | "retry_backoff";
  readonly key: string;

  constructor(
    waitKind:
      | "sleep"
      | "signal"
      | "exit"
      | "child_result"
      | "supervision_member_result"
      | "ask_reply"
      | "retry_backoff",
    key: string
  ) {
    super(`Run suspended on ${waitKind}:${key}`);
    this.name = "RunSuspendedError";
    this.waitKind = waitKind;
    this.key = key;
  }
}

export class TurnHandledError extends Error {
  readonly disposition: "deferred" | "rejected";

  constructor(disposition: "deferred" | "rejected") {
    super(`Service turn ${disposition}`);
    this.disposition = disposition;
  }
}

export function buildExecError(input: {
  name: string;
  message: string;
  exitCode: number | null;
  signalCode: string | null;
  timedOut: boolean;
  stdoutRef?: string;
  stderrRef?: string;
  artifacts: ExecArtifact[];
  stderr: string;
  retryable: boolean;
  family: Exclude<RetryFamily, "always">;
}): Record<string, unknown> {
  return {
    name: "ExecError",
    execName: input.name,
    message: input.stderr ? `${input.message}: ${truncate(input.stderr)}` : input.message,
    exitCode: input.exitCode,
    signalCode: input.signalCode,
    timedOut: input.timedOut,
    stdoutRef: input.stdoutRef,
    stderrRef: input.stderrRef,
    artifacts: input.artifacts,
    retryable: input.retryable,
    family: input.family,
  };
}

export function buildStepError(input: {
  name: string;
  key: string;
  message: string;
  timedOut: boolean;
  timeoutMs?: number;
  cause: unknown;
  retryable: boolean;
  family: Exclude<RetryFamily, "always">;
}): Record<string, unknown> {
  const stack =
    input.cause instanceof Error && typeof input.cause.stack === "string"
      ? input.cause.stack
      : undefined;

  return {
    name: "StepError",
    stepName: input.name,
    key: input.key,
    message: input.message,
    timedOut: input.timedOut,
    timeoutMs: input.timeoutMs,
    stack,
    retryable: input.retryable,
    family: input.family,
  };
}

export function truncate(value: string, maxLength = 240): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}
