# Tests

This directory holds Bun-driven integration coverage for the local runtime.

Current coverage:

- workflow cancellation while waiting on `sleep`
- parent/child cancellation propagation
- workflow-to-service ask cancellation propagation
- active `exec()` cancellation
- workflow replay after worker loss and lease expiry
- service turn replay after worker loss and lease expiry
- durable signal delivery, including buffered signals before first activation
- exec stdout/stderr/artifact capture on success
- exec timeout persistence with captured failure artifacts
- cooperative step cancellation that releases the worker
- cooperative step timeout persistence for run and step failure state
- kernel-enforced timeout for non-cooperative blocking steps
- managed-worker kill/restart on cancellation of non-cooperative blocking steps

Run it from the dev shell:

- `bun test tests --timeout 30000 --max-concurrency 1`

Next high-value additions:

- service-turn coverage for kernel-enforced hard-stop on non-cooperative blocking steps
- hard-stop semantics for externally managed workers
