import type {
  DaemonStatusResponse,
  DefinitionRecord,
  ProjectRecord,
} from "./types.ts";

export function writeOutput<T>(
  flags: Record<string, string | boolean>,
  body: T,
  renderHuman?: (body: T) => string
): void {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }

  if (renderHuman) {
    process.stdout.write(`${renderHuman(body)}\n`);
    return;
  }

  process.stdout.write(`${String(body)}\n`);
}

export function renderDaemonStatus(body: DaemonStatusResponse): string {
  return [
    "Vilano kernel is running",
    `runtime_version: ${body.runtimeVersion}`,
    `protocol_version: ${body.protocolVersion}`,
    `schema_version: ${body.schemaVersion}`,
    `pid: ${body.pid}`,
    `port: ${body.port}`,
    `started_at: ${body.startedAt}`,
    `home_dir: ${body.homeDir}`,
    `execution_home: ${body.executionHomeDir}`,
    `project_root: ${body.projectRoot}`,
    `runtime_db: ${body.runtimeDbPath}`,
    `managed_workers: ${body.managedWorkerCount}`,
    `managed_worker_runtime: ${body.managedWorkerRuntime}`,
    `lease_duration_seconds: ${body.leaseDurationSeconds}`,
    `applied_migrations: ${body.appliedMigrations.length}`,
    `projects: ${body.projectCount}`,
  ].join("\n");
}

export function renderVersionInfo(body: {
  cliVersion: string;
  protocolVersion: number;
  runtimeBundle: {
    root: string;
    sourceRoot: string;
    bundled: boolean;
    materialized: boolean;
    bundleVersion: string;
    installManifestFile: string;
    installManifest: {
      runtimeVersion: string;
      protocolVersion: number;
      schemaVersion: number;
      supportedWorkerRuntimes: string[];
      platform: {
        os: string;
        arch: string;
      };
    } | null;
  };
  kernel: DaemonStatusResponse | null;
  kernelError?: string | null;
}): string {
  return [
    `cli_version: ${body.cliVersion}`,
    `protocol_version: ${body.protocolVersion}`,
    `runtime_bundle: ${body.runtimeBundle.root}${body.runtimeBundle.bundled ? " (packaged)" : " (repo)"}`,
    body.runtimeBundle.bundled ? `runtime_bundle_source: ${body.runtimeBundle.sourceRoot}` : null,
    `runtime_bundle_version: ${body.runtimeBundle.bundleVersion}`,
    `runtime_install_manifest: ${body.runtimeBundle.installManifestFile}`,
    body.runtimeBundle.installManifest
      ? `runtime_install: runtime=${body.runtimeBundle.installManifest.runtimeVersion} protocol=${body.runtimeBundle.installManifest.protocolVersion} schema=${body.runtimeBundle.installManifest.schemaVersion} worker_runtimes=${body.runtimeBundle.installManifest.supportedWorkerRuntimes.join(",")} platform=${body.runtimeBundle.installManifest.platform.os}/${body.runtimeBundle.installManifest.platform.arch}`
      : null,
    body.kernelError ? `kernel_error: ${body.kernelError}` : null,
    body.kernel
      ? `kernel: running ${body.kernel.runtimeVersion} schema=${body.kernel.schemaVersion} port=${body.kernel.port}`
      : "kernel: not running",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderUpdateCheck(body: {
  mode: "check";
  source: string;
  channel: string;
  current: {
    version: string;
    bundled: boolean;
    installManifestFile: string;
  };
  latest: {
    version: string;
    channel: string;
    protocolVersion: number;
    schemaMin: number;
    schemaMax: number;
    supportedWorkerRuntimes: string[];
    releasedAt: string;
    notesUrl: string | null;
    artifact: {
      url: string;
      sha256: string;
      sizeBytes?: number;
    } | null;
  };
  platform: {
    key: string;
    supported: boolean;
  };
  updateAvailable: boolean;
}): string {
  return [
    `update_check: ${body.updateAvailable ? "update available" : "up to date"}`,
    `source: ${body.source}`,
    `channel: ${body.channel}`,
    `current_version: ${body.current.version}`,
    body.current.bundled ? `runtime_install_manifest: ${body.current.installManifestFile}` : null,
    `latest_version: ${body.latest.version}`,
    `latest_channel: ${body.latest.channel}`,
    `released_at: ${body.latest.releasedAt}`,
    `platform: ${body.platform.key}`,
    `platform_supported: ${body.platform.supported}`,
    `latest_protocol: ${body.latest.protocolVersion}`,
    `latest_schema: ${body.latest.schemaMin}-${body.latest.schemaMax}`,
    `latest_worker_runtimes: ${body.latest.supportedWorkerRuntimes.join(",")}`,
    body.latest.artifact ? `artifact_url: ${body.latest.artifact.url}` : null,
    body.latest.artifact ? `artifact_sha256: ${body.latest.artifact.sha256}` : null,
    body.latest.notesUrl ? `notes: ${body.latest.notesUrl}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

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
  return [
    `doctor: ${body.ok ? "ok" : "needs attention"}`,
    `cli_version: ${body.cliVersion}`,
    `protocol_version: ${body.protocolVersion}`,
    `runtime_home: ${body.runtimeHome}`,
    body.kernel.status ? `execution_home: ${body.kernel.status.executionHomeDir}` : null,
    `runtime_bundle: ${body.runtimeBundle.root}${body.runtimeBundle.bundled ? " (packaged)" : " (repo)"}`,
    body.runtimeBundle.bundled ? `runtime_bundle_source: ${body.runtimeBundle.sourceRoot}` : null,
    `runtime_bundle_materialized: ${body.runtimeBundle.materialized}`,
    `runtime_bundle_version: ${body.runtimeBundle.bundleVersion}`,
    `kernel_dir: ${body.runtimeBundle.kernelDir}`,
    `worker_dir: ${body.runtimeBundle.workerDir}`,
    `bun: ${renderDoctorTool(body.tools.bun)}`,
    `node: ${renderDoctorTool(body.tools.node)}`,
    `mix: ${renderDoctorTool(body.tools.mix)}`,
    `elixir: ${renderDoctorTool(body.tools.elixir)}`,
    `kernel_deps_ready: ${body.kernel.depsReady}`,
    `kernel_build_ready: ${body.kernel.buildReady}`,
    body.kernel.error ? `kernel_error: ${body.kernel.error}` : null,
    body.kernel.running && body.kernel.status
      ? `kernel_status: running runtime=${body.kernel.status.runtimeVersion} protocol=${body.kernel.status.protocolVersion} schema=${body.kernel.status.schemaVersion}`
      : "kernel_status: not running",
    ...(body.appliedFixes.length > 0 ? [`applied_fixes: ${body.appliedFixes.join(", ")}`] : []),
    "checks:",
    ...body.checks.map((check) =>
      `  [${check.ok ? "ok" : "fail"}${check.required ? "" : "/optional"}] ${check.name}: ${check.detail}`
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

  return `${tool.path ?? "unknown"}${tool.version ? ` (${tool.version})` : ""}`;
}

export function renderProject(project: ProjectRecord): string {
  return [
    `project: ${project.name}`,
    `path: ${project.path}`,
    `snapshot_path: ${project.snapshotPath ?? "none"}`,
    `last_synced_at: ${project.lastSyncedAt ?? "never"}`,
    `definitions_manifest_hash: ${project.definitionsManifestHash ?? "none"}`,
    `workflows: ${project.definitions.workflows.length}`,
    `services: ${project.definitions.services.length}`,
  ].join("\n");
}

export function renderProjectSummary(project: ProjectRecord): string {
  return `${project.name}\t${project.path}\tsnapshot=${project.snapshotPath ?? "none"}\tworkflows=${project.definitions.workflows.length}\tservices=${project.definitions.services.length}`;
}

export function renderDefinitionList(
  kind: "workflow" | "service",
  project: string | null,
  definitions: DefinitionRecord[]
): string {
  if (definitions.length === 0) {
    return project
      ? `No ${kind} definitions found in project ${project}.`
      : `No ${kind} definitions found.`;
  }

  const header = project ? `${kind} definitions in ${project}` : `${kind} definitions`;
  return [
    header,
    ...definitions.map(
      (definition) =>
        `${definition.name}\t${definition.file}\t${definition.sourceLanguage}/${definition.runtimeKind}`
    ),
  ].join("\n");
}

export function renderDefinitionInspect(project: string, definition: DefinitionRecord): string {
  return [
    `project: ${project}`,
    `kind: ${definition.kind}`,
    `name: ${definition.name}`,
    `export: ${definition.exportName}`,
    `file: ${definition.file}`,
    `source_language: ${definition.sourceLanguage}`,
    `runtime_kind: ${definition.runtimeKind}`,
  ].join("\n");
}
