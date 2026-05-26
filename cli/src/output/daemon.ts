import type {
  DaemonStatusResponse,
  RuntimeDebugResponse,
  RuntimeStorageResponse,
} from "../types.ts";

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

export function renderDaemonStorage(body: RuntimeStorageResponse): string {
  const paths = [...body.paths].sort((left, right) => right.bytes - left.bytes);

  return [
    "Vilano Runtime storage",
    "paths:",
    ...paths.map(
      (entry) =>
        `  ${entry.name}: ${formatBytes(entry.bytes)} files=${entry.files} dirs=${entry.directories} exists=${entry.exists} path=${entry.path}${entry.error ? ` error=${entry.error}` : ""}`
    ),
    "database:",
    `  projects: ${body.database.projects}`,
    `  runs: ${body.database.runs}`,
    `  run_events: count=${body.database.runEvents.count} body_json=${formatBytes(body.database.runEvents.bytes)}`,
    `  event_payload_refs: count=${body.database.eventPayloadRefs.count} payload_bytes=${formatBytes(body.database.eventPayloadRefs.bytes)}`,
    `  service_states: count=${body.database.serviceStates.count} state_json=${formatBytes(body.database.serviceStates.bytes)}`,
    `  service_envelopes: count=${body.database.serviceEnvelopes.count} payload_json=${formatBytes(body.database.serviceEnvelopes.bytes)}`,
    `  run_execs: count=${body.database.runExecs.count} metadata_json=${formatBytes(body.database.runExecs.bytes)}`,
  ].join("\n");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}
