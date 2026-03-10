import path from "node:path";
import fs from "node:fs/promises";

import {
  buildProjectManifestFile,
  getProjectManifestPath,
  loadExplicitProjectManifest,
} from "../cli/src/project-manifest.ts";
import { validateProjectManifest } from "../cli/src/project-manifest-contract.ts";
import type { DefinitionRecord, ProjectRecord } from "../cli/src/types.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const examplesRoot = path.join(ROOT, "examples");
const exampleProjectPaths = await collectExampleProjects(examplesRoot);
const summaries: Array<{
  example: string;
  manifestPath: string;
  workflows: number;
  services: number;
}> = [];

for (const exampleProjectPath of exampleProjectPaths) {
  const generatedManifest = await buildProjectManifestFile(exampleProjectPath);
  const validation = await validateProjectManifest(generatedManifest, {
    projectPath: exampleProjectPath,
  });

  if (!validation.ok) {
    throw new Error(
      `Generated manifest for ${path.basename(exampleProjectPath)} does not satisfy protocol/v1/project-manifest.schema.json: ${validation.errors.join("; ")}`
    );
  }

  const explicitManifest = await loadExplicitProjectManifest(path.basename(exampleProjectPath), exampleProjectPath);
  if (!explicitManifest) {
    throw new Error(`Expected explicit manifest at ${getProjectManifestPath(exampleProjectPath)}`);
  }

  if (!definitionsEqual(explicitManifest.definitions, generatedManifest.definitions)) {
    throw new Error(
      `Explicit manifest drift detected for ${path.basename(exampleProjectPath)}. Re-run 'vilano init ${exampleProjectPath}' and review the result.`
    );
  }

  summaries.push({
    example: path.basename(exampleProjectPath),
    manifestPath: getProjectManifestPath(exampleProjectPath),
    workflows: generatedManifest.definitions.workflows.length,
    services: generatedManifest.definitions.services.length,
  });
}

process.stdout.write(`${JSON.stringify({ ok: true, examples: summaries }, null, 2)}\n`);

async function collectExampleProjects(rootPath: string): Promise<string[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const projectPath = path.join(rootPath, entry.name);
    try {
      await fs.access(getProjectManifestPath(projectPath));
      results.push(projectPath);
    } catch {
      continue;
    }
  }

  return results.sort();
}

function definitionsEqual(
  left: ProjectRecord["definitions"],
  right: ProjectRecord["definitions"]
): boolean {
  return (
    JSON.stringify(normalizeDefinitions(left.workflows)) ===
      JSON.stringify(normalizeDefinitions(right.workflows)) &&
    JSON.stringify(normalizeDefinitions(left.services)) ===
      JSON.stringify(normalizeDefinitions(right.services))
  );
}

function normalizeDefinitions(definitions: DefinitionRecord[]): DefinitionRecord[] {
  return [...definitions].sort((left, right) =>
    [
      left.kind,
      left.name,
      left.exportName,
      left.file,
      left.runtimeKind,
      left.sourceLanguage,
    ]
      .join("\u0000")
      .localeCompare(
        [
          right.kind,
          right.name,
          right.exportName,
          right.file,
          right.runtimeKind,
          right.sourceLanguage,
        ].join("\u0000")
      )
  );
}
