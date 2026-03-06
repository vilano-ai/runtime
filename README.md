# Vilano Runtime

Vilano Runtime is a TypeScript-first durable execution runtime with an Elixir/BEAM reliability
kernel.

This repository is intentionally scaffolded to match the current v1 architecture work:

- `kernel/`: Elixir runtime kernel and supervision tree
- `sdk/typescript/`: TypeScript authoring surface
- `worker/bun/`: local Bun worker
- `cli/`: Bun CLI and local kernel client
- `protocol/`: shared protocol and schema notes
- `docs/`: tracked project documentation
- `examples/`: runnable examples as the implementation grows
- `tests/`: integration and fault-injection coverage later

Working design notes live under `spec/` and are ignored by git on purpose.

## Current State

This is an early bootstrap, not a full runtime. The repo now has a real split between a BEAM-owned
control plane in `kernel/` and Bun-based SDK / CLI surfaces instead of treating Bun as the runtime
owner.

The JavaScript/TypeScript surfaces are Bun-first: Bun runs `.ts` entrypoints directly and the CLI
uses `#!/usr/bin/env bun`. The control plane is intended to live in the BEAM kernel, with Bun
responsible for authoring, local manifest discovery, and worker execution.

## Dev Shell

This repo now includes a Nix flake and `direnv` integration.

1. Run `direnv allow`.
2. Run `bun install`.
3. Run `cd kernel && mix local.hex --force && mix local.rebar --force`.
4. Run `cd kernel && mix deps.get`.

After that, entering the repo should give you:

- `bun`
- `elixir`, `mix`, `iex`
- `hex`, `rebar3`
- `sqlite3`, `pkg-config`, and a C toolchain for `ecto_sqlite3` / `exqlite`

The shell also prepends `node_modules/.bin` to `PATH`, so local tools like `tsc` resolve without
extra setup.

`MIX_HOME` and `HEX_HOME` are pinned inside the repo (`.mix/` and `.hex/`) so the kernel toolchain
does not inherit stale user-level Hex archives compiled against the wrong OTP version.

## Near-Term Build Order

1. BEAM kernel project/run API plus durable storage.
2. Bun worker activation lease loop.
3. Workflow replay plus `step()` boundary.
4. CLI `project`, `run`, and `replay` flows backed by the kernel.
5. Service identity, inbox, and `ask` / `send`.
6. Managed `exec()` and artifact capture.
