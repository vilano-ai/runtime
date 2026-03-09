# Protocol

This directory holds the shared transport contract between:

- the Elixir kernel
- the Bun worker
- the CLI / kernel client surface

Current v1 artifacts live under [v1](./v1):

- [meta.json](./v1/meta.json)
- [worker.openapi.yaml](./v1/worker.openapi.yaml)
- [control.openapi.yaml](./v1/control.openapi.yaml)
- [semantics.md](./v1/semantics.md)

The transport is still:

- HTTP over loopback
- JSON request/response bodies
- explicit RPCs for activation leasing and durable operation resolution

The OpenAPI files document the wire surface. The semantics doc captures the behavioral rules that the wire format alone does not express.
