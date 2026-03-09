import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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
    let lastError: unknown;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const runtimeHome = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-test-"));
      const projectDir = path.join(runtimeHome, "projects", "bootstrap-demo");
      await cloneBootstrapDemoProject(projectDir);
      const port = choosePortCandidate();
      const harness = new RuntimeHarness(runtimeHome, port, {
        VILANO_KERNEL_NO_COMPILE: "1",
        VILANO_KERNEL_PORT: String(port),
        ...(options.env ?? {}),
      });

      try {
        await harness.runCli(["daemon", "start", "--port", String(port)]);
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
    try {
      await this.runCli(["daemon", "stop"], { allowFailure: true });
    } finally {
      await makeTreeWritable(deriveExecutionHomeDir(this.runtimeHome)).catch(() => undefined);
      await fs.rm(deriveExecutionHomeDir(this.runtimeHome), { recursive: true, force: true });
      await fs.rm(this.runtimeHome, { recursive: true, force: true });
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

  get artifactHomeDir(): string {
    return path.join(deriveExecutionHomeDir(this.runtimeHome), "artifacts");
  }

  resolveArtifactRef(ref: string): string {
    return path.join(this.artifactHomeDir, ref);
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

    return new SpawnedCommand(proc);
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
