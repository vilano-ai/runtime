import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";

export interface ProcessExitStatus {
  exitCode: number | null;
  signalCode: string | null;
}

export interface SpawnedProcess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<ProcessExitStatus>;
  kill(signal?: NodeJS.Signals): void;
}

export interface RuntimeAdapter {
  runtime: "bun" | "node";
  sleep(ms: number): Promise<void>;
  spawnProcess(input: {
    cmd: string;
    args: string[];
    cwd: string;
    env: Record<string, string | undefined>;
  }): SpawnedProcess;
}

export function createNodeCompatibleRuntimeAdapter(
  runtime: "bun" | "node"
): RuntimeAdapter {
  return {
    runtime,
    sleep,
    spawnProcess({ cmd, args, cwd, env }) {
      const child = spawn(cmd, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const exited = new Promise<ProcessExitStatus>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          resolve({
            exitCode: code,
            signalCode: signal,
          });
        });
      });

      return {
        stdout: child.stdout ? toReadableStream(child.stdout) : null,
        stderr: child.stderr ? toReadableStream(child.stderr) : null,
        exited,
        kill(signal = "SIGKILL") {
          if (typeof child.pid === "number") {
            killProcessTree(child.pid, signal);
            return;
          }

          child.kill(signal);
        },
      };
    },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toReadableStream(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>;
}

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  for (const childPid of listDescendantPids(pid).reverse()) {
    try {
      process.kill(childPid, signal);
    } catch {
      // Ignore races where descendants have already exited.
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Ignore races where the process has already exited.
  }
}

function listDescendantPids(pid: number): number[] {
  const result = spawnSync("pgrep", ["-P", String(pid)], {
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  const directChildren = result.stdout
    .trim()
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  return directChildren.flatMap((childPid) => [childPid, ...listDescendantPids(childPid)]);
}
