import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { readJsonFile } from "../json-file.ts";
import { fileExists } from "../fs-utils.ts";
import { runDoctor } from "../doctor.ts";
import {
  ensureDaemonStarted,
  getRuntimeDebug,
  getRuntimeStorage,
  getRunningDaemonStatus,
  pruneRuntimeStorage,
  readDaemonAuthState,
  resolveDefaultKernelPort,
  stopDaemon,
} from "../daemon-client.ts";
import {
  renderRollbackResult,
  renderDaemonDebug,
  renderDaemonPrune,
  renderDaemonStatus,
  renderDaemonStorage,
  renderDoctorReport,
  renderUpdateApply,
  renderUpdateCheck,
  renderVersionInfo,
  writeOutput,
} from "../output.ts";
import {
  compareRuntimeVersions,
  getCurrentPlatformKey,
  loadReleaseMetadata,
  resolveReleaseChannel,
  resolveReleaseMetadataSource,
  selectReleaseVersion,
} from "../release-metadata.ts";
import { getRuntimePaths } from "../runtime-home.ts";
import { prepareRuntimeBundle, prepareRuntimeBundleWithOptions } from "../runtime-materializer.ts";
import { CLI_PROTOCOL_VERSION, getCliVersion } from "../runtime-version.ts";
import { applyRuntimeUpdate, rollbackRuntimeInstall } from "../update-runtime.ts";
import type { RuntimeBundleManifest } from "../runtime-bundle.ts";
import type { DaemonState, DaemonStatusResponse } from "../types.ts";
import { CliError } from "../cli-error.ts";

export async function handleDaemonCommand(
  args: string[],
  flags: Record<string, string | boolean>
): Promise<number> {
  const command = args[0];

  switch (command) {
    case "start": {
      const portFlag = flags.port;
      const defaultPort = resolveDefaultKernelPort();
      const port =
        typeof portFlag === "string" ? Number.parseInt(portFlag, 10) : defaultPort;
      const status = await ensureDaemonStarted(Number.isFinite(port) ? port : defaultPort);
      writeOutput(flags, status, renderDaemonStatus);
      return 0;
    }
    case "status": {
      const status = await getRunningDaemonStatus();
      if (!status) {
        writeOutput(flags, { ok: true, running: false }, () => "Vilano Runtime kernel is not running");
        return 0;
      }

      writeOutput(flags, status, renderDaemonStatus);
      return 0;
    }
    case "debug": {
      const body = await getRuntimeDebug();
      writeOutput(flags, body, renderDaemonDebug);
      return 0;
    }
    case "storage": {
      const body = await getRuntimeStorage();
      writeOutput(flags, body, renderDaemonStorage);
      return 0;
    }
    case "prune": {
      const body = await pruneRuntimeStorage({
        dryRun: Boolean(flags["dry-run"]),
        runWorkspaceTtlSeconds: readOptionalNonNegativeSeconds(
          flags["workspace-ttl-seconds"],
          "workspace-ttl-seconds",
          process.env.VILANO_PRUNE_RUN_WORKSPACE_TTL_SECONDS
        ),
        completedRunTtlSeconds: readOptionalNonNegativeSeconds(
          flags["completed-run-ttl-seconds"],
          "completed-run-ttl-seconds",
          process.env.VILANO_PRUNE_COMPLETED_RUN_TTL_SECONDS
        ),
        serviceEnvelopeTtlSeconds: readOptionalNonNegativeSeconds(
          flags["service-envelope-ttl-seconds"],
          "service-envelope-ttl-seconds",
          process.env.VILANO_PRUNE_SERVICE_ENVELOPE_TTL_SECONDS
        ),
        artifactGraceSeconds: readOptionalNonNegativeSeconds(
          flags["artifact-grace-seconds"],
          "artifact-grace-seconds",
          process.env.VILANO_PRUNE_ARTIFACT_GRACE_SECONDS
        ),
        eventPayloadGraceSeconds: readOptionalNonNegativeSeconds(
          flags["event-payload-grace-seconds"],
          "event-payload-grace-seconds",
          process.env.VILANO_PRUNE_EVENT_PAYLOAD_GRACE_SECONDS
        ),
        runtimeCacheTtlSeconds: readOptionalNonNegativeSeconds(
          flags["runtime-cache-ttl-seconds"],
          "runtime-cache-ttl-seconds",
          process.env.VILANO_PRUNE_RUNTIME_CACHE_TTL_SECONDS
        ),
        daemonLogMaxBytes: readOptionalNonNegativeInteger(
          flags["daemon-log-max-bytes"],
          "daemon-log-max-bytes",
          process.env.VILANO_PRUNE_DAEMON_LOG_MAX_BYTES
        ),
        vacuumDatabase:
          Boolean(flags["vacuum-database"]) ||
          readOptionalBooleanEnv(process.env.VILANO_PRUNE_VACUUM_DATABASE, "VILANO_PRUNE_VACUUM_DATABASE"),
      });
      writeOutput(flags, body, renderDaemonPrune);
      return 0;
    }
    case "stop": {
      const stopped = await stopDaemon();
      if (!stopped) {
        writeOutput(flags, { ok: true, running: false }, () => "Vilano Runtime kernel is not running");
        return 0;
      }

      writeOutput(
        flags,
        { ok: true, stopped: true, pid: stopped.pid, port: stopped.port },
        (body) => `Vilano Runtime kernel stopped\npid: ${body.pid}\nport: ${body.port}`
      );
      return 0;
    }
    default:
      throw new CliError("Usage: vilano daemon start|status|debug|storage|prune|stop");
  }
}

function readOptionalNonNegativeSeconds(
  flagValue: string | boolean | undefined,
  flagName: string,
  envValue: string | undefined
): number | undefined {
  return readOptionalNonNegativeInteger(flagValue, flagName, envValue);
}

function readOptionalNonNegativeInteger(
  flagValue: string | boolean | undefined,
  flagName: string,
  envValue: string | undefined
): number | undefined {
  if (flagValue === true) {
    throw new CliError(`--${flagName} requires a value`);
  }

  const rawValue = typeof flagValue === "string" ? flagValue : envValue;
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }

  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value < 0 || String(value) !== rawValue.trim()) {
    throw new CliError(`--${flagName} must be a non-negative integer`);
  }

  return value;
}

function readOptionalBooleanEnv(envValue: string | undefined, envName: string): boolean {
  if (envValue === undefined || envValue.trim() === "") {
    return false;
  }

  if (envValue === "1" || envValue.toLowerCase() === "true") {
    return true;
  }

  if (envValue === "0" || envValue.toLowerCase() === "false") {
    return false;
  }

  throw new CliError(`${envName} must be true, false, 1, or 0`);
}

export async function handleVersionCommand(flags: Record<string, string | boolean>): Promise<number> {
  let daemonStatus: DaemonStatusResponse | null = null;
  let kernelError: string | null = null;

  try {
    daemonStatus = await getRunningDaemonStatus();
  } catch (error) {
    kernelError = error instanceof Error ? error.message : String(error);
  }

  const bundle = await prepareRuntimeBundleWithOptions({ materialize: false });
  const installManifest = await readJsonFile<RuntimeBundleManifest | null>(bundle.installManifestFile, null);

  const body = {
    ok: true,
    cliVersion: getCliVersion(),
    protocolVersion: CLI_PROTOCOL_VERSION,
    runtimeBundle: {
      root: bundle.runtimeRoot,
      sourceRoot: bundle.source.runtimeRoot,
      bundled: bundle.source.bundled,
      materialized: bundle.materialized,
      bundleVersion: bundle.bundleVersion,
      installManifestFile: bundle.installManifestFile,
      installManifest,
    },
    kernel: daemonStatus,
    kernelError,
  };

  writeOutput(flags, body, (payload) => renderVersionInfo(payload));
  return 0;
}

export async function handleDoctorCommand(flags: Record<string, string | boolean>): Promise<number> {
  const report = await runDoctor({ fix: Boolean(flags.fix) });
  writeOutput(flags, report, renderDoctorReport);
  return report.ok ? 0 : 1;
}

export async function handleUpdateCommand(flags: Record<string, string | boolean>): Promise<number> {
  if (!flags.check) {
    const channel = resolveReleaseChannel(flags);
    const source = resolveReleaseMetadataSource(flags);
    const result = await applyRuntimeUpdate({
      source,
      channel,
      platformKey: getCurrentPlatformKey(),
      targetVersion: typeof flags.to === "string" ? flags.to : undefined,
    });

    writeOutput(flags, result, renderUpdateApply);
    return 0;
  }

  const source = resolveReleaseMetadataSource(flags);
  const channel = resolveReleaseChannel(flags);
  const metadata = await loadReleaseMetadata(source);
  let targetRelease;
  if (typeof flags.to === "string") {
    targetRelease = metadata.manifest.releases[flags.to];
    if (!targetRelease) {
      throw new CliError(`Release metadata does not contain version ${flags.to}.`);
    }
  } else {
    targetRelease = selectReleaseVersion(metadata.manifest, channel);
  }
  const platformKey = getCurrentPlatformKey();
  const platformArtifact = targetRelease.artifacts[platformKey] ?? null;
  const bundle = await prepareRuntimeBundleWithOptions({ materialize: false });
  const installManifest = await readJsonFile<RuntimeBundleManifest | null>(bundle.installManifestFile, null);
  const currentVersion = installManifest?.runtimeVersion ?? getCliVersion();
  const updateAvailable = compareRuntimeVersions(targetRelease.version, currentVersion) > 0;

  const body = {
    ok: true,
    mode: "check" as const,
    source: metadata.source,
    channel,
    current: {
      version: currentVersion,
      bundled: bundle.source.bundled,
      materialized: bundle.materialized,
      installManifestFile: bundle.installManifestFile,
      installManifest,
    },
    latest: {
      version: targetRelease.version,
      channel: targetRelease.channel,
      protocolVersion: targetRelease.protocolVersion,
      schemaMin: targetRelease.schemaMin,
      schemaMax: targetRelease.schemaMax,
      supportedWorkerRuntimes: targetRelease.supportedWorkerRuntimes,
      releasedAt: targetRelease.releasedAt,
      notesUrl: targetRelease.notesUrl ?? null,
      artifact: platformArtifact,
    },
    platform: {
      key: platformKey,
      supported: platformArtifact !== null,
    },
    updateAvailable,
  };

  writeOutput(flags, body, renderUpdateCheck);
  return 0;
}

export async function handleRollbackCommand(
  flags: Record<string, string | boolean>
): Promise<number> {
  const result = await rollbackRuntimeInstall(
    typeof flags.to === "string" ? flags.to : undefined
  );
  writeOutput(flags, result, renderRollbackResult);
  return 0;
}

export async function handleWorkerCommand(
  args: string[],
  flags: Record<string, string | boolean>
): Promise<number> {
  const command = args[0];

  switch (command) {
    case "start": {
      const workerRuntime =
        typeof flags.runtime === "string" ? flags.runtime : process.env.VILANO_WORKER_RUNTIME ?? "bun";
      if (workerRuntime !== "bun" && workerRuntime !== "node") {
        throw new CliError("Usage: vilano worker start [--runtime <bun|node>] [--once] [--worker-id <id>] [--server <url>]");
      }

      const daemonState = await readJsonFile<DaemonState | null>(getRuntimePaths().daemonStateFile, null);
      const serverUrl = resolveWorkerServerUrl(flags, daemonState);
      const bundle = await prepareRuntimeBundle();
      const workerEntry = path.join(bundle.workerDir, workerRuntime, "src", "cli.ts");
      const launch = await resolveWorkerLaunchCommand(bundle, workerRuntime, workerEntry);
      const childArgs = [...launch.prefixArgs, "--server", serverUrl];

      if (typeof flags["worker-id"] === "string") {
        childArgs.push("--worker-id", flags["worker-id"]);
      }

      if (flags.once) {
        childArgs.push("--once");
      }

      const workerAuthEnv = await resolveWorkerAuthEnv(serverUrl);
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(launch.executable, childArgs, {
          stdio: "inherit",
          env: {
            ...process.env,
            VILANO_HOME: "",
            ...workerAuthEnv,
          },
        });

        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      });

      return exitCode;
    }
    default:
      throw new CliError("Usage: vilano worker start [--runtime <bun|node>] [--once] [--worker-id <id>] [--server <url>]");
  }
}

async function resolveWorkerAuthEnv(serverUrl: string): Promise<Record<string, string>> {
  const daemonState = await readJsonFile<DaemonState | null>(getRuntimePaths().daemonStateFile, null);
  const daemonAuthState = await readDaemonAuthState();
  if (!daemonState || !daemonAuthState?.workerAuthToken) {
    return {};
  }

  try {
    const parsed = new URL(serverUrl);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";

    if (isLoopback && port === daemonState.port) {
      return {
        VILANO_WORKER_TOKEN: daemonAuthState.workerAuthToken,
        VILANO_WORKER_ARTIFACT_HOME: getRuntimePaths().artifactHomeDir,
        VILANO_WORKER_HOME: getRuntimePaths().workerHomeDir,
      };
    }
  } catch {
    return {};
  }

  return {};
}

async function resolveWorkerLaunchCommand(
  bundle: Awaited<ReturnType<typeof prepareRuntimeBundle>>,
  workerRuntime: "bun" | "node",
  workerEntry: string
): Promise<{ executable: string; prefixArgs: string[] }> {
  if (!bundle.source.bundled) {
    return {
      executable: workerRuntime === "node" ? "node" : "bun",
      prefixArgs: [workerEntry],
    };
  }

  if (workerRuntime === "bun") {
    const bundledBun = path.join(bundle.source.cliRoot, "bun", "bun");
    if (!(await fileExists(bundledBun))) {
      throw new CliError(`Packaged Vilano runtime is missing bundled bun at ${bundledBun}. Reinstall Vilano Runtime.`);
    }

    return {
      executable: bundledBun,
      prefixArgs: [workerEntry],
    };
  }

  const installManifest = await readJsonFile<RuntimeBundleManifest | null>(bundle.installManifestFile, null);
  if (!installManifest?.supportedWorkerRuntimes.includes("node")) {
    throw new CliError(
      "Packaged Vilano runtime does not bundle the preview Node worker. Use `vilano worker start --runtime bun` or run from a repo checkout with Node on PATH."
    );
  }

  const bundledNode = path.join(bundle.source.cliRoot, "node", "node");
  if (!(await fileExists(bundledNode))) {
    throw new CliError(`Packaged Vilano runtime declares Node worker support but is missing bundled node at ${bundledNode}.`);
  }

  return {
    executable: bundledNode,
    prefixArgs: [workerEntry],
  };
}

function resolveWorkerServerUrl(
  flags: Record<string, string | boolean>,
  daemonState: DaemonState | null
): string {
  if (typeof flags.server === "string") {
    return flags.server;
  }

  if (typeof flags.url === "string") {
    return flags.url;
  }

  if (daemonState?.port) {
    return `http://127.0.0.1:${daemonState.port}`;
  }

  return "http://127.0.0.1:4141";
}
