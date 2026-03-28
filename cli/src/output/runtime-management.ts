import type { DaemonStatusResponse } from "../types.ts";

export function renderVersionInfo(body: {
  cliVersion: string;
  protocolVersion: number;
  runtimeBundle: {
    root: string;
    sourceRoot: string;
    bundled: boolean;
    materialized: boolean;
    bundleVersion: string;
    installManifestFile: string;
    installManifest: {
      runtimeVersion: string;
      protocolVersion: number;
      schemaVersion: number;
      supportedWorkerRuntimes: string[];
      platform: {
        os: string;
        arch: string;
      };
      compatibility?: {
        platformKey: string;
        minimumDarwinKernelMajor?: number;
        minimumGlibcVersion?: string;
      };
    } | null;
  };
  kernel: DaemonStatusResponse | null;
  kernelError?: string | null;
}): string {
  return [
    `cli_version: ${body.cliVersion}`,
    `protocol_version: ${body.protocolVersion}`,
    `runtime_bundle: ${body.runtimeBundle.bundled ? "packaged" : "repo"}`,
    `runtime_bundle_version: ${body.runtimeBundle.bundleVersion}`,
    body.runtimeBundle.installManifest
      ? `runtime_install: runtime=${body.runtimeBundle.installManifest.runtimeVersion} protocol=${body.runtimeBundle.installManifest.protocolVersion} schema=${body.runtimeBundle.installManifest.schemaVersion} worker_runtimes=${body.runtimeBundle.installManifest.supportedWorkerRuntimes.join(",")} platform=${body.runtimeBundle.installManifest.platform.os}/${body.runtimeBundle.installManifest.platform.arch}`
      : null,
    body.runtimeBundle.installManifest?.compatibility
      ? `runtime_compatibility: ${renderCompatibility(body.runtimeBundle.installManifest.compatibility)}`
      : null,
    body.kernelError ? `kernel_error: ${body.kernelError}` : null,
    body.kernel
      ? `kernel: running ${body.kernel.runtimeVersion} schema=${body.kernel.schemaVersion} port=${body.kernel.port}`
      : "kernel: not running",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderUpdateCheck(body: {
  mode: "check";
  source: string;
  channel: string;
  current: {
    version: string;
    bundled: boolean;
    installManifestFile: string;
  };
  latest: {
    version: string;
    channel: string;
    protocolVersion: number;
    schemaMin: number;
    schemaMax: number;
    supportedWorkerRuntimes: string[];
    releasedAt: string;
    notesUrl: string | null;
    artifact: {
      url: string;
      sha256: string;
      sizeBytes?: number;
      compatibility?: {
        platformKey: string;
        minimumDarwinKernelMajor?: number;
        minimumGlibcVersion?: string;
      };
    } | null;
  };
  platform: {
    key: string;
    supported: boolean;
  };
  updateAvailable: boolean;
}): string {
  return [
    `update_check: ${body.updateAvailable ? "update available" : "up to date"}`,
    `source: ${body.source}`,
    `channel: ${body.channel}`,
    `current_version: ${body.current.version}`,
    body.current.bundled ? `runtime_install_manifest: ${body.current.installManifestFile}` : null,
    `latest_version: ${body.latest.version}`,
    `latest_channel: ${body.latest.channel}`,
    `released_at: ${body.latest.releasedAt}`,
    `platform: ${body.platform.key}`,
    `platform_supported: ${body.platform.supported}`,
    `latest_protocol: ${body.latest.protocolVersion}`,
    `latest_schema: ${body.latest.schemaMin}-${body.latest.schemaMax}`,
    `latest_worker_runtimes: ${body.latest.supportedWorkerRuntimes.join(",")}`,
    body.latest.artifact ? `artifact_url: ${body.latest.artifact.url}` : null,
    body.latest.artifact ? `artifact_sha256: ${body.latest.artifact.sha256}` : null,
    body.latest.artifact?.compatibility
      ? `artifact_compatibility: ${renderCompatibility(body.latest.artifact.compatibility)}`
      : null,
    body.latest.notesUrl ? `notes: ${body.latest.notesUrl}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderUpdateApply(body: {
  source: string;
  channel: string;
  previousVersion: string | null;
  currentVersion: string;
  installedVersion: string;
  platform: {
    key: string;
    artifactUrl: string;
  };
}): string {
  return [
    "update: applied",
    `source: ${body.source}`,
    `channel: ${body.channel}`,
    `previous_version: ${body.previousVersion ?? "none"}`,
    `current_version: ${body.currentVersion}`,
    `installed_version: ${body.installedVersion}`,
    `platform: ${body.platform.key}`,
    `artifact_url: ${body.platform.artifactUrl}`,
  ].join("\n");
}

export function renderRollbackResult(body: {
  currentVersion: string;
  previousVersion: string | null;
  rolledBackTo: string;
}): string {
  return [
    "rollback: applied",
    `from_version: ${body.currentVersion}`,
    `previous_version: ${body.previousVersion ?? "none"}`,
    `rolled_back_to: ${body.rolledBackTo}`,
  ].join("\n");
}

function renderCompatibility(input: {
  platformKey: string;
  minimumDarwinKernelMajor?: number;
  minimumGlibcVersion?: string;
}): string {
  return [
    input.platformKey,
    input.minimumDarwinKernelMajor !== undefined
      ? `darwin_kernel>=${input.minimumDarwinKernelMajor}`
      : null,
    input.minimumGlibcVersion ? `glibc>=${input.minimumGlibcVersion}` : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ");
}
