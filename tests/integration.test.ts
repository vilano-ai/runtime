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
const BOOTSTRAP_DEMO_TMP = path.join(ROOT, "examples", "bootstrap-demo", "tmp");

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
    await fs.rm(BOOTSTRAP_DEMO_TMP, { recursive: true, force: true });

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
      await fs.rm(BOOTSTRAP_DEMO_TMP, { recursive: true, force: true });
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

test("cooperative step cancellation releases the worker for later runs", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const longRun = await harness.startWorkflow("demo/cooperativeStep", {
      durationMs: 30_000,
    });

    await harness.waitForRun(
      longRun.run.id,
      (inspect) => inspect.run.status === "running" && inspect.steps.some((step) => step.status === "running")
    );

    const cancelled = await harness.cancelRun(longRun.run.id);
    expect(cancelled.run.status).toBe("cancelled");

    const planner = await harness.startWorkflow("demo/planner", { topic: "after-cancel" });
    const plannerInspect = await harness.waitForRun(
      planner.run.id,
      (inspect) => inspect.run.status === "completed",
      5_000
    );

    expect(plannerInspect.run.output).toEqual({ summary: "planned: after-cancel" });

    const cancelledInspect = await harness.waitForRun(
      longRun.run.id,
      (inspect) =>
        inspect.run.status === "cancelled" &&
        inspect.steps.some((step) => step.status === "cancelled")
    );

    expect(cancelledInspect.events.map((event) => event.type)).toContain("StepCancelled");
  } finally {
    await harness.dispose();
  }
});

test("cooperative step timeouts fail the step and run durably", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/cooperativeStep", {
      durationMs: 5_000,
      timeout: "200ms",
    });

    const failed = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "failed" &&
        inspect.steps.some((step) => step.status === "failed")
    );

    const step = failed.steps.find((entry) => entry.name === "cooperative-step");
    expect(step).toBeTruthy();
    expect(step?.timeoutMs).toBe(200);
    expect(step?.status).toBe("failed");
    expect(
      step?.error && typeof step.error === "object"
        ? (step.error as Record<string, unknown>).timedOut
        : null
    ).toBe(true);
    expect(failed.events.map((event) => event.type)).toContain("StepFailed");
    expect(failed.events.map((event) => event.type)).toContain("RunFailed");
  } finally {
    await harness.dispose();
  }
});

test("blocking step timeout is enforced by the kernel and restarts the worker", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/blockingStep", {
      durationMs: 5_000,
      timeout: "200ms",
    });

    const failed = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "failed" &&
        inspect.steps.some((step) => step.name === "blocking-step" && step.status === "failed"),
      10_000
    );

    const step = failed.steps.find((entry) => entry.name === "blocking-step");
    expect(step).toBeTruthy();
    expect(step?.error && typeof step.error === "object" ? (step.error as Record<string, unknown>).timedOut : null).toBe(
      true
    );
    expect(
      step?.error && typeof step.error === "object"
        ? (step.error as Record<string, unknown>).forcedTermination
        : null
    ).toBe(true);

    const planner = await harness.startWorkflow("demo/planner", { topic: "after-blocking-timeout" });
    const plannerInspect = await harness.waitForRun(
      planner.run.id,
      (inspect) => inspect.run.status === "completed",
      10_000
    );

    expect(plannerInspect.run.output).toEqual({ summary: "planned: after-blocking-timeout" });
  } finally {
    await harness.dispose();
  }
});

test("step retries back off durably and eventually complete", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/retryingStep", {
      token: "step-retry",
      retries: 1,
      backoff: "50ms",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "completed" &&
        inspect.steps.some((step) => step.name === "retrying-step" && step.status === "completed"),
      10_000
    );

    expect(completed.run.output).toEqual({ attempt: 2, token: "step-retry" });
    expect(completed.events.map((event) => event.type)).toContain("RetryScheduled");

    const step = completed.steps.find((entry) => entry.name === "retrying-step");
    expect(step?.attempts).toBe(2);
    expect(step?.status).toBe("completed");
    expect(
      completed.waits.some((wait) => wait.kind === "retry_backoff" && wait.status === "completed")
    ).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("run cancel kills the managed worker for non-cooperative steps", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/blockingStep", {
      durationMs: 30_000,
    });

    await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "running" && inspect.steps.some((step) => step.status === "running")
    );

    const cancelled = await harness.cancelRun(run.run.id);
    expect(cancelled.run.status).toBe("cancelled");

    const planner = await harness.startWorkflow("demo/planner", { topic: "after-blocking-cancel" });
    const plannerInspect = await harness.waitForRun(
      planner.run.id,
      (inspect) => inspect.run.status === "completed",
      10_000
    );

    expect(plannerInspect.run.output).toEqual({ summary: "planned: after-blocking-cancel" });

    const cancelledInspect = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "cancelled" &&
        inspect.steps.some((step) => step.name === "blocking-step" && step.status === "cancelled"),
      10_000
    );

    expect(cancelledInspect.events.map((event) => event.type)).toContain("RunCancelled");
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

test("service turns retry durably after handler failures", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "service-retry" };

  try {
    const reply = await harness.askService(
      "demo/retryingResponder",
      "unstable",
      keyInput,
      { token: "service-retry" }
    );

    expect(reply).toEqual({ attempt: 2, token: "service-retry" });

    const inspect = await harness.waitForService(
      "demo/retryingResponder",
      keyInput,
      (body) =>
        body.run.status === "idle" &&
        (body.turns ?? []).some((turn) => turn.phase === "completed"),
      10_000
    );

    expect(inspect.events.map((event) => event.type)).toContain("RetryScheduled");
    expect((inspect.turns ?? []).map((turn) => turn.attempts)).toContain(2);
    expect(
      inspect.waits.some((wait) => wait.kind === "retry_backoff" && wait.status === "completed")
    ).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("signals wake waiting workflows durably after downtime", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_MANAGED_WORKERS: "0",
    },
  });

  try {
    const run = await harness.startWorkflow("demo/gate", {});
    const worker = await harness.spawnWorker({ workerId: "signal-waiter", once: true });
    await worker.wait();

    await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.waits.some((wait) => wait.kind === "signal" && wait.status === "waiting")
    );

    await harness.sendSignal(run.run.id, "approved", { source: "late" });

    const pending = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "pending" &&
        inspect.waits.some((wait) => wait.kind === "signal" && wait.status === "completed") &&
        inspect.signals.some((signal) => signal.name === "approved" && signal.consumedAt !== null)
    );

    expect(pending.events.map((event) => event.type)).toContain("SignalReceived");
    expect(pending.events.map((event) => event.type)).toContain("WaitSatisfied");

    const resumeWorker = await harness.spawnWorker({ workerId: "signal-resumer", once: true });
    const resumeResult = await resumeWorker.wait();
    expect(resumeResult.exitCode).toBe(0);

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );

    expect(completed.run.output).toEqual({ approval: { source: "late" } });
  } finally {
    await harness.dispose();
  }
});

test("signals sent before activation are buffered and consumed on first wait", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_MANAGED_WORKERS: "0",
    },
  });

  try {
    const run = await harness.startWorkflow("demo/gate", {});

    await harness.sendSignal(run.run.id, "approved", { source: "buffered" });

    const buffered = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "pending" &&
        inspect.signals.some((signal) => signal.name === "approved" && signal.consumedAt === null)
    );

    expect(buffered.events.map((event) => event.type)).toContain("SignalReceived");

    const worker = await harness.spawnWorker({ workerId: "signal-buffered", once: true });
    const workerResult = await worker.wait();
    expect(workerResult.exitCode).toBe(0);

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );

    expect(completed.run.output).toEqual({ approval: { source: "buffered" } });
    expect(completed.events.map((event) => event.type)).toContain("WaitSatisfied");
    expect(completed.events.map((event) => event.type)).not.toContain("RunSuspended");
  } finally {
    await harness.dispose();
  }
});

test("exec success captures stdout stderr and artifacts", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/planner", { topic: "BEAM" });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed" && inspect.execs.length === 1
    );

    expect(completed.run.output).toEqual({ summary: "planned: BEAM" });
    expect(completed.execs).toHaveLength(1);

    const exec = completed.execs[0]!;
    expect(exec.status).toBe("completed");
    expect(exec.stdoutRef).toBeTruthy();
    expect(exec.stderrRef).toBeTruthy();
    expect(exec.artifacts).toHaveLength(1);

    await fs.access(path.join(harness.homeDir, exec.stdoutRef as string));
    await fs.access(path.join(harness.homeDir, exec.stderrRef as string));
    await fs.access(path.join(harness.homeDir, exec.artifacts[0]!.ref));
  } finally {
    await harness.dispose();
  }
});

test("exec retries back off durably and eventually complete", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/retryingExec", {
      token: "exec-retry",
      retries: 1,
      backoff: "50ms",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "completed" &&
        inspect.execs.some((entry) => entry.name === "retrying-exec" && entry.status === "completed"),
      10_000
    );

    expect(completed.run.output).toEqual({ attempt: 2, token: "exec-retry" });
    expect(completed.events.map((event) => event.type)).toContain("RetryScheduled");

    const exec = completed.execs.find((entry) => entry.name === "retrying-exec");
    expect(exec?.attempts).toBe(2);
    expect(exec?.status).toBe("completed");
    expect(
      completed.waits.some((wait) => wait.kind === "retry_backoff" && wait.status === "completed")
    ).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("exec timeout persists failure metadata and captured artifacts", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/timedExec", {
      durationMs: 5_000,
      timeout: "200ms",
    });

    const failed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "failed" && inspect.execs.length === 1
    );

    expect(failed.execs).toHaveLength(1);
    const exec = failed.execs[0]!;
    expect(exec.status).toBe("failed");
    expect(exec.stderrRef).toBeTruthy();
    expect(exec.artifacts).toHaveLength(1);
    expect(exec.error && typeof exec.error === "object" ? (exec.error as Record<string, unknown>).timedOut : null).toBe(
      true
    );

    await fs.access(path.join(harness.homeDir, exec.stderrRef as string));
    await fs.access(path.join(harness.homeDir, exec.artifacts[0]!.ref));

    expect(failed.events.map((event) => event.type)).toContain("ProcessFailed");
    expect(failed.events.map((event) => event.type)).toContain("RunFailed");
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
