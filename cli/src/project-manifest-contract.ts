import fs from "node:fs/promises";
import path from "node:path";

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
      const stat = await fs.stat(resolvedFile);
      if (!stat.isFile()) {
        errors.push(`definition '${definition.name}' file does not resolve to a file: ${relativeFile}`);
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
