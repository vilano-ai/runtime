#!/usr/bin/env bun

import { main } from "../src/index.ts";

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = typeof code === "number" ? code : 0;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
