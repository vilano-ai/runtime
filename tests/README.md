# Tests

This directory holds Bun-driven integration coverage for the local runtime.

There are two main test modes:

- `bun run test` for the normal integration suite
- `bun run test:soak` for the longer mixed-traffic churn run
- `bun run smoke:install` for package/install verification outside the repo layout

Current coverage:

- workflow cancellation while waiting on `sleep`
- parent/child cancellation propagation
- workflow-to-service ask cancellation propagation
- active `exec()` cancellation
- workflow replay after worker loss and lease expiry
- service turn replay after worker loss and lease expiry
- lease fencing that rejects stale workflow completions after expiry
- implicit durable key generation for repeated steps, execs, and child spawns
- durable step retry/backoff
- durable exec retry/backoff
- durable service-turn retry/backoff
- explicit non-retryable failures bypassing retries
- retry-family filtering for steps, execs, and service turns
- exponential retry backoff scheduling
- capped and jittered retry backoff scheduling
- durable signal delivery, including buffered signals before first activation
- sleep wait durability across daemon restart
- signal wait durability across daemon restart
- service state durability across daemon restart
- repeated daemon restarts across retry waits with capped jittered backoff
- repeated daemon restarts across service backlogs and lease recovery
- mixed workflow/service traffic across repeated daemon restarts and managed-worker churn
- exec stdout/stderr/artifact capture on success
- exec timeout persistence with captured failure artifacts
- `run replay` workflow timeline rendering
- `run replay --json` service turn timeline projection
- replay coverage for wait/signal and retry-backoff timelines
- inspect/replay retry-series projections with cap and jitter details
- inspect/replay visibility for retry decisions
- cooperative step cancellation that releases the worker
- cooperative step timeout persistence for run and step failure state
- kernel-enforced timeout for non-cooperative blocking steps
- kernel-enforced timeout for non-cooperative blocking service turns
- managed-worker kill/restart on cancellation of non-cooperative blocking steps
- unmanaged-worker fallback for non-cooperative blocking service turns
- service FIFO processing across mixed `ask` / `send` backlogs
- `service stop` failing queued backlog behind an active turn
- service ask correlation isolation across concurrent caller runs
- handler-triggered service stop draining queued backlog
- Node worker parity for unmanaged and managed JS worker paths

Run it from the dev shell:

- `bun run test`
- `VILANO_KERNEL_NO_COMPILE=1 bun test tests/integration.test.ts --timeout 30000 --max-concurrency 1`
- `VILANO_TEST_TIMING=1 bun test tests/integration.test.ts -t "<test name>" --timeout 30000 --max-concurrency 1`
- `bun run test:soak`

Next high-value additions:

- longer-running multi-minute soak coverage with repeated worker churn
- higher-volume service mailbox / turn sequencing coverage
- restart coverage for broader mixed workflow/service traffic
