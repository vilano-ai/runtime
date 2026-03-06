export interface ActivationDefinition {
  kind: "workflow";
  name: string;
  exportName: string;
  file: string;
}

export interface WorkflowActivation {
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

interface ActivationLeaseResponse {
  ok: true;
  activation: WorkflowActivation | null;
}

interface StepResolveResponse {
  ok: true;
  step: { status: "pending" } | { status: "completed"; output: unknown };
}

interface ExecResolveResponse {
  ok: true;
  exec:
    | { status: "execute"; attempt: number }
    | { status: "completed"; output: unknown }
    | { status: "failed"; error: unknown };
}

interface WaitResolveResponse {
  ok: true;
  wait:
    | { status: "completed"; output?: unknown }
    | { status: "suspended"; wait: { key: string; kind: string; name: string } };
}

export class WorkerClient {
  constructor(
    private readonly serverUrl: string,
    private readonly workerId: string
  ) {}

  async leaseActivation(): Promise<WorkflowActivation | null> {
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

  async resolveStep(leaseId: string, name: string, key: string): Promise<StepResolveResponse["step"]> {
    const response = await this.request<StepResolveResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/steps/resolve`,
      { name, key }
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
    }
  ): Promise<void> {
    await this.request("POST", `/v1/leases/${encodeURIComponent(leaseId)}/execs/fail`, spec);
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
