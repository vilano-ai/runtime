import { spawn } from "node:child_process";
import process from "node:process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    streamToString(child.stdout),
    streamToString(child.stderr),
    new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 0));
    }),
  ]);

  if (exitCode !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        stdout ? `stdout:\n${stdout}` : "",
        stderr ? `stderr:\n${stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return { stdout, stderr, exitCode };
}

export async function tryRunCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<CommandResult | null> {
  try {
    return await runCommand(command, args, options);
  } catch {
    return null;
  }
}

export function firstNonEmptyLine(text: string): string | null {
  return (
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}

async function streamToString(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) {
    return "";
  }

  let data = "";
  for await (const chunk of stream) {
    data += chunk.toString();
  }
  return data;
}
