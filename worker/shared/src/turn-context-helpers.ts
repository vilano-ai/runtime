import type {
  AskOptions,
  MessageOptions,
  SignalOptions,
  SpawnOptions,
} from "./runtime-sdk.ts";
import type {
  ServiceTurnActivation,
  WorkflowActivation,
} from "./client.ts";

export type Activation = WorkflowActivation | ServiceTurnActivation;
export type ServiceMethodKind = "message" | "ask" | "signal";

export function hasOwnState(value: unknown): value is { state?: unknown } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "state")
  );
}

export function splitPayloadAndOptions(
  args: unknown[],
  kind: ServiceMethodKind
): {
  payload: unknown;
  options: AskOptions | MessageOptions | SignalOptions | undefined;
} {
  if (args.length === 0) {
    return { payload: undefined, options: undefined };
  }

  if (args.length === 1) {
    return {
      payload: args[0],
      options: undefined,
    };
  }

  return {
    payload: args[0],
    options: looksLikeOptions(args[1], kind)
      ? (args[1] as AskOptions | MessageOptions | SignalOptions)
      : undefined,
  };
}

export function looksLikeOptions(value: unknown, kind: ServiceMethodKind): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const allowedKeys = kind === "ask" ? new Set(["key", "timeout"]) : new Set(["key"]);
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => allowedKeys.has(key));
}

export function nextImplicitServiceOpKey(
  counters: Map<string, number>,
  serviceRunId: string,
  opKind: "send" | "ask" | "signal" | "monitor" | "link",
  messageName: string,
  explicitKey?: string
): string {
  if (explicitKey) {
    return explicitKey;
  }

  const counterKey = `${serviceRunId}:${opKind}:${messageName}`;
  const nextCount = (counters.get(counterKey) ?? 0) + 1;
  counters.set(counterKey, nextCount);
  return `${opKind}:${serviceRunId}:${messageName}:${nextCount}`;
}

export function scopeActivationOpKey(activation: Activation, key: string): string {
  if (activation.kind !== "service_turn") {
    return key;
  }

  return `turn:${activation.envelope.id}:${key}`;
}

export function nextImplicitActivationOpKey(
  counters: Map<string, number>,
  opKind:
    | "spawn"
    | "step"
    | "exec"
    | "publish"
    | "sleep"
    | "wait_for_signal"
    | "monitor"
    | "link"
    | "next_exit"
    | "supervise"
    | "supervision_member_result",
  name: string,
  explicitKey?: string
): string {
  if (explicitKey) {
    return explicitKey;
  }

  const counterKey = `${opKind}:${name}`;
  const nextCount = (counters.get(counterKey) ?? 0) + 1;
  counters.set(counterKey, nextCount);
  return `${opKind}:${name}:${nextCount}`;
}

export function nextSpawnOpKey(
  counters: Map<string, number>,
  definitionName: string,
  options: SpawnOptions = {}
): string {
  if (options.policy === "fresh") {
    return nextImplicitActivationOpKey(
      counters,
      "spawn",
      options.key && options.key.trim() !== "" ? options.key : definitionName
    );
  }

  return nextImplicitActivationOpKey(counters, "spawn", definitionName, options.key);
}

export function nextImplicitSupervisionMemberKey(
  counters: Map<string, number>,
  definitionName: string,
  explicitKey?: string
): string {
  if (explicitKey) {
    return explicitKey;
  }

  const nextCount = (counters.get(definitionName) ?? 0) + 1;
  counters.set(definitionName, nextCount);
  return `member:${definitionName}:${nextCount}`;
}
