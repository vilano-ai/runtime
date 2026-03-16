import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  askService,
  cancelRun,
  ensureServiceRun,
  inspectRun,
  inspectServiceEnvelope,
  inspectServiceRun,
  inspectWorkflowDefinition,
  listDefinitions,
  listProjects,
  listRuns,
  listServiceRuns,
  replayRun,
  sendRunSignal,
  sendServiceMessage,
  sendServiceSignal,
  startWorkflowRun,
  stopServiceRun,
} from "./daemon-client.ts";
import { CliError } from "./cli-error.ts";
import { handleInitCommand, handleProjectCommand } from "./commands/project.ts";
import {
  handleDaemonCommand,
  handleDoctorCommand,
  handleRollbackCommand,
  handleUpdateCommand,
  handleVersionCommand,
  handleWorkerCommand,
} from "./commands/system.ts";
import {
  renderDefinitionInspect,
  renderDefinitionList,
  writeOutput,
} from "./output.ts";
import { findDefinition, resolveProjectForCwd } from "./registry.ts";
import {
  decorateRunInspect,
  renderRun,
  renderRunInspect,
  renderRunList,
  renderRunReplay,
  renderServiceRunList,
} from "./run-views.ts";
import { getRuntimePaths } from "./runtime-home.ts";
import type {
  DefinitionRecord,
  DaemonState,
  ProjectRecord,
  RunChildRecord,
  RunEnvelopeRecord,
  RunRecord,
} from "./types.ts";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

interface ResolutionOptions {
  autoStart?: boolean;
}

function renderHelp(positionals: string[] = []): string {
  const [group, command] = positionals;

  switch (group) {
    case undefined:
      return renderTopLevelHelp();
    case "version":
      return ["Usage: vilano version [--json]", "", "Show CLI/runtime version info and the running kernel, if any."].join("\n");
    case "update":
      return ["Usage: vilano update [--check] [--release-manifest <path>] [--json]", "", "Check for or apply a managed runtime update."].join("\n");
    case "rollback":
      return ["Usage: vilano rollback [--json]", "", "Switch the managed install back to the previous runtime version."].join("\n");
    case "doctor":
      return ["Usage: vilano doctor [--fix] [--json]", "", "Inspect the local runtime environment. Use --fix to prepare missing local state."].join("\n");
    case "init":
      return [
        "Usage: vilano init [path] [--starter] [--force] [--json]",
        "",
        "Create an explicit manifest for an existing project, or scaffold the fastest runnable starter path with --starter.",
        "",
        "Examples:",
        "  vilano init .",
        "  vilano init ./my-agent --starter",
      ].join("\n");
    case "daemon":
      return renderDaemonHelp(command);
    case "project":
      return renderProjectHelp(command);
    case "workflow":
      return renderWorkflowHelp(command);
    case "run":
      return renderRunHelp(command);
    case "worker":
      return renderWorkerHelp(command);
    case "service":
      return renderServiceHelp(command);
    case "signal":
      return renderSignalHelp(command);
    default:
      throw new CliError(`Unknown command group: ${group}`);
  }
}

function renderTopLevelHelp(): string {
  return [
    "Vilano Runtime CLI",
    "",
    "Commands:",
    "  vilano version",
    "  vilano update [--check]",
    "  vilano rollback",
    "  vilano doctor [--fix]",
    "  vilano init [path] [--starter] [--force]",
    "  vilano daemon start|status|stop",
    "  vilano project add|list|inspect|sync|remove",
    "  vilano workflow list|inspect",
    "  vilano run start|list|inspect|replay|cancel",
    "  vilano worker start",
    "  vilano service list|ensure|inspect|send|ask|signal|stop",
    "  vilano signal send",
    "",
    "Use `vilano help <group> [command]` or `vilano <group> [command] --help` for details.",
  ].join("\n");
}

function renderDaemonHelp(command?: string): string {
  switch (command) {
    case "start":
      return ["Usage: vilano daemon start [--port <port>] [--json]", "", "Start the local Vilano kernel if it is not already running."].join("\n");
    case "status":
      return ["Usage: vilano daemon status [--json]", "", "Show the running kernel status, if any."].join("\n");
    case "stop":
      return ["Usage: vilano daemon stop [--json]", "", "Stop the local Vilano kernel."].join("\n");
    default:
      return ["Usage: vilano daemon <start|status|stop> [--json]", "", "Manage the local Vilano kernel process."].join("\n");
  }
}

function renderProjectHelp(command?: string): string {
  switch (command) {
    case "add":
      return [
        "Usage: vilano project add <path> --name <project> [--json]",
        "",
        "Register a local project with the runtime. This validates the manifest, snapshots the project, and imports the declared definitions from that snapshot.",
        "",
        "Treat project registration as a trusted local-code step.",
        "",
        "Examples:",
        "  vilano project add . --name demo",
        "  vilano project add ./examples/bootstrap-demo --name demo",
      ].join("\n");
    case "list":
      return ["Usage: vilano project list [--json]", "", "List registered local projects."].join("\n");
    case "inspect":
      return ["Usage: vilano project inspect <project> [--json]", "", "Show the registered manifest and snapshot details for a project."].join("\n");
    case "sync":
      return [
        "Usage: vilano project sync <project> [--json]",
        "",
        "Refresh a registered project from its source path. This re-validates the manifest, snapshots the project, and imports the declared definitions from that snapshot.",
        "",
        "Treat project sync as a trusted local-code step.",
      ].join("\n");
    case "remove":
      return ["Usage: vilano project remove <project> [--json]", "", "Remove a project registration."].join("\n");
    default:
      return ["Usage: vilano project <add|list|inspect|sync|remove> [--json]", "", "Manage the local project registry."].join("\n");
  }
}

function renderWorkflowHelp(command?: string): string {
  switch (command) {
    case "list":
      return [
        "Usage: vilano workflow list [--project <project>] [--json]",
        "",
        "List registered workflow definitions.",
      ].join("\n");
    case "inspect":
      return [
        "Usage: vilano workflow inspect <workflow-ref> [--project <project>] [--json]",
        "",
        "Inspect a registered workflow definition.",
        "",
        "workflow-ref can be `project/name` or just `name` inside a registered project directory.",
      ].join("\n");
    default:
      return ["Usage: vilano workflow <list|inspect> [--json]", "", "Inspect registered workflow definitions."].join("\n");
  }
}

function renderRunHelp(command?: string): string {
  switch (command) {
    case "start":
      return [
        "Usage: vilano run start <workflow-ref> [--input '{...}'] [--project <project>] [--json]",
        "",
        "Start a workflow run. If the runtime is not running, this command will start it.",
        "",
        "Example:",
        "  vilano run start demo/reviewCoordinator --input '{\"repoId\":\"repo_123\",\"note\":\"Ship 0.1\"}'",
      ].join("\n");
    case "list":
      return ["Usage: vilano run list [--project <project>] [--json]", "", "List workflow and service runs for the selected project scope."].join("\n");
    case "inspect":
      return ["Usage: vilano run inspect <run-id> [--json]", "", "Show the current durable state for a run."].join("\n");
    case "replay":
      return ["Usage: vilano run replay <run-id> [--json]", "", "Render the durable event timeline for a run."].join("\n");
    case "cancel":
      return ["Usage: vilano run cancel <run-id> [--json]", "", "Cancel a running workflow or service run."].join("\n");
    default:
      return ["Usage: vilano run <start|list|inspect|replay|cancel> [--json]", "", "Operate on workflow and service runs."].join("\n");
  }
}

function renderWorkerHelp(command?: string): string {
  switch (command) {
    case "start":
      return [
        "Usage: vilano worker start [--runtime <bun|node>] [--once] [--worker-id <id>] [--server <url>] [--json]",
        "",
        "Start an external worker process and connect it to the local kernel.",
      ].join("\n");
    default:
      return ["Usage: vilano worker start [--runtime <bun|node>] [--once] [--worker-id <id>] [--server <url>] [--json]", "", "Start an external worker."].join("\n");
  }
}

function renderServiceHelp(command?: string): string {
  switch (command) {
    case "list":
      return [
        "Usage: vilano service list [--project <project>] [--instances] [--active] [--json]",
        "",
        "List registered services or service instances with --instances.",
      ].join("\n");
    case "ensure":
      return [
        "Usage: vilano service ensure <service-ref> --service-key <key> [--key-json '{...}'] [--project <project>] [--json]",
        "",
        "Ensure a keyed service instance exists. If the runtime is not running, this command will start it.",
      ].join("\n");
    case "inspect":
      return [
        "Usage: vilano service inspect <service-ref> --service-key <key> [--key-json '{...}'] [--project <project>] [--json]",
        "",
        "Inspect a keyed service run.",
      ].join("\n");
    case "send":
      return [
        "Usage: vilano service send <service-ref> <message-name> --service-key <key> [--input '{...}'] [--key-json '{...}'] [--project <project>] [--json]",
        "",
        "Send an asynchronous message to a keyed service instance.",
      ].join("\n");
    case "ask":
      return [
        "Usage: vilano service ask <service-ref> <ask-name> --service-key <key> [--input '{...}'] [--key-json '{...}'] [--wait-timeout 30s] [--project <project>] [--json]",
        "",
        "Send an ask to a keyed service instance and wait for the reply.",
      ].join("\n");
    case "signal":
      return [
        "Usage: vilano service signal <service-ref> <signal-name> --service-key <key> [--input '{...}'] [--key-json '{...}'] [--project <project>] [--json]",
        "",
        "Deliver a signal to a keyed service instance.",
      ].join("\n");
    case "stop":
      return [
        "Usage: vilano service stop <service-ref> --service-key <key> [--project <project>] [--json]",
        "",
        "Stop a keyed service instance.",
      ].join("\n");
    default:
      return ["Usage: vilano service <list|ensure|inspect|send|ask|signal|stop> [--json]", "", "Operate on durable keyed services."].join("\n");
  }
}

function renderSignalHelp(command?: string): string {
  switch (command) {
    case "send":
      return ["Usage: vilano signal send <run-id> <signal-name> [--input '{...}'] [--json]", "", "Send a signal directly to a run."].join("\n");
    default:
      return ["Usage: vilano signal send <run-id> <signal-name> [--input '{...}'] [--json]", "", "Deliver run signals."].join("\n");
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.positionals[0] === "help") {
      writeOutput(parsed.flags, renderHelp(parsed.positionals.slice(1)));
      return 0;
    }

    if (parsed.positionals.length === 0 || parsed.flags.help || parsed.flags.h) {
      writeOutput(parsed.flags, renderHelp(parsed.positionals));
      return 0;
    }

    const [group, ...rest] = parsed.positionals;

    switch (group) {
      case "version":
        return handleVersionCommand(parsed.flags);
      case "update":
        return handleUpdateCommand(parsed.flags);
      case "rollback":
        return handleRollbackCommand(parsed.flags);
      case "doctor":
        return handleDoctorCommand(parsed.flags);
      case "init":
        return handleInitCommand(rest, parsed.flags);
      case "daemon":
        return handleDaemonCommand(rest, parsed.flags);
      case "project":
        return handleProjectCommand(rest, parsed.flags);
      case "workflow":
        return handleWorkflow(rest, parsed.flags);
      case "run":
        return handleRun(rest, parsed.flags);
      case "worker":
        return handleWorkerCommand(rest, parsed.flags);
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

async function handleWorkflow(
  args: string[],
  flags: Record<string, string | boolean>
): Promise<number> {
  const command = args[0];

  switch (command) {
    case "list": {
      const project = await resolveProjectScope(flags);
      const response = await listDefinitions("workflow", project);
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

async function handleRun(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const command = args[0];

  switch (command) {
    case "start": {
      const reference = args[1];
      if (!reference) {
        throw new CliError("Usage: vilano run start <workflow-ref> [--input '{...}']");
      }

      const { project, definition } = await resolveWorkflowReference(reference, flags, { autoStart: true });
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
      const response = await listDefinitions("service", project);
      writeOutput(flags, response, (body) => renderDefinitionList("service", body.project, body.definitions));
      return 0;
    }
    case "ensure": {
      const reference = args[1];
      if (!reference) {
        throw new CliError("Usage: vilano service ensure <service-ref> --service-key <key> [--key-json '{...}']");
      }

      const target = await resolveServiceTarget(reference, flags, { autoStart: true });
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
        throw new CliError("Usage: vilano service inspect <service-ref> --service-key <key>");
      }

      const target = await resolveServiceTarget(reference, flags, { autoStart: true });
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
        throw new CliError("Usage: vilano service send <service-ref> <message-name> --service-key <key> [--input '{...}'] [--key-json '{...}']");
      }

      const target = await resolveServiceTarget(reference, flags, { autoStart: true });
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
        throw new CliError("Usage: vilano service ask <service-ref> <ask-name> --service-key <key> [--input '{...}'] [--key-json '{...}'] [--wait-timeout 30s]");
      }

      if (flags.timeout !== undefined) {
        throw new CliError("External service asks use --wait-timeout for CLI polling. Durable ask timeouts are only supported from workflow/service code today.");
      }

      const target = await resolveServiceTarget(reference, flags, { autoStart: true });
      const payload = parseJsonFlag(flags.input, "input", null);
      const initial = await askService(
        target.project.name,
        target.definition.name,
        target.serviceKey,
        target.keyInput,
        messageName,
        payload
      );
      const timeoutMs = parseDurationFlag(flags["wait-timeout"], 30_000, "wait-timeout");
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
        throw new CliError("Usage: vilano service stop <service-ref> --service-key <key>");
      }

      const target = await resolveServiceTarget(reference, flags, { autoStart: true });
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
        throw new CliError("Usage: vilano service signal <service-ref> <signal-name> --service-key <key> [--input '{...}'] [--key-json '{...}']");
      }

      const target = await resolveServiceTarget(reference, flags, { autoStart: true });
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

    if (token === "-h") {
      flags.h = true;
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
  flags: Record<string, string | boolean>,
  options: ResolutionOptions = {}
): Promise<string | undefined> {
  const projectFlag = flags.project;
  if (typeof projectFlag === "string" && projectFlag.trim() !== "") {
    return projectFlag;
  }

  const projects = (await listProjects({ autoStart: options.autoStart })).projects;
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
  options: ResolutionOptions = {}
): Promise<{ project: ProjectRecord; definition: DefinitionRecord }> {
  const explicitProject = typeof flags.project === "string" ? flags.project : undefined;
  const projects = (await listProjects({ autoStart: options.autoStart })).projects;
  return findDefinition(projects, "workflow", reference, process.cwd(), explicitProject);
}

async function resolveServiceReference(
  reference: string,
  flags: Record<string, string | boolean>,
  options: ResolutionOptions = {}
): Promise<{ project: ProjectRecord; definition: DefinitionRecord }> {
  const explicitProject = typeof flags.project === "string" ? flags.project : undefined;
  const projects = (await listProjects({ autoStart: options.autoStart })).projects;
  return findDefinition(projects, "service", reference, process.cwd(), explicitProject);
}

async function resolveServiceTarget(
  reference: string,
  flags: Record<string, string | boolean>,
  options: ResolutionOptions = {}
): Promise<{
  project: ProjectRecord;
  definition: DefinitionRecord;
  keyInput: unknown;
  serviceKey: string;
}> {
  const { project, definition } = await resolveServiceReference(reference, flags, options);
  const keyInput = parseJsonFlag(flags["key-json"] ?? flags.key, "key-json", {});
  const directServiceKey =
    typeof (flags["service-key"] ?? flags.serviceKey) === "string"
      ? String(flags["service-key"] ?? flags.serviceKey)
      : null;
  const serviceKey =
    directServiceKey && directServiceKey.trim() !== ""
      ? directServiceKey
      : await resolveExistingServiceKey(project.name, definition.name, keyInput, options);

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

async function resolveExistingServiceKey(
  projectName: string,
  definitionName: string,
  keyInput: unknown,
  options: ResolutionOptions = {}
): Promise<string> {
  const response = await listServiceRuns(projectName, false, { autoStart: options.autoStart });
  const existing = response.runs.find(
    (run) =>
      run.definitionName === definitionName &&
      typeof run.serviceKey === "string" &&
      JSON.stringify(run.keyInput ?? null) === JSON.stringify(keyInput ?? null)
  );

  if (existing?.serviceKey) {
    return existing.serviceKey;
  }

  throw new CliError(
    "Usage requires --service-key <key> for new or unresolved service instances. --key-json can only target an existing service instance already registered in the runtime."
  );
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
