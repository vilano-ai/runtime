# Support Matrix

This document describes the supported OSS release path for Vilano Runtime.

## Canonical Release Path

Vilano Runtime `0.1` ships as:

- Bun CLI
- TypeScript SDK
- BEAM kernel
- Bun managed worker
- local SQLite-backed runtime home

## Runtime Components

### Kernel

- Elixir / BEAM kernel
- SQLite-backed durable state
- loopback-only HTTP coordination plane
- per-runtime access token under `VILANO_HOME`

### Authoring

- TypeScript SDK in [sdk/typescript](../sdk/typescript)
- workflows
- services as durable keyed agents
- durable `step`, `exec`, `sleep`, `waitForSignal`, `spawn`, and `connect`
- durable `monitor`, `link`, `trapExit`, and `nextExit`
- workflow supervision groups
- mailbox controls, passivation state, discovery, and pubsub

### Worker Runtime

- Bun worker runtime

### CLI / Operations

- Bun-first CLI entrypoint
- local project registry
- packaged runtime bundle materialized under the managed install root when the daemon starts
- `run inspect`, `run replay`, `doctor`, `version`, and smoke-install flow

### Operating Systems

Supported for the canonical release path:

- macOS Apple Silicon (`darwin-arm64`)
- Linux x86_64 (`linux-x64`)

## CI Enforcement

The repo CI enforces the supported release path directly:

- supported path jobs run on `ubuntu-latest` and `macos-latest`
- Bun CLI + TypeScript SDK + BEAM kernel + Bun worker is the required passing path
- `bun run check:launch` is the local pre-release gate
- `Launch Gate` is the heavier GitHub Actions pre-release gate

If the supported release path changes, the CI matrix should change with it.

## Operational Model

Vilano Runtime is documented and packaged as:

- local-first
- single-machine
- single-user runtime home
- loopback-only daemon
- immutable installed runtime payloads plus mutable runtime state

See [Trust Model](./trust-model.md) for the canonical runtime boundary and operator guidance.

## Managed vs External Workers

- managed workers supervised by the kernel get hard-stop fallback for timed blocking steps
- external/manual workers participate through the same protocol and rely on durable
  failure/cancellation plus lease recovery
