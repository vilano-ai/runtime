import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import type {
  RunCancelResponse,
  RunInspectResponse,
  RunStartResponse,
} from "../cli/src/types.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI_ENTRY = path.join(ROOT, "cli", "bin", "vilano.ts");
const WORKER_ENTRY = path.join(ROOT, "worker", "bun", "src", "cli.ts");

class RuntimeHarness {
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
    const runtimeHome = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-test-"));
    const port = await reservePort();
    const harness = new RuntimeHarness(runtimeHome, port, options.env ?? {});

    await harness.runCli(["daemon", "start", "--port", String(port)]);
    await harness.runCli(["project", "add", "./examples/bootstrap-demo", "--name", "demo"]);

    return harness;
  }

  async dispose(): Promise<void> {
    try {
      await this.runCli(["daemon", "stop"], { allowFailure: true });
    } finally {
      await fs.rm(this.runtimeHome, { recursive: true, force: true });
    }
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

  async ensureService(reference: string, keyInput: unknown): Promise<void> {
    await this.runCli([
      "service",
      "ensure",
      reference,
      "--key-json",
      JSON.stringify(keyInput),
    ]);
  }

  async waitForRun(
    runId: string,
    predicate: (inspect: RunInspectResponse) => boolean,
    timeoutMs = 10_000
  ): Promise<RunInspectResponse> {
    return await waitFor(async () => await this.inspectRun(runId), predicate, timeoutMs);
  }

  async waitForService(
    reference: string,
    keyInput: unknown,
    predicate: (inspect: RunInspectResponse) => boolean,
    timeoutMs = 10_000
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

class SpawnedCommand {
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

test("run cancel fails waiting workflows and records cancellation counts", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/sleeper", { duration: "30s" });

    await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "waiting" && inspect.waits.some((wait) => wait.status === "waiting")
    );

    const cancelled = await harness.cancelRun(run.run.id);
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.cancelledWaitCount).toBe(1);
    expect(cancelled.cancelledChildRunCount).toBe(0);
    expect(cancelled.cancelledServiceAskCount).toBe(0);

    const inspect = await harness.waitForRun(
      run.run.id,
      (body) => body.run.status === "cancelled"
    );

    expect(inspect.waits.map((wait) => wait.status)).toContain("failed");
    expect(inspect.events.map((event) => event.type)).toContain("RunCancelled");
  } finally {
    await harness.dispose();
  }
});

test("run cancel propagates to spawned child workflows", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/slowDelegator", {
      topic: "BEAM",
      duration: "30s",
    });

    const parentInspect = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.children.length === 1 &&
        inspect.children[0]?.childRunId !== undefined
    );

    const childRunId = parentInspect.children[0]?.childRunId;
    expect(childRunId).toBeTruthy();

    const cancelled = await harness.cancelRun(run.run.id);
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.cancelledChildRunCount).toBe(1);

    const cancelledParent = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "cancelled" &&
        inspect.children.every((child) => child.status === "cancelled")
    );

    expect(cancelledParent.children.map((child) => child.status)).toContain("cancelled");

    const cancelledChild = await harness.waitForRun(
      childRunId as string,
      (inspect) => inspect.run.status === "cancelled"
    );

    expect(cancelledChild.events.map((event) => event.type)).toContain("RunCancelled");
  } finally {
    await harness.dispose();
  }
});

test("run cancel propagates through outbound service asks", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "cancel-session" };

  try {
    const run = await harness.startWorkflow("demo/approvalCoordinator", keyInput);

    await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.waits.some((wait) => wait.kind === "ask_reply" && wait.status === "waiting")
    );

    await harness.waitForService(
      "demo/operator",
      keyInput,
      (inspect) => inspect.envelopes.length > 0 && (inspect.turns ?? []).length > 0
    );

    const cancelled = await harness.cancelRun(run.run.id);
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.cancelledServiceAskCount).toBe(1);

    const workflowInspect = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "cancelled"
    );
    expect(workflowInspect.events.map((event) => event.type)).toContain("RunCancelled");

    const serviceInspect = await harness.waitForService(
      "demo/operator",
      keyInput,
      (inspect) =>
        inspect.run.status === "idle" &&
        inspect.envelopes.some((envelope) => envelope.status === "failed") &&
        (inspect.turns ?? []).some((turn) => turn.phase === "failed")
    );

    expect(serviceInspect.envelopes.map((envelope) => envelope.status)).toContain("failed");
  } finally {
    await harness.dispose();
  }
});

test("run cancel marks active exec work cancelled", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/longExec", { durationMs: 30_000 });

    await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.execs.some((exec) => exec.status === "running")
    );

    const cancelled = await harness.cancelRun(run.run.id);
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.hadActiveLease).toBeTrue();

    const inspect = await harness.waitForRun(
      run.run.id,
      (body) =>
        body.run.status === "cancelled" &&
        body.execs.some((exec) => exec.status === "cancelled")
    );

    expect(inspect.execs.map((exec) => exec.status)).toContain("cancelled");
    expect(inspect.execs.map((exec) => exec.lastEventType)).toContain("ProcessCancelled");
    expect(inspect.events.map((event) => event.type)).toContain("RunCancelled");
  } finally {
    await harness.dispose();
  }
});

test("workflow runs resume after worker loss and lease expiry", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_MANAGED_WORKERS: "0",
      VILANO_LEASE_DURATION_SECONDS: "2",
    },
  });

  try {
    const run = await harness.startWorkflow("demo/slowWorkflowStep", { durationMs: 1500 });
    const firstWorker = await harness.spawnWorker({ workerId: "test-replay-workflow-1", once: true });

    await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "running" &&
        inspect.steps.some((step) => step.status === "running")
    );

    firstWorker.kill();
    await firstWorker.wait();
    await sleep(2_300);

    const secondWorker = await harness.spawnWorker({ workerId: "test-replay-workflow-2", once: true });
    const secondResult = await secondWorker.wait();
    expect(secondResult.exitCode).toBe(0);

    const inspect = await harness.waitForRun(
      run.run.id,
      (body) =>
        body.run.status === "completed" &&
        body.steps.some((step) => step.status === "completed")
    );

    expect(inspect.steps.map((step) => step.attempts)).toContain(2);
    expect(inspect.events.filter((event) => event.type === "RunLeaseGranted")).toHaveLength(2);
    expect(inspect.events.map((event) => event.type)).toContain("RunCompleted");
  } finally {
    await harness.dispose();
  }
});

test("service turns resume after worker loss and lease expiry", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_MANAGED_WORKERS: "0",
      VILANO_LEASE_DURATION_SECONDS: "4",
    },
  });

  const keyInput = { sessionId: "lease-recovery" };

  try {
    await harness.ensureService("demo/operator", keyInput);

    const askCommand = harness.spawnCliCommand([
        "service",
        "ask",
        "demo/operator",
        "slowStep",
        "--key-json",
        JSON.stringify(keyInput),
        "--input",
        JSON.stringify({ durationMs: 2500 }),
        "--timeout",
        "20s",
        "--json",
      ]);

    await harness.waitForService(
      "demo/operator",
      keyInput,
      (inspect) =>
        inspect.run.status === "pending" &&
        inspect.envelopes.some((envelope) => envelope.status === "queued"),
      5_000
    );

    const firstWorker = await harness.spawnWorker({ workerId: "test-replay-service-1", once: true });

    await harness.waitForService(
      "demo/operator",
      keyInput,
      (inspect) =>
        inspect.run.status === "active" &&
        inspect.turns?.some((turn) => turn.phase === "running") === true &&
        inspect.steps.some((step) => step.status === "running")
    );

    firstWorker.kill();
    await firstWorker.wait();
    await sleep(4_300);

    const secondWorker = await harness.spawnWorker({ workerId: "test-replay-service-2", once: true });
    const [secondResult, askResult] = await Promise.all([secondWorker.wait(), askCommand.wait()]);

    expect(secondResult.exitCode).toBe(0);
    expect(askResult.exitCode).toBe(0);

    const askBody = JSON.parse(askResult.stdout) as { ok: true; reply: { waitedMs: number } };
    expect(askBody.reply.waitedMs).toBe(2500);

    const inspect = await harness.waitForService(
      "demo/operator",
      keyInput,
      (body) =>
        body.run.status === "idle" &&
        (body.turns ?? []).some((turn) => turn.phase === "completed")
    );

    expect((inspect.turns ?? []).map((turn) => turn.attempts)).toContain(2);
    expect((inspect.turns ?? []).map((turn) => turn.lastResumeReason)).toContain("lease_expired");
    expect(inspect.steps.map((step) => step.attempts)).toContain(2);
  } finally {
    await harness.dispose();
  }
});

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

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
