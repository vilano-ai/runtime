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
- [Protocol](../protocol/README.md)
  - Versioned transport artifacts for the kernel control plane and worker protocol.
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
6. Read [Protocol](../protocol/README.md) before changing kernel/worker or CLI/kernel wire
   contracts.
