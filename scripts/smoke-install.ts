import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { deriveExecutionHomeDir } from "../cli/src/runtime-home.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI_DIR = path.join(ROOT, "cli");
const SDK_DIR = path.join(ROOT, "sdk", "typescript");

await run("bun", ["run", "prepare:cli-package"], ROOT);

const cliTarball = await packWorkspace(CLI_DIR);
const sdkTarball = await packWorkspace(SDK_DIR);
const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-install-smoke-"));
const runtimeHome = path.join(installDir, ".vilano-home");

try {
  await fs.writeFile(
    path.join(installDir, "package.json"),
    JSON.stringify(
      {
        name: "vilano-install-smoke",
        private: true,
      },
      null,
      2
    )
  );

  await run("bun", ["add", cliTarball, sdkTarball], installDir);

  const cliEntry = path.join(installDir, "node_modules", ".bin", "vilano");
  const packagedRuntimeDist = path.join(installDir, "node_modules", "vilano", "runtime-dist");
  const releaseMetadataPath = path.join(installDir, "release.json");
  const baseEnv = {
    ...process.env,
    VILANO_HOME: runtimeHome,
  };
  const packagedBundleHashBefore = await hashDirectoryContents(packagedRuntimeDist);

  const manifestProjectDir = path.join(installDir, "manifest-project");
  await fs.mkdir(path.join(manifestProjectDir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(manifestProjectDir, "src", "definitions.ts"),
    [
      "import { workflow } from '@vilano/runtime';",
      "",
      "export const smokeWorkflow = workflow({",
      "  name: 'smokeWorkflow',",
      "  run: async (input) => ({ ok: true, value: input?.value ?? 'smoke' }),",
      "});",
      "",
      ].join("\n")
  );

  const version = JSON.parse((await run(cliEntry, ["version", "--json"], installDir, baseEnv)).stdout) as {
    cliVersion: string;
    protocolVersion: number;
    runtimeBundle: {
      root: string;
      sourceRoot: string;
      bundled: boolean;
      materialized: boolean;
      bundleVersion: string;
      installManifestFile: string;
      installManifest: {
        runtimeVersion: string;
        protocolVersion: number;
        schemaVersion: number;
        supportedWorkerRuntimes: string[];
      } | null;
    };
  };

  if (!version.runtimeBundle.bundled) {
    throw new Error("Packaged CLI did not resolve a bundled runtime-dist");
  }

  if (version.runtimeBundle.materialized) {
    throw new Error("Packaged CLI version command should not materialize the runtime bundle");
  }

  if (version.runtimeBundle.root !== version.runtimeBundle.sourceRoot) {
    throw new Error("Packaged CLI version command should report the source runtime bundle before daemon start");
  }

  if (!version.runtimeBundle.installManifest) {
    throw new Error("Packaged CLI version command did not surface the runtime install manifest");
  }

  if (!version.runtimeBundle.installManifest.supportedWorkerRuntimes.includes("bun")) {
    throw new Error("Packaged CLI install manifest did not report the supported worker runtimes");
  }

  if (version.runtimeBundle.root.startsWith(runtimeHome)) {
    throw new Error(`Packaged CLI version command should not resolve to a materialized runtime root: ${version.runtimeBundle.root}`);
  }

  await fs.writeFile(
    releaseMetadataPath,
    `${JSON.stringify(
      {
        manifestVersion: 1,
        latest: "0.1.1",
        channels: {
          stable: "0.1.1",
        },
        releases: {
          "0.1.1": {
            version: "0.1.1",
            channel: "stable",
            protocolVersion: version.protocolVersion,
            schemaMin: version.runtimeBundle.installManifest?.schemaVersion ?? 0,
            schemaMax: version.runtimeBundle.installManifest?.schemaVersion ?? 0,
            supportedWorkerRuntimes: version.runtimeBundle.installManifest?.supportedWorkerRuntimes ?? ["bun"],
            releasedAt: "2026-03-10T12:00:00.000Z",
            artifacts: {
              [`${process.platform}-${process.arch}`]: {
                url: "https://example.com/vilano-v0.1.1.tar.gz",
                sha256: "abc123",
              },
            },
          },
        },
      },
      null,
      2
    )}\n`
  );

  const updateCheck = JSON.parse(
    (
      await run(
        cliEntry,
        ["update", "--check", "--release-manifest", releaseMetadataPath, "--json"],
        installDir,
        baseEnv
      )
    ).stdout
  ) as {
    updateAvailable: boolean;
    latest: {
      version: string;
      artifact: {
        url: string;
      } | null;
    };
  };

  if (!updateCheck.updateAvailable || updateCheck.latest.version !== "0.1.1") {
    throw new Error(
      `Packaged CLI update --check did not report the expected release metadata:\n${JSON.stringify(updateCheck, null, 2)}`
    );
  }

  const doctor = JSON.parse(
    (
      await run(
        cliEntry,
        ["doctor", "--json"],
        installDir,
        baseEnv,
        { allowFailure: true, timeoutMs: 240_000 }
      )
    ).stdout
  ) as { ok: boolean };

  if (!doctor.ok) {
    throw new Error(
      `Packaged CLI doctor did not produce a healthy install:\n${JSON.stringify(doctor, null, 2)}`
    );
  }

  const doctorFix = JSON.parse(
    (
      await run(
        cliEntry,
        ["doctor", "--fix", "--json"],
        installDir,
        baseEnv,
        { allowFailure: true, timeoutMs: 240_000 }
      )
    ).stdout
  ) as { ok: boolean; appliedFixes?: string[] };

  if (!doctorFix.ok) {
    throw new Error(
      `Packaged CLI doctor --fix did not succeed:\n${JSON.stringify(doctorFix, null, 2)}`
    );
  }

  const packagedBundleHashAfterDoctorFix = await hashDirectoryContents(packagedRuntimeDist);
  if (packagedBundleHashBefore !== packagedBundleHashAfterDoctorFix) {
    throw new Error("Packaged runtime-dist contents changed during doctor --fix");
  }

  const { env, status } = await startDaemonWithRetry(cliEntry, installDir, runtimeHome, version.protocolVersion);

  if (status.protocolVersion !== version.protocolVersion) {
    throw new Error("Packaged CLI started a kernel with a mismatched protocol version");
  }

  const initManifest = JSON.parse(
    (await run(cliEntry, ["project", "init-manifest", "./manifest-project", "--json"], installDir, env)).stdout
  ) as {
    manifestPath: string;
    manifest: {
      definitions: {
        workflows: Array<{ name: string }>;
      };
    };
  };

  if (!initManifest.manifest.definitions.workflows.some((definition) => definition.name === "smokeWorkflow")) {
    throw new Error("Packaged CLI did not generate an explicit manifest for the smoke project");
  }

  await run(cliEntry, ["project", "add", "./manifest-project", "--name", "smoke"], installDir, env);
  const projectInspect = JSON.parse(
    (await run(cliEntry, ["project", "inspect", "smoke", "--json"], installDir, env)).stdout
  ) as {
    project: {
      definitions: {
        workflows: Array<{ name: string }>;
      };
    };
  };

  if (!projectInspect.project.definitions.workflows.some((definition) => definition.name === "smokeWorkflow")) {
    throw new Error("Packaged CLI did not register the explicit vilano.manifest.json project contract");
  }

  const workflowList = JSON.parse(
    (await run(cliEntry, ["workflow", "list", "--project", "smoke", "--json"], installDir, env)).stdout
  ) as {
    definitions: Array<{ name: string }>;
  };

  if (!workflowList.definitions.some((definition) => definition.name === "smokeWorkflow")) {
    throw new Error("Packaged CLI did not load the explicit vilano.manifest.json project contract");
  }

  const runStarted = JSON.parse(
    (
      await run(
        cliEntry,
        ["run", "start", "smoke/smokeWorkflow", "--input", '{"value":"installed"}', "--json"],
        installDir,
        env
      )
    ).stdout
  ) as { run: { id: string } };

  const completedRun = await waitForRunCompletion(cliEntry, installDir, env, runStarted.run.id);
  if (completedRun.run.status !== "completed") {
    throw new Error(`Packaged CLI did not complete smoke workflow: ${completedRun.run.status}`);
  }

  if ((completedRun.run.output as { value?: string } | null)?.value !== "installed") {
    throw new Error(
      `Packaged CLI returned unexpected smoke workflow output: ${JSON.stringify(completedRun.run.output)}`
    );
  }

  await run(cliEntry, ["daemon", "stop"], installDir, env);
  const packagedBundleHashAfter = await hashDirectoryContents(packagedRuntimeDist);
  if (packagedBundleHashBefore !== packagedBundleHashAfter) {
    throw new Error("Packaged runtime-dist contents changed during install smoke run");
  }

  process.stdout.write(
    `${JSON.stringify({ ok: true, installDir, cliVersion: version.cliVersion, protocolVersion: version.protocolVersion }, null, 2)}\n`
  );
} finally {
  await makeTreeWritable(installDir).catch(() => undefined);
  await makeTreeWritable(deriveExecutionHomeDir(runtimeHome)).catch(() => undefined);
  await fs.rm(deriveExecutionHomeDir(runtimeHome), { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(installDir, { recursive: true, force: true });
  await cleanupTarball(cliTarball);
  await cleanupTarball(sdkTarball);
}

async function packWorkspace(workspaceDir: string): Promise<string> {
  const existingTarballs = (await fs.readdir(workspaceDir)).filter((entry) => entry.endsWith(".tgz"));
  await Promise.all(existingTarballs.map((entry) => fs.rm(path.join(workspaceDir, entry), { force: true })));
  await run("bun", ["pm", "pack"], workspaceDir);
  const after = (await fs.readdir(workspaceDir)).filter((entry) => entry.endsWith(".tgz"));
  const created = after[0];

  if (!created) {
    throw new Error(`Failed to locate tarball after packing ${workspaceDir}`);
  }

  return path.join(workspaceDir, created);
}

async function cleanupTarball(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { force: true });
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

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function hashDirectoryContents(rootPath: string): Promise<string> {
  const crypto = await import("node:crypto");
  const digest = crypto.createHash("sha256");
  const files = await collectFiles(rootPath);

  for (const filePath of files) {
    const relativePath = path.relative(rootPath, filePath);
    digest.update(relativePath);
    digest.update("\0");
    digest.update(await fs.readFile(filePath));
    digest.update("\0");
  }

  return digest.digest("hex");
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

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve port")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function startDaemonWithRetry(
  cliEntry: string,
  installDir: string,
  runtimeHome: string,
  expectedProtocolVersion: number
): Promise<{
  env: NodeJS.ProcessEnv;
  status: {
    runtimeVersion: string;
    protocolVersion: number;
  };
}> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await reservePort();
    const env = {
      ...process.env,
      VILANO_HOME: runtimeHome,
      VILANO_KERNEL_PORT: String(port),
    };

    try {
      await run(cliEntry, ["daemon", "start", "--port", String(port)], installDir, env, {
        timeoutMs: 120_000,
      });

      const status = JSON.parse(
        (await run(cliEntry, ["daemon", "status", "--json"], installDir, env)).stdout
      ) as {
        runtimeVersion: string;
        protocolVersion: number;
      };

      if (status.protocolVersion !== expectedProtocolVersion) {
        throw new Error(
          `Packaged CLI started a kernel with protocol ${status.protocolVersion}, expected ${expectedProtocolVersion}`
        );
      }

      return { env, status };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(
    `Packaged CLI failed to start the daemon after multiple attempts:\n${lastError?.message ?? "unknown error"}`
  );
}

async function waitForRunCompletion(
  cliEntry: string,
  installDir: string,
  env: NodeJS.ProcessEnv,
  runId: string
): Promise<{ run: { status: string; output: unknown } }> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const body = JSON.parse(
      (await run(cliEntry, ["run", "inspect", runId, "--json"], installDir, env)).stdout
    ) as { run: { status: string; output: unknown } };

    if (body.run.status === "completed" || body.run.status === "failed" || body.run.status === "cancelled") {
      return body;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for packaged workflow run ${runId}`);
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { allowFailure?: boolean; timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "pipe",
  });

  const timeout = options.timeoutMs
    ? setTimeout(() => {
        child.kill("SIGKILL");
      }, options.timeoutMs)
    : null;

  const [stdout, stderr, exitCode] = await Promise.all([
    streamToString(child.stdout),
    streamToString(child.stderr),
    new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 0));
    }),
  ]);

  if (timeout) {
    clearTimeout(timeout);
  }

  if (!options.allowFailure && exitCode !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        stdout ? `stdout:\n${stdout}` : "",
        stderr ? `stderr:\n${stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return { stdout, stderr, exitCode };
}

async function streamToString(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) {
    return "";
  }

  let data = "";
  for await (const chunk of stream) {
    data += chunk.toString();
  }
  return data;
}
