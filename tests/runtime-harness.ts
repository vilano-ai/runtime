import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import type {
  RunCancelResponse,
  RunInspectResponse,
  RunReplayEntry,
  RunStartResponse,
  ServiceStopResponse,
} from "../cli/src/types.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI_ENTRY = path.join(ROOT, "cli", "bin", "vilano.ts");
const WORKER_ENTRY = path.join(ROOT, "worker", "bun", "src", "cli.ts");
const BOOTSTRAP_DEMO_TMP = path.join(ROOT, "examples", "bootstrap-demo", "tmp");
const ROOT_TMP = path.join(ROOT, "tmp");

export class RuntimeHarness {
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
    return await this.runCliJson<RunInspectResponse>(["run", "inspect", runId]);
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
    return await this.runCliJson<RunInspectResponse>([
      "service",
      "inspect",
      reference,
      "--key-json",
      JSON.stringify(keyInput),
    ]);
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

    return this.spawnCommand(args);
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

  private spawnCommand(command: string[]): SpawnedCommand {
    const proc = Bun.spawn(command, {
      cwd: ROOT,
      env: {
        ...process.env,
        VILANO_HOME: this.runtimeHome,
        ...this.envOverrides,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    return new SpawnedCommand(proc);
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

  while (Date.now() <= deadline) {
    try {
      const value = await fn();
      if (predicate(value)) {
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
