# Vilano Runtime

Vilano Runtime is a TypeScript-first durable execution runtime with a BEAM kernel and Bun workers.

Today, this repo already has a working local runtime with:

- durable workflows
- durable services with inboxes and typed `send` / `ask` / `signal`
- BEAM-owned leasing, waits, timers, routing, and supervision
- Bun workers for TypeScript execution and subprocess execution
- project registry, `run inspect`, and `run replay`
- integration coverage for cancellation, replay, retries, signals, and hard-stop fallback paths

Working design notes live under `spec/` and are intentionally ignored by git.

## Quickstart

1. Run `direnv allow`.
2. Run `bun install`.
3. Run `cd kernel && mix local.hex --force && mix local.rebar --force`.
4. Run `cd kernel && mix deps.get`.

Start the local runtime:

```bash
./cli/bin/vilano.ts daemon start
./cli/bin/vilano.ts project add ./examples/bootstrap-demo --name demo
./cli/bin/vilano.ts workflow list
```

Run a workflow:

```bash
./cli/bin/vilano.ts run start demo/planner --input '{"topic":"BEAM"}'
./cli/bin/vilano.ts run list
./cli/bin/vilano.ts run inspect <run-id>
./cli/bin/vilano.ts run replay <run-id>
```

Address a service:

```bash
./cli/bin/vilano.ts service ensure demo/reviewer --key-json '{"repoId":"repo_123"}'
./cli/bin/vilano.ts service send demo/reviewer hint --key-json '{"repoId":"repo_123"}' --input '{"note":"Focus on migrations"}'
./cli/bin/vilano.ts service ask demo/reviewer status --key-json '{"repoId":"repo_123"}'
```

Run the integration suite:

```bash
direnv exec . bun test tests --timeout 120000 --max-concurrency 1
```

## Authoring Model

Workflows are bounded runs:

```ts
import { workflow } from "@vilano/runtime";

export const planner = workflow({
  name: "planner",
  run: async (input: { topic: string }, ctx) => {
    const research = await ctx.step(
      "research",
      async () => ({ topic: input.topic, sources: 3 }),
      { retries: 1, backoff: "50ms" }
    );

    return await ctx.exec({
      name: "summarize",
      cmd: "bun",
      args: ["-e", `console.log(JSON.stringify(${JSON.stringify(research)}))`],
      capture: { stdout: true },
      parse: (stdout) => JSON.parse(stdout.trim()),
    });
  },
});
```

Services are durable, addressable runs with typed inbox handlers:

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

From a workflow or service turn:

```ts
const reviewerRef = await ctx.connect(reviewer, { repoId: "repo_123" });
await reviewerRef.send.hint({ note: "Focus on migrations" });
const status = await reviewerRef.ask.status();
```

## Runtime Semantics

The runtime does not capture arbitrary JavaScript stack frames. Recovery works by replaying workflow or service-turn orchestration code from the top against durable history.

Durable boundaries today:

- `ctx.step()`
- `ctx.exec()`
- `ctx.sleep()`
- `ctx.waitForSignal()`
- `ctx.spawn()` / `child.result()`
- `ctx.connect()` with service `send` / `ask` / `signal`

### `step()` vs `exec()`

Use `ctx.step()` for short, replayable, in-process TypeScript logic.

Use `ctx.exec()` for:

- CLI tools
- browser drivers
- codegen processes
- anything that should be killable as a real subprocess
- work that should capture stdout, stderr, and artifacts durably

### Cancellation and Timeouts

`step()` supports cooperative control inside the callback:

- `step.signal`
- `step.checkCancelled()`
- `await step.yield()`

For managed local workers, the kernel also has a hard-stop fallback for timed, non-cooperative blocking steps: it fails the step, revokes the lease, and kills the stuck Bun worker so the runtime can continue.

For unmanaged workers, the kernel still marks the activation as failed or cancelled durably, but it cannot force-kill that external worker process.

### Retries

Retries are durable and kernel-scheduled for:

- steps
- execs
- service turns

Current retry behavior is fixed-count plus fixed-backoff:

- `retries: 1` means at most 2 attempts total
- `backoff: "50ms"` schedules a durable timed retry wait in the kernel

## Operator Surface

Current CLI surfaces:

- `vilano daemon start|status|stop`
- `vilano project add|list|inspect|sync|remove`
- `vilano workflow list|inspect`
- `vilano run start|list|inspect|replay|cancel`
- `vilano service list|ensure|inspect|send|ask|signal|stop`
- `vilano signal send`

Useful commands:

- `vilano run inspect <run-id>`
  Shows current run state, events, waits, turns, steps, execs, child runs, and service envelopes.
- `vilano run replay <run-id>`
  Shows a chronological timeline derived from the durable event stream.
- `--json`
  Available on important commands for scripting and future TUI layering.

## Current Limits

This runtime is real, but still v1-shaped.

Current limits worth knowing:

- `step()` hard-stop escalation is only available for managed workers the kernel supervises.
- In-process TypeScript code is still cooperative first; the hard-stop path is a fallback, not normal control flow.
- Retry policies are fixed-count and fixed-backoff only.
- `run replay` is currently a CLI projection over inspect data, not a dedicated kernel endpoint.
- Hosted, clustered, and multi-node execution are not built yet.

## Repo Layout

- `kernel/`: Elixir/BEAM control plane
- `sdk/typescript/`: TypeScript authoring surface
- `worker/bun/`: Bun worker runtime
- `cli/`: Bun CLI and kernel client
- `examples/`: runnable demo definitions
- `tests/`: Bun integration suite
- `protocol/`: protocol notes
