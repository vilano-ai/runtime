import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { readJsonFile, writeJsonFileAtomic } from "./json-file";
import { getRuntimePaths } from "./runtime-home";
import type { DefinitionRecord, ProjectRecord, RegistryFile } from "./types";

const EMPTY_REGISTRY: RegistryFile = {
  version: 1,
  projects: {},
};

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "coverage",
  "_build",
  "deps",
  ".next",
  "out",
  "spec",
]);

export async function loadRegistry(): Promise<RegistryFile> {
  const { registryFile } = getRuntimePaths();
  return readJsonFile<RegistryFile>(registryFile, EMPTY_REGISTRY);
}

export async function saveRegistry(registry: RegistryFile): Promise<void> {
  const { registryFile } = getRuntimePaths();
  await writeJsonFileAtomic(registryFile, registry);
}

export async function addProject(projectName: string, projectPath: string): Promise<ProjectRecord> {
  const resolvedPath = path.resolve(projectPath);
  const stat = await fs.stat(resolvedPath);

  if (!stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${resolvedPath}`);
  }

  const registry = await loadRegistry();

  registry.projects[projectName] = {
    name: projectName,
    path: resolvedPath,
    lastSyncedAt: null,
    definitionsManifestHash: null,
    definitions: {
      workflows: [],
      services: [],
    },
  };

  const synced = await syncProject(projectName, registry);
  await saveRegistry(registry);
  return synced;
}

export async function removeProject(projectName: string): Promise<ProjectRecord> {
  const registry = await loadRegistry();
  const project = registry.projects[projectName];

  if (!project) {
    throw new Error(`Unknown project: ${projectName}`);
  }

  delete registry.projects[projectName];
  await saveRegistry(registry);
  return project;
}

export async function getProject(projectName: string): Promise<ProjectRecord> {
  const registry = await loadRegistry();
  const project = registry.projects[projectName];

  if (!project) {
    throw new Error(`Unknown project: ${projectName}`);
  }

  return project;
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const registry = await loadRegistry();
  return Object.values(registry.projects).sort((a, b) => a.name.localeCompare(b.name));
}

export async function syncProject(projectName: string, registryArg?: RegistryFile): Promise<ProjectRecord> {
  const registry = registryArg ?? (await loadRegistry());
  const project = registry.projects[projectName];

  if (!project) {
    throw new Error(`Unknown project: ${projectName}`);
  }

  const manifest = await scanProjectDefinitions(project.path);

  project.lastSyncedAt = new Date().toISOString();
  project.definitionsManifestHash = manifest.hash;
  project.definitions = manifest.definitions;

  if (!registryArg) {
    await saveRegistry(registry);
  }

  return project;
}

export function resolveProjectForCwd(
  registry: RegistryFile,
  cwd: string
): ProjectRecord | null {
  const resolvedCwd = path.resolve(cwd);

  const matches = Object.values(registry.projects)
    .filter((project) => resolvedCwd === project.path || resolvedCwd.startsWith(`${project.path}${path.sep}`))
    .sort((a, b) => b.path.length - a.path.length);

  return matches[0] ?? null;
}

export function findDefinition(
  registry: RegistryFile,
  kind: "workflow" | "service",
  reference: string,
  cwd: string,
  explicitProject?: string
): { project: ProjectRecord; definition: DefinitionRecord } {
  const parsed = parseDefinitionReference(reference, explicitProject);

  let project: ProjectRecord | undefined;
  let definitionName: string;

  if (parsed.projectName) {
    project = registry.projects[parsed.projectName];
    definitionName = parsed.definitionName;
  } else {
    project = resolveProjectForCwd(registry, cwd) ?? undefined;
    definitionName = parsed.definitionName;
  }

  if (!project) {
    throw new Error(
      parsed.projectName
        ? `Unknown project: ${parsed.projectName}`
        : `Definition reference must include a project outside a registered project directory: ${reference}`
    );
  }

  const bucket = kind === "workflow" ? project.definitions.workflows : project.definitions.services;
  const definition = bucket.find((entry) => entry.name === definitionName);

  if (!definition) {
    throw new Error(`Unknown ${kind} '${definitionName}' in project '${project.name}'`);
  }

  return { project, definition };
}

function parseDefinitionReference(
  reference: string,
  explicitProject?: string
): { projectName: string | null; definitionName: string } {
  if (reference.includes("/")) {
    const [projectName, definitionName] = reference.split("/", 2);
    if (!projectName || !definitionName) {
      throw new Error(`Invalid definition reference: ${reference}`);
    }

    return { projectName, definitionName };
  }

  return {
    projectName: explicitProject ?? null,
    definitionName: reference,
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
    const slice = source.slice(match.index, match.index + 1200);
    const nameMatch = /name\s*:\s*["'`]([^"'`]+)["'`]/.exec(slice);

    records.push({
      kind,
      name: nameMatch?.[1] ?? exportName,
      exportName,
      file,
    });
  }

  return records;
}

function compareDefinitions(a: DefinitionRecord, b: DefinitionRecord): number {
  return a.name.localeCompare(b.name) || a.file.localeCompare(b.file);
}
