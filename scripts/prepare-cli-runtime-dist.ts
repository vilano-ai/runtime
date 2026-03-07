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
