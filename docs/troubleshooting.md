# Troubleshooting

This page is the short operator-facing path for the most likely first-release issues.

## `vilano` Is Not Found

If you installed through `install.sh`, the launcher lives at:

```bash
~/.vilano/bin/vilano
```

Either use that full path or add `~/.vilano/bin` to your `PATH`.

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

## Preview Node Worker Confusion

Node worker support is still preview.

- Bun worker path: supported
- Node worker path: preview

If you are validating the supported OSS path, use the Bun worker runtime.

## Install Or Update Problems

Check:

```bash
vilano version
vilano update --check
vilano doctor
```

The public installer and `vilano update` both default to the stable channel. Preview installs are
opt-in through `VILANO_RELEASE_CHANNEL=preview`.

## Still Unsure

Use these in order:

- [Support Matrix](./support-matrix.md)
- [Trust Model](./trust-model.md)
- [Operations Guide](./operations.md)
- [Release Notes Guide](./releases.md)
