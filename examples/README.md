# Examples

The repo now has two kinds of example projects:

- focused reference examples meant to teach one clear pattern
- `bootstrap-demo/`, which is the canonical repo-checkout demo plus a richer fixture source for
  integration and soak tests

Together they show the current agent-runtime surface: coordinator workflows, durable keyed
services, signals, fanout, supervision, mailbox behavior, discovery, and pubsub.

For the fastest installed-runtime path, use `vilano init . --starter` instead of cloning an
example. Use the repo examples when you want a richer checkout to read and modify directly.

Use `bootstrap-demo` with the local CLI:

```bash
./cli/bin/vilano.ts project add ./examples/bootstrap-demo --name demo
./cli/bin/vilano.ts run start demo/reviewCoordinator --input '{"repoId":"repo_123","note":"Ship 0.1"}'
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
  Canonical repo-checkout demo plus many durability, failure, cancellation, and replay fixtures.
