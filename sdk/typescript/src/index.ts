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

export interface SpawnOptions {
  key?: string;
}

export interface ConnectOptions {
  mustExist?: boolean;
}

export type RetryFamily =
  | "always"
  | "application"
  | "timeout"
  | "process_exit"
  | "process_spawn";

export type RetryJitter =
  | "full"
  | "half"
  | {
      kind: "ratio";
      ratio: number;
    };

export type RetryBackoff =
  | string
  | {
      kind: "fixed";
      delay: string;
      jitter?: RetryJitter;
    }
  | {
      kind: "linear";
      initial: string;
      step?: string;
      max?: string;
      jitter?: RetryJitter;
    }
  | {
      kind: "exponential";
      initial: string;
      factor?: number;
      max?: string;
      jitter?: RetryJitter;
    };

export interface StepOptions {
  key?: string;
  timeout?: string;
  retries?: number;
  backoff?: RetryBackoff;
  retry?: RetryOptions;
}

export interface RetryOptions {
  retries?: number;
  backoff?: RetryBackoff;
  on?: RetryFamily[];
}

export interface StepContext {
  readonly attempt: number;
  readonly signal: AbortSignal;
  checkCancelled(): void;
  yield(): Promise<void>;
}

export interface ExecOptions {
  key?: string;
  timeout?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface AskOptions {
  key?: string;
  timeout?: string;
}

export interface MessageOptions {
  key?: string;
}

export interface SignalOptions {
  key?: string;
}

export interface MonitorOptions {
  key?: string;
}

export interface LinkOptions {
  key?: string;
  propagate?: "abnormal" | "all";
}

export type ExitStatus = "completed" | "failed" | "cancelled" | "stopped";

export interface ExitEvent {
  targetId: string;
  targetKind: "workflow" | "service";
  relationship: "monitor" | "link";
  status: ExitStatus;
  at: string;
  output?: unknown;
  error?: unknown;
}

export interface RelationshipRef {
  readonly id: string;
  readonly targetId: string;
  readonly kind: "monitor" | "link";
}

export interface WorkflowHandle<TOutput> {
  readonly id: string;
  result(): Promise<TOutput>;
  status(): Promise<RunStatus>;
  signal(name: string, payload?: unknown, options?: SignalOptions): Promise<void>;
  monitor(options?: MonitorOptions): Promise<RelationshipRef>;
  link(options?: LinkOptions): Promise<RelationshipRef>;
}

export type SendResult<TState> = void | { state?: TState; stop?: true };
export type AskResult<TState, TReply> = { reply: TReply; state?: TState; stop?: true };
export type SignalResult<TState> = void | { state?: TState; stop?: true };

export interface ServiceTurnContext {
  readonly runId: string;
  readonly turnAttempt: number;
  step<TOutput>(
    name: string,
    fn: (step: StepContext) => Promise<TOutput> | TOutput,
    options?: StepOptions
  ): Promise<TOutput>;
  exec<TOutput = ExecResult>(spec: ExecSpec<TOutput>): Promise<TOutput>;
  sleep(duration: string, options?: { key?: string }): Promise<void>;
  waitForSignal(name: string, options?: { key?: string }): Promise<unknown>;
  trapExit(enabled?: boolean): Promise<void>;
  nextExit(options?: { key?: string }): Promise<ExitEvent>;
  log(message: string, fields?: Record<string, unknown>): Promise<void>;
  spawn<TInput, TOutput>(
    definition: WorkflowDefinition<TInput, TOutput>,
    input: TInput,
    options?: SpawnOptions
  ): WorkflowHandle<TOutput>;
  connect<
    TKeyInput,
    TState,
    TSend extends SendHandlerMap<TState>,
    TAsk extends AskHandlerMap<TState>,
    TSignal extends SignalHandlerMap<TState>
  >(
    definition: ServiceDefinition<TKeyInput, TState, TSend, TAsk, TSignal>,
    input: TKeyInput,
    options?: ConnectOptions
  ): Promise<ServiceRef<TSend, TAsk, TSignal>>;
}

export interface WorkflowContext extends ServiceTurnContext {}

export interface ExecSpec<TOutput = unknown> {
  name: string;
  key?: string;
  retries?: number;
  backoff?: RetryBackoff;
  retry?: RetryOptions;
  cmd: string;
  args?: string[];
  timeout?: string;
  cwd?: string;
  env?: Record<string, string>;
  capture?: {
    stdout?: boolean;
    stderr?: boolean;
    artifacts?: string[];
  };
  parse?: (stdout: string) => TOutput;
}

export interface ExecArtifact {
  path: string;
  ref: string;
}

export interface ExecResult {
  exitCode: number;
  signalCode: string | null;
  stdout: string;
  stderr: string;
  stdoutRef?: string;
  stderrRef?: string;
  artifacts: ExecArtifact[];
}

export type SendHandler<TPayload, TState> = (
  payload: TPayload,
  state: Readonly<TState>,
  ctx: ServiceTurnContext
) => Promise<SendResult<TState>> | SendResult<TState>;

export type AskHandler<TPayload, TState, TReply> = (
  payload: TPayload,
  state: Readonly<TState>,
  ctx: ServiceTurnContext
) => Promise<AskResult<TState, TReply>> | AskResult<TState, TReply>;

export type SignalHandler<TPayload, TState> = (
  payload: TPayload,
  state: Readonly<TState>,
  ctx: ServiceTurnContext
) => Promise<SignalResult<TState>> | SignalResult<TState>;

export type SendHandlerMap<TState> = Record<string, SendHandler<any, TState>>;
export type AskHandlerMap<TState> = Record<string, AskHandler<any, TState, any>>;
export type SignalHandlerMap<TState> = Record<string, SignalHandler<any, TState>>;

export interface WorkflowDefinition<TInput, TOutput> {
  readonly kind: "workflow";
  readonly name: string;
  readonly run: (input: TInput, ctx: WorkflowContext) => Promise<TOutput>;
}

export interface ServiceDefinition<
  TKeyInput,
  TState,
  TSend extends SendHandlerMap<TState>,
  TAsk extends AskHandlerMap<TState>,
  TSignal extends SignalHandlerMap<TState>
> {
  readonly kind: "service";
  readonly name: string;
  readonly retry?: RetryOptions;
  readonly key: (input: TKeyInput) => string;
  readonly init?: (input: TKeyInput, ctx: ServiceTurnContext) => Promise<TState> | TState;
  readonly onSend?: TSend;
  readonly onAsk?: TAsk;
  readonly onSignal?: TSignal;
}

type FirstArg<THandler extends (...args: any[]) => any> = THandler extends (
  arg1: infer TArg,
  ...rest: any[]
) => any
  ? TArg
  : void;
type AskReplyOf<THandler extends (...args: any[]) => any> =
  Awaited<ReturnType<THandler>> extends { reply: infer TReply } ? TReply : never;

type SendMethodArgs<TPayload> = [TPayload] extends [void]
  ? [] | [payload: undefined, options?: MessageOptions]
  : [payload: TPayload, options?: MessageOptions];

type AskMethodArgs<TPayload> = [TPayload] extends [void]
  ? [] | [payload: undefined, options?: AskOptions]
  : [payload: TPayload, options?: AskOptions];

type SignalMethodArgs<TPayload> = [TPayload] extends [void]
  ? [] | [payload: undefined, options?: SignalOptions]
  : [payload: TPayload, options?: SignalOptions];

export interface ServiceRef<
  TSend extends SendHandlerMap<any>,
  TAsk extends AskHandlerMap<any>,
  TSignal extends SignalHandlerMap<any>
> {
  readonly id: string;
  send: {
    [K in keyof TSend]: (...args: SendMethodArgs<FirstArg<TSend[K]>>) => Promise<void>;
  };
  ask: {
    [K in keyof TAsk]: (
      ...args: AskMethodArgs<FirstArg<TAsk[K]>>
    ) => Promise<AskReplyOf<TAsk[K]>>;
  };
  signal: {
    [K in keyof TSignal]: (...args: SignalMethodArgs<FirstArg<TSignal[K]>>) => Promise<void>;
  };
  status(): Promise<RunStatus>;
  monitor(options?: MonitorOptions): Promise<RelationshipRef>;
  link(options?: LinkOptions): Promise<RelationshipRef>;
}

export class NonRetryableError extends Error {
  readonly retryable = false as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "NonRetryableError";

    if (options && "cause" in options) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
  }
}

export function nonRetryable(error: string | Error): Error & { retryable: false } {
  if (typeof error === "string") {
    return new NonRetryableError(error);
  }

  Object.defineProperty(error, "retryable", {
    value: false,
    configurable: true,
    enumerable: false,
    writable: true,
  });

  if (error.name === "Error") {
    error.name = "NonRetryableError";
  }

  return error as Error & { retryable: false };
}

export function workflow<TInput, TOutput>(
  definition: Omit<WorkflowDefinition<TInput, TOutput>, "kind">
): WorkflowDefinition<TInput, TOutput> {
  return {
    kind: "workflow",
    ...definition,
  };
}

export function service<
  TKeyInput,
  TState,
  TSend extends SendHandlerMap<TState> = {},
  TAsk extends AskHandlerMap<TState> = {},
  TSignal extends SignalHandlerMap<TState> = {}
>(
  definition: Omit<
    ServiceDefinition<TKeyInput, TState, TSend, TAsk, TSignal>,
    "kind"
  >
): ServiceDefinition<TKeyInput, TState, TSend, TAsk, TSignal> {
  return {
    kind: "service",
    ...definition,
  };
}
