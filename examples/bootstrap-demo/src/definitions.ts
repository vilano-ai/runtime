import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";

import { nonRetryable, service, workflow } from "@vilano/runtime";

type DemoRetryFamily = "always" | "application" | "timeout" | "process_exit" | "process_spawn";
type DemoRetryJitter =
  | "full"
  | "half"
  | {
      kind: "ratio";
      ratio: number;
    };
type DemoRetryBackoff =
  | string
  | {
      kind: "fixed";
      delay: string;
      jitter?: DemoRetryJitter;
    }
  | {
      kind: "linear";
      initial: string;
      step?: string;
      max?: string;
      jitter?: DemoRetryJitter;
    }
  | {
      kind: "exponential";
      initial: string;
      factor?: number;
      max?: string;
      jitter?: DemoRetryJitter;
    };

let moduleStateProbeCounter = 0;

async function bumpMarkerAttempt(markerPath: string): Promise<number> {
  await fs.mkdir("tmp", { recursive: true });

  try {
    const current = Number((await fs.readFile(markerPath, "utf8")).trim() || "0");
    const next = current + 1;
    await fs.writeFile(markerPath, String(next));
    return next;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.writeFile(markerPath, "1");
      return 1;
    }

    throw error;
  }
}

export const planner = workflow({
  name: "planner",
  run: async (input: { topic: string }, ctx) => {
    return await ctx.exec({
      name: "summarize",
      key: "summary",
      cmd: "bun",
      args: [
        "-e",
        [
          "const fs = require('node:fs');",
          `const summary = ${JSON.stringify(`planned: ${input.topic}`)};`,
          "fs.mkdirSync('tmp', { recursive: true });",
          "fs.writeFileSync('tmp/summary.txt', summary);",
          "console.log(JSON.stringify({ summary }));",
        ].join(" "),
      ],
      capture: {
        stdout: true,
        stderr: true,
        artifacts: ["tmp/summary.txt"],
      },
      parse: (stdout) => JSON.parse(stdout.trim()) as { summary: string },
    });
  },
});

export const sleeper = workflow({
  name: "sleeper",
  run: async (input: { duration?: string }, ctx) => {
    await ctx.sleep(input.duration ?? "100ms", { key: "nap" });

    return {
      woke: true,
    };
  },
});

export const slowWorkflowStep = workflow({
  name: "slowWorkflowStep",
  run: async (input: { durationMs?: number }, ctx) => {
    return await ctx.step(
      "slow-workflow-step",
      async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, input.durationMs ?? 1500);
        });

        return {
          waitedMs: input.durationMs ?? 1500,
        };
      },
      { key: `slow-workflow-step:${input.durationMs ?? 1500}` }
    );
  },
});

export const cooperativeStep = workflow({
  name: "cooperativeStep",
  run: async (input: { durationMs?: number; timeout?: string }, ctx) => {
    return await ctx.step(
      "cooperative-step",
      async (step) => {
        const durationMs = input.durationMs ?? 5_000;
        const deadline = Date.now() + durationMs;
        let ticks = 0;

        while (Date.now() < deadline) {
          ticks += 1;
          await step.yield();
        }

        step.checkCancelled();

        return {
          ticks,
          waitedMs: durationMs,
        };
      },
      {
        key: `cooperative-step:${input.durationMs ?? 5_000}`,
        timeout: input.timeout,
      }
    );
  },
});

export const blockingStep = workflow({
  name: "blockingStep",
  run: async (input: { durationMs?: number; timeout?: string }, ctx) => {
    return await ctx.step(
      "blocking-step",
      async () => {
        const durationMs = input.durationMs ?? 5_000;
        const deadline = Date.now() + durationMs;

        while (Date.now() < deadline) {
          // Intentionally blocks the event loop to exercise kernel-enforced worker termination.
        }

        return {
          waitedMs: durationMs,
        };
      },
      {
        key: `blocking-step:${input.durationMs ?? 5_000}`,
        timeout: input.timeout,
      }
    );
  },
});

export const retryingStep = workflow({
  name: "retryingStep",
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
    return await ctx.step(
      "retrying-step",
      async (step) => {
        const attempt = step.attempt;
        if (attempt <= (input.failuresBeforeSuccess ?? 1)) {
          throw new Error("transient step failure");
        }

        return {
          attempt,
          token: input.token,
        };
      },
      {
        key: `retrying-step:${input.token}`,
        retry: {
          retries: input.retries ?? 1,
          backoff: input.backoff ?? "50ms",
          on: input.retryOn,
        },
      }
    );
  },
});

export const timeoutRetryingStep = workflow({
  name: "timeoutRetryingStep",
  run: async (
    input: {
      token: string;
      retries?: number;
      backoff?: DemoRetryBackoff;
      retryOn?: DemoRetryFamily[];
      timeout?: string;
    },
    ctx
  ) => {
    return await ctx.step(
      "timeout-retrying-step",
      async (step) => {
        const attempt = step.attempt;

        if (attempt === 1) {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            await step.yield();
          }
        }

        return {
          attempt,
          token: input.token,
        };
      },
      {
        key: `timeout-retrying-step:${input.token}`,
        timeout: input.timeout ?? "200ms",
        retry: {
          retries: input.retries ?? 1,
          backoff: input.backoff ?? "50ms",
          on: input.retryOn ?? ["timeout"],
        },
      }
    );
  },
});

export const nonRetryingStep = workflow({
  name: "nonRetryingStep",
  run: async (input: { token: string }, ctx) => {
    return await ctx.step(
      "non-retrying-step",
      async (step) => {
        const attempt = step.attempt;
        throw nonRetryable(new Error(`non-retryable step failure on attempt ${attempt}`));
      },
      {
        key: `non-retrying-step:${input.token}`,
        retries: 3,
        backoff: "50ms",
      }
    );
  },
});

export const gate = workflow({
  name: "gate",
  run: async (_input: Record<string, never>, ctx) => {
    const approval = await ctx.waitForSignal("approved", { key: "approval" });

    return {
      approval,
    };
  },
});

export const childTask = workflow({
  name: "childTask",
  run: async (input: { topic: string }, ctx) => {
    const summary = await ctx.step(
      "child-summary",
      async () => `child planned: ${input.topic}`,
      { key: "child-summary" }
    );

    return { summary };
  },
});

export const delegator = workflow({
  name: "delegator",
  run: async (input: { topic: string }, ctx) => {
    const child = ctx.spawn(childTask, { topic: input.topic }, { key: "child" });
    const result = await child.result();

    return {
      delegated: true,
      childRunId: child.id,
      child: result,
    };
  },
});

export const slowChildTask = workflow({
  name: "slowChildTask",
  run: async (input: { topic: string; duration?: string }, ctx) => {
    await ctx.sleep(input.duration ?? "5s", { key: "slow-child-wait" });

    return {
      summary: `slow child planned: ${input.topic}`,
    };
  },
});

export const waitingChild = workflow({
  name: "waitingChild",
  run: async (input: { token: string }, ctx) => {
    await ctx.waitForSignal("continue", { key: `continue:${input.token}` });

    return {
      token: input.token,
    };
  },
});

export const childSignalCoordinator = workflow({
  name: "childSignalCoordinator",
  run: async (input: { token: string }, ctx) => {
    const child = ctx.spawn(waitingChild, { token: input.token }, { key: `child:${input.token}` });
    const initialStatus = await child.status();
    await child.signal("continue", { source: "parent" });
    const result = await child.result();

    return {
      initialStatus,
      child: result,
    };
  },
});

export const cancelledChildParent = workflow({
  name: "cancelledChildParent",
  run: async (input: { token: string }, ctx) => {
    const child = ctx.spawn(waitingChild, { token: input.token }, { key: `child:${input.token}` });
    return await child.result();
  },
});

export const slowDelegator = workflow({
  name: "slowDelegator",
  run: async (input: { topic: string; duration?: string }, ctx) => {
    const child = ctx.spawn(
      slowChildTask,
      { topic: input.topic, duration: input.duration },
      { key: "slow-child" }
    );

    const result = await child.result();

    return {
      delegated: true,
      childRunId: child.id,
      child: result,
    };
  },
});

export const echoChild = workflow({
  name: "echoChild",
  run: async (input: { value: number }) => {
    return input;
  },
});

export const implicitKeyProbe = workflow({
  name: "implicitKeyProbe",
  run: async (input: { token: string }, ctx) => {
    const stepMarkerPath = `tmp/implicit-step-${input.token}.txt`;
    const execMarkerPath = `tmp/implicit-exec-${input.token}.txt`;

    const firstStep = await ctx.step("repeat-step", async () => await bumpMarkerAttempt(stepMarkerPath));
    const secondStep = await ctx.step("repeat-step", async () => await bumpMarkerAttempt(stepMarkerPath));

    const execScript = [
      "const fs = require('node:fs');",
      "fs.mkdirSync('tmp', { recursive: true });",
      `const markerPath = ${JSON.stringify(execMarkerPath)};`,
      "let current = 0;",
      "try { current = Number(fs.readFileSync(markerPath, 'utf8').trim() || '0'); }",
      "catch (error) { if (error.code !== 'ENOENT') throw error; }",
      "const next = current + 1;",
      "fs.writeFileSync(markerPath, String(next));",
      "console.log(JSON.stringify({ attempt: next }));",
    ].join(" ");

    const firstExec = await ctx.exec({
      name: "repeat-exec",
      cmd: "bun",
      args: ["-e", execScript],
      capture: { stdout: true },
      parse: (stdout) => JSON.parse(stdout.trim()) as { attempt: number },
    });

    const secondExec = await ctx.exec({
      name: "repeat-exec",
      cmd: "bun",
      args: ["-e", execScript],
      capture: { stdout: true },
      parse: (stdout) => JSON.parse(stdout.trim()) as { attempt: number },
    });

    const firstChild = ctx.spawn(echoChild, { value: 1 });
    const secondChild = ctx.spawn(echoChild, { value: 2 });
    const [firstChildResult, secondChildResult] = await Promise.all([
      firstChild.result(),
      secondChild.result(),
    ]);

    return {
      stepAttempts: [firstStep, secondStep],
      execAttempts: [firstExec.attempt, secondExec.attempt],
      childRunIds: [firstChild.id, secondChild.id],
      childValues: [firstChildResult.value, secondChildResult.value],
    };
  },
});

export const mailboxAskWorkflow = workflow({
  name: "mailboxAskWorkflow",
  run: async (input: { sessionId: string; id: string; delayMs?: number }, ctx) => {
    const ref = await ctx.connect(mailboxProbe, { sessionId: input.sessionId });
    return await ref.ask.delay({ id: input.id, delayMs: input.delayMs ?? 0 });
  },
});

export const reviewer = service({
  name: "reviewer",
  key: (input: { repoId: string }) => input.repoId,
  init: async (input: { repoId: string }) => ({
    repoId: input.repoId,
    notes: [] as string[],
  }),
  onAsk: {
    status: async (_payload: void, state) => {
      return {
        reply: {
          ready: true,
          notes: state.notes.length,
        },
      };
    },
  },
  onSend: {
    hint: async (payload: { note: string }, state) => {
      return {
        state: {
          ...state,
          notes: [...state.notes, payload.note],
        },
      };
    },
  },
  onSignal: {
    reset: async (_payload: void, state) => {
      return {
        state: {
          ...state,
          notes: [],
        },
      };
    },
  },
});

export const operator = service({
  name: "operator",
  key: (input: { sessionId: string }) => input.sessionId,
  init: async (input: { sessionId: string }) => ({
    sessionId: input.sessionId,
    approvals: 0,
  }),
  onAsk: {
    pipeline: async (payload: { topic: string }, state, ctx) => {
      await ctx.sleep("50ms", { key: `pause:${payload.topic}` });

      const child = ctx.spawn(childTask, { topic: payload.topic }, { key: `child:${payload.topic}` });
      const childResult = await child.result();

      const execResult = await ctx.exec({
        name: "operator-pipeline",
        key: `exec:${payload.topic}`,
        cmd: "bun",
        args: [
          "-e",
          `console.log(JSON.stringify(${JSON.stringify({
            summary: `operator:${payload.topic}`,
          })}))`,
        ],
        capture: {
          stdout: true,
        },
        parse: (stdout) => JSON.parse(stdout.trim()) as { summary: string },
      });

      return {
        reply: {
          child: childResult,
          exec: execResult,
          approvals: state.approvals,
        },
      };
    },
    slowStep: async (payload: { durationMs?: number }, _state, ctx) => {
      const result = await ctx.step(
        "slow-step",
        async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, payload.durationMs ?? 1500);
          });

          return {
            waitedMs: payload.durationMs ?? 1500,
          };
        },
        { key: `slow-step:${payload.durationMs ?? 1500}` }
      );

      return {
        reply: result,
      };
    },
    blockingStep: async (payload: { durationMs?: number; timeout?: string }, _state, ctx) => {
      const result = await ctx.step(
        "blocking-service-step",
        async () => {
          const durationMs = payload.durationMs ?? 5_000;
          const deadline = Date.now() + durationMs;

          while (Date.now() < deadline) {
            // Intentionally blocks the event loop to exercise kernel-enforced service turn termination.
          }

          return {
            waitedMs: durationMs,
          };
        },
        {
          key: `blocking-service-step:${payload.durationMs ?? 5_000}`,
          timeout: payload.timeout,
        }
      );

      return {
        reply: result,
      };
    },
    awaitApproval: async (_payload: void, state, ctx) => {
      const approval = await ctx.waitForSignal("approved", { key: "approved" });

      return {
        reply: {
          approval,
          sessionId: state.sessionId,
        },
      };
    },
  },
});

export const retryingResponder = service({
  name: "retryingResponder",
  retry: {
    retries: 1,
    backoff: "50ms",
  },
  key: (input: { sessionId: string }) => input.sessionId,
  onAsk: {
    unstable: async (payload: { token: string }, _state, ctx) => {
      const attempt = ctx.turnAttempt;

      if (attempt === 1) {
        throw new Error("transient service failure");
      }

      return {
        reply: {
          attempt,
          token: payload.token,
        },
      };
    },
  },
});

export const mailboxProbe = service({
  name: "mailboxProbe",
  key: (input: { sessionId: string }) => input.sessionId,
  init: async (input: { sessionId: string }) => ({
    sessionId: input.sessionId,
    history: [] as string[],
  }),
  onSend: {
    record: async (payload: { id: string }, state) => ({
      state: {
        ...state,
        history: [...state.history, `send:${payload.id}`],
      },
    }),
  },
  onAsk: {
    delay: async (payload: { id: string; delayMs?: number }, state, ctx) => {
      if ((payload.delayMs ?? 0) > 0) {
        await ctx.step(
          "mailbox-delay",
          async () => {
            await new Promise((resolve) => {
              setTimeout(resolve, payload.delayMs ?? 0);
            });

            return null;
          },
          {
            key: `mailbox-delay:${payload.id}:${payload.delayMs ?? 0}`,
          }
        );
      }

      const history = [...state.history, `ask:${payload.id}`];

      return {
        state: {
          ...state,
          history,
        },
        reply: {
          id: payload.id,
          history,
        },
      };
    },
    stopAfterDelay: async (payload: { delayMs?: number }, state, ctx) => {
      if ((payload.delayMs ?? 0) > 0) {
        await ctx.step(
          "mailbox-stop-delay",
          async () => {
            await new Promise((resolve) => {
              setTimeout(resolve, payload.delayMs ?? 0);
            });

            return null;
          },
          {
            key: `mailbox-stop-delay:${payload.delayMs ?? 0}`,
          }
        );
      }

      return {
        state: {
          ...state,
          history: [...state.history, "ask:stop"],
        },
        reply: {
          stopped: true,
        },
        stop: true,
      };
    },
    history: async (_payload: Record<string, never>, state) => ({
      reply: {
        history: state.history,
      },
    }),
  },
});

export const optionsPayloadProbe = service({
  name: "optionsPayloadProbe",
  key: (input: { sessionId: string }) => input.sessionId,
  onAsk: {
    echo: async (payload: { key: string; timeout: string }) => ({
      reply: payload,
    }),
  },
});

export const serviceTurnIsolationProbe = service({
  name: "serviceTurnIsolationProbe",
  key: (input: { sessionId: string }) => input.sessionId,
  init: async () => ({
    counter: 0,
  }),
  onAsk: {
    sequence: async (_payload: { token: string }, state, ctx) => {
      const first = await ctx.step("repeat-step", async () => state.counter + 1);
      const second = await ctx.step("repeat-step", async () => state.counter + 2);

      return {
        state: {
          counter: state.counter + 2,
        },
        reply: {
          attempts: [first, second],
        },
      };
    },
  },
});

export const timeoutOnlyResponder = service({
  name: "timeoutOnlyResponder",
  retry: {
    retries: 2,
    backoff: "50ms",
    on: ["timeout"],
  },
  key: (input: { sessionId: string }) => input.sessionId,
  onAsk: {
    unstable: async (payload: { token: string }, _state, ctx) => {
      const attempt = ctx.turnAttempt;
      throw new Error(`application failure on attempt ${attempt}`);
    },
  },
});

export const nonRetryingResponder = service({
  name: "nonRetryingResponder",
  retry: {
    retries: 3,
    backoff: "50ms",
  },
  key: (input: { sessionId: string }) => input.sessionId,
  onAsk: {
    unstable: async (payload: { token: string }, _state, ctx) => {
      const attempt = ctx.turnAttempt;
      throw nonRetryable(new Error(`non-retryable service failure on attempt ${attempt}`));
    },
  },
});

export const reviewCoordinator = workflow({
  name: "reviewCoordinator",
  run: async (input: { repoId: string; note: string }, ctx) => {
    const reviewerRef = await ctx.connect(reviewer, { repoId: input.repoId });
    await reviewerRef.send.hint({ note: input.note });
    const status = await reviewerRef.ask.status();

    return {
      reviewerRunId: reviewerRef.id,
      status,
    };
  },
});

export const approvalCoordinator = workflow({
  name: "approvalCoordinator",
  run: async (input: { sessionId: string }, ctx) => {
    const operatorRef = await ctx.connect(operator, { sessionId: input.sessionId });
    const approval = await operatorRef.ask.awaitApproval();

    return {
      operatorRunId: operatorRef.id,
      approval,
    };
  },
});

export const askTimeoutCoordinator = workflow({
  name: "askTimeoutCoordinator",
  run: async (input: { sessionId: string }, ctx) => {
    const operatorRef = await ctx.connect(operator, { sessionId: input.sessionId });
    return await operatorRef.ask.awaitApproval(undefined, { timeout: "100ms" });
  },
});

export const servicePayloadShapeCoordinator = workflow({
  name: "servicePayloadShapeCoordinator",
  run: async (input: { sessionId: string }, ctx) => {
    const probe = await ctx.connect(optionsPayloadProbe, { sessionId: input.sessionId });
    return await probe.ask.echo({ key: "payload-key", timeout: "payload-timeout" });
  },
});

export const serviceStatusCoordinator = workflow({
  name: "serviceStatusCoordinator",
  run: async (input: { sessionId: string }, ctx) => {
    const operatorRef = await ctx.connect(operator, { sessionId: input.sessionId });

    return {
      status: await operatorRef.status(),
      serviceRunId: operatorRef.id,
    };
  },
});

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
      args: [
        "-e",
        "console.log(JSON.stringify({ ok: true }))",
      ],
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

export const serviceTurnCoordinator = workflow({
  name: "serviceTurnCoordinator",
  run: async (input: { sessionId: string; topic: string }, ctx) => {
    const operatorRef = await ctx.connect(operator, { sessionId: input.sessionId });
    const pipeline = await operatorRef.ask.pipeline({ topic: input.topic });

    return {
      operatorRunId: operatorRef.id,
      pipeline,
    };
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
      args: [
        "-e",
        `console.log(JSON.stringify({ token: ${JSON.stringify(input.token)} }))`,
      ],
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
      args: [
        "-lc",
        [
          "kill -TERM $$",
        ].join(" "),
      ],
      capture: {
        stdout: true,
        stderr: true,
      },
    });
  },
});
