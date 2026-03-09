import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export interface RuntimePaths {
  homeDir: string;
  executionHomeDir: string;
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
  const resolvedHomeDir = path.resolve(homeDir);
  const parentDir = path.dirname(resolvedHomeDir);
  const baseName = sanitizePathSegment(path.basename(resolvedHomeDir) || "vilano");
  const suffix = crypto.createHash("sha256").update(resolvedHomeDir).digest("hex").slice(0, 12);
  return path.join(parentDir, `.${baseName}-execution-${suffix}`);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}
