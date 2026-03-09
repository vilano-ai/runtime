import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, writeJsonFileAtomic } from "./json-file.ts";
import { getRuntimePaths } from "./runtime-home.ts";

const SNAPSHOT_EXCLUDED_NAMES = new Set([".git", ".hg", ".svn", ".vilano"]);

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

  const sourceNodeModules = await findNearestNodeModules(sourcePath);
  if (!sourceNodeModules) {
    return;
  }

  await fs.symlink(sourceNodeModules, snapshotNodeModules, "dir");
}

async function findNearestNodeModules(startPath: string): Promise<string | null> {
  let current = path.resolve(startPath);

  while (true) {
    const candidate = path.join(current, "node_modules");

    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}
