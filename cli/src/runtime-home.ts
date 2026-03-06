import os from "node:os";
import path from "node:path";

export interface RuntimePaths {
  homeDir: string;
  registryFile: string;
  daemonStateFile: string;
}

export function getRuntimePaths(): RuntimePaths {
  const homeDir = process.env.VILANO_HOME
    ? path.resolve(process.env.VILANO_HOME)
    : path.join(os.homedir(), ".vilano");

  return {
    homeDir,
    registryFile: path.join(homeDir, "projects.json"),
    daemonStateFile: path.join(homeDir, "daemon.json"),
  };
}
