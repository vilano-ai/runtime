import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import type { WorkerClient, WorkflowActivation } from "../worker/shared/src/client.ts";
import { executeActivation } from "../worker/shared/src/core.ts";
import { createNodeCompatibleRuntimeAdapter } from "../worker/shared/src/runtime-adapter.ts";

test("activation setup failures fail the run and clear the lease token", async () => {
  const workerHome = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-worker-core-"));
  const missingProjectPath = path.join(workerHome, "missing-project");
  const calls: {
    heartbeats: number;
    failRun: Array<{ leaseId: string; error: Record<string, unknown> }>;
    clearedLeaseIds: string[];
  } = {
    heartbeats: 0,
    failRun: [],
    clearedLeaseIds: [],
  };

  const client = {
    async heartbeat() {
      calls.heartbeats += 1;
    },
    async failRun(leaseId: string, error: Record<string, unknown>) {
      calls.failRun.push({ leaseId, error });
    },
    clearLeaseAuthToken(leaseId: string) {
      calls.clearedLeaseIds.push(leaseId);
    },
  } as unknown as WorkerClient;

  const activation = {
    kind: "workflow",
    leaseId: "lease-setup-failure",
    project: {
      path: missingProjectPath,
    },
  } as unknown as WorkflowActivation;

  try {
    await executeActivation(
      createNodeCompatibleRuntimeAdapter("node"),
      client,
      activation,
      5,
      workerHome
    );

    expect(calls.failRun).toHaveLength(1);
    expect(calls.failRun[0]?.leaseId).toBe("lease-setup-failure");
    expect(calls.clearedLeaseIds).toEqual(["lease-setup-failure"]);
  } finally {
    await fs.rm(workerHome, { recursive: true, force: true });
  }
});
