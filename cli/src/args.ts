import process from "node:process";

export type CommandFlags = Record<string, string | boolean>;

export interface ParsedArgs {
  positionals: string[];
  flags: CommandFlags;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: CommandFlags = {};

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

export function shouldApplyProjectConfig(parsed: ParsedArgs): boolean {
  if (parsed.positionals[0] === "help") {
    return false;
  }

  if (parsed.positionals.length === 0 || parsed.flags.help || parsed.flags.h) {
    return false;
  }

  const [group] = parsed.positionals;
  return !["version", "update", "rollback", "doctor"].includes(group ?? "");
}

export function writeCliError(error: unknown, argv: string[]): number {
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
