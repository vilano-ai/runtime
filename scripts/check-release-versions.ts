import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dir, "..");
const expectedVersion = process.env.GITHUB_REF_NAME?.replace(/^v/u, "");

if (!expectedVersion) {
  throw new Error("GITHUB_REF_NAME is required");
}

const sources = [
  { label: "sdk", path: path.join(ROOT, "sdk", "typescript", "package.json"), type: "json" as const },
  { label: "cli", path: path.join(ROOT, "cli", "package.json"), type: "json" as const },
  { label: "worker-bun", path: path.join(ROOT, "worker", "bun", "package.json"), type: "json" as const },
  { label: "worker-node", path: path.join(ROOT, "worker", "node", "package.json"), type: "json" as const },
  { label: "worker-shared", path: path.join(ROOT, "worker", "shared", "package.json"), type: "json" as const },
  { label: "kernel", path: path.join(ROOT, "kernel", "mix.exs"), type: "mix" as const },
];

const versions = await Promise.all(
  sources.map(async (source) => {
    const version =
      source.type === "json" ? await readJsonVersion(source.path) : await readKernelVersion(source.path);
    return {
      label: source.label,
      version,
    };
  })
);

for (const entry of versions) {
  if (entry.version !== expectedVersion) {
    throw new Error(
      `Release version mismatch for ${entry.label}: expected ${expectedVersion}, got ${entry.version}`
    );
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      expectedVersion,
      versions,
    },
    null,
    2
  )}\n`
);

async function readJsonVersion(filePath: string): Promise<string> {
  const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as { version?: unknown };
  if (typeof raw.version !== "string" || raw.version.length === 0) {
    throw new Error(`Missing version in ${filePath}`);
  }

  return raw.version;
}

async function readKernelVersion(filePath: string): Promise<string> {
  const source = await fs.readFile(filePath, "utf8");
  const match = source.match(/version:\s*"([^"]+)"/u);
  const version = match?.[1];
  if (!version) {
    throw new Error(`Missing version in ${filePath}`);
  }

  return version;
}
