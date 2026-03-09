import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import type { DefinitionRecord } from "./types.ts";

export const PROJECT_MANIFEST_VERSION = 1;

export interface ProjectManifestFile {
  manifestVersion: number;
  definitions: {
    workflows: DefinitionRecord[];
    services: DefinitionRecord[];
  };
}

let validatorPromise: Promise<ValidateFunction<ProjectManifestFile>> | null = null;

export async function validateProjectManifest(
  value: unknown,
  options: { projectPath?: string } = {}
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const validate = await getValidator();

  if (!validate(value)) {
    const errors =
      (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);

    return { ok: false, errors };
  }

  const projectPath = options.projectPath ? path.resolve(options.projectPath) : null;
  const additionalErrors = projectPath
    ? await collectProjectScopedManifestErrors(value as ProjectManifestFile, projectPath)
    : [];

  if (additionalErrors.length > 0) {
    return { ok: false, errors: additionalErrors };
  }

  return { ok: true };
}

export async function assertValidProjectManifest(
  value: unknown,
  sourceDescription: string,
  options: { projectPath?: string } = {}
): Promise<ProjectManifestFile> {
  const result = await validateProjectManifest(value, options);
  if (!result.ok) {
    throw new Error(
      `Invalid Vilano project manifest at ${sourceDescription}: ${result.errors.join("; ")}`
    );
  }

  return value as ProjectManifestFile;
}

async function getValidator(): Promise<ValidateFunction<ProjectManifestFile>> {
  if (!validatorPromise) {
    validatorPromise = buildValidator();
  }

  return await validatorPromise;
}

async function buildValidator(): Promise<ValidateFunction<ProjectManifestFile>> {
  const schema = JSON.parse(await fs.readFile(await resolveSchemaPath(), "utf8")) as Record<string, unknown>;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });

  return ajv.compile<ProjectManifestFile>(schema);
}

async function resolveSchemaPath(): Promise<string> {
  const candidates = [
    path.resolve(import.meta.dir, "../../protocol/v1/project-manifest.schema.json"),
    path.resolve(import.meta.dir, "../runtime-dist/protocol/v1/project-manifest.schema.json"),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(
    `Unable to locate protocol/v1/project-manifest.schema.json from ${import.meta.dir}`
  );
}

async function collectProjectScopedManifestErrors(
  manifest: ProjectManifestFile,
  projectPath: string
): Promise<string[]> {
  const errors: string[] = [];
  const seen = new Set<string>();
  const moduleCache = new Map<string, Promise<Record<string, unknown>>>();
  const projectRealPath = await fs.realpath(projectPath);

  for (const definition of [...manifest.definitions.workflows, ...manifest.definitions.services]) {
    const relativeFile = definition.file;
    if (!relativeFile || relativeFile.trim().length === 0) {
      continue;
    }

    if (path.isAbsolute(relativeFile)) {
      errors.push(`definition '${definition.name}' must use a relative file path`);
      continue;
    }

    const resolvedFile = path.resolve(projectPath, relativeFile);
    const relativeToProject = path.relative(projectPath, resolvedFile);

    if (
      relativeToProject === "" ||
      relativeToProject.startsWith("..") ||
      path.isAbsolute(relativeToProject)
    ) {
      errors.push(`definition '${definition.name}' file must stay within the project root`);
      continue;
    }

    if (seen.has(resolvedFile)) {
      continue;
    }

    seen.add(resolvedFile);

    try {
      const stat = await fs.lstat(resolvedFile);
      if (stat.isSymbolicLink()) {
        errors.push(`definition '${definition.name}' file must not be a symbolic link: ${relativeFile}`);
        continue;
      }

      if (!stat.isFile()) {
        errors.push(`definition '${definition.name}' file does not resolve to a file: ${relativeFile}`);
        continue;
      }

      const realFilePath = await fs.realpath(resolvedFile);
      const relativeToRealProject = path.relative(projectRealPath, realFilePath);
      if (
        relativeToRealProject === "" ||
        relativeToRealProject.startsWith("..") ||
        path.isAbsolute(relativeToRealProject)
      ) {
        errors.push(`definition '${definition.name}' file must resolve within the project root`);
        continue;
      }

      try {
        const moduleExports = await loadDefinitionModule(realFilePath, moduleCache);
        if (!(definition.exportName in moduleExports)) {
          const exportsList = Object.keys(moduleExports).sort().join(", ");
          errors.push(
            `definition '${definition.name}' export '${definition.exportName}' was not found in ${relativeFile} (exports: ${exportsList})`
          );
          continue;
        }

        const value = moduleExports[definition.exportName];
        if (!value || typeof value !== "object") {
          errors.push(
            `definition '${definition.name}' export '${definition.exportName}' in ${relativeFile} is not a Vilano ${definition.kind} definition`
          );
          continue;
        }

        const record = value as { kind?: string; name?: string };
        if (record.kind !== definition.kind || record.name !== definition.name) {
          errors.push(
            `definition '${definition.name}' export '${definition.exportName}' in ${relativeFile} does not match declared ${definition.kind} '${definition.name}'`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(
          `definition '${definition.name}' export '${definition.exportName}' in ${relativeFile} could not be loaded: ${message}`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        errors.push(`definition '${definition.name}' file does not exist: ${relativeFile}`);
        continue;
      }

      throw error;
    }
  }

  return errors;
}

async function loadDefinitionModule(
  realFilePath: string,
  moduleCache: Map<string, Promise<Record<string, unknown>>>
): Promise<Record<string, unknown>> {
  let promise = moduleCache.get(realFilePath);
  if (!promise) {
    const moduleUrl = `${pathToFileURL(realFilePath).href}?vilano_manifest_validate=${Date.now()}`;
    promise = import(moduleUrl).then((value) => value as Record<string, unknown>);
    moduleCache.set(realFilePath, promise);
  }

  return await promise;
}
