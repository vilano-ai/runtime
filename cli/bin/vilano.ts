#!/usr/bin/env bun

import { main } from "../src/index.ts";

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = typeof code === "number" ? code : 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { message } }, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(1);
}
