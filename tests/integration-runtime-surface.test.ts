import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { RuntimeHarness, expectInOrder, sleep } from "./runtime-harness.ts";

test("runtime harness dispose reaps daemon and spawned worker processes", async () => {
  const harness = await RuntimeHarness.create();

  const daemonPid = harness.daemonProcessId;
  const run = await harness.startWorkflow("demo/blockingStep", {
    durationMs: 5_000,
  });

  await harness.waitForRun(run.run.id, (body) => body.run.status === "running");

  const processCommandsBeforeDispose = await listProcessesContaining(harness.homeDir);
  expect(processCommandsBeforeDispose.some((command) => command.includes("worker"))).toBe(true);

  await harness.dispose();

  expect(daemonPid).toBeTruthy();
  expect(await waitForProcessExit(daemonPid as number, 5_000)).toBe(true);
  expect(await waitFor(async () => (await listProcessesContaining(harness.homeDir)).length === 0, 5_000)).toBe(
    true
  );
});

test("run cancel fails waiting workflows and records cancellation counts", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/sleeper", { duration: "30s" });

    await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "waiting" && inspect.waits.some((wait) => wait.status === "waiting")
    );

    const cancelled = await harness.cancelRun(run.run.id);
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.cancelledWaitCount).toBe(1);
    expect(cancelled.cancelledChildRunCount).toBe(0);
    expect(cancelled.cancelledServiceAskCount).toBe(0);

    const inspect = await harness.waitForRun(
      run.run.id,
      (body) => body.run.status === "cancelled"
    );

    expect(inspect.waits.map((wait) => wait.status)).toContain("failed");
    expect(inspect.events.map((event) => event.type)).toContain("RunCancelled");
  } finally {
    await harness.dispose();
  }
});

test("run cancel propagates to spawned child workflows", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/slowDelegator", {
      topic: "BEAM",
      duration: "30s",
    });

    const parentInspect = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.children.length === 1 &&
        inspect.children[0]?.childRunId !== undefined
    );

    const childRunId = parentInspect.children[0]?.childRunId;
    expect(childRunId).toBeTruthy();

    const cancelled = await harness.cancelRun(run.run.id);
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.cancelledChildRunCount).toBe(1);

    const cancelledParent = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "cancelled" &&
        inspect.children.every((child) => child.status === "cancelled")
    );

    expect(cancelledParent.children.map((child) => child.status)).toContain("cancelled");

    const cancelledChild = await harness.waitForRun(
      childRunId as string,
      (inspect) => inspect.run.status === "cancelled"
    );

    expect(cancelledChild.events.map((event) => event.type)).toContain("RunCancelled");
  } finally {
    await harness.dispose();
  }
});

test("cancelled child results fail the waiting parent", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/cancelledChildParent", { token: "cancelled-child" });
    const waiting = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "waiting" && inspect.children.length === 1
    );

    const childRunId = waiting.children[0]?.childRunId;
    expect(childRunId).toBeTruthy();

    await harness.cancelRun(childRunId as string);

    const failed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "failed"
    );

    expect(failed.run.error).toBeTruthy();
    expect(failed.events.map((event) => event.type)).toContain("RunFailed");
  } finally {
    await harness.dispose();
  }
});


test("run cancel propagates through outbound service asks", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "cancel-session" };

  try {
    const run = await harness.startWorkflow("demo/approvalCoordinator", keyInput);

    await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.waits.some((wait) => wait.kind === "ask_reply" && wait.status === "waiting")
    );

    await harness.waitForService(
      "demo/operator",
      keyInput,
      (inspect) => inspect.envelopes.length > 0 && (inspect.turns ?? []).length > 0
    );

    const cancelled = await harness.cancelRun(run.run.id);
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.cancelledServiceAskCount).toBe(1);

    const workflowInspect = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "cancelled"
    );
    expect(workflowInspect.events.map((event) => event.type)).toContain("RunCancelled");

    const serviceInspect = await harness.waitForService(
      "demo/operator",
      keyInput,
      (inspect) =>
        inspect.run.status === "idle" &&
        inspect.envelopes.some((envelope) => envelope.status === "failed") &&
        (inspect.turns ?? []).some((turn) => turn.phase === "failed")
    );

    expect(serviceInspect.envelopes.map((envelope) => envelope.status)).toContain("failed");
  } finally {
    await harness.dispose();
  }
});

test("first in-run service asks suspend durably before the service replies", async () => {
  const harness = await RuntimeHarness.create();
  const keyInput = { sessionId: "suspend-session" };

  try {
    const run = await harness.startWorkflow("demo/approvalCoordinator", keyInput);

    const waitingWorkflow = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.waits.some((wait) => wait.kind === "ask_reply" && wait.status === "waiting") &&
        inspect.events.map((event) => event.type).includes("AskRequested") &&
        inspect.events.map((event) => event.type).includes("RunSuspended")
    );

    const waitingService = await harness.waitForService(
      "demo/operator",
      keyInput,
      (inspect) =>
        inspect.run.status === "waiting" &&
        inspect.envelopes.some(
          (envelope) => envelope.name === "awaitApproval" && envelope.status === "processing"
        )
    );

    expect(waitingWorkflow.waits.some((wait) => wait.kind === "ask_reply")).toBe(true);

    await harness.sendSignal(waitingService.run.id, "approved", {
      source: "suspend-regression",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );

    expect(completed.run.output).toMatchObject({
      operatorRunId: waitingService.run.id,
    });
  } finally {
    await harness.dispose();
  }
});

test("run cancel marks active exec work cancelled", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/longExec", { durationMs: 30_000 });

    await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.execs.some((exec) => exec.status === "running")
    );

    const cancelled = await harness.cancelRun(run.run.id);
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.hadActiveLease).toBeTrue();

    const inspect = await harness.waitForRun(
      run.run.id,
      (body) =>
        body.run.status === "cancelled" &&
        body.execs.some((exec) => exec.status === "cancelled")
    );

    expect(inspect.execs.map((exec) => exec.status)).toContain("cancelled");
    expect(inspect.execs.map((exec) => exec.lastEventType)).toContain("ProcessCancelled");
    expect(inspect.events.map((event) => event.type)).toContain("RunCancelled");
  } finally {
    await harness.dispose();
  }
});

test("kernel rejects unauthenticated localhost requests", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const unauthorized = await fetch(`${harness.serverUrl}/v1/status`);
    expect(unauthorized.status).toBe(401);

    const authorized = await harness.requestKernel("/v1/status");
    expect(authorized.status).toBe(200);
  } finally {
    await harness.dispose();
  }
});

test("runtime debug endpoint reports queue heads, leases, and backlog counts", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const running = await harness.startWorkflow("demo/blockingStep", {
      durationMs: 5_000,
    });

    await harness.waitForRun(running.run.id, (inspect) => inspect.run.status === "running");

    const pending = await harness.startWorkflow("demo/planner", {
      topic: "runtime-debug-queue-head",
    });

    const response = await harness.requestKernel("/v1/admin/runtime-debug");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: true;
      busyRetries: {
        profiles: Record<string, unknown>;
        recentExhausted: Array<{ profile: string; reason: string; at: string }>;
      };
      activeLeases: Array<{ runId: string; leaseId: string; leaseWorkerId: string | null }>;
      managedWorkers: Array<{ workerId: string; activeLeaseCount: number }>;
      leaseQueue: {
        workflowHead: { id: string } | null;
        serviceTurnHead: unknown | null;
        oldestPendingRuns: Array<{ id: string }>;
        pendingByProject: Array<{ project: string; count: number }>;
      };
      runStatusCounts: Array<{ status: string; count: number }>;
      projectRunStatusCounts: Array<{ project: string; status: string; count: number }>;
    };

    expect(body.ok).toBe(true);
    expect(body.busyRetries.profiles).toBeObject();
    expect(Array.isArray(body.busyRetries.recentExhausted)).toBe(true);
    expect(body.activeLeases.some((lease) => lease.runId === running.run.id)).toBe(true);
    expect(body.managedWorkers.length).toBeGreaterThan(0);
    expect(body.leaseQueue.workflowHead?.id).toBe(pending.run.id);
    expect(body.leaseQueue.serviceTurnHead).toBeNull();
    expect(body.leaseQueue.oldestPendingRuns.some((run) => run.id === pending.run.id)).toBe(true);
    expect(
      body.leaseQueue.pendingByProject.some(
        (entry) => entry.project === "demo" && Number(entry.count) >= 1
      )
    ).toBe(true);
    expect(
      body.runStatusCounts.some((entry) => entry.status === "running" && Number(entry.count) >= 1)
    ).toBe(true);
    expect(
      body.projectRunStatusCounts.some(
        (entry) => entry.project === "demo" && entry.status === "running" && Number(entry.count) >= 1
      )
    ).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("runtime storage endpoint and CLI report disk usage categories", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const response = await harness.requestKernel("/v1/admin/storage");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: true;
      roots: { runtimeDbPath: string; executionHomeDir: string };
      paths: Array<{ name: string; path: string; bytes: number; exists: boolean }>;
      database: {
        runs: number;
        runPayloads: { count: number; bytes: number };
        runEvents: { count: number; bytes: number };
        eventPayloadRefs: { count: number; bytes: number };
        runServiceOps: { count: number; bytes: number };
        topicPublishes: { count: number; bytes: number };
      };
    };

    expect(body.ok).toBe(true);
    expect(body.roots.runtimeDbPath).toBeTruthy();
    expect(body.roots.executionHomeDir).toBeTruthy();
    expect(body.paths.some((entry) => entry.name === "runtime_db" && entry.exists)).toBe(true);
    expect(body.paths.some((entry) => entry.name === "runtime_db_wal")).toBe(true);
    expect(body.paths.some((entry) => entry.name === "runtime_db_shm")).toBe(true);
    expect(body.paths.some((entry) => entry.name === "project_snapshots" && entry.exists)).toBe(true);
    expect(body.paths.every((entry) => Number.isFinite(entry.bytes))).toBe(true);
    expect(Number.isInteger(body.database.runs)).toBe(true);
    expect(Number.isInteger(body.database.runPayloads.bytes)).toBe(true);
    expect(Number.isInteger(body.database.runEvents.count)).toBe(true);
    expect(Number.isInteger(body.database.eventPayloadRefs.bytes)).toBe(true);
    expect(Number.isInteger(body.database.runServiceOps.bytes)).toBe(true);
    expect(Number.isInteger(body.database.topicPublishes.count)).toBe(true);

    const cliBody = await harness.runCliJson<typeof body>(["daemon", "storage"]);
    expect(cliBody.ok).toBe(true);
    expect(cliBody.paths.some((entry) => entry.name === "runtime_db" && entry.exists)).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("runtime prune removes unreferenced snapshots and stale run workspaces", async () => {
  const harness = await RuntimeHarness.create();
  let failingSnapshotParent: string | null = null;

  try {
    const storage = await harness.runCliJson<{
      ok: true;
      roots: { runtimeDbPath: string; executionHomeDir: string };
    }>(["daemon", "storage"]);
    const runtimeDbPath = storage.roots.runtimeDbPath;
    const executionHome = storage.roots.executionHomeDir;
    const orphanSnapshot = path.join(executionHome, "project-snapshots", "orphan", "snapshot-1");
    const freshSnapshot = path.join(executionHome, "project-snapshots", "fresh", "snapshot-1");
    const failingSnapshot = path.join(executionHome, "project-snapshots", "failing", "snapshot-1");
    const staleWorkspace = path.join(executionHome, "worker-home", "run-workspaces", "lease-stale");
    const staleRuntimeCache = path.join(harness.homeDir, "runtime-cache", "managed-workers", "stale-version");
    const daemonLogPath = path.join(harness.homeDir, "kernel-startup.log");
    const orphanArtifact = path.join(
      executionHome,
      "artifacts",
      "runs",
      "run_missing",
      "execs",
      "orphan",
      "attempt-1",
      "stdout.txt"
    );
    const oldEnoughForPrune = new Date(Date.now() - 10 * 60 * 1000);
    const initialSnapshotGraceSeconds = 60;
    const serviceKey = { sessionId: "prune-runtime" };
    await harness.ensureService("demo/operator", serviceKey);
    const service = await harness.inspectService("demo/operator", serviceKey);
    const completedRun = await harness.startWorkflow("demo/planner", { topic: "prune-runtime" });
    await harness.waitForRun(completedRun.run.id, (body) => body.run.status === "completed");
    const unsafeParentRunId = `run_prune_live_parent_${completedRun.run.id}`;
    const unsafeChildRunId = `run_prune_terminal_child_${completedRun.run.id}`;
    const safeCompletedRunId = `run_prune_safe_${completedRun.run.id}`;

    const db = new Database(runtimeDbPath);
    try {
      db.query(
        `
          insert into runs (
            id,
            project_name,
            definition_kind,
            definition_name,
            project_snapshot_path,
            project_definitions_json,
            definition_file,
            definition_export_name,
            definition_runtime_kind,
            definition_source_language,
            status,
            lease_id,
            lease_auth_token,
            lease_worker_id,
            lease_expires_at,
            input_json,
            output_json,
            error_json,
            created_at,
            updated_at
          ) values (?, 'demo', 'workflow', 'planner', null, null, null, null, null, null, ?, null, null, null, null, '{}', null, null, ?, ?)
        `
      ).run(unsafeParentRunId, "waiting", new Date().toISOString(), new Date().toISOString());

      db.query(
        `
          insert into runs (
            id,
            project_name,
            definition_kind,
            definition_name,
            project_snapshot_path,
            project_definitions_json,
            definition_file,
            definition_export_name,
            definition_runtime_kind,
            definition_source_language,
            status,
            lease_id,
            lease_auth_token,
            lease_worker_id,
            lease_expires_at,
            input_json,
            output_json,
            error_json,
            created_at,
            updated_at
          ) values (?, 'demo', 'workflow', 'planner', null, null, null, null, null, null, 'completed', null, null, null, null, '{}', '{}', null, ?, ?)
        `
      ).run(unsafeChildRunId, oldEnoughForPrune.toISOString(), oldEnoughForPrune.toISOString());

      db.query(
        `
          insert into runs (
            id,
            project_name,
            definition_kind,
            definition_name,
            project_snapshot_path,
            project_definitions_json,
            definition_file,
            definition_export_name,
            definition_runtime_kind,
            definition_source_language,
            status,
            lease_id,
            lease_auth_token,
            lease_worker_id,
            lease_expires_at,
            input_json,
            output_json,
            error_json,
            created_at,
            updated_at
          ) values (?, 'demo', 'workflow', 'planner', null, null, null, null, null, null, 'completed', null, null, null, null, '{}', '{}', null, ?, ?)
        `
      ).run(safeCompletedRunId, oldEnoughForPrune.toISOString(), oldEnoughForPrune.toISOString());

      db.query(
        `
          insert into run_children (
            parent_run_id,
            op_key,
            child_run_id,
            definition_name,
            status,
            created_at,
            updated_at
          ) values (?, 'unsafe-child', ?, 'planner', 'completed', ?, ?)
        `
      ).run(
        unsafeParentRunId,
        unsafeChildRunId,
        oldEnoughForPrune.toISOString(),
        oldEnoughForPrune.toISOString()
      );

      db.query(
        `
          insert into run_topic_publishes (
            caller_run_id,
            op_key,
            publish_id,
            topic,
            payload_json,
            matched_count,
            enqueued_count,
            rejected_count,
            created_at,
            updated_at
          ) values (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
        `
      ).run(
        completedRun.run.id,
        "test:publish",
        `publish:${completedRun.run.id}`,
        "prune-topic",
        JSON.stringify({ payload: "x".repeat(1024) }),
        new Date().toISOString(),
        new Date().toISOString()
      );

      db.query(
        `
          insert into service_envelopes (
            id,
            service_run_id,
            kind,
            name,
            attempt,
            payload_json,
            correlation_id,
            sender_run_id,
            status,
            reply_json,
            error_json,
            wake_at,
            created_at,
            updated_at
          ) values (?, ?, 'signal', 'afterPrune', null, ?, null, ?, 'pending', null, null, null, ?, ?)
        `
      ).run(
        `env_${completedRun.run.id}`,
        service.run.id,
        JSON.stringify({ keep: true }),
        completedRun.run.id,
        new Date().toISOString(),
        new Date().toISOString()
      );

      db.query(
        `
          insert into service_envelopes (
            id,
            service_run_id,
            kind,
            name,
            attempt,
            payload_json,
            correlation_id,
            sender_run_id,
            status,
            reply_json,
            error_json,
            wake_at,
            created_at,
            updated_at
          ) values (?, ?, 'ask', 'oldReply', 1, ?, null, ?, 'completed', ?, null, null, ?, ?)
        `
      ).run(
        `terminal_env_${completedRun.run.id}`,
        service.run.id,
        JSON.stringify({ remove: true }),
        completedRun.run.id,
        JSON.stringify({ largeReply: "y".repeat(1024) }),
        oldEnoughForPrune.toISOString(),
        oldEnoughForPrune.toISOString()
      );

      db.exec("pragma wal_checkpoint(full)");
    } finally {
      db.close();
    }

    await fs.mkdir(orphanSnapshot, { recursive: true });
    await fs.writeFile(path.join(orphanSnapshot, "index.ts"), "export const orphan = true;\n", "utf8");
    await fs.chmod(orphanSnapshot, 0o555);
    await fs.utimes(orphanSnapshot, oldEnoughForPrune, oldEnoughForPrune);
    await fs.mkdir(freshSnapshot, { recursive: true });
    await fs.writeFile(path.join(freshSnapshot, "index.ts"), "export const fresh = true;\n", "utf8");
    const invalidDryRunSnapshot = path.join(
      executionHome,
      "project-snapshots",
      "invalid-dry-run",
      "snapshot-1"
    );
    await fs.mkdir(invalidDryRunSnapshot, { recursive: true });
    await fs.writeFile(path.join(invalidDryRunSnapshot, "index.ts"), "export const invalid = true;\n", "utf8");
    await fs.utimes(invalidDryRunSnapshot, oldEnoughForPrune, oldEnoughForPrune);
    await fs.mkdir(failingSnapshot, { recursive: true });
    await fs.writeFile(path.join(failingSnapshot, "index.ts"), "export const fail = true;\n", "utf8");
    await fs.utimes(failingSnapshot, oldEnoughForPrune, oldEnoughForPrune);
    failingSnapshotParent = path.dirname(failingSnapshot);
    await fs.chmod(failingSnapshotParent, 0o555);
    await fs.mkdir(staleWorkspace, { recursive: true });
    await fs.writeFile(path.join(staleWorkspace, "workspace.txt"), "stale\n", "utf8");
    await fs.utimes(staleWorkspace, oldEnoughForPrune, oldEnoughForPrune);
    await fs.mkdir(path.join(staleRuntimeCache, "worker"), { recursive: true });
    await fs.writeFile(path.join(staleRuntimeCache, "worker", "index.ts"), "export {};\n", "utf8");
    await fs.utimes(staleRuntimeCache, oldEnoughForPrune, oldEnoughForPrune);
    await fs.writeFile(daemonLogPath, "x".repeat(128), "utf8");
    await fs.mkdir(path.dirname(orphanArtifact), { recursive: true });
    await fs.writeFile(orphanArtifact, "orphan artifact\n", "utf8");
    await fs.utimes(orphanArtifact, oldEnoughForPrune, oldEnoughForPrune);

    const dryRun = await harness.runCliJson<{
      ok: true;
      dryRun: boolean;
      projectSnapshots: {
        graceSeconds: number;
        candidateCount: number;
        removedCount: number;
        failedCount: number;
        failedPaths: Array<{ path: string; failedPath: string; reason: string; bytes: number }>;
      };
      runWorkspaces: { candidateCount: number; removedCount: number; failedCount: number };
      completedRuns: { enabled: boolean; candidateCount: number; removedCount: number; skippedUnsafeCount: number };
      serviceEnvelopes: { enabled: boolean; candidateCount: number; removedCount: number };
      artifacts: { candidateCount: number; removedCount: number; failedCount: number };
      eventPayloads: { garbageCollected: boolean };
      runtimeCache: { candidateCount: number; removedCount: number; failedCount: number };
      daemonLog: { truncated: boolean; removedBytes: number };
      database: { walCheckpointed: boolean; vacuumed: boolean; beforeBytes: number; afterBytes: number };
    }>([
      "daemon",
      "prune",
      "--project-snapshot-grace-seconds",
      String(initialSnapshotGraceSeconds),
      "--workspace-ttl-seconds",
      "0",
      "--completed-run-ttl-seconds",
      "0",
      "--service-envelope-ttl-seconds",
      "0",
      "--artifact-grace-seconds",
      "0",
      "--event-payload-grace-seconds",
      "0",
      "--runtime-cache-ttl-seconds",
      "0",
      "--daemon-log-max-bytes",
      "1",
      "--dry-run",
    ]);

    expect(dryRun.projectSnapshots.candidateCount).toBeGreaterThanOrEqual(1);
    expect(dryRun.projectSnapshots.graceSeconds).toBe(initialSnapshotGraceSeconds);
    expect(dryRun.projectSnapshots.removedCount).toBe(0);
    expect(dryRun.projectSnapshots.failedCount).toBe(0);
    expect(dryRun.runWorkspaces.candidateCount).toBeGreaterThanOrEqual(1);
    expect(dryRun.runWorkspaces.removedCount).toBe(0);
    expect(dryRun.runWorkspaces.failedCount).toBe(0);
    expect(dryRun.completedRuns.enabled).toBe(true);
    expect(dryRun.completedRuns.candidateCount).toBeGreaterThanOrEqual(1);
    expect(dryRun.completedRuns.skippedUnsafeCount).toBeGreaterThanOrEqual(1);
    expect(dryRun.completedRuns.removedCount).toBe(0);
    expect(dryRun.serviceEnvelopes.enabled).toBe(true);
    expect(dryRun.serviceEnvelopes.candidateCount).toBeGreaterThanOrEqual(1);
    expect(dryRun.serviceEnvelopes.removedCount).toBe(0);
    expect(dryRun.artifacts.candidateCount).toBeGreaterThanOrEqual(1);
    expect(dryRun.artifacts.removedCount).toBe(0);
    expect(dryRun.artifacts.failedCount).toBe(0);
    expect(dryRun.eventPayloads.garbageCollected).toBe(false);
    expect(dryRun.runtimeCache.candidateCount).toBeGreaterThanOrEqual(1);
    expect(dryRun.runtimeCache.removedCount).toBe(0);
    expect(dryRun.daemonLog.truncated).toBe(false);
    expect(dryRun.database.walCheckpointed).toBe(false);
    await fs.access(orphanSnapshot);
    await fs.access(freshSnapshot);
    await fs.access(failingSnapshot);
    await fs.access(staleWorkspace);

    const invalidDryRun = await harness.requestKernel("/v1/admin/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: "yes", projectSnapshotGraceSeconds: 0 }),
    });
    expect(invalidDryRun.status).toBe(400);
    expect(await invalidDryRun.json()).toMatchObject({
      ok: false,
      error: {
        code: "invalid_prune_option",
      },
    });
    await fs.access(invalidDryRunSnapshot);

    const pruned = await harness.runCliJson<typeof dryRun>([
      "daemon",
      "prune",
      "--project-snapshot-grace-seconds",
      String(initialSnapshotGraceSeconds),
      "--workspace-ttl-seconds",
      "0",
      "--completed-run-ttl-seconds",
      "0",
      "--service-envelope-ttl-seconds",
      "0",
      "--artifact-grace-seconds",
      "0",
      "--event-payload-grace-seconds",
      "0",
      "--runtime-cache-ttl-seconds",
      "0",
      "--daemon-log-max-bytes",
      "1",
      "--vacuum-database",
    ]);

    expect(pruned.dryRun).toBe(false);
    expect(pruned.projectSnapshots.removedCount).toBeGreaterThanOrEqual(1);
    expect(pruned.projectSnapshots.failedCount).toBeGreaterThanOrEqual(1);
    expect(pruned.projectSnapshots.failedPaths.some((entry) => entry.path === failingSnapshot)).toBe(true);
    expect(pruned.runWorkspaces.removedCount).toBeGreaterThanOrEqual(1);
    expect(pruned.completedRuns.removedCount).toBeGreaterThanOrEqual(1);
    expect(pruned.serviceEnvelopes.removedCount).toBeGreaterThanOrEqual(1);
    expect(pruned.artifacts.removedCount).toBeGreaterThanOrEqual(1);
    expect(pruned.eventPayloads.garbageCollected).toBe(true);
    expect(pruned.runtimeCache.removedCount).toBeGreaterThanOrEqual(1);
    expect(pruned.daemonLog.truncated).toBe(true);
    expect(pruned.database.walCheckpointed).toBe(true);
    expect(pruned.database.vacuumed).toBe(true);
    await expect(fs.access(orphanSnapshot)).rejects.toThrow();
    await expect(fs.access(invalidDryRunSnapshot)).rejects.toThrow();
    await fs.access(freshSnapshot);
    await fs.chmod(failingSnapshotParent, 0o755);
    await fs.access(failingSnapshot);
    await expect(fs.access(staleWorkspace)).rejects.toThrow();
    await expect(fs.access(staleRuntimeCache)).rejects.toThrow();
    await expect(fs.access(orphanArtifact)).rejects.toThrow();
    expect(pruned.daemonLog.removedBytes).toBeGreaterThanOrEqual(128);

    const prunedDb = new Database(runtimeDbPath, { readonly: true });
    try {
      const publishCount = prunedDb
        .query<{ count: number }, [string]>("select count(*) as count from run_topic_publishes where caller_run_id = ?")
        .get(completedRun.run.id)?.count;
      const envelopeCount = prunedDb
        .query<{ count: number }, [string]>("select count(*) as count from service_envelopes where id = ?")
        .get(`env_${completedRun.run.id}`)?.count;
      const terminalEnvelopeCount = prunedDb
        .query<{ count: number }, [string]>("select count(*) as count from service_envelopes where id = ?")
        .get(`terminal_env_${completedRun.run.id}`)?.count;
      const unsafeChildCount = prunedDb
        .query<{ count: number }, [string]>("select count(*) as count from runs where id = ?")
        .get(unsafeChildRunId)?.count;
      const senderRunCount = prunedDb
        .query<{ count: number }, [string]>("select count(*) as count from runs where id = ?")
        .get(completedRun.run.id)?.count;
      const safeCompletedRunCount = prunedDb
        .query<{ count: number }, [string]>("select count(*) as count from runs where id = ?")
        .get(safeCompletedRunId)?.count;
      expect(publishCount).toBe(1);
      expect(envelopeCount).toBe(1);
      expect(terminalEnvelopeCount).toBe(0);
      expect(unsafeChildCount).toBe(1);
      expect(senderRunCount).toBe(1);
      expect(safeCompletedRunCount).toBe(0);
    } finally {
      prunedDb.close();
    }

    await fs.utimes(freshSnapshot, oldEnoughForPrune, oldEnoughForPrune);

    const zeroGracePruned = await harness.requestKernel("/v1/admin/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectSnapshotGraceSeconds: 0 }),
    });
    expect(zeroGracePruned.status).toBe(200);
    const zeroGraceBody = (await zeroGracePruned.json()) as typeof dryRun;
    expect(zeroGraceBody.projectSnapshots.graceSeconds).toBe(0);
    expect(zeroGraceBody.projectSnapshots.removedCount).toBeGreaterThanOrEqual(1);
    await expect(fs.access(freshSnapshot)).rejects.toThrow();

    const invalidPrune = await harness.requestKernel("/v1/admin/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runWorkspaceTtlSeconds: -1 }),
    });
    expect(invalidPrune.status).toBe(400);
    expect(await invalidPrune.json()).toMatchObject({
      ok: false,
      error: {
        code: "invalid_prune_option",
      },
    });
  } finally {
    if (failingSnapshotParent) {
      await fs.chmod(failingSnapshotParent, 0o755).catch(() => undefined);
    }
    await harness.dispose();
  }
});

test("configured auto prune bounds terminal service envelope history", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_PRUNE_SERVICE_ENVELOPE_TTL_SECONDS: "0",
      VILANO_PRUNE_INTERVAL_SECONDS: "1",
    },
  });

  try {
    const serviceKey = { sessionId: "auto-prune" };
    await harness.ensureService("demo/operator", serviceKey);
    const service = await harness.inspectService("demo/operator", serviceKey);
    const runtimeDbPath = path.join(harness.homeDir, "runtime.sqlite");
    const envelopeId = `auto_prune_env_${Date.now()}`;
    const oldEnoughForPrune = new Date(Date.now() - 60_000).toISOString();

    const db = new Database(runtimeDbPath);
    try {
      db.query(
        `
          insert into service_envelopes (
            id,
            service_run_id,
            kind,
            name,
            attempt,
            payload_json,
            correlation_id,
            sender_run_id,
            status,
            reply_json,
            error_json,
            wake_at,
            created_at,
            updated_at
          ) values (?, ?, 'ask', 'autoPrune', 1, '{}', null, null, 'completed', '{}', null, null, ?, ?)
        `
      ).run(envelopeId, service.run.id, oldEnoughForPrune, oldEnoughForPrune);
    } finally {
      db.close();
    }

    let removed = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(750);
      const checkDb = new Database(runtimeDbPath, { readonly: true });
      try {
        const count = checkDb
          .query<{ count: number }, [string]>("select count(*) as count from service_envelopes where id = ?")
          .get(envelopeId)?.count;
        if (count === 0) {
          removed = true;
          break;
        }
      } finally {
        checkDb.close();
      }
    }

    expect(removed).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("invalid auto prune env does not fall through to default cleanup", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_PRUNE_ARTIFACT_GRACE_SECONDS: "not-a-number",
      VILANO_PRUNE_INTERVAL_SECONDS: "1",
    },
  });

  try {
    const storage = await harness.runCliJson<{
      ok: true;
      roots: { artifactHomeDir: string };
    }>(["daemon", "storage"]);
    const orphanArtifact = path.join(
      storage.roots.artifactHomeDir,
      "runs",
      "run_invalid_auto_prune",
      "execs",
      "orphan",
      "attempt-1",
      "stdout.txt"
    );
    const oldEnoughForPrune = new Date(Date.now() - 10 * 60 * 1000);

    await fs.mkdir(path.dirname(orphanArtifact), { recursive: true });
    await fs.writeFile(orphanArtifact, "keep\n", "utf8");
    await fs.utimes(orphanArtifact, oldEnoughForPrune, oldEnoughForPrune);
    await sleep(1_500);

    await fs.access(orphanArtifact);
  } finally {
    await harness.dispose();
  }
});

test("project purge-runtime clears persisted runs and service state for one project", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const serviceKey = { sessionId: "purge-runtime" };
    await harness.ensureService("demo/operator", serviceKey);
    const service = await harness.inspectService("demo/operator", serviceKey);

    const run = await harness.startWorkflow("demo/planner", { topic: "purge-runtime" });
    await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed");

    const db = new Database(path.join(harness.homeDir, "runtime.sqlite"));
    try {
      db.query(
        `
          insert into topic_subscriptions (
            topic,
            service_run_id,
            signal_name,
            created_at,
            updated_at
          ) values ('purge-topic', ?, 'purgeSignal', ?, ?)
        `
      ).run(service.run.id, new Date().toISOString(), new Date().toISOString());

      db.query(
        `
          insert into run_topic_publishes (
            caller_run_id,
            op_key,
            publish_id,
            topic,
            payload_json,
            matched_count,
            enqueued_count,
            rejected_count,
            created_at,
            updated_at
          ) values (?, 'purge-publish', ?, 'purge-topic', '{}', 1, 1, 0, ?, ?)
        `
      ).run(run.run.id, `purge:${run.run.id}`, new Date().toISOString(), new Date().toISOString());

      db.query(
        `
          insert into service_envelopes (
            id,
            service_run_id,
            kind,
            name,
            attempt,
            payload_json,
            correlation_id,
            sender_run_id,
            status,
            reply_json,
            error_json,
            wake_at,
            created_at,
            updated_at
          ) values (?, 'run_external_service', 'signal', 'purgeExternal', 1, '{}', null, ?, 'completed', null, null, null, ?, ?)
        `
      ).run(
        `purge_external_env_${run.run.id}`,
        run.run.id,
        new Date().toISOString(),
        new Date().toISOString()
      );
    } finally {
      db.close();
    }

    const purged = await harness.runCliJson<{
      ok: true;
      project: string;
      purgedRunCount: number;
      purgedServiceRunCount: number;
      purgedEnvelopeCount: number;
      killedManagedWorkerIds: string[];
      purgedAt: string;
    }>(["project", "purge-runtime", "demo"]);

    expect(purged.ok).toBe(true);
    expect(purged.project).toBe("demo");
    expect(purged.purgedRunCount).toBeGreaterThan(0);
    expect(purged.purgedServiceRunCount).toBeGreaterThan(0);
    expect(purged.purgedEnvelopeCount).toBeGreaterThanOrEqual(1);

    const runsResponse = await harness.requestKernel("/v1/runs?project=demo");
    expect(runsResponse.status).toBe(200);
    const runsBody = (await runsResponse.json()) as { ok: true; runs: Array<unknown> };
    expect(runsBody.runs).toHaveLength(0);

    const serviceRunsResponse = await harness.requestKernel("/v1/service-runs?project=demo");
    expect(serviceRunsResponse.status).toBe(200);
    const serviceRunsBody = (await serviceRunsResponse.json()) as { ok: true; runs: Array<unknown> };
    expect(serviceRunsBody.runs).toHaveLength(0);

    const purgedDb = new Database(path.join(harness.homeDir, "runtime.sqlite"), { readonly: true });
    try {
      const subscriptionCount = purgedDb
        .query<{ count: number }, [string]>("select count(*) as count from topic_subscriptions where service_run_id = ?")
        .get(service.run.id)?.count;
      const publishCount = purgedDb
        .query<{ count: number }, [string]>("select count(*) as count from run_topic_publishes where caller_run_id = ?")
        .get(run.run.id)?.count;
      const externalEnvelopeCount = purgedDb
        .query<{ count: number }, [string]>("select count(*) as count from service_envelopes where sender_run_id = ?")
        .get(run.run.id)?.count;

      expect(subscriptionCount).toBe(0);
      expect(publishCount).toBe(0);
      expect(externalEnvelopeCount).toBe(0);
    } finally {
      purgedDb.close();
    }

    const fresh = await harness.startWorkflow("demo/planner", { topic: "post-purge-runtime" });
    const freshInspect = await harness.waitForRun(
      fresh.run.id,
      (inspect) => inspect.run.status === "completed"
    );
    expect(freshInspect.run.status).toBe("completed");
  } finally {
    await harness.dispose();
  }
});

test("worker tokens cannot access daemon-only routes", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/planner", { topic: "worker-auth" });
    const daemonState = JSON.parse(
      await Bun.file(`${harness.homeDir}/daemon-auth.json`).text()
    ) as { workerAuthToken?: string };
    const headers = new Headers();
    if (daemonState.workerAuthToken) {
      headers.set("x-vilano-token", daemonState.workerAuthToken);
      headers.set("content-type", "application/json");
    }

    const response = await fetch(`${harness.serverUrl}/v1/projects`, {
      headers,
    });

    expect(response.status).toBe(401);

    const runInspect = await fetch(
      `${harness.serverUrl}/v1/runs/${encodeURIComponent(run.run.id)}`,
      {
        headers,
      }
    );
    expect(runInspect.status).toBe(401);

    const runSignal = await fetch(
      `${harness.serverUrl}/v1/runs/${encodeURIComponent(run.run.id)}/signals`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "continue",
          payload: { source: "worker-token" },
        }),
      }
    );
    expect(runSignal.status).toBe(401);
  } finally {
    await harness.dispose();
  }
});

test("daemon state keeps operator credentials out of daemon.json", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const daemonState = JSON.parse(
      await Bun.file(`${harness.homeDir}/daemon.json`).text()
    ) as Record<string, unknown>;
    const daemonAuthState = JSON.parse(
      await Bun.file(`${harness.homeDir}/daemon-auth.json`).text()
    ) as Record<string, unknown>;

    expect(daemonState.authToken).toBeUndefined();
    expect(daemonState.workerAuthToken).toBeUndefined();
    expect(typeof daemonAuthState.authToken).toBe("string");
    expect(typeof daemonAuthState.workerAuthToken).toBe("string");
  } finally {
    await harness.dispose();
  }
});

test("worker runtime does not expose daemon or worker tokens to workflow code", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/workerEnvProbe", {});
    const completed = await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed");

    expect(completed.run.output).toEqual({
      workerTokenPresent: false,
      daemonTokenPresent: false,
      runtimeHomePresent: false,
      workerHomePresent: false,
      internalRuntimeHomePresent: false,
    });
  } finally {
    await harness.dispose();
  }
});

test("worker loads fresh modules for each activation", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const first = await harness.startWorkflow("demo/moduleStateProbe", {});
    const firstCompleted = await harness.waitForRun(first.run.id, (inspect) => inspect.run.status === "completed");
    expect(firstCompleted.run.output).toEqual({ count: 1 });

    const second = await harness.startWorkflow("demo/moduleStateProbe", {});
    const secondCompleted = await harness.waitForRun(second.run.id, (inspect) => inspect.run.status === "completed");
    expect(secondCompleted.run.output).toEqual({ count: 1 });
  } finally {
    await harness.dispose();
  }
});

test("managed workers run each activation in a fresh JS process", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const first = await harness.startWorkflow("demo/workerPidProbe", {});
    const firstCompleted = await harness.waitForRun(first.run.id, (inspect) => inspect.run.status === "completed");
    const second = await harness.startWorkflow("demo/workerPidProbe", {});
    const secondCompleted = await harness.waitForRun(second.run.id, (inspect) => inspect.run.status === "completed");

    expect(firstCompleted.run.output).toBeTruthy();
    expect(secondCompleted.run.output).toBeTruthy();
    expect((firstCompleted.run.output as { pid: number }).pid).not.toBe(
      (secondCompleted.run.output as { pid: number }).pid
    );
  } finally {
    await harness.dispose();
  }
});

test("per-activation workers exit after workflows leave lingering event-loop handles", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const first = await harness.startWorkflow("demo/lingeringHandleProbe", {});
    const firstCompleted = await harness.waitForRun(first.run.id, (inspect) => inspect.run.status === "completed");

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

test("parents can resume and spawn followup children after a child leaves lingering handles", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/childFollowupProbe", {});
    const completed = await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed", 10_000);
    const output = completed.run.output as { first: { pid: number }; second: { pid: number } };

    expect(output.first.pid).toBeTruthy();
    expect(output.second.pid).toBeTruthy();
    expect(output.first.pid).not.toBe(output.second.pid);
  } finally {
    await harness.dispose();
  }
});

test("activations execute from writable workspaces while snapshots stay read-only", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/snapshotIsolationProbe", {});
    const completed = await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed");
    const output = completed.run.output as {
      cwd: string;
      workspaceMarkerPresent: boolean;
      snapshotWritable: boolean;
      snapshotWriteErrorCode: string | null;
      dependencyWritable: boolean;
      dependencyWriteErrorCode: string | null;
      workspaceNodeModulesSymlink: boolean;
      workspaceNodeModulesRealPath: string | null;
    };

    expect(output.workspaceMarkerPresent).toBe(true);
    expect(output.snapshotWritable).toBe(false);
    expect(output.snapshotWriteErrorCode).toBeTruthy();
    expect(output.dependencyWritable).toBe(false);
    expect(output.dependencyWriteErrorCode).toBeTruthy();
    expect(output.workspaceNodeModulesSymlink).toBe(true);
    expect(output.workspaceNodeModulesRealPath).toBeTruthy();
    expect(output.workspaceNodeModulesRealPath).toBe(
      await fs.realpath(path.join(completed.run.projectSnapshotPath ?? "", "node_modules"))
    );
    expect(output.cwd).not.toBe(completed.run.projectSnapshotPath);
    expect(await waitForPathMissing(path.join(output.cwd, "tmp", "workspace-marker.txt"), 5_000)).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("runs resume into a fresh workspace after durable suspension", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/activationWorkspaceProbe", {});
    const completed = await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed");
    const output = completed.run.output as {
      firstCwd: string;
      secondCwd: string;
      markerPresentAfterResume: boolean;
    };

    expect(output.firstCwd).not.toBe(output.secondCwd);
    expect(output.markerPresentAfterResume).toBe(false);
  } finally {
    await harness.dispose();
  }
});

test("kernel rejects persisted project definitions that escape the snapshot root", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const projectDir = await fs.mkdtemp(path.join(harness.homeDir, "kernel-project-"));
    const outsideFile = path.join(harness.homeDir, "outside-definition.ts");
    await fs.writeFile(outsideFile, "export const escape = workflow({ name: 'escape', run: async () => ({ ok: true }) });\n");

    const response = await harness.requestKernel("/v1/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        name: "kernel-validation",
        path: projectDir,
        snapshotPath: projectDir,
        definitions: {
          workflows: [
            {
              kind: "workflow",
              name: "escape",
              exportName: "escape",
              file: "../outside-definition.ts",
              runtimeKind: "javascript",
              sourceLanguage: "typescript",
            },
          ],
          services: [],
        },
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: false; error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_project");
    expect(body.error.message).toContain("snapshot root");
  } finally {
    await harness.dispose();
  }
});

test("explicit manifests fail registration when declared exports do not resolve", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const projectDir = await fs.mkdtemp(path.join(harness.homeDir, "manifest-project-"));
    await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "src", "definitions.ts"),
      [
        "export const actualWorkflow = {",
        "  kind: 'workflow',",
        "  name: 'actualWorkflow',",
        "  run: async () => ({ ok: true }),",
        "};",
        "",
      ].join("\n")
    );
    await fs.writeFile(
      path.join(projectDir, "vilano.manifest.json"),
      `${JSON.stringify(
        {
          manifestVersion: 1,
          definitions: {
            workflows: [
              {
                kind: "workflow",
                name: "declaredWorkflow",
                exportName: "missingWorkflow",
                file: "src/definitions.ts",
                runtimeKind: "javascript",
                sourceLanguage: "typescript",
              },
            ],
            services: [],
          },
        },
        null,
        2
      )}\n`
    );

    const result = await harness.spawnCliCommand([
      "project",
      "add",
      projectDir,
      "--name",
      "bad-manifest",
    ]).wait();

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Project registration failed definition validation"
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain("missingWorkflow");
  } finally {
    await harness.dispose();
  }
});

test("lease-scoped child status and signals work inside workflow execution", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/childSignalCoordinator", { token: "lease-child" });
    const completed = await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed");
    const output = completed.run.output as {
      initialStatus: string;
      child: { token: string };
    };

    expect(["pending", "running", "waiting", "completed"]).toContain(output.initialStatus);
    expect(output.child).toEqual({ token: "lease-child" });
  } finally {
    await harness.dispose();
  }
});

test("lease-scoped service status works through connected service refs", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/serviceStatusCoordinator", {
      sessionId: "service-status",
    });
    const completed = await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "completed");
    const output = completed.run.output as {
      status: string;
      serviceRunId: string;
    };

    expect(["idle", "active", "waiting"]).toContain(output.status);
    expect(typeof output.serviceRunId).toBe("string");

    const operatorInspect = await harness.inspectService("demo/operator", { sessionId: "service-status" });
    expect(operatorInspect.run.id).toBe(output.serviceRunId);
  } finally {
    await harness.dispose();
  }
});

test("historical runs without pinned snapshots fail safely on resume", async () => {
  const harness = await RuntimeHarness.create({
    env: {
      VILANO_MANAGED_WORKERS: "0",
    },
  });

  const db = new Database(`${harness.homeDir}/runtime.sqlite`);

  try {
    const run = await harness.startWorkflow("demo/planner", { topic: "legacy-run" });

    db.query(
      `
        update runs
        set project_snapshot_path = null,
            project_definitions_json = null,
            definition_file = null,
            definition_export_name = null,
            definition_runtime_kind = null,
            definition_source_language = null
        where id = ?
      `
    ).run(run.run.id);

    const worker = await harness.spawnWorker({ once: true, workerId: "legacy-run-worker" });
    const workerResult = await worker.wait();
    expect(workerResult.exitCode).toBe(0);

    const failed = await harness.waitForRun(run.run.id, (inspect) => inspect.run.status === "failed");
    expect(failed.run.error).toMatchObject({
      reason: "missing_pinned_definition",
    });
  } finally {
    db.close();
    await harness.dispose();
  }
});

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }

    await sleep(100);
  }

  return !isProcessAlive(pid);
}

async function listProcessesContaining(fragment: string): Promise<string[]> {
  const proc = Bun.spawn(["ps", "-axo", "command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(fragment));
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await fn()) {
      return true;
    }

    await sleep(100);
  }

  return await fn();
}

async function waitForPathMissing(targetPath: string, timeoutMs: number): Promise<boolean> {
  return await waitFor(async () => {
    try {
      await fs.access(targetPath);
      return false;
    } catch {
      return true;
    }
  }, timeoutMs);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}
