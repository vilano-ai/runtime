import fs from "node:fs/promises";
import path from "node:path";

import {
  RELEASE_METADATA_VERSION,
  type ReleaseMetadataManifest,
} from "../cli/src/distribution-contract.ts";
import { renderInstallScript } from "./release-installer.ts";
import { mergeReleaseMetadata } from "./release-metadata.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const DIST_DIR = path.join(ROOT, "dist", "release");
const INPUT_DIR = process.env.VILANO_RELEASE_INPUT_DIR
  ? path.resolve(process.env.VILANO_RELEASE_INPUT_DIR)
  : DIST_DIR;
const OUTPUT_DIR = process.env.VILANO_RELEASE_OUTPUT_DIR
  ? path.resolve(process.env.VILANO_RELEASE_OUTPUT_DIR)
  : DIST_DIR;

const manifests = await collectReleaseManifests(INPUT_DIR);
if (manifests.length === 0) {
  throw new Error(`No release.json files found under ${INPUT_DIR}`);
}

const merged = mergeReleaseMetadata(manifests);
await fs.mkdir(OUTPUT_DIR, { recursive: true });
await copyReleaseArtifacts(INPUT_DIR, OUTPUT_DIR);
await fs.writeFile(path.join(OUTPUT_DIR, "release.json"), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(OUTPUT_DIR, "SHA256SUMS"), await buildChecksums(INPUT_DIR), "utf8");
await fs.writeFile(path.join(OUTPUT_DIR, "install.sh"), renderInstallScript(merged), "utf8");
await fs.chmod(path.join(OUTPUT_DIR, "install.sh"), 0o755);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      inputDir: INPUT_DIR,
      outputDir: OUTPUT_DIR,
      version: merged.latest,
      platforms: Object.keys(merged.releases[merged.latest]?.artifacts ?? {}).sort(),
    },
    null,
    2
  )}\n`
);

async function collectReleaseManifests(rootDir: string): Promise<ReleaseMetadataManifest[]> {
  const files = await collectFiles(rootDir);
  const manifestFiles = files.filter((filePath) => path.basename(filePath) === "release.json");
  const manifests: ReleaseMetadataManifest[] = [];

  for (const filePath of manifestFiles) {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as ReleaseMetadataManifest;
    if (raw.manifestVersion !== RELEASE_METADATA_VERSION) {
      throw new Error(`Unsupported release metadata version in ${filePath}`);
    }
    manifests.push(raw);
  }

  return manifests;
}

async function copyReleaseArtifacts(inputDir: string, outputDir: string): Promise<void> {
  const files = await collectFiles(inputDir);
  const artifactFiles = files.filter((filePath) => filePath.endsWith(".tar.gz"));
  const copiedNames = new Map<string, string>();

  for (const filePath of artifactFiles) {
    const fileName = path.basename(filePath);
    const previousSource = copiedNames.get(fileName);
    if (previousSource && previousSource !== filePath) {
      throw new Error(`Duplicate release artifact filename while merging: ${fileName}`);
    }

    copiedNames.set(fileName, filePath);
    const targetPath = path.join(outputDir, fileName);
    if (path.resolve(filePath) === path.resolve(targetPath)) {
      continue;
    }

    await fs.copyFile(filePath, targetPath);
  }
}

async function buildChecksums(rootDir: string): Promise<string> {
  const files = await collectFiles(rootDir);
  const checksumFiles = files.filter((filePath) => path.basename(filePath) === "SHA256SUMS");
  const lines = new Set<string>();

  for (const filePath of checksumFiles) {
    const content = await fs.readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed) {
        lines.add(trimmed);
      }
    }
  }

  return `${Array.from(lines).sort().join("\n")}\n`;
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
