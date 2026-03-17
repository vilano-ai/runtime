# Troubleshooting

This page is the short operator-facing path for the most likely first-release issues.

## `vilano` Is Not Found

If you installed through `install.sh`, add the managed launcher to your shell:

```bash
export PATH="$HOME/.vilano/bin:$PATH"
```

The launcher itself lives at `~/.vilano/bin/vilano`.

## `doctor` Reports Missing Local State

Run:

```bash
vilano doctor
vilano doctor --fix
```

`doctor --fix` is the mutating path. It prepares missing runtime-local state without rewriting a
healthy packaged bundle.

## The Daemon Will Not Start

Start with:

```bash
vilano daemon status
vilano daemon start
```

If startup still fails:

- check whether another Vilano daemon is already running
- check whether the configured port is already taken
- confirm the runtime home is writable

`daemon status` should report runtime version, protocol version, schema version, and the runtime
database path once the daemon is healthy.

## `project add` Fails

Common causes:

- the project is missing an explicit `vilano.manifest.json`
- the manifest points outside the project root
- a declared export does not exist
- a declared definition kind/name does not match the exported object

Recommended recovery path:

```bash
vilano init /path/to/project
vilano project add /path/to/project --name <project>
```

If you are starting from an empty directory, use `vilano init /path/to/project --starter` instead.
Make sure Bun `1.3.10+` is installed before running `bun add @vilano/runtime`.

Then review [Manifest Guide](./manifests.md) if the project uses non-trivial exports.

## A Run Looks Stuck

Use:

```bash
vilano run inspect <run-id>
vilano run replay <run-id>
```

`run inspect` shows current durable state. `run replay` shows the timeline, including waits,
signals, retries, child runs, and service turns.

If the run is waiting, the runtime may be behaving correctly and expecting:

- a signal
- a service reply
- a sleep wake-up
- a child result

For long-lived services, inspect output also shows passivation and queued mailbox state so you can
tell whether the agent is idle, waiting, or overloaded without guessing from process liveness.

## Install Or Update Problems

Check:

```bash
vilano version
vilano update --check
vilano doctor
```

The public installer and `vilano update` both default to the stable channel. Alternate release
channels are selected with `VILANO_RELEASE_CHANNEL`.

## Still Unsure

Use these in order:

- [Support Matrix](./support-matrix.md)
- [Trust Model](./trust-model.md)
- [Operations Guide](./operations.md)
