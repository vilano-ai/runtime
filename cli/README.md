# Vilano CLI

`vilano` is the local operator surface for Vilano Runtime.

It is responsible for:

- bootstrapping the local daemon
- managing the project registry
- resolving workflow and service definitions
- starting runs and talking to services
- rendering inspect and replay output
- packaging and smoke-install validation

The CLI is intentionally a client of the kernel, not a second runtime authority.

## Runtime Assumptions

- Bun-first CLI entrypoint
- loopback-only kernel connection
- per-runtime access token loaded from `VILANO_HOME`
- repo mode and packaged-install mode

When running from an installed package, the CLI materializes the bundled runtime payload under
`VILANO_HOME` before starting the daemon. It does not mutate the installed package tree.

## Important Commands

```bash
vilano version
vilano doctor --fix
vilano daemon start
vilano daemon status
vilano project add /path/to/project --name demo
vilano run start demo/planner --input '{"topic":"BEAM"}'
vilano run inspect <run-id>
vilano run replay <run-id>
vilano service ask demo/reviewer status --key-json '{"repoId":"repo_123"}'
```

## Code Layout

- [src/index.ts](./src/index.ts)
  - command routing and command handlers
- [src/daemon-client.ts](./src/daemon-client.ts)
  - kernel client and daemon bootstrap logic
- [src/output.ts](./src/output.ts)
  - general CLI output helpers
- [src/run-views.ts](./src/run-views.ts)
  - inspect/replay rendering and projections
- [src/registry.ts](./src/registry.ts)
  - project registration and local resolution
- [src/project-manifest.ts](./src/project-manifest.ts)
  - generated manifest support
- [src/runtime-materializer.ts](./src/runtime-materializer.ts)
  - packaged runtime bundle materialization

## Release Notes

The CLI currently supports the Bun-first release path. Bun workers are the supported OSS v1 lane.
Node workers remain preview, the CLI itself remains Bun-oriented today, and non-JS worker
implementations are future work rather than a supported part of the current manifest/runtime story.
