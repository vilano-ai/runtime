import type { DaemonStatusResponse } from "../types.ts";

export function renderDoctorReport(body: {
  ok: boolean;
  cliVersion: string;
  protocolVersion: number;
  runtimeHome: string;
  runtimeBundle: {
    root: string;
    sourceRoot: string;
    bundled: boolean;
    materialized: boolean;
    bundleVersion: string;
    kernelDir: string;
    workerDir: string;
  };
  tools: {
    bun: { found: boolean; path: string | null; version: string | null };
    node: { found: boolean; path: string | null; version: string | null };
    mix: { found: boolean; path: string | null; version: string | null };
    elixir: { found: boolean; path: string | null; version: string | null };
  };
  kernel: {
    depsReady: boolean;
    buildReady: boolean;
    running: boolean;
    status: DaemonStatusResponse | null;
    error?: string | null;
  };
  appliedFixes: string[];
  checks: Array<{ name: string; ok: boolean; required: boolean; detail: string }>;
}): string {
  const reportedChecks = body.checks.filter(
    (check) => !check.ok && (check.required || check.name === "runtime_portability")
  );

  return [
    `doctor: ${body.ok ? "ok" : "needs attention"}`,
    `cli_version: ${body.cliVersion}`,
    `protocol_version: ${body.protocolVersion}`,
    `runtime_bundle: ${body.runtimeBundle.bundled ? "packaged" : "repo"}`,
    `runtime_bundle_version: ${body.runtimeBundle.bundleVersion}`,
    `bun: ${renderDoctorTool(body.tools.bun)}`,
    `node: ${renderDoctorTool(body.tools.node)}`,
    `mix: ${renderDoctorTool(body.tools.mix)}`,
    `elixir: ${renderDoctorTool(body.tools.elixir)}`,
    body.kernel.error ? `kernel_error: ${body.kernel.error}` : null,
    body.kernel.running && body.kernel.status
      ? `kernel_status: running runtime=${body.kernel.status.runtimeVersion} protocol=${body.kernel.status.protocolVersion} schema=${body.kernel.status.schemaVersion}`
      : "kernel_status: not running",
    ...(body.appliedFixes.length > 0 ? [`applied_fixes: ${body.appliedFixes.join(", ")}`] : []),
    reportedChecks.length === 0 ? "checks: all required checks passed" : "checks:",
    ...reportedChecks.map((check) =>
      `  [${check.required ? "fail" : "warn"}] ${check.name}: ${check.detail}`
    ),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderDoctorTool(tool: {
  found: boolean;
  path: string | null;
  version: string | null;
}): string {
  if (!tool.found) {
    return "missing";
  }

  return tool.version ?? "found";
}
