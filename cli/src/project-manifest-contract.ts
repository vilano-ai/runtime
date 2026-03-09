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
  value: unknown
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const validate = await getValidator();

  if (validate(value)) {
    return { ok: true };
  }

  const errors =
    (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);

  return { ok: false, errors };
}

export async function assertValidProjectManifest(
  value: unknown,
  sourceDescription: string
): Promise<ProjectManifestFile> {
  const result = await validateProjectManifest(value);
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
