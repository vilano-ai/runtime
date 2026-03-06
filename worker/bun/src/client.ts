export interface ActivationDefinition {
  kind: "workflow" | "service";
  name: string;
  exportName: string;
  file: string;
}

export interface WorkflowActivation {
  kind: "workflow";
  leaseId: string;
  leaseExpiresAt: string;
  run: {
    id: string;
    input: unknown;
  };
  project: {
    name: string;
    path: string;
  };
  definition: ActivationDefinition;
}

export interface ServiceTurnActivation {
  kind: "service_turn";
  leaseId: string;
  leaseExpiresAt: string;
  run: {
    id: string;
  };
  project: {
    name: string;
    path: string;
  };
  definition: ActivationDefinition;
  service: {
    key: string;
    keyInput: unknown;
    state: unknown;
  };
  envelope: {
    id: string;
    kind: "send" | "ask" | "signal";
    name: string;
    payload: unknown;
    correlationId: string | null;
    senderRunId: string | null;
  };
}

interface ActivationLeaseResponse {
  ok: true;
  activation: WorkflowActivation | ServiceTurnActivation | null;
}

interface StepResolveResponse {
  ok: true;
  step:
    | { status: "pending" }
    | { status: "completed"; output: unknown }
    | { status: "failed"; error: unknown };
}

interface ExecResolveResponse {
  ok: true;
  exec:
    | { status: "execute"; attempt: number }
    | { status: "completed"; output: unknown }
    | { status: "failed"; error: unknown };
}

interface StepFailResponse {
  ok: true;
  step:
    | { status: "failed"; error: unknown }
    | { status: "retry_waiting"; wait: { key: string; kind: string; name: string } };
}

interface ExecFailResponse {
  ok: true;
  exec:
    | { status: "failed"; error: unknown }
    | { status: "retry_waiting"; wait: { key: string; kind: string; name: string } };
}

interface WaitResolveResponse {
  ok: true;
  wait:
    | { status: "completed"; output?: unknown }
    | { status: "suspended"; wait: { key: string; kind: string; name: string } };
}

interface SpawnResolveResponse {
  ok: true;
  spawn: {
    status: "created" | "existing";
    childRun: {
      id: string;
      status: string;
      output: unknown | null;
      error: unknown | null;
    };
  };
}

interface ChildResultResponse {
  ok: true;
  child:
    | { status: "completed"; output: unknown }
    | { status: "failed"; error: unknown }
    | { status: "suspended"; wait: { key: string; kind: string; name: string } };
}

interface RunStatusResponse {
  ok: true;
  run: {
    status: string;
  };
}

interface LeaseStatusResponse {
  ok: true;
  lease:
    | { active: false }
    | {
        active: true;
        runId: string;
        status: string;
        definitionKind: string;
        leaseExpiresAt: string | null;
      };
}

interface ServiceRunResponse {
  ok: true;
  run: {
    id: string;
    status: string;
  };
}

interface ServiceCallResolveResponse {
  ok: true;
  result:
    | { status: "completed"; output?: unknown }
    | { status: "failed"; error: unknown }
    | { status: "suspended"; wait: { key: string; kind: string; name: string } };
}

interface ServiceTurnFailResponse {
  ok: true;
  run: unknown;
  status?: "retry_waiting";
  wait?: { key: string; kind: string; name: string };
}

export class WorkerClient {
  constructor(
    private readonly serverUrl: string,
    private readonly workerId: string
  ) {}

  async leaseActivation(): Promise<WorkflowActivation | ServiceTurnActivation | null> {
    const response = await this.request<ActivationLeaseResponse>("POST", "/v1/activations/lease", {
      workerId: this.workerId,
    });

    return response.activation;
  }

  async heartbeat(leaseId: string): Promise<void> {
    await this.request("POST", `/v1/leases/${encodeURIComponent(leaseId)}/heartbeat`, {
      workerId: this.workerId,
    });
  }

  async getLeaseStatus(
    leaseId: string
  ): Promise<LeaseStatusResponse["lease"]> {
    const response = await this.request<LeaseStatusResponse>(
      "GET",
      `/v1/leases/${encodeURIComponent(leaseId)}/status`
    );

    return response.lease;
  }

  async resolveStep(
    leaseId: string,
    name: string,
    key: string,
    timeoutMs?: number,
    maxAttempts?: number,
    backoffMs?: number
  ): Promise<StepResolveResponse["step"]> {
    const response = await this.request<StepResolveResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/steps/resolve`,
      { name, key, timeoutMs, maxAttempts, backoffMs }
    );

    return response.step;
  }

  async completeStep(leaseId: string, name: string, key: string, output: unknown): Promise<void> {
    await this.request("POST", `/v1/leases/${encodeURIComponent(leaseId)}/steps/complete`, {
      name,
      key,
      output,
    });
  }

  async failStep(
    leaseId: string,
    name: string,
    key: string,
    error: unknown
  ): Promise<StepFailResponse["step"]> {
    const response = await this.request<StepFailResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/steps/fail`,
      {
        name,
        key,
        error,
      }
    );

    return response.step;
  }

  async resolveExec(
    leaseId: string,
    spec: {
      name: string;
      key: string;
      cmd: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    }
  ): Promise<ExecResolveResponse["exec"]> {
    const response = await this.request<ExecResolveResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/execs/resolve`,
      spec
    );

    return response.exec;
  }

  async completeExec(
    leaseId: string,
    spec: {
      name: string;
      key: string;
      exitCode: number;
      signalCode: string | null;
      stdoutRef?: string;
      stderrRef?: string;
      artifacts: Array<{ path: string; ref: string }>;
      output: unknown;
    }
  ): Promise<void> {
    await this.request("POST", `/v1/leases/${encodeURIComponent(leaseId)}/execs/complete`, spec);
  }

  async failExec(
    leaseId: string,
    spec: {
      name: string;
      key: string;
      exitCode: number | null;
      signalCode: string | null;
      stdoutRef?: string;
      stderrRef?: string;
      artifacts: Array<{ path: string; ref: string }>;
      error: unknown;
      maxAttempts?: number;
      backoffMs?: number;
    }
  ): Promise<ExecFailResponse["exec"]> {
    const response = await this.request<ExecFailResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/execs/fail`,
      spec
    );

    return response.exec;
  }

  async resolveSleepWait(
    leaseId: string,
    spec: { key: string; durationMs: number }
  ): Promise<WaitResolveResponse["wait"]> {
    const response = await this.request<WaitResolveResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/waits/sleep`,
      spec
    );

    return response.wait;
  }

  async resolveSignalWait(
    leaseId: string,
    spec: { name: string; key: string }
  ): Promise<WaitResolveResponse["wait"]> {
    const response = await this.request<WaitResolveResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/waits/signal`,
      spec
    );

    return response.wait;
  }

  async resolveSpawn(
    leaseId: string,
    spec: { name: string; key: string; childRunId: string; input: unknown }
  ): Promise<SpawnResolveResponse["spawn"]> {
    const response = await this.request<SpawnResolveResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/spawns/resolve`,
      spec
    );

    return response.spawn;
  }

  async resolveChildResult(
    leaseId: string,
    spec: { childRunId: string; key: string }
  ): Promise<ChildResultResponse["child"]> {
    const response = await this.request<ChildResultResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/children/result`,
      spec
    );

    return response.child;
  }

  async getRunStatus(runId: string): Promise<string> {
    const response = await this.request<RunStatusResponse>("GET", `/v1/runs/${encodeURIComponent(runId)}`);
    return response.run.status;
  }

  async sendRunSignal(runId: string, name: string, payload: unknown): Promise<void> {
    await this.request("POST", `/v1/runs/${encodeURIComponent(runId)}/signals`, {
      name,
      payload,
    });
  }

  async ensureService(
    project: string,
    service: string,
    serviceKey: string,
    keyInput: unknown
  ): Promise<string> {
    const response = await this.request<ServiceRunResponse>("POST", "/v1/services/ensure", {
      project,
      service,
      serviceKey,
      keyInput,
    });

    return response.run.id;
  }

  async resolveServiceSend(
    leaseId: string,
    spec: { serviceRunId: string; name: string; key: string; payload: unknown }
  ): Promise<ServiceCallResolveResponse["result"]> {
    const response = await this.request<ServiceCallResolveResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/services/send`,
      spec
    );

    return response.result;
  }

  async resolveServiceAsk(
    leaseId: string,
    spec: { serviceRunId: string; name: string; key: string; payload: unknown }
  ): Promise<ServiceCallResolveResponse["result"]> {
    const response = await this.request<ServiceCallResolveResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/services/ask`,
      spec
    );

    return response.result;
  }

  async resolveServiceSignal(
    leaseId: string,
    spec: { serviceRunId: string; name: string; key: string; payload: unknown }
  ): Promise<ServiceCallResolveResponse["result"]> {
    const response = await this.request<ServiceCallResolveResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/services/signal`,
      spec
    );

    return response.result;
  }

  async completeServiceTurn(
    leaseId: string,
    envelopeId: string,
    body: { state: unknown; reply?: unknown; stop?: boolean }
  ): Promise<void> {
    await this.request(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/service-turns/${encodeURIComponent(envelopeId)}/complete`,
      body
    );
  }

  async failServiceTurn(
    leaseId: string,
    envelopeId: string,
    error: { message: string; stack?: string },
    retry?: { maxAttempts?: number; backoffMs?: number }
  ): Promise<ServiceTurnFailResponse> {
    return await this.request<ServiceTurnFailResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/service-turns/${encodeURIComponent(envelopeId)}/fail`,
      {
        error,
        maxAttempts: retry?.maxAttempts,
        backoffMs: retry?.backoffMs,
      }
    );
  }

  async completeRun(leaseId: string, result: unknown): Promise<void> {
    await this.request("POST", `/v1/leases/${encodeURIComponent(leaseId)}/complete`, {
      result,
    });
  }

  async failRun(leaseId: string, error: { message: string; stack?: string }): Promise<void> {
    await this.request("POST", `/v1/leases/${encodeURIComponent(leaseId)}/fail`, {
      error,
    });
  }

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.serverUrl}${pathname}`, {
      method,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const raw = await response.text();
    const parsed = raw ? JSON.parse(raw) : {};

    if (!response.ok) {
      const message =
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        parsed.error &&
        typeof parsed.error.message === "string"
          ? parsed.error.message
          : `Worker request failed with status ${response.status}`;

      throw new Error(message);
    }

    return parsed as T;
  }
}
