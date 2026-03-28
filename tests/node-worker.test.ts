import { expect, test } from "bun:test";

import { RuntimeHarness } from "./runtime-harness.ts";

test("unmanaged Node worker completes a workflow run", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_MANAGED_WORKERS: "0",
    },
  });

  try {
    const run = await harness.startWorkflow("demo/planner", { topic: "Node worker" });
    const worker = await harness.spawnWorker({
      runtime: "node",
      workerId: "node-manual-worker",
      once: true,
    });
    const workerResult = await worker.wait();

    expect(workerResult.exitCode).toBe(0);

    const inspect = await harness.waitForRun(
      run.run.id,
      (body) => body.run.status === "completed"
    );

    expect(inspect.run.output).toBeTruthy();
    expect(inspect.events.map((event) => event.type)).toContain("RunCompleted");
  } finally {
    await harness.dispose();
  }
});

test("managed Node workers can drive workflow and service orchestration", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_MANAGED_WORKER_RUNTIME: "node",
    },
  });

  try {
    const status = await harness.runCliJson<{
      ok: true;
      managedWorkerRuntime: string;
    }>(["daemon", "status"]);
    expect(status.managedWorkerRuntime).toBe("node");

    const run = await harness.startWorkflow("demo/reviewCoordinator", { repoId: "repo-node" });
    const inspect = await harness.waitForRun(
      run.run.id,
      (body) => body.run.status === "completed"
    );

    expect(inspect.run.output).toMatchObject({
      status: {
        ready: true,
      },
    });

    const serviceInspect = await harness.inspectService("demo/reviewer", { repoId: "repo-node" });
    expect(serviceInspect.run.status).toBe("idle");
    expect(serviceInspect.envelopes.length).toBeGreaterThan(0);
  } finally {
    await harness.dispose();
  }
});

test("managed Node workers exit after workflows leave lingering event-loop handles", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_MANAGED_WORKER_RUNTIME: "node",
    },
  });

  try {
    const first = await harness.startWorkflow("demo/lingeringHandleProbe", {});
    const firstCompleted = await harness.waitForRun(
      first.run.id,
      (inspect) => inspect.run.status === "completed"
    );

    const second = await harness.startWorkflow("demo/workerPidProbe", {});
    const secondCompleted = await harness.waitForRun(
      second.run.id,
      (inspect) => inspect.run.status === "completed",
      10_000
    );

    expect(firstCompleted.run.output).toBeTruthy();
    expect(secondCompleted.run.output).toBeTruthy();
    expect((firstCompleted.run.output as { pid: number }).pid).not.toBe(
      (secondCompleted.run.output as { pid: number }).pid
    );
  } finally {
    await harness.dispose();
  }
});
