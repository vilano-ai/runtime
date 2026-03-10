# Operations Guide

Vilano Runtime is currently designed as a local runtime on a single machine.

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
`VILANO_HOME`. See [Distribution](./distribution.md) for the intended layout.

## First-Run Health Checks

Use:

```bash
vilano version
vilano doctor
vilano doctor --fix
```

`doctor --fix` only mutates what is missing. For packaged installs that already contain vendored
a ready kernel release, it does not fetch Hex deps or rewrite the packaged bundle. Node is reported
as optional unless you are validating the preview Node worker lane.

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
vilano init /path/to/project
vilano project add /path/to/project --name demo
vilano project sync demo
vilano project inspect demo
```

The registry is machine-local. It is not a remote catalog or package index.
`project add` creates a new registration. If the project name already exists, use `project sync`
to refresh the registered snapshot and definition set. For OSS `0.1`, explicit manifests are the
recommended registration path.

## Operator Commands

### Runs

```bash
vilano run start demo/planner --input '{"topic":"BEAM"}'
vilano run list
vilano run inspect <run-id>
vilano run replay <run-id>
vilano run cancel <run-id>
```

### Services

```bash
vilano service ensure demo/reviewer --service-key repo_123 --key-json '{"repoId":"repo_123"}'
vilano service inspect demo/reviewer --service-key repo_123
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

Use `run inspect` when you want current state.

Use `run replay` when you want the durable timeline, including:

- steps and exec attempts
- waits and resumes
- signals
- child runs
- service turns
- retry decisions and retry series

These views are derived from durable kernel state, not from worker-local memory.

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

The daemon is:

- loopback-only
- guarded by a per-runtime token under `VILANO_HOME`

This is meant to prevent blind localhost access by unrelated local processes. It is not intended as
strong isolation against fully trusted code already running as the same user.

## Upgrade / Compatibility

The runtime now tracks:

- runtime version
- protocol version
- schema version
- applied migrations

CLI and workers reject incompatible kernels up front. Kernel startup applies pending migrations
before serving traffic.
