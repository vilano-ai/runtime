# Vilano Runtime

Vilano Runtime is a TypeScript-first durable execution runtime with an Elixir/BEAM reliability
kernel.

This repository is intentionally scaffolded to match the current v1 architecture work:

- `kernel/`: Elixir runtime kernel and supervision tree
- `sdk/typescript/`: TypeScript authoring surface
- `worker/node/`: local Node worker
- `cli/`: daemon-backed CLI
- `protocol/`: shared protocol and schema notes
- `docs/`: tracked project documentation
- `examples/`: runnable examples as the implementation grows
- `tests/`: integration and fault-injection coverage later

Working design notes live under `spec/` and are ignored by git on purpose.

## Current State

This is a bootstrap scaffold, not a working runtime. The repo now reflects the agreed shape so the
next implementation milestones can land into a coherent structure instead of starting from an empty
tree.

## Near-Term Build Order

1. Local daemon and project registry.
2. Kernel event store, reducers, and run creation.
3. Worker activation lease loop.
4. Workflow replay plus `step()` boundary.
5. CLI `project`, `run`, and `replay` flows.
6. Service identity, inbox, and `ask` / `send`.
7. Managed `exec()` and artifact capture.
