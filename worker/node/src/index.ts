import { startWorker as startSharedWorker } from "../../shared/src/core.ts";
import type { WorkerOptions } from "../../shared/src/core.ts";
import { createNodeCompatibleRuntimeAdapter } from "../../shared/src/runtime-adapter.ts";

const nodeRuntimeAdapter = createNodeCompatibleRuntimeAdapter("node");

export type { WorkerOptions } from "../../shared/src/core.ts";

export async function startWorker(options: WorkerOptions = {}): Promise<void> {
  await startSharedWorker(nodeRuntimeAdapter, options);
}
