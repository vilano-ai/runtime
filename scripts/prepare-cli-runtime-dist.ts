import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI_DIR = path.join(ROOT, "cli");
const RUNTIME_DIST_DIR = path.join(CLI_DIR, "runtime-dist");

await fs.rm(RUNTIME_DIST_DIR, { recursive: true, force: true });
await fs.mkdir(RUNTIME_DIST_DIR, { recursive: true });

await copyIntoRuntimeDist("kernel", [
  ".formatter.exs",
  "README.md",
  "config",
  "lib",
  "mix.exs",
  "mix.lock",
]);

await copyIntoRuntimeDist(path.join("worker", "bun"), [
  "package.json",
  "src",
  "tsconfig.json",
]);

await writeBundleManifest();

async function copyIntoRuntimeDist(sourceRelativeDir: string, entries: string[]): Promise<void> {
  const sourceDir = path.join(ROOT, sourceRelativeDir);
  const targetDir = path.join(RUNTIME_DIST_DIR, sourceRelativeDir);

  await fs.mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    await fs.cp(path.join(sourceDir, entry), path.join(targetDir, entry), {
      recursive: true,
      force: true,
    });
  }
}

async function writeBundleManifest(): Promise<void> {
  const cliPackage = await readJson(path.join(CLI_DIR, "package.json"));
  const workerPackage = await readJson(path.join(ROOT, "worker", "bun", "package.json"));
  const kernelVersion = await readKernelVersion(path.join(ROOT, "kernel", "mix.exs"));
  const protocolVersion = await readProtocolVersion(path.join(ROOT, "kernel", "lib", "vilano_kernel", "version.ex"));
  const runtimeVersion = kernelVersion ?? cliPackage.version ?? workerPackage.version ?? "0.0.0";
  const bundleVersion = `runtime-${runtimeVersion}-protocol-${protocolVersion}`;

  await fs.writeFile(
    path.join(RUNTIME_DIST_DIR, "bundle-manifest.json"),
    `${JSON.stringify(
      {
        bundleVersion,
        cliVersion: cliPackage.version ?? "0.0.0",
        runtimeVersion,
        protocolVersion,
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function readJson(filePath: string): Promise<Record<string, string>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, string>;
}

async function readKernelVersion(filePath: string): Promise<string | null> {
  const source = await fs.readFile(filePath, "utf8");
  const match = source.match(/version:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

async function readProtocolVersion(filePath: string): Promise<number> {
  const source = await fs.readFile(filePath, "utf8");
  const match = source.match(/@protocol_version\s+(\d+)/);
  return match ? Number.parseInt(match[1] ?? "1", 10) : 1;
}
