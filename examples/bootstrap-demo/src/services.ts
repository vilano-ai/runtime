import { nonRetryable, service } from "@vilano/runtime";

import { childTask } from "./workflows-core.ts";

export const reviewer = service({
  name: "reviewer",
  key: (input: { repoId: string }) => input.repoId,
  init: async (input: { repoId: string }) => ({
    repoId: input.repoId,
    notes: [] as string[],
  }),
  onAsk: {
    status: async (_payload: void, state) => ({
      reply: {
        ready: true,
        notes: state.notes.length,
      },
    }),
  },
  onSend: {
    hint: async (payload: { note: string }, state) => ({
      state: {
        ...state,
        notes: [...state.notes, payload.note],
      },
    }),
  },
  onSignal: {
    reset: async (_payload: void, state) => ({
      state: {
        ...state,
        notes: [],
      },
    }),
  },
});

export const operator = service({
  name: "operator",
  discovery: {
    singletonRole: "operator",
  },
  key: (input: { sessionId: string }) => input.sessionId,
  init: async (input: { sessionId: string }) => ({
    sessionId: input.sessionId,
    approvals: 0,
  }),
  onAsk: {
    pipeline: async (payload: { topic: string }, state, ctx) => {
      await ctx.sleep("50ms", { key: `pause:${payload.topic}` });

      const child = ctx.spawn(childTask, { topic: payload.topic }, { key: `child:${payload.topic}` });
      const childResult = await child.result();

      const execResult = await ctx.exec({
        name: "operator-pipeline",
        key: `exec:${payload.topic}`,
        cmd: "bun",
        args: [
          "-e",
          `console.log(JSON.stringify(${JSON.stringify({
            summary: `operator:${payload.topic}`,
          })}))`,
        ],
        capture: {
          stdout: true,
        },
        parse: (stdout) => JSON.parse(stdout.trim()) as { summary: string },
      });

      return {
        reply: {
          child: childResult,
          exec: execResult,
          approvals: state.approvals,
        },
      };
    },
    slowStep: async (payload: { durationMs?: number }, _state, ctx) => {
      const result = await ctx.step(
        "slow-step",
        async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, payload.durationMs ?? 1500);
          });

          return { waitedMs: payload.durationMs ?? 1500 };
        },
        { key: `slow-step:${payload.durationMs ?? 1500}` }
      );

      return { reply: result };
    },
    blockingStep: async (payload: { durationMs?: number; timeout?: string }, _state, ctx) => {
      const result = await ctx.step(
        "blocking-service-step",
        async () => {
          const durationMs = payload.durationMs ?? 5_000;
          const deadline = Date.now() + durationMs;

          while (Date.now() < deadline) {
            // Intentionally blocks the event loop to exercise kernel-enforced service turn termination.
          }

          return { waitedMs: durationMs };
        },
        {
          key: `blocking-service-step:${payload.durationMs ?? 5_000}`,
          timeout: payload.timeout,
        }
      );

      return { reply: result };
    },
    awaitApproval: async (_payload: void, state, ctx) => {
      const approval = await ctx.waitForSignal("approved", { key: "approved" });

      return {
        reply: {
          approval,
          sessionId: state.sessionId,
        },
      };
    },
  },
});

export const retryingResponder = service({
  name: "retryingResponder",
  retry: {
    retries: 1,
    backoff: "50ms",
  },
  key: (input: { sessionId: string }) => input.sessionId,
  onAsk: {
    unstable: async (payload: { token: string }, _state, ctx) => {
      const attempt = ctx.turnAttempt;

      if (attempt === 1) {
        throw new Error("transient service failure");
      }

      return {
        reply: {
          attempt,
          token: payload.token,
        },
      };
    },
  },
});

export const mailboxProbe = service({
  name: "mailboxProbe",
  key: (input: { sessionId: string }) => input.sessionId,
  init: async (input: { sessionId: string }) => ({
    sessionId: input.sessionId,
    history: [] as string[],
    log: [] as string[],
    recordedMailbox: null as unknown,
  }),
  onSend: {
    record: async (payload: { id: string }, state) => ({
      state: {
        ...state,
        history: [...state.history, `send:${payload.id}`],
      },
    }),
    recordMailbox: async (payload: { id: string }, state, ctx) => ({
      state: {
        ...state,
        history: [...state.history, `send:${payload.id}`],
        recordedMailbox: await ctx.mailbox(),
      },
    }),
    appendLog: async (payload: { value: string }, state) => ({
      state: {
        ...state,
        log: [...state.log, payload.value],
      },
    }),
  },
  onAsk: {
    delay: async (payload: { id: string; delayMs?: number }, state, ctx) => {
      if ((payload.delayMs ?? 0) > 0) {
        await ctx.step(
          "mailbox-delay",
          async () => {
            await new Promise((resolve) => {
              setTimeout(resolve, payload.delayMs ?? 0);
            });

            return null;
          },
          { key: `mailbox-delay:${payload.id}:${payload.delayMs ?? 0}` }
        );
      }

      const history = [...state.history, `ask:${payload.id}`];

      return {
        state: {
          ...state,
          history,
        },
        reply: {
          id: payload.id,
          history,
        },
      };
    },
    stopAfterDelay: async (payload: { delayMs?: number }, state, ctx) => {
      if ((payload.delayMs ?? 0) > 0) {
        await ctx.step(
          "mailbox-stop-delay",
          async () => {
            await new Promise((resolve) => {
              setTimeout(resolve, payload.delayMs ?? 0);
            });

            return null;
          },
          { key: `mailbox-stop-delay:${payload.delayMs ?? 0}` }
        );
      }

      return {
        state: {
          ...state,
          history: [...state.history, "ask:stop"],
        },
        reply: {
          stopped: true,
        },
        stop: true,
      };
    },
    history: async (_payload: Record<string, never>, state) => ({
      reply: {
        history: state.history,
      },
    }),
    recordedMailbox: async (_payload: void, state) => ({
      reply: state.recordedMailbox,
    }),
    deferOnce: async (payload: { delay?: string }, state, ctx) => {
      if (ctx.turnAttempt === 1) {
        await ctx.defer({
          delay: payload.delay ?? "200ms",
          reason: "mailbox_not_ready",
        });
      }

      return {
        reply: {
          attempt: ctx.turnAttempt,
          log: state.log,
          mailbox: await ctx.mailbox(),
        },
      };
    },
    rejectTurn: async (payload: { message?: string }, _state, ctx) => {
      await ctx.reject({
        message: payload.message ?? "mailbox turn rejected",
        reason: "mailbox_rejected",
      });
    },
  },
});

export const boundedMailboxProbe = service({
  name: "boundedMailboxProbe",
  mailbox: {
    maxQueued: 1,
    overload: "reject_new",
  },
  key: (input: { sessionId: string }) => input.sessionId,
  init: async (input: { sessionId: string }) => ({
    sessionId: input.sessionId,
    history: [] as string[],
  }),
  onSend: {
    record: async (payload: { id: string }, state) => ({
      state: {
        ...state,
        history: [...state.history, `send:${payload.id}`],
      },
    }),
  },
  onAsk: {
    delay: async (payload: { id: string; delayMs?: number }, state, ctx) => {
      if ((payload.delayMs ?? 0) > 0) {
        await ctx.step(
          "bounded-mailbox-delay",
          async () => {
            await new Promise((resolve) => {
              setTimeout(resolve, payload.delayMs ?? 0);
            });

            return null;
          },
          { key: `bounded-mailbox-delay:${payload.id}:${payload.delayMs ?? 0}` }
        );
      }

      const history = [...state.history, `ask:${payload.id}`];

      return {
        state: {
          ...state,
          history,
        },
        reply: {
          id: payload.id,
          history,
        },
      };
    },
    history: async (_payload: void, state) => ({
      reply: {
        history: state.history,
      },
    }),
  },
});

export const optionsPayloadProbe = service({
  name: "optionsPayloadProbe",
  key: (input: { sessionId: string }) => input.sessionId,
  onAsk: {
    echo: async (payload: { key: string; timeout: string }) => ({
      reply: payload,
    }),
  },
});

export const pubsubProbe = service({
  name: "pubsubProbe",
  key: (input: { sessionId: string }) => input.sessionId,
  init: async (input: { sessionId: string }) => ({
    sessionId: input.sessionId,
    subscriptions: [] as Array<{ topic: string; signal: string }>,
    events: [] as Array<{
      topic: string;
      value: string | null;
      publishId: string;
      publisherRunId: string;
      signal: string;
    }>,
  }),
  onAsk: {
    subscribeTopic: async (payload: { topic: string; signal?: string }, state, ctx) => {
      const subscription = await ctx.subscribe(payload.topic, {
        signal: payload.signal ?? "topicEvent",
      });

      return {
        state: {
          ...state,
          subscriptions: [
            ...state.subscriptions.filter(
              (entry) =>
                !(entry.topic === subscription.topic && entry.signal === subscription.signal)
            ),
            {
              topic: subscription.topic,
              signal: subscription.signal,
            },
          ],
        },
        reply: subscription,
      };
    },
    subscribeInvalidTopic: async (payload: { topic: string; signal: string }, state, ctx) => {
      const subscription = await ctx.subscribe(payload.topic, {
        signal: payload.signal,
      });

      return {
        state,
        reply: subscription,
      };
    },
    unsubscribeTopic: async (payload: { topic: string; signal?: string }, state, ctx) => {
      const signal = payload.signal ?? "topicEvent";
      await ctx.unsubscribe(payload.topic, { signal });

      return {
        state: {
          ...state,
          subscriptions: state.subscriptions.filter(
            (entry) => !(entry.topic === payload.topic && entry.signal === signal)
          ),
        },
        reply: { ok: true },
      };
    },
    events: async (_payload: void, state) => ({
      reply: {
        subscriptions: state.subscriptions,
        events: state.events,
      },
    }),
  },
  onSignal: {
    topicEvent: async (
      payload: {
        topic: string;
        payload?: { value?: string | null } | null;
        publishId: string;
        publisherRunId: string;
      },
      state
    ) => ({
      state: {
        ...state,
        events: [
          ...state.events,
          {
            topic: payload.topic,
            value:
              payload.payload && typeof payload.payload === "object" && "value" in payload.payload
                ? ((payload.payload as { value?: string | null }).value ?? null)
                : null,
            publishId: payload.publishId,
            publisherRunId: payload.publisherRunId,
            signal: "topicEvent",
          },
        ],
      },
    }),
  },
});

export const serviceTurnIsolationProbe = service({
  name: "serviceTurnIsolationProbe",
  key: (input: { sessionId: string }) => input.sessionId,
  init: async () => ({
    counter: 0,
  }),
  onAsk: {
    sequence: async (_payload: { token: string }, state, ctx) => {
      const first = await ctx.step("repeat-step", async () => state.counter + 1);
      const second = await ctx.step("repeat-step", async () => state.counter + 2);

      return {
        state: {
          counter: state.counter + 2,
        },
        reply: {
          attempts: [first, second],
        },
      };
    },
  },
});

export const timeoutOnlyResponder = service({
  name: "timeoutOnlyResponder",
  retry: {
    retries: 2,
    backoff: "50ms",
    on: ["timeout"],
  },
  key: (input: { sessionId: string }) => input.sessionId,
  onAsk: {
    unstable: async (payload: { token: string }, _state, ctx) => {
      const attempt = ctx.turnAttempt;
      throw new Error(`application failure on attempt ${attempt}`);
    },
  },
});

export const nonRetryingResponder = service({
  name: "nonRetryingResponder",
  retry: {
    retries: 3,
    backoff: "50ms",
  },
  key: (input: { sessionId: string }) => input.sessionId,
  onAsk: {
    unstable: async (payload: { token: string }, _state, ctx) => {
      const attempt = ctx.turnAttempt;
      throw nonRetryable(new Error(`non-retryable service failure on attempt ${attempt}`));
    },
  },
});
