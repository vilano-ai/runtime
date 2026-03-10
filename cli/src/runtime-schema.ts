import fs from "node:fs/promises";
import path from "node:path";

import { Database } from "bun:sqlite";

import { getRuntimePaths } from "./runtime-home.ts";

export async function readRuntimeHomeSchemaVersion(): Promise<number | null> {
  const databasePath = path.join(getRuntimePaths().homeDir, "runtime.sqlite");

  try {
    await fs.access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const database = new Database(databasePath, { readonly: true });

  try {
    const runtimeMetadataRow = database
      .query("select schema_version from runtime_metadata order by updated_at desc limit 1")
      .get() as { schema_version?: number } | null;

    if (typeof runtimeMetadataRow?.schema_version === "number") {
      return runtimeMetadataRow.schema_version;
    }
  } catch {
    // Fall back to schema_migrations for older or partially initialized runtime homes.
  }

  try {
    const migrationRow = database
      .query("select max(version) as version from schema_migrations")
      .get() as { version?: number | null } | null;

    if (typeof migrationRow?.version === "number") {
      return migrationRow.version;
    }
  } catch {
    return null;
  } finally {
    database.close(false);
  }

  return null;
}
