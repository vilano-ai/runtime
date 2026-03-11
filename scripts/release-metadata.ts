import {
  RELEASE_METADATA_VERSION,
  type ReleaseArtifactMetadata,
  type ReleaseChannel,
  type ReleaseMetadataManifest,
  type ReleaseVersionMetadata,
  type RuntimeInstallManifest,
} from "../cli/src/distribution-contract.ts";

export function buildReleaseMetadata(input: {
  runtimeVersion: string;
  releaseChannel: ReleaseChannel;
  artifactFileName: string;
  sha256: string;
  sizeBytes: number;
  baseUrl: string;
  platformKey: string;
  installManifest: RuntimeInstallManifest;
  notesUrl?: string;
}): ReleaseMetadataManifest {
  const artifact: ReleaseArtifactMetadata = {
    url: resolveArtifactUrl(input.baseUrl, input.artifactFileName),
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    compatibility: input.installManifest.compatibility,
  };

  return {
    manifestVersion: RELEASE_METADATA_VERSION,
    latest: input.runtimeVersion,
    channels: {
      [input.releaseChannel]: input.runtimeVersion,
    },
    releases: {
      [input.runtimeVersion]: {
        version: input.runtimeVersion,
        channel: input.releaseChannel,
        protocolVersion: input.installManifest.protocolVersion,
        schemaMin: input.installManifest.schemaMin,
        schemaMax: input.installManifest.schemaMax,
        supportedWorkerRuntimes: input.installManifest.supportedWorkerRuntimes,
        releasedAt: new Date().toISOString(),
        notesUrl: normalizeOptionalString(input.notesUrl),
        artifacts: {
          [input.platformKey]: artifact,
        },
      },
    },
  };
}

export function mergeReleaseMetadata(
  manifests: ReleaseMetadataManifest[]
): ReleaseMetadataManifest {
  const first = manifests[0];
  if (!first) {
    throw new Error("No release manifests to merge");
  }

  const latest = first.latest;
  const mergedChannels = { ...first.channels };
  const mergedReleases: Record<string, ReleaseVersionMetadata> = {};

  for (const manifest of manifests) {
    if (manifest.latest !== latest) {
      throw new Error(
        `Release version mismatch while merging metadata: ${manifest.latest} != ${latest}`
      );
    }

    for (const [channel, version] of Object.entries(manifest.channels)) {
      if (!version) {
        continue;
      }

      const existingVersion = mergedChannels[channel as ReleaseChannel];
      if (existingVersion && existingVersion !== version) {
        throw new Error(
          `Release channel mismatch for ${channel}: ${existingVersion} != ${version}`
        );
      }

      mergedChannels[channel as ReleaseChannel] = version;
    }

    for (const [version, release] of Object.entries(manifest.releases)) {
      const existing = mergedReleases[version];
      if (!existing) {
        mergedReleases[version] = {
          ...release,
          notesUrl: normalizeOptionalString(release.notesUrl),
          artifacts: { ...release.artifacts },
        };
        continue;
      }

      if (
        existing.channel !== release.channel ||
        existing.protocolVersion !== release.protocolVersion ||
        existing.schemaMin !== release.schemaMin ||
        existing.schemaMax !== release.schemaMax ||
        normalizeOptionalString(existing.notesUrl) !== normalizeOptionalString(release.notesUrl) ||
        JSON.stringify(existing.supportedWorkerRuntimes) !==
          JSON.stringify(release.supportedWorkerRuntimes)
      ) {
        throw new Error(`Release metadata mismatch for version ${version}`);
      }

      for (const [platform, artifact] of Object.entries(release.artifacts)) {
        if (existing.artifacts[platform]) {
          throw new Error(`Duplicate artifact entry for ${version}/${platform}`);
        }

        existing.artifacts[platform] = artifact;
      }
    }
  }

  return {
    manifestVersion: RELEASE_METADATA_VERSION,
    latest,
    channels: mergedChannels,
    releases: mergedReleases,
  };
}

export function resolveArtifactUrl(baseUrl: string, artifactFileName: string): string {
  if (baseUrl.startsWith("file://")) {
    return new URL(artifactFileName, ensureTrailingSlash(baseUrl)).toString();
  }

  return `${ensureNoTrailingSlash(baseUrl)}/${artifactFileName}`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function ensureNoTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.length > 0 ? value : undefined;
}
