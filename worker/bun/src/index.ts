import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import process from "node:process";

import type {
  ExecArtifact,
  ExecResult,
  ExecSpec,
  StepOptions,
  WorkflowContext,
  WorkflowDefinition,
} from "@vilano/runtime";

import { WorkerClient, type WorkflowActivation } from "./client.ts";

export interface WorkerOptions {
  workerId?: string;
  serverUrl?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  once?: boolean;
}

export async function startWorker(options: WorkerOptions = {}): Promise<void> {
  const workerId = options.workerId ?? `worker-${crypto.randomUUID()}`;
  const serverUrl = options.serverUrl ?? "http://127.0.0.1:4141";
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
  const client = new WorkerClient(serverUrl, workerId);

  while (true) {
    const activation = await client.leaseActivation();
    if (!activation) {
      if (options.once) {
        return;
      }

      await sleep(pollIntervalMs);
      continue;
    }

    await executeActivation(client, activation, heartbeatIntervalMs);

    if (options.once) {
      return;
    }
  }
}

async function executeActivation(
  client: WorkerClient,
  activation: WorkflowActivation,
  heartbeatIntervalMs: number
): Promise<void> {
  const heartbeat = setInterval(() => {
    void client.heartbeat(activation.leaseId).catch(() => undefined);
  }, heartbeatIntervalMs);

  try {
    const definition = await loadWorkflowDefinition(activation);
    const ctx = createWorkflowContext(client, activation);
    const result = await definition.run(activation.run.input, ctx);
    await client.completeRun(activation.leaseId, result);
  } catch (error) {
    await client.failRun(activation.leaseId, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

async function loadWorkflowDefinition(
  activation: WorkflowActivation
): Promise<WorkflowDefinition<any, any>> {
  const absolutePath = path.join(activation.project.path, activation.definition.file);
  const moduleUrl = pathToFileURL(absolutePath).href;
  const moduleExports = (await import(moduleUrl)) as Record<string, unknown>;
  const definition = moduleExports[activation.definition.exportName];

  if (!definition || typeof definition !== "object" || (definition as { kind?: string }).kind !== "workflow") {
    throw new Error(
      `Export '${activation.definition.exportName}' from ${activation.definition.file} is not a workflow definition`
    );
  }

  return definition as WorkflowDefinition<any, any>;
}

function createWorkflowContext(client: WorkerClient, activation: WorkflowActivation): WorkflowContext {
  return {
    runId: activation.run.id,
    async step<TOutput>(
      name: string,
      fn: () => Promise<TOutput> | TOutput,
      options: StepOptions = {}
    ) {
      const key = options.key ?? name;
      const existing = await client.resolveStep(activation.leaseId, name, key);
      if (existing.status === "completed") {
        return existing.output as TOutput;
      }

      const output = await fn();
      await client.completeStep(activation.leaseId, name, key, output);
      return output;
    },
    async exec<TOutput = ExecResult>(spec: ExecSpec<TOutput>) {
      const key = spec.key ?? spec.name;
      const cwd = resolveExecCwd(activation.project.path, spec.cwd);
      const timeoutMs = parseDurationToMs(spec.timeout);
      const resolved = await client.resolveExec(activation.leaseId, {
        name: spec.name,
        key,
        cmd: spec.cmd,
        args: spec.args ?? [],
        cwd,
        env: spec.env,
        timeoutMs,
      });

      if (resolved.status === "completed") {
        return resolved.output as TOutput;
      }

      if (resolved.status === "failed") {
        throw toExecError(spec.name, resolved.error);
      }

      const execution = await executeProcess(activation, spec, {
        key,
        attempt: resolved.attempt,
        cwd,
        timeoutMs,
      });

      if (execution.ok) {
        await client.completeExec(activation.leaseId, {
          name: spec.name,
          key,
          exitCode: execution.exitCode,
          signalCode: execution.signalCode,
          stdoutRef: execution.stdoutRef,
          stderrRef: execution.stderrRef,
          artifacts: execution.artifacts,
          output: execution.output,
        });

        return execution.output;
      }

      await client.failExec(activation.leaseId, {
        name: spec.name,
        key,
        exitCode: execution.exitCode,
        signalCode: execution.signalCode,
        stdoutRef: execution.stdoutRef,
        stderrRef: execution.stderrRef,
        artifacts: execution.artifacts,
        error: execution.error,
      });

      throw toExecError(spec.name, execution.error);
    },
    async sleep() {
      throw new Error("ctx.sleep() is not implemented yet");
    },
    async waitForSignal() {
      throw new Error("ctx.waitForSignal() is not implemented yet");
    },
    async log(message: string, fields?: Record<string, unknown>) {
      console.log("[vilano-worker]", activation.run.id, message, fields ?? {});
    },
    spawn() {
      throw new Error("ctx.spawn() is not implemented yet");
    },
    async connect() {
      throw new Error("ctx.connect() is not implemented yet");
    },
  };
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function resolveExecCwd(projectPath: string, cwd?: string): string {
  if (!cwd) {
    return projectPath;
  }

  return path.isAbsolute(cwd) ? cwd : path.resolve(projectPath, cwd);
}

function parseDurationToMs(duration?: string): number | undefined {
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

type ExecSuccess<TOutput> = {
  ok: true;
  output: TOutput;
  exitCode: number;
  signalCode: string | null;
  stdoutRef?: string;
  stderrRef?: string;
  artifacts: ExecArtifact[];
};

type ExecFailure = {
  ok: false;
  error: Record<string, unknown>;
  exitCode: number | null;
  signalCode: string | null;
  stdoutRef?: string;
  stderrRef?: string;
  artifacts: ExecArtifact[];
};

async function executeProcess<TOutput>(
  activation: WorkflowActivation,
  spec: ExecSpec<TOutput>,
  execution: {
    key: string;
    attempt: number;
    cwd: string;
    timeoutMs?: number;
  }
): Promise<ExecSuccess<TOutput> | ExecFailure> {
  let subprocess: ReturnType<typeof Bun.spawn>;

  try {
    subprocess = Bun.spawn([spec.cmd, ...(spec.args ?? [])], {
      cwd: execution.cwd,
      env: {
        ...process.env,
        ...(spec.env ?? {}),
      },
      stdout: "pipe",
      stderr: "pipe",
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
      }),
      exitCode: null,
      signalCode: null,
      artifacts: [],
    };
  }

  const stdoutPromise = streamToText(subprocess.stdout);
  const stderrPromise = streamToText(subprocess.stderr);
  let timedOut = false;

  const timer =
    execution.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          subprocess.kill("SIGKILL");
        }, execution.timeoutMs);

  const exitCode = await subprocess.exited;
  if (timer) {
    clearTimeout(timer);
  }

  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  let captures: {
    stdoutRef?: string;
    stderrRef?: string;
    artifacts: ExecArtifact[];
  } = { artifacts: [] };

  try {
    captures = await persistExecCaptures(activation, execution, spec, stdout, stderr);
    const signalCode = subprocess.signalCode;

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
        }),
        exitCode,
        signalCode,
        stdoutRef: captures.stdoutRef,
        stderrRef: captures.stderrRef,
        artifacts: captures.artifacts,
      };
    }

    const defaultOutput: ExecResult = {
      exitCode,
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
        signalCode: subprocess.signalCode,
        timedOut: false,
        stdoutRef: captures.stdoutRef,
        stderrRef: captures.stderrRef,
        artifacts: captures.artifacts,
        stderr,
      }),
      exitCode,
      signalCode: subprocess.signalCode,
      stdoutRef: captures.stdoutRef,
      stderrRef: captures.stderrRef,
      artifacts: captures.artifacts,
    };
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
  activation: WorkflowActivation,
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

function getRuntimeHome(): string {
  return process.env.VILANO_HOME
    ? path.resolve(process.env.VILANO_HOME)
    : path.join(os.homedir(), ".vilano");
}

function buildExecError(input: {
  name: string;
  message: string;
  exitCode: number | null;
  signalCode: string | null;
  timedOut: boolean;
  stdoutRef?: string;
  stderrRef?: string;
  artifacts: ExecArtifact[];
  stderr: string;
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
  };
}

function truncate(value: string, maxLength = 240): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function toExecError(name: string, error: unknown): Error {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return Object.assign(new Error(error.message), { cause: error, execName: name });
  }

  return new Error(`Exec '${name}' failed`);
}
