import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

import { ensureDir, readJsonFile, writeJsonFileAtomic } from "./json-file.ts";
import { getRuntimePaths } from "./runtime-home.ts";
import {
  resolveRuntimeBundlePaths,
  type RuntimeBundlePaths,
  type RuntimeBundleManifest,
} from "./runtime-bundle.ts";
import { CLI_PROTOCOL_VERSION, getCliVersion } from "./runtime-version.ts";

export interface PreparedRuntimeBundle {
  source: RuntimeBundlePaths;
  runtimeRoot: string;
  kernelDir: string;
  workerDir: string;
  installManifestFile: string;
  materialized: boolean;
  bundleVersion: string;
}

interface MaterializedBundleState {
  sourceRoot: string;
  cliVersion: string;
  protocolVersion: number;
  runtimeVersion: string;
  schemaVersion: number;
  bundleVersion: string;
  bundleContentHash: string | null;
  materializedContentHash: string | null;
  materializedAt: string;
}

export async function prepareRuntimeBundle(): Promise<PreparedRuntimeBundle> {
  return await prepareRuntimeBundleWithOptions();
}

export async function prepareRuntimeBundleWithOptions(options: { materialize?: boolean } = {}): Promise<PreparedRuntimeBundle> {
  const materialize = options.materialize ?? true;
  const source = resolveRuntimeBundlePaths();

  if (!source.bundled || !materialize) {
    return {
      source,
      runtimeRoot: source.runtimeRoot,
      kernelDir: source.kernelDir,
      workerDir: source.workerDir,
      installManifestFile: source.manifestFile,
      materialized: false,
      bundleVersion: `repo-${getCliVersion()}-protocol-${CLI_PROTOCOL_VERSION}`,
    };
  }

  const manifest = await readBundleManifest(source);
  const runtimePaths = getRuntimePaths();
  const bundleVersion =
    manifest?.bundleVersion ??
    `cli-${getCliVersion()}-runtime-${manifest?.runtimeVersion ?? getCliVersion()}-protocol-${CLI_PROTOCOL_VERSION}`;
  const materializedRoot = path.join(runtimePaths.installsDir, bundleVersion);
  const kernelDir = path.join(materializedRoot, path.relative(source.runtimeRoot, source.kernelDir));
  const workerDir = path.join(materializedRoot, path.relative(source.runtimeRoot, source.workerDir));
  const stateFile = path.join(materializedRoot, ".materialized.json");

  if (!(await isMaterialized(stateFile, source.runtimeRoot, bundleVersion))) {
    await fs.rm(materializedRoot, { recursive: true, force: true });
    await ensureDir(materializedRoot);
    await fs.cp(source.runtimeRoot, materializedRoot, {
      recursive: true,
      force: true,
    });
    const materializedContentHash = await hashRuntimeBundleContents(materializedRoot);
    await writeJsonFileAtomic(stateFile, {
      sourceRoot: source.runtimeRoot,
      cliVersion: getCliVersion(),
      protocolVersion: CLI_PROTOCOL_VERSION,
      runtimeVersion: manifest?.runtimeVersion ?? getCliVersion(),
      schemaVersion: manifest?.schemaVersion ?? 0,
      bundleVersion,
      bundleContentHash: manifest?.bundleContentHash ?? null,
      materializedContentHash,
      materializedAt: new Date().toISOString(),
    } satisfies MaterializedBundleState);
  }

  return {
    source,
    runtimeRoot: materializedRoot,
    kernelDir,
    workerDir,
    installManifestFile: path.join(materializedRoot, "install-manifest.json"),
    materialized: true,
    bundleVersion,
  };
}

async function readBundleManifest(
  source: RuntimeBundlePaths
): Promise<RuntimeBundleManifest | null> {
  return await readJsonFile<RuntimeBundleManifest | null>(source.manifestFile, null);
}

async function isMaterialized(
  stateFile: string,
  sourceRoot: string,
  bundleVersion: string
): Promise<boolean> {
  const state = await readJsonFile<MaterializedBundleState | null>(stateFile, null);
  const sourceBundleManifest = await readJsonFile<RuntimeBundleManifest | null>(
    path.join(sourceRoot, "install-manifest.json"),
    null
  );
  const sourceBundleContentHash = sourceBundleManifest?.bundleContentHash ?? null;
  const materializedRoot = path.dirname(stateFile);
  const materializedContentHash = state ? await hashRuntimeBundleContents(materializedRoot) : null;

  return (
    state !== null &&
    state.sourceRoot === sourceRoot &&
    state.bundleVersion === bundleVersion &&
    state.bundleContentHash === sourceBundleContentHash &&
    state.materializedContentHash === materializedContentHash &&
    materializedContentHash === sourceBundleContentHash &&
    state.cliVersion === getCliVersion() &&
    state.protocolVersion === CLI_PROTOCOL_VERSION &&
    state.schemaVersion === (sourceBundleManifest?.schemaVersion ?? 0)
  );
}

async function readBundleContentHash(sourceRoot: string): Promise<string | null> {
  const manifest = await readJsonFile<RuntimeBundleManifest | null>(
    path.join(sourceRoot, "install-manifest.json"),
    null
  );
  return manifest?.bundleContentHash ?? null;
}

async function hashRuntimeBundleContents(rootPath: string): Promise<string | null> {
  const bundleManifest = await readJsonFile<RuntimeBundleManifest | null>(
    path.join(rootPath, "install-manifest.json"),
    null
  );

  if (!bundleManifest) {
    return null;
  }

  const hash = crypto.createHash("sha256");
  const files = await collectFiles(rootPath);

  for (const filePath of files) {
    const relativePath = path.relative(rootPath, filePath);
    if (relativePath === ".materialized.json" || relativePath === "install-manifest.json") {
      continue;
    }

    hash.update(relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }

  return hash.digest("hex").slice(0, 16);
}

async function collectFiles(rootPath: string): Promise<string[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files.sort();
}
