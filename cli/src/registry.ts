import fs from "node:fs/promises";
import path from "node:path";

import {
  loadGeneratedProjectManifest,
  type BuildProjectManifestOptions,
  writeGeneratedProjectManifest,
} from "./project-manifest.ts";
import type { DefinitionRecord, ProjectRecord } from "./types.ts";

export async function buildProjectManifest(
  projectName: string,
  projectPath: string,
  options: BuildProjectManifestOptions = {}
): Promise<ProjectRecord> {
  const resolvedPath = path.resolve(projectPath);
  const stat = await fs.stat(resolvedPath);

  if (!stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${resolvedPath}`);
  }

  if (!options.regenerate) {
    const generated = await loadGeneratedProjectManifest(projectName, resolvedPath);
    if (generated) {
      return generated;
    }
  }

  return await writeGeneratedProjectManifest(projectName, resolvedPath);
}

export function resolveProjectForCwd(projects: ProjectRecord[], cwd: string): ProjectRecord | null {
  const resolvedCwd = path.resolve(cwd);

  const matches = projects
    .filter((project) => resolvedCwd === project.path || resolvedCwd.startsWith(`${project.path}${path.sep}`))
    .sort((a, b) => b.path.length - a.path.length);

  return matches[0] ?? null;
}

export function findDefinition(
  projects: ProjectRecord[],
  kind: "workflow" | "service",
  reference: string,
  cwd: string,
  explicitProject?: string
): { project: ProjectRecord; definition: DefinitionRecord } {
  const parsed = parseDefinitionReference(reference, explicitProject);

  let project: ProjectRecord | undefined;
  let definitionName: string;

  if (parsed.projectName) {
    project = projects.find((entry) => entry.name === parsed.projectName);
    definitionName = parsed.definitionName;
  } else {
    project = resolveProjectForCwd(projects, cwd) ?? undefined;
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
