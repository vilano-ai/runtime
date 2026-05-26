import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { expect, test } from "bun:test";

import type { WorkerClient, WorkflowActivation } from "../worker/shared/src/client.ts";
import { executeActivation } from "../worker/shared/src/core.ts";
import { createNodeCompatibleRuntimeAdapter } from "../worker/shared/src/runtime-adapter.ts";
import { executeProcess } from "../worker/shared/src/runtime-process.ts";
import type { ExecResult } from "../worker/shared/src/runtime-sdk.ts";

test("activation setup failures fail the run and clear the lease token", async () => {
  const workerHome = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-worker-core-"));
  const missingProjectPath = path.join(workerHome, "missing-project");
  const calls: {
    heartbeats: number;
    failRun: Array<{ leaseId: string; error: Record<string, unknown> }>;
    clearedLeaseIds: string[];
  } = {
    heartbeats: 0,
    failRun: [],
    clearedLeaseIds: [],
  };

  const client = {
    async heartbeat() {
      calls.heartbeats += 1;
    },
    async failRun(leaseId: string, error: Record<string, unknown>) {
      calls.failRun.push({ leaseId, error });
    },
    clearLeaseAuthToken(leaseId: string) {
      calls.clearedLeaseIds.push(leaseId);
    },
  } as unknown as WorkerClient;

  const activation = {
    kind: "workflow",
    leaseId: "lease-setup-failure",
    project: {
      path: missingProjectPath,
    },
  } as unknown as WorkflowActivation;

  try {
    await executeActivation(
      createNodeCompatibleRuntimeAdapter("node"),
      client,
      activation,
      5,
      workerHome
    );

    expect(calls.failRun).toHaveLength(1);
    expect(calls.failRun[0]?.leaseId).toBe("lease-setup-failure");
    expect(calls.clearedLeaseIds).toEqual(["lease-setup-failure"]);
  } finally {
    await fs.rm(workerHome, { recursive: true, force: true });
  }
});

test("exec capture persistence honors stdout and artifact byte caps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-worker-core-"));
  const artifactHome = path.join(root, "artifact-home");
  const projectPath = path.join(root, "project");
  const previousArtifactHome = process.env.VILANO_WORKER_ARTIFACT_HOME;
  const previousCaptureMax = process.env.VILANO_EXEC_CAPTURE_MAX_BYTES;
  const previousArtifactMax = process.env.VILANO_EXEC_ARTIFACT_MAX_BYTES;

  try {
    process.env.VILANO_WORKER_ARTIFACT_HOME = artifactHome;
    process.env.VILANO_EXEC_CAPTURE_MAX_BYTES = "64";
    process.env.VILANO_EXEC_ARTIFACT_MAX_BYTES = "16";

    await fs.mkdir(projectPath, { recursive: true });

    const client = {
      async getLeaseStatus() {
        return { active: true };
      },
    } as unknown as WorkerClient;

    const result = await executeProcess(
      createNodeCompatibleRuntimeAdapter("node"),
      client,
      {
        leaseId: "lease-capture-caps",
        run: { id: "run-capture-caps" },
        project: { path: projectPath },
      },
      {
        name: "capture-caps",
        cmd: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('fs');",
            "process.stdout.write('o'.repeat(200));",
            "fs.writeFileSync('artifact.bin', Buffer.alloc(64, 7));",
          ].join(""),
        ],
        capture: {
          stdout: true,
          artifacts: ["artifact.bin"],
        },
      },
      {
        key: "capture-caps",
        attempt: 1,
        cwd: projectPath,
      }
    );

    if (!result.ok) {
      throw new Error(`exec failed: ${JSON.stringify(result.error)}`);
    }

    expect(result.stdoutRef).toBeTruthy();
    expect(result.artifacts).toHaveLength(1);

    const stdoutPath = path.join(artifactHome, result.stdoutRef as string);
    const stdoutStat = await fs.stat(stdoutPath);
    expect(stdoutStat.size).toBeLessThanOrEqual(64);
    expect(await fs.readFile(stdoutPath, "utf8")).toContain("truncated");

    const artifact = result.artifacts[0]!;
    expect(artifact.truncated).toBe(true);
    expect(artifact.bytes).toBe(16);
    expect(artifact.originalBytes).toBe(64);
    expect((await fs.stat(path.join(artifactHome, artifact.ref))).size).toBe(16);
  } finally {
    restoreEnv("VILANO_WORKER_ARTIFACT_HOME", previousArtifactHome);
    restoreEnv("VILANO_EXEC_CAPTURE_MAX_BYTES", previousCaptureMax);
    restoreEnv("VILANO_EXEC_ARTIFACT_MAX_BYTES", previousArtifactMax);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("default successful exec output stdout and stderr are capped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-worker-core-"));
  const projectPath = path.join(root, "project");
  const previousCaptureMax = process.env.VILANO_EXEC_CAPTURE_MAX_BYTES;

  try {
    process.env.VILANO_EXEC_CAPTURE_MAX_BYTES = "65";
    await fs.mkdir(projectPath, { recursive: true });

    const result = await executeProcess<ExecResult>(
      createNodeCompatibleRuntimeAdapter("node"),
      activeLeaseClient(),
      {
        leaseId: "lease-default-output-caps",
        run: { id: "run-default-output-caps" },
        project: { path: projectPath },
      },
      {
        name: "default-output-caps",
        cmd: process.execPath,
        args: [
          "-e",
          [
            "const value = 'é'.repeat(100);",
            "process.stdout.write(value);",
            "process.stderr.write(value);",
          ].join(""),
        ],
      },
      {
        key: "default-output-caps",
        attempt: 1,
        cwd: projectPath,
      }
    );

    if (!result.ok) {
      throw new Error(`exec failed: ${JSON.stringify(result.error)}`);
    }

    expect(utf8Bytes(result.output.stdout)).toBeLessThanOrEqual(65);
    expect(utf8Bytes(result.output.stderr)).toBeLessThanOrEqual(65);
    expect(result.output.stdout).toContain("truncated");
    expect(result.output.stderr).toContain("truncated");
  } finally {
    restoreEnv("VILANO_EXEC_CAPTURE_MAX_BYTES", previousCaptureMax);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("multibyte stdout and stderr captures respect byte caps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-worker-core-"));
  const artifactHome = path.join(root, "artifact-home");
  const projectPath = path.join(root, "project");
  const previousArtifactHome = process.env.VILANO_WORKER_ARTIFACT_HOME;
  const previousCaptureMax = process.env.VILANO_EXEC_CAPTURE_MAX_BYTES;

  try {
    process.env.VILANO_WORKER_ARTIFACT_HOME = artifactHome;
    process.env.VILANO_EXEC_CAPTURE_MAX_BYTES = "65";
    await fs.mkdir(projectPath, { recursive: true });

    const result = await executeProcess<ExecResult>(
      createNodeCompatibleRuntimeAdapter("node"),
      activeLeaseClient(),
      {
        leaseId: "lease-multibyte-caps",
        run: { id: "run-multibyte-caps" },
        project: { path: projectPath },
      },
      {
        name: "multibyte-caps",
        cmd: process.execPath,
        args: [
          "-e",
          [
            "const value = 'é'.repeat(100);",
            "process.stdout.write(value);",
            "process.stderr.write(value);",
          ].join(""),
        ],
        capture: {
          stdout: true,
          stderr: true,
        },
      },
      {
        key: "multibyte-caps",
        attempt: 1,
        cwd: projectPath,
      }
    );

    if (!result.ok) {
      throw new Error(`exec failed: ${JSON.stringify(result.error)}`);
    }

    const stdoutPath = path.join(artifactHome, result.stdoutRef as string);
    const stderrPath = path.join(artifactHome, result.stderrRef as string);
    const stdout = await fs.readFile(stdoutPath, "utf8");
    const stderr = await fs.readFile(stderrPath, "utf8");

    expect((await fs.stat(stdoutPath)).size).toBeLessThanOrEqual(65);
    expect((await fs.stat(stderrPath)).size).toBeLessThanOrEqual(65);
    expect(utf8Bytes(stdout)).toBeLessThanOrEqual(65);
    expect(utf8Bytes(stderr)).toBeLessThanOrEqual(65);
    expect(stdout).not.toContain("\uFFFD");
    expect(stderr).not.toContain("\uFFFD");
  } finally {
    restoreEnv("VILANO_WORKER_ARTIFACT_HOME", previousArtifactHome);
    restoreEnv("VILANO_EXEC_CAPTURE_MAX_BYTES", previousCaptureMax);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("zero byte caps persist empty captures and artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-worker-core-"));
  const artifactHome = path.join(root, "artifact-home");
  const projectPath = path.join(root, "project");
  const previousArtifactHome = process.env.VILANO_WORKER_ARTIFACT_HOME;
  const previousCaptureMax = process.env.VILANO_EXEC_CAPTURE_MAX_BYTES;
  const previousArtifactMax = process.env.VILANO_EXEC_ARTIFACT_MAX_BYTES;

  try {
    process.env.VILANO_WORKER_ARTIFACT_HOME = artifactHome;
    process.env.VILANO_EXEC_CAPTURE_MAX_BYTES = "0";
    process.env.VILANO_EXEC_ARTIFACT_MAX_BYTES = "0";
    await fs.mkdir(projectPath, { recursive: true });

    const result = await executeProcess<ExecResult>(
      createNodeCompatibleRuntimeAdapter("node"),
      activeLeaseClient(),
      {
        leaseId: "lease-zero-caps",
        run: { id: "run-zero-caps" },
        project: { path: projectPath },
      },
      {
        name: "zero-caps",
        cmd: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('fs');",
            "process.stdout.write('stdout');",
            "process.stderr.write('stderr');",
            "fs.writeFileSync('artifact.bin', Buffer.from([1, 2, 3]));",
          ].join(""),
        ],
        capture: {
          stdout: true,
          stderr: true,
          artifacts: ["artifact.bin"],
        },
      },
      {
        key: "zero-caps",
        attempt: 1,
        cwd: projectPath,
      }
    );

    if (!result.ok) {
      throw new Error(`exec failed: ${JSON.stringify(result.error)}`);
    }

    expect(utf8Bytes(result.output.stdout)).toBe(0);
    expect(utf8Bytes(result.output.stderr)).toBe(0);

    const stdoutPath = path.join(artifactHome, result.stdoutRef as string);
    const stderrPath = path.join(artifactHome, result.stderrRef as string);
    expect((await fs.stat(stdoutPath)).size).toBe(0);
    expect((await fs.stat(stderrPath)).size).toBe(0);

    const artifact = result.artifacts[0]!;
    expect(artifact.bytes).toBe(0);
    expect(artifact.originalBytes).toBe(3);
    expect(artifact.truncated).toBe(true);
    expect((await fs.stat(path.join(artifactHome, artifact.ref))).size).toBe(0);
  } finally {
    restoreEnv("VILANO_WORKER_ARTIFACT_HOME", previousArtifactHome);
    restoreEnv("VILANO_EXEC_CAPTURE_MAX_BYTES", previousCaptureMax);
    restoreEnv("VILANO_EXEC_ARTIFACT_MAX_BYTES", previousArtifactMax);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function activeLeaseClient(): WorkerClient {
  return {
    async getLeaseStatus() {
      return { active: true };
    },
  } as unknown as WorkerClient;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
