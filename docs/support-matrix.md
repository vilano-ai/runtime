# Support Matrix

This document describes the current OSS runtime support posture. It is intentionally conservative.

## Current Positioning

Vilano is currently a local-first durable execution runtime for a single machine with a BEAM kernel
and external JavaScript/TypeScript workers.

## Supported Today

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

- Bun worker runtime
- Node worker runtime on the `node-worker` line of development

Both currently share the same JS/TS worker core and protocol.

### CLI / Operations

- Bun-first CLI entrypoint
- local project registry
- packaged runtime bundle materialized under `VILANO_HOME`
- `run inspect`, `run replay`, `doctor`, `version`, and smoke-install flow

## Preview / Evolving

- Node worker support should still be treated as preview until it has the same release/CI posture as
  the Bun path.
- Protocol artifacts exist and are versioned, but generated clients/types are not yet the primary
  implementation path.
- Project manifests are generated and cached, but generation still depends on JS/TS source scanning.

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

That is different from simply adding another JS runtime adapter.
