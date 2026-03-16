# First-Run Walkthrough

This is the fastest end-to-end path for evaluating Vilano Runtime as a local BEAM-backed agent
runtime.

It proves six things in one pass:

- packaged install works
- a runnable starter project can be created locally
- project registration succeeds
- a workflow run completes durably
- a keyed service stores and returns durable state
- inspect and replay work from the operator surface

## 1. Install Vilano Runtime

```bash
curl -fsSL https://runtime.vilano.ai/install.sh | bash
~/.vilano/bin/vilano version
~/.vilano/bin/vilano doctor
```

If you want bare `vilano`, add `~/.vilano/bin` to your `PATH`.

## 2. Create A Starter Project

```bash
mkdir vilano-starter
cd vilano-starter
vilano init . --starter
```

`vilano init --starter` writes a minimal TypeScript project with:

- an explicit `vilano.manifest.json`
- a `reviewCoordinator` workflow
- a `reviewer` keyed service

## 3. Install Project Dependencies

```bash
bun add @vilano/runtime
```

If you installed Vilano under the default root and want to use the bundled Bun binary instead of a
host Bun install, you can run:

```bash
~/.vilano/current/bun/bun add @vilano/runtime
```

## 4. Register The Project And Start A Run

```bash
vilano project add . --name vilano-starter
vilano workflow list --project vilano-starter
vilano service list --project vilano-starter
vilano run start vilano-starter/reviewCoordinator --input '{"repoId":"repo_123","note":"Ship 0.1"}'
```

Copy the returned run id.

`project add` and `run start` will start the local runtime automatically if it is not already
running.

## 5. Inspect And Replay The Run

```bash
vilano run inspect <run-id>
vilano run replay <run-id>
```

`run inspect` shows the current durable state. `run replay` renders the durable timeline for the
workflow and service interaction.

## 6. Ask The Created Service

The workflow writes one note into the `reviewer` service keyed by `repo_123`.

```bash
vilano service ask vilano-starter/reviewer status --service-key repo_123 --wait-timeout 30s
vilano service inspect vilano-starter/reviewer --service-key repo_123
```

You should see a reply that includes `repoId`, `noteCount`, and the stored notes.

## 7. Clean Up

```bash
vilano daemon stop
```

## Next Steps

For a fuller repo-checkout example, use [`examples/bootstrap-demo`](../examples/bootstrap-demo).
For smaller focused references, use [`examples/multi-agent-demo`](../examples/multi-agent-demo),
[`examples/approval-loop-demo`](../examples/approval-loop-demo), and
[`examples/fanout-demo`](../examples/fanout-demo).

## If Something Fails

Start with:

```bash
vilano doctor
vilano daemon status
```

Then use [Troubleshooting](./troubleshooting.md) and [Operations Guide](./operations.md).
