import path from "node:path";
import process from "node:process";

import { sleep } from "./runtime-harness-utils.ts";

const ROOT = path.resolve(import.meta.dir, "..");

export class SpawnedCommand {
  private waitPromise: Promise<{ stdout: string; stderr: string; exitCode: number }> | null = null;

  constructor(
    private readonly proc: Bun.Subprocess<any, "pipe", "pipe">,
    private readonly onSettled: () => void
  ) {}

  get pid(): number {
    return this.proc.pid;
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    void killProcessTree(this.proc.pid, signal).catch(() => undefined);
  }

  async wait(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return await this.ensureWaitPromise();
  }

  async terminate(): Promise<void> {
    const waitPromise = this.ensureWaitPromise();

    await killProcessTree(this.proc.pid, "SIGTERM").catch(() => undefined);
    if (await waitForPromiseSettled(waitPromise, 1_500)) {
      return;
    }

    await killProcessTree(this.proc.pid, "SIGKILL").catch(() => undefined);
    await waitForPromiseSettled(waitPromise, 1_500);
  }

  forceKillSync(): void {
    forceKillPidSync(this.proc.pid);
  }

  private ensureWaitPromise(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!this.waitPromise) {
      this.waitPromise = Promise.all([
        streamToText(this.proc.stdout),
        streamToText(this.proc.stderr),
        this.proc.exited,
      ])
        .then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }))
        .finally(() => {
          this.onSettled();
        });
    }

    return this.waitPromise;
  }
}

async function streamToText(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>> | number | null | undefined
): Promise<string> {
  if (!stream || typeof stream === "number") {
    return "";
  }

  return await new Response(stream).text();
}

export async function terminateDetachedProcessGroup(pid: number | null): Promise<void> {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return;
  }

  signalProcessGroup(pid as number, "SIGTERM");
  if (await waitForProcessExit(pid as number, 1_500)) {
    return;
  }

  signalProcessGroup(pid as number, "SIGKILL");
  if (await waitForProcessExit(pid as number, 1_500)) {
    return;
  }

  await killProcessTree(pid as number, "SIGKILL").catch(() => undefined);
}

export async function killProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  const childPids = await listChildPids(pid);
  for (const childPid of childPids.reverse()) {
    signalPid(childPid, signal);
  }

  signalPid(pid, signal);
}

async function listChildPids(rootPid: number): Promise<number[]> {
  const proc = Bun.spawn(["ps", "-axo", "pid=,ppid="], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  const childrenByParent = new Map<number, number[]>();

  for (const line of output.split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/, 2);
    const pid = Number.parseInt(pidText ?? "", 10);
    const parentPid = Number.parseInt(parentText ?? "", 10);

    if (!Number.isFinite(pid) || !Number.isFinite(parentPid)) {
      continue;
    }

    const siblings = childrenByParent.get(parentPid) ?? [];
    siblings.push(pid);
    childrenByParent.set(parentPid, siblings);
  }

  const discovered: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];

  while (queue.length > 0) {
    const nextPid = queue.shift()!;
    discovered.push(nextPid);
    queue.push(...(childrenByParent.get(nextPid) ?? []));
  }

  return discovered;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }
}

export function forceKillProcessGroupSync(pid: number | null): void {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return;
  }

  try {
    process.kill(-(pid as number), "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }

  forceKillPidSync(pid);
}

export function forceKillPidSync(pid: number | null): void {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return;
  }

  signalPid(pid as number, "SIGKILL");
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await isProcessAlive(pid))) {
      return true;
    }

    await sleep(100);
  }

  return !(await isProcessAlive(pid));
}

async function waitForPromiseSettled<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    sleep(timeoutMs).then(() => false),
  ]);
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}
