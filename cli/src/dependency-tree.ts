import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, readJsonFile } from "./json-file.ts";

export async function copyPackageDependencyTree(
  sourceRoot: string,
  targetRoot: string
): Promise<void> {
  const seen = new Set<string>();
  const rootPackage = await readJsonFile<{ dependencies?: Record<string, string> }>(
    path.join(sourceRoot, "package.json"),
    {}
  );

  const queue = Object.keys(rootPackage.dependencies ?? {}).map((dependency) => ({
    name: dependency,
    resolveFrom: sourceRoot,
  }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next.name)) {
      continue;
    }

    const resolved = await resolveDependencyInstallPath(next.resolveFrom, next.name);
    if (!resolved) {
      continue;
    }

    seen.add(next.name);
    const sourcePath = await fs.realpath(resolved);
    const dependencyTarget = path.join(targetRoot, "node_modules", next.name);
    await ensureDir(path.dirname(dependencyTarget));
    await fs.cp(sourcePath, dependencyTarget, {
      recursive: true,
      force: true,
    });

    const packageJson = await readJsonFile<{ dependencies?: Record<string, string> }>(
      path.join(sourcePath, "package.json"),
      {}
    );

    queue.push(
      ...Object.keys(packageJson.dependencies ?? {}).map((dependency) => ({
        name: dependency,
        resolveFrom: sourcePath,
      }))
    );
  }
}

async function resolveDependencyInstallPath(
  startDir: string,
  dependency: string
): Promise<string | null> {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, "node_modules", dependency);
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      return null;
    }

    currentDir = parent;
  }
}
