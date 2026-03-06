# Kernel

The Elixir kernel owns durable state, activation leasing, routing, timers, and recovery.

This directory is intentionally minimal for now. The first real implementation work should land in:

- event store and reducers
- runtime supervisor tree
- activation scheduler
- local daemon-facing control API
