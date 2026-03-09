import os from "node:os";
import path from "node:path";

export interface RuntimePaths {
  homeDir: string;
  daemonStateFile: string;
  runtimeBundlesDir: string;
  runtimeCacheDir: string;
  projectSnapshotsDir: string;
}

export function getRuntimePaths(): RuntimePaths {
  const homeDir = process.env.VILANO_HOME
    ? path.resolve(process.env.VILANO_HOME)
    : path.join(os.homedir(), ".vilano");

  return {
    homeDir,
    daemonStateFile: path.join(homeDir, "daemon.json"),
    runtimeBundlesDir: path.join(homeDir, "runtime-bundles"),
    runtimeCacheDir: path.join(homeDir, "runtime-cache"),
    projectSnapshotsDir: path.join(homeDir, "project-snapshots"),
  };
}
