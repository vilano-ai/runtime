import os from "node:os";
import path from "node:path";

export interface RuntimePaths {
  homeDir: string;
  executionHomeDir: string;
  artifactHomeDir: string;
  daemonStateFile: string;
  daemonAuthFile: string;
  daemonStartupLogFile: string;
  runtimeBundlesDir: string;
  runtimeCacheDir: string;
  projectSnapshotsDir: string;
  workerHomeDir: string;
  runWorkspacesDir: string;
}

export function getRuntimePaths(): RuntimePaths {
  const homeDir = process.env.VILANO_HOME
    ? path.resolve(process.env.VILANO_HOME)
    : path.join(os.homedir(), ".vilano");
  const executionHomeDir = deriveExecutionHomeDir(homeDir);

  return {
    homeDir,
    executionHomeDir,
    artifactHomeDir: path.join(executionHomeDir, "artifacts"),
    daemonStateFile: path.join(homeDir, "daemon.json"),
    daemonAuthFile: path.join(homeDir, "daemon-auth.json"),
    daemonStartupLogFile: path.join(homeDir, "kernel-startup.log"),
    runtimeBundlesDir: path.join(homeDir, "runtime-bundles"),
    runtimeCacheDir: path.join(homeDir, "runtime-cache"),
    projectSnapshotsDir: path.join(executionHomeDir, "project-snapshots"),
    workerHomeDir: path.join(executionHomeDir, "worker-home"),
    runWorkspacesDir: path.join(executionHomeDir, "run-workspaces"),
  };
}

export function deriveExecutionHomeDir(homeDir: string): string {
  if (process.env.VILANO_EXECUTION_HOME) {
    return path.resolve(process.env.VILANO_EXECUTION_HOME);
  }

  const resolvedHomeDir = path.resolve(homeDir);
  return path.join(resolvedHomeDir, "execution");
}
