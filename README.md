# Vilano Runtime

[![CI](https://github.com/vilano-ai/runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/vilano-ai/runtime/actions/workflows/ci.yml)
[![Launch Gate](https://github.com/vilano-ai/runtime/actions/workflows/launch-gate.yml/badge.svg)](https://github.com/vilano-ai/runtime/actions/workflows/launch-gate.yml)

Vilano Runtime is a durable runtime for building agent systems.

It replaces retry-based execution with deterministic replay over durable state, allowing
workflows and agents to recover correctly from failure.

In Vilano Runtime:

- the code reruns
- the state does not

The system is built around a BEAM-based kernel for coordination and durability, with
disposable TypeScript workers executing agent behavior.

Vilano Runtime `0.1` ships a TypeScript-first local runtime with a durable BEAM kernel,
disposable JS/TS workers, and an operator CLI.

The current OSS release path is local-first and single-machine. It is built for agent systems that
need:

- durable replay instead of best-effort retries
- long-lived keyed agents instead of ad hoc background processes
- supervision, exit relationships, and passivation from the runtime itself
- explicit waits, signals, pubsub, and child execution
- subprocess-heavy work with durable artifacts
- inspectable execution timelines instead of opaque background jobs

Vilano Runtime is a `0.x` release with a focused support path and a tested core execution model.

## What It Is

Vilano Runtime has three main pieces:

- **BEAM kernel**
  - durable state, leases, waits, retries, signals, service inboxes, relationship semantics,
    supervision policy, passivation state, and managed worker supervision
- **JS/TS workers**
  - replay workflows and service turns, execute agent behavior, run in-process `step()` logic,
    run durable subprocesses through `exec()`, and stay disposable underneath the kernel
- **CLI**
  - local operator surface for bootstrapping the daemon, registering projects, starting runs,
    inspecting timelines, and delivering signals

The simplest mental model is:

- BEAM owns truth and coordination
- JS/TS owns agent behavior
- workers are disposable
- services are durable keyed agents
- workflows orchestrate and supervise them

For OSS `0.1`, Vilano Runtime runs as a local daemon with:

- single-machine
- SQLite-backed
- loopback-only coordination plane
- per-runtime access token under `VILANO_HOME`

By default, installed runtime payloads are intended to live under `~/.vilano/installs`, while
mutable runtime state lives under `~/.vilano/state`.

Vilano Runtime uses a local single-user trust model. See
[docs/trust-model.md](./docs/trust-model.md) for the canonical runtime posture.

Vilano Runtime is released under the [Apache-2.0 License](./LICENSE).

## Current Capabilities

- workflows with replay-from-the-top semantics
- services that behave like durable keyed agents
- services with durable inboxes and typed `send` / `ask` / `signal`
- durable `step`, `exec`, `sleep`, `waitForSignal`, `spawn`, and `connect`
- durable `monitor`, `link`, `trapExit`, and `nextExit`
- kernel-owned workflow supervision groups with restart budgets
- explicit mailbox inspection plus `defer()` / `reject()`
- bounded service inboxes and overload rejection
- explicit service passivation / wake-on-message state
- singleton discovery and supervision-group inspection
- durable topic pubsub with dedupe and restart persistence
- kernel-scheduled retries with fixed, linear, or exponential backoff plus jitter
- cancellation propagation across waits, child runs, service asks, and subprocesses
- managed-worker hard-stop fallback for timed blocking steps
- `run inspect` and `run replay` for durable operator visibility
- packaged local install flow with immutable runtime payloads under the managed install root
  and mutable state under `VILANO_HOME`

## Supported Path

Vilano Runtime `0.1` ships with:

- BEAM kernel
- TypeScript SDK
- Bun CLI
- Bun managed worker
- local SQLite-backed runtime home

Managed workers supervised by the kernel get hard-stop fallback for blocking timed steps. External
workers currently rely on cooperative in-process step cancellation.

The current support posture is documented in [docs/support-matrix.md](./docs/support-matrix.md).

## Start Here

- [First-Run Walkthrough](./docs/first-run.md)
- [Support Matrix](./docs/support-matrix.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Trust Model](./docs/trust-model.md)

## Quick Start

### Install The Runtime

```bash
curl -fsSL https://runtime.vilano.ai/install.sh | bash
export PATH="$HOME/.vilano/bin:$PATH"
vilano version
vilano doctor
```

The installer writes the managed launcher to `~/.vilano/bin/vilano`. Add `~/.vilano/bin` to your
`PATH` once, then use bare `vilano`. Install Bun `1.3.10+` from [bun.sh](https://bun.sh/) before
running `bun add @vilano/runtime` or authoring Vilano Runtime projects. `install.sh` and
`vilano update` both default to the stable channel. Alternate release channels can be selected
with `VILANO_RELEASE_CHANNEL`.

### Create A Runnable Starter

```bash
mkdir vilano-starter
cd vilano-starter
vilano init . --starter
bun add @vilano/runtime
vilano project add . --name vilano-starter
vilano workflow list --project vilano-starter
vilano service list --project vilano-starter
vilano run start vilano-starter/reviewCoordinator --input '{"repoId":"repo_123","note":"Ship 0.1"}'
```

The starter writes an explicit `vilano.manifest.json`, a minimal TypeScript workflow/service pair,
and a local `package.json`. `project add` and `run start` will start the runtime if it is not
already running. The starter path is the intended fastest route from install to a running agent
system.

Inspect the resulting run and service:

```bash
vilano run inspect <run-id>
vilano run replay <run-id>
vilano service ask vilano-starter/reviewer status --service-key repo_123 --wait-timeout 30s
```

### Bring An Existing Repo Under Vilano Runtime

Add the SDK, then generate and review an explicit manifest:

```bash
cd /path/to/project
bun add @vilano/runtime
vilano init .
vilano project add . --name my-project
vilano workflow list --project my-project
```

`vilano init` without `--starter` scans an existing TS/JS project and writes an explicit manifest
starting point. Review that manifest before relying on it, especially if your definitions use
non-trivial export patterns.

Registration validates the manifest contract, paths, and declared export names, then imports the
declared definitions from the pinned snapshot to prove definition identity before registration
completes. Activation still re-validates the same identity when the worker imports the module.

Because of that, treat `vilano project add` and `vilano project sync` as trusted local-code steps.
If your project has top-level module side effects, registration can trigger them.

### Repo Checkout And Examples

For contributor and repo-checkout workflows, see [docs/development.md](./docs/development.md).
`bootstrap-demo` is the canonical richer example in the repo. For smaller reference projects, see
[`examples/multi-agent-demo`](./examples/multi-agent-demo),
[`examples/approval-loop-demo`](./examples/approval-loop-demo), and
[`examples/fanout-demo`](./examples/fanout-demo).

Release-prep and distribution work is documented in [docs/releases.md](./docs/releases.md) and
[docs/distribution.md](./docs/distribution.md).

## Programming Model

### Workflow

```ts
import { workflow } from "@vilano/runtime";

export const planner = workflow({
  name: "planner",
  run: async (input: { topic: string }, ctx) => {
    const research = await ctx.step(
      "research",
      async () => ({ topic: input.topic, sources: 3 }),
      { retry: { retries: 1, backoff: "50ms" } }
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

### Service Agent

```ts
import { service } from "@vilano/runtime";

export const reviewer = service({
  name: "reviewer",
  key: (input: { repoId: string }) => input.repoId,

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

### Agent Runtime Primitives

These are part of the current TypeScript surface:

- `ctx.monitor(...)`
- `ctx.link(...)`
- `ctx.trapExit()`
- `ctx.nextExit()`
- `ctx.supervise(...)`
- `ctx.mailbox()`
- `ctx.defer(...)`
- `ctx.reject(...)`
- `ctx.publish(...)`
- `ctx.subscribe(...)` / `ctx.unsubscribe(...)`
- `ctx.lookupSingleton(...)`

## Execution Semantics

Vilano recovery reruns workflow or service-turn orchestration code from the top against durable
kernel state until the next incomplete operation boundary.

That gives JS/TS BEAM-like operational semantics from the outside while keeping the kernel as the
durable source of truth.

Durable boundaries:

- `ctx.step()`
- `ctx.exec()`
- `ctx.sleep()`
- `ctx.waitForSignal()`
- `ctx.spawn()` / `child.result()`
- `ctx.connect()` and service `send` / `ask` / `signal`
- relationship waits such as `ctx.nextExit()`

### `step()` vs `exec()`

Use `step()` for short, replayable in-process logic.

Use `exec()` when the work should be:

- an actual subprocess
- killable by the runtime
- observable through stdout/stderr/artifacts
- isolated from the worker process

### Cancellation and Timeouts

`step()` is cooperative first. Inside a step callback you can use:

- `step.signal`
- `step.checkCancelled()`
- `await step.yield()`

For managed workers, the kernel also has a hard-stop fallback for timed, non-cooperative blocking
steps. For unmanaged workers, cancellation and timeout remain durable, but the kernel cannot kill
the external worker process.

### Retries

Retries are kernel-scheduled and durable for:

- steps
- execs
- service turns

If a failure should never retry, throw `nonRetryable(...)`.

## Documentation

- [Docs index](./docs/README.md)
- [Architecture](./docs/architecture.md)
- [Support matrix](./docs/support-matrix.md)
- [Development guide](./docs/development.md)
- [Operations guide](./docs/operations.md)
- [Manifest guide](./docs/manifests.md)
- [Protocol guide](./docs/protocol.md)
- [Release notes guide](./docs/releases.md)
- [Protocol artifacts](./protocol/README.md)
- [Test coverage](./tests/README.md)
- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Code of conduct](./CODE_OF_CONDUCT.md)

## Repository Layout

- [kernel/](./kernel) — BEAM kernel and durable agent coordination plane
- [cli/](./cli) — Bun-based operator CLI
- [sdk/typescript/](./sdk/typescript) — TypeScript SDK
- [worker/](./worker) — shared JS/TS worker core and runtime-specific entrypoints
- [examples/](./examples) — reference project definitions and demos
- [protocol/](./protocol) — versioned transport contract
- [tests/](./tests) — integration and soak coverage

## Running the Checks

```bash
bun run typecheck
direnv exec . bun run test:kernel
direnv exec . bash -lc 'cd kernel && mix compile'
direnv exec . bun run test
direnv exec . bun run smoke:install
```

## Notes

Long-form design exploration still lives under `spec/` and is intentionally ignored by git. The
tracked docs in `docs/` describe the codebase and support posture as it exists in the repository.
