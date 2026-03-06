# Protocol

This directory is reserved for shared protocol artifacts between:

- the Elixir kernel
- the Node worker
- the CLI / daemon control plane

The current v1 direction is:

- JSON message bodies
- local HTTP transport
- explicit RPCs for activation leasing and durable operation resolution

The authoritative design notes currently live under `spec/`.
