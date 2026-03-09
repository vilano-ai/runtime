import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ServiceDefinition, WorkflowDefinition } from "./runtime-sdk.ts";

import type { ServiceTurnActivation, WorkflowActivation } from "./client.ts";

export async function loadWorkflowDefinition(
  activation: WorkflowActivation,
  options: { cacheKey?: string; importRoot?: string } = {}
): Promise<WorkflowDefinition<any, any>> {
  const moduleExports = await loadDefinitionModule(
    options.importRoot ?? activation.project.path,
    activation.definition.file,
    activation.definition.exportName,
    options.cacheKey
  );
  const definition = selectDefinitionExport(
    moduleExports,
    activation.definition.exportName,
    activation.definition.name,
    "workflow"
  );

  if (!definition || typeof definition !== "object" || (definition as { kind?: string }).kind !== "workflow") {
    const exportsList = Object.keys(moduleExports).sort().join(", ");
    throw new Error(
      `Export '${activation.definition.exportName}' from ${activation.definition.file} is not a workflow definition (exports: ${exportsList})`
    );
  }

  return definition as WorkflowDefinition<any, any>;
}

export async function loadServiceDefinition(
  activation: ServiceTurnActivation,
  options: { cacheKey?: string; importRoot?: string } = {}
): Promise<ServiceDefinition<any, any, any, any, any>> {
  const moduleExports = await loadDefinitionModule(
    options.importRoot ?? activation.project.path,
    activation.definition.file,
    activation.definition.exportName,
    options.cacheKey
  );
  const definition = selectDefinitionExport(
    moduleExports,
    activation.definition.exportName,
    activation.definition.name,
    "service"
  );

  if (!definition || typeof definition !== "object" || (definition as { kind?: string }).kind !== "service") {
    const exportsList = Object.keys(moduleExports).sort().join(", ");
    throw new Error(
      `Export '${activation.definition.exportName}' from ${activation.definition.file} is not a service definition (exports: ${exportsList})`
    );
  }

  return definition as ServiceDefinition<any, any, any, any, any>;
}

async function loadDefinitionModule(
  projectPath: string,
  file: string,
  exportName: string,
  cacheKey?: string
): Promise<Record<string, unknown>> {
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
  if (!(exportName in moduleExports)) {
    return moduleExports;
  }

  return moduleExports;
}

function selectDefinitionExport(
  moduleExports: Record<string, unknown>,
  exportName: string,
  definitionName: string,
  kind: "workflow" | "service"
): unknown {
  const candidates: unknown[] = [];
  const defaultExports =
    moduleExports.default && typeof moduleExports.default === "object" && !Array.isArray(moduleExports.default)
      ? (moduleExports.default as Record<string, unknown>)
      : null;

  candidates.push(moduleExports[exportName]);

  if (defaultExports) {
    candidates.push(defaultExports[exportName]);
  }

  candidates.push(...Object.values(moduleExports));

  if (defaultExports) {
    candidates.push(...Object.values(defaultExports));
  }

  return candidates.find((candidate) => isDefinitionLike(candidate, definitionName, kind));
}

function isDefinitionLike(
  candidate: unknown,
  definitionName: string,
  kind: "workflow" | "service"
): candidate is WorkflowDefinition<any, any> | ServiceDefinition<any, any, any, any, any> {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }

  const record = candidate as { kind?: string; name?: string };
  return record.kind === kind && record.name === definitionName;
}
