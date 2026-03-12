import { expect, test } from "bun:test";
import { RuntimeHarness, sleep } from "./runtime-harness.ts";

test("expired leases cannot commit stale workflow completions", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_MANAGED_WORKERS: "0",
      VILANO_LEASE_DURATION_SECONDS: "1",
    },
  });

  try {
    const run = await harness.startWorkflow("demo/planner", { topic: "lease-fence" });

    const leaseResponse = await harness.requestKernel("/v1/activations/lease", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workerId: "manual-lease-worker",
      }),
    });

    expect(leaseResponse.status).toBe(200);
    const leased = (await leaseResponse.json()) as {
      ok: true;
      activation: { leaseId: string } | null;
    };

    expect(leased.activation?.leaseId).toBeTruthy();
    const leaseId = leased.activation?.leaseId as string;

    await sleep(1_500);

    const staleComplete = await harness.requestKernel(`/v1/leases/${encodeURIComponent(leaseId)}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        result: { summary: "stale-completion" },
      }),
    });

    expect(staleComplete.status).toBe(404);

    const worker = await harness.spawnWorker({ once: true, workerId: "fresh-worker" });
    const workerResult = await worker.wait();
    expect(workerResult.exitCode).toBe(0);

    const inspect = await harness.waitForRun(
      run.run.id,
      (body) => body.run.status === "completed"
    );

    expect(inspect.run.output).toEqual({ summary: "planned: lease-fence" });
  } finally {
    await harness.dispose();
  }
});

test("implicit durable keys do not collapse repeated steps execs or child spawns", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/implicitKeyProbe", { token: "alpha" });

    const inspect = await harness.waitForRun(
      run.run.id,
      (body) => body.run.status === "completed"
    );

    expect(inspect.run.output).toEqual({
      stepAttempts: [1, 2],
      execAttempts: [1, 2],
      childRunIds: expect.any(Array),
      childValues: [1, 2],
    });

    const output = inspect.run.output as {
      stepAttempts: number[];
      execAttempts: number[];
      childRunIds: string[];
      childValues: number[];
    };

    expect(output.childRunIds).toHaveLength(2);
    expect(output.childRunIds[0]).not.toBe(output.childRunIds[1]);

    expect(
      inspect.steps
        .filter((step) => step.name === "repeat-step")
        .map((step) => step.status)
    ).toEqual(["completed", "completed"]);

    expect(
      inspect.execs
        .filter((exec) => exec.name === "repeat-exec")
        .map((exec) => exec.status)
    ).toEqual(["completed", "completed"]);

    expect(inspect.children.map((child) => child.childRunId)).toHaveLength(2);
    expect(new Set(inspect.children.map((child) => child.childRunId)).size).toBe(2);
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
