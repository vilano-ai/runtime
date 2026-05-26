import { CliError } from "./cli-error.ts";

export function renderHelp(positionals: string[] = []): string {
  const [group, command] = positionals;

  switch (group) {
    case undefined:
      return renderTopLevelHelp();
    case "version":
      return [
        "Usage: vilano version [--json]",
        "",
        "Show CLI/runtime version info and the running kernel, if any.",
      ].join("\n");
    case "update":
      return [
        "Usage: vilano update [--check] [--release-manifest <path>] [--json]",
        "",
        "Check for or apply a managed runtime update.",
      ].join("\n");
    case "rollback":
      return [
        "Usage: vilano rollback [--json]",
        "",
        "Switch the managed install back to the previous runtime version.",
      ].join("\n");
    case "doctor":
      return [
        "Usage: vilano doctor [--fix] [--json]",
        "",
        "Inspect the local runtime environment. Use --fix to prepare missing local state.",
      ].join("\n");
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
    "  vilano daemon start|status|debug|storage|prune|stop",
    "  vilano project add|list|inspect|sync|remove",
    "  vilano workflow list|inspect",
    "  vilano run start|list|inspect|explain|replay|cancel",
    "  vilano worker start",
    "  vilano service list|ensure|inspect|history|send|ask|signal|stop",
    "  vilano signal send",
    "",
    "Use `vilano help <group> [command]` or `vilano <group> [command] --help` for details.",
  ].join("\n");
}

function renderDaemonHelp(command?: string): string {
  switch (command) {
    case "start":
      return [
        "Usage: vilano daemon start [--port <port>] [--json]",
        "",
        "Start the local Vilano kernel if it is not already running.",
      ].join("\n");
    case "status":
      return [
        "Usage: vilano daemon status [--json]",
        "",
        "Show the running kernel status, if any.",
      ].join("\n");
    case "debug":
      return [
        "Usage: vilano daemon debug [--json]",
        "",
        "Show a runtime debug snapshot with busy retries, active leases, and run backlog counts.",
      ].join("\n");
    case "storage":
      return [
        "Usage: vilano daemon storage [--json]",
        "",
        "Show runtime storage usage by directory and persisted row category.",
      ].join("\n");
    case "prune":
      return [
        "Usage: vilano daemon prune [--workspace-ttl-seconds <seconds>] [--event-payload-grace-seconds <seconds>] [--dry-run] [--json]",
        "",
        "Prune unreferenced snapshots, old inactive run workspaces, and orphan event payload files.",
      ].join("\n");
    case "stop":
      return [
        "Usage: vilano daemon stop [--json]",
        "",
        "Stop the local Vilano kernel.",
      ].join("\n");
    default:
      return [
        "Usage: vilano daemon <start|status|debug|storage|prune|stop> [--json]",
        "",
        "Manage the local Vilano kernel process.",
      ].join("\n");
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
      return [
        "Usage: vilano project list [--json]",
        "",
        "List registered local projects.",
      ].join("\n");
    case "inspect":
      return [
        "Usage: vilano project inspect <project> [--json]",
        "",
        "Show the registered manifest and snapshot details for a project.",
      ].join("\n");
    case "sync":
      return [
        "Usage: vilano project sync <project> [--json]",
        "",
        "Refresh a registered project from its source path. This re-validates the manifest, snapshots the project, and imports the declared definitions from that snapshot.",
        "",
        "Treat project sync as a trusted local-code step.",
      ].join("\n");
    case "remove":
      return [
        "Usage: vilano project remove <project> [--json]",
        "",
        "Remove a project registration.",
      ].join("\n");
    default:
      return [
        "Usage: vilano project <add|list|inspect|sync|remove> [--json]",
        "",
        "Manage the local project registry.",
      ].join("\n");
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
      return [
        "Usage: vilano workflow <list|inspect> [--json]",
        "",
        "Inspect registered workflow definitions.",
      ].join("\n");
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
      return [
        "Usage: vilano run list [--project <project>] [--json]",
        "",
        "List workflow and service runs for the selected project scope.",
      ].join("\n");
    case "inspect":
      return [
        "Usage: vilano run inspect <run-id> [--json]",
        "",
        "Show the current durable state for a run.",
      ].join("\n");
    case "explain":
      return [
        "Usage: vilano run explain <run-id> [--json]",
        "",
        "Summarize what a run is doing, waiting on, and which child work is still active.",
      ].join("\n");
    case "replay":
      return [
        "Usage: vilano run replay <run-id> [--json]",
        "",
        "Render the durable event timeline for a run.",
      ].join("\n");
    case "cancel":
      return [
        "Usage: vilano run cancel <run-id> [--json]",
        "",
        "Cancel a running workflow or service run.",
      ].join("\n");
    default:
      return [
        "Usage: vilano run <start|list|inspect|explain|replay|cancel> [--json]",
        "",
        "Operate on workflow and service runs.",
      ].join("\n");
  }
}

function renderWorkerHelp(command?: string): string {
  switch (command) {
    case "start":
      return [
        "Usage: vilano worker start [--runtime <bun|node>] [--once] [--worker-id <id>] [--server <url>] [--json]",
        "",
        "Start an external worker process and connect it to the local kernel.",
        "Bun is the supported worker path; Node remains preview.",
      ].join("\n");
    default:
      return [
        "Usage: vilano worker start [--runtime <bun|node>] [--once] [--worker-id <id>] [--server <url>] [--json]",
        "",
        "Start an external worker. Bun is the supported path; Node remains preview.",
      ].join("\n");
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
    case "history":
      return [
        "Usage: vilano service history <service-ref> --service-key <key> [--key-json '{...}'] [--project <project>] [--json]",
        "",
        "Render the durable replay timeline for a keyed service run.",
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
      return [
        "Usage: vilano service <list|ensure|inspect|history|send|ask|signal|stop> [--json]",
        "",
        "Operate on durable keyed services.",
      ].join("\n");
  }
}

function renderSignalHelp(command?: string): string {
  switch (command) {
    case "send":
      return [
        "Usage: vilano signal send <run-id> <signal-name> [--input '{...}'] [--json]",
        "",
        "Send a signal directly to a run.",
      ].join("\n");
    default:
      return [
        "Usage: vilano signal send <run-id> <signal-name> [--input '{...}'] [--json]",
        "",
        "Deliver run signals.",
      ].join("\n");
  }
}
