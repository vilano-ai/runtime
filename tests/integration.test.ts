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

class RuntimeHarness {
  private constructor(
    private readonly runtimeHome: string,
    private readonly port: number
  ) {}

  static async create(): Promise<RuntimeHarness> {
    const runtimeHome = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-test-"));
    const port = await reservePort();
    const harness = new RuntimeHarness(runtimeHome, port);

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

  private async runCliJson<T>(args: string[]): Promise<T> {
    const result = await this.runCli([...args, "--json"]);
    return JSON.parse(result.stdout) as T;
  }

  private async runCli(
    args: string[],
    options: { allowFailure?: boolean } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        VILANO_HOME: this.runtimeHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToText(proc.stdout),
      streamToText(proc.stderr),
      proc.exited,
    ]);

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
