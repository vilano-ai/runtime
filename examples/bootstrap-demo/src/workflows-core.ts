import { nonRetryable, workflow } from "@vilano/runtime";

import { bumpMarkerAttempt, type DemoRetryBackoff, type DemoRetryFamily } from "./demo-shared";

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
    return { woke: true };
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

        return { waitedMs: input.durationMs ?? 1500 };
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

        return { ticks, waitedMs: durationMs };
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

        return { waitedMs: durationMs };
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

        return { attempt, token: input.token };
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

        return { attempt, token: input.token };
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
    return { approval };
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
    return { delegated: true, childRunId: child.id, child: result };
  },
});

export const slowChildTask = workflow({
  name: "slowChildTask",
  run: async (input: { topic: string; duration?: string }, ctx) => {
    await ctx.sleep(input.duration ?? "5s", { key: "slow-child-wait" });
    return { summary: `slow child planned: ${input.topic}` };
  },
});

export const waitingChild = workflow({
  name: "waitingChild",
  run: async (input: { token: string }, ctx) => {
    await ctx.waitForSignal("continue", { key: `continue:${input.token}` });
    return { token: input.token };
  },
});

export const childSignalCoordinator = workflow({
  name: "childSignalCoordinator",
  run: async (input: { token: string }, ctx) => {
    const child = ctx.spawn(waitingChild, { token: input.token }, { key: `child:${input.token}` });
    const initialStatus = await child.status();
    await child.signal("continue", { source: "parent" });
    const result = await child.result();
    return { initialStatus, child: result };
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
    return { delegated: true, childRunId: child.id, child: result };
  },
});

export const echoChild = workflow({
  name: "echoChild",
  run: async (input: { value: number }) => input,
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
