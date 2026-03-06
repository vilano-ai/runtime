# TypeScript SDK

The TypeScript SDK is the authoring surface for Vilano Runtime.

It gives you two durable definition types:

- `workflow()`: bounded execution that completes
- `service()`: addressable, long-lived execution with inbox handlers

## Workflow Example

```ts
import { workflow } from "@vilano/runtime";

export const planner = workflow({
  name: "planner",
  run: async (input: { topic: string }, ctx) => {
    const summary = await ctx.step(
      "summarize",
      async () => `planned: ${input.topic}`,
      { retries: 1, backoff: "50ms" }
    );

    return { summary };
  },
});
```

## Service Example

```ts
import { service } from "@vilano/runtime";

export const reviewer = service({
  name: "reviewer",
  key: (input: { repoId: string }) => input.repoId,
  retry: { retries: 1, backoff: "50ms" },

  init: async (input) => ({
    repoId: input.repoId,
    notes: [] as string[],
  }),

  onSend: {
    hint: async (payload: { note: string }, state) => ({
      state: { ...state, notes: [...state.notes, payload.note] },
    }),
  },

  onAsk: {
    status: async (_payload, state) => ({
      reply: { ready: true, notes: state.notes.length },
    }),
  },
});
```

## Available Context

Inside workflows and service turns:

- `ctx.step(name, fn, options?)`
- `ctx.exec(spec)`
- `ctx.sleep(duration, options?)`
- `ctx.waitForSignal(name, options?)`
- `ctx.spawn(workflow, input, options?)`
- `ctx.connect(service, keyInput, options?)`
- `ctx.log(message, fields?)`

Connected services expose typed refs:

```ts
const ref = await ctx.connect(reviewer, { repoId: "repo_123" });
await ref.send.hint({ note: "Focus on migrations" });
const status = await ref.ask.status();
```

## `step()` Semantics

`step()` is for replayable in-process TypeScript logic.

The callback receives a step helper:

```ts
await ctx.step("work", async (step) => {
  while (true) {
    step.checkCancelled();
    await step.yield();
  }
});
```

Available step helpers:

- `step.signal`
- `step.checkCancelled()`
- `await step.yield()`

Use `step()` for short logic. If the work should be a killable process, use `exec()` instead.

## `exec()` Semantics

`exec()` is the durable subprocess boundary.

It supports:

- command, args, cwd, env
- timeout
- fixed retry/backoff
- stdout/stderr capture
- artifact capture
- parse callback for typed output

That makes it the right boundary for CLI tools, browser drivers, codegen, and long-running external work.

## Current Guarantees

- replay-from-the-top orchestration
- durable step, exec, wait, child, and service-message boundaries
- durable retries for steps, execs, and service turns
- cooperative cancellation for in-process `step()` code
- kernel hard-stop fallback for timed blocking steps on managed workers

## Explicit Non-Retryable Failures

If a failure should fail immediately even when retries are configured, throw `nonRetryable(...)`:

```ts
import { nonRetryable } from "@vilano/runtime";

throw nonRetryable(new Error("bad request"));
```

That works for:

- `step()` callback failures
- service handler failures
- `exec()` parse failures

## Current Limits

- no arbitrary JS continuation capture
- no exact-once guarantee for side effects
- hard-stop fallback only for managed workers the kernel supervises
- fixed-count / fixed-backoff retry policy only
