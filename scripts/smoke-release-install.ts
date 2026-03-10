import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const SDK_DIR = path.join(ROOT, "sdk", "typescript");
const RELEASE_DIR = path.join(ROOT, "dist", "release");

const installScriptPath = path.join(RELEASE_DIR, "install.sh");
const releaseMetadataPath = path.join(RELEASE_DIR, "release.json");
const installRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-release-install-"));
const projectDir = path.join(installRoot, "demo-project");
const sdkTarball = await packWorkspace(SDK_DIR);

try {
  const baseEnv = { ...process.env };
  const firstInstall = await run("bash", [installScriptPath], ROOT, {
    ...process.env,
    VILANO_INSTALL_ROOT: installRoot,
  });

  const expectedInstallCommand = `${path.join(installRoot, "bin", "vilano")} version`;
  if (!firstInstall.stdout.includes(expectedInstallCommand)) {
    throw new Error(`Release installer did not print the managed launcher verification command:\n${firstInstall.stdout}`);
  }

  if (!firstInstall.stdout.includes(`export PATH="${path.join(installRoot, "bin")}:$PATH"`)) {
    throw new Error(`Release installer did not print PATH guidance for the managed launcher:\n${firstInstall.stdout}`);
  }

  await run("bash", [installScriptPath], ROOT, {
    ...process.env,
    VILANO_INSTALL_ROOT: installRoot,
  });

  const installedCli = path.join(installRoot, "bin", "vilano");
  const installState = JSON.parse(
    await fs.readFile(path.join(installRoot, "install-state.json"), "utf8")
  ) as {
    currentVersion: string | null;
    previousVersion: string | null;
  };

  if (!installState.currentVersion) {
    throw new Error("Release installer did not record the current installed version");
  }

  if (installState.previousVersion !== installState.currentVersion) {
    throw new Error(
      `Reinstall should record the previous version consistently, got current=${installState.currentVersion} previous=${installState.previousVersion}`
    );
  }

  const version = JSON.parse((await run(installedCli, ["version", "--json"], ROOT)).stdout) as {
    runtimeBundle: {
      installManifest: {
        runtimeVersion: string;
      } | null;
    };
  };

  if (version.runtimeBundle.installManifest?.runtimeVersion !== installState.currentVersion) {
    throw new Error(
      `Installed Vilano version mismatch: expected ${installState.currentVersion}, got ${version.runtimeBundle.installManifest?.runtimeVersion ?? "null"}`
    );
  }

  const updateCheck = JSON.parse(
    (
      await run(
        installedCli,
        ["update", "--check", "--release-manifest", releaseMetadataPath, "--json"],
        ROOT
      )
    ).stdout
  ) as { updateAvailable: boolean };

  if (updateCheck.updateAvailable) {
    throw new Error("Fresh release install unexpectedly reported an available update");
  }

  const doctor = JSON.parse((await run(installedCli, ["doctor", "--json"], ROOT)).stdout) as { ok: boolean };
  if (!doctor.ok) {
    throw new Error(`Release install doctor check did not report a healthy runtime:\n${JSON.stringify(doctor, null, 2)}`);
  }

  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "package.json"),
    `${JSON.stringify({ name: "vilano-release-install-smoke", private: true }, null, 2)}\n`
  );
  await run("bun", ["add", sdkTarball], projectDir);

  await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "src", "definitions.ts"),
    [
      "import { workflow } from '@vilano/runtime';",
      "",
      "export const smokeWorkflow = workflow({",
      "  name: 'smokeWorkflow',",
      "  run: async (input) => ({ ok: true, value: input?.value ?? 'smoke' }),",
      "});",
      "",
    ].join("\n"),
    "utf8"
  );

  await run(installedCli, ["init", ".", "--json"], projectDir);

  const daemonPort = await reservePort();
  await run(installedCli, ["daemon", "start", "--port", String(daemonPort)], projectDir, {
    ...baseEnv,
    VILANO_KERNEL_PORT: String(daemonPort),
  });

  const workerWithoutHostBun = await run(
    installedCli,
    ["worker", "start", "--runtime", "bun", "--once"],
    projectDir,
    {
      ...baseEnv,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      VILANO_KERNEL_PORT: String(daemonPort),
    }
  );
  if (workerWithoutHostBun.exitCode !== 0) {
    throw new Error(
      `Packaged bun worker did not start from the bundled runtime:\nstdout:\n${workerWithoutHostBun.stdout}\nstderr:\n${workerWithoutHostBun.stderr}`
    );
  }

  const previewNodeWorker = await run(
    installedCli,
    ["worker", "start", "--runtime", "node", "--once"],
    projectDir,
    {
      ...baseEnv,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      VILANO_KERNEL_PORT: String(daemonPort),
    },
    { allowFailure: true }
  );
  if (
    previewNodeWorker.exitCode === 0 ||
    !/does not bundle the preview Node worker|missing bundled node/i.test(
      `${previewNodeWorker.stdout}\n${previewNodeWorker.stderr}`
    )
  ) {
    throw new Error(
      `Packaged node worker path should fail with an explicit bundled-runtime message:\nstdout:\n${previewNodeWorker.stdout}\nstderr:\n${previewNodeWorker.stderr}`
    );
  }

  await run(installedCli, ["project", "add", ".", "--name", "smoke"], projectDir);
  const started = JSON.parse(
    (
      await run(
        installedCli,
        ["run", "start", "smoke/smokeWorkflow", "--input", '{"value":"release-install"}', "--json"],
        projectDir,
        {
          ...process.env,
          VILANO_KERNEL_PORT: String(daemonPort),
        }
      )
    ).stdout
  ) as { run: { id: string } };

  const completed = await waitForRunCompletion(
    installedCli,
    projectDir,
    started.run.id,
    daemonPort
  );
  if (completed.run.status !== "completed") {
    throw new Error(`Release install smoke run did not complete: ${completed.run.status}`);
  }

  if ((completed.run.output as { value?: string } | null)?.value !== "release-install") {
    throw new Error(
      `Release install smoke run returned unexpected output: ${JSON.stringify(completed.run.output)}`
    );
  }

  const replay = JSON.parse(
    (
      await run(installedCli, ["run", "replay", started.run.id, "--json"], projectDir, {
        ...baseEnv,
        VILANO_KERNEL_PORT: String(daemonPort),
      })
    ).stdout
  ) as { timeline: unknown[] };
  if (!Array.isArray(replay.timeline) || replay.timeline.length === 0) {
    throw new Error(`Release install smoke replay did not return a durable timeline:\n${JSON.stringify(replay, null, 2)}`);
  }

  await run(installedCli, ["daemon", "stop"], projectDir, {
    ...baseEnv,
    VILANO_KERNEL_PORT: String(daemonPort),
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        installRoot,
        version: installState.currentVersion,
      },
      null,
      2
    )}\n`
  );
} finally {
  await makeTreeWritable(installRoot).catch(() => undefined);
  await fs.rm(installRoot, { recursive: true, force: true }).catch(() => undefined);
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
  await fs.rm(targetPath, { force: true }).catch(() => undefined);
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

async function waitForRunCompletion(
  cliPath: string,
  cwd: string,
  runId: string,
  daemonPort: number
): Promise<{ run: { status: string; output: unknown } }> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const body = JSON.parse(
      (
        await run(cliPath, ["run", "inspect", runId, "--json"], cwd, {
          ...process.env,
          VILANO_KERNEL_PORT: String(daemonPort),
        })
      ).stdout
    ) as { run: { status: string; output: unknown } };

    if (body.run.status === "completed" || body.run.status === "failed" || body.run.status === "cancelled") {
      return body;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for release-install smoke run ${runId}`);
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
