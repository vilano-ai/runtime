import fs from "node:fs/promises";
import crypto from "node:crypto";
import process from "node:process";

import type {
  ServiceDefinition,
} from "./runtime-sdk.ts";
import {
  WorkerClient,
  type ServiceTurnActivation,
  type WorkflowActivation,
} from "./client.ts";
import {
  ensureActivationWorkspace,
} from "./activation-workspace.ts";
import { executeServiceTurn } from "./service-turn.ts";
import { createTurnContext } from "./workflow-context.ts";
import { loadServiceDefinition, loadWorkflowDefinition } from "./definitions.ts";
import type { RuntimeAdapter } from "./runtime-adapter.ts";
import { WORKER_PROTOCOL_VERSION } from "./runtime-version.ts";
import {
  ActivationCancelledError,
  RunSuspendedError,
  TurnHandledError,
  isInactiveActivationError,
  setRuntimeHomeOverride,
  toFailureBody,
  toRetryPolicy,
} from "./runtime-utils.ts";

type Activation = WorkflowActivation | ServiceTurnActivation;

export interface WorkerOptions {
  workerId?: string;
  serverUrl?: string;
  authToken?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  once?: boolean;
}

export async function startWorker(
  adapter: RuntimeAdapter,
  options: WorkerOptions = {}
): Promise<void> {
  const artifactHome =
    process.env.VILANO_WORKER_ARTIFACT_HOME ??
    process.env.VILANO_RUNTIME_HOME ??
    process.env.VILANO_HOME ??
    process.env.VILANO_WORKER_HOME;
  const workerHome = process.env.VILANO_WORKER_HOME ?? artifactHome;
  if (workerHome) {
    await fs.mkdir(workerHome, { recursive: true });
    process.chdir(workerHome);
  }
  const workerHomePath = process.cwd();
  setRuntimeHomeOverride(artifactHome ? artifactHome : null);

  const workerId = options.workerId ?? `worker-${crypto.randomUUID()}`;
  const serverUrl = options.serverUrl ?? "http://127.0.0.1:4141";
  const authToken = options.authToken ?? process.env.VILANO_WORKER_TOKEN;
  delete process.env.VILANO_WORKER_TOKEN;
  delete process.env.VILANO_DAEMON_TOKEN;
  delete process.env.VILANO_WORKER_ARTIFACT_HOME;
  delete process.env.VILANO_RUNTIME_HOME;
  delete process.env.VILANO_WORKER_HOME;
  delete process.env.VILANO_HOME;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const client = new WorkerClient(serverUrl, workerId, authToken);
  const status = await client.assertCompatible(WORKER_PROTOCOL_VERSION);
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ??
    Math.max(1000, Math.floor((status.leaseDurationSeconds * 1000) / 3));

  while (true) {
    let activation: WorkflowActivation | ServiceTurnActivation | null;

    try {
      activation = await client.leaseActivation();
    } catch (error) {
      if (options.once) {
        throw error;
      }

      await adapter.sleep(pollIntervalMs);
      continue;
    }

    if (!activation) {
      if (options.once) {
        return;
      }

      await adapter.sleep(pollIntervalMs);
      continue;
    }

    await executeActivation(adapter, client, activation, heartbeatIntervalMs, workerHomePath);

    if (options.once) {
      return;
    }
  }
}

export async function executeActivation(
  adapter: RuntimeAdapter,
  client: WorkerClient,
  activation: Activation,
  heartbeatIntervalMs: number,
  workerHomePath: string
): Promise<void> {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let heartbeatFailureCount = 0;
  let activationWorkspace: string | null = null;
  let serviceDefinition: ServiceDefinition<any, any, any, any, any> | null = null;
  let serviceRetry: ServiceDefinition<any, any, any, any, any>["retry"] | undefined;

  try {
    heartbeat = setInterval(() => {
      void client
        .heartbeat(activation.leaseId)
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
    activationWorkspace = await ensureActivationWorkspace(
      workerHomePath,
      activation,
      activation.project.path
    );
    if (!activationWorkspace) {
      throw new Error("Activation staging did not produce an execution workspace");
    }

    if (activation.kind === "workflow") {
      const workspace = activationWorkspace;
      const definition = await withActivationCwd(activation.project.path, async () =>
        await loadWorkflowDefinition(activation, {
          cacheKey: activation.leaseId,
          importRoot: activation.project.path,
        })
      );

      await withActivationCwd(workspace, async () => {
        const ctx = createTurnContext(adapter, client, activation, workspace);
        const result = await definition.run(activation.run.input, ctx);
        await client.completeRun(activation.leaseId, result);
      });
      return;
    }

    const workspace = activationWorkspace;
    serviceDefinition = await withActivationCwd(activation.project.path, async () =>
      await loadServiceDefinition(activation, {
        cacheKey: activation.leaseId,
        importRoot: activation.project.path,
      })
    );
    serviceRetry = serviceDefinition.retry;

    await withActivationCwd(workspace, async () => {
      await executeServiceTurn(
        adapter,
        client,
        activation,
        serviceDefinition as ServiceDefinition<any, any, any, any, any>,
        workspace
      );
    });
  } catch (error) {
    if (error instanceof RunSuspendedError) {
      return;
    }

    if (error instanceof TurnHandledError) {
      return;
    }

    if (error instanceof ActivationCancelledError || isInactiveActivationError(error)) {
      return;
    }

    if (activation.kind === "workflow") {
      try {
        await client.failRun(activation.leaseId, toFailureBody(error));
      } catch (reportError) {
        if (reportError instanceof ActivationCancelledError || isInactiveActivationError(reportError)) {
          return;
        }

        throw reportError;
      }
    } else {
      try {
        const failedTurn = await client.failServiceTurn(
          activation.leaseId,
          activation.envelope.id,
          toFailureBody(error),
          toRetryPolicy(serviceRetry)
        );

        if (failedTurn.status === "retry_waiting") {
          return;
        }
      } catch (reportError) {
        if (reportError instanceof ActivationCancelledError || isInactiveActivationError(reportError)) {
          return;
        }

        throw reportError;
      }
    }
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    client.clearLeaseAuthToken(activation.leaseId);
    if (activationWorkspace) {
      await fs.rm(activationWorkspace, { recursive: true, force: true }).catch(() => undefined);
    }
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
