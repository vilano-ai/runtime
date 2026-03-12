import { workflow } from "@vilano/runtime";

import { bumpMarkerAttempt } from "./demo-shared";
import { childTask } from "./workflows-core";

export const relationshipChild = workflow({
  name: "relationshipChild",
  run: async (
    input: { mode: "complete" | "fail"; duration?: string; value?: string },
    ctx
  ) => {
    if (input.duration) {
      await ctx.sleep(input.duration, { key: "relationship-child-delay" });
    }

    if (input.mode === "fail") {
      throw new Error(input.value ?? "relationship child failed");
    }

    return { value: input.value ?? "relationship-child-ok" };
  },
});

export const childMonitorCoordinator = workflow({
  name: "childMonitorCoordinator",
  run: async (
    input: { mode: "complete" | "fail"; duration?: string; value?: string },
    ctx
  ) => {
    const child = ctx.spawn(relationshipChild, input, { key: "child" });
    await child.monitor({ key: "monitor" });
    const exit = await ctx.nextExit({ key: "exit" });

    return { childRunId: child.id, exit };
  },
});

export const trappedChildLinkCoordinator = workflow({
  name: "trappedChildLinkCoordinator",
  run: async (input: { duration?: string; value?: string }, ctx) => {
    await ctx.trapExit();

    const child = ctx.spawn(
      relationshipChild,
      {
        mode: "fail",
        duration: input.duration ?? "50ms",
        value: input.value ?? "linked child failed",
      },
      { key: "child" }
    );

    await child.link({ key: "link" });
    const exit = await ctx.nextExit({ key: "exit" });

    return { childRunId: child.id, exit };
  },
});

export const linkedChildCancellationCoordinator = workflow({
  name: "linkedChildCancellationCoordinator",
  run: async (input: { duration?: string; value?: string }, ctx) => {
    const child = ctx.spawn(
      relationshipChild,
      {
        mode: "fail",
        duration: input.duration ?? "50ms",
        value: input.value ?? "linked child failed",
      },
      { key: "child" }
    );

    await child.link({ key: "link" });
    await ctx.sleep("30s", { key: "linked-child-cancel-wait" });

    return { childRunId: child.id };
  },
});

export const supervisedFlakyChild = workflow({
  name: "supervisedFlakyChild",
  run: async (
    input: { markerPath: string; failCount?: number; sleep?: string; value?: string },
    ctx
  ) => {
    const attempt = await bumpMarkerAttempt(input.markerPath);

    if (input.sleep) {
      await ctx.sleep(input.sleep, { key: "supervised-flaky-child-sleep" });
    }

    if (attempt <= (input.failCount ?? 0)) {
      throw new Error(input.value ?? `supervised child failed on attempt ${attempt}`);
    }

    return { attempt, value: input.value ?? "supervised-child-ok" };
  },
});

export const supervisionOneForOneCoordinator = workflow({
  name: "supervisionOneForOneCoordinator",
  run: async (
    input: { markerPath: string; failCount?: number; maxRestarts?: number; window?: string; value?: string },
    ctx
  ) => {
    const group = await ctx.supervise({
      key: "one-for-one-group",
      strategy: "one_for_one",
      maxRestarts: input.maxRestarts ?? 1,
      window: input.window ?? "1m",
      onExhausted: "fail_self",
    });
    const member = await group.spawn(
      supervisedFlakyChild,
      {
        markerPath: input.markerPath,
        failCount: input.failCount ?? 1,
        value: input.value ?? "supervised-one-for-one",
      },
      { key: "worker" }
    );
    const initialRunId = await member.currentRunId();
    const output = await member.result();
    const finalRunId = await member.currentRunId();

    return { initialRunId, finalRunId, output };
  },
});

export const supervisionExhaustionCoordinator = workflow({
  name: "supervisionExhaustionCoordinator",
  run: async (
    input: { markerPath: string; failCount?: number; maxRestarts?: number; window?: string; value?: string },
    ctx
  ) => {
    const group = await ctx.supervise({
      key: "exhaustion-group",
      strategy: "one_for_one",
      maxRestarts: input.maxRestarts ?? 1,
      window: input.window ?? "1m",
      onExhausted: "fail_self",
    });
    const member = await group.spawn(
      supervisedFlakyChild,
      {
        markerPath: input.markerPath,
        failCount: input.failCount ?? 3,
        value: input.value ?? "supervision exhausted",
      },
      { key: "worker" }
    );

    return await member.result();
  },
});

export const supervisionOneForAllCoordinator = workflow({
  name: "supervisionOneForAllCoordinator",
  run: async (
    input: { flakyMarkerPath: string; siblingMarkerPath: string; maxRestarts?: number; window?: string },
    ctx
  ) => {
    const group = await ctx.supervise({
      key: "one-for-all-group",
      strategy: "one_for_all",
      maxRestarts: input.maxRestarts ?? 1,
      window: input.window ?? "1m",
      onExhausted: "fail_self",
    });
    const flaky = await group.spawn(
      supervisedFlakyChild,
      {
        markerPath: input.flakyMarkerPath,
        failCount: 1,
        value: "supervised-flaky",
      },
      { key: "flaky" }
    );
    const sibling = await group.spawn(
      supervisedFlakyChild,
      {
        markerPath: input.siblingMarkerPath,
        failCount: 0,
        sleep: "2s",
        value: "supervised-sibling",
      },
      { key: "sibling" }
    );
    const initialFlakyRunId = await flaky.currentRunId();
    const initialSiblingRunId = await sibling.currentRunId();
    const [flakyOutput, siblingOutput] = await Promise.all([flaky.result(), sibling.result()]);
    const finalFlakyRunId = await flaky.currentRunId();
    const finalSiblingRunId = await sibling.currentRunId();

    return {
      initialFlakyRunId,
      initialSiblingRunId,
      finalFlakyRunId,
      finalSiblingRunId,
      flakyOutput,
      siblingOutput,
    };
  },
});

export const supervisionMembersCoordinator = workflow({
  name: "supervisionMembersCoordinator",
  run: async (input: { topic: string }, ctx) => {
    const group = await ctx.supervise({
      key: "supervision-members",
      strategy: "one_for_one",
      maxRestarts: 1,
      window: "1m",
    });

    const first = await group.spawn(childTask, { topic: input.topic }, { key: "first" });
    const second = await group.spawn(childTask, { topic: `${input.topic}-second` }, { key: "second" });

    await first.result();
    await second.result();

    return { members: await group.members() };
  },
});
