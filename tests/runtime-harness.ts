import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import type {
  DaemonState,
  RunCancelResponse,
  RunEnvelopeRecord,
  RunEventRecord,
  RunExecRecord,
  RunInspectResponse,
  RunReplayEntry,
  RunRetrySeriesRecord,
  RunStepRecord,
  RunTurnRecord,
  RunStartResponse,
  ServiceStopResponse,
} from "../cli/src/types.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI_ENTRY = path.join(ROOT, "cli", "bin", "vilano.ts");
const WORKER_ENTRY = path.join(ROOT, "worker", "bun", "src", "cli.ts");
const BOOTSTRAP_DEMO_TMP = path.join(ROOT, "examples", "bootstrap-demo", "tmp");
const ROOT_TMP = path.join(ROOT, "tmp");

export class RuntimeHarness {
  private readonly serviceAddressCache = new Map<string, { project: string; name: string; key: string }>();

  private constructor(
    private readonly runtimeHome: string,
    private readonly port: number,
    private readonly envOverrides: Record<string, string>
  ) {}

  static async create(
    options: {
      env?: Record<string, string>;
    } = {}
  ): Promise<RuntimeHarness> {
    await fs.rm(BOOTSTRAP_DEMO_TMP, { recursive: true, force: true });
    await fs.rm(ROOT_TMP, { recursive: true, force: true });

    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const runtimeHome = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-test-"));
      const port = await reservePort();
      const harness = new RuntimeHarness(runtimeHome, port, {
        VILANO_KERNEL_NO_COMPILE: "1",
        VILANO_KERNEL_PORT: String(port),
        ...(options.env ?? {}),
      });

      try {
        await harness.runCli(["daemon", "start", "--port", String(port)]);
        await harness.runCli(["project", "add", "./examples/bootstrap-demo", "--name", "demo"]);
        return harness;
      } catch (error) {
        lastError = error;
        await harness.dispose();
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to create runtime harness after repeated daemon start attempts");
  }

  async dispose(): Promise<void> {
    try {
      await this.runCli(["daemon", "stop"], { allowFailure: true });
    } finally {
      await fs.rm(this.runtimeHome, { recursive: true, force: true });
      await fs.rm(BOOTSTRAP_DEMO_TMP, { recursive: true, force: true });
      await fs.rm(ROOT_TMP, { recursive: true, force: true });
    }
  }

  async restartDaemon(): Promise<void> {
    await this.runCli(["daemon", "stop"], { allowFailure: true });
    await this.runCli(["daemon", "start", "--port", String(this.port)]);
  }

  async startWorkflow(reference: string, input: unknown): Promise<RunStartResponse> {
    return await this.runCliJson<RunStartResponse>([
      "run",
      "start",
      reference,
      "--input",
      JSON.stringify(input),
    ]);
  }

  async cancelRun(runId: string): Promise<RunCancelResponse> {
    return await this.runCliJson<RunCancelResponse>(["run", "cancel", runId]);
  }

  async inspectRun(runId: string): Promise<RunInspectResponse> {
    const response = await this.requestKernel(`/v1/runs/${encodeURIComponent(runId)}`);
    return decorateRunInspect((await response.json()) as RunInspectResponse);
  }

  async replayRun(runId: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return await this.runCli(["run", "replay", runId]);
  }

  async replayRunJson(
    runId: string
  ): Promise<RunInspectResponse & { timeline: RunReplayEntry[] }> {
    return await this.runCliJson<RunInspectResponse & { timeline: RunReplayEntry[] }>([
      "run",
      "replay",
      runId,
    ]);
  }

  async inspectService(reference: string, keyInput: unknown): Promise<RunInspectResponse> {
    const target = await this.resolveServiceAddress(reference, keyInput);
    const response = await this.requestKernel(
      `/v1/services/${encodeURIComponent(target.project)}/${encodeURIComponent(target.name)}/runs/${encodeURIComponent(target.key)}`
    );
    return decorateRunInspect((await response.json()) as RunInspectResponse);
  }

  async askService(reference: string, messageName: string, keyInput: unknown, input: unknown): Promise<unknown> {
    const response = await this.runCliJson<{ ok: true; reply: unknown }>([
      "service",
      "ask",
      reference,
      messageName,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify(input),
      "--timeout",
      "20s",
    ]);

    return response.reply;
  }

  async sendService(reference: string, messageName: string, keyInput: unknown, input: unknown): Promise<void> {
    await this.runCli([
      "service",
      "send",
      reference,
      messageName,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify(input),
    ]);
  }

  async ensureService(reference: string, keyInput: unknown): Promise<void> {
    await this.runCli([
      "service",
      "ensure",
      reference,
      "--key-json",
      JSON.stringify(keyInput),
    ]);
  }

  async stopService(reference: string, keyInput: unknown): Promise<ServiceStopResponse> {
    return await this.runCliJson<ServiceStopResponse>([
      "service",
      "stop",
      reference,
      "--key-json",
      JSON.stringify(keyInput),
    ]);
  }

  async sendSignal(runId: string, signalName: string, input: unknown): Promise<void> {
    await this.runCli([
      "signal",
      "send",
      runId,
      signalName,
      "--input",
      JSON.stringify(input),
    ]);
  }

  async waitForRun(
    runId: string,
    predicate: (inspect: RunInspectResponse) => boolean,
    timeoutMs = 20_000
  ): Promise<RunInspectResponse> {
    return await waitFor(async () => await this.inspectRun(runId), predicate, timeoutMs);
  }

  async waitForService(
    reference: string,
    keyInput: unknown,
    predicate: (inspect: RunInspectResponse) => boolean,
    timeoutMs = 20_000
  ): Promise<RunInspectResponse> {
    return await waitFor(
      async () => await this.inspectService(reference, keyInput),
      predicate,
      timeoutMs
    );
  }

  async spawnWorker(options: { workerId?: string; once?: boolean } = {}): Promise<SpawnedCommand> {
    const args = [process.execPath, WORKER_ENTRY, "--server", this.serverUrl];

    if (options.workerId) {
      args.push("--worker-id", options.workerId);
    }

    if (options.once) {
      args.push("--once");
    }

    return this.spawnCommand(args, {
      VILANO_DAEMON_TOKEN: await this.readDaemonToken(),
    });
  }

  spawnCliCommand(args: string[]): SpawnedCommand {
    return this.spawnCommand([process.execPath, CLI_ENTRY, ...args]);
  }

  get serverUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get homeDir(): string {
    return this.runtimeHome;
  }

  private async runCliJson<T>(args: string[]): Promise<T> {
    const result = await this.runCli([...args, "--json"]);
    return JSON.parse(result.stdout) as T;
  }

  private async runCli(
    args: string[],
    options: { allowFailure?: boolean } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = this.spawnCommand([process.execPath, CLI_ENTRY, ...args]);
    const { stdout, stderr, exitCode } = await proc.wait();

    if (!options.allowFailure && exitCode !== 0) {
      throw new Error(
        [
          `CLI command failed: ${args.join(" ")}`,
          stdout ? `stdout:\n${stdout}` : "",
          stderr ? `stderr:\n${stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    return {
      stdout,
      stderr,
      exitCode,
    };
  }

  async requestKernel(pathname: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.readDaemonToken();

    return await fetch(`${this.serverUrl}${pathname}`, {
      ...init,
      headers: {
        ...(token ? { "x-vilano-token": token } : {}),
        ...(init.headers ?? {}),
      },
    });
  }

  private spawnCommand(command: string[], extraEnv: Record<string, string> = {}): SpawnedCommand {
    const proc = Bun.spawn(command, {
      cwd: ROOT,
      env: {
        ...process.env,
        VILANO_HOME: this.runtimeHome,
        ...this.envOverrides,
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    return new SpawnedCommand(proc);
  }

  private async readDaemonToken(): Promise<string> {
    const daemonState = await readDaemonState(this.runtimeHome);
    return daemonState?.authToken ?? "";
  }

  private async resolveServiceAddress(
    reference: string,
    keyInput: unknown
  ): Promise<{ project: string; name: string; key: string }> {
    const cacheKey = `${reference}:${JSON.stringify(keyInput)}`;
    const existing = this.serviceAddressCache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const [project, name] = parseQualifiedReference(reference);
    const projectResponse = await this.requestKernel(`/v1/projects/${encodeURIComponent(project)}`);
    const projectBody = (await projectResponse.json()) as {
      ok: true;
      project: { path: string };
    };

    const definitionsResponse = await this.requestKernel(`/v1/services?project=${encodeURIComponent(project)}`);
    const definitionsBody = (await definitionsResponse.json()) as {
      ok: true;
      definitions: Array<{ name: string; exportName: string; file: string }>;
    };

    const definition = definitionsBody.definitions.find((entry) => entry.name === name);
    if (!definition) {
      throw new Error(`Unknown service '${name}' in project '${project}'`);
    }

    const modulePath = path.join(projectBody.project.path, definition.file);
    const module = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
    const service = module[definition.exportName] as { key: (input: unknown) => string } | undefined;

    if (!service || typeof service.key !== "function") {
      throw new Error(`Service definition '${definition.exportName}' in ${modulePath} does not expose a key() function`);
    }

    const resolved = {
      project,
      name,
      key: service.key(keyInput),
    };

    this.serviceAddressCache.set(cacheKey, resolved);
    return resolved;
  }
}

export class SpawnedCommand {
  constructor(private readonly proc: Bun.Subprocess<any, "pipe", "pipe">) {}

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    process.kill(this.proc.pid, signal);
  }

  async wait(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const [stdout, stderr, exitCode] = await Promise.all([
      streamToText(this.proc.stdout),
      streamToText(this.proc.stderr),
      this.proc.exited,
    ]);

    return { stdout, stderr, exitCode };
  }
}

export async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export function expectInOrder(text: string, fragments: string[]): void {
  let lastIndex = -1;

  for (const fragment of fragments) {
    const nextIndex = text.indexOf(fragment, lastIndex + 1);
    expectIndexOrdering(nextIndex, lastIndex);
    lastIndex = nextIndex;
  }
}

function expectIndexOrdering(nextIndex: number, lastIndex: number): void {
  if (nextIndex <= lastIndex) {
    throw new Error(`Expected fragment ordering after index ${lastIndex}, got ${nextIndex}`);
  }
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  const startedAt = Date.now();

  while (Date.now() <= deadline) {
    try {
      const value = await fn();
      if (predicate(value)) {
        maybeLogTiming(`waitFor(${timeoutMs})`, Date.now() - startedAt);
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(150);
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error(`Timed out waiting after ${timeoutMs}ms`);
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve test port")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function streamToText(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>> | number | null | undefined
): Promise<string> {
  if (!stream || typeof stream === "number") {
    return "";
  }

  return await new Response(stream).text();
}

async function readDaemonState(runtimeHome: string): Promise<DaemonState | null> {
  try {
    const raw = await fs.readFile(path.join(runtimeHome, "daemon.json"), "utf8");
    return JSON.parse(raw) as DaemonState;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function parseQualifiedReference(reference: string): [string, string] {
  const slashIndex = reference.indexOf("/");
  if (slashIndex <= 0 || slashIndex === reference.length - 1) {
    throw new Error(`Expected qualified reference like 'project/name', got '${reference}'`);
  }

  return [reference.slice(0, slashIndex), reference.slice(slashIndex + 1)];
}

function maybeLogTiming(label: string, durationMs: number): void {
  if (process.env.VILANO_TEST_TIMING !== "1") {
    return;
  }

  console.error(`[timing] ${label} ${durationMs}ms`);
}

function decorateRunInspect<T extends {
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
    backoffJitterKind: typeof body.backoffJitterKind === "string" ? body.backoffJitterKind : null,
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
