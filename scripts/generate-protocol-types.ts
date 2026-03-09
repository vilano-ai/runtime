import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const GENERATED_DIR = path.join(ROOT, "protocol", "v1", "generated");

await fs.mkdir(GENERATED_DIR, { recursive: true });

await generate("worker.openapi.yaml", "worker.ts");
await generate("control.openapi.yaml", "control.ts");

async function generate(sourceFile: string, outputFile: string): Promise<void> {
  const inputPath = path.join(ROOT, "protocol", "v1", sourceFile);
  const outputPath = path.join(GENERATED_DIR, outputFile);

  await run("openapi-typescript", [inputPath, "-o", outputPath]);
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? 1}`));
    });
  });
}
