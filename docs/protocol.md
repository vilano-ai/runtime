# Protocol Guide

Vilano Runtime has two versioned transport surfaces:

- **worker protocol**
  - kernel-to-worker activation leasing and durable operation resolution
- **control protocol**
  - CLI/operator requests to the local kernel

Both are currently HTTP+JSON over loopback and both live under [protocol/v1](../protocol/v1).

## Files

- [worker.openapi.yaml](../protocol/v1/worker.openapi.yaml)
- [control.openapi.yaml](../protocol/v1/control.openapi.yaml)
- [semantics.md](../protocol/v1/semantics.md)
- [meta.json](../protocol/v1/meta.json)

## How The Repo Uses Them

- The shared JS/TS worker client imports generated transport types from
  [protocol/v1/generated/worker.ts](../protocol/v1/generated/worker.ts).
- The CLI daemon client imports generated status metadata from
  [protocol/v1/generated/control.ts](../protocol/v1/generated/control.ts).
- `bun run generate:protocol` regenerates those files from the OpenAPI artifacts.
- `bun run check:protocol` fails if the generated types are out of date.

The OpenAPI files describe the wire format. The semantics document is the behavioral contract:

- replay from the top
- durable key resolution
- lease fencing
- wait and suspension rules
- retry decisions
- cancellation semantics
- service turn guarantees
- relationship, supervision, mailbox, discovery, and pubsub semantics where the routes expose them

Do not change the OpenAPI files without changing the semantics document when the meaning of the
runtime changes.

## Contributor Workflow

If you change a protocol-facing route or payload:

1. update the relevant OpenAPI file under [protocol/v1](../protocol/v1)
2. update [semantics.md](../protocol/v1/semantics.md) if the behavior changes
3. run `bun run generate:protocol`
4. run `bun run check:protocol`
5. update or add protocol contract coverage in
   [tests/protocol-contract.test.ts](../tests/protocol-contract.test.ts)

## Example Worker Integration

The worker integration loop is:

1. `POST /v1/activations/lease`
2. inspect the activation kind and lease metadata
3. resolve durable operations through `/v1/leases/{leaseId}/...`
4. suspend by returning durable waits to the kernel
5. complete or fail the lease explicitly

The shared worker core in [worker/shared](../worker/shared) is the reference implementation for
this flow.

## Versioning

Protocol changes are release-facing. Each release should state:

- runtime version
- protocol version
- manifest version if it changed
- compatibility notes for CLI and workers

See [Release Notes Guide](./releases.md) for the required release note sections.
