# TypeScript SDK

The TypeScript SDK is the primary authoring surface for Vilano Runtime.

It gives you two durable definition types:

- `workflow()` for orchestration and supervision
- `service()` for durable keyed, inbox-driven agent execution

These examples assume `vilano` is on `PATH` and Bun `1.3.10+` is installed. Install Bun from
[bun.sh](https://bun.sh/) before running the starter path.

## Fastest Start

Generate a runnable starter project with the CLI:

```bash
vilano init ./my-agent --starter
cd my-agent
bun add @vilano/runtime
vilano project add . --name my-agent
vilano run start my-agent/reviewCoordinator --input '{"repoId":"repo_123","note":"Ship 0.1"}'
```

For an existing repo, add the package and generate an explicit manifest:

```bash
bun add @vilano/runtime
vilano init .
```

`vilano project add` and `vilano project sync` import the declared definitions from the pinned
snapshot to validate export identity, so treat project registration as a trusted local-code step.

## Core APIs

Inside workflows and service turns, the runtime context supports:

- `ctx.step(name, fn, options?)`
- `ctx.exec(spec)`
- `ctx.sleep(duration, options?)`
- `ctx.waitForSignal(name, options?)`
- `ctx.spawn(workflow, input, options?)`
- `ctx.connect(service, keyInput, options?)`
- `ctx.log(message, fields?)`
- `ctx.monitor(target, options?)`
- `ctx.link(target, options?)`
- `ctx.trapExit(enabled?)`
- `ctx.nextExit(options?)`
- `ctx.supervise(options)`
- `ctx.mailbox()`
- `ctx.defer(options)`
- `ctx.reject(error)`
- `ctx.lookupSingleton(name, scope?)`
- `ctx.publish(topic, payload, options?)`
- `ctx.subscribe(topic, options?)` / `ctx.unsubscribe(topic, options?)`

Connected services expose typed refs:

```ts
const ref = await ctx.connect(reviewer, { repoId: "repo_123" });
await ref.send.hint({ note: "Focus on migrations" });
const status = await ref.ask.status();
```

## Semantics

The SDK follows the Vilano replay model:

- orchestration replays from the top
- durable operations resolve from history
- arbitrary JavaScript continuation capture is not attempted

JS/TS gets BEAM-like operational semantics from the runtime kernel, while the kernel remains the
durable source of truth.

### `step()`

Use `step()` for short, replayable in-process logic.

Step callbacks receive cooperative control helpers:

- `step.signal`
- `step.checkCancelled()`
- `await step.yield()`

### `exec()`

Use `exec()` for subprocess-heavy work that should be:

- killable
- retryable as a process boundary
- observable through stdout/stderr/artifacts

### Retries

Preferred retry shape:

```ts
retry: {
  retries: 2,
  backoff: { kind: "exponential", initial: "50ms", factor: 2, max: "1s" },
  on: ["application", "timeout"],
}
```

Supported retry families:

- `application`
- `timeout`
- `process_exit`
- `process_spawn`
- `always`

If a failure should bypass retries entirely:

```ts
import { nonRetryable } from "@vilano/runtime";

throw nonRetryable(new Error("invalid input"));
```

## Runtime Notes

- workflows and service turns replay from the top against durable history
- managed workers supervised by the kernel get hard-stop fallback for blocking timed steps
- `step()` is for replayable in-process logic; `exec()` is for subprocess boundaries

See [docs/architecture.md](../../docs/architecture.md) and
[docs/support-matrix.md](../../docs/support-matrix.md) for the broader runtime context.
