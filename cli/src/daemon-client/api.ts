import type {
  DaemonStatusResponse,
  DefinitionInspectResponse,
  DefinitionListResponse,
  ProjectListResponse,
  ProjectPurgeRuntimeResponse,
  ProjectResponse,
  ProjectRecord,
  RunCancelResponse,
  RunInspectResponse,
  RunListResponse,
  RunReplayResponse,
  RunStartResponse,
  RuntimeDebugResponse,
  RuntimeStorageResponse,
  ServiceEnsureResponse,
  ServiceEnvelopeResponse,
  ServiceMutationResponse,
  ServiceRunListResponse,
  ServiceStopResponse,
  SignalSendResponse,
} from "../types.ts";
import { assertCompatibleKernelStatus } from "./common.ts";
import type { RequestOptions } from "./common.ts";
import { requestJsonWithState } from "./control.ts";
import { ensureDaemonStarted } from "./process.ts";
import {
  clearDaemonStateFiles,
  isProcessAlive,
  readDaemonAuthState,
  readDaemonState,
} from "./state.ts";

export async function getRuntimeDebug(): Promise<RuntimeDebugResponse> {
  return requestJson<RuntimeDebugResponse>({
    method: "GET",
    pathname: "/v1/admin/runtime-debug",
    autoStart: false,
  });
}

export async function getRuntimeStorage(): Promise<RuntimeStorageResponse> {
  return requestJson<RuntimeStorageResponse>({
    method: "GET",
    pathname: "/v1/admin/storage",
    autoStart: false,
  });
}

export async function listProjects(
  options: { autoStart?: boolean } = {}
): Promise<ProjectListResponse> {
  return requestJson<ProjectListResponse>({
    method: "GET",
    pathname: "/v1/projects",
    autoStart: options.autoStart ?? false,
  });
}

export async function addProject(project: ProjectRecord): Promise<ProjectResponse> {
  return requestJson<ProjectResponse>({
    method: "POST",
    pathname: "/v1/projects",
    body: project,
    autoStart: true,
  });
}

export async function inspectProject(name: string): Promise<ProjectResponse> {
  return requestJson<ProjectResponse>({
    method: "GET",
    pathname: `/v1/projects/${encodeURIComponent(name)}`,
    autoStart: false,
  });
}

export async function syncProject(project: ProjectRecord): Promise<ProjectResponse> {
  return requestJson<ProjectResponse>({
    method: "POST",
    pathname: `/v1/projects/${encodeURIComponent(project.name)}/sync`,
    body: project,
    autoStart: true,
  });
}

export async function removeProject(name: string): Promise<ProjectResponse> {
  return requestJson<ProjectResponse>({
    method: "DELETE",
    pathname: `/v1/projects/${encodeURIComponent(name)}`,
    autoStart: true,
  });
}

export async function purgeProjectRuntime(
  name: string
): Promise<ProjectPurgeRuntimeResponse> {
  return requestJson<ProjectPurgeRuntimeResponse>({
    method: "POST",
    pathname: `/v1/projects/${encodeURIComponent(name)}/purge-runtime`,
    autoStart: true,
  });
}

export async function listReferencedProjectSnapshots(
  project?: string
): Promise<{ ok: true; project: string | null; snapshotPaths: string[] }> {
  const query = project ? `?project=${encodeURIComponent(project)}` : "";
  return requestJson<{ ok: true; project: string | null; snapshotPaths: string[] }>({
    method: "GET",
    pathname: `/v1/admin/project-snapshots${query}`,
    autoStart: false,
  });
}

export async function listDefinitions(
  kind: "workflow" | "service",
  project?: string,
  options: { autoStart?: boolean } = {}
): Promise<DefinitionListResponse> {
  const query = project ? `?project=${encodeURIComponent(project)}` : "";
  const pathname = kind === "workflow" ? `/v1/workflows${query}` : `/v1/services${query}`;

  return requestJson<DefinitionListResponse>({
    method: "GET",
    pathname,
    autoStart: options.autoStart ?? false,
  });
}

export async function inspectWorkflowDefinition(
  project: string,
  name: string
): Promise<DefinitionInspectResponse> {
  return requestJson<DefinitionInspectResponse>({
    method: "GET",
    pathname: `/v1/workflows/${encodeURIComponent(project)}/${encodeURIComponent(name)}`,
    autoStart: false,
  });
}

export async function startWorkflowRun(
  project: string,
  workflow: string,
  input: unknown
): Promise<RunStartResponse> {
  return requestJson<RunStartResponse>({
    method: "POST",
    pathname: "/v1/runs",
    body: {
      project,
      workflow,
      input,
    },
    autoStart: true,
  });
}

export async function listRuns(project?: string): Promise<RunListResponse> {
  const query = project ? `?project=${encodeURIComponent(project)}` : "";
  return requestJson<RunListResponse>({
    method: "GET",
    pathname: `/v1/runs${query}`,
    autoStart: false,
  });
}

export async function inspectRun(runId: string): Promise<RunInspectResponse> {
  return requestJson<RunInspectResponse>({
    method: "GET",
    pathname: `/v1/runs/${encodeURIComponent(runId)}`,
    autoStart: false,
  });
}

export async function replayRun(runId: string): Promise<RunReplayResponse> {
  return requestJson<RunReplayResponse>({
    method: "GET",
    pathname: `/v1/runs/${encodeURIComponent(runId)}/replay`,
    autoStart: false,
  });
}

export async function cancelRun(runId: string): Promise<RunCancelResponse> {
  return requestJson<RunCancelResponse>({
    method: "POST",
    pathname: `/v1/runs/${encodeURIComponent(runId)}/cancel`,
    autoStart: true,
  });
}

export async function ensureServiceRun(
  project: string,
  service: string,
  serviceKey: string,
  keyInput: unknown
): Promise<ServiceEnsureResponse> {
  return requestJson<ServiceEnsureResponse>({
    method: "POST",
    pathname: "/v1/services/ensure",
    body: {
      project,
      service,
      serviceKey,
      keyInput,
    },
    autoStart: true,
  });
}

export async function inspectServiceRun(
  project: string,
  service: string,
  serviceKey: string
): Promise<RunInspectResponse> {
  return requestJson<RunInspectResponse>({
    method: "GET",
    pathname: `/v1/services/${encodeURIComponent(project)}/${encodeURIComponent(
      service
    )}/runs/${encodeURIComponent(serviceKey)}`,
    autoStart: false,
  });
}

export async function listServiceRuns(
  project?: string,
  activeOnly = false,
  options: { autoStart?: boolean } = {}
): Promise<ServiceRunListResponse> {
  const params = new URLSearchParams();
  if (project) {
    params.set("project", project);
  }

  if (activeOnly) {
    params.set("active", "true");
  }

  const query = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson<ServiceRunListResponse>({
    method: "GET",
    pathname: `/v1/service-runs${query}`,
    autoStart: options.autoStart ?? false,
  });
}

export async function inspectServiceEnvelope(
  envelopeId: string
): Promise<ServiceEnvelopeResponse> {
  return requestJson<ServiceEnvelopeResponse>({
    method: "GET",
    pathname: `/v1/service-envelopes/${encodeURIComponent(envelopeId)}`,
    autoStart: false,
  });
}

export async function sendServiceMessage(
  project: string,
  service: string,
  serviceKey: string,
  keyInput: unknown,
  message: string,
  payload: unknown
): Promise<ServiceMutationResponse> {
  return requestJson<ServiceMutationResponse>({
    method: "POST",
    pathname: `/v1/services/${encodeURIComponent(project)}/${encodeURIComponent(
      service
    )}/runs/${encodeURIComponent(serviceKey)}/send`,
    body: {
      keyInput,
      message,
      payload,
    },
    autoStart: true,
  });
}

export async function sendServiceSignal(
  project: string,
  service: string,
  serviceKey: string,
  keyInput: unknown,
  signal: string,
  payload: unknown
): Promise<ServiceMutationResponse> {
  return requestJson<ServiceMutationResponse>({
    method: "POST",
    pathname: `/v1/services/${encodeURIComponent(project)}/${encodeURIComponent(
      service
    )}/runs/${encodeURIComponent(serviceKey)}/signal`,
    body: {
      keyInput,
      signal,
      payload,
    },
    autoStart: true,
  });
}

export async function askService(
  project: string,
  service: string,
  serviceKey: string,
  keyInput: unknown,
  message: string,
  payload: unknown
): Promise<ServiceMutationResponse> {
  return requestJson<ServiceMutationResponse>({
    method: "POST",
    pathname: `/v1/services/${encodeURIComponent(project)}/${encodeURIComponent(
      service
    )}/runs/${encodeURIComponent(serviceKey)}/ask`,
    body: {
      keyInput,
      message,
      payload,
    },
    autoStart: true,
  });
}

export async function stopServiceRun(
  project: string,
  service: string,
  serviceKey: string
): Promise<ServiceStopResponse> {
  return requestJson<ServiceStopResponse>({
    method: "POST",
    pathname: `/v1/services/${encodeURIComponent(project)}/${encodeURIComponent(
      service
    )}/runs/${encodeURIComponent(serviceKey)}/stop`,
    autoStart: true,
  });
}

export async function sendRunSignal(
  runId: string,
  name: string,
  payload: unknown
): Promise<SignalSendResponse> {
  return requestJson<SignalSendResponse>({
    method: "POST",
    pathname: `/v1/runs/${encodeURIComponent(runId)}/signals`,
    body: {
      name,
      payload,
    },
    autoStart: true,
  });
}

async function requestJson<T>({
  method,
  pathname,
  body,
  autoStart = true,
}: RequestOptions): Promise<T> {
  let daemonState = await readDaemonState();
  let daemonAuthState = await readDaemonAuthState();

  if ((!daemonState || !daemonAuthState) && autoStart) {
    const status = await ensureDaemonStarted();
    assertCompatibleKernelStatus(status);
    daemonState = await readDaemonState();
    daemonAuthState = await readDaemonAuthState();
  }

  if (!daemonState || !daemonAuthState) {
    throw new Error("Vilano Runtime kernel is not running");
  }

  if (!(await isProcessAlive(daemonState.pid))) {
    await clearDaemonStateFiles();

    if (autoStart) {
      const status = await ensureDaemonStarted();
      assertCompatibleKernelStatus(status);
      daemonState = await readDaemonState();
      daemonAuthState = await readDaemonAuthState();
    }
  }

  if (!daemonState || !daemonAuthState) {
    throw new Error("Vilano Runtime kernel state is missing from VILANO_HOME");
  }

  if (typeof daemonState.protocolVersion === "number") {
    assertCompatibleKernelStatus({
      protocolVersion: daemonState.protocolVersion,
      runtimeVersion: daemonState.runtimeVersion ?? "unknown",
    });
  }

  return requestJsonWithState<T>(
    {
      port: daemonState.port,
      authToken: daemonAuthState.authToken,
    },
    { method, pathname, body, autoStart }
  );
}
