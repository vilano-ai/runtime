# Kernel

The kernel is the durable control plane for Vilano Runtime.

It runs on Elixir/BEAM and currently owns:

- run and service state
- durable event storage
- activation leasing
- timer scheduling
- signal routing
- child-run wakeups
- service inboxes and one-turn-at-a-time service execution
- managed local worker supervision
- hard-stop escalation for timed, stuck managed workers

## What the Kernel Does

The kernel is the source of truth. Bun workers do not own workflow state.

At a high level:

1. The CLI or a worker calls the kernel HTTP API.
2. The kernel persists runs, events, waits, steps, execs, service envelopes, and child lineage.
3. The kernel grants leases to workers.
4. Workers replay TypeScript orchestration and call back into the kernel for durable boundaries.
5. The kernel wakes suspended runs when timers fire, signals arrive, children finish, or service replies commit.

## Managed vs Unmanaged Workers

Managed local workers are supervised by the kernel.

That lets the kernel:

- restart workers automatically
- kill a worker that is stuck in a timed blocking step
- kill a worker immediately on cancellation when needed

Unmanaged workers still work, but the kernel cannot terminate their OS process. In that mode, the kernel falls back to durable failure/cancellation plus lease recovery.

## Storage Model

The kernel currently persists durable runtime state in SQLite.

Important tables include:

- `runs`
- `run_events`
- `run_steps`
- `run_execs`
- `run_waits`
- `run_children`
- `service_runs`
- `service_envelopes`
- `run_service_ops`
- `run_signals`

The event log is the durable timeline. The relational tables act as current-state projections and scheduling indexes.

## Current API Surface

The kernel exposes a local HTTP API used by:

- the CLI
- Bun workers

That API currently supports:

- project registration and sync
- workflow start/list/inspect/cancel
- service ensure/inspect/send/ask/signal/stop
- activation lease/heartbeat/complete/fail
- step/exec/wait/service-turn resolution and completion

`run replay` is currently implemented in the CLI as a projection over `run inspect` data rather than as a kernel-native endpoint.

## Important Semantics

- The kernel never resumes arbitrary JavaScript stack frames.
- Replay happens by rerunning orchestration from the top against durable state.
- Retries are kernel-scheduled, not worker-local loops.
- Waits and signals are durable state, not in-memory promises.
- Service turns are processed one at a time per service instance in v1.
