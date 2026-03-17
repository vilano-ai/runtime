# First-Run Walkthrough

This is the fastest end-to-end path for evaluating Vilano Runtime as a durable runtime for
building agent systems.

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
export PATH="$HOME/.vilano/bin:$PATH"
vilano version
vilano doctor
```

This walkthrough assumes you add `~/.vilano/bin` to `PATH` once up front. Install Bun `1.3.10+`
from [bun.sh](https://bun.sh/) before running `bun add @vilano/runtime` or authoring Vilano
Runtime projects.

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

This starter path is the intended shortest route from install to a running agent system.

## 3. Install Project Dependencies

```bash
bun add @vilano/runtime
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

`project add` validates the explicit manifest, snapshots the project, and imports the declared
definitions from that snapshot to prove definition identity before registration completes. Treat
project registration as a trusted local-code step.

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
