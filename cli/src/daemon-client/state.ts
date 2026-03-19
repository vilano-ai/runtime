import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { readJsonFile, writeJsonFileAtomic } from "../json-file.ts";
import { getRuntimePaths } from "../runtime-home.ts";
import type { DaemonAuthState, DaemonState } from "../types.ts";

export async function readDaemonState(): Promise<DaemonState | null> {
  return await readJsonFile<DaemonState | null>(getRuntimePaths().daemonStateFile, null);
}

export async function readDaemonAuthState(): Promise<DaemonAuthState | null> {
  return await readJsonFile<DaemonAuthState | null>(getRuntimePaths().daemonAuthFile, null);
}

export async function writeDaemonStateFiles(
  daemonState: DaemonState,
  daemonAuthState: DaemonAuthState
): Promise<void> {
  const runtimePaths = getRuntimePaths();
  await writeJsonFileAtomic(runtimePaths.daemonStateFile, daemonState);
  await writeJsonFileAtomic(runtimePaths.daemonAuthFile, daemonAuthState);
}

export async function clearDaemonStateFiles(): Promise<void> {
  const runtimePaths = getRuntimePaths();
  await fs.rm(runtimePaths.daemonStateFile, { force: true });
  await fs.rm(runtimePaths.daemonAuthFile, { force: true });
}

export async function isProcessAlive(pid: number | null | undefined): Promise<boolean> {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return false;
  }

  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      return true;
    }

    return false;
  }
}

export function generateDaemonAuthToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function deriveReleaseNodeName(homeDir: string): string {
  const suffix = crypto
    .createHash("sha256")
    .update(path.resolve(homeDir))
    .digest("hex")
    .slice(0, 12);

  return `vilano_kernel_${suffix}`;
}
