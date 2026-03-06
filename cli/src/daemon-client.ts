import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { readJsonFile } from "./json-file";
import { getRuntimePaths } from "./runtime-home";
import type {
  DaemonState,
  DaemonStatusResponse,
  DefinitionInspectResponse,
  DefinitionListResponse,
  ErrorResponse,
  ProjectListResponse,
  ProjectResponse,
} from "./types";

interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  pathname: string;
  body?: unknown;
  autoStart?: boolean;
}

export async function ensureDaemonStarted(port = 4141): Promise<DaemonStatusResponse> {
  const status = await getRunningDaemonStatus();
  if (status) {
    return status;
  }

  const entryPath = path.join(__dirname, "index.js");
  const child = spawn(
    process.execPath,
    [entryPath, "__daemon-serve", "--port", String(port)],
    {
      detached: true,
      stdio: "ignore",
    }
  );

  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const running = await getRunningDaemonStatus();
    if (running) {
      return running;
    }

    await sleep(150);
  }

  throw new Error("Timed out waiting for the Vilano daemon to start");
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
    const running = await getRunningDaemonStatus();
    if (!running) {
      await fs.rm(runtimePaths.daemonStateFile, { force: true });
      return {
        ok: true,
        pid: daemonState.pid,
        port: daemonState.port,
        startedAt: daemonState.startedAt,
        registryPath: daemonState.registryPath,
        projectCount: 0,
      };
    }

    await sleep(150);
  }

  throw new Error("Timed out waiting for the Vilano daemon to stop");
}

export async function getRunningDaemonStatus(): Promise<DaemonStatusResponse | null> {
  const runtimePaths = getRuntimePaths();
  const daemonState = await readJsonFile<DaemonState | null>(runtimePaths.daemonStateFile, null);

  if (!daemonState) {
    return null;
  }

  try {
    return await requestJsonWithState<DaemonStatusResponse>(daemonState, {
      method: "GET",
      pathname: "/v1/status",
      autoStart: false,
    });
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

export async function addProject(name: string, projectPath: string): Promise<ProjectResponse> {
  return requestJson<ProjectResponse>({
    method: "POST",
    pathname: "/v1/projects",
    body: { name, path: projectPath },
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

export async function syncProject(name: string): Promise<ProjectResponse> {
  return requestJson<ProjectResponse>({
    method: "POST",
    pathname: `/v1/projects/${encodeURIComponent(name)}/sync`,
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
    throw new Error("Vilano daemon is not running");
  }

  return requestJsonWithState<T>(status, { method, pathname, body, autoStart });
}

async function requestJsonWithState<T>(
  status: Pick<DaemonStatusResponse, "port">,
  {
    method,
    pathname,
    body,
  }: RequestOptions
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: status.port,
        method,
        path: pathname,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            const parsed = raw ? (JSON.parse(raw) as T | ErrorResponse) : ({} as T);

            if (!res.statusCode || res.statusCode >= 400) {
              const message =
                typeof parsed === "object" &&
                parsed !== null &&
                "error" in parsed &&
                parsed.error &&
                typeof parsed.error.message === "string"
                  ? parsed.error.message
                  : `Daemon request failed with status ${res.statusCode ?? 0}`;

              reject(new Error(message));
              return;
            }

            resolve(parsed as T);
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("error", reject);

    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
