# Protocol

This directory is reserved for shared protocol artifacts between:

- the Elixir kernel
- the Bun worker
- the CLI / kernel client surface

The current v1 direction is:

- JSON message bodies
- local HTTP transport
- explicit RPCs for activation leasing and durable operation resolution

The authoritative design notes currently live under `spec/`.
