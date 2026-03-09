import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ensurePrivateDir, writeJsonFileAtomic } from "./json-file.ts";
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

  await ensurePrivateDir(path.dirname(snapshotRoot));
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
  await sealSnapshot(snapshotRoot);

  return snapshotRoot;
}

export async function pruneProjectSnapshots(
  projectName: string,
  retainedSnapshotPaths: Iterable<string>
): Promise<void> {
  const runtimePaths = getRuntimePaths();
  const projectSnapshotRoot = path.join(runtimePaths.projectSnapshotsDir, projectName);
  const retained = new Set(
    [...retainedSnapshotPaths]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => path.resolve(value))
  );

  let entries;
  try {
    entries = await fs.readdir(projectSnapshotRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) {
        return;
      }

      const snapshotPath = path.join(projectSnapshotRoot, entry.name);
      if (!retained.has(snapshotPath)) {
        await fs.rm(snapshotPath, { recursive: true, force: true });
      }
    })
  );

  const remaining = await fs.readdir(projectSnapshotRoot).catch(() => []);
  if (remaining.length === 0) {
    await fs.rm(projectSnapshotRoot, { recursive: true, force: true });
  }
}

export async function pruneAllProjectSnapshots(retainedSnapshotPaths: Iterable<string>): Promise<void> {
  const runtimePaths = getRuntimePaths();
  const retained = new Set(
    [...retainedSnapshotPaths]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => path.resolve(value))
  );

  let projects;
  try {
    projects = await fs.readdir(runtimePaths.projectSnapshotsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  await Promise.all(
    projects.map(async (entry) => {
      if (!entry.isDirectory()) {
        return;
      }

      await pruneProjectSnapshots(entry.name, retained);
    })
  );
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

  const dependencySource = await resolveDependencySource(sourcePath);
  if (!dependencySource) {
    return;
  }

  await fs.cp(dependencySource, snapshotNodeModules, {
    recursive: true,
    force: true,
    dereference: true,
  });
}

async function resolveDependencySource(sourcePath: string): Promise<string | null> {
  let currentPath = sourcePath;

  while (true) {
    const candidate = path.join(currentPath, "node_modules");

    try {
      const stat = await fs.lstat(candidate);

      if (stat.isDirectory()) {
        return candidate;
      }

      if (stat.isSymbolicLink()) {
        const resolvedPath = await fs.realpath(candidate);
        const resolvedStat = await fs.stat(resolvedPath);
        if (resolvedStat.isDirectory()) {
          return resolvedPath;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }

    currentPath = parentPath;
  }
}

async function sealSnapshot(rootPath: string): Promise<void> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await sealSnapshot(entryPath);
      await fs.chmod(entryPath, 0o555);
      continue;
    }

    if (entry.isFile()) {
      await fs.chmod(entryPath, 0o444);
    }
  }

  await fs.chmod(rootPath, 0o555);
}
