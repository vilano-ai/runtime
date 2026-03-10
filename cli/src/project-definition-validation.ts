import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { DefinitionRecord } from "./types.ts";

export async function validateProjectDefinitionsIdentity(
  projectPath: string,
  definitions: DefinitionRecord[]
): Promise<void> {
  const projectRealPath = await fs.realpath(projectPath);
  const moduleExportsByFile = new Map<string, Record<string, unknown>>();
  const validationKey = crypto.randomUUID();

  for (const definition of definitions) {
    let moduleExports = moduleExportsByFile.get(definition.file);
    if (!moduleExports) {
      moduleExports = await loadDefinitionModule(projectPath, projectRealPath, definition.file, `${validationKey}:${definition.file}`);
      moduleExportsByFile.set(definition.file, moduleExports);
    }

    assertDefinitionIdentity(moduleExports, definition);
  }
}

async function loadDefinitionModule(
  projectPath: string,
  projectRealPath: string,
  file: string,
  cacheKey: string
): Promise<Record<string, unknown>> {
  const absolutePath = path.join(projectPath, file);
  let absoluteRealPath: string;

  try {
    absoluteRealPath = await fs.realpath(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Definition file '${file}' does not exist`);
    }

    throw error;
  }

  const relativeToProject = path.relative(projectRealPath, absoluteRealPath);
  if (
    relativeToProject === "" ||
    relativeToProject.startsWith("..") ||
    path.isAbsolute(relativeToProject)
  ) {
    throw new Error(`Definition file '${file}' resolved outside the project root`);
  }

  const moduleUrl = `${pathToFileURL(absoluteRealPath).href}?vilano_registration=${encodeURIComponent(cacheKey)}`;
  return (await import(moduleUrl)) as Record<string, unknown>;
}

function assertDefinitionIdentity(
  moduleExports: Record<string, unknown>,
  definition: DefinitionRecord
): void {
  const value = moduleExports[definition.exportName];

  if (!(definition.exportName in moduleExports)) {
    const exportsList = Object.keys(moduleExports).sort().join(", ");
    throw new Error(
      `Definition file '${definition.file}' does not export '${definition.exportName}' for declared ${definition.kind} '${definition.name}' (exports: ${exportsList})`
    );
  }

  if (!value || typeof value !== "object") {
    throw new Error(
      `Export '${definition.exportName}' from ${definition.file} is not a ${definition.kind} definition`
    );
  }

  const record = value as { kind?: string; name?: string };
  if (record.kind !== definition.kind || record.name !== definition.name) {
    throw new Error(
      `Export '${definition.exportName}' from ${definition.file} does not match declared ${definition.kind} '${definition.name}'`
    );
  }
}
