import os from "node:os";
import path from "node:path";

export interface RuntimePaths {
  rootDir: string;
  homeDir: string;
  installRootDir: string;
  binDir: string;
  installsDir: string;
  cacheDir: string;
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
  const installRootDir = resolveInstallRootDir();
  const homeDir = process.env.VILANO_HOME
    ? path.resolve(process.env.VILANO_HOME)
    : path.join(installRootDir, "state");
  const executionHomeDir = deriveExecutionHomeDir(homeDir);

  return {
    rootDir: installRootDir,
    homeDir,
    installRootDir,
    binDir: path.join(installRootDir, "bin"),
    installsDir: path.join(installRootDir, "installs"),
    cacheDir: path.join(installRootDir, "cache"),
    executionHomeDir,
    artifactHomeDir: path.join(executionHomeDir, "artifacts"),
    daemonStateFile: path.join(homeDir, "daemon.json"),
    daemonAuthFile: path.join(homeDir, "daemon-auth.json"),
    daemonStartupLogFile: path.join(homeDir, "kernel-startup.log"),
    runtimeBundlesDir: path.join(installRootDir, "installs"),
    runtimeCacheDir: path.join(installRootDir, "cache"),
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

function resolveInstallRootDir(): string {
  if (process.env.VILANO_INSTALL_ROOT) {
    return path.resolve(process.env.VILANO_INSTALL_ROOT);
  }

  if (process.env.VILANO_HOME) {
    const resolvedHomeDir = path.resolve(process.env.VILANO_HOME);
    return path.basename(resolvedHomeDir) === "state"
      ? path.dirname(resolvedHomeDir)
      : resolvedHomeDir;
  }

  return path.join(os.homedir(), ".vilano");
}
