#!/usr/bin/env node

import process from "node:process";

import { startWorker } from "./index.ts";

interface ParsedArgs {
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || !token.startsWith("--")) {
      continue;
    }

    const raw = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[raw] = next;
      index += 1;
      continue;
    }

    flags[raw] = true;
  }

  return { flags };
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));

  await startWorker({
    serverUrl: typeof parsed.flags.server === "string" ? parsed.flags.server : undefined,
    workerId: typeof parsed.flags["worker-id"] === "string" ? parsed.flags["worker-id"] : undefined,
    authToken: typeof parsed.flags.token === "string" ? parsed.flags.token : undefined,
    once: Boolean(parsed.flags.once),
  });
}
