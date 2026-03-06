# Tests

This directory holds Bun-driven integration coverage for the local runtime.

Current coverage:

- workflow cancellation while waiting on `sleep`
- parent/child cancellation propagation
- workflow-to-service ask cancellation propagation
- active `exec()` cancellation
- workflow replay after worker loss and lease expiry
- service turn replay after worker loss and lease expiry
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

Run it from the dev shell:

- `bun test tests --timeout 30000 --max-concurrency 1`
- `VILANO_KERNEL_NO_COMPILE=1 bun test tests --timeout 30000 --max-concurrency 1`

Next high-value additions:

- longer-running soak coverage across repeated daemon restarts
- restart coverage for richer retry-policy combinations
- higher-volume service mailbox / turn sequencing coverage
