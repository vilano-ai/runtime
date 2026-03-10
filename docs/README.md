# Docs

Tracked documentation in this directory is the stable, contributor-facing description of the
runtime as it exists in git.

Design exploration and longer product notes still live under `spec/`, which is intentionally
ignored by git.

## Index

- [Architecture](./architecture.md)
  - Runtime layers, control flow, ownership boundaries, and current coupling points.
- [Support Matrix](./support-matrix.md)
  - What is supported today, what is preview/experimental, and what is intentionally out of
    scope for the current OSS runtime.
- [Development Guide](./development.md)
  - Repo layout, local commands, manifest/protocol boundaries, and contributor expectations.
- [Operations Guide](./operations.md)
  - Runtime home layout, daemon lifecycle, health checks, and operator-facing commands.
- [Manifest Guide](./manifests.md)
  - Explicit project manifest contract, generated cache behavior, and the path away from source
    scanning.
- [Distribution](./distribution.md)
  - Runtime install layout, mutable state layout, and the intended packaged install model.
- [Protocol Guide](./protocol.md)
  - Versioned transport artifacts, generated transport types, and contributor workflow for
    protocol changes.
- [Release Notes Guide](./releases.md)
  - What each release note should say about support matrix, protocol version, and manifest
    compatibility.
- [Tests](../tests/README.md)
  - Integration and soak coverage, including restart/churn expectations.

## Reading Order

1. Start with the top-level [README](../README.md) for install and first-run usage.
2. Read [Architecture](./architecture.md) to understand the kernel/worker/CLI split.
3. Read [Support Matrix](./support-matrix.md) before changing packaging, worker runtimes, or
   release posture.
4. Read [Development Guide](./development.md) before refactoring core modules or changing the
   contributor workflow.
5. Read [Operations Guide](./operations.md) before changing daemon, runtime-home, or install
   behavior.
6. Read [Manifest Guide](./manifests.md) before changing project registration or discovery.
7. Read [Distribution](./distribution.md) before changing packaged install, runtime materialization,
   or update behavior.
8. Read [Protocol Guide](./protocol.md) before changing kernel/worker or CLI/kernel wire
   contracts.
9. Read [Release Notes Guide](./releases.md) before cutting a release or changing compatibility
   expectations.
