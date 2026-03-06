import fs from "node:fs/promises";

import { service, workflow } from "@vilano/runtime";

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
    input: { token: string; retries?: number; backoff?: string },
    ctx
  ) => {
    const markerPath = `tmp/retrying-step-${input.token}.txt`;

    return await ctx.step(
      "retrying-step",
      async () => {
        const attempt = await bumpMarkerAttempt(markerPath);
        if (attempt === 1) {
          throw new Error("transient step failure");
        }

        return {
          attempt,
          token: input.token,
        };
      },
      {
        key: `retrying-step:${input.token}`,
        retries: input.retries ?? 1,
        backoff: input.backoff ?? "50ms",
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
    unstable: async (payload: { token: string }) => {
      const markerPath = `tmp/retrying-service-${payload.token}.txt`;
      const attempt = await bumpMarkerAttempt(markerPath);

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
    input: { token: string; retries?: number; backoff?: string },
    ctx
  ) => {
    const markerPath = `tmp/retrying-exec-${input.token}.txt`;

    return await ctx.exec({
      name: "retrying-exec",
      key: `retrying-exec:${input.token}`,
      retries: input.retries ?? 1,
      backoff: input.backoff ?? "50ms",
      cmd: "bun",
      args: [
        "-e",
        [
          "const fs = require('node:fs');",
          "fs.mkdirSync('tmp', { recursive: true });",
          `const markerPath = ${JSON.stringify(markerPath)};`,
          "let attempt = 1;",
          "if (fs.existsSync(markerPath)) {",
          "  attempt = Number(fs.readFileSync(markerPath, 'utf8').trim() || '0') + 1;",
          "}",
          "fs.writeFileSync(markerPath, String(attempt));",
          "if (attempt === 1) {",
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
