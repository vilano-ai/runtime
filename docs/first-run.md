# First-Run Walkthrough

This is the fastest end-to-end path for evaluating Vilano Runtime as a BEAM-backed agent runtime.

It proves five things in one pass:

- packaged install works
- the daemon starts cleanly
- project registration succeeds
- a multi-agent workflow run completes durably
- inspect/replay and service inspection work from the operator surface

## Prerequisites

- macOS Apple Silicon or Linux x86_64
- Bun installed for the repo checkout
- git installed

## 1. Install Vilano Runtime

```bash
curl -fsSL https://runtime.vilano.ai/install.sh | bash
~/.vilano/bin/vilano version
~/.vilano/bin/vilano doctor
```

If you want bare `vilano`, add `~/.vilano/bin` to your `PATH`.

## 2. Get The Demo Project

```bash
git clone https://github.com/vilano-ai/runtime.git
cd runtime
bun install
```

This walkthrough uses the checked-in `multi-agent-demo` project because it exercises both
coordinator workflows and long-lived agent services.

## 3. Start The Daemon

```bash
~/.vilano/bin/vilano daemon start
~/.vilano/bin/vilano daemon status
```

Confirm that `daemon status` reports a runtime version, protocol version, schema version, and
managed worker runtime.

## 4. Register The Demo

```bash
~/.vilano/bin/vilano project add ./examples/multi-agent-demo --name multi-agent
~/.vilano/bin/vilano workflow list --project multi-agent
~/.vilano/bin/vilano service list --project multi-agent
```

You should see `multiAgentCoordinator` plus the three durable agent services.

## 5. Start A Run

```bash
~/.vilano/bin/vilano run start multi-agent/multiAgentCoordinator --input '{"briefId":"brief_123","topic":"launch readiness","audience":"operators"}'
```

Copy the returned run id.

## 6. Inspect And Replay The Run

```bash
~/.vilano/bin/vilano run inspect <run-id>
~/.vilano/bin/vilano run replay <run-id>
```

`run inspect` should show the current durable state. `run replay` should render the timeline of the
coordinator workflow and the agent/service interactions that happened during the run.

## 7. Inspect The Created Services

The workflow creates three keyed services for `brief_123`.

```bash
~/.vilano/bin/vilano service inspect multi-agent/researchAgent --service-key brief_123 --key-json '{"briefId":"brief_123"}'
~/.vilano/bin/vilano service inspect multi-agent/writerAgent --service-key brief_123 --key-json '{"briefId":"brief_123"}'
~/.vilano/bin/vilano service inspect multi-agent/reviewerAgent --service-key brief_123 --key-json '{"briefId":"brief_123"}'
```

You should see persisted service state and completed envelopes.

## 8. Clean Up

```bash
~/.vilano/bin/vilano daemon stop
```

## If Something Fails

Start with:

```bash
~/.vilano/bin/vilano doctor
~/.vilano/bin/vilano daemon status
```

Then use [Troubleshooting](./troubleshooting.md) and [Operations Guide](./operations.md).
