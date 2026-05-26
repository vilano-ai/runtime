# Operations Guide

Vilano Runtime `0.1` is a local-first durable runtime for building agent systems.

These examples assume `vilano` is on `PATH` and Bun `1.3.10+` is installed.

## Runtime Home

Vilano Runtime stores mutable runtime state under `VILANO_HOME`.

If `VILANO_HOME` is not set, the default is `~/.vilano/state`.

Vilano Runtime also has an install root for packaged/runtime assets. If `VILANO_INSTALL_ROOT` is not set,
the default install root is `~/.vilano`.

Important contents include:

- runtime database
- daemon pid and state
- access token
- execution/workspace state
- captured exec artifacts

Packaged installs materialize versioned runtime payloads under the install root, not inside
`VILANO_HOME`. See [Distribution](./distribution.md) for the install layout.

## First-Run Health Checks

Use:

```bash
vilano version
vilano doctor
vilano doctor --fix
```

`doctor --fix` only mutates what is missing. For packaged installs that already contain a ready
kernel release, it does not fetch Hex deps or rewrite the packaged bundle.

If first-run commands fail, use [Troubleshooting](./troubleshooting.md).

`version` and `doctor` are read-only. They do not start the daemon. `doctor --fix` is the mutating
path when you want Vilano Runtime to prepare local Mix/Hex state.

## Daemon Lifecycle

```bash
vilano daemon start
vilano daemon status
vilano daemon stop
```

`daemon status` reports:

- runtime version
- protocol version
- schema version
- runtime home
- database path
- managed worker runtime and count
- lease duration
- applied migrations

## Project Registration

Projects are registered locally:

```bash
vilano init /path/to/project --starter
cd /path/to/project
bun add @vilano/runtime
vilano project add . --name demo
vilano project sync demo
vilano project inspect demo
```

The registry is machine-local. It is not a remote catalog or package index.
`project add` creates a new registration. If the project name already exists, use `project sync`
to refresh the registered snapshot and definition set. Explicit manifests are the recommended
registration path. `vilano init --starter` scaffolds a runnable new project. Plain `vilano init`
generates a manifest from source discovery for an existing TS/JS repo, so review it before relying
on it for non-trivial export patterns. Registration validates the manifest contract, paths, and
declared export names, then imports the declared definitions from the pinned snapshot to prove
definition identity before registration completes. Activation still re-validates the same identity
when the worker imports the module later.

Treat `project add` and `project sync` as trusted local-code steps. If a project module has
top-level side effects, registration can trigger them. See [Trust Model](./trust-model.md).

## Project Config

Project-local runtime defaults can live in `vilano.toml`:

```toml
[runtime]
port = 4141
execution_home = ".vilano/execution"
managed_workers = 2
repo_pool_size = 5
sqlite_busy_timeout_ms = 5000

[project]
env_file = ".env"
```

Vilano walks up from the current working directory to find the nearest `vilano.toml`. Use it for
project-owned defaults that you want teammates to share. Shell env vars still take precedence.

## Operator Commands

### Runs

```bash
vilano run start demo/reviewCoordinator --input '{"repoId":"repo_123","note":"Ship 0.1"}'
vilano run list
vilano run explain <run-id>
vilano run inspect <run-id>
vilano run replay <run-id>
vilano run cancel <run-id>
```

### Services

```bash
vilano service ensure demo/reviewer --service-key repo_123 --key-json '{"repoId":"repo_123"}'
vilano service inspect demo/reviewer --service-key repo_123
vilano service history demo/reviewer --service-key repo_123
vilano service ask demo/reviewer status --service-key repo_123 --wait-timeout 30s
vilano service send demo/reviewer hint --service-key repo_123 --input '{"note":"Focus on migrations"}'
vilano service signal demo/reviewer reset --service-key repo_123
vilano service stop demo/reviewer --service-key repo_123
```

### Signals

```bash
vilano signal send <run-id> approved --input '{"by":"operator"}'
```

## Inspect and Replay

Use `run explain` when you want a quick answer about what the run is waiting on, which child work
is still active, and what the current critical path looks like.

Use `run inspect` when you want current state.

Use `run replay` when you want the durable timeline, including:

- steps and exec attempts
- waits and resumes
- signals
- child runs
- service turns
- retry decisions and retry series

These views are derived from durable kernel state, not from worker-local memory.

For services, inspect output now also exposes passivation state, queued mailbox depth, and wake
reasons so operators can reason about long-lived agents without guessing whether a JS worker is
currently live.

For external CLI asks, `--wait-timeout` only controls how long the CLI waits for a reply. Durable
ask timeouts are available inside workflow/service code.

## Managed vs Unmanaged Workers

Managed workers are supervised by the kernel. That allows:

- automatic restart
- lease-aware worker lifecycle
- hard-stop fallback for timed blocking steps

Unmanaged workers are still supported, but the kernel cannot terminate their OS process. In that
case, the runtime falls back to durable failure/cancellation and lease recovery.

## Local Trust Model

See [Trust Model](./trust-model.md) for the canonical OSS posture.

## Upgrade / Compatibility

The runtime now tracks:

- runtime version
- protocol version
- schema version
- applied migrations

CLI and workers reject incompatible kernels up front. Kernel startup applies pending migrations
before serving traffic.
