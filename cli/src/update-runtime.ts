import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CliError } from "./cli-error.ts";
import type { ReleaseChannel, ReleaseVersionMetadata } from "./distribution-contract.ts";
import { ensureDir } from "./json-file.ts";
import {
  getInstalledVersionRoot,
  installCliRoot,
  readInstallState,
  readInstalledManifest,
  switchCurrentInstall,
  unpackArtifactToInstallRoot,
} from "./install-state.ts";
import { loadReleaseMetadata, selectReleaseVersion, type LoadedReleaseMetadata } from "./release-metadata.ts";
import { getRuntimePaths } from "./runtime-home.ts";
import { prepareRuntimeBundleWithOptions } from "./runtime-materializer.ts";
import { getCliVersion } from "./runtime-version.ts";

export interface UpdateApplyResult {
  ok: true;
  source: string;
  channel: ReleaseChannel;
  previousVersion: string | null;
  currentVersion: string;
  installedVersion: string;
  platform: {
    key: string;
    artifactUrl: string;
  };
}

export interface RollbackResult {
  ok: true;
  currentVersion: string;
  previousVersion: string | null;
  rolledBackTo: string;
}

export async function applyRuntimeUpdate(input: {
  source: string;
  channel: ReleaseChannel;
  platformKey: string;
  targetVersion?: string;
}): Promise<UpdateApplyResult> {
  const metadata = await loadReleaseMetadata(input.source);
  const targetRelease = resolveTargetRelease(metadata, input.channel, input.targetVersion);
  const artifact = targetRelease.artifacts[input.platformKey];

  if (!artifact) {
    throw new CliError(
      `No runtime artifact is published for ${input.platformKey} in release ${targetRelease.version}.`
    );
  }

  const bundle = await prepareRuntimeBundleWithOptions({ materialize: false });
  const installManifest = await readInstalledManifestFromBundle(bundle.installManifestFile);
  const currentVersion = installManifest?.runtimeVersion ?? getCliVersion();
  const currentState = await readInstallState();
  const previousVersion = currentState?.currentVersion ?? currentVersion;

  await bootstrapCurrentManagedInstall(currentVersion, bundle.source.bundled, bundle.source.cliRoot);

  const downloadPath = await downloadReleaseArtifact(
    artifact.url,
    artifact.sha256,
    `${targetRelease.version}-${input.platformKey}.tar.gz`
  );
  const targetRoot = getInstalledVersionRoot(targetRelease.version);
  await unpackArtifactToInstallRoot(downloadPath, targetRoot);
  const installedManifest = await readInstalledManifest(targetRelease.version);

  if (!installedManifest) {
    throw new CliError(`Installed artifact ${targetRelease.version} is missing runtime-dist/install-manifest.json`);
  }

  if (installedManifest.runtimeVersion !== targetRelease.version) {
    throw new CliError(
      `Installed artifact version mismatch: expected ${targetRelease.version}, got ${installedManifest.runtimeVersion}.`
    );
  }

  await switchCurrentInstall(targetRelease.version, input.channel, {
    previousVersion,
  });
  const nextState = await readInstallState();

  return {
    ok: true,
    source: metadata.source,
    channel: input.channel,
    previousVersion: nextState?.previousVersion ?? previousVersion,
    currentVersion: targetRelease.version,
    installedVersion: targetRelease.version,
    platform: {
      key: input.platformKey,
      artifactUrl: artifact.url,
    },
  };
}

export async function rollbackRuntimeInstall(targetVersion?: string): Promise<RollbackResult> {
  const state = await readInstallState();
  if (!state?.currentVersion) {
    throw new CliError("No managed Vilano runtime is installed under the current install root.");
  }

  const rollbackTarget = targetVersion ?? state.previousVersion;
  if (!rollbackTarget) {
    throw new CliError("No previous Vilano runtime version is available to roll back to.");
  }

  const manifest = await readInstalledManifest(rollbackTarget);
  if (!manifest) {
    throw new CliError(`Vilano runtime ${rollbackTarget} is not installed under the current install root.`);
  }

  await switchCurrentInstall(rollbackTarget, state.channel);
  return {
    ok: true,
    currentVersion: state.currentVersion,
    previousVersion: state.previousVersion,
    rolledBackTo: rollbackTarget,
  };
}

function resolveTargetRelease(
  metadata: LoadedReleaseMetadata,
  channel: ReleaseChannel,
  targetVersion?: string
): ReleaseVersionMetadata {
  if (!targetVersion) {
    return selectReleaseVersion(metadata.manifest, channel);
  }

  const selected = metadata.manifest.releases[targetVersion];
  if (!selected) {
    throw new CliError(`Release metadata does not contain version ${targetVersion}.`);
  }

  return selected;
}

async function bootstrapCurrentManagedInstall(
  currentVersion: string,
  sourceBundled: boolean,
  sourceCliRoot: string
): Promise<void> {
  const existing = await readInstalledManifest(currentVersion);
  if (existing) {
    return;
  }

  if (!sourceBundled) {
    return;
  }

  await installCliRoot(sourceCliRoot, getInstalledVersionRoot(currentVersion));
}

async function readInstalledManifestFromBundle(
  manifestPath: string
): Promise<{ runtimeVersion: string } | null> {
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf8")) as { runtimeVersion: string };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function downloadReleaseArtifact(
  source: string,
  expectedSha256: string,
  fileName: string
): Promise<string> {
  const runtimePaths = getRuntimePaths();
  const downloadsDir = path.join(runtimePaths.cacheDir, "downloads");
  await ensureDir(downloadsDir);
  const targetPath = path.join(downloadsDir, fileName);

  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new CliError(`Failed to download runtime artifact from ${source}: HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(targetPath, Buffer.from(arrayBuffer));
  } else if (source.startsWith("file://")) {
    await fs.copyFile(new URL(source), targetPath);
  } else {
    await fs.copyFile(path.resolve(source), targetPath);
  }

  const digest = await hashFileSha256(targetPath);
  if (digest !== expectedSha256) {
    throw new CliError(
      `Runtime artifact checksum mismatch for ${source}. Expected ${expectedSha256}, got ${digest}.`
    );
  }

  return targetPath;
}

async function hashFileSha256(filePath: string): Promise<string> {
  const digest = crypto.createHash("sha256");
  digest.update(await fs.readFile(filePath));
  return digest.digest("hex");
}
