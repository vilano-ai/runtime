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
import {
  SpawnedCommand,
  forceKillPidSync,
  forceKillProcessGroupSync,
  killProcessTree,
  terminateDetachedProcessGroup,
} from "./runtime-harness-processes.ts";
import {
  choosePortCandidate,
  cloneBootstrapDemoProject,
  deriveServiceKey,
  expectInOrder,
  makeTreeWritable,
  maybeLogTiming,
  parseQualifiedReference,
  readDaemonAuthState,
  readDaemonState,
  sleep,
  waitFor,
} from "./runtime-harness-utils.ts";
export { expectInOrder, sleep } from "./runtime-harness-utils.ts";

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
      await cloneBootstrapDemoProject(projectDir, BOOTSTRAP_DEMO_ROOT, SDK_ROOT);
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
