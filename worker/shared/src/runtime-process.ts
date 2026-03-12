import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import type { ExecArtifact, ExecResult, ExecSpec } from "./runtime-sdk.ts";
import { WorkerRequestError, type WorkerClient } from "./client.ts";
import type { RuntimeAdapter } from "./runtime-adapter.ts";
import {
  ActivationCancelledError,
  buildExecError,
  isRetryableError,
} from "./runtime-errors.ts";

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
      env: buildExecEnv(spec.env, execution.attempt),
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
  overrides: Record<string, string | undefined> | undefined,
  attempt: number
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...overrides,
    VILANO_EXEC_ATTEMPT: String(attempt),
  };

  delete env.VILANO_DAEMON_TOKEN;
  delete env.VILANO_WORKER_TOKEN;

  return env;
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
