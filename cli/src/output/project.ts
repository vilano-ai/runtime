import type { DefinitionRecord, ProjectRecord } from "../types.ts";

export function renderProject(project: ProjectRecord): string {
  return [
    `project: ${project.name}`,
    `path: ${project.path}`,
    `snapshot_path: ${project.snapshotPath ?? "none"}`,
    `last_synced_at: ${project.lastSyncedAt ?? "never"}`,
    `definitions_manifest_hash: ${project.definitionsManifestHash ?? "none"}`,
    `workflows: ${project.definitions.workflows.length}`,
    `services: ${project.definitions.services.length}`,
  ].join("\n");
}

export function renderProjectSummary(project: ProjectRecord): string {
  return `${project.name}\t${project.path}\tsnapshot=${project.snapshotPath ?? "none"}\tworkflows=${project.definitions.workflows.length}\tservices=${project.definitions.services.length}`;
}

export function renderDefinitionList(
  kind: "workflow" | "service",
  project: string | null,
  definitions: DefinitionRecord[]
): string {
  if (definitions.length === 0) {
    return project
      ? `No ${kind} definitions found in project ${project}.`
      : `No ${kind} definitions found.`;
  }

  const header = project ? `${kind} definitions in ${project}` : `${kind} definitions`;
  return [
    header,
    ...definitions.map(
      (definition) =>
        `${definition.name}\t${definition.file}\t${definition.sourceLanguage}/${definition.runtimeKind}`
    ),
  ].join("\n");
}

export function renderDefinitionInspect(project: string, definition: DefinitionRecord): string {
  return [
    `project: ${project}`,
    `kind: ${definition.kind}`,
    `name: ${definition.name}`,
    `export: ${definition.exportName}`,
    `file: ${definition.file}`,
    `source_language: ${definition.sourceLanguage}`,
    `runtime_kind: ${definition.runtimeKind}`,
  ].join("\n");
}
