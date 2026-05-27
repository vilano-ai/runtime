import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ensurePrivateDir } from "./json-file.ts";
import { getRuntimePaths } from "./runtime-home.ts";

const DEFAULT_SNAPSHOT_GLOBALLY_EXCLUDED_NAMES = [
  ".assembly-runtime",
  ".git",
  ".hg",
  ".svn",
  ".vilano",
];
const DEFAULT_SNAPSHOT_ROOT_EXCLUDED_NAMES = [
  ".cache",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "coverage",
  "logs",
  "tmp",
];
const DEFAULT_SNAPSHOT_ROOT_EXCLUDED_FILE_SUFFIXES = [".log"];
const PENDING_SNAPSHOT_DIR = ".pending";
const PENDING_SNAPSHOT_MIN_AGE_MS = 5 * 60 * 1000;

export interface ProjectSnapshotOptions {
  excludes?: readonly string[];
  includeNodeModules?: boolean;
}

interface NormalizedSnapshotOptions {
  excludedNames: Set<string>;
  excludedPaths: Set<string>;
  rootExcludedNames: Set<string>;
  includeNodeModules: boolean;
}

export async function materializeProjectSnapshot(
  projectName: string,
  projectPath: string,
  options: ProjectSnapshotOptions = snapshotOptionsFromEnv()
): Promise<string> {
  const runtimePaths = getRuntimePaths();
  const sourcePath = path.resolve(projectPath);
  const snapshotOptions = normalizeSnapshotOptions(options);
  const snapshotId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const snapshotRoot = path.join(runtimePaths.projectSnapshotsDir, projectName, snapshotId);
  const tempSnapshotRoot = `${snapshotRoot}.tmp-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await ensurePrivateDir(path.dirname(snapshotRoot));
    await writeProjectSnapshotPendingMarker(snapshotRoot);
    await fs.cp(sourcePath, tempSnapshotRoot, {
      recursive: true,
      force: true,
      dereference: true,
      filter: (src) => shouldCopySnapshotEntry(sourcePath, src, snapshotOptions),
    });
    if (snapshotOptions.includeNodeModules) {
      await ensureDependencyResolution(sourcePath, tempSnapshotRoot);
    }
    await fs.rename(tempSnapshotRoot, snapshotRoot);
    await fs.utimes(snapshotRoot, new Date(), new Date());
    await sealSnapshot(snapshotRoot);
  } catch (error) {
    await removeProjectSnapshot(tempSnapshotRoot).catch(() => undefined);
    await removeProjectSnapshot(snapshotRoot).catch(() => undefined);
    await clearProjectSnapshotPendingMarker(snapshotRoot).catch(() => undefined);
    throw error;
  }

  return snapshotRoot;
}

export async function releaseProjectSnapshot(snapshotPath: string): Promise<void> {
  await clearProjectSnapshotPendingMarker(snapshotPath);
}

function projectSnapshotPendingMarkerPath(snapshotPath: string): string {
  return path.join(
    path.dirname(snapshotPath),
    PENDING_SNAPSHOT_DIR,
    `${projectSnapshotPendingBasename(snapshotPath)}.pending`
  );
}

function projectSnapshotPendingBasename(snapshotPath: string): string {
  return path.basename(snapshotPath).split(".tmp-", 1)[0] ?? path.basename(snapshotPath);
}

async function writeProjectSnapshotPendingMarker(snapshotPath: string): Promise<void> {
  const markerPath = projectSnapshotPendingMarkerPath(snapshotPath);
  await ensurePrivateDir(path.dirname(markerPath));
  await fs.writeFile(markerPath, snapshotPath, "utf8");
}

async function clearProjectSnapshotPendingMarker(snapshotPath: string): Promise<void> {
  const markerPath = projectSnapshotPendingMarkerPath(snapshotPath);
  await fs.rm(markerPath, { force: true });
  await fs.rmdir(path.dirname(markerPath)).catch(() => undefined);
}

async function hasActiveProjectSnapshotPendingMarker(snapshotPath: string): Promise<boolean> {
  const markerPath = projectSnapshotPendingMarkerPath(snapshotPath);

  try {
    const stat = await fs.stat(markerPath);
    return Date.now() - stat.mtimeMs < PENDING_SNAPSHOT_MIN_AGE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export function snapshotOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ProjectSnapshotOptions {
  return {
    excludes: parseSnapshotExcludesEnv(env.VILANO_SNAPSHOT_EXCLUDES),
    includeNodeModules: parseSnapshotBooleanEnv(env.VILANO_SNAPSHOT_INCLUDE_NODE_MODULES, true),
  };
}

function normalizeSnapshotOptions(options: ProjectSnapshotOptions): NormalizedSnapshotOptions {
  const includeNodeModules = options.includeNodeModules ?? true;
  const excludedNames = new Set(DEFAULT_SNAPSHOT_GLOBALLY_EXCLUDED_NAMES);
  const excludedPaths = new Set<string>();
  const rootExcludedNames = new Set(DEFAULT_SNAPSHOT_ROOT_EXCLUDED_NAMES);

  if (!includeNodeModules) {
    excludedNames.add("node_modules");
  }

  for (const exclude of options.excludes ?? []) {
    const normalized = normalizeExcludeRule(exclude);
    if (!normalized) {
      continue;
    }

    if (normalized.includes("/")) {
      excludedPaths.add(normalized);
    } else {
      excludedNames.add(normalized);
    }
  }

  return {
    excludedNames,
    excludedPaths,
    rootExcludedNames,
    includeNodeModules: includeNodeModules && !excludedNames.has("node_modules"),
  };
}

function shouldCopySnapshotEntry(
  sourceRoot: string,
  sourcePath: string,
  options: NormalizedSnapshotOptions
): boolean {
  const relativePath = normalizeRelativePath(path.relative(sourceRoot, sourcePath));
  if (relativePath === "") {
    return true;
  }

  const basename = path.basename(sourcePath);
  if (options.excludedNames.has(basename)) {
    return false;
  }

  const isRootEntry = !relativePath.includes("/");
  if (isRootEntry && options.rootExcludedNames.has(basename)) {
    return false;
  }

  if (
    isRootEntry &&
    DEFAULT_SNAPSHOT_ROOT_EXCLUDED_FILE_SUFFIXES.some((suffix) => basename.endsWith(suffix))
  ) {
    return false;
  }

  for (const excludedPath of options.excludedPaths) {
    if (relativePath === excludedPath || relativePath.startsWith(`${excludedPath}/`)) {
      return false;
    }
  }

  return true;
}

function parseSnapshotExcludesEnv(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
        return parsed;
      }
    } catch {
      return [];
    }

    return [];
  }

  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseSnapshotBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return defaultValue;
  }
}

function normalizeExcludeRule(value: string): string | null {
  const normalized = normalizeRelativePath(value.trim());
  if (normalized === "" || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    return null;
  }

  if (path.isAbsolute(value)) {
    return null;
  }

  return normalized;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\/+/, "").replace(/\/+$/, "");
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

      if (entry.name === PENDING_SNAPSHOT_DIR) {
        return;
      }

      const snapshotPath = path.join(projectSnapshotRoot, entry.name);
      if (await hasActiveProjectSnapshotPendingMarker(snapshotPath)) {
        return;
      }

      if (!retained.has(snapshotPath)) {
        await removeProjectSnapshot(snapshotPath);
      }
    })
  );

  await pruneStaleProjectSnapshotPendingMarkers(projectSnapshotRoot);

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

async function pruneStaleProjectSnapshotPendingMarkers(projectSnapshotRoot: string): Promise<void> {
  const pendingRoot = path.join(projectSnapshotRoot, PENDING_SNAPSHOT_DIR);
  let entries;

  try {
    entries = await fs.readdir(pendingRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }

      const markerPath = path.join(pendingRoot, entry.name);
      const stat = await fs.stat(markerPath);
      if (Date.now() - stat.mtimeMs >= PENDING_SNAPSHOT_MIN_AGE_MS) {
        await fs.rm(markerPath, { force: true });
      }
    })
  );

  await fs.rmdir(pendingRoot).catch(() => undefined);
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

  await sealSnapshot(snapshotNodeModules);
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

export async function removeProjectSnapshot(snapshotPath: string): Promise<void> {
  await clearProjectSnapshotPendingMarker(snapshotPath);
  await makeSnapshotDirectoriesWritable(snapshotPath);
  await fs.rm(snapshotPath, { recursive: true, force: true });
}

async function makeSnapshotDirectoriesWritable(rootPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(rootPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (!stat.isDirectory()) {
    return;
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    await makeSnapshotDirectoriesWritable(path.join(rootPath, entry.name));
  }

  await fs.chmod(rootPath, stat.mode | 0o200);
}
