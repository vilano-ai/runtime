import type { RuntimeAdapter } from "./runtime-adapter.ts";
import type { WorkerClient, ServiceTurnActivation } from "./client.ts";
import type {
  AskResult,
  ServiceDefinition,
  SignalResult,
} from "./runtime-sdk.ts";
import { createTurnContext } from "./workflow-context.ts";
import { hasOwnState } from "./turn-context-helpers.ts";

export async function executeServiceTurn(
  adapter: RuntimeAdapter,
  client: WorkerClient,
  activation: ServiceTurnActivation,
  definition: ServiceDefinition<any, any, any, any, any>,
  activationCwd: string
): Promise<void> {
  const ctx = createTurnContext(adapter, client, activation, activationCwd, definition);
  let state = activation.service.state;
  let shouldCommitState = false;

  if (state == null && definition.init) {
    state = await definition.init(activation.service.keyInput, ctx);
    shouldCommitState = true;
  }

  const envelope = activation.envelope;
  const payload = envelope.payload === null ? undefined : envelope.payload;

  if (envelope.kind === "ask") {
    const handler = definition.onAsk?.[envelope.name];
    if (typeof handler !== "function") {
      throw new Error(`Unknown service ask handler '${envelope.name}' on '${definition.name}'`);
    }

    const result = (await handler(payload, state, ctx)) as AskResult<any, unknown>;
    const nextState = hasOwnState(result) ? result.state : state;

    await client.completeServiceTurn(activation.leaseId, envelope.id, {
      state: shouldCommitState || hasOwnState(result) ? nextState : undefined,
      reply: result.reply,
      stop: result.stop === true,
    });

    return;
  }

  if (envelope.kind === "send") {
    const handler = definition.onSend?.[envelope.name];
    if (typeof handler !== "function") {
      throw new Error(`Unknown service send handler '${envelope.name}' on '${definition.name}'`);
    }

    const result = (await handler(payload, state, ctx)) as
      | void
      | { state?: unknown; stop?: true };
    const nextState = hasOwnState(result) ? result.state : state;

    await client.completeServiceTurn(activation.leaseId, envelope.id, {
      state: shouldCommitState || hasOwnState(result) ? nextState : undefined,
      stop: result?.stop === true,
    });

    return;
  }

  const handler = definition.onSignal?.[envelope.name];
  if (typeof handler !== "function") {
    throw new Error(`Unknown service signal handler '${envelope.name}' on '${definition.name}'`);
  }

  const result = (await handler(payload, state, ctx)) as SignalResult<any>;
  const nextState = hasOwnState(result) ? result.state : state;

  await client.completeServiceTurn(activation.leaseId, envelope.id, {
    state: shouldCommitState || hasOwnState(result) ? nextState : undefined,
    stop: result?.stop === true,
  });
}
