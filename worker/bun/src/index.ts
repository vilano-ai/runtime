import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import type {
  AskOptions,
  AskResult,
  ConnectOptions,
  ExecArtifact,
  ExecResult,
  ExecSpec,
  MessageOptions,
  RunStatus,
  ServiceDefinition,
  ServiceRef,
  ServiceTurnContext,
  SignalOptions,
  SignalResult,
  SpawnOptions,
  StepOptions,
  WorkflowHandle,
  WorkflowContext,
  WorkflowDefinition,
} from "@vilano/runtime";

import {
  WorkerClient,
  type ServiceTurnActivation,
  type WorkflowActivation,
} from "./client.ts";

type Activation = WorkflowActivation | ServiceTurnActivation;
type ServiceMethodKind = "message" | "ask" | "signal";

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
    let activation: WorkflowActivation | ServiceTurnActivation | null;

    try {
      activation = await client.leaseActivation();
    } catch (error) {
      if (options.once) {
        throw error;
      }

      await sleep(pollIntervalMs);
      continue;
    }

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
  activation: Activation,
  heartbeatIntervalMs: number
): Promise<void> {
  const heartbeat = setInterval(() => {
    void client.heartbeat(activation.leaseId).catch(() => undefined);
  }, heartbeatIntervalMs);

  try {
    if (activation.kind === "workflow") {
      const definition = await loadWorkflowDefinition(activation);
      const ctx = createWorkflowContext(client, activation);
      const result = await definition.run(activation.run.input, ctx);
      await client.completeRun(activation.leaseId, result);
      return;
    }

    const definition = await loadServiceDefinition(activation);
    await executeServiceTurn(client, activation, definition);
  } catch (error) {
    if (error instanceof RunSuspendedError) {
      return;
    }

    if (activation.kind === "workflow") {
      await client.failRun(activation.leaseId, {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } else {
      await client.failServiceTurn(activation.leaseId, activation.envelope.id, {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function loadWorkflowDefinition(
  activation: WorkflowActivation
): Promise<WorkflowDefinition<any, any>> {
  const definition = await loadDefinitionModule(
    activation.project.path,
    activation.definition.file,
    activation.definition.exportName
  );

  if (!definition || typeof definition !== "object" || (definition as { kind?: string }).kind !== "workflow") {
    throw new Error(
      `Export '${activation.definition.exportName}' from ${activation.definition.file} is not a workflow definition`
    );
  }

  return definition as WorkflowDefinition<any, any>;
}

async function loadServiceDefinition(
  activation: ServiceTurnActivation
): Promise<ServiceDefinition<any, any, any, any, any>> {
  const definition = await loadDefinitionModule(
    activation.project.path,
    activation.definition.file,
    activation.definition.exportName
  );

  if (!definition || typeof definition !== "object" || (definition as { kind?: string }).kind !== "service") {
    throw new Error(
      `Export '${activation.definition.exportName}' from ${activation.definition.file} is not a service definition`
    );
  }

  return definition as ServiceDefinition<any, any, any, any, any>;
}

async function loadDefinitionModule(
  projectPath: string,
  file: string,
  exportName: string
): Promise<unknown> {
  const absolutePath = path.join(projectPath, file);
  const moduleUrl = pathToFileURL(absolutePath).href;
  const moduleExports = (await import(moduleUrl)) as Record<string, unknown>;
  return moduleExports[exportName];
}

function createWorkflowContext(client: WorkerClient, activation: WorkflowActivation): WorkflowContext {
  const implicitServiceOpCounters = new Map<string, number>();

  return {
    ...createTurnContext(client, activation),
    spawn<TInput, TOutput>(
      definition: WorkflowDefinition<TInput, TOutput>,
      input: TInput,
      options: SpawnOptions = {}
    ): WorkflowHandle<TOutput> {
      const key = options.key ?? definition.name;
      const childRunId = deterministicChildRunId(activation.run.id, key);
      const spawnPromise = client.resolveSpawn(activation.leaseId, {
        name: definition.name,
        key,
        childRunId,
        input,
      });

      return {
        id: childRunId,
        async result() {
          await spawnPromise;

          const resolved = await client.resolveChildResult(activation.leaseId, {
            childRunId,
            key,
          });

          if (resolved.status === "completed") {
            return resolved.output as TOutput;
          }

          if (resolved.status === "failed") {
            throw toChildRunError(childRunId, resolved.error);
          }

          throw new RunSuspendedError("child_result", `child_result:${childRunId}`);
        },
        async status() {
          await spawnPromise;
          return (await client.getRunStatus(childRunId)) as RunStatus;
        },
        async signal(name: string, payload?: unknown) {
          await spawnPromise;
          await client.sendRunSignal(childRunId, name, payload ?? null);
        },
      };
    },
    async connect<
      TKeyInput,
      TState,
      TSend extends Record<string, (...args: any[]) => any>,
      TAsk extends Record<string, (...args: any[]) => any>,
      TSignal extends Record<string, (...args: any[]) => any>
    >(
      definition: ServiceDefinition<TKeyInput, TState, TSend, TAsk, TSignal>,
      input: TKeyInput,
      _options?: ConnectOptions
    ): Promise<ServiceRef<TSend, TAsk, TSignal>> {
      const serviceKey = definition.key(input);
      const serviceRunId = await client.ensureService(
        activation.project.name,
        definition.name,
        serviceKey,
        input
      );

      return createServiceRef(
        client,
        activation,
        definition,
        serviceRunId,
        implicitServiceOpCounters
      ) as ServiceRef<TSend, TAsk, TSignal>;
    },
  };
}

function createTurnContext(client: WorkerClient, activation: Activation): ServiceTurnContext {
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
    async log(message: string, fields?: Record<string, unknown>) {
      console.log("[vilano-worker]", activation.run.id, message, fields ?? {});
    },
    async sleep(duration: string, options?: { key?: string }) {
      const durationMs = parseDurationToMs(duration);
      if (durationMs === undefined) {
        throw new Error("ctx.sleep() requires a duration");
      }

      const key = options?.key ?? `sleep:${duration}`;
      const resolved = await client.resolveSleepWait(activation.leaseId, { key, durationMs });
      if (resolved.status === "completed") {
        return;
      }

      throw new RunSuspendedError("sleep", key);
    },
    async waitForSignal(name: string, options?: { key?: string }) {
      const key = options?.key ?? name;
      const resolved = await client.resolveSignalWait(activation.leaseId, { name, key });
      if (resolved.status === "completed") {
        return resolved.output;
      }

      throw new RunSuspendedError("signal", key);
    },
  };
}

function createServiceRef(
  client: WorkerClient,
  activation: WorkflowActivation,
  definition: ServiceDefinition<any, any, any, any, any>,
  serviceRunId: string,
  implicitOpCounters: Map<string, number>
): ServiceRef<any, any, any> {
  const sendEntries = Object.keys(definition.onSend ?? {}).map((name) => [
    name,
    async (...args: any[]) => {
      const { payload, options } = splitPayloadAndOptions(args, "message");
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "send",
        name,
        options?.key
      );
      const resolved = await client.resolveServiceSend(activation.leaseId, {
        serviceRunId,
        name,
        key,
        payload: payload ?? null,
      });

      if (resolved.status === "failed") {
        throw toServiceCallError(serviceRunId, name, resolved.error, "send");
      }
    },
  ]);

  const askEntries = Object.keys(definition.onAsk ?? {}).map((name) => [
    name,
    async (...args: any[]) => {
      const { payload, options } = splitPayloadAndOptions(args, "ask");
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "ask",
        name,
        options?.key
      );
      const resolved = await client.resolveServiceAsk(activation.leaseId, {
        serviceRunId,
        name,
        key,
        payload: payload ?? null,
      });

      if (resolved.status === "completed") {
        return resolved.output;
      }

      if (resolved.status === "failed") {
        throw toServiceAskError(serviceRunId, name, resolved.error);
      }

      throw new RunSuspendedError("ask_reply", `ask_reply:ask:${key}`);
    },
  ]);

  const signalEntries = Object.keys(definition.onSignal ?? {}).map((name) => [
    name,
    async (...args: any[]) => {
      const { payload, options } = splitPayloadAndOptions(args, "signal");
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "signal",
        name,
        options?.key
      );
      const resolved = await client.resolveServiceSignal(activation.leaseId, {
        serviceRunId,
        name,
        key,
        payload: payload ?? null,
      });

      if (resolved.status === "failed") {
        throw toServiceCallError(serviceRunId, name, resolved.error, "signal");
      }
    },
  ]);

  return {
    id: serviceRunId,
    send: Object.fromEntries(sendEntries),
    ask: Object.fromEntries(askEntries),
    signal: Object.fromEntries(signalEntries),
    async status() {
      return (await client.getRunStatus(serviceRunId)) as RunStatus;
    },
  };
}

async function executeServiceTurn(
  client: WorkerClient,
  activation: ServiceTurnActivation,
  definition: ServiceDefinition<any, any, any, any, any>
): Promise<void> {
  const ctx = createTurnContext(client, activation);
  let state = activation.service.state;
  let shouldCommitState = false;

  if (state == null && definition.init) {
    state = await definition.init(activation.service.keyInput, ctx);
    shouldCommitState = true;
  }

  const envelope = activation.envelope;
  const payload = envelope.payload === null ? undefined : envelope.payload;

  if (envelope.kind === "ask") {
    const handler = definition.onAsk?.[envelope.name];
    if (typeof handler !== "function") {
      throw new Error(`Unknown service ask handler '${envelope.name}' on '${definition.name}'`);
    }

    const result = (await handler(payload, state, ctx)) as AskResult<any, unknown>;
    const nextState = hasOwnState(result) ? result.state : state;

    await client.completeServiceTurn(activation.leaseId, envelope.id, {
      state: shouldCommitState || hasOwnState(result) ? nextState : undefined,
      reply: result.reply,
      stop: result.stop === true,
    });

    return;
  }

  if (envelope.kind === "send") {
    const handler = definition.onSend?.[envelope.name];
    if (typeof handler !== "function") {
      throw new Error(`Unknown service send handler '${envelope.name}' on '${definition.name}'`);
    }

    const result = (await handler(payload, state, ctx)) as
      | void
      | { state?: unknown; stop?: true };
    const nextState = hasOwnState(result) ? result.state : state;

    await client.completeServiceTurn(activation.leaseId, envelope.id, {
      state: shouldCommitState || hasOwnState(result) ? nextState : undefined,
      stop: result?.stop === true,
    });

    return;
  }

  const handler = definition.onSignal?.[envelope.name];
  if (typeof handler !== "function") {
    throw new Error(`Unknown service signal handler '${envelope.name}' on '${definition.name}'`);
  }

  const result = (await handler(payload, state, ctx)) as SignalResult<any>;
  const nextState = hasOwnState(result) ? result.state : state;

  await client.completeServiceTurn(activation.leaseId, envelope.id, {
    state: shouldCommitState || hasOwnState(result) ? nextState : undefined,
    stop: result?.stop === true,
  });
}

function hasOwnState(value: unknown): value is { state?: unknown } {
  return Boolean(value) && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "state");
}

function splitPayloadAndOptions(
  args: unknown[],
  kind: ServiceMethodKind
): {
  payload: unknown;
  options: AskOptions | MessageOptions | SignalOptions | undefined;
} {
  if (args.length === 0) {
    return { payload: undefined, options: undefined };
  }

  if (args.length === 1 && looksLikeOptions(args[0], kind)) {
    return {
      payload: undefined,
      options: args[0] as AskOptions | MessageOptions | SignalOptions,
    };
  }

  return {
    payload: args[0],
    options: looksLikeOptions(args[1], kind)
      ? (args[1] as AskOptions | MessageOptions | SignalOptions)
      : undefined,
  };
}

function looksLikeOptions(value: unknown, kind: ServiceMethodKind): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const allowedKeys = kind === "ask" ? new Set(["key", "timeout"]) : new Set(["key"]);
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => allowedKeys.has(key));
}

function nextImplicitServiceOpKey(
  counters: Map<string, number>,
  serviceRunId: string,
  opKind: "send" | "ask" | "signal",
  messageName: string,
  explicitKey?: string
): string {
  if (explicitKey) {
    return explicitKey;
  }

  const counterKey = `${serviceRunId}:${opKind}:${messageName}`;
  const nextCount = (counters.get(counterKey) ?? 0) + 1;
  counters.set(counterKey, nextCount);
  return `${opKind}:${serviceRunId}:${messageName}:${nextCount}`;
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
  activation: Activation,
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
  activation: Activation,
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

function toChildRunError(childRunId: string, error: unknown): Error {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return Object.assign(new Error(error.message), { cause: error, childRunId });
  }

  return new Error(`Child run '${childRunId}' failed`);
}

function toServiceAskError(serviceRunId: string, messageName: string, error: unknown): Error {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return Object.assign(new Error(error.message), { cause: error, serviceRunId, messageName });
  }

  return new Error(`Service ask '${messageName}' failed on '${serviceRunId}'`);
}

function toServiceCallError(
  serviceRunId: string,
  messageName: string,
  error: unknown,
  kind: "send" | "signal"
): Error {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return Object.assign(new Error(error.message), { cause: error, serviceRunId, messageName, kind });
  }

  return new Error(`Service ${kind} '${messageName}' failed on '${serviceRunId}'`);
}

function deterministicChildRunId(parentRunId: string, key: string): string {
  const digest = crypto.createHash("sha256").update(`${parentRunId}:${key}`).digest("hex").slice(0, 32);
  return `run_${digest}`;
}

class RunSuspendedError extends Error {
  constructor(
    readonly waitKind: "sleep" | "signal" | "child_result" | "ask_reply",
    readonly key: string
  ) {
    super(`Run suspended on ${waitKind}:${key}`);
    this.name = "RunSuspendedError";
  }
}
