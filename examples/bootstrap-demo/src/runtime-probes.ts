import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";

import { nonRetryable, workflow } from "@vilano/runtime";

import { type DemoRetryBackoff, type DemoRetryFamily } from "./demo-shared";

let moduleStateProbeCounter = 0;

export const workerEnvProbe = workflow({
  name: "workerEnvProbe",
  run: async () => {
    return {
      workerTokenPresent: Boolean(process.env.VILANO_WORKER_TOKEN),
      daemonTokenPresent: Boolean(process.env.VILANO_DAEMON_TOKEN),
      runtimeHomePresent: Boolean(process.env.VILANO_HOME),
      workerHomePresent: Boolean(process.env.VILANO_WORKER_HOME),
      internalRuntimeHomePresent: Boolean(process.env.VILANO_RUNTIME_HOME),
    };
  },
});

export const workerPidProbe = workflow({
  name: "workerPidProbe",
  run: async () => ({ pid: process.pid }),
});

export const moduleStateProbe = workflow({
  name: "moduleStateProbe",
  run: async (_input, ctx) => {
    return await ctx.step(
      "module-state-probe",
      async () => {
        moduleStateProbeCounter += 1;
        return { count: moduleStateProbeCounter };
      },
      { key: "module-state-probe" }
    );
  },
});

export const snapshotIsolationProbe = workflow({
  name: "snapshotIsolationProbe",
  run: async (_input, ctx) => {
    return await ctx.step(
      "snapshot-isolation-probe",
      async () => {
        await fs.mkdir("tmp", { recursive: true });
        await fs.writeFile("tmp/workspace-marker.txt", "workspace-ok", "utf8");

        let snapshotWritable = true;
        let snapshotWriteErrorCode: string | null = null;
        let dependencyWritable = true;
        let dependencyWriteErrorCode: string | null = null;
        let workspaceNodeModulesSymlink = false;
        let workspaceNodeModulesRealPath: string | null = null;

        try {
          await fs.access(new URL(import.meta.url), fsConstants.W_OK);
        } catch (error) {
          snapshotWritable = false;
          snapshotWriteErrorCode = (error as NodeJS.ErrnoException).code ?? "unknown";
        }

        try {
          await fs.writeFile("node_modules/.vilano-dependency-marker", "blocked", "utf8");
        } catch (error) {
          dependencyWritable = false;
          dependencyWriteErrorCode = (error as NodeJS.ErrnoException).code ?? "unknown";
        }

        try {
          workspaceNodeModulesSymlink = (await fs.lstat("node_modules")).isSymbolicLink();
          workspaceNodeModulesRealPath = await fs.realpath("node_modules");
        } catch {
          workspaceNodeModulesSymlink = false;
          workspaceNodeModulesRealPath = null;
        }

        return {
          cwd: process.cwd(),
          workspaceMarkerPresent: true,
          snapshotWritable,
          snapshotWriteErrorCode,
          dependencyWritable,
          dependencyWriteErrorCode,
          workspaceNodeModulesSymlink,
          workspaceNodeModulesRealPath,
        };
      },
      { key: "snapshot-isolation-probe" }
    );
  },
});

export const activationWorkspaceProbe = workflow({
  name: "activationWorkspaceProbe",
  run: async (_input, ctx) => {
    const seeded = await ctx.step(
      "seed-workspace",
      async () => {
        await fs.mkdir("tmp", { recursive: true });
        await fs.writeFile("tmp/activation-marker.txt", "marker", "utf8");

        return {
          cwd: process.cwd(),
        };
      },
      { key: "seed-workspace" }
    );

    await ctx.sleep("50ms", { key: "resume-gap" });

    const resumed = await ctx.step(
      "check-workspace",
      async () => {
        let markerPresent = true;

        try {
          await fs.access("tmp/activation-marker.txt", fsConstants.F_OK);
        } catch {
          markerPresent = false;
        }

        return {
          cwd: process.cwd(),
          markerPresent,
        };
      },
      { key: "check-workspace" }
    );

    return {
      firstCwd: seeded.cwd,
      secondCwd: resumed.cwd,
      markerPresentAfterResume: resumed.markerPresent,
    };
  },
});

export const execEnvSecretProbe = workflow({
  name: "execEnvSecretProbe",
  run: async (input: { secret: string }, ctx) => {
    return await ctx.exec({
      name: "exec-env-secret-probe",
      key: `exec-env-secret-probe:${input.secret}`,
      cmd: "bun",
      args: ["-e", "console.log(JSON.stringify({ ok: true }))"],
      env: {
        EXEC_SECRET: input.secret,
      },
      capture: {
        stdout: true,
      },
      parse: (stdout) => JSON.parse(stdout.trim()) as { ok: true },
    });
  },
});

export const longExec = workflow({
  name: "longExec",
  run: async (input: { durationMs?: number }, ctx) => {
    return await ctx.exec({
      name: "long-exec",
      key: "long-exec",
      cmd: "bun",
      args: [
        "-e",
        [
          `await new Promise((resolve) => setTimeout(resolve, ${input.durationMs ?? 5_000}));`,
          "console.log(JSON.stringify({ ok: true }));",
        ].join(" "),
      ],
      capture: {
        stdout: true,
        stderr: true,
      },
      parse: (stdout) => JSON.parse(stdout.trim()) as { ok: true },
    });
  },
});

export const timedExec = workflow({
  name: "timedExec",
  run: async (input: { durationMs?: number; timeout?: string }, ctx) => {
    return await ctx.exec({
      name: "timed-exec",
      key: "timed-exec",
      cmd: "bun",
      args: [
        "-e",
        [
          "const fs = require('node:fs');",
          "fs.mkdirSync('tmp', { recursive: true });",
          "fs.writeFileSync('tmp/before-timeout.txt', 'before-timeout');",
          "console.error('still running');",
          `await new Promise((resolve) => setTimeout(resolve, ${input.durationMs ?? 5_000}));`,
          "console.log(JSON.stringify({ ok: true }));",
        ].join(" "),
      ],
      timeout: input.timeout ?? "200ms",
      capture: {
        stdout: true,
        stderr: true,
        artifacts: ["tmp/before-timeout.txt"],
      },
      parse: (stdout) => JSON.parse(stdout.trim()) as { ok: true },
    });
  },
});

export const retryingExec = workflow({
  name: "retryingExec",
  run: async (
    input: {
      token: string;
      retries?: number;
      backoff?: DemoRetryBackoff;
      retryOn?: DemoRetryFamily[];
      failuresBeforeSuccess?: number;
    },
    ctx
  ) => {
    return await ctx.exec({
      name: "retrying-exec",
      key: `retrying-exec:${input.token}`,
      retry: {
        retries: input.retries ?? 1,
        backoff: input.backoff ?? "50ms",
        on: input.retryOn,
      },
      cmd: "bun",
      args: [
        "-e",
        [
          "const attempt = Number(process.env.VILANO_EXEC_ATTEMPT || '1');",
          `if (attempt <= ${input.failuresBeforeSuccess ?? 1}) {`,
          "  console.error('transient exec failure');",
          "  process.exit(1);",
          "}",
          `console.log(JSON.stringify({ attempt, token: ${JSON.stringify(input.token)} }));`,
        ].join(" "),
      ],
      capture: {
        stdout: true,
        stderr: true,
      },
      parse: (stdout) => JSON.parse(stdout.trim()) as { attempt: number; token: string },
    });
  },
});

export const nonRetryingExec = workflow({
  name: "nonRetryingExec",
  run: async (input: { token: string }, ctx) => {
    return await ctx.exec({
      name: "non-retrying-exec",
      key: `non-retrying-exec:${input.token}`,
      retries: 3,
      backoff: "50ms",
      cmd: "bun",
      args: ["-e", `console.log(JSON.stringify({ token: ${JSON.stringify(input.token)} }))`],
      capture: {
        stdout: true,
      },
      parse: (_stdout) => {
        throw nonRetryable(new Error(`non-retryable exec parse failure for ${input.token}`));
      },
    });
  },
});

export const signaledExec = workflow({
  name: "signaledExec",
  run: async (input: { token: string }, ctx) => {
    return await ctx.exec({
      name: "signaled-exec",
      key: `signaled-exec:${input.token}`,
      cmd: "bash",
      args: ["-lc", ["kill -TERM $$"].join(" ")],
      capture: {
        stdout: true,
        stderr: true,
      },
    });
  },
});
