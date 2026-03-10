import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import {
  type ReleaseChannel,
  type RuntimeInstallManifest,
} from "../cli/src/distribution-contract.ts";
import { copyPackageDependencyTree } from "../cli/src/dependency-tree.ts";
import { renderInstallScript } from "./release-installer.ts";
import { buildReleaseMetadata } from "./release-metadata.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI_DIR = path.join(ROOT, "cli");
const DIST_DIR = path.join(ROOT, "dist", "release");

const PLATFORM_KEY = resolvePlatformKey();
const RELEASE_CHANNEL = resolveReleaseChannel();

await fs.rm(DIST_DIR, { recursive: true, force: true });
await fs.mkdir(DIST_DIR, { recursive: true });

const cliPackage = await readJson(path.join(CLI_DIR, "package.json"));
const runtimeVersion = cliPackage.version ?? "0.0.0";
const artifactFileName = `vilano-v${runtimeVersion}-${PLATFORM_KEY}.tar.gz`;
const artifactRootName = `vilano-v${runtimeVersion}-${PLATFORM_KEY}`;
const artifactPath = path.join(DIST_DIR, artifactFileName);
const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-release-build-"));
const baseUrl = resolveReleaseBaseUrl();
const installManifest = (await readJson(
  path.join(CLI_DIR, "runtime-dist", "install-manifest.json")
)) as RuntimeInstallManifest;

try {
  const artifactRoot = path.join(stagingDir, artifactRootName);
  await copyCliRuntime(artifactRoot);
  await copyBundledBun(artifactRoot);
  await copyPackageDependencyTree(CLI_DIR, artifactRoot);
  await copyInstallManifest(artifactRoot);
  await createTarball(stagingDir, artifactRootName, artifactPath);

  const sha256 = await hashFileSha256(artifactPath);
  const stat = await fs.stat(artifactPath);
  const releaseMetadata = buildReleaseMetadata({
    runtimeVersion,
    releaseChannel: RELEASE_CHANNEL,
    artifactFileName,
    sha256,
    sizeBytes: stat.size,
    baseUrl,
    platformKey: PLATFORM_KEY,
    installManifest,
    notesUrl: resolveReleaseNotesUrl(),
  });

  await fs.writeFile(
    path.join(DIST_DIR, "release.json"),
    `${JSON.stringify(releaseMetadata, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(DIST_DIR, "SHA256SUMS"),
    `${sha256}  ${artifactFileName}\n`,
    "utf8"
  );
  await fs.writeFile(path.join(DIST_DIR, "install.sh"), renderInstallScript(releaseMetadata), "utf8");
  await fs.chmod(path.join(DIST_DIR, "install.sh"), 0o755);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        version: runtimeVersion,
        channel: RELEASE_CHANNEL,
        platform: PLATFORM_KEY,
        artifactPath,
        releaseMetadataPath: path.join(DIST_DIR, "release.json"),
        installerPath: path.join(DIST_DIR, "install.sh"),
      },
      null,
      2
    )}\n`
  );
} finally {
  await fs.rm(stagingDir, { recursive: true, force: true });
}

async function copyCliRuntime(targetRoot: string): Promise<void> {
  await fs.mkdir(targetRoot, { recursive: true });
  for (const entry of ["bin", "src", "runtime-dist", "README.md", "LICENSE", "package.json"]) {
    await fs.cp(path.join(CLI_DIR, entry), path.join(targetRoot, entry), {
      recursive: true,
      force: true,
    });
  }
}

async function copyBundledBun(targetRoot: string): Promise<void> {
  const bunDir = path.join(targetRoot, "bun");
  const targetPath = path.join(bunDir, "bun");
  await fs.mkdir(bunDir, { recursive: true });
  await fs.copyFile(process.execPath, targetPath);
  await fs.chmod(targetPath, 0o755);
}

async function copyInstallManifest(targetRoot: string): Promise<void> {
  const installManifestPath = path.join(targetRoot, "runtime-dist", "install-manifest.json");
  await fs.copyFile(installManifestPath, path.join(targetRoot, "install-manifest.json"));
}

async function createTarball(sourceDir: string, rootName: string, targetPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-czf", targetPath, "-C", sourceDir, rootName], {
      stdio: "ignore",
      env: process.env,
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Failed to build release artifact tarball (exit ${code ?? 1})`));
    });
  });
}

function resolveReleaseBaseUrl(): string {
  if (process.env.VILANO_RELEASE_BASE_URL) {
    return process.env.VILANO_RELEASE_BASE_URL;
  }

  return new URL(`file://${DIST_DIR}/`).toString();
}

function resolveReleaseNotesUrl(): string | undefined {
  const value = process.env.VILANO_RELEASE_NOTES_URL;
  if (!value || value.length === 0) {
    return undefined;
  }

  return value;
}

function resolvePlatformKey(): string {
  const actual = `${process.platform}-${os.arch()}`;
  const expected = process.env.VILANO_RELEASE_PLATFORM;

  if (expected && expected !== actual) {
    throw new Error(
      `Release platform mismatch: expected ${expected} from VILANO_RELEASE_PLATFORM, got ${actual} from the current runner.`
    );
  }

  return actual;
}

async function hashFileSha256(filePath: string): Promise<string> {
  const digest = crypto.createHash("sha256");
  digest.update(await fs.readFile(filePath));
  return digest.digest("hex");
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

function resolveReleaseChannel(): ReleaseChannel {
  const candidate = process.env.VILANO_RELEASE_CHANNEL ?? "stable";
  if (candidate !== "stable" && candidate !== "preview") {
    throw new Error(`Unsupported release channel: ${candidate}`);
  }

  return candidate;
}
