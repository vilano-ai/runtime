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
});
