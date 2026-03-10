import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { CliError } from "./cli-error.ts";
import type { ReleaseChannel, RuntimeInstallManifest } from "./distribution-contract.ts";
import { ensureDir, readJsonFile, writeJsonFileAtomic } from "./json-file.ts";
import { getRuntimePaths } from "./runtime-home.ts";

const INSTALL_STATE_VERSION = 1;

interface InstallState {
  version: typeof INSTALL_STATE_VERSION;
  currentVersion: string | null;
  previousVersion: string | null;
  channel: ReleaseChannel;
  updatedAt: string;
}

export async function readInstallState(): Promise<InstallState | null> {
  return await readJsonFile<InstallState | null>(getRuntimePaths().installStateFile, null);
}

export async function writeInstallState(input: {
  currentVersion: string | null;
  previousVersion: string | null;
  channel: ReleaseChannel;
}): Promise<InstallState> {
  const state: InstallState = {
    version: INSTALL_STATE_VERSION,
    currentVersion: input.currentVersion,
    previousVersion: input.previousVersion,
    channel: input.channel,
    updatedAt: new Date().toISOString(),
  };

  await writeJsonFileAtomic(getRuntimePaths().installStateFile, state);
  return state;
}

export function getInstalledVersionRoot(version: string): string {
  return path.join(getRuntimePaths().installsDir, version);
}

export async function readInstalledManifest(version: string): Promise<RuntimeInstallManifest | null> {
  return await readJsonFile<RuntimeInstallManifest | null>(
    path.join(getInstalledVersionRoot(version), "runtime-dist", "install-manifest.json"),
    null
  );
}

export async function switchCurrentInstall(
  version: string,
  channel: ReleaseChannel,
  options: { previousVersion?: string | null } = {}
): Promise<void> {
  const runtimePaths = getRuntimePaths();
  const targetRoot = getInstalledVersionRoot(version);
  const manifest = await readInstalledManifest(version);

  if (!manifest) {
    throw new CliError(`Installed runtime ${version} is missing runtime-dist/install-manifest.json`);
  }

  const previousVersion =
    options.previousVersion !== undefined
      ? options.previousVersion
      : (await readInstallState())?.currentVersion ?? null;
  await ensureDir(runtimePaths.installRootDir);
  await ensureDir(runtimePaths.binDir);
  await fs.rm(runtimePaths.currentInstallLink, { force: true, recursive: true }).catch(() => undefined);
  await fs.symlink(targetRoot, runtimePaths.currentInstallLink, "dir");
  await writeManagedLauncher();
  await writeInstallState({
    currentVersion: version,
    previousVersion: previousVersion === version ? null : previousVersion,
    channel,
  });
}

export async function installCliRoot(sourceCliRoot: string, targetRoot: string): Promise<void> {
  await fs.rm(targetRoot, { recursive: true, force: true });
  await ensureDir(path.dirname(targetRoot));
  await fs.cp(sourceCliRoot, targetRoot, {
    recursive: true,
    force: true,
  });

  await vendorCliDependencies(sourceCliRoot, targetRoot);
}

export async function unpackArtifactToInstallRoot(
  archivePath: string,
  targetRoot: string
): Promise<void> {
  const stagingRoot = `${targetRoot}.staging`;
  await fs.rm(stagingRoot, { recursive: true, force: true });
  await ensureDir(stagingRoot);

  await runTarExtract(archivePath, stagingRoot);
  const normalizedRoot = await normalizeExtractedRoot(stagingRoot);

  if (normalizedRoot !== stagingRoot) {
    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.rename(normalizedRoot, targetRoot);
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    return;
  }

  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.rename(stagingRoot, targetRoot);
}

async function writeManagedLauncher(): Promise<void> {
  const runtimePaths = getRuntimePaths();
  const launcherPath = path.join(runtimePaths.binDir, "vilano");
  const body = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'INSTALL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"',
    'CURRENT_ROOT="$INSTALL_ROOT/current"',
    'exec bun "$CURRENT_ROOT/bin/vilano.ts" "$@"',
    "",
  ].join("\n");

  await fs.writeFile(launcherPath, body, "utf8");
  await fs.chmod(launcherPath, 0o755);
}

async function vendorCliDependencies(sourceCliRoot: string, targetRoot: string): Promise<void> {
  const packageJson = await readJsonFile<{ dependencies?: Record<string, string> }>(
    path.join(sourceCliRoot, "package.json"),
    {}
  );
  const dependencies = Object.keys(packageJson.dependencies ?? {});

  if (dependencies.length === 0) {
    return;
  }

  for (const dependency of dependencies) {
    const resolved = await resolveDependencyInstallPath(sourceCliRoot, dependency);
    if (!resolved) {
      continue;
    }

    const dependencyTarget = path.join(targetRoot, "node_modules", dependency);
    await ensureDir(path.dirname(dependencyTarget));
    await fs.cp(resolved, dependencyTarget, {
      recursive: true,
      force: true,
    });
  }
}

async function resolveDependencyInstallPath(
  startDir: string,
  dependency: string
): Promise<string | null> {
  let currentDir = startDir;

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

async function runTarExtract(archivePath: string, targetDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", targetDir], {
      stdio: "ignore",
      env: process.env,
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new CliError(`Failed to extract runtime artifact ${archivePath} with tar (exit ${code ?? 1})`));
    });
  });
}

async function normalizeExtractedRoot(rootPath: string): Promise<string> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  const files = entries.filter((entry) => entry.isFile());

  if (directories.length === 1 && files.length === 0) {
    return path.join(rootPath, directories[0]!.name);
  }

  return rootPath;
}
