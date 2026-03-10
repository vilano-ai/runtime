import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CliError } from "./cli-error.ts";
import {
  RELEASE_METADATA_VERSION,
  type RuntimeCompatibility,
  type ReleaseArtifactMetadata,
  type ReleaseChannel,
  type ReleaseMetadataManifest,
  type ReleaseVersionMetadata,
  type SupportedWorkerRuntime,
} from "./distribution-contract.ts";

const DEFAULT_RELEASE_METADATA_URL = "https://runtime.vilano.ai/release.json";

export interface LoadedReleaseMetadata {
  source: string;
  manifest: ReleaseMetadataManifest;
}

export function resolveReleaseMetadataSource(flags: Record<string, string | boolean>): string {
  if (typeof flags["release-manifest"] === "string") {
    return flags["release-manifest"];
  }

  if (typeof process.env.VILANO_RELEASE_METADATA_URL === "string" && process.env.VILANO_RELEASE_METADATA_URL.length > 0) {
    return process.env.VILANO_RELEASE_METADATA_URL;
  }

  return DEFAULT_RELEASE_METADATA_URL;
}

export function resolveReleaseChannel(flags: Record<string, string | boolean>): ReleaseChannel {
  const candidate =
    typeof flags.channel === "string"
      ? flags.channel
      : process.env.VILANO_RELEASE_CHANNEL ?? "stable";

  if (candidate !== "stable" && candidate !== "preview") {
    throw new CliError(`Unsupported release channel: ${candidate}`);
  }

  return candidate;
}

export async function loadReleaseMetadata(source: string): Promise<LoadedReleaseMetadata> {
  const normalizedSource = normalizeReleaseMetadataSource(source);
  const body = await readReleaseMetadataBody(normalizedSource);
  const manifest = parseReleaseMetadataManifest(body, normalizedSource);
  return { source: normalizedSource, manifest };
}

export function selectReleaseVersion(
  manifest: ReleaseMetadataManifest,
  channel: ReleaseChannel
): ReleaseVersionMetadata {
  const channelVersion = manifest.channels[channel] ?? manifest.latest;
  const selected = manifest.releases[channelVersion];

  if (!selected) {
    throw new CliError(
      `Release metadata does not contain a ${channel} target version (${channelVersion}).`
    );
  }

  return selected;
}

export function getCurrentPlatformKey(): string {
  return `${os.platform()}-${os.arch()}`;
}

export function compareRuntimeVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);

  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }

  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }

  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch - parsedRight.patch;
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) {
    return 0;
  }

  if (parsedLeft.prerelease.length === 0) {
    return 1;
  }

  if (parsedRight.prerelease.length === 0) {
    return -1;
  }

  const maxLength = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];

    if (leftIdentifier === undefined) {
      return -1;
    }

    if (rightIdentifier === undefined) {
      return 1;
    }

    const numericLeft = Number.parseInt(leftIdentifier, 10);
    const numericRight = Number.parseInt(rightIdentifier, 10);
    const leftNumeric = `${numericLeft}` === leftIdentifier;
    const rightNumeric = `${numericRight}` === rightIdentifier;

    if (leftNumeric && rightNumeric && numericLeft !== numericRight) {
      return numericLeft - numericRight;
    }

    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }

    if (leftIdentifier !== rightIdentifier) {
      return leftIdentifier.localeCompare(rightIdentifier);
    }
  }

  return 0;
}

function normalizeReleaseMetadataSource(source: string): string {
  if (source.startsWith("http://") || source.startsWith("https://") || source.startsWith("file://")) {
    return source;
  }

  return path.resolve(source);
}

async function readReleaseMetadataBody(source: string): Promise<unknown> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new CliError(`Failed to fetch release metadata from ${source}: HTTP ${response.status}`);
    }

    return await response.json();
  }

  if (source.startsWith("file://")) {
    return JSON.parse(await fs.readFile(new URL(source), "utf8")) as unknown;
  }

  return JSON.parse(await fs.readFile(source, "utf8")) as unknown;
}

function parseReleaseMetadataManifest(
  value: unknown,
  source: string
): ReleaseMetadataManifest {
  const manifest = assertObject(value, `release metadata from ${source}`);
  const manifestVersion = assertNumber(manifest.manifestVersion, "release metadata manifestVersion");

  if (manifestVersion !== RELEASE_METADATA_VERSION) {
    throw new CliError(
      `Unsupported release metadata manifest version: ${manifestVersion}. Expected ${RELEASE_METADATA_VERSION}.`
    );
  }

  const latest = assertString(manifest.latest, "release metadata latest");
  const channelsValue = assertObject(manifest.channels, "release metadata channels");
  const releasesValue = assertObject(manifest.releases, "release metadata releases");

  const channels: Partial<Record<ReleaseChannel, string>> = {};
  for (const [channel, targetVersion] of Object.entries(channelsValue)) {
    if (channel !== "stable" && channel !== "preview") {
      throw new CliError(`Unsupported release channel in metadata: ${channel}`);
    }

    channels[channel] = assertString(targetVersion, `release channel ${channel}`);
  }

  const releases: Record<string, ReleaseVersionMetadata> = {};
  for (const [version, releaseValue] of Object.entries(releasesValue)) {
    releases[version] = parseReleaseVersionMetadata(version, releaseValue);
  }

  if (!releases[latest]) {
    throw new CliError(`Release metadata latest version ${latest} is missing from releases.`);
  }

  return {
    manifestVersion: RELEASE_METADATA_VERSION,
    latest,
    channels,
    releases,
  };
}

function parseReleaseVersionMetadata(versionKey: string, value: unknown): ReleaseVersionMetadata {
  const release = assertObject(value, `release ${versionKey}`);
  const version = assertString(release.version, `release ${versionKey} version`);
  const channel = assertString(release.channel, `release ${versionKey} channel`);

  if (channel !== "stable" && channel !== "preview") {
    throw new CliError(`Unsupported release channel for ${versionKey}: ${channel}`);
  }

  const workerRuntimes = assertArray(
    release.supportedWorkerRuntimes,
    `release ${versionKey} supportedWorkerRuntimes`
  ).map((runtime, index) => {
    const value = assertString(runtime, `release ${versionKey} supportedWorkerRuntimes[${index}]`);
    if (value !== "bun" && value !== "node") {
      throw new CliError(`Unsupported worker runtime in release ${versionKey}: ${value}`);
    }

    return value as SupportedWorkerRuntime;
  });

  const artifactsObject = assertObject(release.artifacts, `release ${versionKey} artifacts`);
  const artifacts: Record<string, ReleaseArtifactMetadata> = {};
  for (const [artifactKey, artifactValue] of Object.entries(artifactsObject)) {
    const artifact = assertObject(artifactValue, `release ${versionKey} artifact ${artifactKey}`);
    artifacts[artifactKey] = {
      url: assertString(artifact.url, `release ${versionKey} artifact ${artifactKey} url`),
      sha256: assertString(artifact.sha256, `release ${versionKey} artifact ${artifactKey} sha256`),
      sizeBytes:
        artifact.sizeBytes === undefined
          ? undefined
          : assertNumber(artifact.sizeBytes, `release ${versionKey} artifact ${artifactKey} sizeBytes`),
      compatibility: parseRuntimeCompatibility(
        artifact.compatibility,
        `release ${versionKey} artifact ${artifactKey} compatibility`
      ),
    };
  }

  return {
    version,
    channel,
    protocolVersion: assertNumber(release.protocolVersion, `release ${versionKey} protocolVersion`),
    schemaMin: assertNumber(release.schemaMin, `release ${versionKey} schemaMin`),
    schemaMax: assertNumber(release.schemaMax, `release ${versionKey} schemaMax`),
    supportedWorkerRuntimes: workerRuntimes,
    releasedAt: assertString(release.releasedAt, `release ${versionKey} releasedAt`),
    notesUrl:
      release.notesUrl === undefined
        ? undefined
        : assertString(release.notesUrl, `release ${versionKey} notesUrl`),
    artifacts,
  };
}

function parseRuntimeCompatibility(value: unknown, label: string): RuntimeCompatibility {
  const compatibility = assertObject(value, label);
  const osValue = assertString(compatibility.os, `${label} os`);
  const archValue = assertString(compatibility.arch, `${label} arch`);

  return {
    platformKey: assertString(compatibility.platformKey, `${label} platformKey`),
    os: osValue as NodeJS.Platform,
    arch: archValue,
    minimumDarwinKernelMajor:
      compatibility.minimumDarwinKernelMajor === undefined
        ? undefined
        : assertNumber(compatibility.minimumDarwinKernelMajor, `${label} minimumDarwinKernelMajor`),
    minimumGlibcVersion:
      compatibility.minimumGlibcVersion === undefined
        ? undefined
        : assertString(compatibility.minimumGlibcVersion, `${label} minimumGlibcVersion`),
  };
}

function parseVersion(value: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} | null {
  const match = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?$/.exec(
    value
  );

  if (!match?.groups) {
    return null;
  }

  const groups = match.groups as {
    major: string;
    minor: string;
    patch: string;
    prerelease?: string;
  };

  return {
    major: Number.parseInt(groups.major, 10),
    minor: Number.parseInt(groups.minor, 10),
    patch: Number.parseInt(groups.patch, 10),
    prerelease: groups.prerelease ? groups.prerelease.split(".") : [],
  };
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`Expected ${label} to be an object.`);
  }

  return value as Record<string, unknown>;
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new CliError(`Expected ${label} to be an array.`);
  }

  return value;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(`Expected ${label} to be a non-empty string.`);
  }

  return value;
}

function assertNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CliError(`Expected ${label} to be a finite number.`);
  }

  return value;
}
