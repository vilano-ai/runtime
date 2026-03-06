export interface DefinitionRecord {
  kind: "workflow" | "service";
  name: string;
  exportName: string;
  file: string;
}

export type DefinitionKind = DefinitionRecord["kind"];

export type RunStatus =
  | "pending"
  | "running"
  | "waiting"
  | "sleeping"
  | "completed"
  | "failed"
  | "cancelled"
  | "idle"
  | "active"
  | "stopped";

export interface ProjectRecord {
  name: string;
  path: string;
  lastSyncedAt: string | null;
  definitionsManifestHash: string | null;
  definitions: {
    workflows: DefinitionRecord[];
    services: DefinitionRecord[];
  };
}

export interface DaemonState {
  version: 1;
  pid: number;
  port: number;
  startedAt: string;
  runtimeDbPath: string;
}

export interface DaemonStatusResponse {
  ok: true;
  pid: number;
  port: number;
  startedAt: string;
  runtimeDbPath: string;
  projectCount: number;
}

export interface ProjectListResponse {
  ok: true;
  projects: ProjectRecord[];
}

export interface ProjectResponse {
  ok: true;
  project: ProjectRecord;
}

export interface DefinitionListResponse {
  ok: true;
  project: string | null;
  definitions: DefinitionRecord[];
}

export interface DefinitionInspectResponse {
  ok: true;
  project: string;
  definition: DefinitionRecord;
}

export interface RunRecord {
  id: string;
  project: string;
  definitionKind: DefinitionKind;
  definitionName: string;
  status: RunStatus;
  input: unknown;
  output: unknown | null;
  error: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunEventRecord {
  id: string;
  runId: string;
  seq: number;
  type: string;
  body: unknown;
  createdAt: string;
}

export interface RunStartResponse {
  ok: true;
  run: RunRecord;
}

export interface RunListResponse {
  ok: true;
  project: string | null;
  runs: RunRecord[];
}

export interface RunInspectResponse {
  ok: true;
  run: RunRecord;
  events: RunEventRecord[];
}

export interface ErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}
