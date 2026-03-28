import fs from "node:fs/promises";
import crypto from "node:crypto";
import process from "node:process";

import type { ServiceDefinition } from "./runtime-sdk.ts";
import {
  WorkerClient,
  type ServiceTurnActivation,
  type WorkflowActivation,
} from "./client.ts";
import { beginActivationSession, type ActivationSession } from "./activation-session.ts";
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
  let session: ActivationSession | null = null;
  let serviceDefinition: ServiceDefinition<any, any, any, any, any> | null = null;
  let serviceRetry: ServiceDefinition<any, any, any, any, any>["retry"] | undefined;

  try {
    session = await beginActivationSession(
      activation,
      heartbeatIntervalMs,
      workerHomePath,
      {
        send: async () => await client.heartbeat(activation.leaseId),
      }
    );
    const workspace = session.workspace;

    if (activation.kind === "workflow") {
      const definition = await session.withProjectCwd(async () =>
        await loadWorkflowDefinition(activation, {
          cacheKey: activation.leaseId,
          importRoot: activation.project.path,
        })
      );

      await session.withWorkspaceCwd(async () => {
        const ctx = createTurnContext(adapter, client, activation, workspace);
        const result = await definition.run(activation.run.input, ctx);
        await client.completeRun(activation.leaseId, result);
      });
      return;
    }

    serviceDefinition = await session.withProjectCwd(async () =>
      await loadServiceDefinition(activation, {
        cacheKey: activation.leaseId,
        importRoot: activation.project.path,
      })
    );
    serviceRetry = serviceDefinition.retry;

    await session.withWorkspaceCwd(async () => {
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
    client.clearLeaseAuthToken(activation.leaseId);
    if (session) {
      await session.close();
    }
  }
}
