import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

await run("git", ["diff", "--quiet", "--", "protocol/v1/generated"]);

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          "Generated protocol types are out of date. Run `bun run generate:protocol` and commit the result."
        )
      );
    });
  });
}
