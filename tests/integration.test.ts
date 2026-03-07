import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { RuntimeHarness, expectInOrder, sleep } from "./runtime-harness.ts";

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
    expect(step?.retryDecision).toBe("retries_disabled");
    expect(step?.retryable).toBe(true);
    expect(step?.willRetry).toBe(false);
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
      30_000
    );

    const step = failed.steps.find((entry) => entry.name === "blocking-step");
    expect(step).toBeTruthy();
    expect(step?.error && typeof step.error === "object" ? (step.error as Record<string, unknown>).timedOut : null).toBe(
      true
    );
    expect(step?.retryDecision).toBe("retries_disabled");
    expect(step?.retryable).toBe(true);
    expect(step?.willRetry).toBe(false);
    expect(
      step?.error && typeof step.error === "object"
        ? (step.error as Record<string, unknown>).forcedTermination
        : null
    ).toBe(true);

    const planner = await harness.startWorkflow("demo/planner", { topic: "after-blocking-timeout" });
    const plannerInspect = await harness.waitForRun(
      planner.run.id,
      (inspect) => inspect.run.status === "completed",
      30_000
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
      20_000
    );

    expect(completed.run.output).toEqual({ attempt: 2, token: "step-retry" });
    expect(completed.events.map((event) => event.type)).toContain("RetryScheduled");

    const step = completed.steps.find((entry) => entry.name === "retrying-step");
    expect(step?.attempts).toBe(2);
    expect(step?.status).toBe("completed");
    expect(step?.retryDecision).toBe("scheduled");
    expect(step?.retryable).toBe(true);
    expect(step?.willRetry).toBe(true);
    expect(step?.nextAttempt).toBe(2);
    expect(
      completed.waits.some((wait) => wait.kind === "retry_backoff" && wait.status === "completed")
    ).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("step retry families can exclude application failures", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/retryingStep", {
      token: "step-timeout-only",
      retries: 2,
      retryOn: ["timeout"],
    });

    const failed = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "failed" &&
        inspect.steps.some((step) => step.name === "retrying-step" && step.status === "failed"),
      20_000
    );

    const step = failed.steps.find((entry) => entry.name === "retrying-step");
    expect(step?.attempts).toBe(1);
    expect(step?.retryDecision).toBe("family_not_selected");
    expect(step?.retryFamily).toBe("application");
    expect(step?.retryable).toBe(false);
    expect(failed.events.map((event) => event.type)).not.toContain("RetryScheduled");
  } finally {
    await harness.dispose();
  }
});

test("timeout retry families can retry timed out steps", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/timeoutRetryingStep", {
      token: "timeout-family-step",
      retries: 1,
      retryOn: ["timeout"],
      timeout: "200ms",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "completed" &&
        inspect.steps.some((step) => step.name === "timeout-retrying-step" && step.status === "completed"),
      30_000
    );

    const step = completed.steps.find((entry) => entry.name === "timeout-retrying-step");
    expect(step?.attempts).toBe(2);
    expect(step?.retryDecision).toBe("scheduled");
    expect(step?.retryFamily).toBe("timeout");
    expect(completed.events.map((event) => event.type)).toContain("RetryScheduled");
  } finally {
    await harness.dispose();
  }
});

test("exponential step backoff increases across retries", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/retryingStep", {
      token: "step-exponential",
      retries: 2,
      failuresBeforeSuccess: 2,
      backoff: {
        kind: "exponential",
        initial: "50ms",
        factor: 2,
      },
    });

    const completed = await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed", 20_000);
    const retryEvents = completed.events.filter((event) => event.type === "RetryScheduled");

    expect(retryEvents).toHaveLength(2);
    expect((retryEvents[0]?.body as Record<string, unknown>).backoffKind).toBe("exponential");
    expect((retryEvents[0]?.body as Record<string, unknown>).backoffMs).toBe(50);
    expect((retryEvents[1]?.body as Record<string, unknown>).backoffMs).toBe(100);
  } finally {
    await harness.dispose();
  }
});

test("retry scheduling persists capped jittered backoff details", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/retryingStep", {
      token: "step-jitter",
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

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed",
      20_000
    );

    const retryEvents = completed.events.filter((event) => event.type === "RetryScheduled");
    expect(retryEvents).toHaveLength(3);

    const bodies = retryEvents.map((event) => event.body as Record<string, unknown>);
    expect(bodies.map((body) => body.backoffBaseMs)).toEqual([100, 200, 400]);
    expect(bodies.map((body) => body.backoffCappedMs)).toEqual([100, 150, 150]);
    expect(bodies.map((body) => body.backoffCapMs)).toEqual([150, 150, 150]);
    expect(bodies.every((body) => body.backoffJitterKind === "ratio")).toBe(true);
    expect(bodies.every((body) => body.backoffJitterRatio === 0.5)).toBe(true);

    for (const body of bodies) {
      const cappedMs = body.backoffCappedMs as number;
      const jitterMs = body.backoffJitterMs as number;
      const scheduledMs = body.backoffMs as number;

      expect(jitterMs).toBeGreaterThanOrEqual(0);
      expect(jitterMs).toBeLessThanOrEqual(Math.round(cappedMs * 0.5));
      expect(scheduledMs).toBe(cappedMs - jitterMs);
    }

    expect(completed.retrySeries).toHaveLength(1);
    const series = completed.retrySeries?.[0];
    expect(series?.operationKind).toBe("step");
    expect(series?.attempts).toHaveLength(3);
    expect(series?.attempts.map((attempt) => attempt.backoffCappedMs)).toEqual([100, 150, 150]);
    expect(series?.attempts.every((attempt) => attempt.backoffJitterKind === "ratio")).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("non-retryable step failures bypass configured retries", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/nonRetryingStep", {
      token: "step-no-retry",
    });

    const failed = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "failed" &&
        inspect.steps.some((step) => step.name === "non-retrying-step" && step.status === "failed"),
      20_000
    );

    const step = failed.steps.find((entry) => entry.name === "non-retrying-step");
    expect(step?.attempts).toBe(1);
    expect(
      step?.error && typeof step.error === "object"
        ? (step.error as Record<string, unknown>).retryable
        : null
    ).toBe(false);
    expect(step?.retryDecision).toBe("non_retryable");
    expect(step?.retryable).toBe(false);
    expect(step?.willRetry).toBe(false);
    expect(failed.events.map((event) => event.type)).not.toContain("RetryScheduled");

    const replay = await harness.replayRun(run.run.id);
    expect(replay.stdout).toContain("retry=non_retryable");
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
      20_000
    );

    expect(plannerInspect.run.output).toEqual({ summary: "planned: after-blocking-cancel" });

    const cancelledInspect = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "cancelled" &&
        inspect.steps.some((step) => step.name === "blocking-step" && step.status === "cancelled"),
      20_000
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

test("service turn blocking step timeout is enforced by the kernel and restarts the managed worker", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "service-blocking-timeout" };

  try {
    await harness.ensureService("demo/operator", keyInput);

    const askCommand = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/operator",
      "blockingStep",
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ durationMs: 5_000, timeout: "200ms" }),
      "--timeout",
      "20s",
      "--json",
    ]);

    await harness.waitForService(
      "demo/operator",
      keyInput,
      (inspect) =>
        inspect.run.status === "active" &&
        inspect.steps.some((step) => step.name === "blocking-service-step" && step.status === "running"),
      20_000
    );

    const askResult = await askCommand.wait();
    expect(askResult.exitCode).not.toBe(0);

    const failed = await harness.waitForService(
      "demo/operator",
      keyInput,
      (inspect) =>
        inspect.run.status === "idle" &&
        inspect.steps.some((step) => step.name === "blocking-service-step" && step.status === "failed"),
      20_000
    );

    const step = failed.steps.find((entry) => entry.name === "blocking-service-step");
    expect(step).toBeTruthy();
    expect(step?.retryDecision).toBe("retries_disabled");
    expect(step?.retryable).toBe(true);
    expect(step?.willRetry).toBe(false);
    expect(
      step?.error && typeof step.error === "object"
        ? (step.error as Record<string, unknown>).forcedTermination
        : null
    ).toBe(true);
    expect(failed.events.map((event) => event.type)).toContain("TurnFailed");

    const planner = await harness.startWorkflow("demo/planner", {
      topic: "after-service-blocking-timeout",
    });
    const plannerInspect = await harness.waitForRun(
      planner.run.id,
      (inspect) => inspect.run.status === "completed",
      20_000
    );

    expect(plannerInspect.run.output).toEqual({ summary: "planned: after-service-blocking-timeout" });
  } finally {
    await harness.dispose();
  }
});

test("unmanaged workers fall back to durable failure when a service turn blocks past its timeout", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_MANAGED_WORKERS: "0",
      VILANO_LEASE_DURATION_SECONDS: "2",
    },
  });
  const keyInput = { sessionId: "service-blocking-unmanaged" };

  try {
    await harness.ensureService("demo/operator", keyInput);

    const askCommand = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/operator",
      "blockingStep",
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ durationMs: 5_000, timeout: "200ms" }),
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

    const firstWorker = await harness.spawnWorker({
      workerId: "service-blocking-unmanaged-worker",
      once: true,
    });

    await harness.waitForService(
      "demo/operator",
      keyInput,
      (inspect) =>
        inspect.run.status === "active" &&
        inspect.steps.some((step) => step.name === "blocking-service-step" && step.status === "running"),
      20_000
    );

    const askResult = await askCommand.wait();
    expect(askResult.exitCode).not.toBe(0);

    const failed = await harness.waitForService(
      "demo/operator",
      keyInput,
      (inspect) =>
        inspect.run.status === "idle" &&
        inspect.steps.some((step) => step.name === "blocking-service-step" && step.status === "failed"),
      20_000
    );

    const step = failed.steps.find((entry) => entry.name === "blocking-service-step");
    expect(step).toBeTruthy();
    expect(
      step?.error && typeof step.error === "object"
        ? (step.error as Record<string, unknown>).forcedTermination
        : null
    ).toBe(true);
    expect(failed.events.map((event) => event.type)).toContain("TurnFailed");

    const planner = await harness.startWorkflow("demo/planner", {
      topic: "after-unmanaged-service-timeout",
    });
    const secondWorker = await harness.spawnWorker({
      workerId: "post-unmanaged-timeout-worker",
      once: true,
    });

    const [plannerWorkerResult, plannerInspect, stuckWorkerResult] = await Promise.all([
      secondWorker.wait(),
      harness.waitForRun(planner.run.id, (inspect) => inspect.run.status === "completed", 20_000),
      firstWorker.wait(),
    ]);

    expect(plannerWorkerResult.exitCode).toBe(0);
    expect(stuckWorkerResult.exitCode).toBe(0);
    expect(plannerInspect.run.output).toEqual({ summary: "planned: after-unmanaged-service-timeout" });
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
      20_000
    );

    expect(inspect.events.map((event) => event.type)).toContain("RetryScheduled");
    expect((inspect.turns ?? []).map((turn) => turn.attempts)).toContain(2);
    expect((inspect.turns ?? []).some((turn) => turn.retryDecision === "scheduled")).toBe(true);
    expect(
      inspect.waits.some((wait) => wait.kind === "retry_backoff" && wait.status === "completed")
    ).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("services process mixed ask and send backlogs in FIFO order", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "mailbox-fifo" };

  try {
    await harness.ensureService("demo/mailboxProbe", keyInput);

    const firstAsk = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/mailboxProbe",
      "delay",
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ id: "first", delayMs: 400 }),
      "--timeout",
      "60s",
      "--json",
    ]);

    await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (inspect) =>
        inspect.run.status === "active" &&
        inspect.envelopes.some((envelope) => envelope.name === "delay" && envelope.status === "processing"),
      30_000
    );

    await harness.sendService("demo/mailboxProbe", "record", keyInput, { id: "second" });

    const historyAsk = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/mailboxProbe",
      "history",
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({}),
      "--timeout",
      "60s",
      "--json",
    ]);

    const queued = await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (inspect) =>
        inspect.envelopes.length >= 3 &&
        inspect.envelopes.some((envelope) => envelope.name === "delay" && envelope.status === "processing") &&
        inspect.envelopes.filter((envelope) => envelope.status === "queued").length >= 2,
      30_000
    );

    expect(queued.envelopes.slice(0, 3).map((envelope) => envelope.name)).toEqual([
      "delay",
      "record",
      "history",
    ]);

    const [firstAskResult, historyAskResult] = await Promise.all([firstAsk.wait(), historyAsk.wait()]);
    if (firstAskResult.exitCode !== 0) {
      throw new Error(
        [
          "first queued ask failed",
          firstAskResult.stdout ? `stdout:\n${firstAskResult.stdout}` : "",
          firstAskResult.stderr ? `stderr:\n${firstAskResult.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    if (historyAskResult.exitCode !== 0) {
      throw new Error(
        [
          "history ask failed",
          historyAskResult.stdout ? `stdout:\n${historyAskResult.stdout}` : "",
          historyAskResult.stderr ? `stderr:\n${historyAskResult.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    expect(firstAskResult.exitCode).toBe(0);
    expect(historyAskResult.exitCode).toBe(0);

    const firstReply = JSON.parse(firstAskResult.stdout) as {
      ok: true;
      reply: { id: string; history: string[] };
    };
    const historyReply = JSON.parse(historyAskResult.stdout) as {
      ok: true;
      reply: { history: string[] };
    };

    expect(firstReply.reply.history).toEqual(["ask:first"]);
    expect(historyReply.reply.history).toEqual(["ask:first", "send:second"]);

    const completed = await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (inspect) =>
        inspect.envelopes.slice(0, 3).every((envelope) => envelope.status === "completed") &&
        inspect.run.state !== null &&
        typeof inspect.run.state === "object" &&
        Array.isArray((inspect.run.state as { history?: unknown[] }).history) &&
        ((inspect.run.state as { history: unknown[] }).history.join("|") === "ask:first|send:second"),
      30_000
    );

    expect(completed.run.state).toEqual({
      sessionId: "mailbox-fifo",
      history: ["ask:first", "send:second"],
    });
    expect(completed.envelopes.slice(0, 3).map((envelope) => envelope.name)).toEqual([
      "delay",
      "record",
      "history",
    ]);
  } finally {
    await harness.dispose();
  }
});

test("service stop fails queued backlog behind an active turn", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "mailbox-stop" };

  try {
    await harness.ensureService("demo/mailboxProbe", keyInput);

    const firstAsk = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/mailboxProbe",
      "delay",
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ id: "first", delayMs: 2500 }),
      "--timeout",
      "60s",
      "--json",
    ]);

    await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (inspect) =>
        inspect.run.status === "active" &&
        inspect.envelopes.some((envelope) => envelope.name === "delay" && envelope.status === "processing"),
      30_000
    );

    await harness.sendService("demo/mailboxProbe", "record", keyInput, { id: "second" });

    const historyAsk = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/mailboxProbe",
      "history",
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({}),
      "--timeout",
      "60s",
      "--json",
    ]);

    await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (inspect) =>
        inspect.envelopes.length >= 3 &&
        inspect.envelopes.some((envelope) => envelope.name === "delay" && envelope.status === "processing") &&
        inspect.envelopes.filter((envelope) => envelope.status === "queued").length >= 2,
      30_000
    );

    const stopped = await harness.stopService("demo/mailboxProbe", keyInput);
    expect(stopped.run.status).toBe("stopped");
    expect(stopped.hadInFlightTurn).toBe(true);
    expect(stopped.stoppedEnvelopeCount).toBe(3);

    const [firstAskResult, historyAskResult] = await Promise.all([firstAsk.wait(), historyAsk.wait()]);
    expect(firstAskResult.exitCode).not.toBe(0);
    expect(historyAskResult.exitCode).not.toBe(0);

    const stoppedInspect = await harness.inspectService("demo/mailboxProbe", keyInput);
    expect(stoppedInspect.run.status).toBe("stopped");
    expect(stoppedInspect.run.state).toBeNull();
    expect(stoppedInspect.envelopes.slice(0, 3).map((envelope) => envelope.status)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(stoppedInspect.envelopes.slice(0, 3).map((envelope) => envelope.name)).toEqual([
      "delay",
      "record",
      "history",
    ]);
  } finally {
    await harness.dispose();
  }
});

test("non-retryable service turn failures bypass configured retries", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "service-no-retry" };

  try {
    const askCommand = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/nonRetryingResponder",
      "unstable",
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ token: "service-no-retry" }),
      "--timeout",
      "20s",
      "--json",
    ]);

    const askResult = await askCommand.wait();
    expect(askResult.exitCode).not.toBe(0);

    const inspect = await harness.waitForService(
      "demo/nonRetryingResponder",
      keyInput,
      (body) =>
        body.run.status === "idle" &&
        (body.turns ?? []).some((turn) => turn.phase === "failed"),
      20_000
    );

    const failedTurn = (inspect.turns ?? []).find((turn) => turn.phase === "failed");
    expect(failedTurn?.attempts).toBe(1);
    expect(failedTurn?.retryDecision).toBe("non_retryable");
    expect(failedTurn?.retryable).toBe(false);
    expect(failedTurn?.willRetry).toBe(false);
    expect(inspect.events.map((event) => event.type)).not.toContain("RetryScheduled");
  } finally {
    await harness.dispose();
  }
});

test("service retry families can exclude application failures", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "service-timeout-only" };

  try {
    const askCommand = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/timeoutOnlyResponder",
      "unstable",
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ token: "service-timeout-only" }),
      "--timeout",
      "20s",
      "--json",
    ]);

    const askResult = await askCommand.wait();
    expect(askResult.exitCode).not.toBe(0);

    const inspect = await harness.waitForService(
      "demo/timeoutOnlyResponder",
      keyInput,
      (body) =>
        body.run.status === "idle" &&
        (body.turns ?? []).some((turn) => turn.phase === "failed"),
      20_000
    );

    const failedTurn = (inspect.turns ?? []).find((turn) => turn.phase === "failed");
    expect(failedTurn?.attempts).toBe(1);
    expect(failedTurn?.retryDecision).toBe("family_not_selected");
    expect(failedTurn?.retryFamily).toBe("application");
    expect(failedTurn?.retryable).toBe(false);
    expect(inspect.events.map((event) => event.type)).not.toContain("RetryScheduled");
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

test("sleep waits survive daemon restart and resume afterward", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/sleeper", { duration: "500ms" });

    await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.waits.some((wait) => wait.kind === "sleep" && wait.status === "waiting")
    );

    await harness.restartDaemon();

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed",
      20_000
    );

    expect(completed.run.output).toEqual({ woke: true });
    expect(completed.events.map((event) => event.type)).toContain("TimerFired");
  } finally {
    await harness.dispose();
  }
});

test("signal waits survive daemon restart and resume after a later signal", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/gate", {});

    await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.waits.some((wait) => wait.kind === "signal" && wait.status === "waiting")
    );

    await harness.restartDaemon();
    await harness.sendSignal(run.run.id, "approved", { source: "after-restart" });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed",
      20_000
    );

    expect(completed.run.output).toEqual({ approval: { source: "after-restart" } });
    expect(completed.events.map((event) => event.type)).toContain("WaitSatisfied");
  } finally {
    await harness.dispose();
  }
});

test("service state survives daemon restart", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { repoId: "restart-state" };

  try {
    await harness.ensureService("demo/reviewer", keyInput);
    await harness.sendService("demo/reviewer", "hint", keyInput, {
      note: "persist this note",
    });

    await harness.waitForService(
      "demo/reviewer",
      keyInput,
      (inspect) =>
        inspect.run.status === "idle" &&
        inspect.run.state !== null &&
        typeof inspect.run.state === "object" &&
        Array.isArray((inspect.run.state as { notes?: unknown[] }).notes) &&
        ((inspect.run.state as { notes: unknown[] }).notes.length === 1),
      20_000
    );

    await harness.restartDaemon();

    const inspect = await harness.inspectService("demo/reviewer", keyInput);
    expect(inspect.run.state).toEqual({
      repoId: "restart-state",
      notes: ["persist this note"],
    });

    const reply = await harness.askService("demo/reviewer", "status", keyInput, {});
    expect(reply).toEqual({ ready: true, notes: 1 });
  } finally {
    await harness.dispose();
  }
});

test("retry waits survive repeated daemon restarts with richer retry policies", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/retryingStep", {
      token: "restart-retry-policy",
      retries: 2,
      failuresBeforeSuccess: 2,
      backoff: {
        kind: "exponential",
        initial: "400ms",
        factor: 2,
        max: "800ms",
        jitter: "half",
      },
    });

    await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.waits.some((wait) => wait.kind === "retry_backoff" && wait.status === "waiting") &&
        inspect.events.filter((event) => event.type === "RetryScheduled").length >= 1,
      30_000
    );

    await harness.restartDaemon();

    await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.waits.some((wait) => wait.kind === "retry_backoff" && wait.status === "waiting") &&
        inspect.events.filter((event) => event.type === "RetryScheduled").length >= 2,
      30_000
    );

    await harness.restartDaemon();

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed",
      40_000
    );

    const step = completed.steps.find((entry) => entry.name === "retrying-step");
    expect(step?.attempts).toBe(3);
    expect(completed.retrySeries).toHaveLength(1);
    expect(completed.retrySeries?.[0]?.attempts).toHaveLength(2);
    expect(completed.retrySeries?.[0]?.attempts.every((attempt) => attempt.backoffJitterKind === "half")).toBe(true);
    expect(completed.events.filter((event) => event.type === "RetryScheduled")).toHaveLength(2);
  } finally {
    await harness.dispose();
  }
});

test("service backlogs survive repeated daemon restarts and lease recovery", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_LEASE_DURATION_SECONDS: "2",
    },
  });
  const keyInput = { sessionId: "mailbox-restart-soak" };

  try {
    await harness.ensureService("demo/mailboxProbe", keyInput);

    const firstAsk = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/mailboxProbe",
      "delay",
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ id: "first", delayMs: 1500 }),
      "--timeout",
      "60s",
      "--json",
    ]);

    await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (inspect) =>
        inspect.run.status === "active" &&
        inspect.envelopes.some((envelope) => envelope.name === "delay" && envelope.status === "processing"),
      30_000
    );

    await harness.sendService("demo/mailboxProbe", "record", keyInput, { id: "second" });

    const historyAsk = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/mailboxProbe",
      "history",
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({}),
      "--timeout",
      "60s",
      "--json",
    ]);

    await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (inspect) =>
        inspect.envelopes.length >= 3 &&
        inspect.envelopes.some((envelope) => envelope.name === "delay" && envelope.status === "processing") &&
        inspect.envelopes.filter((envelope) => envelope.status === "queued").length >= 2,
      30_000
    );

    await harness.restartDaemon();

    await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (inspect) =>
        (inspect.turns ?? []).some(
          (turn) => turn.name === "delay" && turn.phase === "running" && turn.attempts >= 2
        ),
      30_000
    );

    await harness.restartDaemon();

    const [firstAskResult, historyAskResult] = await Promise.all([firstAsk.wait(), historyAsk.wait()]);
    if (firstAskResult.exitCode !== 0) {
      throw new Error(
        [
          "restart backlog first ask failed",
          firstAskResult.stdout ? `stdout:\n${firstAskResult.stdout}` : "",
          firstAskResult.stderr ? `stderr:\n${firstAskResult.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    if (historyAskResult.exitCode !== 0) {
      throw new Error(
        [
          "restart backlog history ask failed",
          historyAskResult.stdout ? `stdout:\n${historyAskResult.stdout}` : "",
          historyAskResult.stderr ? `stderr:\n${historyAskResult.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    expect(firstAskResult.exitCode).toBe(0);
    expect(historyAskResult.exitCode).toBe(0);

    const firstReply = JSON.parse(firstAskResult.stdout) as {
      ok: true;
      reply: { id: string; history: string[] };
    };
    const historyReply = JSON.parse(historyAskResult.stdout) as {
      ok: true;
      reply: { history: string[] };
    };

    expect(firstReply.reply.history).toEqual(["ask:first"]);
    expect(historyReply.reply.history).toEqual(["ask:first", "send:second"]);

    const completed = await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (inspect) =>
        inspect.envelopes.slice(0, 3).every((envelope) => envelope.status === "completed") &&
        inspect.run.state !== null &&
        typeof inspect.run.state === "object" &&
        Array.isArray((inspect.run.state as { history?: unknown[] }).history) &&
        ((inspect.run.state as { history: unknown[] }).history.join("|") === "ask:first|send:second"),
      40_000
    );

    const delayTurn = (completed.turns ?? []).find((turn) => turn.name === "delay");
    expect(delayTurn?.attempts).toBeGreaterThanOrEqual(2);
    expect((completed.turns ?? []).map((turn) => turn.lastResumeReason)).toContain("lease_expired");
    expect(completed.envelopes.slice(0, 3).map((envelope) => envelope.name)).toEqual([
      "delay",
      "record",
      "history",
    ]);
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
      "--key-json",
      JSON.stringify(keyInput),
      "--timeout",
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
