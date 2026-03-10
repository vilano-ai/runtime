import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { readJsonFile } from "../json-file.ts";
import { runDoctor } from "../doctor.ts";
import {
  ensureDaemonStarted,
  getRunningDaemonStatus,
  readDaemonAuthState,
  resolveDefaultKernelPort,
  stopDaemon,
} from "../daemon-client.ts";
import {
  renderDaemonStatus,
  renderDoctorReport,
  renderVersionInfo,
  writeOutput,
} from "../output.ts";
import { getRuntimePaths } from "../runtime-home.ts";
import { prepareRuntimeBundle, prepareRuntimeBundleWithOptions } from "../runtime-materializer.ts";
import { CLI_PROTOCOL_VERSION, getCliVersion } from "../runtime-version.ts";
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
        writeOutput(flags, { ok: true, running: false }, () => "Vilano kernel is not running");
        return 0;
      }

      writeOutput(flags, status, renderDaemonStatus);
      return 0;
    }
    case "stop": {
      const stopped = await stopDaemon();
      if (!stopped) {
        writeOutput(flags, { ok: true, running: false }, () => "Vilano kernel is not running");
        return 0;
      }

      writeOutput(
        flags,
        { ok: true, stopped: true, pid: stopped.pid, port: stopped.port },
        (body) => `Vilano kernel stopped\npid: ${body.pid}\nport: ${body.port}`
      );
      return 0;
    }
    default:
      throw new CliError("Usage: vilano daemon start|status|stop");
  }
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
      const executable = workerRuntime === "node" ? "node" : "bun";
      const childArgs = [workerEntry, "--server", serverUrl];

      if (typeof flags["worker-id"] === "string") {
        childArgs.push("--worker-id", flags["worker-id"]);
      }

      if (flags.once) {
        childArgs.push("--once");
      }

      const workerAuthEnv = await resolveWorkerAuthEnv(serverUrl);
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(executable, childArgs, {
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
