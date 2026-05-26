import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const PROJECT_CONFIG_FILE = "vilano.toml";

export interface VilanoProjectConfig {
  runtime?: {
    port?: number;
    execution_home?: string;
    managed_workers?: number;
    managed_worker_runtime?: "bun" | "node";
    managed_worker_mode?: "per_activation" | "pooled";
    repo_pool_size?: number;
    lease_duration_seconds?: number;
  };
  project?: {
    env_file?: string | string[];
  };
  storage?: {
    snapshot_excludes?: string[];
    snapshot_include_node_modules?: boolean;
  };
}

export interface LoadedVilanoProjectConfig {
  path: string;
  rootDir: string;
  config: VilanoProjectConfig;
}

const RUNTIME_ENV_MAP = {
  port: "VILANO_KERNEL_PORT",
  execution_home: "VILANO_EXECUTION_HOME",
  managed_workers: "VILANO_MANAGED_WORKERS",
  managed_worker_runtime: "VILANO_MANAGED_WORKER_RUNTIME",
  managed_worker_mode: "VILANO_MANAGED_WORKER_MODE",
  repo_pool_size: "VILANO_REPO_POOL_SIZE",
  lease_duration_seconds: "VILANO_LEASE_DURATION_SECONDS",
} as const;

export async function loadProjectConfigForCwd(
  startDir = process.cwd()
): Promise<LoadedVilanoProjectConfig | null> {
  const configPath = await findProjectConfig(startDir);
  if (!configPath) {
    return null;
  }

  const raw = Bun.TOML.parse(await fs.readFile(configPath, "utf8"));
  const config = normalizeProjectConfig(raw, configPath);
  return {
    path: configPath,
    rootDir: path.dirname(configPath),
    config,
  };
}

export async function applyProjectConfigForCwd(
  startDir = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): Promise<LoadedVilanoProjectConfig | null> {
  const loaded = await loadProjectConfigForCwd(startDir);
  if (!loaded) {
    return null;
  }

  await applyProjectConfig(loaded, env);
  return loaded;
}

export async function applyProjectConfig(
  loaded: LoadedVilanoProjectConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const envFiles = normalizeEnvFiles(loaded.config.project?.env_file);
  for (const envFile of envFiles) {
    await loadEnvFile(path.resolve(loaded.rootDir, envFile), env);
  }

  const runtimeConfig = loaded.config.runtime ?? {};
  for (const [key, envName] of Object.entries(RUNTIME_ENV_MAP) as Array<
    [keyof NonNullable<VilanoProjectConfig["runtime"]>, (typeof RUNTIME_ENV_MAP)[keyof typeof RUNTIME_ENV_MAP]]
  >) {
    if (env[envName] !== undefined) {
      continue;
    }

    const value = runtimeConfig[key];
    if (value === undefined) {
      continue;
    }

    if (key === "execution_home") {
      env[envName] = path.resolve(loaded.rootDir, value as string);
      continue;
    }

    env[envName] = String(value);
  }

  const storageConfig = loaded.config.storage ?? {};
  if (env.VILANO_SNAPSHOT_EXCLUDES === undefined && storageConfig.snapshot_excludes !== undefined) {
    env.VILANO_SNAPSHOT_EXCLUDES = JSON.stringify(storageConfig.snapshot_excludes);
  }

  if (
    env.VILANO_SNAPSHOT_INCLUDE_NODE_MODULES === undefined &&
    storageConfig.snapshot_include_node_modules !== undefined
  ) {
    env.VILANO_SNAPSHOT_INCLUDE_NODE_MODULES = String(storageConfig.snapshot_include_node_modules);
  }
}

async function findProjectConfig(startDir: string): Promise<string | null> {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, PROJECT_CONFIG_FILE);
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function normalizeProjectConfig(value: unknown, configPath: string): VilanoProjectConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${PROJECT_CONFIG_FILE} must contain a TOML object: ${configPath}`);
  }

  const record = value as Record<string, unknown>;
  const runtime = normalizeRuntimeConfig(record.runtime, configPath);
  const project = normalizeProjectSection(record.project, configPath);
  const storage = normalizeStorageSection(record.storage, configPath);
  return {
    ...(runtime ? { runtime } : {}),
    ...(project ? { project } : {}),
    ...(storage ? { storage } : {}),
  };
}

function normalizeRuntimeConfig(
  value: unknown,
  configPath: string
): VilanoProjectConfig["runtime"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[runtime] in ${PROJECT_CONFIG_FILE} must be a table: ${configPath}`);
  }

  const record = value as Record<string, unknown>;
  const runtime: NonNullable<VilanoProjectConfig["runtime"]> = {};

  runtime.port = readOptionalInteger(record.port, "runtime.port", configPath, { min: 1, max: 65_535 });
  runtime.managed_workers = readOptionalInteger(record.managed_workers, "runtime.managed_workers", configPath, {
    min: 0,
  });
  runtime.repo_pool_size = readOptionalInteger(record.repo_pool_size, "runtime.repo_pool_size", configPath, {
    min: 1,
  });
  runtime.lease_duration_seconds = readOptionalInteger(
    record.lease_duration_seconds,
    "runtime.lease_duration_seconds",
    configPath,
    { min: 1 }
  );
  runtime.execution_home = readOptionalString(record.execution_home, "runtime.execution_home", configPath);
  runtime.managed_worker_runtime = readOptionalEnum(
    record.managed_worker_runtime,
    "runtime.managed_worker_runtime",
    configPath,
    ["bun", "node"]
  );
  runtime.managed_worker_mode = readOptionalEnum(
    record.managed_worker_mode,
    "runtime.managed_worker_mode",
    configPath,
    ["per_activation", "pooled"]
  );

  return Object.keys(runtime).length > 0 ? runtime : undefined;
}

function normalizeProjectSection(
  value: unknown,
  configPath: string
): VilanoProjectConfig["project"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[project] in ${PROJECT_CONFIG_FILE} must be a table: ${configPath}`);
  }

  const record = value as Record<string, unknown>;
  const envFile = normalizeEnvFileValue(record.env_file, configPath);
  if (envFile === undefined) {
    return undefined;
  }

  return { env_file: envFile };
}

function normalizeStorageSection(
  value: unknown,
  configPath: string
): VilanoProjectConfig["storage"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[storage] in ${PROJECT_CONFIG_FILE} must be a table: ${configPath}`);
  }

  const record = value as Record<string, unknown>;
  const storage: NonNullable<VilanoProjectConfig["storage"]> = {};

  storage.snapshot_excludes = readOptionalSnapshotExcludes(
    record.snapshot_excludes,
    "storage.snapshot_excludes",
    configPath
  );
  storage.snapshot_include_node_modules = readOptionalBoolean(
    record.snapshot_include_node_modules,
    "storage.snapshot_include_node_modules",
    configPath
  );

  return Object.keys(storage).length > 0 ? storage : undefined;
}

function normalizeEnvFiles(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function normalizeEnvFileValue(value: unknown, configPath: string): string | string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
    return value;
  }

  throw new Error(`[project].env_file in ${PROJECT_CONFIG_FILE} must be a string or array of strings: ${configPath}`);
}

function readOptionalString(value: unknown, field: string, configPath: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} in ${PROJECT_CONFIG_FILE} must be a non-empty string: ${configPath}`);
  }

  return value;
}

function readOptionalStringArray(value: unknown, field: string, configPath: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
    throw new Error(`${field} in ${PROJECT_CONFIG_FILE} must be an array of non-empty strings: ${configPath}`);
  }

  return value;
}

function readOptionalSnapshotExcludes(value: unknown, field: string, configPath: string): string[] | undefined {
  const entries = readOptionalStringArray(value, field, configPath);
  if (entries === undefined) {
    return undefined;
  }

  for (const entry of entries) {
    if (path.isAbsolute(entry) || /^[A-Za-z]:[\\/]/.test(entry)) {
      throw new Error(`${field} in ${PROJECT_CONFIG_FILE} must contain relative paths or names: ${configPath}`);
    }

    const parts = entry.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0 || parts.includes(".") || parts.includes("..")) {
      throw new Error(`${field} in ${PROJECT_CONFIG_FILE} must not contain . or .. segments: ${configPath}`);
    }
  }

  return entries;
}

function readOptionalBoolean(value: unknown, field: string, configPath: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${field} in ${PROJECT_CONFIG_FILE} must be a boolean: ${configPath}`);
  }

  return value;
}

function readOptionalInteger(
  value: unknown,
  field: string,
  configPath: string,
  range: { min: number; max?: number }
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < range.min ||
    (range.max !== undefined && value > range.max)
  ) {
    throw new Error(`${field} in ${PROJECT_CONFIG_FILE} must be an integer between ${range.min} and ${range.max ?? "∞"}: ${configPath}`);
  }

  return value;
}

function readOptionalEnum<TAllowed extends string>(
  value: unknown,
  field: string,
  configPath: string,
  allowed: readonly TAllowed[]
): TAllowed | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !allowed.includes(value as TAllowed)) {
    throw new Error(`${field} in ${PROJECT_CONFIG_FILE} must be one of ${allowed.join(", ")}: ${configPath}`);
  }

  return value as TAllowed;
}

async function loadEnvFile(envFilePath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const contents = await fs.readFile(envFilePath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1];
    const rawValue = match[2] ?? "";
    if (!key) {
      continue;
    }

    if (env[key] !== undefined) {
      continue;
    }

    env[key] = parseEnvValue(rawValue);
  }
}

function parseEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  const commentIndex = trimmed.indexOf(" #");
  if (commentIndex >= 0) {
    return trimmed.slice(0, commentIndex).trimEnd();
  }

  return trimmed;
}
