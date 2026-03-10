import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const RELEASE_DIR = path.join(ROOT, "dist", "release");
const WORKER_PUBLIC_DIR = path.join(ROOT, "deploy", "cloudflare", "runtime-installer", "public");

await fs.mkdir(WORKER_PUBLIC_DIR, { recursive: true });

for (const fileName of ["install.sh", "release.json"]) {
  const sourcePath = path.join(RELEASE_DIR, fileName);
  const targetPath = path.join(WORKER_PUBLIC_DIR, fileName);
  await fs.copyFile(sourcePath, targetPath);
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      sourceDir: RELEASE_DIR,
      targetDir: WORKER_PUBLIC_DIR,
      files: ["install.sh", "release.json"],
    },
    null,
    2
  )}\n`
);
