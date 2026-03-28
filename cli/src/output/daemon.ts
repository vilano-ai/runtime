import type { DaemonStatusResponse, RuntimeDebugResponse } from "../types.ts";

export function renderDaemonStatus(body: DaemonStatusResponse): string {
  return [
    "Vilano Runtime kernel is running",
    `runtime_version: ${body.runtimeVersion}`,
    `protocol_version: ${body.protocolVersion}`,
    `schema_version: ${body.schemaVersion}`,
    `pid: ${body.pid}`,
    `port: ${body.port}`,
    `started_at: ${body.startedAt}`,
    `managed_workers: ${body.managedWorkerCount}`,
    `managed_worker_runtime: ${body.managedWorkerRuntime}`,
    `lease_duration_seconds: ${body.leaseDurationSeconds}`,
    `projects: ${body.projectCount}`,
  ].join("\n");
}

export function renderDaemonDebug(body: RuntimeDebugResponse): string {
  const profileEntries = Object.entries(body.busyRetries.profiles).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const recentExhausted = body.busyRetries.recentExhausted.slice(0, 5);
  const activeLeases = body.activeLeases.slice(0, 10);
  const managedWorkers = body.managedWorkers.slice(0, 10);

  return [
    "Vilano Runtime debug snapshot",
    `active_leases: ${body.activeLeases.length}`,
    `active_timed_steps: ${body.activeTimedSteps.length}`,
    `managed_workers: ${body.managedWorkers.length}`,
    "busy_retries:",
    ...(profileEntries.length > 0
      ? profileEntries.map(
          ([name, entry]) =>
            `  ${name}: retries=${entry.retries} exhausted=${entry.exhausted}${entry.lastReason ? ` last_reason=${entry.lastReason}` : ""}${entry.lastDelayMs !== null ? ` last_delay_ms=${entry.lastDelayMs}` : ""}`
        )
      : ["  none"]),
    ...(recentExhausted.length > 0
      ? [
          "recent_exhausted:",
          ...recentExhausted.map(
            (entry) => `  ${entry.at} profile=${entry.profile} reason=${entry.reason}`
          ),
        ]
      : []),
    "run_status_counts:",
    ...(body.runStatusCounts.length > 0
      ? body.runStatusCounts.map((entry) => `  ${entry.status}: ${entry.count}`)
      : ["  none"]),
    "managed_worker_leases:",
    ...(managedWorkers.length > 0
      ? managedWorkers.map(
          (worker) =>
            `  ${worker.workerId}: active_leases=${worker.activeLeaseCount}${
              worker.leases[0]
                ? ` first_run=${worker.leases[0].runId} first_definition=${worker.leases[0].definitionName}`
                : ""
            }`
        )
      : ["  none"]),
    "lease_queue:",
    body.leaseQueue.workflowHead
      ? `  workflow_head: run=${body.leaseQueue.workflowHead.id} project=${body.leaseQueue.workflowHead.project} definition=${body.leaseQueue.workflowHead.definitionName} status=${body.leaseQueue.workflowHead.status} created=${body.leaseQueue.workflowHead.createdAt}`
      : "  workflow_head: none",
    body.leaseQueue.serviceTurnHead
      ? `  service_turn_head: run=${body.leaseQueue.serviceTurnHead.runId} project=${body.leaseQueue.serviceTurnHead.project} definition=${body.leaseQueue.serviceTurnHead.definitionName} service_key=${body.leaseQueue.serviceTurnHead.serviceKey} envelope=${body.leaseQueue.serviceTurnHead.envelopeId} status=${body.leaseQueue.serviceTurnHead.status} created=${body.leaseQueue.serviceTurnHead.createdAt}`
      : "  service_turn_head: none",
    "pending_runs_by_project:",
    ...(body.leaseQueue.pendingByProject.length > 0
      ? body.leaseQueue.pendingByProject.map(
          (entry) => `  ${entry.project}: ${entry.count}`
        )
      : ["  none"]),
    "oldest_pending_runs:",
    ...(body.leaseQueue.oldestPendingRuns.length > 0
      ? body.leaseQueue.oldestPendingRuns.slice(0, 5).map(
          (run) =>
            `  ${run.id} project=${run.project} definition=${run.definitionName} status=${run.status} created=${run.createdAt}`
        )
      : ["  none"]),
    "active_lease_detail:",
    ...(activeLeases.length > 0
      ? activeLeases.map(
          (lease) =>
            `  ${lease.leaseWorkerId ?? "unknown"} run=${lease.runId} definition=${lease.definitionName} status=${lease.status} expires=${lease.leaseExpiresAt}`
        )
      : ["  none"]),
  ].join("\n");
}
