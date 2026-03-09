import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ServiceDefinition, WorkflowDefinition } from "./runtime-sdk.ts";

import type { ServiceTurnActivation, WorkflowActivation } from "./client.ts";

export async function loadWorkflowDefinition(
  activation: WorkflowActivation,
  options: { cacheKey?: string; importRoot?: string } = {}
): Promise<WorkflowDefinition<any, any>> {
  const definition = await loadDefinitionExport(
    options.importRoot ?? activation.project.path,
    activation.definition.file,
    activation.definition.exportName,
    activation.definition.name,
    "workflow",
    options.cacheKey
  );

  return definition as WorkflowDefinition<any, any>;
}

export async function loadServiceDefinition(
  activation: ServiceTurnActivation,
  options: { cacheKey?: string; importRoot?: string } = {}
): Promise<ServiceDefinition<any, any, any, any, any>> {
  const definition = await loadDefinitionExport(
    options.importRoot ?? activation.project.path,
    activation.definition.file,
    activation.definition.exportName,
    activation.definition.name,
    "service",
    options.cacheKey
  );

  return definition as ServiceDefinition<any, any, any, any, any>;
}

async function loadDefinitionExport(
  projectPath: string,
  file: string,
  exportName: string,
  definitionName: string,
  kind: "workflow" | "service",
  cacheKey?: string
): Promise<unknown> {
  const absolutePath = path.join(projectPath, file);
  const [projectRealPath, absoluteRealPath] = await Promise.all([
    fs.realpath(projectPath),
    fs.realpath(absolutePath),
  ]);
  const relativeToProject = path.relative(projectRealPath, absoluteRealPath);

  if (
    relativeToProject === "" ||
    relativeToProject.startsWith("..") ||
    path.isAbsolute(relativeToProject)
  ) {
    throw new Error(`Definition file '${file}' resolved outside the project root`);
  }

  const moduleUrl =
    cacheKey && cacheKey.trim().length > 0
      ? `${pathToFileURL(absoluteRealPath).href}?vilano_activation=${encodeURIComponent(cacheKey)}`
      : pathToFileURL(absoluteRealPath).href;
  const moduleExports = (await import(moduleUrl)) as Record<string, unknown>;
  const value = moduleExports[exportName];

  if (!(exportName in moduleExports)) {
    const exportsList = Object.keys(moduleExports).sort().join(", ");
    throw new Error(
      `Definition file '${file}' does not export '${exportName}' (exports: ${exportsList})`
    );
  }

  if (!value || typeof value !== "object") {
    throw new Error(`Export '${exportName}' from ${file} is not a ${kind} definition`);
  }

  const record = value as { kind?: string; name?: string };
  if (record.kind !== kind || record.name !== definitionName) {
    throw new Error(
      `Export '${exportName}' from ${file} does not match declared ${kind} '${definitionName}'`
    );
  }

  return value;
}
