import { service, workflow } from "@vilano/runtime";

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
