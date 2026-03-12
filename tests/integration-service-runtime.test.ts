import { expect, test } from "bun:test";
import { RuntimeHarness, sleep } from "./runtime-harness.ts";

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
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ durationMs: 2500 }),
      "--wait-timeout",
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
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ durationMs: 5_000, timeout: "200ms" }),
      "--wait-timeout",
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
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ durationMs: 5_000, timeout: "200ms" }),
      "--wait-timeout",
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
    expect(stuckWorkerResult.exitCode).not.toBeNull();
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
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ id: "first", delayMs: 400 }),
      "--wait-timeout",
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
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({}),
      "--wait-timeout",
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

    expect(completed.run.state).toMatchObject({
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
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ id: "first", delayMs: 2500 }),
      "--wait-timeout",
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
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({}),
      "--wait-timeout",
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

test("service turns isolate implicit durable ops across envelopes", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const keyInput = { sessionId: "turn-isolation" };
    await harness.ensureService("demo/serviceTurnIsolationProbe", keyInput);

    const first = (await harness.askService(
      "demo/serviceTurnIsolationProbe",
      "sequence",
      keyInput,
      { token: "same-token" }
    )) as { attempts: number[] };

    const second = (await harness.askService(
      "demo/serviceTurnIsolationProbe",
      "sequence",
      keyInput,
      { token: "same-token" }
    )) as { attempts: number[] };

    expect(first).toEqual({ attempts: [1, 2] });
    expect(second).toEqual({ attempts: [3, 4] });
  } finally {
    await harness.dispose();
  }
});

test("queued envelopes do not re-lease waiting service turns", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "service-waiting-queue" };

  try {
    await harness.ensureService("demo/operator", keyInput);

    const waitingAsk = harness.spawnCliCommand([
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
        inspect.envelopes.some((envelope) => envelope.name === "awaitApproval" && envelope.status === "processing"),
      20_000
    );

    const queuedAsk = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/operator",
      "pipeline",
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ topic: "queued-while-waiting" }),
      "--wait-timeout",
      "20s",
      "--json",
    ]);

    const queued = await harness.waitForService(
      "demo/operator",
      keyInput,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.envelopes.some((envelope) => envelope.name === "awaitApproval" && envelope.status === "processing") &&
        inspect.envelopes.some((envelope) => envelope.name === "pipeline" && envelope.status === "queued"),
      20_000
    );

    expect((queued.turns ?? []).some((turn) => turn.phase === "waiting")).toBe(true);

    await harness.sendSignal(waiting.run.id, "approved", { source: "queued-envelope-test" });

    expect((await waitingAsk.wait()).exitCode).toBe(0);
    expect((await queuedAsk.wait()).exitCode).toBe(0);
  } finally {
    await harness.dispose();
  }
});

test("in-run service asks honor timeout options durably", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/askTimeoutCoordinator", { sessionId: "ask-timeout" });
    const failed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "failed"
    );

    expect(failed.run.error).toMatchObject({
      message: "Service ask timed out",
      cause: {
        reason: "ask_timeout",
      },
    });
    expect(failed.events.map((event) => event.type)).toContain("AskTimedOut");
    expect(failed.waits.some((wait) => wait.kind === "ask_reply" && wait.status === "failed")).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("service refs treat option-shaped objects as payloads", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/servicePayloadShapeCoordinator", {
      sessionId: "shape-session",
    });
    const completed = await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed");

    expect(completed.run.output).toEqual({
      key: "payload-key",
      timeout: "payload-timeout",
    });
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
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ token: "service-no-retry" }),
      "--wait-timeout",
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
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ token: "service-timeout-only" }),
      "--wait-timeout",
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
