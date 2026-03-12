# TypeScript SDK

The TypeScript SDK is the flagship authoring surface today for Vilano Runtime's BEAM-backed agent
kernel.

It gives you two durable definition types:

- `workflow()` for orchestration and supervision
- `service()` for durable keyed, inbox-driven agent execution

The runtime itself is not intended to be TypeScript-only forever. This SDK is simply the most
complete authoring surface in the current OSS release.

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

JS/TS gets BEAM-like operational semantics from the runtime kernel. It does not become BEAM in
process memory, and it does not own the durable coordination truth.

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

Supported retry families today:

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

## Limits

- no arbitrary JS stack capture
- no exact-once side-effect guarantee
- hard-stop fallback only for managed workers the kernel supervises
- TypeScript is the flagship SDK today; other language SDKs are future work

See [docs/architecture.md](../../docs/architecture.md) and
[docs/support-matrix.md](../../docs/support-matrix.md) for the broader runtime context.
