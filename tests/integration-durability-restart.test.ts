import { expect, test } from "bun:test";
import { RuntimeHarness } from "./runtime-harness.ts";

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

test(
  "sleep waits survive daemon restart and resume afterward",
  async () => {
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
        30_000
      );

      expect(completed.run.output).toEqual({ woke: true });
      expect(completed.events.map((event) => event.type)).toContain("TimerFired");
    } finally {
      await harness.dispose();
    }
  },
  { timeout: 60_000 }
);

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

test(
  "retry waits survive repeated daemon restarts with richer retry policies",
  async () => {
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
  },
  { timeout: 60_000 }
);

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
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ id: "first", delayMs: 1500 }),
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
