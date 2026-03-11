export const RUNTIME_INSTALL_MANIFEST_VERSION = 1;
export const RELEASE_METADATA_VERSION = 1;

export type SupportedWorkerRuntime = "bun" | "node";
export type ReleaseChannel = "stable" | "preview";

export interface RuntimeCompatibility {
  platformKey: string;
  os: NodeJS.Platform;
  arch: string;
  minimumDarwinKernelMajor?: number;
  minimumGlibcVersion?: string;
}

export interface RuntimeBuildInfo {
  source: "local" | "github-actions";
  osRelease: string;
  libcFamily?: "glibc";
  libcVersion?: string;
}

export interface RuntimeInstallManifest {
  manifestVersion: typeof RUNTIME_INSTALL_MANIFEST_VERSION;
  kind: "runtime-install";
  cliVersion: string;
  runtimeVersion: string;
  protocolVersion: number;
  schemaVersion: number;
  schemaMin: number;
  schemaMax: number;
  bundleVersion: string;
  bundleContentHash?: string;
  supportedWorkerRuntimes: SupportedWorkerRuntime[];
  platform: {
    os: NodeJS.Platform;
    arch: string;
  };
  compatibility: RuntimeCompatibility;
  build: RuntimeBuildInfo;
  generatedAt: string;
}

export interface ReleaseArtifactMetadata {
  url: string;
  sha256: string;
  sizeBytes?: number;
  compatibility: RuntimeCompatibility;
}

export interface ReleaseVersionMetadata {
  version: string;
  channel: ReleaseChannel;
  protocolVersion: number;
  schemaMin: number;
  schemaMax: number;
  supportedWorkerRuntimes: SupportedWorkerRuntime[];
  releasedAt: string;
  notesUrl?: string;
  artifacts: Record<string, ReleaseArtifactMetadata>;
}

export interface ReleaseMetadataManifest {
  manifestVersion: typeof RELEASE_METADATA_VERSION;
  latest: string;
  channels: Partial<Record<ReleaseChannel, string>>;
  releases: Record<string, ReleaseVersionMetadata>;
}

export function createRuntimeInstallManifest(input: {
  cliVersion: string;
  runtimeVersion: string;
  protocolVersion: number;
  schemaVersion: number;
  bundleVersion: string;
  bundleContentHash?: string;
  supportedWorkerRuntimes: SupportedWorkerRuntime[];
  compatibility: RuntimeCompatibility;
  build: RuntimeBuildInfo;
}): RuntimeInstallManifest {
  return {
    manifestVersion: RUNTIME_INSTALL_MANIFEST_VERSION,
    kind: "runtime-install",
    cliVersion: input.cliVersion,
    runtimeVersion: input.runtimeVersion,
    protocolVersion: input.protocolVersion,
    schemaVersion: input.schemaVersion,
    schemaMin: input.schemaVersion,
    schemaMax: input.schemaVersion,
    bundleVersion: input.bundleVersion,
    bundleContentHash: input.bundleContentHash,
    supportedWorkerRuntimes: input.supportedWorkerRuntimes,
    platform: {
      os: input.compatibility.os,
      arch: input.compatibility.arch,
    },
    compatibility: input.compatibility,
    build: input.build,
    generatedAt: new Date().toISOString(),
  };
}
