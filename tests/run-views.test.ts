import { expect, test } from "bun:test";

import { renderRun } from "../cli/src/run-views/base.ts";
import { renderRunExplain } from "../cli/src/run-views/explain.ts";
import { renderRunInspect } from "../cli/src/run-views/inspect.ts";
import type {
  RunChildRecord,
  RunEnvelopeRecord,
  RunRecord,
  RunTurnRecord,
  RunWaitRecord,
} from "../cli/src/types.ts";

test("renderRun handles wakeReason-only service passivation", () => {
  const output = renderRun({
    id: "run_service",
    project: "demo",
    definitionKind: "service",
    definitionName: "reviewer",
    status: "idle",
    input: { repoId: "repo_123" },
    output: null,
    error: null,
    passivation: {
      state: "passivated",
      wakeReason: "message",
    },
    createdAt: "2026-03-16T00:00:00.000Z",
    updatedAt: "2026-03-16T00:00:00.000Z",
  } satisfies RunRecord);

  expect(output).toContain("passivation_state: passivated");
  expect(output).toContain("wake_reason: message");
  expect(output).not.toContain("wake_on:");
});

test("renderRunExplain summarizes waiting parents and active child runs", () => {
  const run = baseRun({ status: "waiting" });
  const waits = [
    {
      runId: run.id,
      key: "spawn:writer",
      kind: "child_result",
      name: "writer",
      status: "waiting",
      wakeAt: null,
      output: null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    } satisfies RunWaitRecord,
  ];
  const children = [
    {
      parentRunId: run.id,
      key: "spawn:writer",
      childRunId: "run_writer_1",
      definitionName: "writer",
      status: "running",
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    } satisfies RunChildRecord,
  ];

  const output = renderRunExplain(run, [], [], waits, children, [], []);

  expect(output).toContain("summary: run has 1 active wait");
  expect(output).toContain("critical_path: child_result key=spawn:writer status=waiting");
  expect(output).toContain("active_child: writer run=run_writer_1 key=spawn:writer status=running");
});

test("renderRunInspect includes explain summary for waiting service turns", () => {
  const run = baseRun({ definitionKind: "service", definitionName: "reviewer", status: "active" });
  const envelopes = [
    {
      id: "env_1",
      serviceRunId: run.id,
      kind: "ask",
      name: "review",
      payload: null,
      correlationId: "corr_1",
      senderRunId: "run_parent",
      status: "processing",
      reply: null,
      error: null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    } satisfies RunEnvelopeRecord,
  ];
  const turns = [
    {
      envelopeId: "env_1",
      kind: "ask",
      name: "review",
      status: "processing",
      phase: "waiting",
      attempts: 1,
      correlationId: "corr_1",
      senderRunId: "run_parent",
      waitKind: "signal",
      waitKey: "approved",
      waitName: "approved",
      lastResumeReason: null,
      lastEventType: "TurnWaiting",
      lastEventAt: run.updatedAt,
      reply: null,
      error: null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    } satisfies RunTurnRecord,
  ];

  const output = renderRunInspect(run, [], [], [], [], [], [], envelopes, turns, []);

  expect(output).toContain("explain:");
  expect(output).toContain("summary: run is waiting on signal:approved");
  expect(output).toContain("waiting_turn: ask review envelope=env_1 status=processing phase=waiting waiting_on=signal:approved");
  expect(output).toContain("mailbox: processing=1 queued=0");
});

function baseRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run_123",
    project: "demo",
    definitionKind: "workflow",
    definitionName: "planner",
    status: "active",
    input: { repoId: "repo_123" },
    output: null,
    error: null,
    createdAt: "2026-03-18T00:00:00.000Z",
    updatedAt: "2026-03-18T00:00:00.000Z",
    ...overrides,
  };
}
