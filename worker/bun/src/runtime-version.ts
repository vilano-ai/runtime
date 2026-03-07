import fs from "node:fs";
import path from "node:path";

export const WORKER_PROTOCOL_VERSION = 1;

let cachedWorkerVersion: string | null = null;

export function getWorkerVersion(): string {
  if (cachedWorkerVersion) {
    return cachedWorkerVersion;
  }

  const packageJsonPath = path.resolve(import.meta.dir, "..", "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    version?: string;
  };

  cachedWorkerVersion = packageJson.version ?? "0.0.0";
  return cachedWorkerVersion;
}
