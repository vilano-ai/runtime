# Kernel

The Elixir kernel owns durable state, activation leasing, routing, timers, and recovery.

The current bootstrap now aims at a minimal real control plane:

- Bandit/Plug HTTP API on `127.0.0.1`
- SQLite-backed project and run storage
- Bun CLI acting as a client plus local TypeScript manifest scanner

The next kernel milestone after this control-plane cut is activation leasing to Bun workers.
