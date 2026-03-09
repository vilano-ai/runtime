import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import type {
  ExecArtifact,
  ExecResult,
  ExecSpec,
  RetryBackoff,
  RetryFamily,
  RetryJitter,
  RetryOptions,
} from "./runtime-sdk.ts";
import { WorkerRequestError, type WorkerClient } from "./client.ts";
import type { RuntimeAdapter } from "./runtime-adapter.ts";

interface ActivationLike {
  leaseId: string;
  run: { id: string };
  project: { path: string };
}

let runtimeHomeOverride: string | null = null;

export type ExecSuccess<TOutput> = {
  ok: true;
  output: TOutput;
  exitCode: number;
  signalCode: string | null;
  stdoutRef?: string;
  stderrRef?: string;
  artifacts: ExecArtifact[];
};

export type ExecFailure = {
  ok: false;
  error: Record<string, unknown>;
  exitCode: number | null;
  signalCode: string | null;
  stdoutRef?: string;
  stderrRef?: string;
  artifacts: ExecArtifact[];
};

export function resolveExecCwd(projectPath: string, cwd?: string): string {
  if (!cwd) {
    return projectPath;
  }

  return path.isAbsolute(cwd) ? cwd : path.resolve(projectPath, cwd);
}

export function parseDurationToMs(duration?: string): number | undefined {
  if (!duration) {
    return undefined;
  }

  const value = duration.trim();
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) {
    throw new Error(`Unsupported duration: ${duration}`);
  }

  const amount = Number(match[1]);
  const unit = match[2];

  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      throw new Error(`Unsupported duration unit: ${unit}`);
  }
}

export async function executeProcess<TOutput>(
  adapter: RuntimeAdapter,
  client: WorkerClient,
  activation: ActivationLike,
  spec: ExecSpec<TOutput>,
  execution: {
    key: string;
    attempt: number;
    cwd: string;
    timeoutMs?: number;
  }
): Promise<ExecSuccess<TOutput> | ExecFailure> {
  let subprocess: ReturnType<RuntimeAdapter["spawnProcess"]>;

  try {
    subprocess = adapter.spawnProcess({
      cmd: spec.cmd,
      args: spec.args ?? [],
      cwd: execution.cwd,
      env: buildExecEnv(spec.env),
    });
  } catch (error) {
    return {
      ok: false,
      error: buildExecError({
        name: spec.name,
        message: error instanceof Error ? error.message : String(error),
        exitCode: null,
        signalCode: null,
        timedOut: false,
        artifacts: [],
        stderr: "",
        retryable: true,
        family: "process_spawn",
      }),
      exitCode: null,
      signalCode: null,
      artifacts: [],
    };
  }

  const stdoutPromise = streamToText(subprocess.stdout);
  const stderrPromise = streamToText(subprocess.stderr);
  let timedOut = false;
  let activationCancelled = false;
  let leaseStatusPollInFlight = false;

  const timer =
    execution.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          subprocess.kill("SIGKILL");
        }, execution.timeoutMs);

  const leaseStatusPoller = setInterval(() => {
    if (leaseStatusPollInFlight || activationCancelled) {
      return;
    }

    leaseStatusPollInFlight = true;
    void client
      .getLeaseStatus(activation.leaseId)
      .then((lease) => {
        if (!lease.active && !activationCancelled) {
          activationCancelled = true;
          subprocess.kill("SIGKILL");
        }
      })
      .catch((error) => {
        if (
          error instanceof WorkerRequestError &&
          (error.status === 401 || error.status === 404) &&
          !activationCancelled
        ) {
          activationCancelled = true;
          subprocess.kill("SIGKILL");
        }
      })
      .finally(() => {
        leaseStatusPollInFlight = false;
      });
  }, 250);

  let exitStatus: Awaited<typeof subprocess.exited>;

  try {
    exitStatus = await subprocess.exited;
  } catch (error) {
    if (timer) {
      clearTimeout(timer);
    }
    clearInterval(leaseStatusPoller);

    return {
      ok: false,
      error: buildExecError({
        name: spec.name,
        message: error instanceof Error ? error.message : String(error),
        exitCode: null,
        signalCode: null,
        timedOut: false,
        artifacts: [],
        stderr: "",
        retryable: true,
        family: "process_spawn",
      }),
      exitCode: null,
      signalCode: null,
      artifacts: [],
    };
  }

  if (timer) {
    clearTimeout(timer);
  }
  clearInterval(leaseStatusPoller);

  const exitCode = exitStatus.exitCode;
  const signalCode = exitStatus.signalCode;
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;

  if (activationCancelled) {
    throw new ActivationCancelledError(
      `Activation lease ${activation.leaseId} is no longer active`,
      "lease_inactive"
    );
  }

  let captures: {
    stdoutRef?: string;
    stderrRef?: string;
    artifacts: ExecArtifact[];
  } = { artifacts: [] };

  try {
    captures = await persistExecCaptures(activation, execution, spec, stdout, stderr);

    if (timedOut) {
      return {
        ok: false,
        error: buildExecError({
          name: spec.name,
          message: `Process timed out after ${execution.timeoutMs}ms`,
          exitCode,
          signalCode,
          timedOut: true,
          stdoutRef: captures.stdoutRef,
          stderrRef: captures.stderrRef,
          artifacts: captures.artifacts,
          stderr,
          retryable: true,
          family: "timeout",
        }),
        exitCode,
        signalCode,
        stdoutRef: captures.stdoutRef,
        stderrRef: captures.stderrRef,
        artifacts: captures.artifacts,
      };
    }

    if (signalCode) {
      return {
        ok: false,
        error: buildExecError({
          name: spec.name,
          message: `Process terminated by signal ${signalCode}`,
          exitCode,
          signalCode,
          timedOut: false,
          stdoutRef: captures.stdoutRef,
          stderrRef: captures.stderrRef,
          artifacts: captures.artifacts,
          stderr,
          retryable: true,
          family: "process_exit",
        }),
        exitCode,
        signalCode,
        stdoutRef: captures.stdoutRef,
        stderrRef: captures.stderrRef,
        artifacts: captures.artifacts,
      };
    }

    if (exitCode !== 0) {
      return {
        ok: false,
        error: buildExecError({
          name: spec.name,
          message: `Process exited with code ${exitCode}`,
          exitCode,
          signalCode,
          timedOut: false,
          stdoutRef: captures.stdoutRef,
          stderrRef: captures.stderrRef,
          artifacts: captures.artifacts,
          stderr,
          retryable: true,
          family: "process_exit",
        }),
        exitCode,
        signalCode,
        stdoutRef: captures.stdoutRef,
        stderrRef: captures.stderrRef,
        artifacts: captures.artifacts,
      };
    }

    const defaultOutput: ExecResult = {
      exitCode: exitCode ?? 0,
      signalCode,
      stdout,
      stderr,
      stdoutRef: captures.stdoutRef,
      stderrRef: captures.stderrRef,
      artifacts: captures.artifacts,
    };

    const output = spec.parse ? spec.parse(stdout) : (defaultOutput as TOutput);

    return {
      ok: true,
      output,
      exitCode,
      signalCode,
      stdoutRef: captures.stdoutRef,
      stderrRef: captures.stderrRef,
      artifacts: captures.artifacts,
    };
  } catch (error) {
    return {
      ok: false,
        error: buildExecError({
          name: spec.name,
          message: error instanceof Error ? error.message : String(error),
          exitCode,
          signalCode,
          timedOut: false,
          stdoutRef: captures.stdoutRef,
          stderrRef: captures.stderrRef,
        artifacts: captures.artifacts,
        stderr,
        retryable: isRetryableError(error),
        family: "application",
      }),
      exitCode,
      signalCode,
      stdoutRef: captures.stdoutRef,
      stderrRef: captures.stderrRef,
      artifacts: captures.artifacts,
    };
  }
}

function buildExecEnv(
  overrides: Record<string, string | undefined> | undefined
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...overrides,
  };

  delete env.VILANO_DAEMON_TOKEN;
  delete env.VILANO_WORKER_TOKEN;

  return env;
}

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

export function toExecError(name: string, error: unknown): Error {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return Object.assign(new Error((error as { message: string }).message), { cause: error, execName: name });
  }

  return new Error(`Exec '${name}' failed`);
}

export function toStepError(name: string, error: unknown): Error {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return Object.assign(new Error((error as { message: string }).message), { cause: error, stepName: name });
  }

  return new Error(`Step '${name}' failed`);
}

export function toChildRunError(childRunId: string, error: unknown): Error {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return Object.assign(new Error((error as { message: string }).message), { cause: error, childRunId });
  }

  return new Error(`Child run '${childRunId}' failed`);
}

export function toServiceAskError(serviceRunId: string, messageName: string, error: unknown): Error {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
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
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
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

  constructor(
    message: string,
    reason: "lease_inactive"
  ) {
    super(message);
    this.name = "ActivationCancelledError";
    this.reason = reason;
  }
}

export class StepControlError extends Error {
  override readonly cause?: unknown;
  readonly reason: "timeout" | "activation_cancelled";

  constructor(
    reason: "timeout" | "activation_cancelled",
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "StepControlError";
    this.reason = reason;
    this.cause = cause;
  }

  toActivationCancelledError(): ActivationCancelledError {
    return new ActivationCancelledError(this.message, "lease_inactive");
  }
}

export function deterministicChildRunId(parentRunId: string, key: string): string {
  const digest = crypto.createHash("sha256").update(`${parentRunId}:${key}`).digest("hex").slice(0, 32);
  return `run_${digest}`;
}

export class RunSuspendedError extends Error {
  readonly waitKind: "sleep" | "signal" | "child_result" | "ask_reply" | "retry_backoff";
  readonly key: string;

  constructor(
    waitKind: "sleep" | "signal" | "child_result" | "ask_reply" | "retry_backoff",
    key: string
  ) {
    super(`Run suspended on ${waitKind}:${key}`);
    this.name = "RunSuspendedError";
    this.waitKind = waitKind;
    this.key = key;
  }
}

async function streamToText(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>> | number | null | undefined
): Promise<string> {
  if (!stream || typeof stream === "number") {
    return "";
  }

  return await new Response(stream).text();
}

async function persistExecCaptures<TOutput>(
  activation: ActivationLike,
  execution: {
    key: string;
    attempt: number;
    cwd: string;
  },
  spec: ExecSpec<TOutput>,
  stdout: string,
  stderr: string
): Promise<{
  stdoutRef?: string;
  stderrRef?: string;
  artifacts: ExecArtifact[];
}> {
  const captures = spec.capture ?? {};
  if (!captures.stdout && !captures.stderr && !(captures.artifacts && captures.artifacts.length > 0)) {
    return { artifacts: [] };
  }

  const runtimeHome = getRuntimeHome();
  const attemptDir = path.join(
    runtimeHome,
    "artifacts",
    "runs",
    activation.run.id,
    "execs",
    sanitizePathSegment(execution.key),
    `attempt-${execution.attempt}`
  );

  await fs.mkdir(attemptDir, { recursive: true });

  let stdoutRef: string | undefined;
  let stderrRef: string | undefined;

  if (captures.stdout) {
    const stdoutPath = path.join(attemptDir, "stdout.txt");
    await fs.writeFile(stdoutPath, stdout, "utf8");
    stdoutRef = path.relative(runtimeHome, stdoutPath);
  }

  if (captures.stderr) {
    const stderrPath = path.join(attemptDir, "stderr.txt");
    await fs.writeFile(stderrPath, stderr, "utf8");
    stderrRef = path.relative(runtimeHome, stderrPath);
  }

  const artifacts = await captureArtifacts(runtimeHome, attemptDir, execution.cwd, captures.artifacts ?? []);
  return { stdoutRef, stderrRef, artifacts };
}

async function captureArtifacts(
  runtimeHome: string,
  attemptDir: string,
  cwd: string,
  artifactPaths: string[]
): Promise<ExecArtifact[]> {
  const artifacts: ExecArtifact[] = [];

  for (const artifactPath of artifactPaths) {
    const sourcePath = path.isAbsolute(artifactPath)
      ? artifactPath
      : path.resolve(cwd, artifactPath);
    const targetRelative = path.join("files", sanitizeArtifactPath(artifactPath));
    const targetPath = path.join(attemptDir, targetRelative);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);

    artifacts.push({
      path: artifactPath,
      ref: path.relative(runtimeHome, targetPath),
    });
  }

  return artifacts;
}

function sanitizeArtifactPath(artifactPath: string): string {
  const normalized = artifactPath
    .split(/[\\/]+/)
    .filter((segment) => segment && segment !== "." && segment !== "..");

  if (normalized.length === 0) {
    return path.basename(artifactPath);
  }

  return path.join(...normalized);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function setRuntimeHomeOverride(runtimeHome: string | null): void {
  runtimeHomeOverride = runtimeHome ? path.resolve(runtimeHome) : null;
}

function getRuntimeHome(): string {
  return runtimeHomeOverride
    ? runtimeHomeOverride
    : process.env.VILANO_WORKER_ARTIFACT_HOME
    ? path.resolve(process.env.VILANO_WORKER_ARTIFACT_HOME)
    : process.env.VILANO_RUNTIME_HOME
    ? path.resolve(process.env.VILANO_RUNTIME_HOME)
    : process.env.VILANO_WORKER_HOME
    ? path.resolve(process.env.VILANO_WORKER_HOME)
    : process.env.VILANO_HOME
    ? path.resolve(process.env.VILANO_HOME)
    : path.join(os.homedir(), ".vilano");
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
    input.cause instanceof Error && typeof input.cause.stack === "string" ? input.cause.stack : undefined;

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

export function truncate(value: string, maxLength = 240): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}
