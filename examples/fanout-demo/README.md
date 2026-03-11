# Fanout Demo

`fanout-demo` is the smallest child-workflow fanout example in the repo.

It shows:

- a coordinator workflow spawning multiple child workflows
- durable child result collection
- a simple report built from parallel slices

Try it from the repo root:

```bash
./cli/bin/vilano.ts daemon start
./cli/bin/vilano.ts project add ./examples/fanout-demo --name fanout
./cli/bin/vilano.ts run start fanout/parallelReport --input '{"topic":"release checklist"}'
```
