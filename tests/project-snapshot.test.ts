import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

test("pruneAllProjectSnapshots removes sealed snapshots across projects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-project-snapshot-"));
  const runtimeHome = path.join(root, "runtime-home");
  const executionHome = path.join(root, "execution-home");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");

  try {
    await writeProject(projectA, "export const project = 'a';\n");
    await writeProject(projectB, "export const project = 'b';\n");

    const script = `
      import { materializeProjectSnapshot, pruneAllProjectSnapshots } from ${JSON.stringify(
        pathToFileURL(path.join(import.meta.dir, "..", "cli", "src", "project-snapshot.ts")).href
      )};

      const removed = await materializeProjectSnapshot("project-a", process.env.PROJECT_A);
      const retained = await materializeProjectSnapshot("project-b", process.env.PROJECT_B);
      await pruneAllProjectSnapshots([retained]);
      console.log(JSON.stringify({ removed, retained }));
    `;

    const proc = Bun.spawn([process.execPath, "--eval", script], {
      env: {
        ...process.env,
        VILANO_HOME: runtimeHome,
        VILANO_EXECUTION_HOME: executionHome,
        PROJECT_A: projectA,
        PROJECT_B: projectB,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToString(proc.stdout),
      streamToString(proc.stderr),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const result = JSON.parse(stdout.trim()) as { removed: string; retained: string };
    await expect(fs.access(result.removed)).rejects.toThrow();
    await fs.access(result.retained);
  } finally {
    await makeTreeWritable(root).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function writeProject(projectPath: string, source: string): Promise<void> {
  await fs.mkdir(path.join(projectPath, "src"), { recursive: true });
  await fs.writeFile(path.join(projectPath, "src", "index.ts"), source, "utf8");
}

async function streamToString(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return "";
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    result += decoder.decode(value, { stream: true });
  }

  result += decoder.decode();
  return result;
}

async function makeTreeWritable(rootPath: string): Promise<void> {
  const stat = await fs.lstat(rootPath);

  if (stat.isDirectory()) {
    const entries = await fs.readdir(rootPath);
    await Promise.all(entries.map((entry) => makeTreeWritable(path.join(rootPath, entry))));
    await fs.chmod(rootPath, stat.mode | 0o200);
    return;
  }

  if (stat.isFile()) {
    await fs.chmod(rootPath, stat.mode | 0o200);
  }
}
