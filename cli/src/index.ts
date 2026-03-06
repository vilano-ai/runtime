import {
  addProject,
  ensureDaemonStarted,
  getRunningDaemonStatus,
  inspectProject,
  inspectWorkflowDefinition,
  listDefinitions,
  listProjects,
  removeProject,
  stopDaemon,
  syncProject,
} from "./daemon-client";
import { startDaemonServer } from "./daemon-server";
import { findDefinition, loadRegistry, resolveProjectForCwd } from "./registry";
import type { DefinitionRecord, ProjectRecord } from "./types";

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
    "  vilano service list",
    "",
    "Everything important should eventually remain scriptable with --json.",
  ].join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    if (argv[0] === "__daemon-serve") {
      const parsed = parseArgs(argv.slice(1));
      const portFlag = parsed.flags.port;
      const port = typeof portFlag === "string" ? Number.parseInt(portFlag, 10) : 4141;
      await startDaemonServer(Number.isFinite(port) ? port : 4141);
      return 0;
    }

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
      case "service":
        return handleService(rest, parsed.flags);
      default:
        throw new CliError(`Unknown command group: ${group}`);
    }
  } catch (error) {
    return handleError(error, argv);
  }
}

if (require.main === module) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    }
  );
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
        writeOutput(flags, { ok: true, running: false }, () => "Vilano daemon is not running");
        return 0;
      }

      writeOutput(flags, status, renderDaemonStatus);
      return 0;
    }
    case "stop": {
      const stopped = await stopDaemon();
      if (!stopped) {
        writeOutput(flags, { ok: true, running: false }, () => "Vilano daemon is not running");
        return 0;
      }

      writeOutput(
        flags,
        { ok: true, stopped: true, pid: stopped.pid, port: stopped.port },
        (body) => `Vilano daemon stopped\npid: ${body.pid}\nport: ${body.port}`
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

      const response = await addProject(nameFlag, projectPath);
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

      const response = await syncProject(projectName);
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
      const response = await listDefinitions("workflow", await resolveProjectScope(flags));
      writeOutput(flags, response, (body) => renderDefinitionList("workflow", body.project, body.definitions));
      return 0;
    }
    case "inspect": {
      const reference = args[1];
      if (!reference) {
        throw new CliError("Usage: vilano workflow inspect <workflow-ref>");
      }

      const { project, definition } = await resolveWorkflowReference(reference, flags);
      const response = await inspectWorkflowDefinition(project.name, definition.name);
      writeOutput(flags, response, (body) => renderDefinitionInspect(body.project, body.definition));
      return 0;
    }
    default:
      throw new CliError("Usage: vilano workflow list|inspect");
  }
}

async function handleService(
  args: string[],
  flags: Record<string, string | boolean>
): Promise<number> {
  const command = args[0];

  switch (command) {
    case "list": {
      const response = await listDefinitions("service", await resolveProjectScope(flags));
      writeOutput(flags, response, (body) => renderDefinitionList("service", body.project, body.definitions));
      return 0;
    }
    default:
      throw new CliError("Usage: vilano service list");
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

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

  const registry = await loadRegistry();
  return resolveProjectForCwd(registry, process.cwd())?.name;
}

async function resolveWorkflowReference(
  reference: string,
  flags: Record<string, string | boolean>
): Promise<{ project: ProjectRecord; definition: DefinitionRecord }> {
  const explicitProject = typeof flags.project === "string" ? flags.project : undefined;
  const registry = await loadRegistry();

  return findDefinition(registry, "workflow", reference, process.cwd(), explicitProject);
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
  registryPath: string;
  projectCount: number;
}): string {
  return [
    "Vilano daemon is running",
    `pid: ${body.pid}`,
    `port: ${body.port}`,
    `started_at: ${body.startedAt}`,
    `registry: ${body.registryPath}`,
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
