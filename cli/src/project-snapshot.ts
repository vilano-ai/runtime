import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, writeJsonFileAtomic } from "./json-file.ts";
import { getRuntimePaths } from "./runtime-home.ts";

const SNAPSHOT_EXCLUDED_NAMES = new Set([".git", ".hg", ".svn", ".vilano", "tmp"]);

interface ProjectSnapshotMetadata {
  version: 1;
  projectName: string;
  sourcePath: string;
  createdAt: string;
}

export async function materializeProjectSnapshot(
  projectName: string,
  projectPath: string
): Promise<string> {
  const runtimePaths = getRuntimePaths();
  const sourcePath = path.resolve(projectPath);
  const snapshotId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const snapshotRoot = path.join(runtimePaths.projectSnapshotsDir, projectName, snapshotId);

  await ensureDir(path.dirname(snapshotRoot));
  await fs.cp(sourcePath, snapshotRoot, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (_src, dest) => !SNAPSHOT_EXCLUDED_NAMES.has(path.basename(dest)),
  });
  await ensureDependencyResolution(sourcePath, snapshotRoot);

  await writeJsonFileAtomic(path.join(snapshotRoot, ".vilano-snapshot.json"), {
    version: 1,
    projectName,
    sourcePath,
    createdAt: new Date().toISOString(),
  } satisfies ProjectSnapshotMetadata);

  return snapshotRoot;
}

async function ensureDependencyResolution(sourcePath: string, snapshotRoot: string): Promise<void> {
  const snapshotNodeModules = path.join(snapshotRoot, "node_modules");

  try {
    await fs.lstat(snapshotNodeModules);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const sourceNodeModules = path.join(sourcePath, "node_modules");
  try {
    const stat = await fs.lstat(sourceNodeModules);
    if (stat.isSymbolicLink()) {
      throw new Error(`Project node_modules must not be a symbolic link: ${sourceNodeModules}`);
    }

    if (!stat.isDirectory()) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  await fs.cp(sourceNodeModules, snapshotNodeModules, {
    recursive: true,
    force: true,
    dereference: true,
  });
}
