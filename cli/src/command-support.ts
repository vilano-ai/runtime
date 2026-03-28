import process from "node:process";

import { inspectServiceEnvelope, listProjects, listServiceRuns } from "./daemon-client.ts";
import { CliError } from "./cli-error.ts";
import { findDefinition, resolveProjectForCwd } from "./registry.ts";
import type {
  DefinitionRecord,
  ProjectRecord,
  RunEnvelopeRecord,
} from "./types.ts";
import type { CommandFlags } from "./args.ts";

export interface ResolutionOptions {
  autoStart?: boolean;
}

export async function resolveProjectScope(
  flags: CommandFlags,
  options: ResolutionOptions = {}
): Promise<string | undefined> {
  const projectFlag = flags.project;
  if (typeof projectFlag === "string" && projectFlag.trim() !== "") {
    return projectFlag;
  }

  const projects = (await listProjects({ autoStart: options.autoStart })).projects;
  return resolveProjectForCwd(projects, process.cwd())?.name;
}

export async function resolveRunProjectScope(
  flags: CommandFlags
): Promise<string | undefined> {
  return resolveProjectScope(flags);
}

export async function resolveWorkflowReference(
  reference: string,
  flags: CommandFlags,
  options: ResolutionOptions = {}
): Promise<{ project: ProjectRecord; definition: DefinitionRecord }> {
  const explicitProject = typeof flags.project === "string" ? flags.project : undefined;
  const projects = (await listProjects({ autoStart: options.autoStart })).projects;
  return findDefinition(projects, "workflow", reference, process.cwd(), explicitProject);
}

export async function resolveServiceReference(
  reference: string,
  flags: CommandFlags,
  options: ResolutionOptions = {}
): Promise<{ project: ProjectRecord; definition: DefinitionRecord }> {
  const explicitProject = typeof flags.project === "string" ? flags.project : undefined;
  const projects = (await listProjects({ autoStart: options.autoStart })).projects;
  return findDefinition(projects, "service", reference, process.cwd(), explicitProject);
}

export async function resolveServiceTarget(
  reference: string,
  flags: CommandFlags,
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

export function parseJsonFlag<T>(
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

export function parseDurationFlag(
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

export async function waitForServiceEnvelope(
  envelopeId: string,
  timeoutMs: number
): Promise<RunEnvelopeRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      const response = await inspectServiceEnvelope(envelopeId);
      if (
        response.envelope.status === "completed" ||
        response.envelope.status === "failed"
      ) {
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

async function resolveExistingServiceKey(
  projectName: string,
  definitionName: string,
  keyInput: unknown,
  options: ResolutionOptions = {}
): Promise<string> {
  const response = await listServiceRuns(projectName, false, {
    autoStart: options.autoStart,
  });
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

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
