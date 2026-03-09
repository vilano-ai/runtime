import { spawn } from "node:child_process";
import { Readable } from "node:stream";

export interface SpawnedProcess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  getSignalCode(): string | null;
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

      const exited = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          resolve(code ?? 0);
        });
      });

      return {
        stdout: child.stdout ? toReadableStream(child.stdout) : null,
        stderr: child.stderr ? toReadableStream(child.stderr) : null,
        exited,
        getSignalCode() {
          return child.signalCode;
        },
        kill(signal = "SIGKILL") {
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
