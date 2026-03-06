# Tests

This directory holds Bun-driven integration coverage for the local runtime.

Current coverage:

- workflow cancellation while waiting on `sleep`
- parent/child cancellation propagation
- workflow-to-service ask cancellation propagation
- active `exec()` cancellation

Run it from the dev shell:

- `bun test tests --timeout 30000 --max-concurrency 1`

Next high-value additions:

- workflow replay after worker loss
- service turn lease-expiry recovery
- durable signal delivery
- subprocess timeout and artifact capture
