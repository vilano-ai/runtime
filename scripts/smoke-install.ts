import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI_DIR = path.join(ROOT, "cli");

await run("bun", ["run", "prepare:cli-package"], ROOT);

const cliTarball = await packWorkspace(CLI_DIR);
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

  await run("bun", ["add", cliTarball], installDir);

  const cliEntry = path.join(installDir, "node_modules", "vilano", "bin", "vilano.ts");
  const baseEnv = {
    ...process.env,
    VILANO_HOME: runtimeHome,
  };

  const manifestProjectDir = path.join(installDir, "manifest-project");
  await fs.mkdir(path.join(manifestProjectDir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(manifestProjectDir, "vilano.manifest.json"),
    `${JSON.stringify(
      {
        manifestVersion: 1,
        definitions: {
          workflows: [
            {
              kind: "workflow",
              name: "smokeWorkflow",
              exportName: "smokeWorkflow",
              file: "src/definitions.ts",
              runtimeKind: "javascript",
              sourceLanguage: "typescript",
            },
          ],
          services: [],
        },
      },
      null,
      2
    )}\n`
  );

  const version = JSON.parse((await run("bun", [cliEntry, "version", "--json"], installDir, baseEnv)).stdout) as {
    cliVersion: string;
    protocolVersion: number;
    runtimeBundle: {
      root: string;
      sourceRoot: string;
      bundled: boolean;
      materialized: boolean;
      bundleVersion: string;
    };
  };

  if (!version.runtimeBundle.bundled) {
    throw new Error("Packaged CLI did not resolve a bundled runtime-dist");
  }

  if (!version.runtimeBundle.materialized) {
    throw new Error("Packaged CLI did not materialize the runtime bundle under VILANO_HOME");
  }

  if (!version.runtimeBundle.root.startsWith(runtimeHome)) {
    throw new Error(`Materialized runtime root was not created under VILANO_HOME: ${version.runtimeBundle.root}`);
  }

  const doctor = JSON.parse(
    (
      await run(
        "bun",
        [cliEntry, "doctor", "--fix", "--json"],
        installDir,
        baseEnv,
        { allowFailure: true, timeoutMs: 240_000 }
      )
    ).stdout
  ) as { ok: boolean };

  if (!doctor.ok) {
    throw new Error(
      `Packaged CLI doctor --fix did not produce a healthy install:\n${JSON.stringify(doctor, null, 2)}`
    );
  }

  const { env, status } = await startDaemonWithRetry(cliEntry, installDir, runtimeHome, version.protocolVersion);

  if (status.protocolVersion !== version.protocolVersion) {
    throw new Error("Packaged CLI started a kernel with a mismatched protocol version");
  }

  await run("bun", [cliEntry, "project", "add", "./manifest-project", "--name", "smoke"], installDir, env);
  const projectInspect = JSON.parse(
    (await run("bun", [cliEntry, "project", "inspect", "smoke", "--json"], installDir, env)).stdout
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
    (await run("bun", [cliEntry, "workflow", "list", "--project", "smoke", "--json"], installDir, env)).stdout
  ) as {
    definitions: Array<{ name: string }>;
  };

  if (!workflowList.definitions.some((definition) => definition.name === "smokeWorkflow")) {
    throw new Error("Packaged CLI did not load the explicit vilano.manifest.json project contract");
  }

  await run("bun", [cliEntry, "daemon", "stop"], installDir, env);

  const packagedKernelDeps = path.join(installDir, "node_modules", "vilano", "runtime-dist", "kernel", "deps");
  const packagedKernelBuild = path.join(installDir, "node_modules", "vilano", "runtime-dist", "kernel", "_build");

  if (await exists(packagedKernelDeps) || (await exists(packagedKernelBuild))) {
    throw new Error("Packaged runtime-dist was mutated during install smoke run");
  }

  process.stdout.write(
    `${JSON.stringify({ ok: true, installDir, cliVersion: version.cliVersion, protocolVersion: version.protocolVersion }, null, 2)}\n`
  );
} finally {
  await fs.rm(installDir, { recursive: true, force: true });
  await cleanupTarball(cliTarball);
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
      await run("bun", [cliEntry, "daemon", "start", "--port", String(port)], installDir, env, {
        timeoutMs: 120_000,
      });

      const status = JSON.parse(
        (await run("bun", [cliEntry, "daemon", "status", "--json"], installDir, env)).stdout
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
