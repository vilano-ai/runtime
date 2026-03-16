# Docs

Tracked documentation in this directory is the stable, contributor-facing description of the
runtime as it exists in git.

Longer design notes still live under `spec/`, which is intentionally ignored by git.

## Index

- [Architecture](./architecture.md)
  - Runtime layers, control flow, ownership boundaries, and how the BEAM kernel shapes agent semantics.
- [First-Run Walkthrough](./first-run.md)
  - Canonical install-to-replay evaluation path for the repo and packaged runtime.
- [Support Matrix](./support-matrix.md)
  - Supported path, worker runtimes, operating systems, and runtime model.
- [Development Guide](./development.md)
  - Repo layout, local commands, manifest/protocol boundaries, and contributor expectations.
- [Operations Guide](./operations.md)
  - Runtime home layout, daemon lifecycle, health checks, and operator-facing commands.
- [Troubleshooting](./troubleshooting.md)
  - Likely first-release operator failures and the shortest recovery path for each.
- [Trust Model](./trust-model.md)
  - Canonical local trust boundary and operator guidance.
- [Manifest Guide](./manifests.md)
  - Explicit project manifest contract and generated cache behavior.
- [Distribution](./distribution.md)
  - Runtime install layout, mutable state layout, and the intended packaged install model.
- [Protocol Guide](./protocol.md)
  - Versioned transport artifacts, generated transport types, and contributor workflow for
    protocol changes.
- [Release Notes Guide](./releases.md)
  - What each release note should say about support matrix, protocol version, and manifest
    compatibility.
  - Release bodies live under `docs/release-notes/`.
- [Debut Release Checklist](./debut-release-checklist.md)
  - High-signal pre-release checklist for the first public Vilano Runtime launch.
- [Tests](../tests/README.md)
  - Integration and soak coverage, including restart/churn expectations.

## Reading Order

1. Start with the top-level [README](../README.md) for install and first-run usage.
2. Read [First-Run Walkthrough](./first-run.md) to see the canonical evaluator path.
3. Read [Architecture](./architecture.md) to understand the kernel/worker/CLI split and the agent-kernel model.
4. Read [Support Matrix](./support-matrix.md) before changing packaging, worker runtimes, or
   release posture.
5. Read [Development Guide](./development.md) before refactoring core modules or changing the
   contributor workflow.
6. Read [Operations Guide](./operations.md) before changing daemon, runtime-home, or install
   behavior.
7. Read [Troubleshooting](./troubleshooting.md) before changing first-run or operator-facing failure behavior.
8. Read [Trust Model](./trust-model.md) before changing local auth, daemon exposure, registration
   behavior, or product security posture.
9. Read [Manifest Guide](./manifests.md) before changing project registration or discovery.
10. Read [Distribution](./distribution.md) before changing packaged install, runtime materialization,
   or update behavior.
11. Read [Protocol Guide](./protocol.md) before changing kernel/worker or CLI/kernel wire
   contracts.
12. Read [Release Notes Guide](./releases.md) before cutting a release or changing compatibility
   expectations.
13. Read [Debut Release Checklist](./debut-release-checklist.md) before the first public launch.
