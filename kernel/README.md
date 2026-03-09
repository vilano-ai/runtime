# Kernel

The kernel is the durable control plane for Vilano Runtime.

It runs on Elixir/BEAM and owns:

- runtime metadata and schema state
- durable runs, events, waits, steps, execs, and child lineage
- service instances and service inboxes
- activation leasing and lease fencing
- retry scheduling
- timers and signals
- managed worker supervision

## Responsibility Boundary

The kernel owns durable truth.

Workers do **not** own workflow or service truth; they lease an activation, replay orchestration,
and resolve durable operations back through the kernel.

That split is the core of the runtime:

- kernel = coordination, durability, supervision
- worker = execution

## Main Modules

- [lib/vilano_kernel/runtime_supervisor.ex](./lib/vilano_kernel/runtime_supervisor.ex)
- [lib/vilano_kernel/router.ex](./lib/vilano_kernel/router.ex)
- [lib/vilano_kernel/storage.ex](./lib/vilano_kernel/storage.ex)
- [lib/vilano_kernel/managed_worker.ex](./lib/vilano_kernel/managed_worker.ex)
- [lib/vilano_kernel/wait_manager.ex](./lib/vilano_kernel/wait_manager.ex)
- [lib/vilano_kernel/step_deadline_manager.ex](./lib/vilano_kernel/step_deadline_manager.ex)

Recent decompositions:

- [lib/vilano_kernel/router/support.ex](./lib/vilano_kernel/router/support.ex)
- [lib/vilano_kernel/router/run_views.ex](./lib/vilano_kernel/router/run_views.ex)
- [lib/vilano_kernel/storage/read_models.ex](./lib/vilano_kernel/storage/read_models.ex)
- [lib/vilano_kernel/storage/projects.ex](./lib/vilano_kernel/storage/projects.ex)
- [lib/vilano_kernel/storage/runtime_metadata.ex](./lib/vilano_kernel/storage/runtime_metadata.ex)
- [lib/vilano_kernel/storage/retry_policy.ex](./lib/vilano_kernel/storage/retry_policy.ex)
- [lib/vilano_kernel/storage/service_lifecycle.ex](./lib/vilano_kernel/storage/service_lifecycle.ex)

## Storage Model

The current kernel uses SQLite for durable state.

It tracks:

- schema migrations
- runtime metadata
- run/event timelines
- current-state projections and scheduling indexes

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
