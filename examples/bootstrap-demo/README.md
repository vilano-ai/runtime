# Bootstrap Demo

`bootstrap-demo` is the example project used for local first-run flows and most runtime verification.

Recommended first-run definitions:

- `planner`
  A bounded workflow that uses `ctx.exec()` and captures an artifact.
- `reviewer`
  A durable service with typed `send` and `ask` handlers.
- `reviewCoordinator`
  A workflow that connects to `reviewer`, sends a hint, asks for status, and completes through the service path.
- `serviceTurnCoordinator`
  A service that exercises service-turn orchestration, including `sleep`, child workflows, and `exec()`.

Most of the other definitions in `src/definitions.ts` are intentional failure, retry, cancellation,
replay, supervision, mailbox, discovery, pubsub, and soak fixtures for the integration suite.

Try it from the repo root:

```bash
./cli/bin/vilano.ts daemon start
./cli/bin/vilano.ts project add ./examples/bootstrap-demo --name demo
./cli/bin/vilano.ts run start demo/planner --input '{"topic":"BEAM"}'
./cli/bin/vilano.ts service ensure demo/reviewer --service-key repo_123 --key-json '{"repoId":"repo_123"}'
./cli/bin/vilano.ts service ask demo/reviewer status --service-key repo_123
```
