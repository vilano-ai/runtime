import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ServiceDefinition } from "@vilano/runtime";
import {
  addProject,
  askService,
  cancelRun,
  ensureDaemonStarted,
  ensureServiceRun,
  getRunningDaemonStatus,
  inspectProject,
  inspectRun,
  inspectServiceEnvelope,
  inspectServiceRun,
  inspectWorkflowDefinition,
  listDefinitions,
  listProjects,
  listRuns,
  listServiceRuns,
  removeProject,
  replayRun,
  sendRunSignal,
  sendServiceMessage,
  sendServiceSignal,
  startWorkflowRun,
  stopServiceRun,
  stopDaemon,
  syncProject,
} from "./daemon-client.ts";
import { buildProjectManifest, findDefinition, resolveProjectForCwd } from "./registry.ts";
import type {
  DefinitionRecord,
  ProjectRecord,
  RunExecRecord,
  RunChildRecord,
  RunEnvelopeRecord,
  RunEventRecord,
  RunReplayEntry,
  RunRecord,
  RunRetrySeriesRecord,
  RunSignalRecord,
  RunStepRecord,
  RunTurnRecord,
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
    "  vilano run start|list|inspect|replay|cancel",
    "  vilano worker start",
    "  vilano service list|ensure|inspect|send|ask|signal|stop",
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

      const response = decorateRunInspect(await inspectRun(runId));
      writeOutput(flags, response, (body) =>
        renderRunInspect(
          body.run,
          body.events,
          body.steps,
          body.execs,
          body.waits,
          body.signals,
          body.children,
          body.envelopes,
          body.turns,
          body.retrySeries ?? []
        )
      );
      return 0;
    }
    case "replay": {
      const runId = args[1];
      if (!runId) {
        throw new CliError("Usage: vilano run replay <run-id>");
      }

      const response = decorateRunInspect(await replayRun(runId));
      writeOutput(flags, response, (body) =>
        renderRunReplay(body.run, body.timeline, body.retrySeries ?? [])
      );
      return 0;
    }
    case "cancel": {
      const runId = args[1];
      if (!runId) {
        throw new CliError("Usage: vilano run cancel <run-id>");
      }

      const response = await cancelRun(runId);
      writeOutput(flags, response, (body) =>
        [
          renderRun(body.run),
          `had_active_lease: ${body.hadActiveLease}`,
          `cancelled_waits: ${body.cancelledWaitCount}`,
          `cancelled_child_runs: ${body.cancelledChildRunCount}`,
          `cancelled_service_asks: ${body.cancelledServiceAskCount}`,
          `stopped_envelopes: ${body.stoppedEnvelopeCount}`,
          `had_in_flight_turn: ${body.hadInFlightTurn}`,
        ].join("\n")
      );
      return 0;
    }
    default:
      throw new CliError("Usage: vilano run start|list|inspect|replay|cancel");
  }
}

async function handleService(
  args: string[],
  flags: Record<string, string | boolean>
): Promise<number> {
  const command = args[0];

  switch (command) {
    case "list": {
      if (flags.instances) {
        const project = await resolveProjectScope(flags);
        const response = await listServiceRuns(project, Boolean(flags.active));
        writeOutput(flags, response, (body) => renderServiceRunList(body.project, body.activeOnly, body.runs));
        return 0;
      }

      const project = await resolveProjectScope(flags);
      if (project) {
        const existing = await inspectProject(project);
        await syncProject(await buildProjectManifest(existing.project.name, existing.project.path));
      }

      const response = await listDefinitions("service", project);
      writeOutput(flags, response, (body) => renderDefinitionList("service", body.project, body.definitions));
      return 0;
    }
    case "ensure": {
      const reference = args[1];
      if (!reference) {
        throw new CliError("Usage: vilano service ensure <service-ref> --key-json '{...}'");
      }

      const target = await resolveServiceTarget(reference, flags, { syncDefinition: true });
      const response = await ensureServiceRun(
        target.project.name,
        target.definition.name,
        target.serviceKey,
        target.keyInput
      );
      writeOutput(flags, response, (body) =>
        `${renderRun(body.run)}\nservice_key: ${target.serviceKey}`
      );
      return 0;
    }
    case "inspect": {
      const reference = args[1];
      if (!reference) {
        throw new CliError("Usage: vilano service inspect <service-ref> --key-json '{...}'");
      }

      const target = await resolveServiceTarget(reference, flags, { syncDefinition: true });
      const response = decorateRunInspect(
        await inspectServiceRun(
        target.project.name,
        target.definition.name,
        target.serviceKey
        )
      );
      writeOutput(flags, response, (body) =>
        renderRunInspect(
          body.run,
          body.events,
          body.steps,
          body.execs,
          body.waits,
          body.signals,
          body.children,
          body.envelopes,
          body.turns,
          body.retrySeries ?? []
        )
      );
      return 0;
    }
    case "send": {
      const reference = args[1];
      const messageName = args[2];
      if (!reference || !messageName) {
        throw new CliError("Usage: vilano service send <service-ref> <message-name> --key-json '{...}' [--input '{...}']");
      }

      const target = await resolveServiceTarget(reference, flags, { syncDefinition: true });
      const payload = parseJsonFlag(flags.input, "input", null);
      const response = await sendServiceMessage(
        target.project.name,
        target.definition.name,
        target.serviceKey,
        target.keyInput,
        messageName,
        payload
      );
      writeOutput(flags, response, (body) =>
        [
          `service: ${target.project.name}/${target.definition.name}`,
          `service_key: ${target.serviceKey}`,
          `run: ${body.run.id}`,
          `envelope: ${body.envelope.id}`,
          `queued: send ${messageName}`,
        ].join("\n")
      );
      return 0;
    }
    case "ask": {
      const reference = args[1];
      const messageName = args[2];
      if (!reference || !messageName) {
        throw new CliError("Usage: vilano service ask <service-ref> <ask-name> --key-json '{...}' [--input '{...}'] [--timeout 30s]");
      }

      const target = await resolveServiceTarget(reference, flags, { syncDefinition: true });
      const payload = parseJsonFlag(flags.input, "input", null);
      const initial = await askService(
        target.project.name,
        target.definition.name,
        target.serviceKey,
        target.keyInput,
        messageName,
        payload
      );
      const timeoutMs = parseDurationFlag(flags.timeout, 30_000, "timeout");
      const envelope = await waitForServiceEnvelope(initial.envelope.id, timeoutMs);

      if (envelope.status === "failed") {
        const message =
          envelope.error &&
          typeof envelope.error === "object" &&
          "message" in envelope.error &&
          typeof envelope.error.message === "string"
            ? envelope.error.message
            : `Service ask '${messageName}' failed`;
        throw new CliError(message);
      }

      const body = {
        ok: true as const,
        run: initial.run,
        envelope,
        reply: envelope.reply,
      };

      writeOutput(flags, body, (value) =>
        [
          `service: ${target.project.name}/${target.definition.name}`,
          `service_key: ${target.serviceKey}`,
          `run: ${value.run.id}`,
          `envelope: ${value.envelope.id}`,
          `reply: ${JSON.stringify(value.reply)}`,
        ].join("\n")
      );
      return 0;
    }
    case "stop": {
      const reference = args[1];
      if (!reference) {
        throw new CliError("Usage: vilano service stop <service-ref> --key-json '{...}'");
      }

      const target = await resolveServiceTarget(reference, flags, { syncDefinition: true });
      const response = await stopServiceRun(
        target.project.name,
        target.definition.name,
        target.serviceKey
      );
      writeOutput(flags, response, (body) =>
        [
          `service: ${target.project.name}/${target.definition.name}`,
          `service_key: ${target.serviceKey}`,
          `run: ${body.run.id}`,
          `status: ${body.run.status}`,
          `stopped_envelopes: ${body.stoppedEnvelopeCount}`,
          `cancelled_waits: ${body.cancelledWaitCount}`,
          `cancelled_child_runs: ${body.cancelledChildRunCount ?? 0}`,
          `cancelled_service_asks: ${body.cancelledServiceAskCount ?? 0}`,
          `had_in_flight_turn: ${body.hadInFlightTurn}`,
        ].join("\n")
      );
      return 0;
    }
    case "signal": {
      const reference = args[1];
      const signalName = args[2];
      if (!reference || !signalName) {
        throw new CliError("Usage: vilano service signal <service-ref> <signal-name> --key-json '{...}' [--input '{...}']");
      }

      const target = await resolveServiceTarget(reference, flags, { syncDefinition: true });
      const payload = parseJsonFlag(flags.input, "input", null);
      const response = await sendServiceSignal(
        target.project.name,
        target.definition.name,
        target.serviceKey,
        target.keyInput,
        signalName,
        payload
      );
      writeOutput(flags, response, (body) =>
        [
          `service: ${target.project.name}/${target.definition.name}`,
          `service_key: ${target.serviceKey}`,
          `run: ${body.run.id}`,
          `envelope: ${body.envelope.id}`,
          `queued: signal ${signalName}`,
        ].join("\n")
      );
      return 0;
    }
    default:
      throw new CliError("Usage: vilano service list|ensure|inspect|send|ask|signal|stop");
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

async function resolveServiceReference(
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

  return findDefinition(projects, "service", reference, process.cwd(), explicitProject);
}

async function resolveServiceTarget(
  reference: string,
  flags: Record<string, string | boolean>,
  options: { syncDefinition?: boolean } = {}
): Promise<{
  project: ProjectRecord;
  definition: DefinitionRecord;
  keyInput: unknown;
  serviceKey: string;
}> {
  const { project, definition } = await resolveServiceReference(reference, flags, options);
  const keyInput = parseRequiredJsonFlag(flags["key-json"] ?? flags.key, "key-json");
  const definitionValue = await loadServiceDefinition(project, definition);
  const serviceKey = definitionValue.key(keyInput);

  return {
    project,
    definition,
    keyInput,
    serviceKey,
  };
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

function parseRequiredJsonFlag(value: string | boolean | undefined, flagName: string): unknown {
  const parsed = parseJsonFlag(value, flagName, undefined);
  if (parsed === undefined) {
    throw new CliError(`Usage requires --${flagName} '{...}'`);
  }

  return parsed;
}

async function loadServiceDefinition(
  project: ProjectRecord,
  definition: DefinitionRecord
): Promise<ServiceDefinition<any, any, any, any, any>> {
  const absolutePath = path.resolve(project.path, definition.file);
  const moduleUrl = pathToFileURL(absolutePath).href;
  const moduleExports = (await import(moduleUrl)) as Record<string, unknown>;
  const value = moduleExports[definition.exportName];

  if (!value || typeof value !== "object" || (value as { kind?: string }).kind !== "service") {
    throw new CliError(
      `Export '${definition.exportName}' from ${definition.file} is not a service definition`
    );
  }

  return value as ServiceDefinition<any, any, any, any, any>;
}

function parseDurationFlag(
  value: string | boolean | undefined,
  fallbackMs: number,
  flagName: string
): number {
  if (value === undefined) {
    return fallbackMs;
  }

  if (typeof value !== "string") {
    throw new CliError(`Expected --${flagName} to be followed by a duration like 30s`);
  }

  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim());
  if (!match) {
    throw new CliError(`Failed to parse --${flagName}: expected a duration like 30s`);
  }

  const amount = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return amount;
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      throw new CliError(`Failed to parse --${flagName}: unsupported duration unit`);
  }
}

async function waitForServiceEnvelope(envelopeId: string, timeoutMs: number): Promise<RunEnvelopeRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      const response = await inspectServiceEnvelope(envelopeId);
      if (response.envelope.status === "completed" || response.envelope.status === "failed") {
        return response.envelope;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(150);
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new CliError(`Timed out waiting for service envelope ${envelopeId}`);
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
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
  const lines = [
    `run: ${run.id}`,
    `project: ${run.project}`,
    `kind: ${run.definitionKind}`,
    `definition: ${run.definitionName}`,
    `status: ${run.status}`,
    `created_at: ${run.createdAt}`,
    `updated_at: ${run.updatedAt}`,
    `input: ${JSON.stringify(run.input)}`,
  ];

  if (run.serviceKey) {
    lines.push(`service_key: ${run.serviceKey}`);
  }

  if (run.state !== undefined) {
    lines.push(`state: ${JSON.stringify(run.state)}`);
  }

  return lines.join("\n");
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

function renderServiceRunList(
  project: string | null,
  activeOnly: boolean,
  runs: RunRecord[]
): string {
  if (runs.length === 0) {
    if (project) {
      return activeOnly
        ? `No active service instances found in project ${project}.`
        : `No service instances found in project ${project}.`;
    }

    return activeOnly ? "No active service instances found." : "No service instances found.";
  }

  const header = project
    ? activeOnly
      ? `active service instances in ${project}`
      : `service instances in ${project}`
    : activeOnly
      ? "active service instances"
      : "service instances";

  return [
    header,
    ...runs.map(
      (run) =>
        `${run.id}\t${run.project}/${run.definitionName}\tservice_key=${run.serviceKey ?? "unknown"}\tstatus=${run.status}\tupdated_at=${run.updatedAt}`
    ),
  ].join("\n");
}

function renderRunInspect(
  run: RunRecord,
  events: RunEventRecord[],
  steps: RunStepRecord[],
  execs: RunExecRecord[],
  waits: RunWaitRecord[],
  signals: RunSignalRecord[],
  children: RunChildRecord[],
  envelopes: RunEnvelopeRecord[],
  turns: RunTurnRecord[],
  retrySeries: RunRetrySeriesRecord[]
): string {
  const eventLines =
    events.length === 0
      ? ["events: none"]
      : ["events:", ...events.map((event) => `  ${event.seq}. ${event.type}\t${event.createdAt}${renderEventSummary(event)}`)];
  const stepLines =
    steps.length === 0
      ? ["steps: none"]
      : [
          "steps:",
          ...steps.map((step) => {
            const parts = [
              `  ${step.name}`,
              `key=${step.key}`,
              `status=${step.status}`,
              `attempts=${step.attempts ?? 1}`,
            ];

            if (step.lastEventType) {
              parts.push(`last_event=${step.lastEventType}`);
            }

            if (step.timeoutMs !== null) {
              parts.push(`timeout_ms=${step.timeoutMs}`);
            }

            if (step.status === "failed") {
              const error = asRecord(step.error);
              if (error.timedOut === true) {
                parts.push("timed_out=true");
              }
            }

            if (step.retryDecision) {
              parts.push(`retry=${step.retryDecision}`);
            }

            if (step.retryFamily) {
              parts.push(`family=${step.retryFamily}`);
            }

            if (step.retryable === false) {
              parts.push("retryable=false");
            }

            if (step.willRetry === true) {
              parts.push("will_retry=true");
            }

            if (typeof step.nextAttempt === "number") {
              parts.push(`next_attempt=${step.nextAttempt}`);
            }

            return parts.join("\t");
          }),
        ];
  const execLines =
    execs.length === 0
      ? ["execs: none"]
      : [
          "execs:",
          ...execs.map((exec) => {
            const refs = [exec.stdoutRef, exec.stderrRef].filter(Boolean).join(",");
            const parts = [
              `  ${exec.name}`,
              `key=${exec.key}`,
              `status=${exec.status}`,
              `attempts=${exec.attempts ?? exec.attempt}`,
              `cmd=${[exec.cmd, ...exec.args].join(" ")}`,
            ];

            if (exec.lastEventType) {
              parts.push(`last_event=${exec.lastEventType}`);
            }

            if (exec.exitCode !== null) {
              parts.push(`exit_code=${exec.exitCode}`);
            }

            if (exec.signalCode) {
              parts.push(`signal=${exec.signalCode}`);
            }

            if (refs) {
              parts.push(`refs=${refs}`);
            }

            if (exec.retryDecision) {
              parts.push(`retry=${exec.retryDecision}`);
            }

            if (exec.retryFamily) {
              parts.push(`family=${exec.retryFamily}`);
            }

            if (exec.retryable === false) {
              parts.push("retryable=false");
            }

            if (exec.willRetry === true) {
              parts.push("will_retry=true");
            }

            if (typeof exec.nextAttempt === "number") {
              parts.push(`next_attempt=${exec.nextAttempt}`);
            }

            return parts.join("\t");
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
  const childLines =
    children.length === 0
      ? ["children: none"]
      : [
          "children:",
          ...children.map((child) =>
            `  ${child.definitionName}\tkey=${child.key}\tchild_run=${child.childRunId}\tstatus=${child.status}`
          ),
        ];
  const envelopeLines =
    envelopes.length === 0
      ? ["envelopes: none"]
      : [
          "envelopes:",
          ...envelopes.map((envelope) => {
            const parts = [
              `  ${envelope.kind}`,
              `name=${envelope.name}`,
              `status=${envelope.status}`,
            ];

            if (envelope.correlationId) {
              parts.push(`correlation=${envelope.correlationId}`);
            }

            if (envelope.senderRunId) {
              parts.push(`sender=${envelope.senderRunId}`);
            }

            return parts.join("\t");
          }),
        ];
  const turnLines =
    turns.length === 0
      ? ["turns: none"]
      : [
          "turns:",
          ...turns.map((turn) => {
            const parts = [
              `  ${turn.kind}`,
              `name=${turn.name}`,
              `envelope=${turn.envelopeId}`,
              `status=${turn.status}`,
              `phase=${turn.phase}`,
              `attempts=${turn.attempts}`,
            ];

            if (turn.waitKind && turn.waitKey) {
              parts.push(`waiting=${turn.waitKind}:${turn.waitKey}`);
            }

            if (turn.lastResumeReason) {
              parts.push(`resumed=${turn.lastResumeReason}`);
            }

            if (turn.correlationId) {
              parts.push(`correlation=${turn.correlationId}`);
            }

            if (turn.retryDecision) {
              parts.push(`retry=${turn.retryDecision}`);
            }

            if (turn.retryFamily) {
              parts.push(`family=${turn.retryFamily}`);
            }

            if (turn.retryable === false) {
              parts.push("retryable=false");
            }

            if (turn.willRetry === true) {
              parts.push("will_retry=true");
            }

            if (typeof turn.nextAttempt === "number") {
              parts.push(`next_attempt=${turn.nextAttempt}`);
            }

            return parts.join("\t");
          }),
        ];
  const retrySeriesLines = renderRetrySeries(retrySeries);

  return [
    renderRun(run),
    ...eventLines,
    ...turnLines,
    ...retrySeriesLines,
    ...stepLines,
    ...execLines,
    ...waitLines,
    ...signalLines,
    ...childLines,
    ...envelopeLines,
  ].join("\n");
}

function renderRunReplay(
  run: RunRecord,
  timeline: RunReplayEntry[],
  retrySeries: RunRetrySeriesRecord[]
): string {
  const timelineLines =
    timeline.length === 0
      ? ["timeline: none"]
      : [
          "timeline:",
          ...timeline.map((entry) =>
            `  ${entry.seq}. ${entry.createdAt}\t${entry.type}${entry.summary ? `\t${entry.summary}` : ""}`
          ),
        ];
  const retrySeriesLines = renderRetrySeries(retrySeries);

  return [
    renderRun(run),
    ...retrySeriesLines,
    ...timelineLines,
  ].join("\n");
}

function decorateRunInspect<T extends {
  events: RunEventRecord[];
  steps: RunStepRecord[];
  execs: RunExecRecord[];
  envelopes: RunEnvelopeRecord[];
}>(body: T): T & { turns: RunTurnRecord[]; retrySeries: RunRetrySeriesRecord[] } {
  return {
    ...body,
    steps: deriveStepViews(body.steps, body.events),
    execs: deriveExecViews(body.execs, body.events),
    turns: deriveServiceTurns(body.events, body.envelopes),
    retrySeries: deriveRetrySeries(body.events),
  };
}

function deriveStepViews(steps: RunStepRecord[], events: RunEventRecord[]): RunStepRecord[] {
  const attempts = new Map<string, number>();
  const lastEvent = new Map<string, { type: string; at: string }>();
  const lastFailure = new Map<string, ReturnType<typeof retryFieldsFromEventBody>>();

  for (const event of events) {
    const body = asRecord(event.body);
    const key = typeof body.key === "string" ? body.key : null;
    if (!key) {
      continue;
    }

    if (event.type === "StepStarted") {
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      lastEvent.set(key, { type: event.type, at: event.createdAt });
    }

    if (
      event.type === "StepCompleted" ||
      event.type === "StepCancelled" ||
      event.type === "StepFailed"
    ) {
      lastEvent.set(key, { type: event.type, at: event.createdAt });
    }

    if (event.type === "StepFailed") {
      lastFailure.set(key, retryFieldsFromEventBody(body));
    }
  }

  return steps.map((step) => ({
    ...step,
    attempts: attempts.get(step.key) ?? step.attempt ?? 1,
    lastEventType: lastEvent.get(step.key)?.type ?? null,
    lastEventAt: lastEvent.get(step.key)?.at ?? null,
    ...lastFailure.get(step.key),
  }));
}

function deriveExecViews(execs: RunExecRecord[], events: RunEventRecord[]): RunExecRecord[] {
  const attempts = new Map<string, number>();
  const lastEvent = new Map<string, { type: string; at: string }>();
  const lastFailure = new Map<string, ReturnType<typeof retryFieldsFromEventBody>>();

  for (const event of events) {
    const body = asRecord(event.body);
    const key = typeof body.key === "string" ? body.key : null;
    if (!key) {
      continue;
    }

    if (event.type === "ProcessStarted") {
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      lastEvent.set(key, { type: event.type, at: event.createdAt });
    }

    if (
      event.type === "ProcessCompleted" ||
      event.type === "ProcessFailed" ||
      event.type === "ProcessCancelled"
    ) {
      lastEvent.set(key, { type: event.type, at: event.createdAt });
    }

    if (event.type === "ProcessFailed") {
      lastFailure.set(key, retryFieldsFromEventBody(body));
    }
  }

  return execs.map((exec) => ({
    ...exec,
    attempts: attempts.get(exec.key) ?? exec.attempt,
    lastEventType: lastEvent.get(exec.key)?.type ?? null,
    lastEventAt: lastEvent.get(exec.key)?.at ?? null,
    ...lastFailure.get(exec.key),
  }));
}

function deriveServiceTurns(
  events: RunEventRecord[],
  envelopes: RunEnvelopeRecord[]
): RunTurnRecord[] {
  const turns = new Map<string, RunTurnRecord>();

  for (const envelope of envelopes) {
    turns.set(envelope.id, {
      envelopeId: envelope.id,
      kind: envelope.kind,
      name: envelope.name,
      status: envelope.status,
      phase: envelope.status,
      attempts: envelope.attempt ?? 0,
      correlationId: envelope.correlationId,
      senderRunId: envelope.senderRunId,
      waitKind: null,
      waitKey: null,
      waitName: null,
      lastResumeReason: null,
      lastEventType: null,
      lastEventAt: null,
      reply: envelope.reply,
      error: envelope.error,
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
    });
  }

  for (const event of events) {
    const body = asRecord(event.body);
    const envelopeId = typeof body.envelopeId === "string" ? body.envelopeId : null;
    if (!envelopeId) {
      continue;
    }

    const turn = turns.get(envelopeId);
    if (!turn) {
      continue;
    }

    turn.lastEventType = event.type;
    turn.lastEventAt = event.createdAt;

    if (event.type === "TurnStarted" || event.type === "TurnResumed") {
      turn.phase = "running";
    }

    if (event.type === "TurnWaiting") {
      turn.phase = "waiting";
      turn.waitKind = typeof body.waitKind === "string" ? body.waitKind : null;
      turn.waitKey = typeof body.key === "string" ? body.key : null;
      turn.waitName = typeof body.name === "string" ? body.name : null;
    }

    if (event.type === "TurnResumed") {
      turn.lastResumeReason = typeof body.reason === "string" ? body.reason : null;
      turn.waitKind = null;
      turn.waitKey = null;
      turn.waitName = null;
    }

    if (event.type === "TurnCompleted") {
      turn.phase = "completed";
      turn.waitKind = null;
      turn.waitKey = null;
      turn.waitName = null;
    }

    if (event.type === "TurnFailed") {
      turn.phase = "failed";
      Object.assign(turn, retryFieldsFromEventBody(body));
    }
  }

  return Array.from(turns.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function deriveRetrySeries(events: RunEventRecord[]): RunRetrySeriesRecord[] {
  const series = new Map<string, RunRetrySeriesRecord>();

  for (const event of events) {
    const body = asRecord(event.body);
    const source = retrySeriesSourceFromEvent(event.type, body);
    if (!source) {
      continue;
    }

    let record = series.get(source.seriesKey);
    if (!record) {
      record = {
        seriesKey: source.seriesKey,
        operationKind: source.operationKind,
        operationKey: source.operationKey,
        name: source.name,
        retryOn: source.retryOn,
        attempts: [],
        lastDecision: null,
        lastFamily: null,
      };
      series.set(source.seriesKey, record);
    } else {
      if (!record.name && source.name) {
        record.name = source.name;
      }

      if (record.retryOn.length === 0 && source.retryOn.length > 0) {
        record.retryOn = source.retryOn;
      }
    }

    let attemptRecord = record.attempts.find((entry) => entry.attempt === source.attempt);
    if (!attemptRecord) {
      attemptRecord = {
        attempt: source.attempt,
        failureEventType: null,
        failureAt: null,
        scheduledAt: null,
      };
      record.attempts.push(attemptRecord);
    }

    const retryFields = retryFieldsFromEventBody(body);
    const backoffFields = retryBackoffFieldsFromEventBody(body);

    if (event.type === "RetryScheduled") {
      attemptRecord.scheduledAt = event.createdAt;
    } else {
      attemptRecord.failureEventType = event.type;
      attemptRecord.failureAt = event.createdAt;
    }

    Object.assign(attemptRecord, retryFields, backoffFields);
    record.lastDecision = attemptRecord.retryDecision ?? record.lastDecision ?? null;
    record.lastFamily = attemptRecord.retryFamily ?? record.lastFamily ?? null;
  }

  return Array.from(series.values())
    .map((record) => ({
      ...record,
      attempts: record.attempts.sort((left, right) => left.attempt - right.attempt),
    }))
    .sort((left, right) => left.seriesKey.localeCompare(right.seriesKey));
}

function retrySeriesSourceFromEvent(
  eventType: string,
  body: Record<string, unknown>
):
  | {
      seriesKey: string;
      operationKind: string;
      operationKey: string;
      name: string;
      attempt: number;
      retryOn: string[];
    }
  | null {
  const retryOn = stringArrayFromUnknown(body.retryOn);

  switch (eventType) {
    case "StepFailed": {
      const operationKey = typeof body.key === "string" ? body.key : null;
      const attempt = typeof body.attempt === "number" ? body.attempt : null;
      if (!operationKey || attempt === null) {
        return null;
      }

      return {
        seriesKey: `step:${operationKey}`,
        operationKind: "step",
        operationKey,
        name: typeof body.name === "string" ? body.name : operationKey,
        attempt,
        retryOn,
      };
    }
    case "ProcessFailed": {
      const operationKey = typeof body.key === "string" ? body.key : null;
      const attempt = typeof body.attempt === "number" ? body.attempt : null;
      if (!operationKey || attempt === null) {
        return null;
      }

      return {
        seriesKey: `exec:${operationKey}`,
        operationKind: "exec",
        operationKey,
        name: typeof body.name === "string" ? body.name : operationKey,
        attempt,
        retryOn,
      };
    }
    case "TurnFailed": {
      const operationKey = typeof body.envelopeId === "string" ? body.envelopeId : null;
      const attempt = typeof body.attempt === "number" ? body.attempt : null;
      if (!operationKey || attempt === null) {
        return null;
      }

      return {
        seriesKey: `service_turn:${operationKey}`,
        operationKind: "service_turn",
        operationKey,
        name: typeof body.name === "string" ? body.name : operationKey,
        attempt,
        retryOn,
      };
    }
    case "RetryScheduled": {
      const operationKind = typeof body.kind === "string" ? body.kind : null;
      const operationKey = typeof body.operationKey === "string" ? body.operationKey : null;
      const attempt = typeof body.attempt === "number" ? body.attempt : null;
      if (!operationKind || !operationKey || attempt === null) {
        return null;
      }

      return {
        seriesKey: `${operationKind}:${operationKey}`,
        operationKind,
        operationKey,
        name: typeof body.name === "string" ? body.name : operationKey,
        attempt,
        retryOn,
      };
    }
    default:
      return null;
  }
}

function renderRetrySeries(retrySeries: RunRetrySeriesRecord[]): string[] {
  if (retrySeries.length === 0) {
    return ["retry_series: none"];
  }

  return [
    "retry_series:",
    ...retrySeries.flatMap((series) => {
      const headerParts = [
        `  ${series.operationKind}`,
        `name=${series.name}`,
        `key=${series.operationKey}`,
        `attempts=${series.attempts.length}`,
      ];

      if (series.retryOn.length > 0) {
        headerParts.push(`retry_on=${series.retryOn.join(",")}`);
      }

      if (series.lastDecision) {
        headerParts.push(`last_decision=${series.lastDecision}`);
      }

      const attemptLines = series.attempts.map((attempt) => {
        const parts = [`    attempt=${attempt.attempt}`];

        if (attempt.retryDecision) {
          parts.push(`decision=${attempt.retryDecision}`);
        }

        if (attempt.retryFamily) {
          parts.push(`family=${attempt.retryFamily}`);
        }

        if (attempt.failureEventType) {
          parts.push(`failure=${attempt.failureEventType}`);
        }

        if (attempt.backoffKind) {
          parts.push(`backoff=${attempt.backoffKind}:${attempt.backoffMs ?? 0}ms`);
        }

        if (typeof attempt.backoffBaseMs === "number") {
          parts.push(`base_ms=${attempt.backoffBaseMs}`);
        }

        if (typeof attempt.backoffCappedMs === "number") {
          parts.push(`capped_ms=${attempt.backoffCappedMs}`);
        }

        if (typeof attempt.backoffCapMs === "number") {
          parts.push(`cap_ms=${attempt.backoffCapMs}`);
        }

        if (attempt.backoffJitterKind) {
          parts.push(`jitter=${attempt.backoffJitterKind}`);
        }

        if (typeof attempt.backoffJitterRatio === "number") {
          parts.push(`jitter_ratio=${attempt.backoffJitterRatio}`);
        }

        if (typeof attempt.backoffJitterMs === "number") {
          parts.push(`jitter_ms=${attempt.backoffJitterMs}`);
        }

        if (typeof attempt.nextAttempt === "number") {
          parts.push(`next_attempt=${attempt.nextAttempt}`);
        }

        if (attempt.retryWakeAt) {
          parts.push(`wake_at=${attempt.retryWakeAt}`);
        }

        return parts.join("\t");
      });

      return [headerParts.join("\t"), ...attemptLines];
    }),
  ];
}

function renderEventSummary(event: RunEventRecord): string {
  const body = asRecord(event.body);

  switch (event.type) {
    case "TurnStarted":
      return formatSummary({
        envelope: body.envelopeId,
        kind: body.kind,
        name: body.name,
      });
    case "TurnWaiting":
      return formatSummary({
        envelope: body.envelopeId,
        wait: body.waitKind,
        key: body.key,
        name: body.turnName ?? body.name,
      });
    case "TurnResumed":
      return formatSummary({
        envelope: body.envelopeId,
        reason: body.reason,
        name: body.name,
      });
    case "TurnCompleted":
    case "TurnFailed":
      return formatSummary({
        envelope: body.envelopeId,
        kind: body.kind,
        name: body.name,
        family: body.retryFamily,
        retry: body.retryDecision,
        retryable: body.retryable,
        willRetry: body.willRetry,
        backoffKind: body.backoffKind,
        backoffMs: body.backoffMs,
        backoffBaseMs: body.backoffBaseMs,
        backoffCappedMs: body.backoffCappedMs,
        backoffJitterKind: body.backoffJitterKind,
        backoffJitterMs: body.backoffJitterMs,
      });
    case "RunCancelled":
      return formatSummary({
        reason: body.reason,
        waits: body.cancelledWaitCount,
        children: body.cancelledChildRunCount,
        asks: body.cancelledServiceAskCount,
      });
    case "ServiceStopped":
      return formatSummary({
        reason: body.reason,
        waits: body.cancelledWaitCount,
        children: body.cancelledChildRunCount,
        asks: body.cancelledServiceAskCount,
      });
    case "StepCancelled":
    case "StepFailed":
    case "ProcessFailed":
    case "ProcessCancelled":
      return formatSummary({
        key: body.key,
        name: body.name,
        family: body.retryFamily,
        retry: body.retryDecision,
        retryable: body.retryable,
        willRetry: body.willRetry,
        backoffKind: body.backoffKind,
        backoffMs: body.backoffMs,
        backoffBaseMs: body.backoffBaseMs,
        backoffCappedMs: body.backoffCappedMs,
        backoffJitterKind: body.backoffJitterKind,
        backoffJitterMs: body.backoffJitterMs,
      });
    case "WaitSatisfied":
      return formatSummary({
        kind: body.kind,
        key: body.key,
      });
    case "RunSuspended":
      return formatSummary({
        reason: body.reason,
        key: body.key,
      });
    default:
      return "";
  }
}

function formatSummary(fields: Record<string, unknown>): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`);

  return parts.length > 0 ? `\t${parts.join("\t")}` : "";
}

function retryFieldsFromEventBody(body: Record<string, unknown>): {
  retryDecision?: string | null;
  retryFamily?: string | null;
  retryable?: boolean | null;
  willRetry?: boolean | null;
  nextAttempt?: number | null;
  retryWakeAt?: string | null;
} {
  return {
    retryDecision: typeof body.retryDecision === "string" ? body.retryDecision : null,
    retryFamily: typeof body.retryFamily === "string" ? body.retryFamily : null,
    retryable: typeof body.retryable === "boolean" ? body.retryable : null,
    willRetry: typeof body.willRetry === "boolean" ? body.willRetry : null,
    nextAttempt: typeof body.nextAttempt === "number" ? body.nextAttempt : null,
    retryWakeAt: typeof body.wakeAt === "string" ? body.wakeAt : null,
  };
}

function retryBackoffFieldsFromEventBody(body: Record<string, unknown>): {
  backoffKind?: string | null;
  backoffMs?: number | null;
  backoffBaseMs?: number | null;
  backoffCappedMs?: number | null;
  backoffCapMs?: number | null;
  backoffJitterKind?: string | null;
  backoffJitterRatio?: number | null;
  backoffJitterMs?: number | null;
} {
  return {
    backoffKind: typeof body.backoffKind === "string" ? body.backoffKind : null,
    backoffMs: typeof body.backoffMs === "number" ? body.backoffMs : null,
    backoffBaseMs: typeof body.backoffBaseMs === "number" ? body.backoffBaseMs : null,
    backoffCappedMs: typeof body.backoffCappedMs === "number" ? body.backoffCappedMs : null,
    backoffCapMs: typeof body.backoffCapMs === "number" ? body.backoffCapMs : null,
    backoffJitterKind:
      typeof body.backoffJitterKind === "string" ? body.backoffJitterKind : null,
    backoffJitterRatio:
      typeof body.backoffJitterRatio === "number" ? body.backoffJitterRatio : null,
    backoffJitterMs: typeof body.backoffJitterMs === "number" ? body.backoffJitterMs : null,
  };
}

function stringArrayFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function errorMessage(value: unknown): string | undefined {
  const record = asRecord(value);
  return typeof record.message === "string" ? record.message : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
