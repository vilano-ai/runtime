# Vilano Protocol Semantics v1

These semantics are authoritative for the current kernel, CLI, and JavaScript/TypeScript workers.

## Core Rules

- The kernel is the durable source of truth.
- Workers do not resume arbitrary language stacks. They replay orchestration from the top.
- Durable boundaries are resolved by key from kernel state.
- A stale or expired lease cannot complete or fail work.

## Worker Runtime Boundary

- The kernel protocol is HTTP+JSON and is intentionally runtime-neutral.
- The current reference worker implementations are JavaScript/TypeScript workers that execute under Bun or Node.
- Runtime-specific concerns such as subprocess launching, event-loop yielding, and process lifecycle should stay behind a worker runtime adapter.
- Language-specific SDKs must preserve these semantics even if their authoring APIs differ.

## Workflow Execution

- A workflow activation grants one lease to one worker.
- The worker reruns the workflow definition until it reaches the next unresolved durable operation.
- `step`, `exec`, `sleep`, `waitForSignal`, `spawn`, `child.result`, and service `send`/`ask`/`signal` are durable boundaries.
- If a boundary is already complete in storage, replay returns the stored result instead of re-executing it.

## Suspension

- `sleep`, `waitForSignal`, pending child results, pending service ask replies, and retry backoff suspend the activation.
- Suspension is a durable kernel decision.
- A suspended activation yields its lease and later becomes leaseable again.

## Service Turns

- A service instance processes one inbox envelope at a time.
- One active service turn holds one lease.
- `ask` replies and service state updates commit together.
- `stop` transitions reject new inbox work and drain/fail queued work durably.

## Definition Metadata

- Project manifests identify definitions by kind, name, file, export name, source language, and runtime kind.
- The current manifest/runtime pair is `sourceLanguage=typescript` and `runtimeKind=javascript`.
- Future worker families may add additional runtime kinds without changing the kernel control model.

## Retries

- Retry scheduling is a kernel decision.
- Workers report failure metadata, retry family, and retryability.
- The kernel persists the retry decision, wake time, and backoff series.
- `nonRetryable` failures bypass retries immediately.

## Cancellation

- `run cancel` and `service stop` are kernel-owned control decisions.
- Cancellation propagates durably through waits, child runs, and service asks.
- Managed workers may be hard-killed by the kernel if a timed step or cancelled activation remains stuck.
- Unmanaged workers cannot be force-killed by the kernel, but their leases and durable state are still failed/cancelled.

## Trust Model

- The local daemon is loopback-only.
- Requests require the per-runtime token under `VILANO_HOME`.
- This is a local capability boundary, not a sandbox against fully trusted code running as the same user.
