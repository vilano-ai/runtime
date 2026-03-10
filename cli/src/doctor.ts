import fs from "node:fs/promises";
import { spawn } from "node:child_process";

import { getRunningDaemonStatus } from "./daemon-client.ts";
import type { RuntimeInstallManifest } from "./distribution-contract.ts";
import { readJsonFile } from "./json-file.ts";
import { getRuntimeCompatibilityIssues } from "./runtime-compatibility.ts";
import { getRuntimePaths } from "./runtime-home.ts";
import { prepareRuntimeBundleWithOptions } from "./runtime-materializer.ts";
import { CLI_PROTOCOL_VERSION, getCliVersion } from "./runtime-version.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
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
    node: ToolCheck;
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
  const bundle = await prepareRuntimeBundleWithOptions({ materialize: Boolean(options.fix) });
  const appliedFixes: string[] = [];
  const installManifest = await readJsonFile<RuntimeInstallManifest | null>(bundle.installManifestFile, null);
  const kernelReleaseReady = await fileExists(`${bundle.kernelDir}/bin/vilano_kernel`);
  const depsReady = bundle.source.bundled ? kernelReleaseReady : await fileExists(`${bundle.kernelDir}/deps`);
  const buildReady = bundle.source.bundled ? kernelReleaseReady : await fileExists(`${bundle.kernelDir}/_build`);

  if (options.fix) {
    if (bundle.source.bundled && (!depsReady || !buildReady)) {
      throw new Error(
        "Packaged Vilano Runtime is incomplete. Reinstall Vilano Runtime to restore the bundled kernel release."
      );
    }

    const needsKernelTooling = !bundle.source.bundled;
    if (needsKernelTooling) {
      const requiredTools = await Promise.all([
        inspectTool("mix", ["--version"]),
        inspectTool("elixir", ["--version"]),
      ]);

      if (!requiredTools[0].found || !requiredTools[1].found) {
        throw new Error("vilano doctor --fix requires both 'mix' and 'elixir' on PATH");
      }
    }

    appliedFixes.push(
      ...(await applyDoctorFixes(bundle.kernelDir, {
        bundled: bundle.source.bundled,
        depsReady,
        buildReady,
      }))
    );
  }

  const [bunTool, nodeTool, mixTool, elixirTool, daemonState] = await Promise.all([
    inspectTool("bun", ["--version"]),
    inspectTool("node", ["--version"]),
    inspectTool("mix", ["--version"]),
    inspectTool("elixir", ["--version"]),
    getDaemonStatusReport(),
  ]);

  const daemonStatus = daemonState.status;
  const daemonError = daemonState.error;
  const portabilityIssues =
    bundle.source.bundled && installManifest?.compatibility
      ? await getRuntimeCompatibilityIssues(installManifest.compatibility)
      : [];

  const checks: DoctorCheck[] = [
    {
      name: "runtime_bundle",
      ok: true,
      required: true,
      detail: bundle.source.bundled
        ? `Using packaged runtime bundle from ${bundle.source.runtimeRoot} materialized at ${bundle.runtimeRoot}`
        : `Using repo runtime bundle at ${bundle.runtimeRoot}`,
    },
    {
      name: "runtime_portability",
      ok: portabilityIssues.length === 0,
      required: bundle.source.bundled,
      detail:
        portabilityIssues.length === 0
          ? bundle.source.bundled
            ? "packaged runtime matches the current host"
            : "repo runtime portability is managed by the local toolchain"
          : portabilityIssues.join("; "),
    },
    {
      name: "bun",
      ok: bunTool.found,
      required: !bundle.source.bundled,
      detail: bundle.source.bundled
        ? bunTool.found
          ? `${bunTool.path} (${bunTool.version ?? "unknown"}) on PATH; packaged runtimes use the bundled bun binary`
          : "bun not found on PATH (not required for packaged runtimes; managed installs use the bundled bun binary)"
        : bunTool.found
          ? `${bunTool.path} (${bunTool.version ?? "unknown"})`
          : "bun not found on PATH",
    },
    {
      name: "node",
      ok: nodeTool.found,
      required: false,
      detail: nodeTool.found
        ? `${nodeTool.path} (${nodeTool.version ?? "unknown"})`
        : "node not found on PATH (optional for preview Node workers)",
    },
    {
      name: "mix",
      ok: mixTool.found,
      required: !bundle.source.bundled,
      detail: mixTool.found
        ? `${mixTool.path} (${mixTool.version ?? "unknown"})`
        : bundle.source.bundled
          ? "mix not found on PATH (not required for packaged runtimes)"
          : "mix not found on PATH",
    },
    {
      name: "elixir",
      ok: elixirTool.found,
      required: !bundle.source.bundled,
      detail: elixirTool.found
        ? `${elixirTool.path} (${elixirTool.version ?? "unknown"})`
        : bundle.source.bundled
          ? "elixir not found on PATH (not required for packaged runtimes)"
          : "elixir not found on PATH",
    },
    {
      name: "kernel_deps",
      ok: depsReady,
      required: true,
      detail: bundle.source.bundled
        ? depsReady
          ? "packaged kernel release is present"
          : "packaged kernel release is missing; reinstall Vilano Runtime"
        : depsReady
          ? "kernel deps directory is present"
          : "kernel deps are missing; run `vilano doctor --fix` or `mix deps.get`",
    },
    {
      name: "kernel_build",
      ok: true,
      required: true,
      detail: bundle.source.bundled
        ? buildReady
          ? "packaged kernel release is ready"
          : "packaged kernel release is missing; reinstall Vilano Runtime"
        : buildReady
          ? "kernel build artifacts are present"
          : "kernel has not been compiled yet; it can compile on first start",
    },
    {
      name: "daemon",
      ok: daemonError === null,
      required: true,
      detail:
        daemonError !== null
          ? daemonError
          : daemonStatus === null
          ? "Vilano Runtime kernel is not running"
          : `running runtime ${daemonStatus.runtimeVersion} protocol ${daemonStatus.protocolVersion} schema ${daemonStatus.schemaVersion}`,
    },
  ];

  return {
    ok: checks.every((check) => !check.required || check.ok),
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
      node: nodeTool,
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

async function applyDoctorFixes(
  kernelDir: string,
  options: {
    bundled: boolean;
    depsReady: boolean;
    buildReady: boolean;
  }
): Promise<string[]> {
  const fixes: string[] = [];

  if (options.bundled && options.depsReady && options.buildReady) {
    fixes.push("packaged runtime already contains a ready kernel release");
    return fixes;
  }

  await runCommand("mix", ["local.hex", "--force"], kernelDir);
  fixes.push("mix local.hex --force");

  await runCommand("mix", ["local.rebar", "--force"], kernelDir);
  fixes.push("mix local.rebar --force");

  if (!options.depsReady) {
    await runCommand("mix", ["deps.get"], kernelDir);
    fixes.push("mix deps.get");
  }

  if (!options.buildReady) {
    await runCommand("mix", ["compile"], kernelDir);
    fixes.push("mix compile");
  }

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
