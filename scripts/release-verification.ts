import fs from "node:fs/promises";
import path from "node:path";

import { loadReleaseMetadata, selectReleaseVersion } from "../cli/src/release-metadata.ts";
import { renderInstallScript } from "./release-installer.ts";

export interface VerifyReleasePublicationOptions {
  releaseManifestSource: string;
  installerSource: string;
  channel: "stable" | "preview";
  requiredPlatforms: string[];
  expectedVersion?: string;
  expectedArtifactUrlPrefix?: string;
  expectedNotesUrl?: string;
}

export interface VerifyReleasePublicationResult {
  releaseVersion: string;
  channel: "stable" | "preview";
  notesUrl: string | null;
  platforms: string[];
  artifactUrls: string[];
  releaseManifestSource: string;
  installerSource: string;
}

export async function verifyReleasePublication(
  options: VerifyReleasePublicationOptions
): Promise<VerifyReleasePublicationResult> {
  const loadedManifest = await loadReleaseMetadata(options.releaseManifestSource);
  const localBundleDir = resolveLocalBundleDir(options.releaseManifestSource);
  const selectedRelease = selectReleaseVersion(loadedManifest.manifest, options.channel);
  const releaseVersion = options.expectedVersion ?? selectedRelease.version;

  if (selectedRelease.version !== releaseVersion) {
    throw new Error(
      `Release metadata channel ${options.channel} resolved to ${selectedRelease.version}, expected ${releaseVersion}`
    );
  }

  const versionMetadata = loadedManifest.manifest.releases[releaseVersion];
  if (!versionMetadata) {
    throw new Error(`Release metadata is missing version ${releaseVersion}`);
  }

  const actualPlatforms = Object.keys(versionMetadata.artifacts).sort();
  for (const platform of options.requiredPlatforms) {
    if (!versionMetadata.artifacts[platform]) {
      throw new Error(`Release ${releaseVersion} is missing required artifact for ${platform}`);
    }
  }

  if (options.expectedArtifactUrlPrefix) {
    for (const [platform, artifact] of Object.entries(versionMetadata.artifacts)) {
      if (!artifact.url.startsWith(options.expectedArtifactUrlPrefix)) {
        throw new Error(
          `Release ${releaseVersion} artifact URL for ${platform} does not start with ${options.expectedArtifactUrlPrefix}: ${artifact.url}`
        );
      }
    }
  }

  if (localBundleDir) {
    for (const [platform, artifact] of Object.entries(versionMetadata.artifacts)) {
      const expectedFile = path.join(localBundleDir, artifactFileNameFromUrl(artifact.url));
      try {
        await fs.access(expectedFile);
      } catch {
        throw new Error(
          `Local release bundle is missing artifact file for ${platform}: expected ${expectedFile}`
        );
      }
    }
  }

  if (options.expectedNotesUrl) {
    if (versionMetadata.notesUrl !== options.expectedNotesUrl) {
      throw new Error(
        `Release ${releaseVersion} notesUrl mismatch: expected ${options.expectedNotesUrl}, got ${versionMetadata.notesUrl ?? "null"}`
      );
    }
  }

  const expectedInstaller = renderInstallScript(loadedManifest.manifest);
  const actualInstaller = await readTextSource(options.installerSource);
  if (actualInstaller !== expectedInstaller) {
    throw new Error(
      `Installer at ${options.installerSource} does not match the rendered script for ${options.releaseManifestSource}`
    );
  }

  return {
    releaseVersion,
    channel: options.channel,
    notesUrl: versionMetadata.notesUrl ?? null,
    platforms: actualPlatforms,
    artifactUrls: actualPlatforms.map((platform) => versionMetadata.artifacts[platform]?.url ?? ""),
    releaseManifestSource: loadedManifest.source,
    installerSource: normalizeSource(options.installerSource),
  };
}

async function readTextSource(source: string): Promise<string> {
  const normalizedSource = normalizeSource(source);

  if (normalizedSource.startsWith("http://") || normalizedSource.startsWith("https://")) {
    const response = await fetch(normalizedSource);
    if (!response.ok) {
      throw new Error(`Failed to fetch installer from ${normalizedSource}: HTTP ${response.status}`);
    }

    return await response.text();
  }

  if (normalizedSource.startsWith("file://")) {
    return await fs.readFile(new URL(normalizedSource), "utf8");
  }

  return await fs.readFile(normalizedSource, "utf8");
}

function normalizeSource(source: string): string {
  if (source.startsWith("http://") || source.startsWith("https://") || source.startsWith("file://")) {
    return source;
  }

  return path.resolve(source);
}

function resolveLocalBundleDir(source: string): string | null {
  const normalizedSource = normalizeSource(source);
  if (normalizedSource.startsWith("http://") || normalizedSource.startsWith("https://")) {
    return null;
  }

  if (normalizedSource.startsWith("file://")) {
    return path.dirname(new URL(normalizedSource).pathname);
  }

  return path.dirname(normalizedSource);
}

function artifactFileNameFromUrl(url: string): string {
  const parsed = new URL(url);
  const fileName = path.basename(parsed.pathname);
  if (!fileName) {
    throw new Error(`Could not determine artifact filename from ${url}`);
  }

  return fileName;
}
