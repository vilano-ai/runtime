import type {
  RunChildRecord,
  RunEnvelopeRecord,
  RunExecRecord,
  RunRecord,
  RunStepRecord,
  RunTurnRecord,
  RunWaitRecord,
} from "../types.ts";
import { renderRun } from "./base.ts";

const TERMINAL_STATUSES = new Set([
  "cancelled",
  "completed",
  "consumed",
  "failed",
  "stopped",
  "succeeded",
]);

export interface RunExplainRecord {
  summary: string;
  criticalPath: string;
  waitingTurn: string | null;
  activeTurn: string | null;
  activeSteps: string[];
  activeExecs: string[];
  waits: string[];
  activeChildren: string[];
  mailbox:
    | {
        processing: number;
        queued: number;
      }
    | null;
}

export function renderRunExplain(
  run: RunRecord,
  steps: RunStepRecord[],
  execs: RunExecRecord[],
  waits: RunWaitRecord[],
  children: RunChildRecord[],
  envelopes: RunEnvelopeRecord[],
  turns: RunTurnRecord[]
): string {
  const explain = buildRunExplain(run, steps, execs, waits, children, envelopes, turns);
  return [
    renderRun(run),
    ...renderRunExplainSummary(explain),
  ].join("\n");
}

export function buildRunExplain(
  run: RunRecord,
  steps: RunStepRecord[],
  execs: RunExecRecord[],
  waits: RunWaitRecord[],
  children: RunChildRecord[],
  envelopes: RunEnvelopeRecord[],
  turns: RunTurnRecord[]
): RunExplainRecord {
  const activeSteps = steps.filter((step) => isActiveStatus(step.status));
  const activeExecs = execs.filter((exec) => isActiveStatus(exec.status));
  const activeWaits = waits.filter((wait) => isActiveStatus(wait.status));
  const activeChildren = children.filter((child) => isActiveStatus(child.status));
  const activeTurns = turns.filter((turn) => isActiveStatus(turn.status) || turn.phase === "running" || turn.phase === "waiting");
  const processingEnvelopes = envelopes.filter((envelope) => envelope.status === "processing");
  const queuedEnvelopes = envelopes.filter((envelope) => envelope.status === "queued");
  const criticalPath =
    describeWaitingTurn(activeTurns) ??
    describeRecord(activeSteps[0], describeStep) ??
    describeRecord(activeExecs[0], describeExec) ??
    describeRecord(activeWaits[0], describeWait) ??
    describeRecord(activeChildren[0], describeChild) ??
    describeRecord(processingEnvelopes[0] ?? queuedEnvelopes[0], describeEnvelope) ??
    `run is ${run.status}`;

  const summary = summarizeRun(
    run,
    activeSteps,
    activeExecs,
    activeWaits,
    activeChildren,
    activeTurns,
    processingEnvelopes,
    queuedEnvelopes
  );

  const waitingTurn = activeTurns.find((turn) => turn.phase === "waiting");
  const activeTurn = activeTurns.find((turn) => turn.phase === "running");
  return {
    summary,
    criticalPath,
    waitingTurn: waitingTurn ? describeTurn(waitingTurn) : null,
    activeTurn: activeTurn ? describeTurn(activeTurn) : null,
    activeSteps: activeSteps.slice(0, 3).map(describeStep),
    activeExecs: activeExecs.slice(0, 3).map(describeExec),
    waits: activeWaits.slice(0, 3).map(describeWait),
    activeChildren: activeChildren.slice(0, 5).map(describeChild),
    mailbox:
      processingEnvelopes.length > 0 || queuedEnvelopes.length > 0
        ? {
            processing: processingEnvelopes.length,
            queued: queuedEnvelopes.length,
          }
        : null,
  };
}

export function renderRunExplainSummary(explain: RunExplainRecord): string[] {
  const lines = [
    "explain:",
    `  summary: ${explain.summary}`,
    `  critical_path: ${explain.criticalPath}`,
  ];

  if (explain.waitingTurn) {
    lines.push(`  waiting_turn: ${explain.waitingTurn}`);
  }

  if (explain.activeTurn) {
    lines.push(`  active_turn: ${explain.activeTurn}`);
  }

  if (explain.activeSteps.length > 0) {
    for (const step of explain.activeSteps) {
      lines.push(`  active_step: ${step}`);
    }
  } else {
    lines.push("  active_step: none");
  }

  if (explain.activeExecs.length > 0) {
    for (const exec of explain.activeExecs) {
      lines.push(`  active_exec: ${exec}`);
    }
  } else {
    lines.push("  active_exec: none");
  }

  if (explain.waits.length > 0) {
    for (const wait of explain.waits) {
      lines.push(`  waiting_on: ${wait}`);
    }
  } else {
    lines.push("  waiting_on: none");
  }

  if (explain.activeChildren.length > 0) {
    for (const child of explain.activeChildren) {
      lines.push(`  active_child: ${child}`);
    }
  } else {
    lines.push("  active_child: none");
  }

  if (explain.mailbox) {
    lines.push(
      `  mailbox: processing=${explain.mailbox.processing} queued=${explain.mailbox.queued}`
    );
  }

  return lines;
}

function summarizeRun(
  run: RunRecord,
  activeSteps: RunStepRecord[],
  activeExecs: RunExecRecord[],
  activeWaits: RunWaitRecord[],
  activeChildren: RunChildRecord[],
  activeTurns: RunTurnRecord[],
  processingEnvelopes: RunEnvelopeRecord[],
  queuedEnvelopes: RunEnvelopeRecord[]
): string {
  const waitingTurn = activeTurns.find((turn) => turn.phase === "waiting");
  if (waitingTurn) {
    const waitRef =
      waitingTurn.waitKind && waitingTurn.waitKey
        ? `${waitingTurn.waitKind}:${waitingTurn.waitKey}`
        : waitingTurn.name;
    return `run is waiting on ${waitRef}`;
  }

  if (activeWaits.length > 0) {
    return `run has ${activeWaits.length} active wait${activeWaits.length === 1 ? "" : "s"}`;
  }

  if (activeSteps.length > 0 || activeExecs.length > 0 || activeTurns.length > 0) {
    return "run is actively executing";
  }

  if (activeChildren.length > 0) {
    return `run has ${activeChildren.length} active child run${activeChildren.length === 1 ? "" : "s"}`;
  }

  if (processingEnvelopes.length > 0 || queuedEnvelopes.length > 0) {
    return `service mailbox has ${processingEnvelopes.length} processing and ${queuedEnvelopes.length} queued envelope${queuedEnvelopes.length === 1 ? "" : "s"}`;
  }

  return `run is ${run.status}`;
}

function isActiveStatus(status: string): boolean {
  return !TERMINAL_STATUSES.has(status);
}

function describeRecord<T>(value: T | undefined, render: (value: T) => string): string | null {
  return value ? render(value) : null;
}

function describeWaitingTurn(turns: RunTurnRecord[]): string | null {
  const waitingTurn = turns.find((turn) => turn.phase === "waiting");
  return waitingTurn ? describeTurn(waitingTurn) : null;
}

function describeTurn(turn: RunTurnRecord): string {
  const waitRef =
    turn.waitKind && turn.waitKey ? ` waiting_on=${turn.waitKind}:${turn.waitKey}` : "";
  return `${turn.kind} ${turn.name} envelope=${turn.envelopeId} status=${turn.status} phase=${turn.phase}${waitRef}`;
}

function describeStep(step: RunStepRecord): string {
  return `${step.name} key=${step.key} status=${step.status}`;
}

function describeExec(exec: RunExecRecord): string {
  return `${exec.name} key=${exec.key} status=${exec.status} cmd=${[exec.cmd, ...exec.args].join(" ")}`;
}

function describeWait(wait: RunWaitRecord): string {
  const wakeAt = wait.wakeAt ? ` wake_at=${wait.wakeAt}` : "";
  return `${wait.kind} key=${wait.key} status=${wait.status}${wakeAt}`;
}

function describeChild(child: RunChildRecord): string {
  return `${child.definitionName} run=${child.childRunId} key=${child.key} status=${child.status}`;
}

function describeEnvelope(envelope: RunEnvelopeRecord): string {
  return `${envelope.kind} ${envelope.name} status=${envelope.status} envelope=${envelope.id}`;
}
