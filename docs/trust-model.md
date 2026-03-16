# Trust Model

Vilano Runtime is a durable runtime for building agent systems.

This document is the canonical OSS trust posture for the current codebase.

For OSS `0.1`, the supported release path is local-first and single-machine.

## Trust Boundary

Vilano Runtime is packaged and documented for:

- a single OS user
- a local machine
- a loopback-only daemon
- project code that the local operator has chosen to register and run

Code already running as the same OS user is inside the practical trust boundary.

## Runtime Protections

For the supported release path, the runtime provides:

- a loopback-only HTTP coordination plane
- a per-runtime token under `VILANO_HOME`
- separation between immutable packaged runtime payloads and mutable runtime state
- pinned project snapshots for registered projects before the worker runs them
- a kernel-owned coordination plane instead of userland-only agent state

The token and loopback binding reduce blind localhost access by unrelated local processes.

## Project Registration And Execution

Project registration is a trusted local-code step.

`vilano project add` and `vilano project sync`:

1. validate the manifest contract, paths, and export-name syntax
2. materialize a pinned project snapshot
3. import the declared definitions from that snapshot to prove export identity before registration completes

That means registration executes project module imports from the pinned snapshot. Activation
re-validates the same definition identity later when the worker imports the activation module.

If a project module has top-level side effects, registration can trigger them. Register and run
code you trust as the current OS user.

## Operator Guidance

- do not expose the daemon as a network service
- treat local token auth as part of the local runtime boundary, not as a sandbox
- register and run only code you trust as the current OS user
- keep the runtime posture framed as local-first and single-machine in public docs and release notes
