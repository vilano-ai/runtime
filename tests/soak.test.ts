import { expect, test } from "bun:test";

import { RuntimeHarness, sleep } from "./runtime-harness.ts";

test("mixed workflow and service traffic survives repeated restarts and worker churn", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_LEASE_DURATION_SECONDS: "2",
    },
  });
  const mailboxKey = { sessionId: "mailbox-soak-churn" };
  const cycleCount = 6;
  const retryRunIds: string[] = [];
  const reviewRunIds: string[] = [];
  const servicePipelineRunIds: string[] = [];
  const blockingRunIds: string[] = [];
  const askCommands: Array<{
    id: string;
    command: ReturnType<RuntimeHarness["spawnCliCommand"]>;
  }> = [];
  const expectedHistory: string[] = [];

  try {
    await harness.ensureService("demo/mailboxProbe", mailboxKey);

    for (let cycle = 0; cycle < cycleCount; cycle += 1) {
      const askId = `ask-${cycle}`;
      const sendId = `send-${cycle}`;

      const askCommand = harness.spawnCliCommand([
        "service",
        "ask",
        "demo/mailboxProbe",
        "delay",
        "--key-json",
        JSON.stringify(mailboxKey),
        "--input",
        JSON.stringify({ id: askId, delayMs: 250 }),
        "--timeout",
        "120s",
        "--json",
      ]);
      askCommands.push({ id: askId, command: askCommand });
      expectedHistory.push(`ask:${askId}`);

      await harness.waitForService(
        "demo/mailboxProbe",
        mailboxKey,
        (inspect) => inspect.envelopes.length >= cycle * 2 + 1,
        30_000
      );

      await harness.sendService("demo/mailboxProbe", "record", mailboxKey, { id: sendId });
      expectedHistory.push(`send:${sendId}`);

      const retryRun = await harness.startWorkflow("demo/retryingStep", {
        token: `soak-retry-${cycle}`,
        retries: 1,
        failuresBeforeSuccess: 1,
        backoff: {
          kind: "exponential",
          initial: "120ms",
          factor: 2,
          max: "240ms",
          jitter: "half",
        },
      });
      retryRunIds.push(retryRun.run.id);

      const reviewRun = await harness.startWorkflow("demo/reviewCoordinator", {
        repoId: `repo-soak-${cycle}`,
        note: `note-${cycle}`,
      });
      reviewRunIds.push(reviewRun.run.id);

      if (cycle % 2 === 0) {
        const pipelineRun = await harness.startWorkflow("demo/serviceTurnCoordinator", {
          sessionId: `operator-soak-${cycle}`,
          topic: `topic-${cycle}`,
        });
        servicePipelineRunIds.push(pipelineRun.run.id);
      }

      const blockingRun = await harness.startWorkflow("demo/blockingStep", {
        durationMs: 1_200,
        timeout: "150ms",
      });
      blockingRunIds.push(blockingRun.run.id);

      await harness.waitForService(
        "demo/mailboxProbe",
        mailboxKey,
        (inspect) => inspect.envelopes.length >= (cycle + 1) * 2,
        30_000
      );

      if (cycle % 2 === 1) {
        await harness.restartDaemon();
      } else {
        await sleep(250);
      }
    }

    await harness.restartDaemon();

    for (const { id, command } of askCommands) {
      const result = await command.wait();
      if (result.exitCode !== 0) {
        throw new Error(
          [
            `soak ask ${id} failed`,
            result.stdout ? `stdout:\n${result.stdout}` : "",
            result.stderr ? `stderr:\n${result.stderr}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        );
      }

      const body = JSON.parse(result.stdout) as {
        ok: true;
        reply: { id: string; history: string[] };
      };
      expect(body.reply.id).toBe(id);
      expect(body.reply.history).toContain(`ask:${id}`);
    }

    for (const runId of retryRunIds) {
      const inspect = await waitForRunStatus(harness, runId, "completed", 120_000);
      expect(inspect.steps.find((step) => step.name === "retrying-step")?.attempts).toBe(2);
    }

    for (const runId of reviewRunIds) {
      await waitForRunStatus(harness, runId, "completed", 120_000);
    }

    for (const runId of servicePipelineRunIds) {
      await waitForRunStatus(harness, runId, "completed", 120_000);
    }

    for (const runId of blockingRunIds) {
      const inspect = await waitForRunStatus(harness, runId, "failed", 120_000);
      expect(inspect.events.map((event) => event.type)).toContain("StepFailed");
    }

    const serviceInspect = await harness.waitForService(
      "demo/mailboxProbe",
      mailboxKey,
      (inspect) =>
        inspect.run.status === "idle" &&
        inspect.envelopes.slice(0, expectedHistory.length).every((envelope) => envelope.status === "completed") &&
        inspect.run.state !== null &&
        typeof inspect.run.state === "object" &&
        Array.isArray((inspect.run.state as { history?: unknown[] }).history) &&
        (inspect.run.state as { history: unknown[] }).history.length === expectedHistory.length,
      120_000
    );

    const history = (serviceInspect.run.state as { history: string[] }).history;
    expect(history).toEqual(expectedHistory);
    expect(serviceInspect.envelopes.slice(0, expectedHistory.length).every((envelope) => envelope.status === "completed")).toBe(true);
  } finally {
    await harness.dispose();
  }
}, 300_000);

async function waitForRunStatus(
  harness: RuntimeHarness,
  runId: string,
  status: "completed" | "failed",
  timeoutMs: number
) {
  try {
    return await harness.waitForRun(runId, (body) => body.run.status === status, timeoutMs);
  } catch (error) {
    const latest = await harness.inspectRun(runId).catch(() => null);
    throw new Error(
      [
        `Timed out waiting for run ${runId} to reach ${status}`,
        latest ? `last status: ${latest.run.status}` : "last status: unavailable",
        error instanceof Error ? error.message : String(error),
      ].join("\n")
    );
  }
}
