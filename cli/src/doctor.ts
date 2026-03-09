import fs from "node:fs/promises";
import { spawn } from "node:child_process";

import { getRunningDaemonStatus } from "./daemon-client.ts";
import { getRuntimePaths } from "./runtime-home.ts";
import { prepareRuntimeBundle } from "./runtime-materializer.ts";
import { CLI_PROTOCOL_VERSION, getCliVersion } from "./runtime-version.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  cliVersion: string;
  protocolVersion: number;
  runtimeHome: string;
  daemonStateFile: string;
  runtimeBundle: {
    root: string;
    sourceRoot: string;
    kernelDir: string;
    workerDir: string;
    bundled: boolean;
    materialized: boolean;
    bundleVersion: string;
  };
  tools: {
    bun: ToolCheck;
    mix: ToolCheck;
    elixir: ToolCheck;
  };
  kernel: {
    depsReady: boolean;
    buildReady: boolean;
    running: boolean;
    status: Awaited<ReturnType<typeof getRunningDaemonStatus>>;
    error: string | null;
  };
  appliedFixes: string[];
  checks: DoctorCheck[];
}

interface ToolCheck {
  found: boolean;
  path: string | null;
  version: string | null;
}

export async function runDoctor(options: { fix?: boolean } = {}): Promise<DoctorReport> {
  const runtimePaths = getRuntimePaths();
  const bundle = await prepareRuntimeBundle();
  const appliedFixes: string[] = [];

  if (options.fix) {
    appliedFixes.push(...(await applyDoctorFixes(bundle.kernelDir)));
  }

  const [bunTool, mixTool, elixirTool, daemonState, depsReady, buildReady] = await Promise.all([
    inspectTool("bun", ["--version"]),
    inspectTool("mix", ["--version"]),
    inspectTool("elixir", ["--version"]),
    getDaemonStatusReport(),
    fileExists(`${bundle.kernelDir}/deps`),
    fileExists(`${bundle.kernelDir}/_build`),
  ]);

  const daemonStatus = daemonState.status;
  const daemonError = daemonState.error;

  const checks: DoctorCheck[] = [
    {
      name: "runtime_bundle",
      ok: true,
      detail: bundle.source.bundled
        ? `Using packaged runtime bundle from ${bundle.source.runtimeRoot} materialized at ${bundle.runtimeRoot}`
        : `Using repo runtime bundle at ${bundle.runtimeRoot}`,
    },
    {
      name: "bun",
      ok: bunTool.found,
      detail: bunTool.found ? `${bunTool.path} (${bunTool.version ?? "unknown"})` : "bun not found on PATH",
    },
    {
      name: "mix",
      ok: mixTool.found,
      detail: mixTool.found ? `${mixTool.path} (${mixTool.version ?? "unknown"})` : "mix not found on PATH",
    },
    {
      name: "elixir",
      ok: elixirTool.found,
      detail: elixirTool.found ? `${elixirTool.path} (${elixirTool.version ?? "unknown"})` : "elixir not found on PATH",
    },
    {
      name: "kernel_deps",
      ok: depsReady,
      detail: depsReady ? "kernel deps directory is present" : "kernel deps are missing; run `vilano doctor --fix` or `mix deps.get`",
    },
    {
      name: "kernel_build",
      ok: true,
      detail: buildReady ? "kernel build artifacts are present" : "kernel has not been compiled yet; it can compile on first start",
    },
    {
      name: "daemon",
      ok: daemonError === null,
      detail:
        daemonError !== null
          ? daemonError
          : daemonStatus === null
          ? "Vilano kernel is not running"
          : `running runtime ${daemonStatus.runtimeVersion} protocol ${daemonStatus.protocolVersion} schema ${daemonStatus.schemaVersion}`,
    },
  ];

  return {
    ok: checks.every((check) => check.ok),
    cliVersion: getCliVersion(),
    protocolVersion: CLI_PROTOCOL_VERSION,
    runtimeHome: runtimePaths.homeDir,
    daemonStateFile: runtimePaths.daemonStateFile,
    runtimeBundle: {
      root: bundle.runtimeRoot,
      sourceRoot: bundle.source.runtimeRoot,
      kernelDir: bundle.kernelDir,
      workerDir: bundle.workerDir,
      bundled: bundle.source.bundled,
      materialized: bundle.materialized,
      bundleVersion: bundle.bundleVersion,
    },
    tools: {
      bun: bunTool,
      mix: mixTool,
      elixir: elixirTool,
    },
    kernel: {
      depsReady,
      buildReady,
      running: daemonStatus !== null,
      status: daemonStatus,
      error: daemonError,
    },
    appliedFixes,
    checks,
  };
}

async function applyDoctorFixes(kernelDir: string): Promise<string[]> {
  const fixes: string[] = [];

  await runCommand("mix", ["local.hex", "--force"], kernelDir);
  fixes.push("mix local.hex --force");

  await runCommand("mix", ["local.rebar", "--force"], kernelDir);
  fixes.push("mix local.rebar --force");

  await runCommand("mix", ["deps.get"], kernelDir);
  fixes.push("mix deps.get");

  await runCommand("mix", ["compile"], kernelDir);
  fixes.push("mix compile");

  return fixes;
}

async function getDaemonStatusReport(): Promise<{
  status: Awaited<ReturnType<typeof getRunningDaemonStatus>>;
  error: string | null;
}> {
  try {
    return {
      status: await getRunningDaemonStatus(),
      error: null,
    };
  } catch (error) {
    return {
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function inspectTool(command: string, args: string[]): Promise<ToolCheck> {
  const executable = Bun.which(command);
  if (!executable) {
    return {
      found: false,
      path: null,
      version: null,
    };
  }

  try {
    const result = await runCommand(command, args);
    return {
      found: true,
      path: executable,
      version: firstNonEmptyLine(`${result.stdout}\n${result.stderr}`),
    };
  } catch {
    return {
      found: true,
      path: executable,
      version: null,
    };
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
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

function firstNonEmptyLine(text: string): string | null {
  return (
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
