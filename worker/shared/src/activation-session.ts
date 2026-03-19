import fs from "node:fs/promises";
import process from "node:process";

import type {
  ServiceTurnActivation,
  WorkflowActivation,
} from "./client.ts";
import { ensureActivationWorkspace } from "./activation-workspace.ts";

type Activation = WorkflowActivation | ServiceTurnActivation;

export interface ActivationSession {
  workspace: string;
  withProjectCwd<T>(fn: () => Promise<T>): Promise<T>;
  withWorkspaceCwd<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function beginActivationSession(
  activation: Activation,
  heartbeatIntervalMs: number,
  workerHomePath: string,
  heartbeat: {
    send(): Promise<void>;
  }
): Promise<ActivationSession> {
  let heartbeatFailureCount = 0;
  const interval = setInterval(() => {
    void heartbeat
      .send()
      .then(() => {
        heartbeatFailureCount = 0;
      })
      .catch((error) => {
        heartbeatFailureCount += 1;

        if (heartbeatFailureCount === 1 || heartbeatFailureCount % 5 === 0) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[vilano-worker] heartbeat failed lease=${activation.leaseId} run=${activation.run.id} consecutive_failures=${heartbeatFailureCount} error=${message}`
          );
        }
      });
  }, heartbeatIntervalMs);

  try {
    const workspace = await ensureActivationWorkspace(
      workerHomePath,
      activation,
      activation.project.path
    );

    if (!workspace) {
      throw new Error("Activation staging did not produce an execution workspace");
    }

    return {
      workspace,
      withProjectCwd: async <T>(fn: () => Promise<T>) =>
        await withActivationCwd(activation.project.path, fn),
      withWorkspaceCwd: async <T>(fn: () => Promise<T>) =>
        await withActivationCwd(workspace, fn),
      close: async () => {
        clearInterval(interval);
        await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    clearInterval(interval);
    throw error;
  }
}

async function withActivationCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  process.chdir(cwd);

  try {
    return await fn();
  } finally {
    process.chdir(previousCwd);
  }
}
