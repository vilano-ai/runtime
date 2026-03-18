import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI_ENTRY = path.join(REPO_ROOT, "cli", "bin", "vilano.ts");

test("global help skips invalid vilano.toml files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-cli-config-guard-"));

  try {
    await fs.writeFile(path.join(root, "vilano.toml"), "[runtime\nport = 4141\n", "utf8");

    const result = await runCli(root, ["help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Vilano Runtime CLI");
    expect(result.stderr).toBe("");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("version skips missing env files from vilano.toml", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-cli-config-guard-"));

  try {
    await fs.writeFile(
      path.join(root, "vilano.toml"),
      ['[project]', 'env_file = ".env.missing"'].join("\n"),
      "utf8"
    );

    const result = await runCli(root, ["version", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      cliVersion: expect.any(String),
      protocolVersion: expect.any(Number),
    });
    expect(result.stderr).toBe("");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function runCli(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}
