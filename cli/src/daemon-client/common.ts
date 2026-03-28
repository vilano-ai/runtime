import process from "node:process";

import type { components as ControlComponents } from "../../../protocol/v1/generated/control.ts";
import { CLI_PROTOCOL_VERSION } from "../runtime-version.ts";
import type { DaemonState, DaemonStatusResponse } from "../types.ts";

export interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  pathname: string;
  body?: unknown;
  autoStart?: boolean;
}

export type KernelStatusBody = ControlComponents["schemas"]["StatusResponse"];

export class KernelRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "KernelRequestError";
  }
}

export function toDaemonStatus(
  state: DaemonState,
  body: KernelStatusBody
): DaemonStatusResponse {
  return {
    ok: true,
    pid: state.pid,
    port: state.port,
    startedAt: body.startedAt,
    runtimeDbPath: body.runtimeDbPath,
    runtimeVersion: body.runtimeVersion,
    protocolVersion: body.protocolVersion,
    schemaVersion: body.schemaVersion,
    appliedMigrations: body.appliedMigrations,
    homeDir: body.homeDir,
    executionHomeDir: body.executionHomeDir,
    projectRoot: body.projectRoot,
    managedWorkerCount: body.managedWorkerCount,
    managedWorkerRuntime: body.managedWorkerRuntime,
    leaseDurationSeconds: body.leaseDurationSeconds,
    projectCount: body.projectCount,
  };
}

export function assertCompatibleKernelStatus(
  status: Pick<DaemonStatusResponse, "protocolVersion" | "runtimeVersion">
): void {
  if (
    typeof status.protocolVersion !== "number" ||
    status.protocolVersion !== CLI_PROTOCOL_VERSION
  ) {
    throw new Error(
      `Vilano Runtime CLI protocol version ${CLI_PROTOCOL_VERSION} is incompatible with kernel runtime ${status.runtimeVersion} (protocol ${status.protocolVersion})`
    );
  }
}

export async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export function resolveDefaultKernelPort(): number {
  const raw = process.env.VILANO_KERNEL_PORT;
  if (!raw) {
    return 4141;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 4141;
  }

  return parsed;
}
