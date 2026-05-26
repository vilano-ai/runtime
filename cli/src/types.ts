export interface DefinitionRecord {
  kind: "workflow" | "service";
  name: string;
  exportName: string;
  file: string;
  runtimeKind: "javascript";
  sourceLanguage: "typescript" | "javascript";
  mailbox?: {
    maxQueued: number;
    overload?: "reject_new";
  };
  discovery?: {
    singletonRole: string;
  };
}

export type DefinitionKind = DefinitionRecord["kind"];

export type RunStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "idle"
  | "active"
  | "stopped";

export interface ProjectRecord {
  name: string;
  path: string;
  snapshotPath: string | null;
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
  runtimeVersion?: string;
  protocolVersion?: number;
  schemaVersion?: number;
}

export interface DaemonAuthState {
  version: 1;
  authToken: string;
  workerAuthToken: string;
}

export interface DaemonStatusResponse {
  ok: true;
  pid: number;
  port: number;
  startedAt: string;
  runtimeDbPath: string;
  runtimeVersion: string;
  protocolVersion: number;
  schemaVersion: number;
  appliedMigrations: Array<{ version: number; name: string; applied_at: string }>;
  homeDir: string;
  executionHomeDir: string;
  projectRoot: string;
  managedWorkerCount: number;
  managedWorkerRuntime: string;
  leaseDurationSeconds: number;
  projectCount: number;
}

export interface RuntimeBusyRetryProfileRecord {
  retries: number;
  exhausted: number;
  lastRetryAt: string | null;
  lastExhaustedAt: string | null;
  lastReason: string | null;
  lastDelayMs: number | null;
}

export interface RuntimeDebugResponse {
  ok: true;
  busyRetries: {
    profiles: Record<string, RuntimeBusyRetryProfileRecord>;
    recentExhausted: Array<{
      profile: string;
      reason: string;
      at: string;
    }>;
  };
  activeLeases: Array<{
    runId: string;
    project: string;
    definitionKind: DefinitionKind;
    definitionName: string;
    status: RunStatus;
    leaseId: string;
    leaseWorkerId: string | null;
    leaseExpiresAt: string;
    updatedAt: string;
  }>;
  managedWorkers: Array<{
    workerId: string;
    activeLeaseCount: number;
    leases: Array<{
      leaseId: string;
      runId: string;
      definitionName: string;
      status: RunStatus;
      leaseExpiresAt: string;
    }>;
  }>;
  activeTimedSteps: Array<{
    runId: string;
    key: string;
    name: string;
    attempt: number | null;
    timeoutMs: number | null;
    startedAt: string;
    leaseId: string;
    leaseWorkerId: string | null;
  }>;
  leaseQueue: {
    workflowHead: RunRecord | null;
    serviceTurnHead: {
      envelopeId: string;
      runId: string;
      project: string;
      definitionName: string;
      serviceKey: string;
      kind: "send" | "ask" | "signal";
      name: string;
      attempt: number | null;
      status: string;
      correlationId: string | null;
      senderRunId: string | null;
      wakeAt: string | null;
      createdAt: string;
      updatedAt: string;
      runStatus: RunStatus;
      leaseId: string | null;
      leaseWorkerId: string | null;
      leaseExpiresAt: string | null;
    } | null;
    oldestPendingRuns: RunRecord[];
    pendingByProject: Array<{
      project: string;
      count: number;
    }>;
  };
  runStatusCounts: Array<{
    status: RunStatus;
    count: number;
  }>;
  projectRunStatusCounts: Array<{
    project: string;
    status: RunStatus;
    count: number;
  }>;
}

export interface RuntimeStoragePathUsage {
  name: string;
  path: string;
  kind: "file" | "directory";
  exists: boolean;
  bytes: number;
  files: number;
  directories: number;
  error?: string;
}

export interface RuntimeStorageResponse {
  ok: true;
  roots: {
    homeDir: string;
    executionHomeDir: string;
    artifactHomeDir: string;
    runtimeDbPath: string;
  };
  paths: RuntimeStoragePathUsage[];
  database: {
    projects: number;
    runs: number;
    runEvents: { count: number; bytes: number };
    eventPayloadRefs: { count: number; bytes: number };
    serviceStates: { count: number; bytes: number };
    serviceEnvelopes: { count: number; bytes: number };
    runExecs: { count: number; bytes: number };
  };
}

export interface ProjectListResponse {
  ok: true;
  projects: ProjectRecord[];
}

export interface ProjectResponse {
  ok: true;
  project: ProjectRecord;
}

export interface ProjectPurgeRuntimeResponse {
  ok: true;
  project: string;
  purgedRunCount: number;
  purgedServiceRunCount: number;
  purgedEnvelopeCount: number;
  killedManagedWorkerIds: string[];
  purgedAt: string;
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
  projectSnapshotPath?: string | null;
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
  passivation?: {
    state: "passivated" | "pending" | "waiting" | "active" | "ready" | "stopped";
    reason?: string | null;
    wakeReason?: string | null;
    wakeOn?: string[] | null;
    queuedMessages?: number | null;
    nextWakeAt?: string | null;
  } | null;
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

export interface RunCancelResponse {
  ok: true;
  run: RunRecord;
  cancelledWaitCount: number;
  cancelledChildRunCount: number;
  cancelledServiceAskCount: number;
  hadActiveLease: boolean;
  stoppedEnvelopeCount: number;
  hadInFlightTurn: boolean;
}

export interface RunStepRecord {
  runId: string;
  key: string;
  name: string;
  status: string;
  attempt?: number | null;
  maxAttempts?: number | null;
  backoffMs?: number | null;
  timeoutMs: number | null;
  output: unknown | null;
  error: unknown | null;
  attempts?: number;
  lastEventType?: string | null;
  lastEventAt?: string | null;
  retryDecision?: string | null;
  retryFamily?: string | null;
  retryable?: boolean | null;
  willRetry?: boolean | null;
  nextAttempt?: number | null;
  retryWakeAt?: string | null;
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
  envKeys?: string[];
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
  retryDecision?: string | null;
  retryFamily?: string | null;
  retryable?: boolean | null;
  willRetry?: boolean | null;
  nextAttempt?: number | null;
  retryWakeAt?: string | null;
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
  attempt?: number | null;
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
  retryDecision?: string | null;
  retryFamily?: string | null;
  retryable?: boolean | null;
  willRetry?: boolean | null;
  nextAttempt?: number | null;
  retryWakeAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRetryAttemptRecord {
  attempt: number;
  failureEventType: string | null;
  failureAt: string | null;
  scheduledAt: string | null;
  retryDecision?: string | null;
  retryFamily?: string | null;
  retryable?: boolean | null;
  willRetry?: boolean | null;
  nextAttempt?: number | null;
  retryWakeAt?: string | null;
  backoffKind?: string | null;
  backoffMs?: number | null;
  backoffBaseMs?: number | null;
  backoffCappedMs?: number | null;
  backoffCapMs?: number | null;
  backoffJitterKind?: string | null;
  backoffJitterRatio?: number | null;
  backoffJitterMs?: number | null;
}

export interface RunRetrySeriesRecord {
  seriesKey: string;
  operationKind: string;
  operationKey: string;
  name: string;
  retryOn: string[];
  attempts: RunRetryAttemptRecord[];
  lastDecision?: string | null;
  lastFamily?: string | null;
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
  retrySeries?: RunRetrySeriesRecord[];
}

export interface RunReplayEntry {
  seq: number;
  createdAt: string;
  type: string;
  summary: string;
  body: unknown;
}

export interface RunReplayResponse extends RunInspectResponse {
  timeline: RunReplayEntry[];
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
  cancelledChildRunCount?: number;
  cancelledServiceAskCount?: number;
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
