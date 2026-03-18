import type {
  ConnectOptions,
  DiscoveredServiceRef,
  ExitEvent,
  ExecResult,
  ExecSpec,
  LinkOptions,
  MessageOptions,
  MonitorOptions,
  RelationshipRef,
  RunStatus,
  ServiceDefinition,
  ServiceRef,
  ServiceTurnContext,
  SpawnOptions,
  StepOptions,
  SupervisionMemberInfo,
  SupervisionMemberStatus,
  SupervisedSpawnOptions,
  SupervisedWorkflowHandle,
  SuperviseOptions,
  TopicPublishResult,
  TopicSubscriptionRef,
  WorkflowDefinition,
  WorkflowHandle,
  WorkflowSupervisionGroup,
} from "./runtime-sdk.ts";
import { WorkerClient } from "./client.ts";
import type { RuntimeAdapter } from "./runtime-adapter.ts";
import {
  ActivationCancelledError,
  buildStepError,
  deterministicChildRunId,
  executeProcess,
  isInactiveActivationError,
  isRetryableError,
  parseDurationToMs,
  resolveExecCwd,
  RunSuspendedError,
  StepControlError,
  toChildRunError,
  toExecError,
  toRetryPolicy,
  toStepError,
} from "./runtime-utils.ts";
import { TurnHandledError } from "./runtime-errors.ts";
import { createServiceRef, createDiscoveredServiceRef } from "./service-refs.ts";
import { createStepController } from "./step-controller.ts";
import {
  type Activation,
  nextImplicitActivationOpKey,
  nextSpawnOpKey,
  nextImplicitSupervisionMemberKey,
  scopeActivationOpKey,
} from "./turn-context-helpers.ts";

export function createTurnContext(
  adapter: RuntimeAdapter,
  client: WorkerClient,
  activation: Activation,
  activationCwd: string,
  currentServiceDefinition: ServiceDefinition<any, any, any, any, any> | null = null
): ServiceTurnContext {
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
        nextSpawnOpKey(implicitActivationOpCounters, definition.name, options)
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
        async monitor(options: MonitorOptions = {}): Promise<RelationshipRef> {
          await spawnPromise;
          const monitorKey = scopeActivationOpKey(
            activation,
            nextImplicitActivationOpKey(
              implicitActivationOpCounters,
              "monitor",
              childRunId,
              options.key
            )
          );
          const relationship = await client.resolveRunMonitor(activation.leaseId, childRunId, {
            key: monitorKey,
          });

          return {
            id: relationship.id,
            targetId: relationship.targetRunId,
            kind: relationship.kind,
          };
        },
        async link(options: LinkOptions = {}): Promise<RelationshipRef> {
          await spawnPromise;
          const linkKey = scopeActivationOpKey(
            activation,
            nextImplicitActivationOpKey(
              implicitActivationOpCounters,
              "link",
              childRunId,
              options.key
            )
          );
          const relationship = await client.resolveRunLink(activation.leaseId, childRunId, {
            key: linkKey,
            propagate: options.propagate,
          });

          return {
            id: relationship.id,
            targetId: relationship.targetRunId,
            kind: relationship.kind,
          };
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
    async lookup<
      TKeyInput,
      TState,
      TSend extends Record<string, (...args: any[]) => any>,
      TAsk extends Record<string, (...args: any[]) => any>,
      TSignal extends Record<string, (...args: any[]) => any>
    >(
      definition: ServiceDefinition<TKeyInput, TState, TSend, TAsk, TSignal>,
      input: TKeyInput
    ): Promise<ServiceRef<TSend, TAsk, TSignal>> {
      const serviceKey = definition.key(input);
      const serviceRunId = await client.ensureService(
        null,
        definition.name,
        serviceKey,
        input,
        activation.leaseId,
        true
      );

      return createServiceRef(
        client,
        activation,
        definition,
        serviceRunId,
        implicitServiceOpCounters
      ) as ServiceRef<TSend, TAsk, TSignal>;
    },
    async lookupSingleton(role: string, keyInput: unknown = {}): Promise<DiscoveredServiceRef> {
      const run = await client.lookupSingletonService(activation.leaseId, role, keyInput ?? {});

      return createDiscoveredServiceRef(
        client,
        activation,
        run.id,
        run.project,
        run.definitionName,
        run.serviceKey,
        run.keyInput,
        implicitServiceOpCounters
      );
    },
    runId: activation.run.id,
    turnAttempt:
      activation.kind === "service_turn" ? (activation.envelope.attempt ?? 1) : 1,
    async step<TOutput>(
      name: string,
      fn: (step: import("./runtime-sdk.ts").StepContext) => Promise<TOutput> | TOutput,
      options: StepOptions = {}
    ) {
      const key = scopeActivationOpKey(
        activation,
        nextImplicitActivationOpKey(implicitActivationOpCounters, "step", name, options.key)
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
    async publish(topic: string, payload?: unknown, options?: MessageOptions): Promise<TopicPublishResult> {
      const key = scopeActivationOpKey(
        activation,
        nextImplicitActivationOpKey(
          implicitActivationOpCounters,
          "publish",
          topic,
          options?.key
        )
      );

      return await client.resolveTopicPublish(activation.leaseId, {
        topic,
        key,
        payload: payload ?? null,
      });
    },
    async supervise(options: SuperviseOptions): Promise<WorkflowSupervisionGroup> {
      const key = scopeActivationOpKey(
        activation,
        nextImplicitActivationOpKey(
          implicitActivationOpCounters,
          "supervise",
          options.strategy,
          options.key
        )
      );
      const windowMs = parseDurationToMs(options.window);
      if (windowMs === undefined || windowMs <= 0) {
        throw new Error("ctx.supervise() requires a positive window duration");
      }

      const group = await client.resolveSupervisionGroup(activation.leaseId, {
        key,
        strategy: options.strategy,
        maxRestarts: options.maxRestarts,
        windowMs,
        onExhausted: options.onExhausted,
      });
      const implicitGroupMemberCounters = new Map<string, number>();

      return {
        id: group.id,
        strategy: group.strategy,
        maxRestarts: group.maxRestarts,
        windowMs: group.windowMs,
        onExhausted: group.onExhausted,
        async members(): Promise<SupervisionMemberInfo[]> {
          const members = await client.listSupervisionMembers(activation.leaseId, group.id);
          return members.map((member) => ({
            key: member.key,
            definitionName: member.definitionName,
            status: member.status as SupervisionMemberStatus,
            currentRunId: member.currentChildRunId,
            generation: member.generation,
            input: member.input,
          }));
        },
        async spawn<TInput, TOutput>(
          definition: WorkflowDefinition<TInput, TOutput>,
          input: TInput,
          spawnOptions: SupervisedSpawnOptions = {}
        ): Promise<SupervisedWorkflowHandle<TOutput>> {
          const memberKey = nextImplicitSupervisionMemberKey(
            implicitGroupMemberCounters,
            definition.name,
            spawnOptions.key
          );
          const member = await client.resolveSupervisionMember(activation.leaseId, group.id, {
            name: definition.name,
            key: memberKey,
            input,
          });
          const resultKey = scopeActivationOpKey(
            activation,
            nextImplicitActivationOpKey(
              implicitActivationOpCounters,
              "supervision_member_result",
              `${group.id}:${member.key}`
            )
          );

          return {
            groupId: group.id,
            key: member.key,
            async result() {
              const resolved = await client.resolveSupervisionMemberResult(
                activation.leaseId,
                group.id,
                member.key,
                { key: resultKey }
              );

              if (resolved.status === "completed") {
                return resolved.output as TOutput;
              }

              if (resolved.status === "failed") {
                throw toChildRunError(
                  `${group.id}:${member.key}`,
                  "error" in resolved ? resolved.error : null
                );
              }

              throw new RunSuspendedError(
                "supervision_member_result",
                `supervision_member_result:${group.id}:${member.key}`
              );
            },
            async status() {
              const current = await client.getSupervisionMemberStatus(
                activation.leaseId,
                group.id,
                member.key
              );

              return current.status as SupervisionMemberStatus;
            },
            async currentRunId() {
              const current = await client.getSupervisionMemberStatus(
                activation.leaseId,
                group.id,
                member.key
              );

              return current.currentChildRunId ?? null;
            },
            async signal(name: string, payload?: unknown) {
              const current = await client.getSupervisionMemberStatus(
                activation.leaseId,
                group.id,
                member.key
              );

              if (!current.currentChildRunId) {
                throw new Error(
                  `Supervised member '${member.key}' has no active child run to signal`
                );
              }

              await client.sendChildRunSignal(
                activation.leaseId,
                current.currentChildRunId,
                name,
                payload ?? null
              );
            },
          };
        },
      };
    },
    async trapExit(enabled = true) {
      await client.setTrapExits(activation.leaseId, enabled);
    },
    async nextExit(options?: { key?: string }) {
      const key = scopeActivationOpKey(
        activation,
        nextImplicitActivationOpKey(
          implicitActivationOpCounters,
          "next_exit",
          activation.run.id,
          options?.key
        )
      );
      const resolved = await client.resolveExitWait(activation.leaseId, { key });
      if (resolved.status === "completed") {
        return resolved.output as ExitEvent;
      }

      throw new RunSuspendedError("exit", key);
    },
    async mailbox() {
      if (activation.kind !== "service_turn") {
        throw new Error("ctx.mailbox() is only available in service turns");
      }

      return await client.getServiceTurnMailbox(activation.leaseId, activation.envelope.id);
    },
    async subscribe(topic: string, options?: { signal?: string }): Promise<TopicSubscriptionRef> {
      if (activation.kind !== "service_turn") {
        throw new Error("ctx.subscribe() is only available in service turns");
      }

      const signal = options?.signal ?? topic;
      const availableSignals = currentServiceDefinition?.onSignal;
      if (!availableSignals || !(signal in availableSignals)) {
        const serviceName = currentServiceDefinition?.name ?? activation.definition.name;
        throw new Error(
          `Service '${serviceName}' cannot subscribe topic '${topic}' with unknown signal '${signal}'`
        );
      }

      return await client.subscribeTopic(activation.leaseId, {
        topic,
        signal,
      });
    },
    async unsubscribe(topic: string, options?: { signal?: string }): Promise<void> {
      if (activation.kind !== "service_turn") {
        throw new Error("ctx.unsubscribe() is only available in service turns");
      }

      await client.unsubscribeTopic(activation.leaseId, {
        topic,
        signal: options?.signal ?? topic,
      });
    },
    async defer(options: { delay: string; reason?: string }): Promise<never> {
      if (activation.kind !== "service_turn") {
        throw new Error("ctx.defer() is only available in service turns");
      }

      const delayMs = parseDurationToMs(options.delay);
      if (delayMs === undefined || delayMs <= 0) {
        throw new Error("ctx.defer() requires a positive delay");
      }

      await client.deferServiceTurn(activation.leaseId, activation.envelope.id, {
        delayMs,
        reason: options.reason,
      });

      throw new TurnHandledError("deferred");
    },
    async reject(error: { message: string; reason?: string; details?: unknown }): Promise<never> {
      if (activation.kind !== "service_turn") {
        throw new Error("ctx.reject() is only available in service turns");
      }

      await client.rejectServiceTurn(activation.leaseId, activation.envelope.id, {
        error: {
          name: "ServiceTurnRejectedError",
          message: error.message,
          reason: error.reason ?? "service_turn_rejected",
          details: error.details ?? null,
        },
      });

      throw new TurnHandledError("rejected");
    },
  };
}
