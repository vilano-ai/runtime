import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import type {
  DaemonAuthState,
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
import { decorateRunInspect } from "../cli/src/run-views.ts";
import { deriveExecutionHomeDir } from "../cli/src/runtime-home.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI_ENTRY = path.join(ROOT, "cli", "bin", "vilano.ts");
const WORKER_ROOT = path.join(ROOT, "worker");
const BOOTSTRAP_DEMO_ROOT = path.join(ROOT, "examples", "bootstrap-demo");
const SDK_ROOT = path.join(ROOT, "sdk", "typescript");
const activeHarnesses = new Set<RuntimeHarness>();
let cleanupHooksInstalled = false;
let forcingGlobalCleanup = false;

export class RuntimeHarness {
  private readonly serviceAddressCache = new Map<string, { project: string; name: string; key: string }>();
  private readonly spawnedCommands = new Set<SpawnedCommand>();
  private daemonPid: number | null = null;
  private disposed = false;

  private constructor(
    private readonly runtimeHome: string,
    private readonly port: number,
    private readonly envOverrides: Record<string, string>
  ) {
    registerActiveHarness(this);
  }

  static async create(
    options: {
      env?: Record<string, string>;
    } = {}
  ): Promise<RuntimeHarness> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const runtimeHome = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-test-"));
      const projectDir = path.join(runtimeHome, "projects", "bootstrap-demo");
      await cloneBootstrapDemoProject(projectDir);
      const port = choosePortCandidate();
      const harness = new RuntimeHarness(runtimeHome, port, {
        VILANO_KERNEL_NO_COMPILE: "1",
        VILANO_KERNEL_PORT: String(port),
        VILANO_REPO_POOL_SIZE: "1",
        ...(options.env ?? {}),
      });

      try {
        await harness.runCli(["daemon", "start", "--port", String(port)]);
        await harness.refreshDaemonPid();
        await harness.runCli(["project", "add", projectDir, "--name", "demo"]);
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
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    await this.refreshDaemonPid();

    try {
      await this.runCli(["daemon", "stop"], { allowFailure: true });
    } finally {
      await this.terminateOutstandingCommands();
      await terminateDetachedProcessGroup(this.daemonPid);
      unregisterActiveHarness(this);
      await makeTreeWritable(deriveExecutionHomeDir(this.runtimeHome)).catch(() => undefined);
      await fs.rm(deriveExecutionHomeDir(this.runtimeHome), { recursive: true, force: true });
      await fs.rm(this.runtimeHome, { recursive: true, force: true });
      this.daemonPid = null;
    }
  }

  async restartDaemon(): Promise<void> {
    await this.runCli(["daemon", "stop"], { allowFailure: true });
    await this.runCli(["daemon", "start", "--port", String(this.port)]);
    await this.refreshDaemonPid();
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
    const target = await this.resolveServiceAddress(reference, keyInput);
    const response = await this.runCliJson<{ ok: true; reply: unknown }>([
      "service",
      "ask",
      reference,
      messageName,
      "--service-key",
      target.key,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify(input),
      "--wait-timeout",
      "20s",
    ]);

    return response.reply;
  }

  async sendService(reference: string, messageName: string, keyInput: unknown, input: unknown): Promise<void> {
    const target = await this.resolveServiceAddress(reference, keyInput);
    await this.runCli([
      "service",
      "send",
      reference,
      messageName,
      "--service-key",
      target.key,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify(input),
    ]);
  }

  async ensureService(reference: string, keyInput: unknown): Promise<void> {
    const target = await this.resolveServiceAddress(reference, keyInput);
    await this.runCli([
      "service",
      "ensure",
      reference,
      "--service-key",
      target.key,
      "--key-json",
      JSON.stringify(keyInput),
    ]);
  }

  async stopService(reference: string, keyInput: unknown): Promise<ServiceStopResponse> {
    const target = await this.resolveServiceAddress(reference, keyInput);
    return await this.runCliJson<ServiceStopResponse>([
      "service",
      "stop",
      reference,
      "--service-key",
      target.key,
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

  async spawnWorker(
    options: { workerId?: string; once?: boolean; runtime?: "bun" | "node" } = {}
  ): Promise<SpawnedCommand> {
    const runtime = options.runtime ?? "bun";
    const executable = runtime === "node" ? "node" : "bun";
    const workerEntry = path.join(WORKER_ROOT, runtime, "src", "cli.ts");
    const args = [executable, workerEntry, "--server", this.serverUrl];
    const workerHome = path.join(deriveExecutionHomeDir(this.runtimeHome), "worker-home");

    await fs.mkdir(workerHome, { recursive: true });

    if (options.workerId) {
      args.push("--worker-id", options.workerId);
    }

    if (options.once) {
      args.push("--once");
    }

    return this.spawnCommand(
      args,
      {
        VILANO_WORKER_TOKEN: await this.readWorkerToken(),
        VILANO_WORKER_ARTIFACT_HOME: path.join(deriveExecutionHomeDir(this.runtimeHome), "artifacts"),
        VILANO_WORKER_HOME: workerHome,
      },
      workerHome,
      false
    );
  }

  spawnCliCommand(args: string[]): SpawnedCommand {
    return this.spawnCommand([process.execPath, CLI_ENTRY, ...args]);
  }

  async runCliJson<T>(args: string[]): Promise<T> {
    const result = await this.runCli([...args, "--json"]);
    return JSON.parse(result.stdout) as T;
  }

  get serverUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get homeDir(): string {
    return this.runtimeHome;
  }

  get daemonProcessId(): number | null {
    return this.daemonPid;
  }

  get artifactHomeDir(): string {
    return path.join(deriveExecutionHomeDir(this.runtimeHome), "artifacts");
  }

  resolveArtifactRef(ref: string): string {
    return path.join(this.artifactHomeDir, ref);
  }

  forceCleanupSync(): void {
    for (const command of this.spawnedCommands) {
      command.forceKillSync();
    }

    forceKillProcessGroupSync(this.daemonPid);
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

  private spawnCommand(
    command: string[],
    extraEnv: Record<string, string> = {},
    cwd = ROOT,
    includeRuntimeHome = true
  ): SpawnedCommand {
    const proc = Bun.spawn(command, {
      cwd,
      env: {
        ...process.env,
        ...(includeRuntimeHome ? { VILANO_HOME: this.runtimeHome } : {}),
        ...this.envOverrides,
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    let spawned!: SpawnedCommand;
    spawned = new SpawnedCommand(proc, () => {
      this.spawnedCommands.delete(spawned);
    });
    this.spawnedCommands.add(spawned);
    return spawned;
  }

  private async readDaemonToken(): Promise<string> {
    const daemonAuth = await readDaemonAuthState(this.runtimeHome);
    return daemonAuth?.authToken ?? "";
  }

  private async readWorkerToken(): Promise<string> {
    const daemonAuth = await readDaemonAuthState(this.runtimeHome);
    return daemonAuth?.workerAuthToken ?? "";
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
    const serviceRunsResponse = await this.requestKernel(
      `/v1/service-runs?project=${encodeURIComponent(project)}`
    );
    const serviceRunsBody = (await serviceRunsResponse.json()) as {
      ok: true;
      runs: Array<{ definitionName: string; serviceKey?: string; keyInput?: unknown }>;
    };

    const existingRun = serviceRunsBody.runs.find(
      (entry) =>
        entry.definitionName === name &&
        entry.serviceKey &&
        JSON.stringify(entry.keyInput ?? null) === JSON.stringify(keyInput ?? null)
    );

    if (existingRun?.serviceKey) {
      const resolved = {
        project,
        name,
        key: existingRun.serviceKey,
      };

      this.serviceAddressCache.set(cacheKey, resolved);
      return resolved;
    }

    const resolved = {
      project,
      name,
      key: deriveServiceKey(keyInput),
    };

    this.serviceAddressCache.set(cacheKey, resolved);
    return resolved;
  }

  private async refreshDaemonPid(): Promise<void> {
    this.daemonPid = (await readDaemonState(this.runtimeHome))?.pid ?? this.daemonPid;
  }

  private async terminateOutstandingCommands(): Promise<void> {
    const commands = [...this.spawnedCommands];
    await Promise.all(commands.map((command) => command.terminate().catch(() => undefined)));
  }
}

function deriveServiceKey(keyInput: unknown): string {
  if (typeof keyInput === "string" && keyInput.trim() !== "") {
    return keyInput;
  }

  if (
    keyInput &&
    typeof keyInput === "object" &&
    !Array.isArray(keyInput)
  ) {
    const entries = Object.entries(keyInput as Record<string, unknown>).filter(
      ([, value]) =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    );

    if (entries.length === 1) {
      return String(entries[0]?.[1]);
    }
  }

  throw new Error(
    "RuntimeHarness could not derive a service key from key input. Pass a simple stable identifier."
  );
}

export class SpawnedCommand {
  private waitPromise: Promise<{ stdout: string; stderr: string; exitCode: number }> | null = null;

  constructor(
    private readonly proc: Bun.Subprocess<any, "pipe", "pipe">,
    private readonly onSettled: () => void
  ) {}

  get pid(): number {
    return this.proc.pid;
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    void killProcessTree(this.proc.pid, signal).catch(() => undefined);
  }

  async wait(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return await this.ensureWaitPromise();
  }

  async terminate(): Promise<void> {
    const waitPromise = this.ensureWaitPromise();

    await killProcessTree(this.proc.pid, "SIGTERM").catch(() => undefined);
    if (await waitForPromiseSettled(waitPromise, 1_500)) {
      return;
    }

    await killProcessTree(this.proc.pid, "SIGKILL").catch(() => undefined);
    await waitForPromiseSettled(waitPromise, 1_500);
  }

  forceKillSync(): void {
    forceKillPidSync(this.proc.pid);
  }

  private ensureWaitPromise(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!this.waitPromise) {
      this.waitPromise = Promise.all([
        streamToText(this.proc.stdout),
        streamToText(this.proc.stderr),
        this.proc.exited,
      ])
        .then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }))
        .finally(() => {
          this.onSettled();
        });
    }

    return this.waitPromise;
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

async function cloneBootstrapDemoProject(projectDir: string): Promise<void> {
  await fs.mkdir(path.dirname(projectDir), { recursive: true });
  await fs.cp(BOOTSTRAP_DEMO_ROOT, projectDir, {
    recursive: true,
    force: true,
    filter: (_source, destination) => {
      const name = path.basename(destination);
      return name !== ".vilano" && name !== "tmp";
    },
  });

  const runtimePackageDir = path.join(projectDir, "node_modules", "@vilano", "runtime");
  await fs.mkdir(path.dirname(runtimePackageDir), { recursive: true });
  await fs.symlink(SDK_ROOT, runtimePackageDir, "dir");
}

function choosePortCandidate(): number {
  const min = 20_000;
  const max = 50_000;
  return min + Math.floor(Math.random() * (max - min));
}

async function streamToText(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>> | number | null | undefined
): Promise<string> {
  if (!stream || typeof stream === "number") {
    return "";
  }

  return await new Response(stream).text();
}

function registerActiveHarness(harness: RuntimeHarness): void {
  activeHarnesses.add(harness);
  installCleanupHooks();
}

function unregisterActiveHarness(harness: RuntimeHarness): void {
  activeHarnesses.delete(harness);
}

function installCleanupHooks(): void {
  if (cleanupHooksInstalled) {
    return;
  }

  cleanupHooksInstalled = true;

  process.once("SIGINT", () => {
    forceCleanupAllHarnessesSync();
    process.exit(130);
  });

  process.once("SIGTERM", () => {
    forceCleanupAllHarnessesSync();
    process.exit(143);
  });

  process.once("exit", () => {
    forceCleanupAllHarnessesSync();
  });
}

function forceCleanupAllHarnessesSync(): void {
  if (forcingGlobalCleanup) {
    return;
  }

  forcingGlobalCleanup = true;
  for (const harness of activeHarnesses) {
    harness.forceCleanupSync();
  }
}

async function terminateDetachedProcessGroup(pid: number | null): Promise<void> {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return;
  }

  signalProcessGroup(pid as number, "SIGTERM");
  if (await waitForProcessExit(pid as number, 1_500)) {
    return;
  }

  signalProcessGroup(pid as number, "SIGKILL");
  if (await waitForProcessExit(pid as number, 1_500)) {
    return;
  }

  await killProcessTree(pid as number, "SIGKILL").catch(() => undefined);
}

async function killProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  const childPids = await listChildPids(pid);
  for (const childPid of childPids.reverse()) {
    signalPid(childPid, signal);
  }

  signalPid(pid, signal);
}

async function listChildPids(rootPid: number): Promise<number[]> {
  const proc = Bun.spawn(["ps", "-axo", "pid=,ppid="], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  const childrenByParent = new Map<number, number[]>();

  for (const line of output.split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/, 2);
    const pid = Number.parseInt(pidText ?? "", 10);
    const parentPid = Number.parseInt(parentText ?? "", 10);

    if (!Number.isFinite(pid) || !Number.isFinite(parentPid)) {
      continue;
    }

    const siblings = childrenByParent.get(parentPid) ?? [];
    siblings.push(pid);
    childrenByParent.set(parentPid, siblings);
  }

  const discovered: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];

  while (queue.length > 0) {
    const nextPid = queue.shift()!;
    discovered.push(nextPid);
    queue.push(...(childrenByParent.get(nextPid) ?? []));
  }

  return discovered;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }
}

function forceKillProcessGroupSync(pid: number | null): void {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return;
  }

  try {
    process.kill(-(pid as number), "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }

  forceKillPidSync(pid);
}

function forceKillPidSync(pid: number | null): void {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return;
  }

  signalPid(pid as number, "SIGKILL");
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await isProcessAlive(pid))) {
      return true;
    }

    await sleep(100);
  }

  return !(await isProcessAlive(pid));
}

async function waitForPromiseSettled<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    sleep(timeoutMs).then(() => false),
  ]);
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
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

async function readDaemonAuthState(runtimeHome: string): Promise<DaemonAuthState | null> {
  try {
    const raw = await fs.readFile(path.join(runtimeHome, "daemon-auth.json"), "utf8");
    return JSON.parse(raw) as DaemonAuthState;
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

async function makeTreeWritable(rootPath: string): Promise<void> {
  const stat = await fs.lstat(rootPath);

  if (stat.isDirectory()) {
    const entries = await fs.readdir(rootPath);
    await Promise.all(entries.map((entry) => makeTreeWritable(path.join(rootPath, entry))));
    await fs.chmod(rootPath, stat.mode | 0o200);
    return;
  }

  if (stat.isFile()) {
    await fs.chmod(rootPath, stat.mode | 0o200);
  }
}
