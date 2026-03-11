# Contributing to Vilano Runtime

Thanks for contributing.

## Before You Start

Vilano is currently a `0.x` local-first BEAM-backed agent runtime. Please read these first:

- [README.md](./README.md)
- [docs/support-matrix.md](./docs/support-matrix.md)
- [docs/development.md](./docs/development.md)
- [docs/protocol.md](./docs/protocol.md)
- [docs/manifests.md](./docs/manifests.md)

Contributions should preserve the core model:

- the BEAM kernel owns durable truth and coordination
- workers execute user code and agent behavior
- protocol and manifest changes are release-facing changes

## Development Setup

```bash
direnv allow
bun install
./cli/bin/vilano.ts doctor --fix
```

Common checks:

```bash
bun run typecheck
bun run check:manifest
bun run check:protocol
direnv exec . bun run test:kernel
direnv exec . bun run test
direnv exec . bun run smoke:install
```

## What to Include in a Change

For runtime changes, include:

- tests for the new behavior or regression
- docs updates when user-facing behavior changes
- protocol or manifest updates when contracts change

For release-facing changes, keep the support matrix and release guidance in sync:

- [docs/support-matrix.md](./docs/support-matrix.md)
- [docs/releases.md](./docs/releases.md)

## Pull Requests

Please keep pull requests scoped and explain:

- what changed
- why it changed
- how it was verified
- whether protocol, manifest, or support-matrix behavior changed

If a change is intentionally preview-only, say that explicitly.

## Design Expectations

Please avoid:

- adding new public primitives without a strong semantic reason
- moving user-code execution into the kernel
- widening the support matrix casually
- treating fallback manifest discovery as a long-term foundation

## Security

If you believe you found a security issue, do not open a public issue first. See
[SECURITY.md](./SECURITY.md).
