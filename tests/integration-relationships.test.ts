import { expect, test } from "bun:test";
import path from "node:path";
import { RuntimeHarness } from "./runtime-harness.ts";

test("child monitors deliver durable exit events", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/childMonitorCoordinator", {
      mode: "complete",
      duration: "50ms",
      value: "monitor-ok",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );
    const output = completed.run.output as
      | {
          childRunId?: string;
          exit?: { targetId?: string };
        }
      | undefined;
    const childRunId = output?.childRunId;

    expect(completed.run.output).toMatchObject({
      childRunId,
      exit: {
        relationship: "monitor",
        status: "completed",
        targetKind: "workflow",
        output: {
          value: "monitor-ok",
        },
      },
    });

    expect(typeof childRunId).toBe("string");
    expect(output?.exit?.targetId).toBe(childRunId);
    expect(completed.events.map((event) => event.type)).toContain("ExitNotified");
  } finally {
    await harness.dispose();
  }
});

test("trapExit converts linked child failure into a durable exit event", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/trappedChildLinkCoordinator", {
      duration: "50ms",
      value: "trap-linked-child-failure",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );
    const output = completed.run.output as
      | {
          childRunId?: string;
          exit?: { targetId?: string };
        }
      | undefined;
    const childRunId = output?.childRunId;

    expect(completed.run.output).toMatchObject({
      childRunId,
      exit: {
        relationship: "link",
        status: "failed",
        targetKind: "workflow",
        error: {
          message: "trap-linked-child-failure",
        },
      },
    });

    expect(typeof childRunId).toBe("string");
    expect(output?.exit?.targetId).toBe(childRunId);
    expect(completed.events.map((event) => event.type)).toContain("ExitNotified");
  } finally {
    await harness.dispose();
  }
});

test("linked child failures cancel untrapped waiting parents", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/linkedChildCancellationCoordinator", {
      duration: "50ms",
      value: "linked-child-cancelled-parent",
    });

    const cancelled = await harness.waitForRun(
      run.run.id,
      (inspect) =>
        inspect.run.status === "cancelled" &&
        inspect.children.length === 1 &&
        inspect.children[0]?.status === "failed"
    );

    expect(cancelled.run.error).toMatchObject({
      reason: "linked_exit",
      targetStatus: "failed",
    });
    expect(cancelled.events.map((event) => event.type)).toContain("LinkedExitPropagated");
  } finally {
    await harness.dispose();
  }
});

test("one_for_one supervision restarts a failed child and preserves logical result waiting", async () => {
  const harness = await RuntimeHarness.create();
  const markerPath = path.join(harness.homeDir, "supervision-one-for-one-marker.txt");

  try {
    const run = await harness.startWorkflow("demo/supervisionOneForOneCoordinator", {
      markerPath,
      failCount: 1,
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );
    const output = completed.run.output as
      | {
          initialRunId?: string;
          finalRunId?: string;
          output?: { attempt?: number };
        }
      | undefined;

    expect(output?.output?.attempt).toBe(2);
    expect(output?.initialRunId).toBeTruthy();
    expect(output?.finalRunId).toBeTruthy();
    expect(completed.children).toHaveLength(2);
    expect(completed.children.map((child) => child.status)).toEqual(
      expect.arrayContaining(["failed", "completed"])
    );
    expect(completed.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["SupervisionGroupRegistered", "SupervisionMemberRestarted"])
    );
  } finally {
    await harness.dispose();
  }
});

test("one_for_all supervision restarts sibling members when one child fails", async () => {
  const harness = await RuntimeHarness.create();
  const flakyMarkerPath = path.join(harness.homeDir, "supervision-one-for-all-flaky.txt");
  const siblingMarkerPath = path.join(harness.homeDir, "supervision-one-for-all-sibling.txt");

  try {
    const run = await harness.startWorkflow("demo/supervisionOneForAllCoordinator", {
      flakyMarkerPath,
      siblingMarkerPath,
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );
    const output = completed.run.output as
      | {
          initialFlakyRunId?: string;
          initialSiblingRunId?: string;
          finalFlakyRunId?: string;
          finalSiblingRunId?: string;
          flakyOutput?: { attempt?: number };
          siblingOutput?: { attempt?: number };
        }
      | undefined;

    expect(output?.flakyOutput?.attempt).toBe(2);
    expect(output?.initialFlakyRunId).toBeTruthy();
    expect(output?.initialSiblingRunId).toBeTruthy();
    expect(output?.finalFlakyRunId).toBeTruthy();
    expect(output?.finalSiblingRunId).toBeTruthy();
    expect(completed.children).toHaveLength(4);
    expect(completed.children.map((child) => child.status)).toEqual(
      expect.arrayContaining(["failed", "cancelled", "completed", "completed"])
    );
    expect(completed.events.map((event) => event.type)).toContain("SupervisionGroupRestarting");
  } finally {
    await harness.dispose();
  }
});

test("supervision exhaustion fails the owner when restart budget is exceeded", async () => {
  const harness = await RuntimeHarness.create();
  const markerPath = path.join(harness.homeDir, "supervision-exhaustion-marker.txt");

  try {
    const run = await harness.startWorkflow("demo/supervisionExhaustionCoordinator", {
      markerPath,
      failCount: 3,
      maxRestarts: 1,
    });

    const failed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "failed"
    );

    expect(failed.run.error).toMatchObject({
      reason: "supervision_exhausted",
      name: "SupervisionExhaustedError",
    });
    expect(failed.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["SupervisionGroupExhausted", "RunFailed"])
    );
  } finally {
    await harness.dispose();
  }
});

test("supervision groups can list logical members and their current runtime state", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/supervisionMembersCoordinator", {
      topic: "group-members",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );
    const output = completed.run.output as
      | {
          members?: Array<{
            key?: string;
            definitionName?: string;
            status?: string;
            generation?: number;
            currentRunId?: string | null;
            input?: { topic?: string };
          }>;
        }
      | undefined;

    expect(output?.members).toHaveLength(2);
    expect(output?.members?.map((member) => member.key)).toEqual(["first", "second"]);
    expect(output?.members?.map((member) => member.definitionName)).toEqual([
      "childTask",
      "childTask",
    ]);
    expect(output?.members?.map((member) => member.status)).toEqual(["completed", "completed"]);
    expect(output?.members?.every((member) => member.generation === 1)).toBe(true);
    expect(output?.members?.every((member) => Boolean(member.currentRunId))).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("singleton discovery resolves existing services by role and preserves related-run semantics", async () => {
  const harness = await RuntimeHarness.create();

  try {
    const run = await harness.startWorkflow("demo/singletonLookupCoordinator", {
      sessionId: "singleton-lookup",
      topic: "singleton-discovery",
    });

    const completed = await harness.waitForRun(
      run.run.id,
      (inspect) => inspect.run.status === "completed"
    );
    const output = completed.run.output as
      | {
          connectedRunId?: string;
          typedRunId?: string;
          discoveredRunId?: string;
          discoveredDefinition?: string;
          discoveredKey?: string;
          discoveredStatus?: string;
          typedResult?: { child?: { summary?: string } };
          discoveredResult?: { child?: { summary?: string } };
        }
      | undefined;

    expect(output?.connectedRunId).toBeTruthy();
    expect(output?.typedRunId).toBe(output?.connectedRunId);
    expect(output?.discoveredRunId).toBe(output?.connectedRunId);
    expect(output?.discoveredDefinition).toBe("operator");
    expect(output?.discoveredKey).toBe("singleton-lookup");
    expect(output?.discoveredStatus).toBe("idle");
    expect(output?.typedResult?.child?.summary).toBe("child planned: singleton-discovery-typed");
    expect(output?.discoveredResult?.child?.summary).toBe("child planned: singleton-discovery");
  } finally {
    await harness.dispose();
  }
});
