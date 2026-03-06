export interface DefinitionRecord {
  kind: "workflow" | "service";
  name: string;
  exportName: string;
  file: string;
}

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

export interface RegistryFile {
  version: 1;
  projects: Record<string, ProjectRecord>;
}

export interface DaemonState {
  version: 1;
  pid: number;
  port: number;
  startedAt: string;
  registryPath: string;
}

export interface DaemonStatusResponse {
  ok: true;
  pid: number;
  port: number;
  startedAt: string;
  registryPath: string;
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

export interface ErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}
