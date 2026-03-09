import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, readJsonFile, writeJsonFileAtomic } from "./json-file.ts";
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

const PROJECT_MANIFEST_VERSION = 1;

interface GeneratedProjectManifestFile {
  manifestVersion: number;
  generatedAt: string;
  definitionsManifestHash: string;
  definitions: {
    workflows: DefinitionRecord[];
    services: DefinitionRecord[];
  };
}

export interface BuildProjectManifestOptions {
  regenerate?: boolean;
}

export function getProjectManifestPath(projectPath: string): string {
  return path.join(projectPath, ".vilano", "project-manifest.json");
}

export async function loadGeneratedProjectManifest(
  projectName: string,
  projectPath: string
): Promise<ProjectRecord | null> {
  const resolvedPath = path.resolve(projectPath);
  const manifestPath = getProjectManifestPath(resolvedPath);
  const manifest = await readJsonFile<GeneratedProjectManifestFile | null>(manifestPath, null);

  if (!manifest || manifest.manifestVersion !== PROJECT_MANIFEST_VERSION) {
    return null;
  }

  return toProjectRecord(projectName, resolvedPath, manifest);
}

export async function writeGeneratedProjectManifest(
  projectName: string,
  projectPath: string
): Promise<ProjectRecord> {
  const resolvedPath = path.resolve(projectPath);
  const definitions = await scanProjectDefinitions(resolvedPath);
  const manifest: GeneratedProjectManifestFile = {
    manifestVersion: PROJECT_MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    definitionsManifestHash: definitions.hash,
    definitions: definitions.definitions,
  };

  const manifestPath = getProjectManifestPath(resolvedPath);
  await ensureDir(path.dirname(manifestPath));
  await writeJsonFileAtomic(manifestPath, manifest);
  return toProjectRecord(projectName, resolvedPath, manifest);
}

function toProjectRecord(
  projectName: string,
  projectPath: string,
  manifest: GeneratedProjectManifestFile
): ProjectRecord {
  return {
    name: projectName,
    path: projectPath,
    lastSyncedAt: manifest.generatedAt,
    definitionsManifestHash: manifest.definitionsManifestHash,
    definitions: manifest.definitions,
  };
}

async function scanProjectDefinitions(projectPath: string): Promise<{
  hash: string;
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

  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        workflows,
        services,
      })
    )
    .digest("hex");

  return {
    hash,
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
      sourceLanguage: "typescript",
    });
  }

  return records;
}

function compareDefinitions(a: DefinitionRecord, b: DefinitionRecord): number {
  return a.name.localeCompare(b.name) || a.file.localeCompare(b.file);
}
