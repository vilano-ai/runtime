# Vilano CLI

`vilano` is the local operator surface for Vilano Runtime.

Current commands cover:

- daemon lifecycle
- project registry management
- workflow definition discovery
- run start / inspect / replay / cancel
- service ensure / inspect / send / ask / signal / stop

The CLI talks to the local BEAM kernel and is intended to run with Bun.

Useful root-level checks:

- `bun run check`
- `bun run pack`
