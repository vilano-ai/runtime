import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  addProject,
  ensureDaemonStarted,
  getRunningDaemonStatus,
  inspectProject,
  inspectRun,
  inspectWorkflowDefinition,
  listDefinitions,
  listProjects,
  listRuns,
  removeProject,
  sendRunSignal,
  startWorkflowRun,
  stopDaemon,
  syncProject,
} from "./daemon-client.ts";
import { buildProjectManifest, findDefinition, resolveProjectForCwd } from "./registry.ts";
import type {
  DefinitionRecord,
  ProjectRecord,
  RunExecRecord,
  RunEventRecord,
  RunRecord,
  RunSignalRecord,
  RunStepRecord,
  RunWaitRecord,
} from "./types.ts";

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function renderHelp(): string {
  return [
    "Vilano CLI",
    "",
    "Implemented commands:",
    "  vilano daemon start|status|stop",
    "  vilano project add|list|inspect|sync|remove",
    "  vilano workflow list|inspect",
    "  vilano run start|list|inspect",
    "  vilano worker start",
    "  vilano service list",
    "  vilano signal send",
    "",
    "Everything important should eventually remain scriptable with --json.",
  ].join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.positionals.length === 0 || parsed.flags.help || parsed.flags.h) {
      writeOutput(parsed.flags, renderHelp());
      return 0;
    }

    const [group, ...rest] = parsed.positionals;

    switch (group) {
      case "daemon":
        return handleDaemon(rest, parsed.flags);
      case "project":
        return handleProject(rest, parsed.flags);
      case "workflow":
        return handleWorkflow(rest, parsed.flags);
      case "run":
        return handleRun(rest, parsed.flags);
      case "worker":
        return handleWorker(rest, parsed.flags);
      case "service":
        return handleService(rest, parsed.flags);
      case "signal":
        return handleSignal(rest, parsed.flags);
      default:
        throw new CliError(`Unknown command group: ${group}`);
    }
  } catch (error) {
    return handleError(error, argv);
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}

async function handleDaemon(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const command = args[0];

  switch (command) {
    case "start": {
      const portFlag = flags.port;
      const port = typeof portFlag === "string" ? Number.parseInt(portFlag, 10) : 4141;
      const status = await ensureDaemonStarted(Number.isFinite(port) ? port : 4141);
      writeOutput(flags, status, renderDaemonStatus);
      return 0;
    }
    case "status": {
      const status = await getRunningDaemonStatus();
      if (!status) {
        writeOutput(flags, { ok: true, running: false }, () => "Vilano kernel is not running");
        return 0;
      }

      writeOutput(flags, status, renderDaemonStatus);
      return 0;
    }
    case "stop": {
      const stopped = await stopDaemon();
      if (!stopped) {
        writeOutput(flags, { ok: true, running: false }, () => "Vilano kernel is not running");
        return 0;
      }

      writeOutput(
        flags,
        { ok: true, stopped: true, pid: stopped.pid, port: stopped.port },
        (body) => `Vilano kernel stopped\npid: ${body.pid}\nport: ${body.port}`
      );
      return 0;
    }
    default:
      throw new CliError("Usage: vilano daemon start|status|stop");
  }
}

async function handleProject(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const command = args[0];

  switch (command) {
    case "add": {
      const projectPath = args[1];
      const nameFlag = flags.name;

      if (!projectPath) {
        throw new CliError("Usage: vilano project add <path> --name <project>");
      }

      if (typeof nameFlag !== "string" || nameFlag.trim() === "") {
        throw new CliError("Usage: vilano project add <path> --name <project>");
      }

      const manifest = await buildProjectManifest(nameFlag, projectPath);
      const response = await addProject(manifest);
      writeOutput(flags, response, (body) => renderProject(body.project));
      return 0;
    }
    case "list": {
      const response = await listProjects();
      writeOutput(flags, response, (body) =>
        body.projects.length === 0
          ? "No Vilano projects registered."
          : body.projects.map(renderProjectSummary).join("\n")
      );
      return 0;
    }
    case "inspect": {
      const projectName = args[1];
      if (!projectName) {
        throw new CliError("Usage: vilano project inspect <project>");
      }

      const response = await inspectProject(projectName);
      writeOutput(flags, response, (body) => renderProject(body.project));
      return 0;
    }
    case "sync": {
      const projectName = args[1];
      if (!projectName) {
        throw new CliError("Usage: vilano project sync <project>");
      }

      const existing = await inspectProject(projectName);
      const manifest = await buildProjectManifest(existing.project.name, existing.project.path);
      const response = await syncProject(manifest);
      writeOutput(flags, response, (body) => renderProject(body.project));
      return 0;
    }
    case "remove": {
      const projectName = args[1];
      if (!projectName) {
        throw new CliError("Usage: vilano project remove <project>");
      }

      const response = await removeProject(projectName);
      writeOutput(flags, response, (body) => `Removed project ${body.project.name}`);
      return 0;
    }
    default:
      throw new CliError("Usage: vilano project add|list|inspect|sync|remove");
  }
}

async function handleWorkflow(
  args: string[],
  flags: Record<string, string | boolean>
): Promise<number> {
  const command = args[0];

  switch (command) {
    case "list": {
      const project = await resolveProjectScope(flags);
      if (project) {
        const existing = await inspectProject(project);
        await syncProject(await buildProjectManifest(existing.project.name, existing.project.path));
      }

      const response = await listDefinitions("workflow", project);
      writeOutput(flags, response, (body) => renderDefinitionList("workflow", body.project, body.definitions));
      return 0;
    }
    case "inspect": {
      const reference = args[1];
      if (!reference) {
        throw new CliError("Usage: vilano workflow inspect <workflow-ref>");
      }

      const { project, definition } = await resolveWorkflowReference(reference, flags, { syncDefinition: true });
      const response = await inspectWorkflowDefinition(project.name, definition.name);
      writeOutput(flags, response, (body) => renderDefinitionInspect(body.project, body.definition));
      return 0;
    }
    default:
      throw new CliError("Usage: vilano workflow list|inspect");
  }
}

async function handleRun(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const command = args[0];

  switch (command) {
    case "start": {
      const reference = args[1];
      if (!reference) {
        throw new CliError("Usage: vilano run start <workflow-ref> [--input '{...}']");
      }

      const { project, definition } = await resolveWorkflowReference(reference, flags, {
        syncDefinition: true,
      });
      const input = parseJsonFlag(flags.input, "input", {});
      const response = await startWorkflowRun(project.name, definition.name, input);
      writeOutput(flags, response, (body) => renderRun(body.run));
      return 0;
    }
    case "list": {
      const response = await listRuns(await resolveRunProjectScope(flags));
      writeOutput(flags, response, (body) => renderRunList(body.project, body.runs));
      return 0;
    }
    case "inspect": {
      const runId = args[1];
      if (!runId) {
        throw new CliError("Usage: vilano run inspect <run-id>");
      }

      const response = await inspectRun(runId);
      writeOutput(flags, response, (body) =>
        renderRunInspect(body.run, body.events, body.steps, body.execs, body.waits, body.signals)
      );
      return 0;
    }
    default:
      throw new CliError("Usage: vilano run start|list|inspect");
  }
}

async function handleService(
  args: string[],
  flags: Record<string, string | boolean>
): Promise<number> {
  const command = args[0];

  switch (command) {
    case "list": {
      const project = await resolveProjectScope(flags);
      if (project) {
        const existing = await inspectProject(project);
        await syncProject(await buildProjectManifest(existing.project.name, existing.project.path));
      }

      const response = await listDefinitions("service", project);
      writeOutput(flags, response, (body) => renderDefinitionList("service", body.project, body.definitions));
      return 0;
    }
    default:
      throw new CliError("Usage: vilano service list");
  }
}

async function handleWorker(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const command = args[0];

  switch (command) {
    case "start": {
      const serverUrl =
        typeof flags.server === "string"
          ? flags.server
          : typeof flags.url === "string"
            ? flags.url
            : "http://127.0.0.1:4141";
      const workerEntry = fileURLToPath(new URL("../../worker/bun/src/cli.ts", import.meta.url));
      const childArgs = [workerEntry, "--server", serverUrl];

      if (typeof flags["worker-id"] === "string") {
        childArgs.push("--worker-id", flags["worker-id"]);
      }

      if (flags.once) {
        childArgs.push("--once");
      }

      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, childArgs, {
          stdio: "inherit",
        });

        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      });

      return exitCode;
    }
    default:
      throw new CliError("Usage: vilano worker start [--once] [--worker-id <id>] [--server <url>]");
  }
}

async function handleSignal(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const command = args[0];

  switch (command) {
    case "send": {
      const runId = args[1];
      const signalName = args[2];
      if (!runId || !signalName) {
        throw new CliError("Usage: vilano signal send <run-id> <signal-name> [--input '{...}']");
      }

      const payload = parseJsonFlag(flags.input, "input", null);
      const response = await sendRunSignal(runId, signalName, payload);
      writeOutput(flags, response, (body) => `Sent signal ${body.signal.name} to ${body.signal.runId}`);
      return 0;
    }
    default:
      throw new CliError("Usage: vilano signal send <run-id> <signal-name> [--input '{...}']");
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    const eqIndex = raw.indexOf("=");
    if (eqIndex >= 0) {
      const key = raw.slice(0, eqIndex);
      const value = raw.slice(eqIndex + 1);
      flags[key] = value;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[raw] = next;
      index += 1;
      continue;
    }

    flags[raw] = true;
  }

  return { positionals, flags };
}

async function resolveProjectScope(
  flags: Record<string, string | boolean>
): Promise<string | undefined> {
  const projectFlag = flags.project;
  if (typeof projectFlag === "string" && projectFlag.trim() !== "") {
    return projectFlag;
  }

  const projects = (await listProjects()).projects;
  return resolveProjectForCwd(projects, process.cwd())?.name;
}

async function resolveRunProjectScope(
  flags: Record<string, string | boolean>
): Promise<string | undefined> {
  return resolveProjectScope(flags);
}

async function resolveWorkflowReference(
  reference: string,
  flags: Record<string, string | boolean>,
  options: { syncDefinition?: boolean } = {}
): Promise<{ project: ProjectRecord; definition: DefinitionRecord }> {
  const explicitProject = typeof flags.project === "string" ? flags.project : undefined;
  let projects = (await listProjects()).projects;
  const projectName = resolveReferenceProjectName(projects, reference, explicitProject);

  if (options.syncDefinition && projectName) {
    const project = projects.find((entry) => entry.name === projectName);
    if (!project) {
      throw new CliError(`Unknown project: ${projectName}`);
    }

    await syncProject(await buildProjectManifest(project.name, project.path));
    projects = (await listProjects()).projects;
  }

  return findDefinition(projects, "workflow", reference, process.cwd(), explicitProject);
}

function resolveReferenceProjectName(
  projects: ProjectRecord[],
  reference: string,
  explicitProject?: string
): string | undefined {
  if (reference.includes("/")) {
    return reference.split("/", 1)[0];
  }

  return explicitProject ?? resolveProjectForCwd(projects, process.cwd())?.name;
}

function parseJsonFlag<T>(
  value: string | boolean | undefined,
  flagName: string,
  fallback: T
): T | unknown {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string") {
    throw new CliError(`Expected --${flagName} to be followed by a JSON string`);
  }

  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new CliError(
      `Failed to parse --${flagName} as JSON: ${error instanceof Error ? error.message : "invalid JSON"}`
    );
  }
}

function writeOutput<T>(
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

function renderDaemonStatus(body: {
  pid: number;
  port: number;
  startedAt: string;
  runtimeDbPath: string;
  projectCount: number;
}): string {
  return [
    "Vilano kernel is running",
    `pid: ${body.pid}`,
    `port: ${body.port}`,
    `started_at: ${body.startedAt}`,
    `runtime_db: ${body.runtimeDbPath}`,
    `projects: ${body.projectCount}`,
  ].join("\n");
}

function renderProject(project: ProjectRecord): string {
  return [
    `project: ${project.name}`,
    `path: ${project.path}`,
    `last_synced_at: ${project.lastSyncedAt ?? "never"}`,
    `definitions_manifest_hash: ${project.definitionsManifestHash ?? "none"}`,
    `workflows: ${project.definitions.workflows.length}`,
    `services: ${project.definitions.services.length}`,
  ].join("\n");
}

function renderProjectSummary(project: ProjectRecord): string {
  return `${project.name}\t${project.path}\tworkflows=${project.definitions.workflows.length}\tservices=${project.definitions.services.length}`;
}

function renderDefinitionList(
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
  return [header, ...definitions.map((definition) => `${definition.name}\t${definition.file}`)].join("\n");
}

function renderDefinitionInspect(project: string, definition: DefinitionRecord): string {
  return [
    `project: ${project}`,
    `kind: ${definition.kind}`,
    `name: ${definition.name}`,
    `export: ${definition.exportName}`,
    `file: ${definition.file}`,
  ].join("\n");
}

function renderRun(run: RunRecord): string {
  return [
    `run: ${run.id}`,
    `project: ${run.project}`,
    `kind: ${run.definitionKind}`,
    `definition: ${run.definitionName}`,
    `status: ${run.status}`,
    `created_at: ${run.createdAt}`,
    `updated_at: ${run.updatedAt}`,
    `input: ${JSON.stringify(run.input)}`,
  ].join("\n");
}

function renderRunList(project: string | null, runs: RunRecord[]): string {
  if (runs.length === 0) {
    return project ? `No runs found in project ${project}.` : "No runs found.";
  }

  const header = project ? `runs in ${project}` : "runs";
  return [
    header,
    ...runs.map(
      (run) =>
        `${run.id}\t${run.project}/${run.definitionName}\tstatus=${run.status}\tcreated_at=${run.createdAt}`
    ),
  ].join("\n");
}

function renderRunInspect(
  run: RunRecord,
  events: RunEventRecord[],
  steps: RunStepRecord[],
  execs: RunExecRecord[],
  waits: RunWaitRecord[],
  signals: RunSignalRecord[]
): string {
  const eventLines =
    events.length === 0
      ? ["events: none"]
      : ["events:", ...events.map((event) => `  ${event.seq}. ${event.type}\t${event.createdAt}`)];
  const stepLines =
    steps.length === 0
      ? ["steps: none"]
      : ["steps:", ...steps.map((step) => `  ${step.name}\tkey=${step.key}\tstatus=${step.status}`)];
  const execLines =
    execs.length === 0
      ? ["execs: none"]
      : [
          "execs:",
          ...execs.map((exec) => {
            const refs = [exec.stdoutRef, exec.stderrRef].filter(Boolean).join(",");
            return `  ${exec.name}\tkey=${exec.key}\tstatus=${exec.status}\tattempt=${exec.attempt}\tcmd=${[exec.cmd, ...exec.args].join(" ")}${refs ? `\trefs=${refs}` : ""}`;
          }),
        ];
  const waitLines =
    waits.length === 0
      ? ["waits: none"]
      : [
          "waits:",
          ...waits.map((wait) =>
            `  ${wait.kind}\tkey=${wait.key}\tstatus=${wait.status}${wait.wakeAt ? `\twake_at=${wait.wakeAt}` : ""}${wait.name !== wait.kind ? `\tname=${wait.name}` : ""}`
          ),
        ];
  const signalLines =
    signals.length === 0
      ? ["signals: none"]
      : [
          "signals:",
          ...signals.map((signal) =>
            `  ${signal.name}\tcreated_at=${signal.createdAt}${signal.consumedAt ? `\tconsumed_at=${signal.consumedAt}` : ""}`
          ),
        ];

  return [
    renderRun(run),
    ...eventLines,
    ...stepLines,
    ...execLines,
    ...waitLines,
    ...signalLines,
  ].join("\n");
}

async function handleError(error: unknown, argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const message = error instanceof Error ? error.message : "Unknown error";

  if (parsed.flags.json) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { code: "cli_error", message } }, null, 2)}\n`
    );
  } else {
    process.stderr.write(`${message}\n`);
  }

  return 1;
}
