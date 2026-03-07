# Examples

`bootstrap-demo/` is the current runnable example project.

It serves two purposes:

- first-run workflow and service examples for the local runtime
- richer fixture coverage for integration and soak tests

Use it with the local CLI:

```bash
./cli/bin/vilano.ts project add ./examples/bootstrap-demo --name demo
./cli/bin/vilano.ts workflow list
./cli/bin/vilano.ts service list
```

The canonical first-run definitions are documented in `examples/bootstrap-demo/README.md`. The rest of the exported definitions are mostly durability and failure fixtures used by the test suite.
