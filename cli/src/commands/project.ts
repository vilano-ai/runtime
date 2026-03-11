import fs from "node:fs/promises";

import {
  addProject,
  inspectProject,
  listReferencedProjectSnapshots,
  listProjects,
  removeProject,
  syncProject,
} from "../daemon-client.ts";
import { renderProject, renderProjectSummary, writeOutput } from "../output.ts";
import { materializeProjectSnapshot, pruneAllProjectSnapshots } from "../project-snapshot.ts";
import { validateProjectDefinitionsIdentity } from "../project-definition-validation.ts";
import {
  getProjectManifestPath,
  hashDefinitions,
  writeExplicitProjectManifest,
} from "../project-manifest.ts";
import { buildProjectManifest } from "../registry.ts";
import { CliError } from "../cli-error.ts";
import type { ProjectRecord } from "../types.ts";

const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function handleProjectCommand(
  args: string[],
  flags: Record<string, string | boolean>
): Promise<number> {
  const command = args[0];

  switch (command) {
    case "add": {
      const projectPath = args[1];
      const nameFlag = flags.name;

      if (!projectPath) {
        throw new CliError("Usage: vilano project add <path> --name <project>");
      }

      if (typeof nameFlag !== "string" || nameFlag.trim() === "") {
        throw new CliError("Usage: vilano project add <path> --name <project>");
      }

      if (!PROJECT_NAME_PATTERN.test(nameFlag)) {
        throw new CliError("Project name must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/");
      }

      await warnIfUsingGeneratedManifestFallback(projectPath);
      const manifest = await buildProjectManifest(nameFlag, projectPath, { regenerate: true });
      const validated = await materializeValidatedProjectSnapshot(
        nameFlag,
        manifest.path,
        manifest.definitions
      );
      manifest.snapshotPath = validated.snapshotPath;
      manifest.definitionsManifestHash = validated.definitionsManifestHash;
      const response = await addProject(manifest);
      await pruneRegisteredProjectSnapshots(response.project.name);
      writeOutput(flags, response, (body) => renderProject(body.project));
      return 0;
    }
    case "list": {
      const response = await listProjects();
      writeOutput(flags, response, (body) =>
        body.projects.length === 0
          ? "No Vilano projects registered."
          : body.projects.map(renderProjectSummary).join("\n")
      );
      return 0;
    }
    case "init-manifest": {
      return handleInitCommand(args.slice(1), flags);
    }
    case "inspect": {
      const projectName = args[1];
      if (!projectName) {
        throw new CliError("Usage: vilano project inspect <project>");
      }

      const response = await inspectProject(projectName);
      writeOutput(flags, response, (body) => renderProject(body.project));
      return 0;
    }
    case "sync": {
      const projectName = args[1];
      if (!projectName) {
        throw new CliError("Usage: vilano project sync <project>");
      }

      const existing = await inspectProject(projectName);
      await warnIfUsingGeneratedManifestFallback(existing.project.path);
      const manifest = await buildProjectManifest(existing.project.name, existing.project.path, {
        regenerate: true,
      });
      const validated = await materializeValidatedProjectSnapshot(
        existing.project.name,
        manifest.path,
        manifest.definitions
      );
      manifest.snapshotPath = validated.snapshotPath;
      manifest.definitionsManifestHash = validated.definitionsManifestHash;
      const response = await syncProject(manifest);
      await pruneRegisteredProjectSnapshots(response.project.name);
      writeOutput(flags, response, (body) => renderProject(body.project));
      return 0;
    }
    case "remove": {
      const projectName = args[1];
      if (!projectName) {
        throw new CliError("Usage: vilano project remove <project>");
      }

      const response = await removeProject(projectName);
      await pruneRegisteredProjectSnapshots(projectName);
      writeOutput(flags, response, (body) => `Removed project ${body.project.name}`);
      return 0;
    }
    default:
      throw new CliError("Usage: vilano project add|list|inspect|sync|remove");
  }
}

export async function handleInitCommand(
  args: string[],
  flags: Record<string, string | boolean>
): Promise<number> {
  const projectPath = args[0] ?? ".";
  const result = await writeExplicitProjectManifest(projectPath, {
    force: Boolean(flags.force),
  });

  writeOutput(
    flags,
    { ok: true, manifestPath: result.manifestPath, manifest: result.manifest },
    (body) =>
      [
        `Wrote ${body.manifestPath}`,
        `workflows: ${body.manifest.definitions.workflows.length}`,
        `services: ${body.manifest.definitions.services.length}`,
        "Review the generated manifest before relying on it; non-trivial export patterns may need manual edits.",
        "",
        "Next steps:",
        `  vilano project add ${projectPath === "." ? "." : projectPath} --name <project>`,
      ].join("\n")
  );

  return 0;
}

async function pruneRegisteredProjectSnapshots(_projectName: string): Promise<void> {
  const references = await listReferencedProjectSnapshots();
  await pruneAllProjectSnapshots(references.snapshotPaths);
}

async function materializeValidatedProjectSnapshot(
  projectName: string,
  projectPath: string,
  definitions: ProjectRecord["definitions"]
): Promise<{ snapshotPath: string; definitionsManifestHash: string }> {
  const snapshotPath = await materializeProjectSnapshot(projectName, projectPath);

  try {
    const validated = await validateProjectDefinitionsIdentity(snapshotPath, [
      ...definitions.workflows,
      ...definitions.services,
    ]);

    definitions.workflows = validated.filter((definition) => definition.kind === "workflow");
    definitions.services = validated.filter((definition) => definition.kind === "service");

    return {
      snapshotPath,
      definitionsManifestHash: hashDefinitions(definitions),
    };
  } catch (error) {
    await fs.rm(snapshotPath, { recursive: true, force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Project registration failed definition validation: ${message}`);
  }
}

async function warnIfUsingGeneratedManifestFallback(projectPath: string): Promise<void> {
  try {
    await fs.access(getProjectManifestPath(projectPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(
        "Vilano Runtime is using generated manifest fallback for this project. Run `vilano init <path>` to create the recommended explicit contract.\n"
      );
      return;
    }

    throw error;
  }
}
