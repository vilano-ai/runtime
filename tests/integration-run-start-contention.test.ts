import path from "node:path";

import { expect, test } from "bun:test";

import { RuntimeHarness } from "./runtime-harness.ts";

test(
  "concurrent run starts succeed while managed workers are already busy on local sqlite",
  async () => {
    const harness = await RuntimeHarness.create({
      env: {
        VILANO_LEASE_DURATION_SECONDS: "2",
        VILANO_MANAGED_WORKERS: "6",
        VILANO_REPO_POOL_SIZE: "5",
      },
    });

    const blockingRunIds: string[] = [];

    try {
      for (let index = 0; index < 8; index += 1) {
        const started = await harness.startWorkflow("demo/cooperativeStep", {
          durationMs: 4_000 + (index % 2) * 250,
          timeout: "12s",
        });
        blockingRunIds.push(started.run.id);
      }

      await Promise.all(
        blockingRunIds.map(async (runId) => {
          await harness.waitForRun(
            runId,
            (inspect) =>
              inspect.run.status === "running" &&
              inspect.steps.some((step) => step.status === "running"),
            30_000
          );
        })
      );

      const startResults = await Promise.allSettled(
        Array.from({ length: 24 }, async (_, index) => {
          return await harness.startWorkflow("demo/planner", {
            topic: `sqlite-run-start-${index}`,
          });
        })
      );

      const failures = startResults.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );

      expect(failures).toHaveLength(0);

      const createdRunIds = startResults
        .filter(
          (
            result
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<RuntimeHarness["startWorkflow"]>>
          > => result.status === "fulfilled"
        )
        .map((result) => result.value.run.id);

      await Promise.all(
        createdRunIds.map(async (runId) => {
          const inspect = await waitForTerminalRun(harness, runId, 120_000);
          expect(inspect.run.status).toBe("completed");
        })
      );

      await Promise.all(
        blockingRunIds.map(async (runId) => {
          const inspect = await waitForTerminalRun(harness, runId, 120_000);
          expect(inspect.run.status).toBe("completed");
        })
      );

      const startupLog = await Bun.file(path.join(harness.homeDir, "kernel-startup.log")).text();
      expect(startupLog).not.toContain("Database busy");
      expect(startupLog).not.toContain("WorkerRequestError: Database busy");
    } finally {
      await harness.dispose();
    }
  },
  180_000
);

async function waitForTerminalRun(
  harness: RuntimeHarness,
  runId: string,
  timeoutMs: number
) {
  try {
    return await harness.waitForRun(
      runId,
      (inspect) =>
        inspect.run.status === "completed" ||
        inspect.run.status === "failed" ||
        inspect.run.status === "cancelled",
      timeoutMs
    );
  } catch (error) {
    const latest = await harness.inspectRun(runId).catch(() => null);
    throw new Error(
      [
        `Timed out waiting for run ${runId} to reach a terminal state`,
        latest ? `last status: ${latest.run.status}` : "last status: unavailable",
        error instanceof Error ? error.message : String(error),
      ].join("\n")
    );
  }
}
