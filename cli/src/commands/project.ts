import {
  addProject,
  inspectProject,
  listReferencedProjectSnapshots,
  listProjects,
  removeProject,
  syncProject,
} from "../daemon-client.ts";
import { renderProject, renderProjectSummary, writeOutput } from "../output.ts";
import { materializeProjectSnapshot, pruneProjectSnapshots } from "../project-snapshot.ts";
import { buildProjectManifest } from "../registry.ts";
import { CliError } from "../cli-error.ts";

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

      const manifest = await buildProjectManifest(nameFlag, projectPath, { regenerate: true });
      manifest.snapshotPath = await materializeProjectSnapshot(nameFlag, manifest.path);
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
      const manifest = await buildProjectManifest(existing.project.name, existing.project.path, {
        regenerate: true,
      });
      manifest.snapshotPath = await materializeProjectSnapshot(existing.project.name, manifest.path);
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

async function pruneRegisteredProjectSnapshots(projectName: string): Promise<void> {
  const references = await listReferencedProjectSnapshots(projectName);
  await pruneProjectSnapshots(projectName, references.snapshotPaths);
}
