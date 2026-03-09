import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import type {
  AskOptions,
  AskResult,
  ConnectOptions,
  ExecArtifact,
  ExecResult,
  ExecSpec,
  MessageOptions,
  RetryBackoff,
  RetryFamily,
  RetryJitter,
  RetryOptions,
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
} from "@vilano/runtime";

import {
  WorkerClient,
  type ServiceTurnActivation,
  type WorkflowActivation,
} from "./client.ts";
import { loadServiceDefinition, loadWorkflowDefinition } from "./definitions.ts";
import type { RuntimeAdapter } from "./runtime-adapter.ts";
import { WORKER_PROTOCOL_VERSION } from "./runtime-version.ts";

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
  const workerId = options.workerId ?? `worker-${crypto.randomUUID()}`;
  const serverUrl = options.serverUrl ?? "http://127.0.0.1:4141";
  const authToken = options.authToken ?? process.env.VILANO_DAEMON_TOKEN;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
  const client = new WorkerClient(serverUrl, workerId, authToken);
  await client.assertCompatible(WORKER_PROTOCOL_VERSION);

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

    await executeActivation(adapter, client, activation, heartbeatIntervalMs);

    if (options.once) {
      return;
    }
  }
}

async function executeActivation(
  adapter: RuntimeAdapter,
  client: WorkerClient,
  activation: Activation,
  heartbeatIntervalMs: number
): Promise<void> {
  const heartbeat = setInterval(() => {
    void client.heartbeat(activation.leaseId).catch(() => undefined);
  }, heartbeatIntervalMs);
  let serviceDefinition: ServiceDefinition<any, any, any, any, any> | null = null;

  try {
    if (activation.kind === "workflow") {
      const definition = await loadWorkflowDefinition(activation);
      const ctx = createTurnContext(adapter, client, activation);
      const result = await definition.run(activation.run.input, ctx);
      await client.completeRun(activation.leaseId, result);
      return;
    }

    serviceDefinition = await loadServiceDefinition(activation);
    await executeServiceTurn(adapter, client, activation, serviceDefinition);
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
          toRetryPolicy(serviceDefinition?.retry)
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
    clearInterval(heartbeat);
  }
}

function createTurnContext(
  adapter: RuntimeAdapter,
  client: WorkerClient,
  activation: Activation
): WorkflowContext {
  const implicitActivationOpCounters = new Map<string, number>();
  const implicitServiceOpCounters = new Map<string, number>();

  return {
    spawn<TInput, TOutput>(
      definition: WorkflowDefinition<TInput, TOutput>,
      input: TInput,
      options: SpawnOptions = {}
    ): WorkflowHandle<TOutput> {
      const key = nextImplicitActivationOpKey(
        implicitActivationOpCounters,
        "spawn",
        definition.name,
        options.key
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
          return (await client.getRunStatus(childRunId)) as RunStatus;
        },
        async signal(name: string, payload?: unknown) {
          await spawnPromise;
          await client.sendRunSignal(childRunId, name, payload ?? null);
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
      _options?: ConnectOptions
    ): Promise<ServiceRef<TSend, TAsk, TSignal>> {
      const serviceKey = definition.key(input);
      const serviceRunId = await client.ensureService(
        activation.project.name,
        definition.name,
        serviceKey,
        input
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
    async step<TOutput>(
      name: string,
      fn: (step: StepContext) => Promise<TOutput> | TOutput,
      options: StepOptions = {}
    ) {
      const key = nextImplicitActivationOpKey(
        implicitActivationOpCounters,
        "step",
        name,
        options.key
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
      const key = nextImplicitActivationOpKey(
        implicitActivationOpCounters,
        "exec",
        spec.name,
        spec.key
      );
      const cwd = resolveExecCwd(activation.project.path, spec.cwd);
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

      const key = nextImplicitActivationOpKey(
        implicitActivationOpCounters,
        "sleep",
        duration,
        options?.key
      );
      const resolved = await client.resolveSleepWait(activation.leaseId, { key, durationMs });
      if (resolved.status === "completed") {
        return;
      }

      throw new RunSuspendedError("sleep", key);
    },
    async waitForSignal(name: string, options?: { key?: string }) {
      const key = nextImplicitActivationOpKey(
        implicitActivationOpCounters,
        "wait_for_signal",
        name,
        options?.key
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
      const resolved = await client.resolveServiceSend(activation.leaseId, {
        serviceRunId,
        name,
        key,
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
      const key = nextImplicitServiceOpKey(
        implicitOpCounters,
        serviceRunId,
        "ask",
        name,
        options?.key
      );
      const resolved = await client.resolveServiceAsk(activation.leaseId, {
        serviceRunId,
        name,
        key,
        payload: payload ?? null,
      });

      if (resolved.status === "completed") {
        return resolved.output;
      }

      if (resolved.status === "failed") {
        throw toServiceAskError(serviceRunId, name, resolved.error);
      }

      throw new RunSuspendedError("ask_reply", `ask_reply:ask:${key}`);
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
      const resolved = await client.resolveServiceSignal(activation.leaseId, {
        serviceRunId,
        name,
        key,
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
      return (await client.getRunStatus(serviceRunId)) as RunStatus;
    },
  };
}

async function executeServiceTurn(
  adapter: RuntimeAdapter,
  client: WorkerClient,
  activation: ServiceTurnActivation,
  definition: ServiceDefinition<any, any, any, any, any>
): Promise<void> {
  const ctx = createTurnContext(adapter, client, activation);
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

  if (args.length === 1 && looksLikeOptions(args[0], kind)) {
    return {
      payload: undefined,
      options: args[0] as AskOptions | MessageOptions | SignalOptions,
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
      .catch(() => {
        failForInactiveLease();
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

function resolveExecCwd(projectPath: string, cwd?: string): string {
  if (!cwd) {
    return projectPath;
  }

  return path.isAbsolute(cwd) ? cwd : path.resolve(projectPath, cwd);
}

function parseDurationToMs(duration?: string): number | undefined {
  if (!duration) {
    return undefined;
  }

  const value = duration.trim();
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) {
    throw new Error(`Unsupported duration: ${duration}`);
  }

  const amount = Number(match[1]);
  const unit = match[2];

  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      throw new Error(`Unsupported duration unit: ${unit}`);
  }
}

type ExecSuccess<TOutput> = {
  ok: true;
  output: TOutput;
  exitCode: number;
  signalCode: string | null;
  stdoutRef?: string;
  stderrRef?: string;
  artifacts: ExecArtifact[];
};

type ExecFailure = {
  ok: false;
  error: Record<string, unknown>;
  exitCode: number | null;
  signalCode: string | null;
  stdoutRef?: string;
  stderrRef?: string;
  artifacts: ExecArtifact[];
};

async function executeProcess<TOutput>(
  adapter: RuntimeAdapter,
  client: WorkerClient,
  activation: Activation,
  spec: ExecSpec<TOutput>,
  execution: {
    key: string;
    attempt: number;
    cwd: string;
    timeoutMs?: number;
  }
): Promise<ExecSuccess<TOutput> | ExecFailure> {
  let subprocess: ReturnType<RuntimeAdapter["spawnProcess"]>;

  try {
    subprocess = adapter.spawnProcess({
      cmd: spec.cmd,
      args: spec.args ?? [],
      cwd: execution.cwd,
      env: {
        ...process.env,
        ...spec.env,
      },
    });
  } catch (error) {
    return {
      ok: false,
      error: buildExecError({
        name: spec.name,
        message: error instanceof Error ? error.message : String(error),
        exitCode: null,
        signalCode: null,
        timedOut: false,
        artifacts: [],
        stderr: "",
        retryable: true,
        family: "process_spawn",
      }),
      exitCode: null,
      signalCode: null,
      artifacts: [],
    };
  }

  const stdoutPromise = streamToText(subprocess.stdout);
  const stderrPromise = streamToText(subprocess.stderr);
  let timedOut = false;
  let activationCancelled = false;
  let leaseStatusPollInFlight = false;

  const timer =
    execution.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          subprocess.kill("SIGKILL");
        }, execution.timeoutMs);

  const leaseStatusPoller = setInterval(() => {
    if (leaseStatusPollInFlight || activationCancelled) {
      return;
    }

    leaseStatusPollInFlight = true;
    void client
      .getLeaseStatus(activation.leaseId)
      .then((lease) => {
        if (!lease.active && !activationCancelled) {
          activationCancelled = true;
          subprocess.kill("SIGKILL");
        }
      })
      .catch(() => {
        if (!activationCancelled) {
          activationCancelled = true;
          subprocess.kill("SIGKILL");
        }
      })
      .finally(() => {
        leaseStatusPollInFlight = false;
      });
  }, 250);

  const exitCode = await subprocess.exited;
  if (timer) {
    clearTimeout(timer);
  }
  clearInterval(leaseStatusPoller);

  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;

  if (activationCancelled) {
    throw new ActivationCancelledError(
      `Activation lease ${activation.leaseId} is no longer active`,
      "lease_inactive"
    );
  }

  let captures: {
    stdoutRef?: string;
    stderrRef?: string;
    artifacts: ExecArtifact[];
  } = { artifacts: [] };

  try {
    captures = await persistExecCaptures(activation, execution, spec, stdout, stderr);
    const signalCode = subprocess.getSignalCode();

    if (timedOut) {
      return {
        ok: false,
        error: buildExecError({
          name: spec.name,
          message: `Process timed out after ${execution.timeoutMs}ms`,
          exitCode,
          signalCode,
          timedOut: true,
          stdoutRef: captures.stdoutRef,
          stderrRef: captures.stderrRef,
          artifacts: captures.artifacts,
          stderr,
          retryable: true,
          family: "timeout",
        }),
        exitCode,
        signalCode,
        stdoutRef: captures.stdoutRef,
        stderrRef: captures.stderrRef,
        artifacts: captures.artifacts,
      };
    }

    if (exitCode !== 0) {
      return {
        ok: false,
        error: buildExecError({
          name: spec.name,
          message: `Process exited with code ${exitCode}`,
          exitCode,
          signalCode,
          timedOut: false,
          stdoutRef: captures.stdoutRef,
          stderrRef: captures.stderrRef,
          artifacts: captures.artifacts,
          stderr,
          retryable: true,
          family: "process_exit",
        }),
        exitCode,
        signalCode,
        stdoutRef: captures.stdoutRef,
        stderrRef: captures.stderrRef,
        artifacts: captures.artifacts,
      };
    }

    const defaultOutput: ExecResult = {
      exitCode,
      signalCode,
      stdout,
      stderr,
      stdoutRef: captures.stdoutRef,
      stderrRef: captures.stderrRef,
      artifacts: captures.artifacts,
    };

    const output = spec.parse ? spec.parse(stdout) : (defaultOutput as TOutput);

    return {
      ok: true,
      output,
      exitCode,
      signalCode,
      stdoutRef: captures.stdoutRef,
      stderrRef: captures.stderrRef,
      artifacts: captures.artifacts,
    };
  } catch (error) {
    return {
      ok: false,
      error: buildExecError({
        name: spec.name,
        message: error instanceof Error ? error.message : String(error),
        exitCode,
        signalCode: subprocess.getSignalCode(),
        timedOut: false,
        stdoutRef: captures.stdoutRef,
        stderrRef: captures.stderrRef,
        artifacts: captures.artifacts,
        stderr,
        retryable: isRetryableError(error),
        family: "application",
      }),
      exitCode,
      signalCode: subprocess.getSignalCode(),
      stdoutRef: captures.stdoutRef,
      stderrRef: captures.stderrRef,
      artifacts: captures.artifacts,
    };
  }
}

async function streamToText(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>> | number | null | undefined
): Promise<string> {
  if (!stream || typeof stream === "number") {
    return "";
  }

  return await new Response(stream).text();
}

async function persistExecCaptures<TOutput>(
  activation: Activation,
  execution: {
    key: string;
    attempt: number;
    cwd: string;
  },
  spec: ExecSpec<TOutput>,
  stdout: string,
  stderr: string
): Promise<{
  stdoutRef?: string;
  stderrRef?: string;
  artifacts: ExecArtifact[];
}> {
  const captures = spec.capture ?? {};
  if (!captures.stdout && !captures.stderr && !(captures.artifacts && captures.artifacts.length > 0)) {
    return { artifacts: [] };
  }

  const runtimeHome = getRuntimeHome();
  const attemptDir = path.join(
    runtimeHome,
    "artifacts",
    "runs",
    activation.run.id,
    "execs",
    sanitizePathSegment(execution.key),
    `attempt-${execution.attempt}`
  );

  await fs.mkdir(attemptDir, { recursive: true });

  let stdoutRef: string | undefined;
  let stderrRef: string | undefined;

  if (captures.stdout) {
    const stdoutPath = path.join(attemptDir, "stdout.txt");
    await fs.writeFile(stdoutPath, stdout, "utf8");
    stdoutRef = path.relative(runtimeHome, stdoutPath);
  }

  if (captures.stderr) {
    const stderrPath = path.join(attemptDir, "stderr.txt");
    await fs.writeFile(stderrPath, stderr, "utf8");
    stderrRef = path.relative(runtimeHome, stderrPath);
  }

  const artifacts = await captureArtifacts(runtimeHome, attemptDir, execution.cwd, captures.artifacts ?? []);
  return { stdoutRef, stderrRef, artifacts };
}

async function captureArtifacts(
  runtimeHome: string,
  attemptDir: string,
  cwd: string,
  artifactPaths: string[]
): Promise<ExecArtifact[]> {
  const artifacts: ExecArtifact[] = [];

  for (const artifactPath of artifactPaths) {
    const sourcePath = path.isAbsolute(artifactPath)
      ? artifactPath
      : path.resolve(cwd, artifactPath);
    const targetRelative = path.join("files", sanitizeArtifactPath(artifactPath));
    const targetPath = path.join(attemptDir, targetRelative);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);

    artifacts.push({
      path: artifactPath,
      ref: path.relative(runtimeHome, targetPath),
    });
  }

  return artifacts;
}

function sanitizeArtifactPath(artifactPath: string): string {
  const normalized = artifactPath
    .split(/[\\/]+/)
    .filter((segment) => segment && segment !== "." && segment !== "..");

  if (normalized.length === 0) {
    return path.basename(artifactPath);
  }

  return path.join(...normalized);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function getRuntimeHome(): string {
  return process.env.VILANO_HOME
    ? path.resolve(process.env.VILANO_HOME)
    : path.join(os.homedir(), ".vilano");
}

function buildExecError(input: {
  name: string;
  message: string;
  exitCode: number | null;
  signalCode: string | null;
  timedOut: boolean;
  stdoutRef?: string;
  stderrRef?: string;
  artifacts: ExecArtifact[];
  stderr: string;
  retryable: boolean;
  family: Exclude<RetryFamily, "always">;
}): Record<string, unknown> {
  return {
    name: "ExecError",
    execName: input.name,
    message: input.stderr ? `${input.message}: ${truncate(input.stderr)}` : input.message,
    exitCode: input.exitCode,
    signalCode: input.signalCode,
    timedOut: input.timedOut,
    stdoutRef: input.stdoutRef,
    stderrRef: input.stderrRef,
    artifacts: input.artifacts,
    retryable: input.retryable,
    family: input.family,
  };
}

function buildStepError(input: {
  name: string;
  key: string;
  message: string;
  timedOut: boolean;
  timeoutMs?: number;
  cause: unknown;
  retryable: boolean;
  family: Exclude<RetryFamily, "always">;
}): Record<string, unknown> {
  const stack =
    input.cause instanceof Error && typeof input.cause.stack === "string" ? input.cause.stack : undefined;

  return {
    name: "StepError",
    stepName: input.name,
    key: input.key,
    message: input.message,
    timedOut: input.timedOut,
    timeoutMs: input.timeoutMs,
    stack,
    retryable: input.retryable,
    family: input.family,
  };
}

function toFailureBody(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const body: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    if ("retryable" in error && error.retryable === false) {
      body.retryable = false;
    }

    if ("family" in error && typeof error.family === "string") {
      body.family = error.family;
    } else {
      body.family = "application";
    }

    if ("cause" in error) {
      body.cause = (error as Error & { cause?: unknown }).cause;
    }

    return body;
  }

  return {
    message: String(error),
    family: "application",
  };
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return true;
  }

  if ("retryable" in error && error.retryable === false) {
    return false;
  }

  return true;
}

function toMaxAttempts(retries?: number): number {
  if (!Number.isInteger(retries) || retries === undefined || retries < 0) {
    return 1;
  }

  return retries + 1;
}

function toRetryPolicy(
  retry?: RetryOptions,
  legacy?: { retries?: number; backoff?: RetryBackoff }
):
  | {
      maxAttempts?: number;
      backoffKind?: "fixed" | "linear" | "exponential";
      backoffMs?: number;
      backoffStepMs?: number;
      backoffFactor?: number;
      maxBackoffMs?: number;
      backoffJitterKind?: "full" | "half" | "ratio";
      backoffJitterRatio?: number;
      retryOn?: string[];
    }
  | undefined {
  const merged = mergeRetryOptions(retry, legacy);
  if (!merged) {
    return undefined;
  }

  const maxAttempts = toMaxAttempts(merged.retries);
  const backoff = resolveRetryBackoff(merged.backoff);
  const retryOn = normalizeRetryOn(merged.on);

  return {
    maxAttempts,
    backoffKind: backoff.backoffKind,
    backoffMs: backoff.backoffMs,
    backoffStepMs: backoff.backoffStepMs,
    backoffFactor: backoff.backoffFactor,
    maxBackoffMs: backoff.maxBackoffMs,
    backoffJitterKind: backoff.backoffJitterKind,
    backoffJitterRatio: backoff.backoffJitterRatio,
    retryOn,
  };
}

function mergeRetryOptions(
  retry?: RetryOptions,
  legacy?: { retries?: number; backoff?: RetryBackoff }
): RetryOptions | undefined {
  const retries = retry?.retries ?? legacy?.retries;
  const backoff = retry?.backoff ?? legacy?.backoff;
  const on = retry?.on;

  if (retries === undefined && backoff === undefined && on === undefined) {
    return undefined;
  }

  return {
    retries,
    backoff,
    on,
  };
}

function resolveRetryBackoff(backoff?: RetryBackoff): {
  backoffKind: "fixed" | "linear" | "exponential";
  backoffMs: number;
  backoffStepMs?: number;
  backoffFactor?: number;
  maxBackoffMs?: number;
  backoffJitterKind?: "full" | "half" | "ratio";
  backoffJitterRatio?: number;
} {
  if (!backoff) {
    return {
      backoffKind: "fixed",
      backoffMs: 0,
    };
  }

  if (typeof backoff === "string") {
    return {
      backoffKind: "fixed",
      backoffMs: parseDurationToMs(backoff) ?? 0,
    };
  }

  switch (backoff.kind) {
    case "fixed":
      return {
        backoffKind: "fixed",
        backoffMs: parseDurationToMs(backoff.delay) ?? 0,
        ...resolveRetryJitter(backoff.jitter),
      };
    case "linear":
      return {
        backoffKind: "linear",
        backoffMs: parseDurationToMs(backoff.initial) ?? 0,
        backoffStepMs: parseDurationToMs(backoff.step ?? backoff.initial) ?? 0,
        maxBackoffMs: parseDurationToMs(backoff.max),
        ...resolveRetryJitter(backoff.jitter),
      };
    case "exponential":
      return {
        backoffKind: "exponential",
        backoffMs: parseDurationToMs(backoff.initial) ?? 0,
        backoffFactor:
          typeof backoff.factor === "number" && Number.isFinite(backoff.factor) && backoff.factor > 0
            ? backoff.factor
            : 2,
        maxBackoffMs: parseDurationToMs(backoff.max),
        ...resolveRetryJitter(backoff.jitter),
      };
  }
}

function resolveRetryJitter(jitter?: RetryJitter): {
  backoffJitterKind?: "full" | "half" | "ratio";
  backoffJitterRatio?: number;
} {
  if (!jitter) {
    return {};
  }

  if (jitter === "full") {
    return {
      backoffJitterKind: "full",
      backoffJitterRatio: 1,
    };
  }

  if (jitter === "half") {
    return {
      backoffJitterKind: "half",
      backoffJitterRatio: 0.5,
    };
  }

  if (jitter.kind === "ratio") {
    const ratio = Math.min(Math.max(jitter.ratio, 0), 1);
    return {
      backoffJitterKind: "ratio",
      backoffJitterRatio: Number.isFinite(ratio) ? ratio : 0,
    };
  }

  return {};
}

function normalizeRetryOn(on?: RetryFamily[]): string[] | undefined {
  if (!on || on.length === 0) {
    return undefined;
  }

  if (on.includes("always")) {
    return ["always"];
  }

  return Array.from(new Set(on));
}

function truncate(value: string, maxLength = 240): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function toExecError(name: string, error: unknown): Error {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return Object.assign(new Error(error.message), { cause: error, execName: name });
  }

  return new Error(`Exec '${name}' failed`);
}

function toStepError(name: string, error: unknown): Error {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return Object.assign(new Error(error.message), { cause: error, stepName: name });
  }

  return new Error(`Step '${name}' failed`);
}

function toChildRunError(childRunId: string, error: unknown): Error {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return Object.assign(new Error(error.message), { cause: error, childRunId });
  }

  return new Error(`Child run '${childRunId}' failed`);
}

function toServiceAskError(serviceRunId: string, messageName: string, error: unknown): Error {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return Object.assign(new Error(error.message), { cause: error, serviceRunId, messageName });
  }

  return new Error(`Service ask '${messageName}' failed on '${serviceRunId}'`);
}

function toServiceCallError(
  serviceRunId: string,
  messageName: string,
  error: unknown,
  kind: "send" | "signal"
): Error {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return Object.assign(new Error(error.message), { cause: error, serviceRunId, messageName, kind });
  }

  return new Error(`Service ${kind} '${messageName}' failed on '${serviceRunId}'`);
}

function isInactiveActivationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.startsWith("Unknown active lease:") ||
    error.message.startsWith("Unknown active service turn:")
  );
}

function throwAbortReason(reason: unknown): never {
  if (reason instanceof Error) {
    throw reason;
  }

  throw new Error(typeof reason === "string" ? reason : "Step aborted");
}

class ActivationCancelledError extends Error {
  readonly reason: "lease_inactive";

  constructor(
    message: string,
    reason: "lease_inactive"
  ) {
    super(message);
    this.name = "ActivationCancelledError";
    this.reason = reason;
  }
}

class StepControlError extends Error {
  override readonly cause?: unknown;
  readonly reason: "timeout" | "activation_cancelled";

  constructor(
    reason: "timeout" | "activation_cancelled",
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "StepControlError";
    this.reason = reason;
    this.cause = cause;
  }

  toActivationCancelledError(): ActivationCancelledError {
    return new ActivationCancelledError(this.message, "lease_inactive");
  }
}

function deterministicChildRunId(parentRunId: string, key: string): string {
  const digest = crypto.createHash("sha256").update(`${parentRunId}:${key}`).digest("hex").slice(0, 32);
  return `run_${digest}`;
}

class RunSuspendedError extends Error {
  readonly waitKind: "sleep" | "signal" | "child_result" | "ask_reply" | "retry_backoff";
  readonly key: string;

  constructor(
    waitKind: "sleep" | "signal" | "child_result" | "ask_reply" | "retry_backoff",
    key: string
  ) {
    super(`Run suspended on ${waitKind}:${key}`);
    this.name = "RunSuspendedError";
    this.waitKind = waitKind;
    this.key = key;
  }
}
