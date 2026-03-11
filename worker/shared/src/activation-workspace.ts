import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ServiceTurnActivation, WorkflowActivation } from "./client.ts";

type Activation = WorkflowActivation | ServiceTurnActivation;

export async function ensureActivationWorkspace(
  workerHome: string,
  activation: Activation,
  activationImportRoot: string
): Promise<string> {
  const workspacesRoot = path.join(workerHome, "run-workspaces");
  const workspacePath = path.join(workspacesRoot, activation.leaseId);

  await fs.mkdir(workspacesRoot, { recursive: true });

  const tempWorkspacePath = `${workspacePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

  try {
    await fs.cp(activationImportRoot, tempWorkspacePath, {
      recursive: true,
      force: true,
      dereference: true,
      filter: (_src, dest) => path.basename(dest) !== "node_modules",
    });

    await makeWorkspaceWritable(tempWorkspacePath);
    await linkActivationNodeModules(activationImportRoot, tempWorkspacePath);

    try {
      await fs.rename(tempWorkspacePath, workspacePath);
    } catch (error) {
      if (!(await shouldReuseExistingPath(error, workspacePath))) {
        throw error;
      }

      await removeTree(tempWorkspacePath);
    }

    return workspacePath;
  } catch (error) {
    await removeTree(tempWorkspacePath);
    throw error;
  }
}

export async function ensureActivationImportRoot(
  workerHome: string,
  activation: Activation
): Promise<string> {
  const importsRoot = path.join(workerHome, "import-cache");
  const importRoot = path.join(importsRoot, await importCacheKey(activation.project.path));

  await fs.mkdir(importsRoot, { recursive: true });
  const tempImportRoot = `${importRoot}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

  try {
    await copyActivationTree(activation.project.path, tempImportRoot);
    const importRootStat = await fs.stat(tempImportRoot);
    await fs.chmod(tempImportRoot, importRootStat.mode | 0o200);

    try {
      await fs.rename(tempImportRoot, importRoot);
    } catch (error) {
      if (!(await shouldReuseExistingPath(error, importRoot))) {
        throw error;
      }

      await removeTree(tempImportRoot);
    }

    await fs.chmod(importRoot, importRootStat.mode);

    return importRoot;
  } catch (error) {
    await removeTree(tempImportRoot);
    throw error;
  }
}

async function copyActivationTree(sourcePath: string, destinationPath: string): Promise<void> {
  await fs.cp(sourcePath, destinationPath, {
    recursive: true,
    force: true,
    dereference: true,
  });
}

async function makeWorkspaceWritable(rootPath: string, rootRelativePath = ""): Promise<void> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    const entryRelativePath =
      rootRelativePath.length === 0 ? entry.name : path.join(rootRelativePath, entry.name);
    const topLevelSegment = entryRelativePath.split(path.sep)[0];

    if (topLevelSegment === "node_modules") {
      continue;
    }

    if (entry.isDirectory()) {
      await makeWorkspaceWritable(entryPath, entryRelativePath);
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

async function linkActivationNodeModules(importRoot: string, workspacePath: string): Promise<void> {
  const importNodeModules = path.join(importRoot, "node_modules");

  try {
    const stat = await fs.stat(importNodeModules);
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
  await fs.symlink(importNodeModules, workspaceNodeModules, "dir");
}

async function importCacheKey(projectPath: string): Promise<string> {
  const resolvedPath = await fs.realpath(projectPath);
  return crypto.createHash("sha256").update(resolvedPath).digest("hex").slice(0, 16);
}

async function shouldReuseExistingPath(
  error: unknown,
  destinationPath: string
): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST" || code === "ENOTEMPTY") {
    return true;
  }

  if (code !== "EACCES") {
    return false;
  }

  try {
    await fs.lstat(destinationPath);
    return true;
  } catch (lookupError) {
    if ((lookupError as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw lookupError;
  }
}

async function removeTree(rootPath: string): Promise<void> {
  await makeTreeWritableForRemoval(rootPath).catch(() => undefined);
  await fs.rm(rootPath, { recursive: true, force: true }).catch(() => undefined);
}

async function makeTreeWritableForRemoval(rootPath: string): Promise<void> {
  const stat = await fs.lstat(rootPath);

  if (stat.isSymbolicLink()) {
    return;
  }

  if (stat.isDirectory()) {
    const entries = await fs.readdir(rootPath);
    await Promise.all(entries.map((entry) => makeTreeWritableForRemoval(path.join(rootPath, entry))));
  }

  await fs.chmod(rootPath, stat.mode | 0o200);
}
