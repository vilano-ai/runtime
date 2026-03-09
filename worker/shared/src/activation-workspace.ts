import fs from "node:fs/promises";
import path from "node:path";

import type { ServiceTurnActivation, WorkflowActivation } from "./client.ts";

type Activation = WorkflowActivation | ServiceTurnActivation;

export async function ensureActivationWorkspace(
  workerHome: string,
  activation: Activation
): Promise<string> {
  const workspacesRoot = path.join(workerHome, "run-workspaces");
  const workspacePath = path.join(workspacesRoot, activation.run.id);
  const workspaceMetadataPath = path.join(workspacePath, ".vilano-workspace.json");

  try {
    const stat = await fs.stat(workspacePath);
    if (stat.isDirectory()) {
      return workspacePath;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(workspacesRoot, { recursive: true });

  const tempWorkspacePath = `${workspacePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

  try {
    await fs.cp(activation.project.path, tempWorkspacePath, {
      recursive: true,
      force: true,
      dereference: true,
      filter: (_src, dest) => path.basename(dest) !== "node_modules",
    });

    await makeWorkspaceWritable(tempWorkspacePath);
    await linkWorkspaceNodeModules(activation.project.path, tempWorkspacePath);

    await fs.writeFile(
      workspaceMetadataPathFor(tempWorkspacePath),
      `${JSON.stringify(
        {
          version: 1,
          runId: activation.run.id,
          sourceSnapshotPath: activation.project.path,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    try {
      await fs.rename(tempWorkspacePath, workspacePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      await fs.rm(tempWorkspacePath, { recursive: true, force: true });
    }

    return workspacePath;
  } catch (error) {
    await fs.rm(tempWorkspacePath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function ensureActivationImportRoot(
  workerHome: string,
  activation: Activation
): Promise<string> {
  const importsRoot = path.join(workerHome, "activation-imports");
  const importRoot = path.join(importsRoot, activation.leaseId);

  try {
    const stat = await fs.stat(importRoot);
    if (stat.isDirectory()) {
      return importRoot;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(importsRoot, { recursive: true });
  const tempImportRoot = `${importRoot}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

  try {
    await fs.cp(activation.project.path, tempImportRoot, {
      recursive: true,
      force: true,
      dereference: true,
      filter: (_src, dest) => path.basename(dest) !== "node_modules",
    });

    const importRootStat = await fs.stat(tempImportRoot);
    await fs.chmod(tempImportRoot, importRootStat.mode | 0o200);
    await linkWorkspaceNodeModules(activation.project.path, tempImportRoot);

    await fs.writeFile(
      workspaceMetadataPathFor(tempImportRoot),
      `${JSON.stringify(
        {
          version: 1,
          leaseId: activation.leaseId,
          runId: activation.run.id,
          sourceSnapshotPath: activation.project.path,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    try {
      await fs.rename(tempImportRoot, importRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      await fs.rm(tempImportRoot, { recursive: true, force: true });
    }

    await fs.chmod(importRoot, importRootStat.mode);

    return importRoot;
  } catch (error) {
    await fs.rm(tempImportRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function makeWorkspaceWritable(rootPath: string): Promise<void> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      await makeWorkspaceWritable(entryPath);
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    const stat = await fs.stat(entryPath);
    await fs.chmod(entryPath, stat.mode | 0o200);
  }

  const rootStat = await fs.stat(rootPath);
  await fs.chmod(rootPath, rootStat.mode | 0o200);
}

function workspaceMetadataPathFor(workspacePath: string): string {
  return path.join(workspacePath, ".vilano-workspace.json");
}

async function linkWorkspaceNodeModules(snapshotPath: string, workspacePath: string): Promise<void> {
  const snapshotNodeModules = path.join(snapshotPath, "node_modules");

  try {
    const stat = await fs.stat(snapshotNodeModules);
    if (!stat.isDirectory()) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  const workspaceNodeModules = path.join(workspacePath, "node_modules");
  await fs.symlink(snapshotNodeModules, workspaceNodeModules, "dir");
}
