# Vilano Runtime

Vilano Runtime is a TypeScript-first durable execution runtime with a BEAM kernel and JavaScript/TypeScript workers.

Today, this repo already has a working local runtime with:

- durable workflows
- durable services with inboxes and typed `send` / `ask` / `signal`
- BEAM-owned leasing, waits, timers, routing, and supervision
- JavaScript/TypeScript workers for TypeScript execution and subprocess execution
- project registry, `run inspect`, and `run replay`
- integration coverage for cancellation, replay, retries, signals, and hard-stop fallback paths

The local daemon listens on loopback only and now requires a per-runtime access token stored under `VILANO_HOME`. That is meant to block blind localhost access by unrelated local processes; it is not a strong isolation boundary against fully trusted code already running as the same user.

Working design notes live under `spec/` and are intentionally ignored by git.

## Quickstart

### Repo First Run

1. Run `direnv allow`.
2. Run `bun install`.
3. Run `./cli/bin/vilano.ts version`.
4. Run `./cli/bin/vilano.ts doctor --fix`.

Start the local runtime:

```bash
./cli/bin/vilano.ts daemon start
./cli/bin/vilano.ts daemon status
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

Run a manual worker under a specific JS runtime:

```bash
./cli/bin/vilano.ts worker start --runtime bun
./cli/bin/vilano.ts worker start --runtime node
```

Packaging and release smoke checks:

```bash
bun run check
bun run prepare:cli-package
bun run pack
bun run smoke:install
```

### Packaged Install Flow

The CLI package now bundles a local runtime payload under `runtime-dist/` so an installed `vilano` can boot its own kernel and worker without a repo checkout. The current repo-level smoke path is:

```bash
bun run smoke:install
```

That script packs `vilano` and `@vilano/runtime`, installs them into a temporary directory, runs `vilano version`, `vilano doctor --fix`, starts the daemon, checks status, and stops it again.

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
  retry: {
    retries: 1,
    backoff: { kind: "exponential", initial: "50ms", factor: 2, max: "1s" },
    on: ["application", "timeout"],
  },

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

For managed local workers, the kernel also has a hard-stop fallback for timed, non-cooperative blocking steps: it fails the step, revokes the lease, and kills the stuck worker process so the runtime can continue.

For unmanaged workers, the kernel still marks the activation as failed or cancelled durably, but it cannot force-kill that external worker process.

### Retries

Retries are durable and kernel-scheduled for:

- steps
- execs
- service turns

If a failure should bypass retries entirely, throw `nonRetryable(...)` from TypeScript-authored logic or parse code:

```ts
import { nonRetryable } from "@vilano/runtime";

throw nonRetryable(new Error("invalid user input"));
```

Current retry behavior is durable, kernel-scheduled, and configurable:

- `retries: 1` still means at most 2 attempts total
- `retry: { retries, backoff, on }` is the preferred shape for new code
- `backoff` can now be:
  `"50ms"`, `{ kind: "fixed", delay: "50ms" }`, `{ kind: "linear", initial: "50ms", step: "50ms", max: "1s" }`, or `{ kind: "exponential", initial: "50ms", factor: 2, max: "1s" }`
- object backoff policies can also add `jitter: "full" | "half" | { kind: "ratio", ratio: 0.5 }`
- capped backoff and applied jitter are persisted durably, so retries schedule from recorded data instead of worker-local timers
- `on` can target retry families like `application`, `timeout`, `process_exit`, or `process_spawn`
- `run inspect` and `run replay` surface the retry decision directly as `scheduled`, `non_retryable`, `family_not_selected`, `retries_disabled`, or `attempts_exhausted`
- `run inspect`, `service inspect`, and `run replay` now also show a `retry_series` view with base delay, capped delay, and applied jitter per attempt

## Operator Surface

Current CLI surfaces:

- `vilano version`
- `vilano doctor [--fix]`
- `vilano daemon start|status|stop`
- `vilano project add|list|inspect|sync|remove`
- `vilano workflow list|inspect`
- `vilano run start|list|inspect|replay|cancel`
- `vilano service list|ensure|inspect|send|ask|signal|stop`
- `vilano signal send`

Useful commands:

- `vilano version`
  Shows the CLI version, protocol version, whether the runtime bundle is repo-backed or packaged, and current kernel info when running.
- `vilano doctor --fix`
  Checks Bun/Elixir tooling, runtime bundle paths, kernel deps/build state, and optionally runs `mix local.hex`, `mix local.rebar`, `mix deps.get`, and `mix compile`.
- `vilano daemon status`
  Shows runtime version, protocol version, schema version, migration count, runtime home, and managed worker state.
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
- Managed local workers materialize a versioned source copy under `.vilano-cache/managed-workers/` so Bun always runs the matching worker implementation.
- `run replay` is served by a dedicated kernel endpoint and rendered by the CLI.
- Hosted, clustered, and multi-node execution are not built yet.

## Runtime Lifecycle

The local runtime now has explicit versioning and migration metadata.

- the kernel persists schema state in `schema_migrations`
- runtime metadata includes runtime version, protocol version, schema version, and applied migrations
- CLI and worker both fail fast on protocol mismatch instead of attempting partial operation
- `daemon status`, `version`, and `doctor --json` expose that metadata for tooling

## Repo Layout

- `kernel/`: Elixir/BEAM control plane
- `sdk/typescript/`: TypeScript authoring surface
- `worker/bun/`: Bun worker runtime
- `cli/`: Bun CLI and kernel client
- `examples/`: runnable demo definitions
- `tests/`: Bun integration suite
- `protocol/`: protocol notes
