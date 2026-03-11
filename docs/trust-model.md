# Trust Model

Vilano Runtime is currently a local-first `0.x` runtime for a single machine.

This document is the canonical OSS trust posture for the current codebase.

## Scope

Vilano Runtime currently assumes:

- a single OS user
- a local machine
- a loopback-only daemon
- project code that the local operator has chosen to register and run

It is not a hosted or multi-tenant system today.

## What The Runtime Does Protect

For the current OSS path, the runtime provides:

- a loopback-only HTTP control plane
- a per-runtime token under `VILANO_HOME`
- separation between immutable packaged runtime payloads and mutable runtime state
- pinned project snapshots for registered projects before the worker runs them

The token and loopback binding are meant to reduce blind localhost access by unrelated local
processes.

## What The Runtime Does Not Claim

Vilano Runtime does not currently claim:

- strong isolation from arbitrary code running as the same OS user
- a sandbox boundary against trusted local code
- hosted/cloud tenancy guarantees
- multi-node trust guarantees
- exact-once side-effect guarantees

If code is already running as the same user, it is inside the practical trust boundary.

## Project Registration And Execution

Project registration is a trusted local-code step.

Today, `vilano project add` and `vilano project sync`:

1. validate the manifest contract, paths, and export-name syntax
2. materialize a pinned project snapshot
3. import the declared definitions from that snapshot to prove export identity before registration completes

That means registration now executes project module imports from the pinned snapshot. Activation
still re-validates the same definition identity later when the worker imports the activation module.

If a project’s module top level has side effects, registration can trigger them. For the current
OSS runtime, that is an accepted part of the local trust model rather than a bug in the isolation
story.

## Operator Guidance

- do not expose the daemon as a network service
- do not treat local token auth as a sandbox
- register and run only code you trust as the current OS user
- keep the runtime posture framed as local-first and single-machine in docs and release notes
