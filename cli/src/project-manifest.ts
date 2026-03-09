import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, readJsonFile, writeJsonFileAtomic } from "./json-file.ts";
import {
  PROJECT_MANIFEST_VERSION,
  assertValidProjectManifest,
  type ProjectManifestFile,
} from "./project-manifest-contract.ts";
import type { DefinitionRecord, ProjectRecord } from "./types.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".vilano",
  "node_modules",
  "dist",
  "coverage",
  "_build",
  "deps",
  ".next",
  "out",
  "spec",
]);

export interface BuildProjectManifestOptions {
  regenerate?: boolean;
}

interface GeneratedProjectManifestCacheFile extends ProjectManifestFile {
  generatedAt: string;
  definitionsManifestHash: string;
}

export function getProjectManifestPath(projectPath: string): string {
  return path.join(projectPath, "vilano.manifest.json");
}

export function getGeneratedProjectManifestCachePath(projectPath: string): string {
  return path.join(projectPath, ".vilano", "project-manifest.json");
}

export async function loadExplicitProjectManifest(
  projectName: string,
  projectPath: string
): Promise<ProjectRecord | null> {
  const resolvedPath = path.resolve(projectPath);
  const manifestPath = getProjectManifestPath(resolvedPath);
  const manifest = await readJsonFile<unknown>(manifestPath, null);

  if (!manifest) {
    return null;
  }

  const validated = await assertValidProjectManifest(manifest, manifestPath);
  return toProjectRecord(projectName, resolvedPath, validated, {
    generatedAt: null,
    definitionsManifestHash: hashDefinitions(validated.definitions),
  });
}

export async function loadProjectManifest(
  projectName: string,
  projectPath: string
): Promise<ProjectRecord | null> {
  const resolvedPath = path.resolve(projectPath);
  const explicitManifest = await loadExplicitProjectManifest(projectName, resolvedPath);

  if (explicitManifest) {
    return explicitManifest;
  }

  return await loadGeneratedProjectManifestCache(projectName, resolvedPath);
}

async function loadGeneratedProjectManifestCache(
  projectName: string,
  projectPath: string
): Promise<ProjectRecord | null> {
  const manifestPath = getGeneratedProjectManifestCachePath(projectPath);
  const manifest = await readJsonFile<GeneratedProjectManifestCacheFile | null>(manifestPath, null);

  if (!manifest) {
    return null;
  }

  if (!isGeneratedProjectManifestCacheFile(manifest)) {
    return null;
  }

  return toProjectRecord(projectName, projectPath, manifest, {
    generatedAt: manifest.generatedAt,
    definitionsManifestHash: manifest.definitionsManifestHash,
  });
}

export async function writeGeneratedProjectManifest(
  projectName: string,
  projectPath: string
): Promise<ProjectRecord> {
  const resolvedPath = path.resolve(projectPath);
  const manifest = await buildGeneratedProjectManifestCacheFile(resolvedPath);

  const manifestPath = getGeneratedProjectManifestCachePath(resolvedPath);
  await ensureDir(path.dirname(manifestPath));
  await writeJsonFileAtomic(manifestPath, manifest);
  return toProjectRecord(projectName, resolvedPath, manifest, {
    generatedAt: manifest.generatedAt,
    definitionsManifestHash: manifest.definitionsManifestHash,
  });
}

export async function buildProjectManifestFile(projectPath: string): Promise<ProjectManifestFile> {
  const resolvedPath = path.resolve(projectPath);
  const definitions = await scanProjectDefinitions(resolvedPath);
  const manifest: ProjectManifestFile = {
    manifestVersion: PROJECT_MANIFEST_VERSION,
    definitions: definitions.definitions,
  };

  return await assertValidProjectManifest(
    manifest,
    `generated manifest for ${resolvedPath}`
  );
}

async function buildGeneratedProjectManifestCacheFile(
  projectPath: string
): Promise<GeneratedProjectManifestCacheFile> {
  const manifest = await buildProjectManifestFile(projectPath);

  return {
    ...manifest,
    generatedAt: new Date().toISOString(),
    definitionsManifestHash: hashDefinitions(manifest.definitions),
  };
}

function toProjectRecord(
  projectName: string,
  projectPath: string,
  manifest: ProjectManifestFile,
  options: {
    generatedAt: string | null;
    definitionsManifestHash: string;
  }
): ProjectRecord {
  return {
    name: projectName,
    path: projectPath,
    snapshotPath: null,
    lastSyncedAt: options.generatedAt,
    definitionsManifestHash: options.definitionsManifestHash,
    definitions: manifest.definitions,
  };
}

async function scanProjectDefinitions(projectPath: string): Promise<{
  definitions: {
    workflows: DefinitionRecord[];
    services: DefinitionRecord[];
  };
}> {
  const files = await collectSourceFiles(projectPath);
  const workflows: DefinitionRecord[] = [];
  const services: DefinitionRecord[] = [];

  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    const relativeFile = path.relative(projectPath, filePath);

    workflows.push(...scanDefinitionsInSource(source, relativeFile, "workflow"));
    services.push(...scanDefinitionsInSource(source, relativeFile, "service"));
  }

  workflows.sort(compareDefinitions);
  services.sort(compareDefinitions);

  return {
    definitions: {
      workflows,
      services,
    },
  };
}

async function collectSourceFiles(rootPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(fullPath);
        }
        continue;
      }

      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }

  await walk(rootPath);
  return results;
}

function scanDefinitionsInSource(
  source: string,
  file: string,
  kind: "workflow" | "service"
): DefinitionRecord[] {
  const records: DefinitionRecord[] = [];
  const exportPattern = new RegExp(
    `export\\s+(?:const|let|var)\\s+(\\w+)\\s*=\\s*${kind}\\s*\\(`,
    "g"
  );

  let match: RegExpExecArray | null;
  while ((match = exportPattern.exec(source)) !== null) {
    const exportName = match[1];
    if (!exportName) {
      continue;
    }

    const slice = source.slice(match.index, match.index + 1200);
    const nameMatch = /name\s*:\s*["'`]([^"'`]+)["'`]/.exec(slice);

    records.push({
      kind,
      name: nameMatch?.[1] ?? exportName,
      exportName,
      file,
      runtimeKind: "javascript",
      sourceLanguage: inferSourceLanguage(file),
    });
  }

  return records;
}

function compareDefinitions(a: DefinitionRecord, b: DefinitionRecord): number {
  return a.name.localeCompare(b.name) || a.file.localeCompare(b.file);
}

function hashDefinitions(definitions: ProjectManifestFile["definitions"]): string {
  return crypto.createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
}

function inferSourceLanguage(file: string): "typescript" | "javascript" {
  switch (path.extname(file)) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return "typescript";
    default:
      return "javascript";
  }
}

function isGeneratedProjectManifestCacheFile(
  value: unknown
): value is GeneratedProjectManifestCacheFile {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.manifestVersion === "number" &&
    typeof candidate.generatedAt === "string" &&
    typeof candidate.definitionsManifestHash === "string" &&
    candidate.definitions !== undefined
  );
}
