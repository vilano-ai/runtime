import { expect, test } from "bun:test";

import type { RuntimeDebugResponse } from "../cli/src/types.ts";
import { RuntimeHarness } from "./runtime-harness.ts";

test(
  "local sqlite backend survives concurrent managed-worker heartbeats and service traffic without busy failures",
  async () => {
    const harness = await RuntimeHarness.create({
      env: {
        VILANO_LEASE_DURATION_SECONDS: "2",
        VILANO_MANAGED_WORKERS: "6",
        VILANO_REPO_POOL_SIZE: "5",
      },
    });

    const longRunningRuns: string[] = [];
    const servicePipelineRuns: string[] = [];
    const reviewRuns: string[] = [];

    try {
      await runWithConcurrency(
        Array.from({ length: 10 }, (_, index) => async () => {
          const started = await harness.startWorkflow("demo/cooperativeStep", {
            durationMs: 2_500 + (index % 3) * 200,
            timeout: "10s",
          });
          longRunningRuns.push(started.run.id);
        }),
        4
      );

      await runWithConcurrency(
        Array.from({ length: 18 }, (_, index) => async () => {
          const started = await harness.startWorkflow("demo/serviceTurnCoordinator", {
            sessionId: `sqlite-service-${index}`,
            topic: `sqlite-topic-${index}`,
          });
          servicePipelineRuns.push(started.run.id);
        }),
        4
      );

      await runWithConcurrency(
        Array.from({ length: 18 }, (_, index) => async () => {
          const started = await harness.startWorkflow("demo/reviewCoordinator", {
            repoId: `sqlite-review-${index}`,
            note: `sqlite-note-${index}`,
          });
          reviewRuns.push(started.run.id);
        }),
        4
      );

      const allRunIds = [...longRunningRuns, ...servicePipelineRuns, ...reviewRuns];
      const completions = await Promise.all(
        allRunIds.map(async (runId) => {
          const inspect = await waitForRunCompletion(harness, runId, 120_000);
          return { runId, inspect };
        })
      );

      expect(completions.every(({ inspect }) => inspect.run.status === "completed")).toBe(true);

      const runtimeDebug = await getRuntimeDebug(harness);
      expect(
        runtimeDebug.busyRetries.recentExhausted.filter(
          (entry) => entry.profile !== "lease_maintenance"
        )
      ).toHaveLength(0);
    } finally {
      await harness.dispose();
    }
  },
  180_000
);

async function waitForRunCompletion(
  harness: RuntimeHarness,
  runId: string,
  timeoutMs: number
) {
  try {
    return await harness.waitForRun(
      runId,
      (inspect) =>
        inspect.run.status === "completed" || inspect.run.status === "failed",
      timeoutMs
    );
  } catch (error) {
    const latest = await harness.inspectRun(runId).catch(() => null);
    throw new Error(
      [
        `Timed out waiting for run ${runId} to complete`,
        latest ? `last status: ${latest.run.status}` : "last status: unavailable",
        error instanceof Error ? error.message : String(error),
      ].join("\n")
    );
  }
}

async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  limit: number
): Promise<void> {
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (nextIndex < tasks.length) {
        const current = nextIndex;
        nextIndex += 1;
        await tasks[current]?.();
      }
    })
  );
}

async function getRuntimeDebug(harness: RuntimeHarness): Promise<RuntimeDebugResponse> {
  const response = await harness.requestKernel("/v1/admin/runtime-debug");
  expect(response.status).toBe(200);
  return (await response.json()) as RuntimeDebugResponse;
}
