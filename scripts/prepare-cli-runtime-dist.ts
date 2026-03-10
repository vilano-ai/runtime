import fs from "node:fs/promises";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { createRuntimeInstallManifest } from "../cli/src/distribution-contract.ts";
import { collectRuntimeBuildInfo } from "../cli/src/runtime-compatibility.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI_DIR = path.join(ROOT, "cli");
const RUNTIME_DIST_DIR = path.join(CLI_DIR, "runtime-dist");

await fs.rm(RUNTIME_DIST_DIR, { recursive: true, force: true });
await fs.mkdir(RUNTIME_DIST_DIR, { recursive: true });

await prepareKernelRelease();
await copyKernelReleaseIntoRuntimeDist();

await copyIntoRuntimeDist("worker", [
  "bun",
  "node",
  "shared",
]);

await copyIntoRuntimeDist("sdk", [
  "typescript",
]);

await copyIntoRuntimeDist("protocol", [
  "v1",
]);

await writeBundleManifest();

async function copyIntoRuntimeDist(sourceRelativeDir: string, entries: string[]): Promise<void> {
  const sourceDir = path.join(ROOT, sourceRelativeDir);
  const targetDir = path.join(RUNTIME_DIST_DIR, sourceRelativeDir);

  await fs.mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    const sourceEntry = path.join(sourceDir, entry);
    try {
      await fs.access(sourceEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }

      throw error;
    }

    await fs.cp(sourceEntry, path.join(targetDir, entry), {
      recursive: true,
      force: true,
    });
  }
}

async function prepareKernelRelease(): Promise<void> {
  const kernelDir = path.join(ROOT, "kernel");
  const releaseDir = path.join(kernelDir, "_build", "prod", "rel", "vilano_kernel");
  const env = {
    ...process.env,
    MIX_ENV: "prod",
  };

  await fs.rm(releaseDir, { recursive: true, force: true });
  await runCommand("mix", ["deps.get"], kernelDir, env);
  await runCommand("mix", ["release", "--overwrite"], kernelDir, env);
}

async function copyKernelReleaseIntoRuntimeDist(): Promise<void> {
  const releaseSource = path.join(ROOT, "kernel", "_build", "prod", "rel", "vilano_kernel");
  const releaseTarget = path.join(RUNTIME_DIST_DIR, "kernel-release");
  await fs.cp(releaseSource, releaseTarget, {
    recursive: true,
    force: true,
  });
}

async function writeBundleManifest(): Promise<void> {
  const cliPackage = await readJson(path.join(CLI_DIR, "package.json"));
  const workerPackage = await readJson(path.join(ROOT, "worker", "bun", "package.json"));
  const kernelVersion = await readKernelVersion(path.join(ROOT, "kernel", "mix.exs"));
  const protocolVersion = await readProtocolVersion(path.join(ROOT, "kernel", "lib", "vilano_kernel", "version.ex"));
  const schemaVersion = await readLatestSchemaVersion(
    path.join(ROOT, "kernel", "lib", "vilano_kernel", "storage", "migrations")
  );
  const runtimeVersion = kernelVersion ?? cliPackage.version ?? workerPackage.version ?? "0.0.0";
  const bundleVersion = `cli-${cliPackage.version ?? "0.0.0"}-runtime-${runtimeVersion}-protocol-${protocolVersion}`;
  const bundleContentHash = await hashRuntimeDistContents();
  const runtimeBuildInfo = await collectRuntimeBuildInfo();
  const manifest = createRuntimeInstallManifest({
    cliVersion: cliPackage.version ?? "0.0.0",
    runtimeVersion,
    protocolVersion,
    schemaVersion,
    bundleVersion,
    bundleContentHash,
    supportedWorkerRuntimes: ["bun"],
    compatibility: runtimeBuildInfo.compatibility,
    build: runtimeBuildInfo.build,
  });

  await fs.writeFile(
    path.join(RUNTIME_DIST_DIR, "install-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
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

async function readLatestSchemaVersion(migrationsDir: string): Promise<number> {
  const files = (await fs.readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".ex"))
    .sort();

  let latest = 0;

  for (const file of files) {
    const source = await fs.readFile(path.join(migrationsDir, file), "utf8");
    const match = source.match(/def version,\s*do:\s*(\d+)/);
    if (!match) {
      continue;
    }

    latest = Math.max(latest, Number.parseInt(match[1] ?? "0", 10));
  }

  return latest;
}

async function hashRuntimeDistContents(): Promise<string> {
  const hash = crypto.createHash("sha256");
  const files = await collectFiles(RUNTIME_DIST_DIR);

  for (const filePath of files) {
    const relativePath = path.relative(RUNTIME_DIST_DIR, filePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }

  return hash.digest("hex").slice(0, 16);
}

async function collectFiles(rootPath: string): Promise<string[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed: ${command} ${args.join(" ")} (exit ${code ?? 1})`));
    });
  });
}
