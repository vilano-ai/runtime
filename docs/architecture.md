# Architecture

Vilano Runtime is a local-first BEAM-backed agent runtime with external JavaScript/TypeScript
workers today.

## Runtime Layers

### 1. BEAM Kernel

The Elixir side is the durable agent kernel. It owns:

- persistent runtime state
- worker leasing and lease fencing
- waits, timers, and signal routing
- service inbox state and one-turn-at-a-time service semantics
- run relationships, exit events, and supervision policy
- singleton discovery and pubsub fanout
- retries, cancellation, and managed-worker hard-stop escalation
- the loopback HTTP API used by the CLI and workers

Primary modules:

- [runtime_supervisor.ex](../kernel/lib/vilano_kernel/runtime_supervisor.ex)
- [router.ex](../kernel/lib/vilano_kernel/router.ex)
- [storage.ex](../kernel/lib/vilano_kernel/storage.ex)
- [storage/activation_lifecycle.ex](../kernel/lib/vilano_kernel/storage/activation_lifecycle.ex)
- [storage/agent_relationships.ex](../kernel/lib/vilano_kernel/storage/agent_relationships.ex)
- [storage/agent_topology.ex](../kernel/lib/vilano_kernel/storage/agent_topology.ex)
- [storage/failure_recovery.ex](../kernel/lib/vilano_kernel/storage/failure_recovery.ex)
- [storage/service_ops.ex](../kernel/lib/vilano_kernel/storage/service_ops.ex)
- [storage/supervision.ex](../kernel/lib/vilano_kernel/storage/supervision.ex)
- [managed_worker.ex](../kernel/lib/vilano_kernel/managed_worker.ex)

### 2. Worker Protocol

The kernel/worker boundary is HTTP + JSON. The transport contract is versioned under
[protocol/v1](../protocol/v1).

The protocol is deliberately smaller than the SDK surface. It covers:

- activation leasing
- durable op resolution and completion
- service turn completion/failure
- waits, retries, cancellation, and compatibility checks

Behavioral rules that the wire format does not express live in
[protocol/v1/semantics.md](../protocol/v1/semantics.md).

### 3. JS/TS Worker Core

The worker replays orchestration code from the top and resolves durable operations through the
kernel. It executes agent behavior, but it is not the source of truth.

The shared core lives in:

- [worker/shared/src/core.ts](../worker/shared/src/core.ts)
- [worker/shared/src/workflow-context.ts](../worker/shared/src/workflow-context.ts)
- [worker/shared/src/service-refs.ts](../worker/shared/src/service-refs.ts)
- [worker/shared/src/service-turn.ts](../worker/shared/src/service-turn.ts)
- [worker/shared/src/runtime-utils.ts](../worker/shared/src/runtime-utils.ts)
- [worker/shared/src/definitions.ts](../worker/shared/src/definitions.ts)

The current shared core is runtime-neutral enough to run under Bun or Node through small runtime
entry/adapters.

### 4. Language SDK

The public authoring model is currently TypeScript-first:

- [sdk/typescript/src/index.ts](../sdk/typescript/src/index.ts)

This layer defines `workflow()`, `service()`, `step()`, `exec()`, `spawn()`, `connect()`,
relationship primitives, supervision, mailbox controls, discovery, and pubsub.

### 5. CLI

The CLI is an operator/client surface, not the runtime brain. It:

- starts/stops the local daemon
- manages the local project registry
- renders inspect/replay views
- invokes control-plane endpoints
- separates packaged runtime payloads from mutable runtime state

Primary modules:

- [cli/src/index.ts](../cli/src/index.ts)
- [cli/src/daemon-client.ts](../cli/src/daemon-client.ts)
- [cli/src/output.ts](../cli/src/output.ts)
- [cli/src/run-views](../cli/src/run-views)

## Control Flow

### Workflow Run

1. `vilano run start` asks the kernel to create a run record.
2. A managed or external worker leases an activation from the kernel.
3. The worker loads the workflow definition from the project manifest.
4. The worker replays the workflow from the top.
5. Durable operations (`step`, `exec`, `sleep`, `waitForSignal`, `spawn`) resolve through the
   kernel.
6. If the run must wait, the worker suspends and releases control back to the kernel.
7. The kernel wakes the run later via timer, signal, child completion, or retry schedule.
8. The worker replays again until the run completes or fails.

This is why workflows are durable orchestration, not long-lived in-memory coordinators.

### Service Turn

1. A workflow, service, or external CLI call enqueues a service envelope.
2. The kernel leases one service turn at a time for that service instance.
3. A worker loads the service definition and replays the handler turn.
4. The turn either:
   - commits reply/state and completes
   - suspends on a durable wait
   - fails and may retry depending on policy
5. The kernel preserves service inbox ordering and state across churn.

This is what makes services behave like durable keyed agents instead of plain request handlers.

## Ownership Boundaries

### What the Kernel Owns

- truth and recovery state
- version/schema compatibility checks
- retries and retry scheduling
- timers and signals
- monitors, links, exit notifications, and supervision state
- passivation and mailbox policy
- cancellation propagation
- managed worker lifecycle

### What the Worker Owns

- loading user code
- replaying orchestration
- running in-process `step()` logic
- spawning subprocesses for `exec()`

### What the CLI Owns

- user-facing command grammar
- local daemon bootstrap
- human-friendly inspect/replay rendering

## Coupling

### Loosely Coupled

- kernel to worker transport
- kernel to CLI transport
- managed worker runtime choice inside the JS/TS family

### Tightly Coupled Today

- TypeScript/JavaScript definition execution
- manifest generation, which still discovers definitions by scanning JS/TS source
- JS/TS replay semantics in the worker core

This is why the runtime is now JS-runtime-neutral enough for Bun and Node, but not yet polyglot at
the language SDK level. The current manifest/runtime contract is still explicitly JS/TS execution
oriented even though the long-term direction is broader.

## Current Module Shape

Recent refactors intentionally pushed the biggest hotspots into domain modules:

- `VilanoKernel.Storage` is now a thin facade over activation lifecycle, failure/recovery, service
  ops, supervision, relationships, topology, and support layers
- worker authoring/runtime logic is now split between workflow context construction, service turn
  execution, process/retry/error helpers, and the worker loop
- inspect/replay rendering and runtime harness logic are no longer concentrated in single files

The remaining larger files are mostly real domain surfaces rather than unstructured buckets.
Further decomposition should continue by responsibility, not by line count alone.
