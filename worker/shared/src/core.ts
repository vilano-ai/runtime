import fs from "node:fs/promises";
import crypto from "node:crypto";
import process from "node:process";

import type {
  AskOptions,
  AskResult,
  ConnectOptions,
  ExecResult,
  ExecSpec,
  MessageOptions,
  RunStatus,
  ServiceDefinition,
  ServiceRef,
  SignalOptions,
  SignalResult,
  SpawnOptions,
  StepContext,
  StepOptions,
  WorkflowHandle,
  WorkflowContext,
  WorkflowDefinition,
} from "./runtime-sdk.ts";
import {
  WorkerClient,
  WorkerRequestError,
  type ServiceTurnActivation,
  type WorkflowActivation,
} from "./client.ts";
import {
  ensureActivationImportRoot,
  ensureActivationWorkspace,
} from "./activation-workspace.ts";
import { loadServiceDefinition, loadWorkflowDefinition } from "./definitions.ts";
import type { RuntimeAdapter } from "./runtime-adapter.ts";
import { WORKER_PROTOCOL_VERSION } from "./runtime-version.ts";
import {
  ActivationCancelledError,
  RunSuspendedError,
  StepControlError,
  buildStepError,
  deterministicChildRunId,
  executeProcess,
  isInactiveActivationError,
  isRetryableError,
  parseDurationToMs,
  resolveExecCwd,
  setRuntimeHomeOverride,
  throwAbortReason,
  toChildRunError,
  toExecError,
  toFailureBody,
  toRetryPolicy,
  toServiceAskError,
  toServiceCallError,
  toStepError,
} from "./runtime-utils.ts";

type Activation = WorkflowActivation | ServiceTurnActivation;
type ServiceMethodKind = "message" | "ask" | "signal";

export interface WorkerOptions {
  workerId?: string;
  serverUrl?: string;
  authToken?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  once?: boolean;
}

export async function startWorker(
  adapter: RuntimeAdapter,
  options: WorkerOptions = {}
): Promise<void> {
  const artifactHome =
    process.env.VILANO_WORKER_ARTIFACT_HOME ??
    process.env.VILANO_RUNTIME_HOME ??
    process.env.VILANO_HOME ??
    process.env.VILANO_WORKER_HOME;
  const workerHome = process.env.VILANO_WORKER_HOME ?? artifactHome;
  if (workerHome) {
    await fs.mkdir(workerHome, { recursive: true });
    process.chdir(workerHome);
  }
  const workerHomePath = process.cwd();
  setRuntimeHomeOverride(artifactHome ? artifactHome : null);

  const workerId = options.workerId ?? `worker-${crypto.randomUUID()}`;
  const serverUrl = options.serverUrl ?? "http://127.0.0.1:4141";
  const authToken = options.authToken ?? process.env.VILANO_WORKER_TOKEN;
  delete process.env.VILANO_WORKER_TOKEN;
  delete process.env.VILANO_DAEMON_TOKEN;
  delete process.env.VILANO_WORKER_ARTIFACT_HOME;
  delete process.env.VILANO_RUNTIME_HOME;
  delete process.env.VILANO_WORKER_HOME;
  delete process.env.VILANO_HOME;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const client = new WorkerClient(serverUrl, workerId, authToken);
  const status = await client.assertCompatible(WORKER_PROTOCOL_VERSION);
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ??
    Math.max(1000, Math.floor((status.leaseDurationSeconds * 1000) / 3));

  while (true) {
    let activation: WorkflowActivation | ServiceTurnActivation | null;

    try {
      activation = await client.leaseActivation();
    } catch (error) {
      if (options.once) {
        throw error;
      }

      await adapter.sleep(pollIntervalMs);
      continue;
    }

    if (!activation) {
      if (options.once) {
        return;
      }

      await adapter.sleep(pollIntervalMs);
      continue;
    }

    await executeActivation(adapter, client, activation, heartbeatIntervalMs, workerHomePath);

    if (options.once) {
      return;
    }
  }
}

export async function executeActivation(
  adapter: RuntimeAdapter,
  client: WorkerClient,
  activation: Activation,
  heartbeatIntervalMs: number,
  workerHomePath: string
): Promise<void> {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let activationImportRoot: string | null = null;
  let activationWorkspace: string | null = null;
  let serviceDefinition: ServiceDefinition<any, any, any, any, any> | null = null;
  let serviceRetry: ServiceDefinition<any, any, any, any, any>["retry"] | undefined;

  try {
    heartbeat = setInterval(() => {
      void client.heartbeat(activation.leaseId).catch(() => undefined);
    }, heartbeatIntervalMs);
    activationImportRoot = await ensureActivationImportRoot(workerHomePath, activation);
    activationWorkspace = await ensureActivationWorkspace(
      workerHomePath,
      activation,
      activationImportRoot
    );
    if (!activationImportRoot || !activationWorkspace) {
      throw new Error("Activation staging did not produce execution roots");
    }

    if (activation.kind === "workflow") {
      const importRoot = activationImportRoot;
      const workspace = activationWorkspace;
      const definition = await withActivationCwd(activationImportRoot, async () =>
        await loadWorkflowDefinition(activation, {
          cacheKey: activation.leaseId,
          importRoot,
        })
      );

      await withActivationCwd(workspace, async () => {
        const ctx = createTurnContext(adapter, client, activation, workspace);
        const result = await definition.run(activation.run.input, ctx);
        await client.completeRun(activation.leaseId, result);
      });
      return;
    }

    const importRoot = activationImportRoot;
    const workspace = activationWorkspace;
    serviceDefinition = await withActivationCwd(importRoot, async () =>
      await loadServiceDefinition(activation, {
        cacheKey: activation.leaseId,
        importRoot,
      })
    );
    serviceRetry = serviceDefinition.retry;

    await withActivationCwd(workspace, async () => {
      await executeServiceTurn(
        adapter,
        client,
        activation,
        serviceDefinition as ServiceDefinition<any, any, any, any, any>,
        workspace
      );
    });
  } catch (error) {
    if (error instanceof RunSuspendedError) {
      return;
    }

    if (error instanceof ActivationCancelledError || isInactiveActivationError(error)) {
      return;
    }

    if (activation.kind === "workflow") {
      try {
        await client.failRun(activation.leaseId, toFailureBody(error));
      } catch (reportError) {
        if (reportError instanceof ActivationCancelledError || isInactiveActivationError(reportError)) {
          return;
        }

        throw reportError;
      }
    } else {
      try {
        const failedTurn = await client.failServiceTurn(
          activation.leaseId,
          activation.envelope.id,
          toFailureBody(error),
          toRetryPolicy(serviceRetry)
        );

        if (failedTurn.status === "retry_waiting") {
          return;
        }
      } catch (reportError) {
        if (reportError instanceof ActivationCancelledError || isInactiveActivationError(reportError)) {
          return;
        }

        throw reportError;
      }
    }
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    client.clearLeaseAuthToken(activation.leaseId);
    if (activationWorkspace) {
      await fs.rm(activationWorkspace, { recursive: true, force: true }).catch(() => undefined);
    }
    if (activationImportRoot) {
      await fs.rm(activationImportRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function withActivationCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  process.chdir(cwd);

  try {
    return await fn();
  } finally {
    process.chdir(previousCwd);
  }
}

function createTurnContext(
  adapter: RuntimeAdapter,
  client: WorkerClient,
  activation: Activation,
  activationCwd: string
): WorkflowContext {
  const implicitActivationOpCounters = new Map<string, number>();
  const implicitServiceOpCounters = new Map<string, number>();

  return {
    spawn<TInput, TOutput>(
      definition: WorkflowDefinition<TInput, TOutput>,
      input: TInput,
      options: SpawnOptions = {}
    ): WorkflowHandle<TOutput> {
      const key = scopeActivationOpKey(
        activation,
        nextImplicitActivationOpKey(
        implicitActivationOpCounters,
        "spawn",
        definition.name,
        options.key
        )
      );
      const childRunId = deterministicChildRunId(activation.run.id, key);
      const spawnPromise = client.resolveSpawn(activation.leaseId, {
        name: definition.name,
        key,
        childRunId,
        input,
      });

      return {
        id: childRunId,
        async result() {
          await spawnPromise;

          const resolved = await client.resolveChildResult(activation.leaseId, {
            childRunId,
            key,
          });

          if (resolved.status === "completed") {
            return resolved.output as TOutput;
          }

          if (resolved.status === "failed") {
            throw toChildRunError(childRunId, resolved.error);
          }

          throw new RunSuspendedError("child_result", `child_result:${childRunId}`);
        },
        async status() {
          await spawnPromise;
          return (await client.getRelatedRunStatus(activation.leaseId, childRunId)) as RunStatus;
        },
        async signal(name: string, payload?: unknown) {
          await spawnPromise;
          await client.sendChildRunSignal(activation.leaseId, childRunId, name, payload ?? null);
        },
      };
    },
    async connect<
      TKeyInput,
      TState,
      TSend extends Record<string, (...args: any[]) => any>,
      TAsk extends Record<string, (...args: any[]) => any>,
      TSignal extends Record<string, (...args: any[]) => any>
    >(
      definition: ServiceDefinition<TKeyInput, TState, TSend, TAsk, TSignal>,
      input: TKeyInput,
      options?: ConnectOptions
    ): Promise<ServiceRef<TSend, TAsk, TSignal>> {
      const serviceKey = definition.key(input);
      const serviceRunId = await client.ensureService(
        null,
        definition.name,
        serviceKey,
        input,
        activation.leaseId,
        options?.mustExist ?? false
      );

      return createServiceRef(
        client,
        activation,
        definition,
        serviceRunId,
        implicitServiceOpCounters
      ) as ServiceRef<TSend, TAsk, TSignal>;
    },
    runId: activation.run.id,
    turnAttempt: activation.kind === "service_turn"
      ? (((activation.envelope as { attempt?: number }).attempt ?? 1))
      : 1,
    async step<TOutput>(
      name: string,
      fn: (step: StepContext) => Promise<TOutput> | TOutput,
      options: StepOptions = {}
    ) {
      const key = scopeActivationOpKey(
        activation,
        nextImplicitActivationOpKey(
        implicitActivationOpCounters,
        "step",
        name,
        options.key
        )
      );
      const timeoutMs = parseDurationToMs(options.timeout);
      const retryPolicy = toRetryPolicy(options.retry, {
        retries: options.retries,
        backoff: options.backoff,
      });
      const existing = await client.resolveStep(
        activation.leaseId,
        name,
        key,
        timeoutMs,
        retryPolicy
      );
      if (existing.status === "completed") {
        return existing.output as TOutput;
      }

      if (existing.status === "failed") {
        throw toStepError(name, existing.error);
      }

      const controller = createStepController(adapter, client, activation, {
        name,
        key,
        attempt: existing.attempt,
        timeoutMs,
      });

      try {
        const output = await fn(controller.context);
        controller.checkCancelled();
        await client.completeStep(activation.leaseId, name, key, output);
        return output;
      } catch (error) {
        if (error instanceof ActivationCancelledError || isInactiveActivationError(error)) {
          throw error;
        }

        if (error instanceof StepControlError) {
          if (error.reason === "activation_cancelled") {
            throw error.toActivationCancelledError();
          }

          const stepError = buildStepError({
            name,
            key,
            message: error.message,
            timedOut: error.reason === "timeout",
            timeoutMs,
            cause: error.cause,
            retryable: true,
            family: "timeout",
          });

          const failedStep = await client.failStep(activation.leaseId, name, key, stepError);
          if (failedStep.status === "retry_waiting") {
            throw new RunSuspendedError("retry_backoff", failedStep.wait.key);
          }

          throw toStepError(name, stepError);
        }

        const stepError = buildStepError({
          name,
          key,
          message: error instanceof Error ? error.message : String(error),
          timedOut: false,
          timeoutMs,
          cause: error,
          retryable: isRetryableError(error),
          family: "application",
        });

        const failedStep = await client.failStep(activation.leaseId, name, key, stepError);
        if (failedStep.status === "retry_waiting") {
          throw new RunSuspendedError("retry_backoff", failedStep.wait.key);
        }

        throw toStepError(name, stepError);
      } finally {
        controller.dispose();
      }
    },
    async exec<TOutput = ExecResult>(spec: ExecSpec<TOutput>) {
      const key = scopeActivationOpKey(
        activation,
        nextImplicitActivationOpKey(
        implicitActivationOpCounters,
        "exec",
        spec.name,
        spec.key
        )
      );
      const cwd = resolveExecCwd(activationCwd, spec.cwd);
      const timeoutMs = parseDurationToMs(spec.timeout);
      const retryPolicy = toRetryPolicy(spec.retry, {
        retries: spec.retries,
        backoff: spec.backoff,
      });
      const resolved = await client.resolveExec(activation.leaseId, {
        name: spec.name,
        key,
        cmd: spec.cmd,
        args: spec.args ?? [],
        cwd,
        env: spec.env,
        timeoutMs,
      });

      if (resolved.status === "completed") {
        return resolved.output as TOutput;
      }

      if (resolved.status === "failed") {
        throw toExecError(spec.name, resolved.error);
      }

      const execution = await executeProcess(adapter, client, activation, spec, {
        key,
        attempt: resolved.attempt,
        cwd,
        timeoutMs,
      });

      if (execution.ok) {
        await client.completeExec(activation.leaseId, {
          name: spec.name,
          key,
          exitCode: execution.exitCode,
          signalCode: execution.signalCode,
          stdoutRef: execution.stdoutRef,
          stderrRef: execution.stderrRef,
          artifacts: execution.artifacts,
          output: execution.output,
        });

        return execution.output;
      }

      const failedExec = await client.failExec(activation.leaseId, {
        name: spec.name,
        key,
        exitCode: execution.exitCode,
        signalCode: execution.signalCode,
        stdoutRef: execution.stdoutRef,
        stderrRef: execution.stderrRef,
        artifacts: execution.artifacts,
        error: execution.error,
        retry: retryPolicy,
      });

      if (failedExec.status === "retry_waiting") {
        throw new RunSuspendedError("retry_backoff", failedExec.wait.key);
      }

      throw toExecError(spec.name, execution.error);
    },
    async log(message: string, fields?: Record<string, unknown>) {
      console.log("[vilano-worker]", activation.run.id, message, fields ?? {});
    },
    async sleep(duration: string, options?: { key?: string }) {
      const durationMs = parseDurationToMs(duration);
      if (durationMs === undefined) {
        throw new Error("ctx.sleep() requires a duration");
      }

      const key = scopeActivationOpKey(
        activation,
        nextImplicitActivationOpKey(
        implicitActivationOpCounters,
        "sleep",
        duration,
        options?.key
        )
      );
      const resolved = await client.resolveSleepWait(activation.leaseId, { key, durationMs });
      if (resolved.status === "completed") {
        return;
      }

      throw new RunSuspendedError("sleep", key);
    },
    async waitForSignal(name: string, options?: { key?: string }) {
      const key = scopeActivationOpKey(
        activation,
        nextImplicitActivationOpKey(
        implicitActivationOpCounters,
        "wait_for_signal",
        name,
        options?.key
        )
      );
      const resolved = await client.resolveSignalWait(activation.leaseId, { name, key });
      if (resolved.status === "completed") {
        return resolved.output;
      }

      throw new RunSuspendedError("signal", key);
    },
  };
}

function createServiceRef(
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
        timeoutMs: typeof askOptions?.timeout === "string" ? parseDurationToMs(askOptions.timeout) : undefined,
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
  };
}

async function executeServiceTurn(
  adapter: RuntimeAdapter,
  client: WorkerClient,
  activation: ServiceTurnActivation,
  definition: ServiceDefinition<any, any, any, any, any>,
  activationCwd: string
): Promise<void> {
  const ctx = createTurnContext(adapter, client, activation, activationCwd);
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

function hasOwnState(value: unknown): value is { state?: unknown } {
  return Boolean(value) && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "state");
}

function splitPayloadAndOptions(
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

function looksLikeOptions(value: unknown, kind: ServiceMethodKind): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const allowedKeys = kind === "ask" ? new Set(["key", "timeout"]) : new Set(["key"]);
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => allowedKeys.has(key));
}

function nextImplicitServiceOpKey(
  counters: Map<string, number>,
  serviceRunId: string,
  opKind: "send" | "ask" | "signal",
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

function scopeActivationOpKey(activation: Activation, key: string): string {
  if (activation.kind !== "service_turn") {
    return key;
  }

  return `turn:${activation.envelope.id}:${key}`;
}

function nextImplicitActivationOpKey(
  counters: Map<string, number>,
  opKind: "spawn" | "step" | "exec" | "sleep" | "wait_for_signal",
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

function createStepController(
  adapter: RuntimeAdapter,
  client: WorkerClient,
  activation: Activation,
  step: {
    name: string;
    key: string;
    attempt: number;
    timeoutMs?: number;
  }
): {
  context: StepContext;
  checkCancelled(): void;
  dispose(): void;
} {
  const abortController = new AbortController();
  let leaseCheckInFlight = false;

  const abortWith = (reason: unknown) => {
    if (!abortController.signal.aborted) {
      abortController.abort(reason);
    }
  };

  const failForInactiveLease = () => {
    abortWith(
      new StepControlError(
        "activation_cancelled",
        `Step '${step.name}' stopped because activation ${activation.leaseId} is no longer active`
      )
    );
  };

  const timeoutTimer =
    step.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          abortWith(
            new StepControlError(
              "timeout",
              `Step '${step.name}' timed out after ${step.timeoutMs}ms`
            )
          );
        }, step.timeoutMs);

  const leasePoller = setInterval(() => {
    if (leaseCheckInFlight || abortController.signal.aborted) {
      return;
    }

    leaseCheckInFlight = true;
    void client
      .getLeaseStatus(activation.leaseId)
      .then((lease) => {
        if (!lease.active) {
          failForInactiveLease();
        }
      })
      .catch((error) => {
        if (
          error instanceof WorkerRequestError &&
          (error.status === 401 || error.status === 404)
        ) {
          failForInactiveLease();
        }
      })
      .finally(() => {
        leaseCheckInFlight = false;
      });
  }, 250);

  const checkCancelled = () => {
    if (!abortController.signal.aborted) {
      return;
    }

    throwAbortReason(abortController.signal.reason);
  };

  return {
    context: {
      attempt: step.attempt,
      signal: abortController.signal,
      checkCancelled,
      async yield() {
        checkCancelled();
        await adapter.sleep(0);
        checkCancelled();
      },
    },
    checkCancelled,
    dispose() {
      clearInterval(leasePoller);
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    },
  };
}
