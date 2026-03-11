import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { DefinitionRecord } from "./types.ts";

export async function validateProjectDefinitionsIdentity(
  projectPath: string,
  definitions: DefinitionRecord[]
): Promise<DefinitionRecord[]> {
  const projectRealPath = await fs.realpath(projectPath);
  const moduleExportsByFile = new Map<string, Record<string, unknown>>();
  const validationKey = crypto.randomUUID();
  const validated: DefinitionRecord[] = [];

  for (const definition of definitions) {
    let moduleExports = moduleExportsByFile.get(definition.file);
    if (!moduleExports) {
      moduleExports = await loadDefinitionModule(projectPath, projectRealPath, definition.file, `${validationKey}:${definition.file}`);
      moduleExportsByFile.set(definition.file, moduleExports);
    }

    const value = assertDefinitionIdentity(moduleExports, definition);
    validated.push(normalizeDefinitionRecord(definition, value));
  }

  return validated;
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
): Record<string, unknown> {
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

  return value as Record<string, unknown>;
}

function normalizeDefinitionRecord(
  definition: DefinitionRecord,
  exportedDefinition: Record<string, unknown>
): DefinitionRecord {
  if (definition.kind !== "service") {
    return definition;
  }

  const mailbox = normalizeMailboxConfig(exportedDefinition.mailbox, definition);
  const discovery = normalizeDiscoveryConfig(exportedDefinition.discovery, definition);

  return cleanupDefinitionRecord({
    ...definition,
    mailbox,
    discovery,
  });
}

function normalizeMailboxConfig(
  mailbox: unknown,
  definition: DefinitionRecord
): DefinitionRecord["mailbox"] | undefined {
  if (mailbox == null) {
    return undefined;
  }

  if (!mailbox || typeof mailbox !== "object" || Array.isArray(mailbox)) {
    throw new Error(`Service '${definition.name}' mailbox config must be an object`);
  }

  const maxQueued = Reflect.get(mailbox, "maxQueued");
  if (!Number.isInteger(maxQueued) || Number(maxQueued) <= 0) {
    throw new Error(`Service '${definition.name}' mailbox.maxQueued must be a positive integer`);
  }

  const overload = Reflect.get(mailbox, "overload");
  if (overload != null && overload !== "reject_new") {
    throw new Error(`Service '${definition.name}' mailbox.overload must be 'reject_new'`);
  }

  return {
    maxQueued: Number(maxQueued),
    overload: "reject_new",
  };
}

function normalizeDiscoveryConfig(
  discovery: unknown,
  definition: DefinitionRecord
): DefinitionRecord["discovery"] | undefined {
  if (discovery == null) {
    return undefined;
  }

  if (!discovery || typeof discovery !== "object" || Array.isArray(discovery)) {
    throw new Error(`Service '${definition.name}' discovery config must be an object`);
  }

  const singletonRole = Reflect.get(discovery, "singletonRole");
  if (typeof singletonRole !== "string" || singletonRole.trim().length === 0) {
    throw new Error(`Service '${definition.name}' discovery.singletonRole must be a non-empty string`);
  }

  return {
    singletonRole,
  };
}

function cleanupDefinitionRecord(definition: DefinitionRecord): DefinitionRecord {
  const next = { ...definition };

  if (!next.mailbox) {
    delete next.mailbox;
  }

  if (!next.discovery) {
    delete next.discovery;
  }

  return next;
}
