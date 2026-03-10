import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";

import { deriveExecutionHomeDir } from "../cli/src/runtime-home.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI_DIR = path.join(ROOT, "cli");
const SDK_DIR = path.join(ROOT, "sdk", "typescript");

await run("bun", ["run", "prepare:cli-package"], ROOT);

const cliTarball = await packWorkspace(CLI_DIR);
const sdkTarball = await packWorkspace(SDK_DIR);
const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-install-smoke-"));
const installRoot = path.join(installDir, ".vilano");
const runtimeHome = path.join(installRoot, "state");
let updateArtifact: { path: string; sha256: string; tempDir: string } | null = null;

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
  const incompatibleReleaseMetadataPath = path.join(installDir, "release-incompatible.json");
  const baseEnv = {
    ...process.env,
    VILANO_HOME: runtimeHome,
    VILANO_INSTALL_ROOT: installRoot,
  };
  const packagedBundleHashBefore = await hashDirectoryContents(packagedRuntimeDist);
  updateArtifact = await buildUpdateArtifact(installDir, "0.1.1");

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
                url: new URL(`file://${updateArtifact.path}`).toString(),
                sha256: updateArtifact.sha256,
              },
            },
          },
        },
      },
      null,
      2
    )}\n`
  );

  await fs.writeFile(
    incompatibleReleaseMetadataPath,
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
            schemaMin: (version.runtimeBundle.installManifest?.schemaVersion ?? 0) + 1,
            schemaMax: (version.runtimeBundle.installManifest?.schemaVersion ?? 0) + 1,
            supportedWorkerRuntimes: ["bun"],
            releasedAt: "2026-03-10T12:00:00.000Z",
            artifacts: {
              [`${process.platform}-${process.arch}`]: {
                url: new URL(`file://${updateArtifact.path}`).toString(),
                sha256: updateArtifact.sha256,
              },
            },
          },
        },
      },
      null,
      2
    )}\n`
  );

  await seedRuntimeSchemaVersion(
    path.join(runtimeHome, "runtime.sqlite"),
    version.runtimeBundle.installManifest?.schemaVersion ?? 0
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

  const incompatibleUpdate = await run(
    cliEntry,
    ["update", "--release-manifest", incompatibleReleaseMetadataPath, "--json"],
    installDir,
    baseEnv,
    { allowFailure: true, timeoutMs: 60_000 }
  );

  if (
    incompatibleUpdate.exitCode === 0 ||
    !/schema/i.test(`${incompatibleUpdate.stdout}\n${incompatibleUpdate.stderr}`)
  ) {
    throw new Error(
      `Packaged CLI update should fail for incompatible schema metadata:\nstdout:\n${incompatibleUpdate.stdout}\nstderr:\n${incompatibleUpdate.stderr}`
    );
  }

  await fs.rm(path.join(runtimeHome, "runtime.sqlite"), { force: true });

  const updateApply = JSON.parse(
    (
      await run(
        cliEntry,
        ["update", "--release-manifest", releaseMetadataPath, "--json"],
        installDir,
        baseEnv,
        { timeoutMs: 240_000 }
      )
    ).stdout
  ) as {
    currentVersion: string;
    installedVersion: string;
  };

  if (updateApply.currentVersion !== "0.1.1" || updateApply.installedVersion !== "0.1.1") {
    throw new Error(
      `Packaged CLI update did not install the expected version:\n${JSON.stringify(updateApply, null, 2)}`
    );
  }

  const managedCliEntry = path.join(installRoot, "bin", "vilano");
  if (!(await exists(managedCliEntry))) {
    throw new Error("Packaged CLI update did not create the managed launcher under the install root");
  }

  const managedVersion = JSON.parse(
    (await run(managedCliEntry, ["version", "--json"], installDir, baseEnv)).stdout
  ) as {
    runtimeBundle: {
      installManifest: {
        runtimeVersion: string;
      } | null;
    };
  };

  if (managedVersion.runtimeBundle.installManifest?.runtimeVersion !== "0.1.1") {
    throw new Error(
      `Managed Vilano launcher did not switch to the updated runtime:\n${JSON.stringify(managedVersion, null, 2)}`
    );
  }

  const rollback = JSON.parse(
    (await run(managedCliEntry, ["rollback", "--json"], installDir, baseEnv)).stdout
  ) as {
    rolledBackTo: string;
  };

  if (rollback.rolledBackTo !== "0.1.0") {
    throw new Error(
      `Managed Vilano rollback did not return to the previous runtime:\n${JSON.stringify(rollback, null, 2)}`
    );
  }

  const rolledBackVersion = JSON.parse(
    (await run(managedCliEntry, ["version", "--json"], installDir, baseEnv)).stdout
  ) as {
    runtimeBundle: {
      installManifest: {
        runtimeVersion: string;
      } | null;
    };
  };

  if (rolledBackVersion.runtimeBundle.installManifest?.runtimeVersion !== "0.1.0") {
    throw new Error(
      `Managed Vilano launcher did not return to the rolled back runtime:\n${JSON.stringify(rolledBackVersion, null, 2)}`
    );
  }

  const doctor = JSON.parse(
    (
      await run(
        managedCliEntry,
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
        managedCliEntry,
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

  const { env, status } = await startDaemonWithRetry(managedCliEntry, installDir, runtimeHome, version.protocolVersion);

  if (status.protocolVersion !== version.protocolVersion) {
    throw new Error("Packaged CLI started a kernel with a mismatched protocol version");
  }

  const initManifest = JSON.parse(
    (await run(managedCliEntry, ["init", "./manifest-project", "--json"], installDir, env)).stdout
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

  await run(managedCliEntry, ["project", "add", "./manifest-project", "--name", "smoke"], installDir, env);
  const projectInspect = JSON.parse(
    (await run(managedCliEntry, ["project", "inspect", "smoke", "--json"], installDir, env)).stdout
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
    (await run(managedCliEntry, ["workflow", "list", "--project", "smoke", "--json"], installDir, env)).stdout
  ) as {
    definitions: Array<{ name: string }>;
  };

  if (!workflowList.definitions.some((definition) => definition.name === "smokeWorkflow")) {
    throw new Error("Packaged CLI did not load the explicit vilano.manifest.json project contract");
  }

  const runStarted = JSON.parse(
    (
      await run(
        managedCliEntry,
        ["run", "start", "smoke/smokeWorkflow", "--input", '{"value":"installed"}', "--json"],
        installDir,
        env
      )
    ).stdout
  ) as { run: { id: string } };

  const completedRun = await waitForRunCompletion(managedCliEntry, installDir, env, runStarted.run.id);
  if (completedRun.run.status !== "completed") {
    throw new Error(`Packaged CLI did not complete smoke workflow: ${completedRun.run.status}`);
  }

  if ((completedRun.run.output as { value?: string } | null)?.value !== "installed") {
    throw new Error(
      `Packaged CLI returned unexpected smoke workflow output: ${JSON.stringify(completedRun.run.output)}`
    );
  }

  const blockedUpdate = await run(
    managedCliEntry,
    ["update", "--release-manifest", releaseMetadataPath, "--json"],
    installDir,
    env,
    { allowFailure: true, timeoutMs: 60_000 }
  );

  if (blockedUpdate.exitCode === 0 || !/stop.*daemon/i.test(`${blockedUpdate.stdout}\n${blockedUpdate.stderr}`)) {
    throw new Error(
      `Managed Vilano update should refuse to run while the daemon is active:\nstdout:\n${blockedUpdate.stdout}\nstderr:\n${blockedUpdate.stderr}`
    );
  }

  const blockedRollback = await run(
    managedCliEntry,
    ["rollback", "--json"],
    installDir,
    env,
    { allowFailure: true, timeoutMs: 60_000 }
  );

  if (
    blockedRollback.exitCode === 0 ||
    !/stop.*daemon/i.test(`${blockedRollback.stdout}\n${blockedRollback.stderr}`)
  ) {
    throw new Error(
      `Managed Vilano rollback should refuse to run while the daemon is active:\nstdout:\n${blockedRollback.stdout}\nstderr:\n${blockedRollback.stderr}`
    );
  }

  await run(managedCliEntry, ["daemon", "stop"], installDir, env);
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
  if (updateArtifact) {
    await cleanupTarball(updateArtifact.path).catch(() => undefined);
    await fs.rm(updateArtifact.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
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

async function buildUpdateArtifact(
  installDir: string,
  targetVersion: string
): Promise<{ path: string; sha256: string; tempDir: string }> {
  const sourceCliRoot = path.join(installDir, "node_modules", "vilano");
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-update-artifact-"));
  const artifactRoot = path.join(stagingRoot, `vilano-${targetVersion}`);
  const archivePath = path.join(stagingRoot, `vilano-${targetVersion}.tar.gz`);

  await fs.cp(sourceCliRoot, artifactRoot, {
    recursive: true,
    force: true,
  });
  await copyDependencyTree(sourceCliRoot, artifactRoot);
  await fs.mkdir(path.join(artifactRoot, "bun"), { recursive: true });
  await fs.copyFile(process.execPath, path.join(artifactRoot, "bun", "bun"));
  await fs.chmod(path.join(artifactRoot, "bun", "bun"), 0o755);

  const packageJsonPath = path.join(artifactRoot, "package.json");
  const runtimeInstallManifestPath = path.join(artifactRoot, "runtime-dist", "install-manifest.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
    version?: string;
  };
  packageJson.version = targetVersion;
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const installManifest = JSON.parse(await fs.readFile(runtimeInstallManifestPath, "utf8")) as {
    cliVersion?: string;
    runtimeVersion?: string;
    bundleVersion?: string;
  };
  installManifest.cliVersion = targetVersion;
  installManifest.runtimeVersion = targetVersion;
  if (typeof installManifest.bundleVersion === "string") {
    installManifest.bundleVersion = installManifest.bundleVersion.replace("0.1.0", targetVersion);
  }
  await fs.writeFile(runtimeInstallManifestPath, `${JSON.stringify(installManifest, null, 2)}\n`);

  await run("tar", ["-czf", archivePath, "-C", stagingRoot, path.basename(artifactRoot)], installDir);
  const sha256 = await hashFileSha256(archivePath);
  return { path: archivePath, sha256, tempDir: stagingRoot };
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

async function copyDependencyTree(sourceRoot: string, targetRoot: string): Promise<void> {
  const packageJson = JSON.parse(await fs.readFile(path.join(sourceRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const queue = Object.keys(packageJson.dependencies ?? {}).map((dependency) => ({
    name: dependency,
    resolveFrom: sourceRoot,
  }));
  const seen = new Set<string>();

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next.name)) {
      continue;
    }

    const resolved = await resolveDependencyInstallPath(next.resolveFrom, next.name);
    if (!resolved) {
      continue;
    }

    seen.add(next.name);
    const sourcePath = await fs.realpath(resolved);
    const dependencyTarget = path.join(targetRoot, "node_modules", next.name);
    await fs.mkdir(path.dirname(dependencyTarget), { recursive: true });
    await fs.cp(sourcePath, dependencyTarget, {
      recursive: true,
      force: true,
    });

    const nestedPackageJson = JSON.parse(
      await fs.readFile(path.join(sourcePath, "package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    queue.push(
      ...Object.keys(nestedPackageJson.dependencies ?? {}).map((dependency) => ({
        name: dependency,
        resolveFrom: sourcePath,
      }))
    );
  }
}

async function resolveDependencyInstallPath(startDir: string, dependency: string): Promise<string | null> {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, "node_modules", dependency);
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      return null;
    }

    currentDir = parent;
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

async function seedRuntimeSchemaVersion(databasePath: string, schemaVersion: number): Promise<void> {
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  await fs.rm(databasePath, { force: true });

  const database = new Database(databasePath);
  try {
    database.exec(`
      create table runtime_metadata (
        runtime_version text not null,
        protocol_version integer not null,
        schema_version integer not null,
        applied_migrations_json text not null,
        updated_at text not null
      );
    `);

    database
      .query(
        `
          insert into runtime_metadata (
            runtime_version,
            protocol_version,
            schema_version,
            applied_migrations_json,
            updated_at
          ) values (?, ?, ?, ?, ?)
        `
      )
      .run("0.1.0", 1, schemaVersion, "[]", new Date().toISOString());
  } finally {
    database.close(false);
  }
}

async function hashFileSha256(filePath: string): Promise<string> {
  const digest = crypto.createHash("sha256");
  digest.update(await fs.readFile(filePath));
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
