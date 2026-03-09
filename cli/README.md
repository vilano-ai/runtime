# Vilano CLI

`vilano` is the local operator surface for Vilano Runtime.

Current commands cover:

- `version`
- `doctor [--fix]`
- daemon lifecycle
- project registry management
- workflow definition discovery
- run start / inspect / replay / cancel
- service ensure / inspect / send / ask / signal / stop

The CLI talks to the local BEAM kernel and is intended to run with Bun. Worker processes can be launched under Bun or Node with `vilano worker start --runtime <bun|node>`.

The local kernel is loopback-only and protected with a per-runtime token stored under `VILANO_HOME`, which the CLI and managed workers pass automatically.

Useful root-level checks:

- `bun run check`
- `bun run pack`
- `bun run smoke:install`

Useful operator commands:

- `vilano version`
- `vilano doctor --fix`
- `vilano daemon status`
- `vilano run replay <run-id>`

When installed from a package, the CLI resolves a bundled runtime payload from `runtime-dist/`. In a repo checkout it falls back to the local `kernel/` and `worker/` directories.
