import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { fileExists } from "../fs-utils.ts";
import { ensurePrivateDir } from "../json-file.ts";
import { getRuntimePaths } from "../runtime-home.ts";
import { prepareRuntimeBundle } from "../runtime-materializer.ts";
import { CLI_PROTOCOL_VERSION } from "../runtime-version.ts";
import type { DaemonAuthState, DaemonState, DaemonStatusResponse } from "../types.ts";
import {
  assertCompatibleKernelStatus,
  KernelRequestError,
  type KernelStatusBody,
  resolveDefaultKernelPort,
  sleep,
  toDaemonStatus,
} from "./common.ts";
import { pingKernelStatus, requestJsonWithState } from "./control.ts";
import {
  clearDaemonStateFiles,
  deriveReleaseNodeName,
  generateDaemonAuthToken,
  isProcessAlive,
  readDaemonAuthState,
  readDaemonState,
  writeDaemonStateFiles,
} from "./state.ts";

async function ensureRuntimeDirectories(): Promise<void> {
  const runtimePaths = getRuntimePaths();
  await ensurePrivateDir(runtimePaths.installRootDir);
  await ensurePrivateDir(runtimePaths.binDir);
  await ensurePrivateDir(runtimePaths.installsDir);
  await ensurePrivateDir(runtimePaths.cacheDir);
  await ensurePrivateDir(runtimePaths.homeDir);
  await ensurePrivateDir(runtimePaths.executionHomeDir);
  await ensurePrivateDir(runtimePaths.workerHomeDir);
  await ensurePrivateDir(runtimePaths.runWorkspacesDir);
}

export async function ensureDaemonStarted(
  port = resolveDefaultKernelPort()
): Promise<DaemonStatusResponse> {
  const status = await getRunningDaemonStatus();
  if (status) {
    return status;
  }

  const runtimePaths = getRuntimePaths();
  await ensureRuntimeDirectories();

  const bundle = await prepareRuntimeBundle();
  const kernelDir = bundle.kernelDir;
  const projectRoot = bundle.runtimeRoot;
  const authToken = generateDaemonAuthToken();
  const workerAuthToken = generateDaemonAuthToken();
  const kernelReleaseExecutable = path.join(kernelDir, "bin", "vilano_kernel");
  const bundledReleaseReady = await fileExists(kernelReleaseExecutable);
  const noCompile =
    process.env.VILANO_KERNEL_NO_COMPILE === "1" ||
    (bundle.materialized && bundledReleaseReady);
  const releaseNode = deriveReleaseNodeName(runtimePaths.homeDir);

  await fs.writeFile(runtimePaths.daemonStartupLogFile, "", { mode: 0o600 });
  const startupLogFd = fsSync.openSync(runtimePaths.daemonStartupLogFile, "a");

  const child = bundle.source.bundled
    ? spawn(kernelReleaseExecutable, ["start"], {
        cwd: kernelDir,
        detached: true,
        stdio: ["ignore", startupLogFd, startupLogFd],
        env: {
          ...process.env,
          RELEASE_NODE: releaseNode,
          VILANO_HOME: runtimePaths.homeDir,
          VILANO_EXECUTION_HOME: runtimePaths.executionHomeDir,
          VILANO_KERNEL_PORT: String(port),
          VILANO_ROOT: projectRoot,
          VILANO_DAEMON_TOKEN: authToken,
          VILANO_WORKER_TOKEN: workerAuthToken,
        },
      })
    : spawn("mix", noCompile ? ["run", "--no-compile", "--no-halt"] : ["run", "--no-halt"], {
        cwd: kernelDir,
        detached: true,
        stdio: ["ignore", startupLogFd, startupLogFd],
        env: {
          ...process.env,
          VILANO_HOME: runtimePaths.homeDir,
          VILANO_EXECUTION_HOME: runtimePaths.executionHomeDir,
          VILANO_KERNEL_PORT: String(port),
          VILANO_ROOT: projectRoot,
          VILANO_DAEMON_TOKEN: authToken,
          VILANO_WORKER_TOKEN: workerAuthToken,
        },
      });
  fsSync.closeSync(startupLogFd);

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && !bundle.source.bundled) {
        reject(
          new Error(
            "Failed to start the Vilano Runtime kernel because 'mix' was not found. Install Elixir 1.17+ and ensure `mix` is on your PATH."
          )
        );
        return;
      }

      if (code === "ENOENT" && bundle.source.bundled) {
        reject(
          new Error(
            `Failed to start the packaged Vilano Runtime kernel release at ${kernelReleaseExecutable}.`
          )
        );
        return;
      }

      reject(error);
    });
  });

  let childExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const kernelStatus = await pingKernelStatus(port, authToken);
    if (kernelStatus) {
      const daemonState: DaemonState = {
        version: 1,
        pid: child.pid ?? 0,
        port,
        startedAt: kernelStatus.startedAt,
        runtimeDbPath: kernelStatus.runtimeDbPath,
        runtimeVersion: kernelStatus.runtimeVersion,
        protocolVersion: kernelStatus.protocolVersion,
        schemaVersion: kernelStatus.schemaVersion,
      };
      const daemonAuthState: DaemonAuthState = {
        version: 1,
        authToken,
        workerAuthToken,
      };

      await writeDaemonStateFiles(daemonState, daemonAuthState);
      child.unref();
      const nextStatus = toDaemonStatus(daemonState, kernelStatus);
      assertCompatibleKernelStatus(nextStatus);
      return nextStatus;
    }

    if (childExit !== null) {
      const exit = childExit as {
        code: number | null;
        signal: NodeJS.Signals | null;
      };
      throw new Error(
        `Vilano Runtime kernel exited before startup (code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}). See ${runtimePaths.daemonStartupLogFile}`
      );
    }

    await sleep(150);
  }

  try {
    if (child.pid) {
      process.kill(child.pid, "SIGKILL");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
  }

  throw new Error(
    `Timed out waiting for the Vilano Runtime kernel to start. See ${runtimePaths.daemonStartupLogFile}`
  );
}

export async function stopDaemon(): Promise<DaemonStatusResponse | null> {
  const runtimePaths = getRuntimePaths();
  const daemonState = await readDaemonState();
  const daemonAuthState = await readDaemonAuthState();

  if (!daemonState || !daemonAuthState) {
    return null;
  }

  try {
    await requestJsonWithState<{ ok: true; shuttingDown: true }>(
      {
        port: daemonState.port,
        authToken: daemonAuthState.authToken,
      },
      {
        method: "POST",
        pathname: "/v1/admin/shutdown",
        autoStart: false,
      }
    );
  } catch (error) {
    if (error instanceof KernelRequestError && error.code === "unauthorized") {
      throw error;
    }

    const running = await pingKernelStatus(daemonState.port, daemonAuthState.authToken);
    if (!running) {
      if (await isProcessAlive(daemonState.pid)) {
        throw new Error(
          "Vilano Runtime kernel process is still running but the shutdown probe failed"
        );
      }

      await clearDaemonStateFiles();
      return null;
    }

    throw new Error("Vilano Runtime kernel is running but refused the shutdown request");
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const running = await pingKernelStatus(daemonState.port, daemonAuthState.authToken);
    if (!running) {
      if (await isProcessAlive(daemonState.pid)) {
        await sleep(150);
        continue;
      }

      await clearDaemonStateFiles();
      return {
        ok: true,
        pid: daemonState.pid,
        port: daemonState.port,
        startedAt: daemonState.startedAt,
        runtimeDbPath: daemonState.runtimeDbPath,
        runtimeVersion: daemonState.runtimeVersion ?? "unknown",
        protocolVersion: daemonState.protocolVersion ?? CLI_PROTOCOL_VERSION,
        schemaVersion: daemonState.schemaVersion ?? 0,
        appliedMigrations: [],
        homeDir: runtimePaths.homeDir,
        executionHomeDir: runtimePaths.executionHomeDir,
        projectRoot: "",
        managedWorkerCount: 0,
        managedWorkerRuntime: "unknown",
        leaseDurationSeconds: 0,
        sqliteBusyTimeoutMs: 0,
        projectCount: 0,
      };
    }

    await sleep(150);
  }

  throw new Error("Timed out waiting for the Vilano Runtime kernel to stop");
}

export async function getRunningDaemonStatus(): Promise<DaemonStatusResponse | null> {
  const daemonState = await readDaemonState();
  const daemonAuthState = await readDaemonAuthState();

  if (!daemonState || !daemonAuthState) {
    return null;
  }

  try {
    const kernelStatus = await requestJsonWithState<KernelStatusBody>(
      {
        port: daemonState.port,
        authToken: daemonAuthState.authToken,
      },
      {
        method: "GET",
        pathname: "/v1/status",
        autoStart: false,
      }
    );

    const status = toDaemonStatus(daemonState, kernelStatus);
    assertCompatibleKernelStatus(status);
    return status;
  } catch (error) {
    if (error instanceof Error && error.message.includes("protocol version")) {
      throw error;
    }

    if (error instanceof KernelRequestError && error.code === "unauthorized") {
      throw error;
    }

    if (await isProcessAlive(daemonState.pid)) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Vilano Runtime kernel process is still running but the status probe failed: ${reason}`
      );
    }

    await clearDaemonStateFiles();
    return null;
  }
}
