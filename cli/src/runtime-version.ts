import fs from "node:fs";
import path from "node:path";

export const CLI_PROTOCOL_VERSION = 2;

let cachedCliVersion: string | null = null;

export function getCliVersion(): string {
  if (cachedCliVersion) {
    return cachedCliVersion;
  }

  const packageJsonPath = path.resolve(import.meta.dir, "..", "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    version?: string;
  };

  cachedCliVersion = packageJson.version ?? "0.0.0";
  return cachedCliVersion;
}
