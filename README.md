# Vilano Runtime

Vilano Runtime is a local-first durable execution runtime with a BEAM kernel and external
JavaScript/TypeScript workers.

It is built for workflows and long-lived services that need:

- durable replay instead of best-effort retries
- explicit waits, signals, and child execution
- subprocess-heavy work with durable artifacts
- inspectable execution timelines instead of opaque background jobs

Vilano is currently a `0.x` runtime. The core execution model is real and tested, but the project
should still be treated as preview software.

## What It Is

Vilano has three main pieces:

- **BEAM kernel**
  - durable state, leases, waits, retries, signals, service inboxes, and managed worker
    supervision
- **JS/TS workers**
  - replay workflows and service turns, execute in-process `step()` logic, and run durable
    subprocesses through `exec()`
- **CLI**
  - local operator surface for bootstrapping the daemon, registering projects, starting runs,
    inspecting timelines, and delivering signals

The runtime is intentionally local-first today:

- single-machine
- SQLite-backed
- loopback-only control plane
- per-runtime access token under `VILANO_HOME`

By default, installed runtime payloads are intended to live under `~/.vilano/installs`, while
mutable runtime state lives under `~/.vilano/state`.

Vilano does not currently claim strong filesystem isolation from code running as the same OS user.
The OSS `0.x` trust model assumes a local, single-user machine.

Vilano Runtime is released under the [Apache-2.0 License](./LICENSE).

## Current Capabilities

- workflows with replay-from-the-top semantics
- services with durable inboxes and typed `send` / `ask` / `signal`
- durable `step`, `exec`, `sleep`, `waitForSignal`, `spawn`, and `connect`
- kernel-scheduled retries with fixed, linear, or exponential backoff plus jitter
- cancellation propagation across waits, child runs, service asks, and subprocesses
- managed-worker hard-stop fallback for timed blocking steps
- `run inspect` and `run replay` for durable operator visibility
- packaged local install flow with runtime bundle materialization under `VILANO_HOME`
  or the configured install root, depending on packaging mode

## Status

Supported today:

- BEAM kernel
- TypeScript SDK
- Bun CLI
- JS/TS worker core running under Bun, with Node worker support in preview

Not supported yet:

- hosted/cloud mode
- clustering / multi-node scheduling
- language-native SDKs beyond TypeScript
- exact-once side-effect guarantees

Managed workers supervised by the kernel get hard-stop fallback for blocking timed steps. External
workers currently rely on cooperative in-process step cancellation.

The current support posture is documented in [docs/support-matrix.md](./docs/support-matrix.md).

## Quick Start

### From a Repo Checkout

```bash
direnv allow
bun install
./cli/bin/vilano.ts doctor --fix
./cli/bin/vilano.ts daemon start
./cli/bin/vilano.ts project add ./examples/bootstrap-demo --name demo
./cli/bin/vilano.ts workflow list
```

For your own repo, prefer an explicit `vilano.manifest.json`:

```bash
./cli/bin/vilano.ts project init-manifest /path/to/project
```

That generates the manifest from the current TS/JS definitions so registration does not depend on
fallback source scanning.

Start a workflow:

```bash
./cli/bin/vilano.ts run start demo/planner --input '{"topic":"BEAM"}'
./cli/bin/vilano.ts run list
./cli/bin/vilano.ts run inspect <run-id>
./cli/bin/vilano.ts run replay <run-id>
```

Talk to a service:

```bash
./cli/bin/vilano.ts service ensure demo/reviewer --service-key repo_123 --key-json '{"repoId":"repo_123"}'
./cli/bin/vilano.ts service send demo/reviewer hint --service-key repo_123 --input '{"note":"Focus on migrations"}'
./cli/bin/vilano.ts service ask demo/reviewer status --service-key repo_123 --wait-timeout 30s
```

### Packaged Smoke Path

The repo includes a packaged install smoke check:

```bash
bun run check
bun run pack
bun run smoke:install
bun run build:release
bun run smoke:release-install
```

That path packs `vilano`, installs it into a temporary directory, verifies that read-only commands
do not mutate the vendored bundle, verifies `doctor --fix` does not rewrite packaged runtime
contents when a bundled kernel release is already present, checks release metadata through
`vilano update --check`, applies an update into the managed install root, rolls back, starts the
daemon through the managed launcher, and confirms that runtime state is written under `VILANO_HOME`.

The release-distribution path goes one step further:

- `bun run build:release`
  - builds a versioned runtime tarball under `dist/release/`
  - emits `dist/release/release.json`
  - emits `dist/release/install.sh`
- `bun run smoke:release-install`
  - installs that artifact into a clean root using the generated installer
  - verifies the managed launcher layout
  - runs a real workflow from the installed runtime

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

### Service

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

## Execution Semantics

Vilano does **not** capture arbitrary JavaScript stack frames.

Recovery works by rerunning workflow or service-turn orchestration code from the top against durable
kernel state until the next incomplete operation boundary.

Durable boundaries today:

- `ctx.step()`
- `ctx.exec()`
- `ctx.sleep()`
- `ctx.waitForSignal()`
- `ctx.spawn()` / `child.result()`
- `ctx.connect()` and service `send` / `ask` / `signal`

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

- [kernel/](./kernel) — BEAM kernel and durable control plane
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
