import { expect, test } from "bun:test";
import { RuntimeHarness } from "./runtime-harness.ts";

test("service asks from different caller runs do not collide on reply correlation", async () => {
  const harness = await RuntimeHarness.create();
  const sessionId = "shared-mailbox";

  try {
    const [firstRun, secondRun] = await Promise.all([
      harness.startWorkflow("demo/mailboxAskWorkflow", {
        sessionId,
        id: "first",
        delayMs: 200,
      }),
      harness.startWorkflow("demo/mailboxAskWorkflow", {
        sessionId,
        id: "second",
        delayMs: 200,
      }),
    ]);

    const [firstInspect, secondInspect] = await Promise.all([
      harness.waitForRun(
        firstRun.run.id,
        (body) => body.run.status === "completed",
        20_000
      ),
      harness.waitForRun(
        secondRun.run.id,
        (body) => body.run.status === "completed",
        20_000
      ),
    ]);

    expect(firstInspect.run.output).toMatchObject({
      id: "first",
    });
    expect(secondInspect.run.output).toMatchObject({
      id: "second",
    });

    const firstHistory = (firstInspect.run.output as { history: string[] }).history;
    const secondHistory = (secondInspect.run.output as { history: string[] }).history;
    expect(firstHistory).toContain("ask:first");
    expect(secondHistory).toContain("ask:second");

    const serviceInspect = await harness.waitForService(
      "demo/mailboxProbe",
      { sessionId },
      (body) => body.run.status === "idle" && body.envelopes.length >= 2
    );

    expect(serviceInspect.envelopes.filter((envelope) => envelope.kind === "ask")).toHaveLength(2);
    expect(serviceInspect.envelopes.every((envelope) => envelope.status === "completed")).toBeTrue();
  } finally {
    await harness.dispose();
  }
});

test("service handler stop drains queued backlog behind the completing turn", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "stop-backlog" };

  try {
    const stopCommand = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/mailboxProbe",
      "stopAfterDelay",
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--input",
      JSON.stringify({ delayMs: 300 }),
      "--json",
    ]);

    await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (body) =>
        body.envelopes.some((envelope) => envelope.name === "stopAfterDelay" && envelope.status === "processing")
    );

    const queuedCommand = harness.spawnCliCommand([
      "service",
      "ask",
      "demo/mailboxProbe",
      "history",
      "--service-key",
      keyInput.sessionId,
      "--key-json",
      JSON.stringify(keyInput),
      "--json",
    ]);

    await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (body) => body.envelopes.length >= 2
    );

    const [stopResult, queuedResult] = await Promise.all([stopCommand.wait(), queuedCommand.wait()]);
    expect(stopResult.exitCode).toBe(0);
    expect(JSON.parse(stopResult.stdout)).toMatchObject({
      ok: true,
      reply: { stopped: true },
    });

    expect(queuedResult.exitCode).toBe(1);
    expect(`${queuedResult.stdout}\n${queuedResult.stderr}`).toContain("Service stopped");

    const serviceInspect = await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (body) =>
        body.run.status === "stopped" &&
        body.envelopes.some((envelope) => envelope.name === "history" && envelope.status === "failed")
    );

    expect(serviceInspect.events.map((event) => event.type)).toContain("ServiceStopped");
  } finally {
    await harness.dispose();
  }
});

test("service turns can inspect mailbox backlog state", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/mailboxSnapshotWorkflow", {
      sessionId: "mailbox-snapshot",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );

    expect(completed.run.output).toMatchObject({
      current: {
        kind: "send",
        name: "recordMailbox",
      },
      queued: {
        total: 2,
        ready: 2,
        deferred: 0,
        asks: 1,
        sends: 1,
        signals: 0,
      },
    });
  } finally {
    await harness.dispose();
  }
});

test("service turns can defer an envelope and let later mail run first", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "mailbox-defer" };

  try {
    const run = await harness.startWorkflow("demo/mailboxDeferWorkflow", {
      sessionId: keyInput.sessionId,
      delay: "200ms",
      followupDelay: "50ms",
      followupValue: "after-defer",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed",
      20_000
    );

    expect(completed.run.output).toMatchObject({
      attempt: 2,
      log: ["after-defer"],
      mailbox: {
        current: {
          kind: "ask",
          name: "deferOnce",
        },
      },
    });

    const serviceInspect = await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (body) =>
        body.run.status === "idle" &&
        body.envelopes.some((envelope) => envelope.name === "deferOnce" && envelope.status === "completed")
    );

    const deferredEnvelope = serviceInspect.envelopes.find((envelope) => envelope.name === "deferOnce");
    expect(deferredEnvelope?.attempt).toBe(2);
    expect(
      serviceInspect.envelopes.some(
        (envelope) => envelope.name === "appendLog" && envelope.status === "completed"
      )
    ).toBeTrue();
    expect(serviceInspect.events.map((event) => event.type)).toContain("TurnDeferred");
  } finally {
    await harness.dispose();
  }
});

test("service turns can reject an envelope without retry", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "mailbox-reject" };

  try {
    const run = await harness.startWorkflow("demo/mailboxRejectWorkflow", {
      sessionId: keyInput.sessionId,
      message: "mailbox rejected this turn",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );

    expect(completed.run.output).toMatchObject({
      rejected: true,
      message: "mailbox rejected this turn",
      reason: "mailbox_rejected",
    });

    const serviceInspect = await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (body) =>
        body.run.status === "idle" &&
        body.envelopes.some((envelope) => envelope.name === "rejectTurn" && envelope.status === "failed")
    );

    expect(serviceInspect.events.map((event) => event.type)).toContain("TurnRejected");
  } finally {
    await harness.dispose();
  }
});

test("bounded service mailboxes reject new work when queued backlog is full", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_MANAGED_WORKERS: "2",
    },
  });
  const keyInput = { sessionId: "bounded-mailbox-overflow" };

  try {
    const blocker = await harness.startWorkflow("demo/boundedMailboxDelayWorkflow", {
      sessionId: keyInput.sessionId,
      id: "processing",
      delayMs: 400,
    });

    await harness.waitForService(
      "demo/boundedMailboxProbe",
      keyInput,
      (body) =>
        body.run.status === "active" &&
        body.envelopes.some((envelope) => envelope.name === "delay" && envelope.status === "processing")
    );

    await harness.sendService("demo/boundedMailboxProbe", "record", keyInput, { id: "queued" });

    await harness.waitForService(
      "demo/boundedMailboxProbe",
      keyInput,
      (body) => body.envelopes.some((envelope) => envelope.name === "record" && envelope.status === "queued")
    );

    const overflow = await harness.startWorkflow("demo/boundedMailboxOverflowWorkflow", {
      sessionId: keyInput.sessionId,
    });

    const overflowCompleted = await harness.waitForRun(
      overflow.run.id,
      (inspect) => inspect.run.status === "completed"
    );

    expect(overflowCompleted.run.output).toMatchObject({
      overloaded: true,
      reason: "service_overloaded",
    });

    let cliError: Error | null = null;
    try {
      await harness.sendService("demo/boundedMailboxProbe", "record", keyInput, { id: "overflow" });
    } catch (error) {
      cliError = error as Error;
    }

    expect(cliError).toBeTruthy();
    expect(cliError?.message ?? "").toContain("Service mailbox overloaded");

    await harness.waitForRun(
      blocker.run.id,
      (inspect) => inspect.run.status === "completed"
    );

    const serviceInspect = await harness.waitForService(
      "demo/boundedMailboxProbe",
      keyInput,
      (body) =>
        body.run.status === "idle" &&
        body.envelopes.some((envelope) => envelope.name === "record" && envelope.status === "completed")
    );

    expect(serviceInspect.events.map((event) => event.type)).toContain("InboundRejected");
  } finally {
    await harness.dispose();
  }
});

test("idle services report explicit passivation and wake-on-mailbox semantics", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "passivation-idle" };

  try {
    await harness.ensureService("demo/mailboxProbe", keyInput);

    const inspect = await harness.waitForService(
      "demo/mailboxProbe",
      keyInput,
      (body) => body.run.status === "idle"
    );

    expect(inspect.run.passivation).toMatchObject({
      state: "passivated",
      wakeReason: "message",
    });
  } finally {
    await harness.dispose();
  }
});

test("waiting services report explicit passivation wake reasons", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "passivation-waiting" };

  try {
    const run = await harness.startWorkflow("demo/approvalCoordinator", {
      sessionId: keyInput.sessionId,
    });

    const waiting = await harness.waitForService(
      "demo/operator",
      keyInput,
      (body) =>
        body.run.status === "waiting" &&
        body.waits.some((wait) => wait.kind === "signal" && wait.status === "waiting")
    );

    expect(waiting.run.passivation).toMatchObject({
      state: "waiting",
      wakeReason: "signal",
    });

    await harness.sendSignal(waiting.run.id, "approved", {
      source: "passivation-test",
    });

    await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );
  } finally {
    await harness.dispose();
  }
});

test("topic publishes fan out into subscribed service signals", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/pubsubDeliveryCoordinator", {
      sessionId: "pubsub-delivery",
      topic: "repo.updated",
      value: "alpha",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );
    const output = completed.run.output as
      | {
          publish?: { topic?: string; matched?: number; enqueued?: number; rejected?: number };
          events?: {
            subscriptions?: Array<{ topic?: string; signal?: string }>;
            events?: Array<{ topic?: string; value?: string | null; signal?: string }>;
          };
        }
      | undefined;

    expect(output?.publish).toMatchObject({
      topic: "repo.updated",
      matched: 1,
      enqueued: 1,
      rejected: 0,
    });
    expect(output?.events?.subscriptions).toEqual([
      {
        topic: "repo.updated",
        signal: "topicEvent",
      },
    ]);
    expect(output?.events?.events).toHaveLength(1);
    expect(output?.events?.events?.[0]).toMatchObject({
      topic: "repo.updated",
      value: "alpha",
      signal: "topicEvent",
    });
  } finally {
    await harness.dispose();
  }
});

test("topic publishes are deduped by caller op key", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/pubsubDedupeCoordinator", {
      sessionId: "pubsub-dedupe",
      topic: "repo.deduped",
      value: "once",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );
    const output = completed.run.output as
      | {
          first?: { publishId?: string; matched?: number; enqueued?: number; rejected?: number };
          second?: { publishId?: string; matched?: number; enqueued?: number; rejected?: number };
          events?: { events?: Array<{ topic?: string; value?: string | null }> };
        }
      | undefined;

    expect(output?.first?.publishId).toBeTruthy();
    expect(output?.second?.publishId).toBe(output?.first?.publishId);
    expect(output?.first).toMatchObject({
      matched: 1,
      enqueued: 1,
      rejected: 0,
    });
    expect(output?.second).toMatchObject({
      matched: 1,
      enqueued: 1,
      rejected: 0,
    });
    expect(output?.events?.events).toHaveLength(1);
    expect(output?.events?.events?.[0]).toMatchObject({
      topic: "repo.deduped",
      value: "once",
    });
  } finally {
    await harness.dispose();
  }
});

test("services can unsubscribe from topics and stop receiving published events", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/pubsubUnsubscribeCoordinator", {
      sessionId: "pubsub-unsubscribe",
      topic: "repo.unsubscribed",
      value: "ignored",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );
    const output = completed.run.output as
      | {
          publish?: { matched?: number; enqueued?: number; rejected?: number };
          events?: {
            subscriptions?: Array<unknown>;
            events?: Array<unknown>;
          };
        }
      | undefined;

    expect(output?.publish).toMatchObject({
      matched: 0,
      enqueued: 0,
      rejected: 0,
    });
    expect(output?.events?.subscriptions).toEqual([]);
    expect(output?.events?.events).toEqual([]);
  } finally {
    await harness.dispose();
  }
});

test("services reject pubsub subscriptions for unknown signal handlers", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/pubsubInvalidSubscriptionCoordinator", {
      sessionId: "pubsub-invalid-subscription",
      topic: "repo.invalid",
      signal: "missingSignal",
    });

    const failed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "failed"
    );
    const error = failed.run.error as { message?: string } | null;

    expect(error?.message).toContain("unknown signal 'missingSignal'");
  } finally {
    await harness.dispose();
  }
});

test("topic subscriptions survive daemon restart and still receive future publishes", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "pubsub-restart" };

  try {
    await harness.askService("demo/pubsubProbe", "subscribeTopic", keyInput, {
      topic: "repo.restarted",
      signal: "topicEvent",
    });

    await harness.restartDaemon();

    const run = await harness.startWorkflow("demo/topicPublisher", {
      topic: "repo.restarted",
      value: "after-restart",
    });

    await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );

    const events = (await harness.askService(
      "demo/pubsubProbe",
      "events",
      keyInput,
      {}
    )) as {
      subscriptions?: Array<{ topic?: string; signal?: string }>;
      events?: Array<{ topic?: string; value?: string | null; signal?: string }>;
    };

    expect(events.subscriptions).toEqual([
      {
        topic: "repo.restarted",
        signal: "topicEvent",
      },
    ]);
    expect(events.events).toHaveLength(1);
    expect(events.events?.[0]).toMatchObject({
      topic: "repo.restarted",
      value: "after-restart",
      signal: "topicEvent",
    });
  } finally {
    await harness.dispose();
  }
});
