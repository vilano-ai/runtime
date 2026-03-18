# Vilano CLI

`vilano` is the local operator surface for Vilano Runtime.

Vilano Runtime is built by Vilano.

It is responsible for:

- bootstrapping the local daemon
- managing the project registry
- resolving workflow and service definitions
- starting runs and talking to services
- rendering inspect and replay output
- packaging and smoke-install validation

The CLI is intentionally a client of the kernel, not a second runtime authority. It should make
the durable agent-system model visible and operable, not hide it behind ad hoc client logic.

## Runtime Assumptions

- Bun-first CLI entrypoint
- loopback-only kernel connection
- per-runtime access token loaded from `VILANO_HOME`
- repo mode and packaged-install mode

When running from an installed package, the CLI materializes the bundled runtime payload under the
managed install root when the daemon actually needs to start. Read-only commands such as `version`
and `doctor` do not mutate the installed package tree. When the packaged bundle already contains a
ready kernel release, `doctor --fix` does not fetch Hex deps or rewrite the installed bundle.

Vilano Runtime uses a local single-user trust model. See
[docs/trust-model.md](../docs/trust-model.md) for the canonical runtime posture.

## Important Commands

These examples assume `vilano` is on `PATH` and Bun `1.3.10+` is installed. Install Bun from
[bun.sh](https://bun.sh/) before running the starter path.

```bash
vilano version
vilano update --check
vilano update
vilano rollback
vilano doctor
vilano init ./my-agent --starter
cd my-agent && bun add @vilano/runtime
vilano project add . --name my-agent
vilano run start my-agent/reviewCoordinator --input '{"repoId":"repo_123","note":"Ship 0.1"}'
vilano run explain <run-id>
vilano run inspect <run-id>
vilano run replay <run-id>
vilano service ask my-agent/reviewer status --service-key repo_123 --wait-timeout 30s
vilano service history my-agent/reviewer --service-key repo_123
```

Project-local defaults can live in `vilano.toml`:

```toml
[runtime]
port = 4141
execution_home = ".vilano/execution"

[project]
env_file = ".env"
```

The CLI discovers the nearest `vilano.toml` from the current working directory upward and maps it
into the existing runtime env knobs before command execution. Shell env vars still win.

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
  - explicit manifest helpers and generated fallback support
- [src/runtime-materializer.ts](./src/runtime-materializer.ts)
  - packaged runtime bundle materialization

## Managed Updates

The CLI targets the canonical local release path built around the managed install layout.

The current release-management surface is intentionally small:

- `vilano version`
  - reports the installed runtime payload and running kernel, if any
- `vilano update --check`
  - checks release metadata and reports whether a newer runtime is available for the current platform
- `vilano update`
  - downloads and installs the selected runtime release into the managed install root
- `vilano rollback`
  - switches the managed install back to the previous installed version

`vilano update` and `vilano rollback` operate on the managed install layout under `~/.vilano`
and are designed around the same install metadata contract used by the packaged smoke path.

Release-prep and distribution work is documented in [docs/releases.md](../docs/releases.md) and
[docs/distribution.md](../docs/distribution.md).

For OSS `0.1`, explicit `vilano.manifest.json` files are the recommended path. Use
`vilano init --starter` for a runnable new project, or plain `vilano init` to bootstrap a manifest
for an existing TS/JS repo. Review generated manifests before relying on them for non-trivial
export patterns. `vilano project add` and `vilano project sync` import the declared definitions
from the pinned snapshot to validate export identity before the registration completes, so treat
registration as a trusted local-code step.
