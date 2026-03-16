import type { RunRecord } from "../types.ts";

export function renderRun(run: RunRecord): string {
  const lines = [
    `run: ${run.id}`,
    `project: ${run.project}`,
    `kind: ${run.definitionKind}`,
    `definition: ${run.definitionName}`,
    `status: ${run.status}`,
    `created_at: ${run.createdAt}`,
    `updated_at: ${run.updatedAt}`,
    `input: ${JSON.stringify(run.input)}`,
  ];

  if (run.serviceKey) {
    lines.push(`service_key: ${run.serviceKey}`);
  }

  if (run.state !== undefined) {
    lines.push(`state: ${JSON.stringify(run.state)}`);
  }

  if (run.passivation) {
    lines.push(`passivation_state: ${run.passivation.state}`);

    if (run.passivation.reason) {
      lines.push(`passivation_reason: ${run.passivation.reason}`);
    }

    if (run.passivation.wakeReason) {
      lines.push(`wake_reason: ${run.passivation.wakeReason}`);
    }

    if (Array.isArray(run.passivation.wakeOn)) {
      lines.push(`wake_on: ${run.passivation.wakeOn.join(",") || "none"}`);
    }

    if (typeof run.passivation.queuedMessages === "number") {
      lines.push(`queued_messages: ${run.passivation.queuedMessages}`);
    }

    if (run.passivation.nextWakeAt) {
      lines.push(`next_wake_at: ${run.passivation.nextWakeAt}`);
    }
  }

  return lines.join("\n");
}

export function renderRunList(project: string | null, runs: RunRecord[]): string {
  if (runs.length === 0) {
    return project ? `No runs found in project ${project}.` : "No runs found.";
  }

  const header = project ? `runs in ${project}` : "runs";
  return [
    header,
    ...runs.map(
      (run) =>
        `${run.id}\t${run.project}/${run.definitionName}\tstatus=${run.status}\tcreated_at=${run.createdAt}`
    ),
  ].join("\n");
}

export function renderServiceRunList(
  project: string | null,
  activeOnly: boolean,
  runs: RunRecord[]
): string {
  if (runs.length === 0) {
    if (project) {
      return activeOnly
        ? `No active service instances found in project ${project}.`
        : `No service instances found in project ${project}.`;
    }

    return activeOnly ? "No active service instances found." : "No service instances found.";
  }

  const header = project
    ? activeOnly
      ? `active service instances in ${project}`
      : `service instances in ${project}`
    : activeOnly
      ? "active service instances"
      : "service instances";

  return [
    header,
    ...runs.map(
      (run) =>
        `${run.id}\t${run.project}/${run.definitionName}\tservice_key=${run.serviceKey ?? "unknown"}\tstatus=${run.status}${run.passivation ? `\tpassivation=${run.passivation.state}` : ""}\tupdated_at=${run.updatedAt}`
    ),
  ].join("\n");
}
