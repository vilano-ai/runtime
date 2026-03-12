import { workflow } from "@vilano/runtime";

import { boundedMailboxProbe, mailboxProbe, pubsubProbe } from "./services.ts";

export const mailboxAskWorkflow = workflow({
  name: "mailboxAskWorkflow",
  run: async (input: { sessionId: string; id: string; delayMs?: number }, ctx) => {
    const ref = await ctx.connect(mailboxProbe, { sessionId: input.sessionId });
    return await ref.ask.delay({ id: input.id, delayMs: input.delayMs ?? 0 });
  },
});

export const mailboxSnapshotWorkflow = workflow({
  name: "mailboxSnapshotWorkflow",
  run: async (input: { sessionId: string }, ctx) => {
    const ref = await ctx.connect(mailboxProbe, { sessionId: input.sessionId });

    await ref.send.recordMailbox({ id: "record-mailbox" }, { key: "record-mailbox" });
    await ref.send.appendLog({ value: "queued-send" }, { key: "queued-send" });

    return await ref.ask.recordedMailbox(undefined, { key: "recorded-mailbox" });
  },
});

export const mailboxDeferredFollowup = workflow({
  name: "mailboxDeferredFollowup",
  run: async (input: { sessionId: string; delay?: string; value: string }, ctx) => {
    await ctx.sleep(input.delay ?? "50ms", { key: "mailbox-deferred-followup-delay" });

    const ref = await ctx.connect(mailboxProbe, { sessionId: input.sessionId });
    await ref.send.appendLog({ value: input.value }, { key: `append-log:${input.value}` });

    return { value: input.value };
  },
});

export const mailboxDeferWorkflow = workflow({
  name: "mailboxDeferWorkflow",
  run: async (
    input: { sessionId: string; delay?: string; followupDelay?: string; followupValue?: string },
    ctx
  ) => {
    const ref = await ctx.connect(mailboxProbe, { sessionId: input.sessionId });
    const followup = ctx.spawn(
      mailboxDeferredFollowup,
      {
        sessionId: input.sessionId,
        delay: input.followupDelay ?? "50ms",
        value: input.followupValue ?? "after-defer",
      },
      { key: "followup" }
    );

    const reply = await ref.ask.deferOnce(
      { delay: input.delay ?? "200ms" },
      { key: "defer-once" }
    );

    await followup.result();
    return reply;
  },
});

export const mailboxRejectWorkflow = workflow({
  name: "mailboxRejectWorkflow",
  run: async (input: { sessionId: string; message?: string }, ctx) => {
    const ref = await ctx.connect(mailboxProbe, { sessionId: input.sessionId });

    try {
      await ref.ask.rejectTurn(
        { message: input.message ?? "mailbox turn rejected" },
        { key: "reject-turn" }
      );

      return { rejected: false };
    } catch (error) {
      const cause =
        error instanceof Error && "cause" in error ? (error as Error & { cause?: unknown }).cause : null;

      return {
        rejected: true,
        message: error instanceof Error ? error.message : String(error),
        reason:
          cause && typeof cause === "object" && "reason" in cause
            ? String((cause as { reason?: unknown }).reason)
            : null,
      };
    }
  },
});

export const boundedMailboxDelayWorkflow = workflow({
  name: "boundedMailboxDelayWorkflow",
  run: async (input: { sessionId: string; id: string; delayMs?: number }, ctx) => {
    const ref = await ctx.connect(boundedMailboxProbe, { sessionId: input.sessionId });
    return await ref.ask.delay({ id: input.id, delayMs: input.delayMs ?? 0 });
  },
});

export const boundedMailboxOverflowWorkflow = workflow({
  name: "boundedMailboxOverflowWorkflow",
  run: async (input: { sessionId: string }, ctx) => {
    const ref = await ctx.connect(boundedMailboxProbe, { sessionId: input.sessionId });

    try {
      await ref.ask.history(undefined, { key: "overflow-history" });
      return { overloaded: false };
    } catch (error) {
      const cause =
        error instanceof Error && "cause" in error ? (error as Error & { cause?: unknown }).cause : null;

      return {
        overloaded: true,
        message: error instanceof Error ? error.message : String(error),
        reason:
          cause && typeof cause === "object" && "reason" in cause
            ? String((cause as { reason?: unknown }).reason)
            : null,
      };
    }
  },
});

export const topicPublisher = workflow({
  name: "topicPublisher",
  run: async (input: { topic: string; value?: string; key?: string }, ctx) => {
    return await ctx.publish(
      input.topic,
      { value: input.value ?? input.topic },
      { key: input.key }
    );
  },
});

export const pubsubDeliveryCoordinator = workflow({
  name: "pubsubDeliveryCoordinator",
  run: async (input: { sessionId: string; topic: string; value?: string }, ctx) => {
    const ref = await ctx.connect(pubsubProbe, { sessionId: input.sessionId });
    const subscription = await ref.ask.subscribeTopic({
      topic: input.topic,
      signal: "topicEvent",
    });
    const publish = await ctx.publish(input.topic, {
      value: input.value ?? input.topic,
    });
    const events = await ref.ask.events();

    return { subscription, publish, events };
  },
});

export const pubsubDedupeCoordinator = workflow({
  name: "pubsubDedupeCoordinator",
  run: async (input: { sessionId: string; topic: string; value?: string }, ctx) => {
    const ref = await ctx.connect(pubsubProbe, { sessionId: input.sessionId });
    await ref.ask.subscribeTopic({
      topic: input.topic,
      signal: "topicEvent",
    });

    const first = await ctx.publish(
      input.topic,
      { value: input.value ?? input.topic },
      { key: "deduped-publish" }
    );
    const second = await ctx.publish(
      input.topic,
      { value: input.value ?? input.topic },
      { key: "deduped-publish" }
    );
    const events = await ref.ask.events();

    return { first, second, events };
  },
});

export const pubsubUnsubscribeCoordinator = workflow({
  name: "pubsubUnsubscribeCoordinator",
  run: async (input: { sessionId: string; topic: string; value?: string }, ctx) => {
    const ref = await ctx.connect(pubsubProbe, { sessionId: input.sessionId });
    await ref.ask.subscribeTopic({
      topic: input.topic,
      signal: "topicEvent",
    });
    await ref.ask.unsubscribeTopic({
      topic: input.topic,
      signal: "topicEvent",
    });

    const publish = await ctx.publish(input.topic, {
      value: input.value ?? input.topic,
    });
    const events = await ref.ask.events();

    return { publish, events };
  },
});

export const pubsubInvalidSubscriptionCoordinator = workflow({
  name: "pubsubInvalidSubscriptionCoordinator",
  run: async (input: { sessionId: string; topic: string; signal: string }, ctx) => {
    const ref = await ctx.connect(pubsubProbe, { sessionId: input.sessionId });
    return await ref.ask.subscribeInvalidTopic({
      topic: input.topic,
      signal: input.signal,
    });
  },
});
