import type {
  AskOptions,
  DiscoveredServiceRef,
  LinkOptions,
  MessageOptions,
  MonitorOptions,
  RelationshipRef,
  RunStatus,
  ServiceDefinition,
  ServiceRef,
  SignalOptions,
} from "./runtime-sdk.ts";
import { type WorkerClient } from "./client.ts";
import {
  RunSuspendedError,
  parseDurationToMs,
  toServiceAskError,
  toServiceCallError,
} from "./runtime-utils.ts";
import {
  type Activation,
  nextImplicitServiceOpKey,
  scopeActivationOpKey,
  splitPayloadAndOptions,
} from "./turn-context-helpers.ts";

export function createDiscoveredServiceRef(
  client: WorkerClient,
  activation: Activation,
  serviceRunId: string,
  project: string,
  definitionName: string,
  serviceKey: string,
  keyInput: unknown,
  implicitOpCounters: Map<string, number>
): DiscoveredServiceRef {
  return {
    id: serviceRunId,
    project,
    definitionName,
    serviceKey,
    keyInput,
    async send(name: string, payload?: unknown, options?: MessageOptions) {
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "send",
        name,
        options?.key
      );
      const scopedKey = scopeActivationOpKey(activation, key);
      const resolved = await client.resolveServiceSend(activation.leaseId, {
        serviceRunId,
        name,
        key: scopedKey,
        payload: payload ?? null,
      });

      if (resolved.status === "failed") {
        throw toServiceCallError(serviceRunId, name, resolved.error, "send");
      }
    },
    async ask(name: string, payload?: unknown, options?: AskOptions) {
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "ask",
        name,
        options?.key
      );
      const scopedKey = scopeActivationOpKey(activation, key);
      const resolved = await client.resolveServiceAsk(activation.leaseId, {
        serviceRunId,
        name,
        key: scopedKey,
        payload: payload ?? null,
        timeoutMs:
          typeof options?.timeout === "string" ? parseDurationToMs(options.timeout) : undefined,
      });

      if (resolved.status === "completed") {
        return resolved.output;
      }

      if (resolved.status === "failed") {
        throw toServiceAskError(serviceRunId, name, resolved.error);
      }

      throw new RunSuspendedError("ask_reply", `ask_reply:ask:${scopedKey}`);
    },
    async signal(name: string, payload?: unknown, options?: SignalOptions) {
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "signal",
        name,
        options?.key
      );
      const scopedKey = scopeActivationOpKey(activation, key);
      const resolved = await client.resolveServiceSignal(activation.leaseId, {
        serviceRunId,
        name,
        key: scopedKey,
        payload: payload ?? null,
      });

      if (resolved.status === "failed") {
        throw toServiceCallError(serviceRunId, name, resolved.error, "signal");
      }
    },
    async status() {
      return (await client.getRelatedRunStatus(activation.leaseId, serviceRunId)) as RunStatus;
    },
    async monitor(options: MonitorOptions = {}): Promise<RelationshipRef> {
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "monitor",
        serviceRunId,
        options.key
      );
      const scopedKey = scopeActivationOpKey(activation, key);
      const relationship = await client.resolveRunMonitor(activation.leaseId, serviceRunId, {
        key: scopedKey,
      });

      return {
        id: relationship.id,
        targetId: relationship.targetRunId,
        kind: relationship.kind,
      };
    },
    async link(options: LinkOptions = {}): Promise<RelationshipRef> {
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "link",
        serviceRunId,
        options.key
      );
      const scopedKey = scopeActivationOpKey(activation, key);
      const relationship = await client.resolveRunLink(activation.leaseId, serviceRunId, {
        key: scopedKey,
        propagate: options.propagate,
      });

      return {
        id: relationship.id,
        targetId: relationship.targetRunId,
        kind: relationship.kind,
      };
    },
  };
}

export function createServiceRef(
  client: WorkerClient,
  activation: Activation,
  definition: ServiceDefinition<any, any, any, any, any>,
  serviceRunId: string,
  implicitOpCounters: Map<string, number>
): ServiceRef<any, any, any> {
  const sendEntries = Object.keys(definition.onSend ?? {}).map((name) => [
    name,
    async (...args: any[]) => {
      const { payload, options } = splitPayloadAndOptions(args, "message");
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "send",
        name,
        options?.key
      );
      const scopedKey = scopeActivationOpKey(activation, key);
      const resolved = await client.resolveServiceSend(activation.leaseId, {
        serviceRunId,
        name,
        key: scopedKey,
        payload: payload ?? null,
      });

      if (resolved.status === "failed") {
        throw toServiceCallError(serviceRunId, name, resolved.error, "send");
      }
    },
  ]);

  const askEntries = Object.keys(definition.onAsk ?? {}).map((name) => [
    name,
    async (...args: any[]) => {
      const { payload, options } = splitPayloadAndOptions(args, "ask");
      const askOptions = options as AskOptions | undefined;
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "ask",
        name,
        askOptions?.key
      );
      const scopedKey = scopeActivationOpKey(activation, key);
      const resolved = await client.resolveServiceAsk(activation.leaseId, {
        serviceRunId,
        name,
        key: scopedKey,
        payload: payload ?? null,
        timeoutMs:
          typeof askOptions?.timeout === "string"
            ? parseDurationToMs(askOptions.timeout)
            : undefined,
      });

      if (resolved.status === "completed") {
        return resolved.output;
      }

      if (resolved.status === "failed") {
        throw toServiceAskError(serviceRunId, name, resolved.error);
      }

      throw new RunSuspendedError("ask_reply", `ask_reply:ask:${scopedKey}`);
    },
  ]);

  const signalEntries = Object.keys(definition.onSignal ?? {}).map((name) => [
    name,
    async (...args: any[]) => {
      const { payload, options } = splitPayloadAndOptions(args, "signal");
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "signal",
        name,
        options?.key
      );
      const scopedKey = scopeActivationOpKey(activation, key);
      const resolved = await client.resolveServiceSignal(activation.leaseId, {
        serviceRunId,
        name,
        key: scopedKey,
        payload: payload ?? null,
      });

      if (resolved.status === "failed") {
        throw toServiceCallError(serviceRunId, name, resolved.error, "signal");
      }
    },
  ]);

  return {
    id: serviceRunId,
    send: Object.fromEntries(sendEntries),
    ask: Object.fromEntries(askEntries),
    signal: Object.fromEntries(signalEntries),
    async status() {
      return (await client.getRelatedRunStatus(activation.leaseId, serviceRunId)) as RunStatus;
    },
    async monitor(options: MonitorOptions = {}): Promise<RelationshipRef> {
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "monitor",
        serviceRunId,
        options.key
      );
      const scopedKey = scopeActivationOpKey(activation, key);
      const relationship = await client.resolveRunMonitor(activation.leaseId, serviceRunId, {
        key: scopedKey,
      });

      return {
        id: relationship.id,
        targetId: relationship.targetRunId,
        kind: relationship.kind,
      };
    },
    async link(options: LinkOptions = {}): Promise<RelationshipRef> {
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "link",
        serviceRunId,
        options.key
      );
      const scopedKey = scopeActivationOpKey(activation, key);
      const relationship = await client.resolveRunLink(activation.leaseId, serviceRunId, {
        key: scopedKey,
        propagate: options.propagate,
      });

      return {
        id: relationship.id,
        targetId: relationship.targetRunId,
        kind: relationship.kind,
      };
    },
  };
}
