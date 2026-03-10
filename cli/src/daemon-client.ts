import { spawn } from "node:child_process";
import fsSync from "node:fs";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { components as ControlComponents } from "../../protocol/v1/generated/control.ts";
import { ensurePrivateDir, readJsonFile, writeJsonFileAtomic } from "./json-file.ts";
import { prepareRuntimeBundle } from "./runtime-materializer.ts";
import { CLI_PROTOCOL_VERSION } from "./runtime-version.ts";
import { getRuntimePaths } from "./runtime-home.ts";
import type {
  DaemonAuthState,
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
  RunCancelResponse,
  RunListResponse,
  RunReplayResponse,
  RunStartResponse,
  SignalSendResponse,
} from "./types.ts";

interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  pathname: string;
  body?: unknown;
  autoStart?: boolean;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

type KernelStatusBody = ControlComponents["schemas"]["StatusResponse"];

class KernelRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "KernelRequestError";
  }
}

export async function ensureDaemonStarted(
  port = resolveDefaultKernelPort()
): Promise<DaemonStatusResponse> {
  const status = await getRunningDaemonStatus();
  if (status) {
    return status;
  }

  const runtimePaths = getRuntimePaths();
  await ensurePrivateDir(runtimePaths.installRootDir);
  await ensurePrivateDir(runtimePaths.binDir);
  await ensurePrivateDir(runtimePaths.installsDir);
  await ensurePrivateDir(runtimePaths.cacheDir);
  await ensurePrivateDir(runtimePaths.homeDir);
  await ensurePrivateDir(runtimePaths.executionHomeDir);
  await ensurePrivateDir(runtimePaths.workerHomeDir);
  await ensurePrivateDir(runtimePaths.runWorkspacesDir);

  const bundle = await prepareRuntimeBundle();
  const kernelDir = bundle.kernelDir;
  const projectRoot = bundle.runtimeRoot;
  const authToken = generateDaemonAuthToken();
  const workerAuthToken = generateDaemonAuthToken();
  const kernelReleaseExecutable = path.join(kernelDir, "bin", "vilano_kernel");
  const bundledReleaseReady = await fileExists(kernelReleaseExecutable);
  const noCompile =
    process.env.VILANO_KERNEL_NO_COMPILE === "1" ||
    (bundle.materialized && bundledReleaseReady);

  await fs.writeFile(runtimePaths.daemonStartupLogFile, "", { mode: 0o600 });
  const startupLogFd = fsSync.openSync(runtimePaths.daemonStartupLogFile, "a");

  const child = bundle.source.bundled
    ? spawn(kernelReleaseExecutable, ["start"], {
        cwd: kernelDir,
        detached: true,
        stdio: ["ignore", startupLogFd, startupLogFd],
        env: {
          ...process.env,
          VILANO_HOME: runtimePaths.homeDir,
          VILANO_EXECUTION_HOME: runtimePaths.executionHomeDir,
          VILANO_KERNEL_PORT: String(port),
          VILANO_ROOT: projectRoot,
          VILANO_DAEMON_TOKEN: authToken,
          VILANO_WORKER_TOKEN: workerAuthToken,
        },
      })
    : spawn("mix", noCompile ? ["run", "--no-compile", "--no-halt"] : ["run", "--no-halt"], {
        cwd: kernelDir,
        detached: true,
        stdio: ["ignore", startupLogFd, startupLogFd],
        env: {
          ...process.env,
          VILANO_HOME: runtimePaths.homeDir,
          VILANO_EXECUTION_HOME: runtimePaths.executionHomeDir,
          VILANO_KERNEL_PORT: String(port),
          VILANO_ROOT: projectRoot,
          VILANO_DAEMON_TOKEN: authToken,
          VILANO_WORKER_TOKEN: workerAuthToken,
        },
      });
  fsSync.closeSync(startupLogFd);

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && !bundle.source.bundled) {
        reject(
          new Error(
            "Failed to start the Vilano Runtime kernel because 'mix' was not found. Install Elixir 1.17+ and ensure `mix` is on your PATH."
          )
        );
        return;
      }
      if (code === "ENOENT" && bundle.source.bundled) {
        reject(
          new Error(
            `Failed to start the packaged Vilano Runtime kernel release at ${kernelReleaseExecutable}.`
          )
        );
        return;
      }

      reject(error);
    });
  });
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const kernelStatus = await pingKernelStatus(port, authToken);
    if (kernelStatus) {
      const daemonState: DaemonState = {
        version: 1,
        pid: child.pid ?? 0,
        port,
        startedAt: kernelStatus.startedAt,
        runtimeDbPath: kernelStatus.runtimeDbPath,
        runtimeVersion: kernelStatus.runtimeVersion,
        protocolVersion: kernelStatus.protocolVersion,
        schemaVersion: kernelStatus.schemaVersion,
      };
      const daemonAuthState: DaemonAuthState = {
        version: 1,
        authToken,
        workerAuthToken,
      };

      await writeJsonFileAtomic(runtimePaths.daemonStateFile, daemonState);
      await writeJsonFileAtomic(runtimePaths.daemonAuthFile, daemonAuthState);
      child.unref();
      const status = toDaemonStatus(daemonState, kernelStatus);
      assertCompatibleKernelStatus(status);
      return status;
    }

    if (childExit !== null) {
      const exit = childExit as {
        code: number | null;
        signal: NodeJS.Signals | null;
      };
      throw new Error(
        `Vilano Runtime kernel exited before startup (code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}). See ${runtimePaths.daemonStartupLogFile}`
      );
    }

    await sleep(150);
  }

  try {
    if (child.pid) {
      process.kill(child.pid, "SIGKILL");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
  }

  throw new Error(
    `Timed out waiting for the Vilano Runtime kernel to start. See ${runtimePaths.daemonStartupLogFile}`
  );
}

export async function stopDaemon(): Promise<DaemonStatusResponse | null> {
  const runtimePaths = getRuntimePaths();
  const daemonState = await readDaemonState();
  const daemonAuthState = await readDaemonAuthState();

  if (!daemonState || !daemonAuthState) {
    return null;
  }

  try {
    await requestJsonWithState<{ ok: true; shuttingDown: true }>(
      {
        port: daemonState.port,
        authToken: daemonAuthState.authToken,
      },
      {
      method: "POST",
      pathname: "/v1/admin/shutdown",
      autoStart: false,
      }
    );
  } catch (error) {
    if (error instanceof KernelRequestError && error.code === "unauthorized") {
      throw error;
    }

    const running = await pingKernelStatus(daemonState.port, daemonAuthState.authToken);
    if (!running) {
      if (await isProcessAlive(daemonState.pid)) {
        throw new Error("Vilano Runtime kernel process is still running but the shutdown probe failed");
      }

      await clearDaemonStateFiles();
      return null;
    }

    throw new Error("Vilano Runtime kernel is running but refused the shutdown request");
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const running = await pingKernelStatus(daemonState.port, daemonAuthState.authToken);
      if (!running) {
        if (await isProcessAlive(daemonState.pid)) {
          await sleep(150);
          continue;
        }

        await clearDaemonStateFiles();
        return {
          ok: true,
          pid: daemonState.pid,
          port: daemonState.port,
          startedAt: daemonState.startedAt,
          runtimeDbPath: daemonState.runtimeDbPath,
          runtimeVersion: daemonState.runtimeVersion ?? "unknown",
          protocolVersion: daemonState.protocolVersion ?? CLI_PROTOCOL_VERSION,
          schemaVersion: daemonState.schemaVersion ?? 0,
          appliedMigrations: [],
          homeDir: runtimePaths.homeDir,
          executionHomeDir: runtimePaths.executionHomeDir,
          projectRoot: "",
          managedWorkerCount: 0,
          managedWorkerRuntime: "unknown",
          leaseDurationSeconds: 0,
          projectCount: 0,
        };
      }

    await sleep(150);
  }
  throw new Error("Timed out waiting for the Vilano Runtime kernel to stop");
}

export async function getRunningDaemonStatus(): Promise<DaemonStatusResponse | null> {
  const daemonState = await readDaemonState();
  const daemonAuthState = await readDaemonAuthState();

  if (!daemonState || !daemonAuthState) {
    return null;
  }

  try {
    const kernelStatus = await requestJsonWithState<KernelStatusBody>(
      {
        port: daemonState.port,
        authToken: daemonAuthState.authToken,
      },
      {
      method: "GET",
      pathname: "/v1/status",
      autoStart: false,
      }
    );

    const status = toDaemonStatus(daemonState, kernelStatus);
    assertCompatibleKernelStatus(status);
    return status;
  } catch (error) {
    if (error instanceof Error && error.message.includes("protocol version")) {
      throw error;
    }

    if (error instanceof KernelRequestError && error.code === "unauthorized") {
      throw error;
    }

    if (await isProcessAlive(daemonState.pid)) {
      throw new Error("Vilano Runtime kernel process is still running but the status probe failed");
    }

    await clearDaemonStateFiles();
    return null;
  }
}

export async function readDaemonState(): Promise<DaemonState | null> {
  return await readJsonFile<DaemonState | null>(getRuntimePaths().daemonStateFile, null);
}

export async function readDaemonAuthState(): Promise<DaemonAuthState | null> {
  return await readJsonFile<DaemonAuthState | null>(getRuntimePaths().daemonAuthFile, null);
}

export async function listProjects(): Promise<ProjectListResponse> {
  return requestJson<ProjectListResponse>({
    method: "GET",
    pathname: "/v1/projects",
    autoStart: false,
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
  project?: string
): Promise<DefinitionListResponse> {
  const query = project ? `?project=${encodeURIComponent(project)}` : "";
  const pathname = kind === "workflow" ? `/v1/workflows${query}` : `/v1/services${query}`;

  return requestJson<DefinitionListResponse>({
    method: "GET",
    pathname,
    autoStart: false,
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
    pathname: `/v1/services/${encodeURIComponent(project)}/${encodeURIComponent(service)}/runs/${encodeURIComponent(serviceKey)}`,
    autoStart: false,
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
    autoStart: false,
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
  let daemonState = await readDaemonState();
  let daemonAuthState = await readDaemonAuthState();
  let status = await getRunningDaemonStatus();
  if (!status && autoStart) {
    status = await ensureDaemonStarted();
    daemonState = await readDaemonState();
    daemonAuthState = await readDaemonAuthState();
  }

  if (!status) {
    throw new Error("Vilano Runtime kernel is not running");
  }

  if (!daemonState) {
    daemonState = await readDaemonState();
  }

  if (!daemonAuthState) {
    daemonAuthState = await readDaemonAuthState();
  }

  if (!daemonState || !daemonAuthState) {
    throw new Error("Vilano Runtime kernel state is missing from VILANO_HOME");
  }

  assertCompatibleKernelStatus(status);
  return requestJsonWithState<T>(
    {
      port: daemonState.port,
      authToken: daemonAuthState.authToken,
    },
    { method, pathname, body, autoStart }
  );
}

async function requestJsonWithState<T>(
  status: { port: number; authToken: string },
  { method, pathname, body }: RequestOptions
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${status.port}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(status.authToken ? { "x-vilano-token": status.authToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const raw = await response.text();
  const parsed = raw ? (JSON.parse(raw) as T | ErrorResponse) : ({} as T);

  if (!response.ok) {
    const errorCode =
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      parsed.error &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      "code" in parsed.error &&
      typeof parsed.error.code === "string"
        ? parsed.error.code
        : undefined;

    const message =
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      parsed.error &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      "message" in parsed.error &&
      typeof parsed.error.message === "string"
        ? parsed.error.message
        : `Kernel request failed with status ${response.status}`;

    throw new KernelRequestError(message, response.status, errorCode);
  }

  return parsed as T;
}

async function pingKernelStatus(port: number, authToken?: string): Promise<KernelStatusBody | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: authToken ? { "x-vilano-token": authToken } : undefined,
    });
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
    runtimeVersion: body.runtimeVersion,
    protocolVersion: body.protocolVersion,
    schemaVersion: body.schemaVersion,
    appliedMigrations: body.appliedMigrations,
    homeDir: body.homeDir,
    executionHomeDir: body.executionHomeDir,
    projectRoot: body.projectRoot,
    managedWorkerCount: body.managedWorkerCount,
    managedWorkerRuntime: body.managedWorkerRuntime,
    leaseDurationSeconds: body.leaseDurationSeconds,
    projectCount: body.projectCount,
  };
}

function assertCompatibleKernelStatus(status: Pick<DaemonStatusResponse, "protocolVersion" | "runtimeVersion">): void {
  if (typeof status.protocolVersion !== "number" || status.protocolVersion !== CLI_PROTOCOL_VERSION) {
    throw new Error(
      `Vilano Runtime CLI protocol version ${CLI_PROTOCOL_VERSION} is incompatible with kernel runtime ${status.runtimeVersion} (protocol ${status.protocolVersion})`
    );
  }
}

function generateDaemonAuthToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

async function clearDaemonStateFiles(): Promise<void> {
  const runtimePaths = getRuntimePaths();
  await fs.rm(runtimePaths.daemonStateFile, { force: true });
  await fs.rm(runtimePaths.daemonAuthFile, { force: true });
}

async function isProcessAlive(pid: number | null | undefined): Promise<boolean> {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return false;
  }

  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      return true;
    }

    return false;
  }
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export function resolveDefaultKernelPort(): number {
  const raw = process.env.VILANO_KERNEL_PORT;
  if (!raw) {
    return 4141;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 4141;
  }

  return parsed;
}
