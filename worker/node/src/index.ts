export interface WorkerOptions {
  workerId?: string;
  serverUrl?: string;
  projectRoot?: string;
}

export async function startWorker(options: WorkerOptions = {}): Promise<void> {
  const workerId = options.workerId ?? "worker-local";
  const serverUrl = options.serverUrl ?? "http://127.0.0.1:4141";

  console.log(
    `[vilano-worker] bootstrap placeholder: worker_id=${workerId} server_url=${serverUrl}`
  );
}
