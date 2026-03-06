export interface DefinitionRecord {
  kind: "workflow" | "service";
  name: string;
  exportName: string;
  file: string;
}

export type DefinitionKind = DefinitionRecord["kind"];

export type RunStatus =
  | "pending"
  | "running"
  | "waiting"
  | "sleeping"
  | "completed"
  | "failed"
  | "cancelled"
  | "idle"
  | "active"
  | "stopped";

export interface ProjectRecord {
  name: string;
  path: string;
  lastSyncedAt: string | null;
  definitionsManifestHash: string | null;
  definitions: {
    workflows: DefinitionRecord[];
    services: DefinitionRecord[];
  };
}

export interface DaemonState {
  version: 1;
  pid: number;
  port: number;
  startedAt: string;
  runtimeDbPath: string;
}

export interface DaemonStatusResponse {
  ok: true;
  pid: number;
  port: number;
  startedAt: string;
  runtimeDbPath: string;
  projectCount: number;
}

export interface ProjectListResponse {
  ok: true;
  projects: ProjectRecord[];
}

export interface ProjectResponse {
  ok: true;
  project: ProjectRecord;
}

export interface DefinitionListResponse {
  ok: true;
  project: string | null;
  definitions: DefinitionRecord[];
}

export interface DefinitionInspectResponse {
  ok: true;
  project: string;
  definition: DefinitionRecord;
}

export interface RunRecord {
  id: string;
  project: string;
  definitionKind: DefinitionKind;
  definitionName: string;
  status: RunStatus;
  leaseId?: string | null;
  leaseWorkerId?: string | null;
  leaseExpiresAt?: string | null;
  input: unknown;
  serviceKey?: string;
  keyInput?: unknown;
  state?: unknown | null;
  output: unknown | null;
  error: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunEventRecord {
  id: string;
  runId: string;
  seq: number;
  type: string;
  body: unknown;
  createdAt: string;
}

export interface RunStartResponse {
  ok: true;
  run: RunRecord;
}

export interface RunStepRecord {
  runId: string;
  key: string;
  name: string;
  status: string;
  output: unknown | null;
  attempts?: number;
  lastEventType?: string | null;
  lastEventAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunExecRecord {
  runId: string;
  key: string;
  name: string;
  status: string;
  cmd: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string> | null;
  timeoutMs: number | null;
  attempt: number;
  exitCode: number | null;
  signalCode: string | null;
  stdoutRef: string | null;
  stderrRef: string | null;
  artifacts: Array<{ path: string; ref: string }>;
  output: unknown | null;
  error: unknown | null;
  attempts?: number;
  lastEventType?: string | null;
  lastEventAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunWaitRecord {
  runId: string;
  key: string;
  kind: string;
  name: string;
  status: string;
  wakeAt: string | null;
  output: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunSignalRecord {
  id: string;
  runId: string;
  name: string;
  payload: unknown | null;
  consumedAt: string | null;
  createdAt: string;
}

export interface RunChildRecord {
  parentRunId: string;
  key: string;
  childRunId: string;
  definitionName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunEnvelopeRecord {
  id: string;
  serviceRunId: string;
  kind: "send" | "ask" | "signal";
  name: string;
  payload: unknown | null;
  correlationId: string | null;
  senderRunId: string | null;
  status: string;
  reply: unknown | null;
  error: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunTurnRecord {
  envelopeId: string;
  kind: "send" | "ask" | "signal";
  name: string;
  status: string;
  phase: string;
  attempts: number;
  correlationId: string | null;
  senderRunId: string | null;
  waitKind: string | null;
  waitKey: string | null;
  waitName: string | null;
  lastResumeReason: string | null;
  lastEventType: string | null;
  lastEventAt: string | null;
  reply: unknown | null;
  error: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunListResponse {
  ok: true;
  project: string | null;
  runs: RunRecord[];
}

export interface RunInspectResponse {
  ok: true;
  run: RunRecord;
  events: RunEventRecord[];
  steps: RunStepRecord[];
  execs: RunExecRecord[];
  waits: RunWaitRecord[];
  signals: RunSignalRecord[];
  children: RunChildRecord[];
  envelopes: RunEnvelopeRecord[];
  turns?: RunTurnRecord[];
}

export interface ServiceEnsureResponse {
  ok: true;
  run: RunRecord;
}

export interface ServiceEnvelopeResponse {
  ok: true;
  envelope: RunEnvelopeRecord;
}

export interface ServiceMutationResponse {
  ok: true;
  run: RunRecord;
  envelope: RunEnvelopeRecord;
}

export interface ServiceStopResponse {
  ok: true;
  run: RunRecord;
  stoppedEnvelopeCount: number;
  cancelledWaitCount: number;
  hadInFlightTurn: boolean;
}

export interface ServiceRunListResponse {
  ok: true;
  project: string | null;
  activeOnly: boolean;
  runs: RunRecord[];
}

export interface SignalSendResponse {
  ok: true;
  signal: RunSignalRecord;
}

export interface ErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}
