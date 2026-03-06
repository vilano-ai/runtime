import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ensureDir, readJsonFile, writeJsonFileAtomic } from "./json-file.ts";
import { getRuntimePaths } from "./runtime-home.ts";
import type {
  DaemonState,
  DaemonStatusResponse,
  DefinitionInspectResponse,
  DefinitionListResponse,
  ErrorResponse,
  ProjectListResponse,
  ProjectResponse,
  ProjectRecord,
  ServiceEnsureResponse,
  ServiceEnvelopeResponse,
  ServiceMutationResponse,
  ServiceRunListResponse,
  ServiceStopResponse,
  RunInspectResponse,
  RunListResponse,
  RunStartResponse,
  SignalSendResponse,
} from "./types.ts";

interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  pathname: string;
  body?: unknown;
  autoStart?: boolean;
}

interface KernelStatusBody {
  ok: true;
  port: number;
  startedAt: string;
  runtimeDbPath: string;
  projectCount: number;
}

export async function ensureDaemonStarted(port = 4141): Promise<DaemonStatusResponse> {
  const status = await getRunningDaemonStatus();
  if (status) {
    return status;
  }

  const runtimePaths = getRuntimePaths();
  await ensureDir(runtimePaths.homeDir);

  const kernelDir = path.resolve(import.meta.dir, "..", "..", "kernel");
  const projectRoot = path.resolve(import.meta.dir, "..", "..");
  const child = spawn("mix", ["run", "--no-halt"], {
    cwd: kernelDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      VILANO_HOME: runtimePaths.homeDir,
      VILANO_KERNEL_PORT: String(port),
      VILANO_ROOT: projectRoot,
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(
          new Error("Failed to start the Vilano kernel because 'mix' was not found. Install Elixir 1.17+ and ensure `mix` is on your PATH.")
        );
        return;
      }

      reject(error);
    });
  });

  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const kernelStatus = await pingKernelStatus(port);
    if (kernelStatus) {
      const daemonState: DaemonState = {
        version: 1,
        pid: child.pid ?? 0,
        port,
        startedAt: kernelStatus.startedAt,
        runtimeDbPath: kernelStatus.runtimeDbPath,
      };

      await writeJsonFileAtomic(runtimePaths.daemonStateFile, daemonState);
      return toDaemonStatus(daemonState, kernelStatus);
    }

    await sleep(150);
  }

  throw new Error("Timed out waiting for the Vilano kernel to start");
}

export async function stopDaemon(): Promise<DaemonStatusResponse | null> {
  const runtimePaths = getRuntimePaths();
  const daemonState = await readJsonFile<DaemonState | null>(runtimePaths.daemonStateFile, null);

  if (!daemonState) {
    return null;
  }

  try {
    process.kill(daemonState.pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const running = await pingKernelStatus(daemonState.port);
    if (!running) {
      await fs.rm(runtimePaths.daemonStateFile, { force: true });
      return {
        ok: true,
        pid: daemonState.pid,
        port: daemonState.port,
        startedAt: daemonState.startedAt,
        runtimeDbPath: daemonState.runtimeDbPath,
        projectCount: 0,
      };
    }

    await sleep(150);
  }

  throw new Error("Timed out waiting for the Vilano kernel to stop");
}

export async function getRunningDaemonStatus(): Promise<DaemonStatusResponse | null> {
  const runtimePaths = getRuntimePaths();
  const daemonState = await readJsonFile<DaemonState | null>(runtimePaths.daemonStateFile, null);

  if (!daemonState) {
    return null;
  }

  try {
    const kernelStatus = await requestJsonWithState<KernelStatusBody>(daemonState, {
      method: "GET",
      pathname: "/v1/status",
      autoStart: false,
    });

    return toDaemonStatus(daemonState, kernelStatus);
  } catch {
    await fs.rm(runtimePaths.daemonStateFile, { force: true });
    return null;
  }
}

export async function listProjects(): Promise<ProjectListResponse> {
  return requestJson<ProjectListResponse>({
    method: "GET",
    pathname: "/v1/projects",
    autoStart: true,
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
    autoStart: true,
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

export async function listDefinitions(
  kind: "workflow" | "service",
  project?: string
): Promise<DefinitionListResponse> {
  const query = project ? `?project=${encodeURIComponent(project)}` : "";
  const pathname = kind === "workflow" ? `/v1/workflows${query}` : `/v1/services${query}`;

  return requestJson<DefinitionListResponse>({
    method: "GET",
    pathname,
    autoStart: true,
  });
}

export async function inspectWorkflowDefinition(
  project: string,
  name: string
): Promise<DefinitionInspectResponse> {
  return requestJson<DefinitionInspectResponse>({
    method: "GET",
    pathname: `/v1/workflows/${encodeURIComponent(project)}/${encodeURIComponent(name)}`,
    autoStart: true,
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
    autoStart: true,
  });
}

export async function inspectRun(runId: string): Promise<RunInspectResponse> {
  return requestJson<RunInspectResponse>({
    method: "GET",
    pathname: `/v1/runs/${encodeURIComponent(runId)}`,
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
    pathname: `/v1/services/${encodeURIComponent(project)}/${encodeURIComponent(service)}/runs/${encodeURIComponent(serviceKey)}`,
    autoStart: true,
  });
}

export async function listServiceRuns(
  project?: string,
  activeOnly = false
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
    autoStart: true,
  });
}

export async function inspectServiceEnvelope(
  envelopeId: string
): Promise<ServiceEnvelopeResponse> {
  return requestJson<ServiceEnvelopeResponse>({
    method: "GET",
    pathname: `/v1/service-envelopes/${encodeURIComponent(envelopeId)}`,
    autoStart: true,
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
    pathname: `/v1/services/${encodeURIComponent(project)}/${encodeURIComponent(service)}/runs/${encodeURIComponent(serviceKey)}/send`,
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
    pathname: `/v1/services/${encodeURIComponent(project)}/${encodeURIComponent(service)}/runs/${encodeURIComponent(serviceKey)}/signal`,
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
    pathname: `/v1/services/${encodeURIComponent(project)}/${encodeURIComponent(service)}/runs/${encodeURIComponent(serviceKey)}/ask`,
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
    pathname: `/v1/services/${encodeURIComponent(project)}/${encodeURIComponent(service)}/runs/${encodeURIComponent(serviceKey)}/stop`,
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
  let status = await getRunningDaemonStatus();
  if (!status && autoStart) {
    status = await ensureDaemonStarted();
  }

  if (!status) {
    throw new Error("Vilano kernel is not running");
  }

  return requestJsonWithState<T>(status, { method, pathname, body, autoStart });
}

async function requestJsonWithState<T>(
  status: Pick<DaemonStatusResponse, "port">,
  { method, pathname, body }: RequestOptions
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${status.port}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const raw = await response.text();
  const parsed = raw ? (JSON.parse(raw) as T | ErrorResponse) : ({} as T);

  if (!response.ok) {
    const message =
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      parsed.error &&
      typeof parsed.error.message === "string"
        ? parsed.error.message
        : `Kernel request failed with status ${response.status}`;

    throw new Error(message);
  }

  return parsed as T;
}

async function pingKernelStatus(port: number): Promise<KernelStatusBody | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/status`);
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as KernelStatusBody;
  } catch {
    return null;
  }
}

function toDaemonStatus(state: DaemonState, body: KernelStatusBody): DaemonStatusResponse {
  return {
    ok: true,
    pid: state.pid,
    port: state.port,
    startedAt: body.startedAt,
    runtimeDbPath: body.runtimeDbPath,
    projectCount: body.projectCount,
  };
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
