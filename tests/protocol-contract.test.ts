import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import type { components as ControlComponents } from "../protocol/v1/generated/control.ts";
import type { components as WorkerComponents } from "../protocol/v1/generated/worker.ts";
import { RuntimeHarness } from "./runtime-harness.ts";

type KernelStatusResponse = ControlComponents["schemas"]["StatusResponse"];
type RuntimePruneResponse = ControlComponents["schemas"]["RuntimePruneResponse"];
type RuntimeStorageResponse = ControlComponents["schemas"]["RuntimeStorageResponse"];
type RunInspectResponse = ControlComponents["schemas"]["RunInspectResponse"];
type RunReplayResponse = ControlComponents["schemas"]["RunReplayResponse"];
type ServiceRunListResponse = ControlComponents["schemas"]["ServiceRunListResponse"];
type ActivationLeaseResponse = WorkerComponents["schemas"]["ActivationLeaseResponse"];
type LeaseStatusResponse = WorkerComponents["schemas"]["LeaseStatusResponse"];
type StepResolveResponse = WorkerComponents["schemas"]["StepResolveResponse"];

test("control status endpoint matches the published contract", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const response = await harness.requestKernel("/v1/status");
    expect(response.status).toBe(200);

    const body = (await response.json()) as KernelStatusResponse;
    expect(body.ok).toBe(true);
    expect(typeof body.runtimeVersion).toBe("string");
    expect(typeof body.protocolVersion).toBe("number");
    expect(typeof body.schemaVersion).toBe("number");
    expect(Array.isArray(body.appliedMigrations)).toBe(true);
    expect(typeof body.homeDir).toBe("string");
    expect(typeof body.executionHomeDir).toBe("string");
    expect(typeof body.projectRoot).toBe("string");
    expect(typeof body.runtimeDbPath).toBe("string");
    expect(typeof body.managedWorkerRuntime).toBe("string");
    expect(typeof body.sqliteBusyTimeoutMs).toBe("number");
  } finally {
    await harness.dispose();
  }
});

test("runtime storage and prune admin endpoints match the published contract", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const storageResponse = await harness.requestKernel("/v1/admin/storage");
    expect(storageResponse.status).toBe(200);

    const storageBody = (await storageResponse.json()) as RuntimeStorageResponse;
    expect(storageBody.ok).toBe(true);
    expect(typeof storageBody.roots.runtimeDbPath).toBe("string");
    expect(Array.isArray(storageBody.paths)).toBe(true);
    expect(typeof storageBody.database.runs).toBe("number");

    const pruneResponse = await harness.requestKernel("/v1/admin/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dryRun: true,
        completedRunTtlSeconds: 0,
        serviceEnvelopeTtlSeconds: 0,
        artifactGraceSeconds: 0,
        eventPayloadGraceSeconds: 0,
        runtimeCacheTtlSeconds: 0,
        daemonLogMaxBytes: 0,
        vacuumDatabase: false,
      }),
    });
    expect(pruneResponse.status).toBe(200);

    const pruneBody = (await pruneResponse.json()) as RuntimePruneResponse;
    expect(pruneBody.ok).toBe(true);
    expect(pruneBody.dryRun).toBe(true);
    expect(pruneBody.completedRuns.enabled).toBe(true);
    expect(pruneBody.completedRuns.ttlSeconds).toBe(0);
    expect(pruneBody.serviceEnvelopes.enabled).toBe(true);
    expect(pruneBody.serviceEnvelopes.ttlSeconds).toBe(0);
    expect(typeof pruneBody.artifacts.candidateCount).toBe("number");
    expect(pruneBody.eventPayloads.garbageCollected).toBe(false);
    expect(pruneBody.runtimeCache.enabled).toBe(true);
    expect(pruneBody.daemonLog.enabled).toBe(true);
    expect(pruneBody.database.walCheckpointed).toBe(false);
    expect(pruneBody.database.walCheckpoint.attempted).toBe(false);

    const defaultPruneResponse = await harness.requestKernel("/v1/admin/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(defaultPruneResponse.status).toBe(200);
    const defaultPruneBody = (await defaultPruneResponse.json()) as RuntimePruneResponse;
    expect(defaultPruneBody.runtimeCache.enabled).toBe(false);
    expect(defaultPruneBody.runtimeCache.ttlSeconds).toBeNull();
  } finally {
    await harness.dispose();
  }
});

test("worker activation and step resolution endpoints match the published contract", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_MANAGED_WORKERS: "0",
    },
  });

  try {
    await harness.startWorkflow("demo/planner", { topic: "Protocol contract" });

    const daemonState = JSON.parse(
      await fs.readFile(path.join(harness.homeDir, "daemon-auth.json"), "utf8")
    ) as { workerAuthToken?: string };
    const workerToken = daemonState.workerAuthToken;
    expect(workerToken).toBeTruthy();

    const leaseResponse = await fetch(`${harness.serverUrl}/v1/activations/lease`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(workerToken ? { "x-vilano-token": workerToken } : {}),
      },
      body: JSON.stringify({
        workerId: "protocol-contract-worker",
      }),
    });

    expect(leaseResponse.status).toBe(200);

    const leased = (await leaseResponse.json()) as ActivationLeaseResponse;
    expect(leased.ok).toBe(true);
    expect(leased.activation).toBeTruthy();
    expect(leased.activation?.kind).toBe("workflow");

    if (!leased.activation || leased.activation.kind !== "workflow") {
      throw new Error("Expected a workflow activation lease");
    }

    const leaseId = leased.activation.leaseId;
    expect(typeof leased.activation.leaseToken).toBe("string");

    const deniedLeaseStatusResponse = await fetch(
      `${harness.serverUrl}/v1/leases/${encodeURIComponent(leaseId)}/status`,
      {
        headers: {
          ...(workerToken ? { "x-vilano-token": workerToken } : {}),
        },
      }
    );
    expect(deniedLeaseStatusResponse.status).toBe(401);

    const leaseStatusResponse = await fetch(
      `${harness.serverUrl}/v1/leases/${encodeURIComponent(leaseId)}/status`,
      {
        headers: {
          "x-vilano-token": leased.activation.leaseToken,
        },
      }
    );
    expect(leaseStatusResponse.status).toBe(200);

    const leaseStatus = (await leaseStatusResponse.json()) as LeaseStatusResponse;
    expect(leaseStatus.ok).toBe(true);
    expect(leaseStatus.lease.active).toBe(true);

    const stepResolveResponse = await fetch(
      `${harness.serverUrl}/v1/leases/${encodeURIComponent(leaseId)}/steps/resolve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-vilano-token": leased.activation.leaseToken,
        },
        body: JSON.stringify({
          name: "protocol-step",
          key: "protocol-step",
          timeoutMs: 1000,
        }),
      }
    );

    expect(stepResolveResponse.status).toBe(200);

    const stepResolve = (await stepResolveResponse.json()) as StepResolveResponse;
    expect(stepResolve.ok).toBe(true);
    expect(stepResolve.step.status).toBe("pending");
  } finally {
    await harness.dispose();
  }
});

test("control inspect, replay, and service run endpoints match the published contract", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const workflow = await harness.startWorkflow("demo/planner", { topic: "Protocol inspect" });
    await harness.waitForRun(workflow.run.id, (body) => body.run.status === "completed");
    await harness.ensureService("demo/reviewer", { repoId: "protocol-reviewer" });

    const inspectResponse = await harness.requestKernel(
      `/v1/runs/${encodeURIComponent(workflow.run.id)}`
    );
    expect(inspectResponse.status).toBe(200);
    const inspectBody = (await inspectResponse.json()) as RunInspectResponse;
    expect(inspectBody.ok).toBe(true);
    expect(inspectBody.run.id).toBe(workflow.run.id);
    expect(Array.isArray(inspectBody.events)).toBe(true);
    expect(Array.isArray(inspectBody.steps)).toBe(true);
    expect(Array.isArray(inspectBody.execs)).toBe(true);
    expect(Array.isArray(inspectBody.waits)).toBe(true);
    expect(Array.isArray(inspectBody.signals)).toBe(true);
    expect(Array.isArray(inspectBody.children)).toBe(true);
    expect(Array.isArray(inspectBody.envelopes)).toBe(true);

    const replayResponse = await harness.requestKernel(
      `/v1/runs/${encodeURIComponent(workflow.run.id)}/replay`
    );
    expect(replayResponse.status).toBe(200);
    const replayBody = (await replayResponse.json()) as RunReplayResponse;
    expect(replayBody.ok).toBe(true);
    expect(replayBody.run.id).toBe(workflow.run.id);
    expect(Array.isArray(replayBody.timeline)).toBe(true);
    expect(replayBody.timeline.length).toBeGreaterThan(0);

    const serviceRunsResponse = await harness.requestKernel(
      `/v1/service-runs?project=${encodeURIComponent("demo")}`
    );
    expect(serviceRunsResponse.status).toBe(200);
    const serviceRunsBody = (await serviceRunsResponse.json()) as ServiceRunListResponse;
    expect(serviceRunsBody.ok).toBe(true);
    expect(serviceRunsBody.project).toBe("demo");
    expect(serviceRunsBody.activeOnly).toBe(false);
    expect(
      serviceRunsBody.runs.some(
        (run) => run.definitionName === "reviewer" && run.serviceKey === "protocol-reviewer"
      )
    ).toBe(true);
  } finally {
    await harness.dispose();
  }
});
