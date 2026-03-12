# Kernel

The kernel is the durable BEAM-backed agent kernel for Vilano Runtime.

It runs on Elixir/BEAM and owns:

- runtime metadata and schema state
- durable runs, events, waits, steps, execs, and child lineage
- service instances and service inboxes
- run relationships, exit notifications, and supervision policy
- passivation state, discovery, and pubsub fanout
- activation leasing and lease fencing
- retry scheduling
- timers and signals
- managed worker supervision

## Responsibility Boundary

The kernel owns durable truth.

Workers do **not** own workflow or service truth; they lease an activation, replay orchestration,
and resolve durable operations back through the kernel.

That split is the core of the runtime:

- kernel = coordination, durability, supervision, agent semantics
- worker = execution

Today, TypeScript is the flagship SDK and JS/TS workers are the primary external execution layer,
but the kernel model itself is broader than a single language surface.

## Main Modules

- [lib/vilano_kernel/runtime_supervisor.ex](./lib/vilano_kernel/runtime_supervisor.ex)
- [lib/vilano_kernel/router.ex](./lib/vilano_kernel/router.ex)
- [lib/vilano_kernel/storage.ex](./lib/vilano_kernel/storage.ex)
- [lib/vilano_kernel/storage/activation_lifecycle.ex](./lib/vilano_kernel/storage/activation_lifecycle.ex)
- [lib/vilano_kernel/storage/agent_relationships.ex](./lib/vilano_kernel/storage/agent_relationships.ex)
- [lib/vilano_kernel/storage/agent_topology.ex](./lib/vilano_kernel/storage/agent_topology.ex)
- [lib/vilano_kernel/storage/failure_recovery.ex](./lib/vilano_kernel/storage/failure_recovery.ex)
- [lib/vilano_kernel/storage/service_ops.ex](./lib/vilano_kernel/storage/service_ops.ex)
- [lib/vilano_kernel/storage/supervision.ex](./lib/vilano_kernel/storage/supervision.ex)
- [lib/vilano_kernel/managed_worker.ex](./lib/vilano_kernel/managed_worker.ex)
- [lib/vilano_kernel/wait_manager.ex](./lib/vilano_kernel/wait_manager.ex)
- [lib/vilano_kernel/step_deadline_manager.ex](./lib/vilano_kernel/step_deadline_manager.ex)

Recent decompositions:

- [lib/vilano_kernel/router/support.ex](./lib/vilano_kernel/router/support.ex)
- [lib/vilano_kernel/router/run_views.ex](./lib/vilano_kernel/router/run_views.ex)
- [lib/vilano_kernel/storage/support.ex](./lib/vilano_kernel/storage/support.ex)
- [lib/vilano_kernel/storage/read_models.ex](./lib/vilano_kernel/storage/read_models.ex)
- [lib/vilano_kernel/storage/projects.ex](./lib/vilano_kernel/storage/projects.ex)
- [lib/vilano_kernel/storage/runtime_metadata.ex](./lib/vilano_kernel/storage/runtime_metadata.ex)
- [lib/vilano_kernel/storage/retry_policy.ex](./lib/vilano_kernel/storage/retry_policy.ex)
- [lib/vilano_kernel/storage/service_lifecycle.ex](./lib/vilano_kernel/storage/service_lifecycle.ex)
- [lib/vilano_kernel/storage/service_support.ex](./lib/vilano_kernel/storage/service_support.ex)
- [lib/vilano_kernel/storage/activation_lifecycle/](./lib/vilano_kernel/storage/activation_lifecycle)
- [lib/vilano_kernel/storage/failure_recovery/](./lib/vilano_kernel/storage/failure_recovery)

## Storage Model

The current kernel uses SQLite for durable state.

It tracks:

- schema migrations
- runtime metadata
- run/event timelines
- current-state projections and scheduling indexes
- durable agent lifecycle, mailbox, relationship, and supervision state

`VilanoKernel.Storage` is intentionally now a facade over the transactional write domains rather
than a single monolithic implementation file.

Kernel startup applies pending migrations before serving traffic and exposes runtime/schema metadata
through `/v1/status`.

## Managed vs Unmanaged Workers

Managed workers are supervised by the kernel, which allows:

- automatic restart
- lease-aware lifecycle control
- hard-stop fallback for timed blocking steps

Unmanaged workers still participate through the same protocol, but the kernel cannot terminate their
OS process directly.

## Protocol

The kernel serves a loopback HTTP API used by:

- the CLI
- JS/TS workers

See [protocol/README.md](../protocol/README.md) for the versioned transport artifacts and
[docs/architecture.md](../docs/architecture.md) for the end-to-end control flow.
