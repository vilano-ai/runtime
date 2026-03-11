# Examples

The repo now has two kinds of example projects:

- focused reference examples meant to teach one clear pattern
- `bootstrap-demo/`, which still doubles as first-run material and as a richer fixture source for
  integration and soak tests

Together they show the current agent-runtime surface: coordinator workflows, durable keyed
services, signals, fanout, supervision, mailbox behavior, discovery, and pubsub.

Use it with the local CLI:

```bash
./cli/bin/vilano.ts project add ./examples/bootstrap-demo --name demo
./cli/bin/vilano.ts workflow list
./cli/bin/vilano.ts service list
```

Reference examples:

- `multi-agent-demo/`
  Canonical BEAM-backed agent-runtime example using multiple durable services plus a coordinator
  workflow.
- `approval-loop-demo/`
  Minimal signal-driven durable coordination example.
- `fanout-demo/`
  Minimal child-workflow fanout and supervision-oriented example.

Fixture-heavy example:

- `bootstrap-demo/`
  Canonical first-run definitions plus many durability, failure, cancellation, and replay fixtures.
