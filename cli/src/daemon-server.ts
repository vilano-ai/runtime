import http, { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

import { ensureDir, writeJsonFileAtomic } from "./json-file";
import {
  addProject,
  findDefinition,
  getProject,
  listProjects,
  loadRegistry,
  removeProject,
  syncProject,
} from "./registry";
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

function sendJson(
  res: ServerResponse<IncomingMessage>,
  statusCode: number,
  body:
    | DaemonStatusResponse
    | ProjectListResponse
    | ProjectResponse
    | DefinitionListResponse
    | DefinitionInspectResponse
    | ErrorResponse
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body)}\n`);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function parseProjectParam(url: URL): string | null {
  return url.searchParams.get("project");
}

export async function startDaemonServer(port: number): Promise<void> {
  const runtimePaths = getRuntimePaths();
  await ensureDir(runtimePaths.homeDir);

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        sendJson(res, 400, errorBody("bad_request", "Missing request metadata"));
        return;
      }

      const url = new URL(req.url, "http://127.0.0.1");
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/v1/status") {
        const registry = await loadRegistry();
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          port,
          startedAt: daemonState.startedAt,
          registryPath: runtimePaths.registryFile,
          projectCount: Object.keys(registry.projects).length,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/projects") {
        sendJson(res, 200, {
          ok: true,
          projects: await listProjects(),
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/projects") {
        const body = await readJsonBody(req);
        const name = expectString(body.name, "name");
        const projectPath = expectString(body.path, "path");
        const project = await addProject(name, projectPath);
        sendJson(res, 200, { ok: true, project });
        return;
      }

      const projectMatch = /^\/v1\/projects\/([^/]+)$/.exec(pathname);
      if (projectMatch && req.method === "GET") {
        const project = await getProject(decodeURIComponent(projectMatch[1]));
        sendJson(res, 200, { ok: true, project });
        return;
      }

      if (projectMatch && req.method === "DELETE") {
        const project = await removeProject(decodeURIComponent(projectMatch[1]));
        sendJson(res, 200, { ok: true, project });
        return;
      }

      const projectSyncMatch = /^\/v1\/projects\/([^/]+)\/sync$/.exec(pathname);
      if (projectSyncMatch && req.method === "POST") {
        const project = await syncProject(decodeURIComponent(projectSyncMatch[1]));
        sendJson(res, 200, { ok: true, project });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/workflows") {
        const registry = await loadRegistry();
        const requestedProject = parseProjectParam(url);

        const definitions = requestedProject
          ? getProjectDefinitions(registry, requestedProject, "workflow")
          : Object.values(registry.projects).flatMap((project) => project.definitions.workflows);

        sendJson(res, 200, {
          ok: true,
          project: requestedProject,
          definitions,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/services") {
        const registry = await loadRegistry();
        const requestedProject = parseProjectParam(url);

        const definitions = requestedProject
          ? getProjectDefinitions(registry, requestedProject, "service")
          : Object.values(registry.projects).flatMap((project) => project.definitions.services);

        sendJson(res, 200, {
          ok: true,
          project: requestedProject,
          definitions,
        });
        return;
      }

      const workflowInspectMatch = /^\/v1\/workflows\/([^/]+)\/([^/]+)$/.exec(pathname);
      if (workflowInspectMatch && req.method === "GET") {
        const registry = await loadRegistry();
        const projectName = decodeURIComponent(workflowInspectMatch[1]);
        const definitionName = decodeURIComponent(workflowInspectMatch[2]);
        const { project, definition } = findDefinition(
          registry,
          "workflow",
          `${projectName}/${definitionName}`,
          process.cwd()
        );

        sendJson(res, 200, {
          ok: true,
          project: project.name,
          definition,
        });
        return;
      }

      sendJson(res, 404, errorBody("not_found", `Unknown endpoint: ${req.method} ${pathname}`));
    } catch (error) {
      sendJson(
        res,
        400,
        errorBody("request_failed", error instanceof Error ? error.message : "Request failed")
      );
    }
  });

  const daemonState: DaemonState = {
    version: 1,
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    registryPath: runtimePaths.registryFile,
  };

  const cleanup = async (): Promise<void> => {
    server.close();
    await fs.rm(runtimePaths.daemonStateFile, { force: true });
  };

  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });

  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  await writeJsonFileAtomic(runtimePaths.daemonStateFile, daemonState);
}

function getProjectDefinitions(
  registry: Awaited<ReturnType<typeof loadRegistry>>,
  projectName: string,
  kind: "workflow" | "service"
) {
  const project = registry.projects[projectName];

  if (!project) {
    throw new Error(`Unknown project: ${projectName}`);
  }

  return kind === "workflow" ? project.definitions.workflows : project.definitions.services;
}

function expectString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected '${fieldName}' to be a non-empty string`);
  }

  return value;
}

function errorBody(code: string, message: string): ErrorResponse {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}
