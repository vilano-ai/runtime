import process from "node:process";

import { verifyReleasePublication } from "./release-verification.ts";

const parsed = parseArgs(process.argv.slice(2));

const releaseManifestSource = requireSingleValue(parsed, "release-manifest");
const installerSource = requireSingleValue(parsed, "installer");
const channel = resolveChannel(requireSingleValue(parsed, "channel"));
const requiredPlatforms = parsed.platform ?? [];
const expectedVersion = optionalSingleValue(parsed, "expected-version");
const expectedArtifactUrlPrefix = optionalSingleValue(parsed, "artifact-url-prefix");
const expectedNotesUrl = optionalSingleValue(parsed, "expected-notes-url");

if (requiredPlatforms.length === 0) {
  throw new Error("Expected at least one --platform value");
}

const result = await verifyReleasePublication({
  releaseManifestSource,
  installerSource,
  channel,
  requiredPlatforms,
  expectedVersion,
  expectedArtifactUrlPrefix,
  expectedNotesUrl,
});

process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);

function parseArgs(argv: string[]): Record<string, string[]> {
  const parsed: Record<string, string[]> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || !token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token ?? ""}`);
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    parsed[key] ??= [];
    parsed[key].push(next);
    index += 1;
  }

  return parsed;
}

function requireSingleValue(parsed: Record<string, string[]>, key: string): string {
  const value = optionalSingleValue(parsed, key);
  if (!value) {
    throw new Error(`Missing required --${key}`);
  }

  return value;
}

function optionalSingleValue(parsed: Record<string, string[]>, key: string): string | undefined {
  const values = parsed[key];
  if (!values || values.length === 0) {
    return undefined;
  }

  if (values.length !== 1) {
    throw new Error(`Expected a single value for --${key}`);
  }

  return values[0];
}

function resolveChannel(value: string): "stable" | "preview" {
  if (value !== "stable" && value !== "preview") {
    throw new Error(`Unsupported release channel: ${value}`);
  }

  return value;
}
