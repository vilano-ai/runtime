import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { expect, test } from "bun:test";

import { main } from "../cli/src/index.ts";
import type { ReleaseMetadataManifest } from "../cli/src/distribution-contract.ts";
import { renderInstallScript } from "../scripts/release-installer.ts";
import { verifyReleasePublication } from "../scripts/release-verification.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

test("vilano update --check reports newer stable releases from release metadata", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-update-check-"));
  const manifestPath = path.join(tempDir, "release.json");
  const originalWrite = process.stdout.write.bind(process.stdout);
  const writes: string[] = [];

  try {
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          manifestVersion: 1,
          latest: "0.1.1",
          channels: {
            stable: "0.1.1",
            preview: "0.2.0-beta.1",
          },
          releases: {
            "0.1.1": {
              version: "0.1.1",
              channel: "stable",
              protocolVersion: 1,
              schemaMin: 12,
              schemaMax: 12,
              supportedWorkerRuntimes: ["bun"],
              releasedAt: "2026-03-10T12:00:00.000Z",
              artifacts: {
                [`${process.platform}-${process.arch}`]: {
                  url: "https://example.com/vilano-v0.1.1.tar.gz",
                  sha256: "abc123",
                  compatibility: {
                    platformKey: `${process.platform}-${process.arch}`,
                    os: process.platform,
                    arch: process.arch,
                  },
                },
              },
            },
            "0.2.0-beta.1": {
              version: "0.2.0-beta.1",
              channel: "preview",
              protocolVersion: 1,
              schemaMin: 12,
              schemaMax: 12,
              supportedWorkerRuntimes: ["bun", "node"],
              releasedAt: "2026-03-11T12:00:00.000Z",
              artifacts: {},
            },
          },
        },
        null,
        2
      )}\n`
    );

    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    const exitCode = await main([
      "update",
      "--check",
      "--release-manifest",
      manifestPath,
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const body = JSON.parse(writes.join("")) as {
      mode: string;
      channel: string;
      current: { version: string };
      latest: { version: string; artifact: { url: string } | null };
      updateAvailable: boolean;
      platform: { supported: boolean };
    };

    expect(body.mode).toBe("check");
    expect(body.channel).toBe("stable");
    expect(body.current.version).toBe("0.1.0");
    expect(body.latest.version).toBe("0.1.1");
    expect(body.latest.artifact?.url).toBe("https://example.com/vilano-v0.1.1.tar.gz");
    expect(body.platform.supported).toBe(true);
    expect(body.updateAvailable).toBe(true);
  } finally {
    process.stdout.write = originalWrite as typeof process.stdout.write;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("release installer defaults to stable and allows preview override", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-release-installer-"));
  const installScriptPath = path.join(tempDir, "install.sh");
  const stableInstallRoot = path.join(tempDir, "stable-install");
  const previewInstallRoot = path.join(tempDir, "preview-install");

  try {
    const stableArtifact = await buildInstallerArtifact(tempDir, "0.1.1");
    const previewArtifact = await buildInstallerArtifact(tempDir, "0.2.0-beta.1");
    const manifest: ReleaseMetadataManifest = {
      manifestVersion: 1,
      latest: "0.2.0-beta.1",
      channels: {
        stable: "0.1.1",
        preview: "0.2.0-beta.1",
      },
      releases: {
        "0.1.1": {
          version: "0.1.1",
          channel: "stable" as const,
          protocolVersion: 1,
          schemaMin: 1,
          schemaMax: 1,
          supportedWorkerRuntimes: ["bun"],
          releasedAt: "2026-03-10T12:00:00.000Z",
          artifacts: {
            [`${process.platform}-${process.arch}`]: {
              url: pathToFileURL(stableArtifact.artifactPath).toString(),
              sha256: stableArtifact.sha256,
              compatibility: {
                platformKey: `${process.platform}-${process.arch}`,
                os: process.platform,
                arch: process.arch,
              },
            },
          },
        },
        "0.2.0-beta.1": {
          version: "0.2.0-beta.1",
          channel: "preview" as const,
          protocolVersion: 1,
          schemaMin: 1,
          schemaMax: 1,
          supportedWorkerRuntimes: ["bun"],
          releasedAt: "2026-03-11T12:00:00.000Z",
          artifacts: {
            [`${process.platform}-${process.arch}`]: {
              url: pathToFileURL(previewArtifact.artifactPath).toString(),
              sha256: previewArtifact.sha256,
              compatibility: {
                platformKey: `${process.platform}-${process.arch}`,
                os: process.platform,
                arch: process.arch,
              },
            },
          },
        },
      },
    };

    await fs.writeFile(installScriptPath, renderInstallScript(manifest), "utf8");
    await fs.chmod(installScriptPath, 0o755);

    const stableInstall = await run(
      "bash",
      [installScriptPath],
      tempDir,
      {
        ...process.env,
        VILANO_INSTALL_ROOT: stableInstallRoot,
      }
    );
    const stableState = JSON.parse(
      await fs.readFile(path.join(stableInstallRoot, "install-state.json"), "utf8")
    ) as { currentVersion: string | null; channel: string };

    expect(stableState.currentVersion).toBe("0.1.1");
    expect(stableState.channel).toBe("stable");
    expect(stableInstall.stdout).toContain(`${path.join(stableInstallRoot, "bin", "vilano")} version`);
    expect(stableInstall.stdout).toContain(`export PATH="${path.join(stableInstallRoot, "bin")}:$PATH"`);

    await run(
      "bash",
      [installScriptPath],
      tempDir,
      {
        ...process.env,
        VILANO_INSTALL_ROOT: previewInstallRoot,
        VILANO_RELEASE_CHANNEL: "preview",
      }
    );
    const previewState = JSON.parse(
      await fs.readFile(path.join(previewInstallRoot, "install-state.json"), "utf8")
    ) as { currentVersion: string | null; channel: string };

    expect(previewState.currentVersion).toBe("0.2.0-beta.1");
    expect(previewState.channel).toBe("preview");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("release metadata merge and bundle verification cover the supported platform set", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-release-verify-"));
  const inputDir = path.join(tempDir, "input");
  const outputDir = path.join(tempDir, "output");
  const notesUrl = "https://github.com/vilano-ai/runtime/blob/v0.1.0/docs/release-notes/v0.1.0.md";
  const artifactUrlPrefix = "https://github.com/vilano-ai/runtime/releases/download/v0.1.0/";

  try {
    const darwinDir = path.join(inputDir, "darwin-arm64");
    const linuxDir = path.join(inputDir, "linux-x64");
    const darwinArtifactName = "vilano-v0.1.0-darwin-arm64.tar.gz";
    const linuxArtifactName = "vilano-v0.1.0-linux-x64.tar.gz";
    const darwinArtifactUrl = `${artifactUrlPrefix}${darwinArtifactName}`;
    const linuxArtifactUrl = `${artifactUrlPrefix}${linuxArtifactName}`;

    await fs.mkdir(darwinDir, { recursive: true });
    await fs.mkdir(linuxDir, { recursive: true });
    await fs.writeFile(path.join(darwinDir, darwinArtifactName), "darwin-artifact\n", "utf8");
    await fs.writeFile(path.join(linuxDir, linuxArtifactName), "linux-artifact\n", "utf8");
    await fs.writeFile(
      path.join(darwinDir, "SHA256SUMS"),
      `darwin-arm64-sha256  ${darwinArtifactName}\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(linuxDir, "SHA256SUMS"),
      `linux-x64-sha256  ${linuxArtifactName}\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(darwinDir, "release.json"),
      `${JSON.stringify(
        createReleaseManifest({
          platformKey: "darwin-arm64",
          artifactUrl: darwinArtifactUrl,
          notesUrl,
        }),
        null,
        2
      )}\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(linuxDir, "release.json"),
      `${JSON.stringify(
        createReleaseManifest({
          platformKey: "linux-x64",
          artifactUrl: linuxArtifactUrl,
          notesUrl,
        }),
        null,
        2
      )}\n`,
      "utf8"
    );

    await run(
      "bun",
      ["scripts/merge-release-artifacts.ts"],
      REPO_ROOT,
      {
        ...process.env,
        VILANO_RELEASE_INPUT_DIR: inputDir,
        VILANO_RELEASE_OUTPUT_DIR: outputDir,
      }
    );

    const merged = JSON.parse(
      await fs.readFile(path.join(outputDir, "release.json"), "utf8")
    ) as ReleaseMetadataManifest;
    expect(Object.keys(merged.releases["0.1.0"]?.artifacts ?? {}).sort()).toEqual([
      "darwin-arm64",
      "linux-x64",
    ]);
    expect(merged.releases["0.1.0"]?.notesUrl).toBe(notesUrl);
    expect(await fs.readFile(path.join(outputDir, darwinArtifactName), "utf8")).toBe("darwin-artifact\n");
    expect(await fs.readFile(path.join(outputDir, linuxArtifactName), "utf8")).toBe("linux-artifact\n");

    const result = await verifyReleasePublication({
      releaseManifestSource: path.join(outputDir, "release.json"),
      installerSource: path.join(outputDir, "install.sh"),
      channel: "stable",
      expectedVersion: "0.1.0",
      requiredPlatforms: ["darwin-arm64", "linux-x64"],
      expectedArtifactUrlPrefix: artifactUrlPrefix,
      expectedNotesUrl: notesUrl,
    });

    expect(result.releaseVersion).toBe("0.1.0");
    expect(result.platforms).toEqual(["darwin-arm64", "linux-x64"]);
    expect(result.notesUrl).toBe(notesUrl);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("release installer rejects artifacts missing bundled worker payload", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-release-installer-missing-worker-"));
  const installScriptPath = path.join(tempDir, "install.sh");
  const installRoot = path.join(tempDir, "install-root");

  try {
    const artifact = await buildInstallerArtifact(tempDir, "0.1.1", { includeWorkerPayload: false });
    const manifest: ReleaseMetadataManifest = {
      manifestVersion: 1,
      latest: "0.1.1",
      channels: {
        stable: "0.1.1",
      },
      releases: {
        "0.1.1": {
          version: "0.1.1",
          channel: "stable",
          protocolVersion: 1,
          schemaMin: 1,
          schemaMax: 1,
          supportedWorkerRuntimes: ["bun"],
          releasedAt: "2026-03-10T12:00:00.000Z",
          artifacts: {
            [`${process.platform}-${process.arch}`]: {
              url: pathToFileURL(artifact.artifactPath).toString(),
              sha256: artifact.sha256,
              compatibility: {
                platformKey: `${process.platform}-${process.arch}`,
                os: process.platform,
                arch: process.arch,
              },
            },
          },
        },
      },
    };

    await fs.writeFile(installScriptPath, renderInstallScript(manifest), "utf8");
    await fs.chmod(installScriptPath, 0o755);

    const install = await runRaw(
      "bash",
      [installScriptPath],
      tempDir,
      {
        ...process.env,
        VILANO_INSTALL_ROOT: installRoot,
      }
    );

    expect(install.exitCode).not.toBe(0);
    expect(`${install.stdout}\n${install.stderr}`).toContain("missing bundled Bun worker entrypoint");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("release verification rejects remote artifacts that are not reachable", async () => {
  const platformKey = `${process.platform}-${process.arch}`;
  const notesUrl = "https://example.com/releases/v0.1.0";
  const artifactPath = "/missing-artifact.tgz";
  let port = 0;

  const server = http.createServer((request, response) => {
    if (request.url === "/release.json") {
      const manifest = createReleaseManifest({
        platformKey,
        artifactUrl: `http://127.0.0.1:${port}${artifactPath}`,
        notesUrl,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify(manifest, null, 2)}\n`);
      return;
    }

    if (request.url === "/install.sh") {
      const manifest = createReleaseManifest({
        platformKey,
        artifactUrl: `http://127.0.0.1:${port}${artifactPath}`,
        notesUrl,
      });
      response.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8" });
      response.end(renderInstallScript(manifest));
      return;
    }

    response.writeHead(404);
    response.end("missing");
  });

  try {
    port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to determine test server port"));
          return;
        }

        resolve(address.port);
      });
      server.once("error", reject);
    });

    await expect(
      verifyReleasePublication({
        releaseManifestSource: `http://127.0.0.1:${port}/release.json`,
        installerSource: `http://127.0.0.1:${port}/install.sh`,
        channel: "stable",
        expectedVersion: "0.1.0",
        requiredPlatforms: [platformKey],
        expectedArtifactUrlPrefix: `http://127.0.0.1:${port}/`,
        expectedNotesUrl: notesUrl,
      })
    ).rejects.toThrow(`Release artifact for ${platformKey} is not reachable`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
});

function createReleaseManifest(input: {
  platformKey: string;
  artifactUrl: string;
  notesUrl: string;
}): ReleaseMetadataManifest {
  const [osName, arch] = input.platformKey.split("-");
  if (!osName || !arch) {
    throw new Error(`Invalid platform key in test: ${input.platformKey}`);
  }

  return {
    manifestVersion: 1,
    latest: "0.1.0",
    channels: {
      stable: "0.1.0",
    },
    releases: {
      "0.1.0": {
        version: "0.1.0",
        channel: "stable",
        protocolVersion: 1,
        schemaMin: 9,
        schemaMax: 9,
        supportedWorkerRuntimes: ["bun"],
        releasedAt: "2026-03-10T12:00:00.000Z",
        notesUrl: input.notesUrl,
        artifacts: {
          [input.platformKey]: {
            url: input.artifactUrl,
            sha256: `${input.platformKey}-sha256`,
            compatibility: {
              platformKey: input.platformKey,
              os: osName as NodeJS.Platform,
              arch,
            },
          },
        },
      },
    },
  };
}

async function buildInstallerArtifact(
  rootDir: string,
  version: string,
  options: { includeWorkerPayload?: boolean } = {}
): Promise<{ artifactPath: string; sha256: string }> {
  const stagingDir = await fs.mkdtemp(path.join(rootDir, `vilano-artifact-${version}-`));
  const platformKey = `${process.platform}-${process.arch}`;
  const artifactRootName = `vilano-v${version}-${platformKey}`;
  const artifactRoot = path.join(stagingDir, artifactRootName);
  const artifactPath = path.join(rootDir, `${artifactRootName}.tar.gz`);
  const manifest = {
    manifestVersion: 1,
    kind: "runtime-install",
    cliVersion: version,
    runtimeVersion: version,
    protocolVersion: 1,
    schemaVersion: 1,
    schemaMin: 1,
    schemaMax: 1,
    bundleVersion: `cli-${version}-runtime-${version}-protocol-1`,
    bundleContentHash: "test-bundle",
    supportedWorkerRuntimes: ["bun"],
    platform: {
      os: process.platform,
      arch: process.arch,
    },
    compatibility: {
      platformKey,
      os: process.platform,
      arch: process.arch,
    },
    build: {
      source: "test",
      osRelease: "test",
    },
    generatedAt: "2026-03-10T12:00:00.000Z",
  };

  try {
    await fs.mkdir(path.join(artifactRoot, "bun"), { recursive: true });
    await fs.mkdir(path.join(artifactRoot, "bin"), { recursive: true });
    await fs.mkdir(path.join(artifactRoot, "runtime-dist", "kernel-release", "bin"), { recursive: true });
    await fs.copyFile(process.execPath, path.join(artifactRoot, "bun", "bun"));
    await fs.chmod(path.join(artifactRoot, "bun", "bun"), 0o755);
    await fs.writeFile(path.join(artifactRoot, "bin", "vilano.ts"), "console.log('stub');\n", "utf8");
    await fs.writeFile(
      path.join(artifactRoot, "runtime-dist", "kernel-release", "bin", "vilano_kernel"),
      "#!/usr/bin/env bash\nexit 0\n",
      "utf8"
    );
    await fs.chmod(path.join(artifactRoot, "runtime-dist", "kernel-release", "bin", "vilano_kernel"), 0o755);
    await fs.writeFile(path.join(artifactRoot, "install-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.writeFile(
      path.join(artifactRoot, "runtime-dist", "install-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    if (options.includeWorkerPayload !== false) {
      await fs.mkdir(path.join(artifactRoot, "runtime-dist", "worker", "bun", "src"), {
        recursive: true,
      });
      await fs.mkdir(path.join(artifactRoot, "runtime-dist", "worker", "shared", "src"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(artifactRoot, "runtime-dist", "worker", "bun", "src", "cli.ts"),
        "export {};\n",
        "utf8"
      );
      await fs.writeFile(
        path.join(artifactRoot, "runtime-dist", "worker", "shared", "src", "core.ts"),
        "export {};\n",
        "utf8"
      );
    }

    await run("tar", ["-czf", artifactPath, "-C", stagingDir, artifactRootName], rootDir);
    return {
      artifactPath,
      sha256: await hashFileSha256(artifactPath),
    };
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

async function hashFileSha256(filePath: string): Promise<string> {
  const digest = crypto.createHash("sha256");
  digest.update(await fs.readFile(filePath));
  return digest.digest("hex");
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await runRaw(command, args, cwd, env);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  return result;
}

async function runRaw(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    streamToString(child.stdout),
    streamToString(child.stderr),
    new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 0));
    }),
  ]);

  return { stdout, stderr, exitCode };
}

async function streamToString(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
