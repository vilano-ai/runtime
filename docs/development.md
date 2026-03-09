# Development Guide

This document is for contributors working inside the repo.

## Local Environment

The repository is set up for `direnv` + Nix:

```bash
direnv allow
bun install
./cli/bin/vilano.ts doctor --fix
```

The shell provides:

- Bun
- Node
- Elixir / Mix
- SQLite
- build tooling needed by the kernel dependencies

## Common Commands

```bash
bun run typecheck
direnv exec . bash -lc 'cd kernel && mix compile'
direnv exec . bun run test
direnv exec . bun run smoke:install
```

Other useful checks:

```bash
bun run check
bun run check:protocol
bun run pack
```

## Repository Structure

- [kernel/](../kernel)
  - BEAM kernel, durable storage, timers, leases, routing, managed workers
- [cli/](../cli)
  - Bun CLI, project registry, install/runtime materialization, inspect/replay rendering
- [sdk/typescript/](../sdk/typescript)
  - public TypeScript authoring API
- [worker/shared/](../worker/shared)
  - shared JS/TS worker core
- [worker/bun/](../worker/bun)
  - Bun worker entry/runtime adapter
- [worker/node/](../worker/node)
  - Node worker entry/runtime adapter
- [protocol/](../protocol)
  - versioned transport contract and semantics
- [examples/](../examples)
  - reference project definitions used in smoke and integration tests
- [tests/](../tests)
  - integration and soak coverage

## Current Implementation Boundaries

### Kernel

The kernel owns durable truth. It should remain the source of truth for:

- run and service state
- leases and lease fencing
- waits, retries, and cancellation
- signals and service envelopes
- managed worker supervision

### Worker

The worker owns execution only:

- loading definitions
- replaying orchestration
- running in-process `step()` logic
- spawning `exec()` subprocesses

Do not move user-code execution into the kernel.

### CLI

The CLI should remain a client/operator surface. It should not become a second source of runtime
truth.

## Manifest and Protocol

Project registration now uses a generated manifest under `.vilano/project-manifest.json`.

That manifest is:

- generated during `project add` / `project sync`
- consumed by the runtime during normal operation
- still produced by JS/TS-oriented scanning today

The worker/kernel and CLI/kernel contracts are documented under [protocol/](../protocol/README.md).
Treat those artifacts as release-facing contracts.

## Testing Expectations

If you change runtime semantics, you should usually touch at least one of:

- [tests/integration.test.ts](../tests/integration.test.ts)
- [tests/node-worker.test.ts](../tests/node-worker.test.ts)
- [tests/soak.test.ts](../tests/soak.test.ts)

The current suite already covers:

- cancellation propagation
- replay after worker loss
- retries and retry policy selection
- waits and signals
- service backlog and FIFO semantics
- packaged install smoke

## Current Refactor Priorities

The main maintainability pressure points are still:

- [kernel/lib/vilano_kernel/storage.ex](../kernel/lib/vilano_kernel/storage.ex)
- [kernel/lib/vilano_kernel/router.ex](../kernel/lib/vilano_kernel/router.ex)
- [cli/src/index.ts](../cli/src/index.ts)

Recent refactors have already split out:

- [cli/src/output.ts](../cli/src/output.ts)
- [cli/src/run-views.ts](../cli/src/run-views.ts)
- [worker/shared/src/runtime-utils.ts](../worker/shared/src/runtime-utils.ts)
- [kernel/lib/vilano_kernel/router/support.ex](../kernel/lib/vilano_kernel/router/support.ex)
- [kernel/lib/vilano_kernel/storage/read_models.ex](../kernel/lib/vilano_kernel/storage/read_models.ex)

Continue splitting by responsibility, not just by file size.
