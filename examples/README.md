# Examples

The repo now has two kinds of example projects:

- focused reference examples meant to teach one clear pattern
- `bootstrap-demo/`, which still doubles as first-run material and as a richer fixture source for
  integration and soak tests

Use it with the local CLI:

```bash
./cli/bin/vilano.ts project add ./examples/bootstrap-demo --name demo
./cli/bin/vilano.ts workflow list
./cli/bin/vilano.ts service list
```

Reference examples:

- `multi-agent-demo/`
  Canonical cooperating-agents example using multiple services plus a coordinator workflow.
- `approval-loop-demo/`
  Minimal signal-driven workflow example.
- `fanout-demo/`
  Minimal child-workflow fanout example.

Fixture-heavy example:

- `bootstrap-demo/`
  Canonical first-run definitions plus many durability, failure, cancellation, and replay fixtures.
