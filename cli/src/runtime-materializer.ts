import fs from "node:fs/promises";
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
  materialized: boolean;
  bundleVersion: string;
}

interface MaterializedBundleState {
  sourceRoot: string;
  cliVersion: string;
  protocolVersion: number;
  runtimeVersion: string;
  bundleVersion: string;
  bundleContentHash: string | null;
  materializedAt: string;
}

export async function prepareRuntimeBundle(): Promise<PreparedRuntimeBundle> {
  const source = resolveRuntimeBundlePaths();

  if (!source.bundled) {
    return {
      source,
      runtimeRoot: source.runtimeRoot,
      kernelDir: source.kernelDir,
      workerDir: source.workerDir,
      materialized: false,
      bundleVersion: `repo-${getCliVersion()}-protocol-${CLI_PROTOCOL_VERSION}`,
    };
  }

  const manifest = await readBundleManifest(source);
  const runtimePaths = getRuntimePaths();
  const bundleVersion =
    manifest?.bundleVersion ??
    `cli-${getCliVersion()}-runtime-${manifest?.runtimeVersion ?? getCliVersion()}-protocol-${CLI_PROTOCOL_VERSION}`;
  const materializedRoot = path.join(runtimePaths.runtimeBundlesDir, bundleVersion);
  const kernelDir = path.join(materializedRoot, "kernel");
  const workerDir = path.join(materializedRoot, "worker");
  const stateFile = path.join(materializedRoot, ".materialized.json");

  if (!(await isMaterialized(stateFile, source.runtimeRoot, bundleVersion))) {
    await fs.rm(materializedRoot, { recursive: true, force: true });
    await ensureDir(materializedRoot);
    await fs.cp(source.runtimeRoot, materializedRoot, {
      recursive: true,
      force: true,
    });
    await writeJsonFileAtomic(stateFile, {
      sourceRoot: source.runtimeRoot,
      cliVersion: getCliVersion(),
      protocolVersion: CLI_PROTOCOL_VERSION,
      runtimeVersion: manifest?.runtimeVersion ?? getCliVersion(),
      bundleVersion,
      bundleContentHash: manifest?.bundleContentHash ?? null,
      materializedAt: new Date().toISOString(),
    } satisfies MaterializedBundleState);
  }

  return {
    source,
    runtimeRoot: materializedRoot,
    kernelDir,
    workerDir,
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
  return (
    state !== null &&
    state.sourceRoot === sourceRoot &&
    state.bundleVersion === bundleVersion &&
    state.bundleContentHash === (await readBundleContentHash(sourceRoot)) &&
    state.cliVersion === getCliVersion() &&
    state.protocolVersion === CLI_PROTOCOL_VERSION
  );
}

async function readBundleContentHash(sourceRoot: string): Promise<string | null> {
  const manifest = await readJsonFile<RuntimeBundleManifest | null>(
    path.join(sourceRoot, "bundle-manifest.json"),
    null
  );
  return manifest?.bundleContentHash ?? null;
}
