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
