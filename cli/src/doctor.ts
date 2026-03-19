import { getRunningDaemonStatus } from "./daemon-client.ts";
import { applyDoctorFixes, getDaemonStatusReport, inspectTool, type ToolCheck } from "./doctor/support.ts";
import type { RuntimeInstallManifest } from "./distribution-contract.ts";
import { fileExists } from "./fs-utils.ts";
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
        : "node not found on PATH (optional)",
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
