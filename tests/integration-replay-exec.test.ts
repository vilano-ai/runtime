import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import { RuntimeHarness, expectInOrder } from "./runtime-harness.ts";

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

    await fs.access(harness.resolveArtifactRef(exec.stdoutRef as string));
    await fs.access(harness.resolveArtifactRef(exec.stderrRef as string));
    await fs.access(harness.resolveArtifactRef(exec.artifacts[0]!.ref));
  } finally {
    await harness.dispose();
  }
});

test("exec env secrets are not persisted verbatim in runtime storage", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const secret = "super-secret-token";
    const run = await harness.startWorkflow("demo/execEnvSecretProbe", { secret });
    const completed = await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed");

    const db = new Database(`${harness.homeDir}/runtime.sqlite`, { readonly: true });
    try {
      const rows = db
        .query("select env_json from run_execs where run_id = ?")
        .all(completed.run.id) as Array<{ env_json: string | null }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.env_json).toContain("EXEC_SECRET");
      expect(rows[0]?.env_json).not.toContain(secret);
    } finally {
      db.close(false);
    }
  } finally {
    await harness.dispose();
  }
});

test("run replay renders a chronological workflow timeline", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/planner", { topic: "replay-workflow" });
    await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed");

    const replay = await harness.replayRun(run.run.id);
    expect(replay.exitCode).toBe(0);
    expect(replay.stdout).toContain("timeline:");
    expectInOrder(replay.stdout, [
      "RunStarted",
      "RunLeaseGranted",
      "ProcessStarted",
      "ProcessCompleted",
      "RunCompleted",
    ]);
  } finally {
    await harness.dispose();
  }
});

test("run replay renders wait and signal lifecycle for workflows", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/gate", {});

    await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.waits.some((wait) => wait.kind === "signal" && wait.status === "waiting")
    );

    await harness.sendSignal(run.run.id, "approved", { source: "replay-signal" });
    await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed", 20_000);

    const replay = await harness.replayRun(run.run.id);
    expect(replay.exitCode).toBe(0);
    expect(replay.stdout).toContain("WaitRegistered");
    expect(replay.stdout).toContain("RunSuspended");
    expect(replay.stdout).toContain("reason=signal");
    expect(replay.stdout).toContain("SignalReceived");
    expect(replay.stdout).toContain("signal=approved");
    expect(replay.stdout).toContain("WaitSatisfied");
    expect(replay.stdout).toContain("kind=signal");
    expectInOrder(replay.stdout, [
      "WaitRegistered",
      "RunSuspended",
      "SignalReceived",
      "WaitSatisfied",
      "RunCompleted",
    ]);
  } finally {
    await harness.dispose();
  }
});

test("run explain json reports the current wait and critical path", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/gate", {});

    await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.waits.some((wait) => wait.kind === "signal" && wait.status === "waiting")
    );

    const explainCommand = harness.spawnCliCommand(["run", "explain", run.run.id, "--json"]);
    const result = await explainCommand.wait();

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      ok: true;
      run: { id: string };
      explain: {
        summary: string;
        criticalPath: string;
        waitingTurn: string | null;
      };
    };

    expect(body.run.id).toBe(run.run.id);
    expect(body.explain.summary).toContain("active wait");
    expect(body.explain.criticalPath).toContain("signal");
  } finally {
    await harness.dispose();
  }
});

test("run replay renders retry backoff lifecycle for workflows", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/retryingStep", {
      token: "replay-retry",
      retries: 1,
      backoff: "50ms",
    });

    await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed", 20_000);

    const replay = await harness.replayRun(run.run.id);
    expect(replay.exitCode).toBe(0);
    expect(replay.stdout).toContain("RetryScheduled");
    expect(replay.stdout).toContain("retry=scheduled");
    expect(replay.stdout).toContain("kind=step");
    expect(replay.stdout).toContain("WaitRegistered");
    expect(replay.stdout).toContain("kind=retry_backoff");
    expect(replay.stdout).toContain("RunSuspended");
    expect(replay.stdout).toContain("reason=retry_backoff");
    expect(replay.stdout).toContain("TimerFired");
    expect(replay.stdout).toContain("WaitSatisfied");
    expectInOrder(replay.stdout, [
      "StepFailed",
      "RetryScheduled",
      "WaitRegistered",
      "RunSuspended",
      "TimerFired",
      "WaitSatisfied",
      "StepCompleted",
      "RunCompleted",
    ]);
  } finally {
    await harness.dispose();
  }
});

test("run replay renders retry series with cap and jitter details", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/retryingStep", {
      token: "replay-jitter",
      retries: 3,
      failuresBeforeSuccess: 3,
      backoff: {
        kind: "exponential",
        initial: "100ms",
        factor: 2,
        max: "150ms",
        jitter: {
          kind: "ratio",
          ratio: 0.5,
        },
      },
    });

    await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed", 20_000);

    const replay = await harness.replayRun(run.run.id);
    expect(replay.exitCode).toBe(0);
    expect(replay.stdout).toContain("retry_series:");
    expect(replay.stdout).toContain("jitter=ratio");
    expect(replay.stdout).toContain("cap_ms=150");
    expect(replay.stdout).toContain("base_ms=400");

    const replayJson = await harness.replayRunJson(run.run.id);
    expect(replayJson.retrySeries).toHaveLength(1);
    expect(replayJson.retrySeries?.[0]?.attempts).toHaveLength(3);
    expect(replayJson.retrySeries?.[0]?.attempts.map((attempt) => attempt.backoffCappedMs)).toEqual([
      100,
      150,
      150,
    ]);
  } finally {
    await harness.dispose();
  }
});

test("run replay json includes service turn timelines", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/reviewCoordinator", {
      repoId: "replay-service",
      note: "Focus on timeline output",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );
    const serviceRunId =
      completed.run.output && typeof completed.run.output === "object"
        ? (completed.run.output as Record<string, unknown>).reviewerRunId
        : null;

    expect(typeof serviceRunId).toBe("string");

    const replay = await harness.replayRunJson(serviceRunId as string);
    const replayTypes = replay.timeline.map((entry) => entry.type);

    expect(replay.run.definitionKind).toBe("service");
    expect(replay.timeline.length).toBeGreaterThan(0);
    expect(replayTypes).toContain("InboundEnqueued");
    expect(replayTypes).toContain("TurnStarted");
    expect(replayTypes).toContain("TurnCompleted");
    expect(replay.turns?.some((turn) => turn.phase === "completed")).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("service history replays the keyed service timeline", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const repoId = "service-history";
    const run = await harness.startWorkflow("demo/reviewCoordinator", {
      repoId,
      note: "Focus on history output",
    });

    await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed");

    const historyCommand = harness.spawnCliCommand([
      "service",
      "history",
      "demo/reviewer",
      "--service-key",
      repoId,
    ]);
    const result = await historyCommand.wait();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("timeline:");
    expect(result.stdout).toContain("InboundEnqueued");
    expect(result.stdout).toContain("TurnStarted");
    expect(result.stdout).toContain("TurnCompleted");
  } finally {
    await harness.dispose();
  }
});

test("run replay json captures waiting and resumed service turns", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "replay-await-approval" };

  try {
    await harness.ensureService("demo/operator", keyInput);

    const askCommand = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/operator",
      "awaitApproval",
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--wait-timeout",
      "20s",
      "--json",
    ]);

    const waiting = await harness.waitForService(
      "demo/operator",
      keyInput,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.waits.some((wait) => wait.kind === "signal" && wait.status === "waiting") &&
        (inspect.turns ?? []).some((turn) => turn.phase === "waiting"),
      20_000
    );

    await harness.sendSignal(waiting.run.id, "approved", { source: "service-replay" });

    const askResult = await askCommand.wait();
    expect(askResult.exitCode).toBe(0);

    const replay = await harness.replayRunJson(waiting.run.id);
    const replayTypes = replay.timeline.map((entry) => entry.type);

    expect(replayTypes).toContain("TurnWaiting");
    expect(replayTypes).toContain("SignalReceived");
    expect(replayTypes).toContain("WaitSatisfied");
    expect(replayTypes).toContain("TurnResumed");
    expect(
      replay.timeline.some(
        (entry) =>
          entry.type === "TurnResumed" &&
          entry.summary.includes("reason=wait_satisfied")
      )
    ).toBe(true);
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
      20_000
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

test("exec retry families can exclude process exit failures", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/retryingExec", {
      token: "exec-timeout-only",
      retries: 2,
      retryOn: ["timeout"],
    });

    const failed = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "failed" &&
        inspect.execs.some((entry) => entry.name === "retrying-exec" && entry.status === "failed"),
      20_000
    );

    const exec = failed.execs.find((entry) => entry.name === "retrying-exec");
    expect(exec?.attempts).toBe(1);
    expect(exec?.retryDecision).toBe("family_not_selected");
    expect(exec?.retryFamily).toBe("process_exit");
    expect(exec?.retryable).toBe(false);
    expect(failed.events.map((event) => event.type)).not.toContain("RetryScheduled");
  } finally {
    await harness.dispose();
  }
});

test("non-retryable exec failures bypass configured retries", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/nonRetryingExec", {
      token: "exec-no-retry",
    });

    const failed = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "failed" &&
        inspect.execs.some((entry) => entry.name === "non-retrying-exec" && entry.status === "failed"),
      20_000
    );

    const exec = failed.execs.find((entry) => entry.name === "non-retrying-exec");
    expect(exec?.attempts).toBe(1);
    expect(
      exec?.error && typeof exec.error === "object"
        ? (exec.error as Record<string, unknown>).retryable
        : null
    ).toBe(false);
    expect(exec?.retryDecision).toBe("non_retryable");
    expect(exec?.retryable).toBe(false);
    expect(exec?.willRetry).toBe(false);
    expect(failed.events.map((event) => event.type)).not.toContain("RetryScheduled");
  } finally {
    await harness.dispose();
  }
});

test("signal-terminated execs fail durably instead of completing", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/signaledExec", { token: "sigterm" });
    const inspect = await harness.waitForRun(run.run.id, (body) => body.run.status === "failed");

    expect(inspect.run.status).toBe("failed");
    expect(inspect.execs).toHaveLength(1);
    expect(inspect.execs[0]?.status).toBe("failed");
    expect(inspect.execs[0]?.signalCode).toBe("SIGTERM");
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

    await fs.access(harness.resolveArtifactRef(exec.stderrRef as string));
    await fs.access(harness.resolveArtifactRef(exec.artifacts[0]!.ref));

    expect(failed.events.map((event) => event.type)).toContain("ProcessFailed");
    expect(failed.events.map((event) => event.type)).toContain("RunFailed");
  } finally {
    await harness.dispose();
  }
});
