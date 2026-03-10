# Multi-Agent Demo

`multi-agent-demo` is the canonical cooperating-agents example for Vilano Runtime.

It shows:

- three long-lived agent-like services with their own local state
- a coordinator workflow that connects to them through typed service refs
- a simple “research -> draft -> review” handoff across multiple agents

Definitions:

- `multiAgentCoordinator`
  Coordinates the full handoff across the three services.
- `researchAgent`
  Accumulates findings for a brief.
- `writerAgent`
  Stores audience context and produces drafts.
- `reviewerAgent`
  Tracks review notes and approval status.

Try it from the repo root:

```bash
./cli/bin/vilano.ts daemon start
./cli/bin/vilano.ts project add ./examples/multi-agent-demo --name multi-agent
./cli/bin/vilano.ts run start multi-agent/multiAgentCoordinator --input '{"briefId":"brief_123","topic":"runtime hardening","audience":"operators"}'
```
