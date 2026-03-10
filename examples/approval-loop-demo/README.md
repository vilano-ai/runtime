# Approval Loop Demo

`approval-loop-demo` is the smallest signal-driven workflow example in the repo.

It shows:

- a workflow that drafts work durably
- a workflow that waits for an external approval signal
- the operator path for resuming a waiting run

Try it from the repo root:

```bash
./cli/bin/vilano.ts daemon start
./cli/bin/vilano.ts project add ./examples/approval-loop-demo --name approval
./cli/bin/vilano.ts run start approval/approvalLoop --input '{"topic":"release notes"}'
./cli/bin/vilano.ts signal send <run-id> approved --input '{"by":"operator"}'
```
