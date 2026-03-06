import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { StepOptions, WorkflowContext, WorkflowDefinition } from "@vilano/runtime";

import { WorkerClient, type WorkflowActivation } from "./client.ts";

export interface WorkerOptions {
  workerId?: string;
  serverUrl?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  once?: boolean;
}

export async function startWorker(options: WorkerOptions = {}): Promise<void> {
  const workerId = options.workerId ?? `worker-${crypto.randomUUID()}`;
  const serverUrl = options.serverUrl ?? "http://127.0.0.1:4141";
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
  const client = new WorkerClient(serverUrl, workerId);

  while (true) {
    const activation = await client.leaseActivation();
    if (!activation) {
      if (options.once) {
        return;
      }

      await sleep(pollIntervalMs);
      continue;
    }

    await executeActivation(client, activation, heartbeatIntervalMs);

    if (options.once) {
      return;
    }
  }
}

async function executeActivation(
  client: WorkerClient,
  activation: WorkflowActivation,
  heartbeatIntervalMs: number
): Promise<void> {
  const heartbeat = setInterval(() => {
    void client.heartbeat(activation.leaseId).catch(() => undefined);
  }, heartbeatIntervalMs);

  try {
    const definition = await loadWorkflowDefinition(activation);
    const ctx = createWorkflowContext(client, activation);
    const result = await definition.run(activation.run.input, ctx);
    await client.completeRun(activation.leaseId, result);
  } catch (error) {
    await client.failRun(activation.leaseId, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

async function loadWorkflowDefinition(
  activation: WorkflowActivation
): Promise<WorkflowDefinition<any, any>> {
  const absolutePath = path.join(activation.project.path, activation.definition.file);
  const moduleUrl = pathToFileURL(absolutePath).href;
  const moduleExports = (await import(moduleUrl)) as Record<string, unknown>;
  const definition = moduleExports[activation.definition.exportName];

  if (!definition || typeof definition !== "object" || (definition as { kind?: string }).kind !== "workflow") {
    throw new Error(
      `Export '${activation.definition.exportName}' from ${activation.definition.file} is not a workflow definition`
    );
  }

  return definition as WorkflowDefinition<any, any>;
}

function createWorkflowContext(client: WorkerClient, activation: WorkflowActivation): WorkflowContext {
  return {
    runId: activation.run.id,
    async step<TOutput>(
      name: string,
      fn: () => Promise<TOutput> | TOutput,
      options: StepOptions = {}
    ) {
      const key = options.key ?? name;
      const existing = await client.resolveStep(activation.leaseId, name, key);
      if (existing.status === "completed") {
        return existing.output as TOutput;
      }

      const output = await fn();
      await client.completeStep(activation.leaseId, name, key, output);
      return output;
    },
    async exec() {
      throw new Error("ctx.exec() is not implemented yet");
    },
    async sleep() {
      throw new Error("ctx.sleep() is not implemented yet");
    },
    async waitForSignal() {
      throw new Error("ctx.waitForSignal() is not implemented yet");
    },
    async log(message: string, fields?: Record<string, unknown>) {
      console.log("[vilano-worker]", activation.run.id, message, fields ?? {});
    },
    spawn() {
      throw new Error("ctx.spawn() is not implemented yet");
    },
    async connect() {
      throw new Error("ctx.connect() is not implemented yet");
    },
  };
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
