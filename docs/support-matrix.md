# Support Matrix

This document describes the current OSS runtime support posture. It is intentionally conservative.

## Current Positioning

Vilano Runtime is currently a local-first durable execution runtime for a single machine with a BEAM kernel
and external JavaScript/TypeScript workers.

## Supported Today

### Canonical OSS v1 Path

The canonical path for the first OSS release is:

- Bun CLI
- TypeScript SDK
- BEAM kernel
- Bun managed worker
- local SQLite-backed runtime home

### Kernel

- Elixir / BEAM kernel
- SQLite-backed local durable state
- loopback-only HTTP control plane
- per-runtime access token under `VILANO_HOME`

### Authoring

- TypeScript SDK in [sdk/typescript](../sdk/typescript)
- workflows
- services
- durable `step`, `exec`, `sleep`, `waitForSignal`, `spawn`, `connect`

### Worker Runtimes

- Bun worker runtime: supported
- Node worker runtime: preview

Both currently share the same JS/TS worker core and protocol. Additional worker languages are not
part of the current OSS support matrix.

### CLI / Operations

- Bun-first CLI entrypoint
- local project registry
- packaged runtime bundle materialized under the managed install root when the daemon starts
- `run inspect`, `run replay`, `doctor`, `version`, and smoke-install flow

### Operating Systems

Supported for the canonical OSS v1 path:

- macOS Apple Silicon (`darwin-arm64`)
- Linux x86_64 (`linux-x64`)

Windows is not part of the supported matrix today.

## CI Enforcement

The repo CI is expected to enforce this matrix directly:

- supported path jobs run on `ubuntu-latest` and `macos-latest`
- Bun CLI + TypeScript SDK + BEAM kernel + Bun worker is the required passing path
- Node worker coverage runs as a separate preview job
- the heavier pre-release gate is `bun run check:launch`
- the heavier GitHub Actions pre-release gate is `Launch Gate`

If the support matrix changes, the CI matrix should change with it.

## Preview / Evolving

- Node worker support should still be treated as preview until it has the same release and support
  posture as the Bun path.
- Protocol artifacts exist and are versioned, but generated clients/types are not yet the primary
  implementation path.
- Explicit `vilano.manifest.json` files are the recommended project contract for OSS `0.1`.
- Generated cache and regex fallback remain compatibility paths for TS/JS repos and should not be
  treated as the preferred release path.

## Not Supported Yet

- hosted/cloud runtime
- multi-node clustering
- exact-once side-effect guarantees
- language-native SDKs beyond TypeScript
- unmanaged worker hard-stop guarantees
- fully language-neutral manifest generation
- permanent backwards-compatibility promises across pre-1.0 releases

## Operational Assumptions

- local-first
- single-user runtime home
- the daemon is not a network service
- local token auth reduces blind localhost access, but does not claim strong isolation against fully
  trusted code running as the same user

See [Trust Model](./trust-model.md) for the canonical description of these assumptions.

## Release Guidance

The correct OSS posture for the current codebase is:

- `0.x`
- preview/alpha language
- explicit support matrix in release notes
- no implied hosted or multi-tenant guarantees

## What Needs to Change for Broader Runtime Support

To support additional worker languages without weakening the current model:

1. keep the BEAM kernel as the stable durable core
2. keep the protocol artifacts authoritative
3. make manifests fully language-neutral
4. add per-language SDK + worker implementations that obey the same replay semantics

## Managed vs External Workers

- managed workers supervised by the kernel get hard-stop fallback for blocking timed steps
- external/manual workers only get cooperative in-process step cancellation today
- that difference is intentional in the current `0.x` support posture

That is different from simply adding another JS runtime adapter.
