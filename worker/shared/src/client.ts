import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

import type { components as ControlComponents } from "../../../protocol/v1/generated/control.ts";
import type { components as WorkerComponents } from "../../../protocol/v1/generated/worker.ts";

export type ActivationDefinition = WorkerComponents["schemas"]["DefinitionRef"];
export type WorkflowActivation = WorkerComponents["schemas"]["WorkflowActivation"];
export type ServiceTurnActivation = WorkerComponents["schemas"]["ServiceTurnActivation"];
type ActivationLeaseResponse = WorkerComponents["schemas"]["ActivationLeaseResponse"];
type KernelStatusResponse = ControlComponents["schemas"]["StatusResponse"];

type StepResolveResponse = WorkerComponents["schemas"]["StepResolveResponse"];

interface ResolvedRetryPolicy {
  maxAttempts?: number;
  backoffKind?: "fixed" | "linear" | "exponential";
  backoffMs?: number;
  backoffStepMs?: number;
  backoffFactor?: number;
  maxBackoffMs?: number;
  backoffJitterKind?: "full" | "half" | "ratio";
  backoffJitterRatio?: number;
  retryOn?: string[];
}

type ExecResolveResponse = WorkerComponents["schemas"]["ExecResolveResponse"];
type StepFailResponse = WorkerComponents["schemas"]["StepFailResponse"];
type ExecFailResponse = WorkerComponents["schemas"]["ExecFailResponse"];
type WaitResolveResponse = WorkerComponents["schemas"]["WaitResolveResponse"];

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

type ChildResultResponse = WorkerComponents["schemas"]["ChildResultResponse"];
type RunStatusResponse = WorkerComponents["schemas"]["RunStatusResponse"];
type LeaseStatusResponse = WorkerComponents["schemas"]["LeaseStatusResponse"];
type ServiceRunResponse = WorkerComponents["schemas"]["ServiceRunResponse"];
type ServiceCallResolveResponse = WorkerComponents["schemas"]["ServiceCallResolveResponse"];
type ServiceTurnFailResponse = WorkerComponents["schemas"]["ServiceTurnFailResponse"];

export class WorkerRequestError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "WorkerRequestError";
    this.status = options.status;
    this.code = options.code;
  }
}

export class WorkerClient {
  private compatibilityChecked = false;
  private readonly serverUrl: string;
  private readonly workerId: string;
  private readonly bootstrapAuthToken?: string;
  private readonly leaseAuthTokens = new Map<string, string>();

  constructor(
    serverUrl: string,
    workerId: string,
    authToken?: string
  ) {
    this.serverUrl = serverUrl;
    this.workerId = workerId;
    this.bootstrapAuthToken = authToken;
  }

  async getStatus(): Promise<KernelStatusResponse> {
    return await this.request<KernelStatusResponse>("GET", "/v1/status", undefined, this.bootstrapAuthToken);
  }

  async assertCompatible(expectedProtocolVersion: number): Promise<KernelStatusResponse> {
    if (this.compatibilityChecked) {
      return await this.getStatus();
    }

    const status = await this.getStatus();
    if (status.protocolVersion !== expectedProtocolVersion) {
      throw new Error(
        `Vilano worker protocol version ${expectedProtocolVersion} is incompatible with kernel runtime ${status.runtimeVersion} (protocol ${status.protocolVersion})`
      );
    }

    this.compatibilityChecked = true;
    return status;
  }

  async leaseActivation(): Promise<WorkflowActivation | ServiceTurnActivation | null> {
    const response = await this.request<ActivationLeaseResponse>("POST", "/v1/activations/lease", {
      workerId: this.workerId,
    }, this.bootstrapAuthToken);

    if (response.activation) {
      this.leaseAuthTokens.set(response.activation.leaseId, response.activation.leaseToken);
    }

    return response.activation;
  }

  async heartbeat(leaseId: string): Promise<void> {
    await this.request("POST", `/v1/leases/${encodeURIComponent(leaseId)}/heartbeat`, {
      workerId: this.workerId,
    }, this.requireLeaseAuthToken(leaseId));
  }

  async getLeaseStatus(
    leaseId: string
  ): Promise<LeaseStatusResponse["lease"]> {
    const response = await this.request<LeaseStatusResponse>(
      "GET",
      `/v1/leases/${encodeURIComponent(leaseId)}/status`,
      undefined,
      this.requireLeaseAuthToken(leaseId)
    );

    return response.lease;
  }

  async resolveStep(
    leaseId: string,
    name: string,
    key: string,
    timeoutMs?: number,
    retry?: ResolvedRetryPolicy
  ): Promise<StepResolveResponse["step"]> {
    const response = await this.request<StepResolveResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/steps/resolve`,
      {
        name,
        key,
        timeoutMs,
        maxAttempts: retry?.maxAttempts,
        backoffKind: retry?.backoffKind,
        backoffMs: retry?.backoffMs,
        backoffStepMs: retry?.backoffStepMs,
        backoffFactor: retry?.backoffFactor,
        maxBackoffMs: retry?.maxBackoffMs,
        backoffJitterKind: retry?.backoffJitterKind,
        backoffJitterRatio: retry?.backoffJitterRatio,
        retryOn: retry?.retryOn,
      },
      this.requireLeaseAuthToken(leaseId)
    );

    return response.step;
  }

  async completeStep(leaseId: string, name: string, key: string, output: unknown): Promise<void> {
    await this.request("POST", `/v1/leases/${encodeURIComponent(leaseId)}/steps/complete`, {
      name,
      key,
      output,
    }, this.requireLeaseAuthToken(leaseId));
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
      },
      this.requireLeaseAuthToken(leaseId)
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
      spec,
      this.requireLeaseAuthToken(leaseId)
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
    await this.request("POST", `/v1/leases/${encodeURIComponent(leaseId)}/execs/complete`, spec, this.requireLeaseAuthToken(leaseId));
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
      retry?: ResolvedRetryPolicy;
    }
  ): Promise<ExecFailResponse["exec"]> {
    const response = await this.request<ExecFailResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/execs/fail`,
      {
        name: spec.name,
        key: spec.key,
        exitCode: spec.exitCode,
        signalCode: spec.signalCode,
        stdoutRef: spec.stdoutRef,
        stderrRef: spec.stderrRef,
        artifacts: spec.artifacts,
        error: spec.error,
        maxAttempts: spec.retry?.maxAttempts,
        backoffKind: spec.retry?.backoffKind,
        backoffMs: spec.retry?.backoffMs,
        backoffStepMs: spec.retry?.backoffStepMs,
        backoffFactor: spec.retry?.backoffFactor,
        maxBackoffMs: spec.retry?.maxBackoffMs,
        backoffJitterKind: spec.retry?.backoffJitterKind,
        backoffJitterRatio: spec.retry?.backoffJitterRatio,
        retryOn: spec.retry?.retryOn,
      },
      this.requireLeaseAuthToken(leaseId)
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
      spec,
      this.requireLeaseAuthToken(leaseId)
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
      spec,
      this.requireLeaseAuthToken(leaseId)
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
      spec,
      this.requireLeaseAuthToken(leaseId)
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
      spec,
      this.requireLeaseAuthToken(leaseId)
    );

    return response.child;
  }

  async getRelatedRunStatus(leaseId: string, runId: string): Promise<string> {
    const response = await this.request<RunStatusResponse>(
      "GET",
      `/v1/leases/${encodeURIComponent(leaseId)}/runs/${encodeURIComponent(runId)}/status`,
      undefined,
      this.requireLeaseAuthToken(leaseId)
    );
    return response.run.status;
  }

  async sendChildRunSignal(leaseId: string, runId: string, name: string, payload: unknown): Promise<void> {
    await this.request(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/runs/${encodeURIComponent(runId)}/signals`,
      {
        name,
        payload,
      },
      this.requireLeaseAuthToken(leaseId)
    );
  }

  async ensureService(
    project: string | null,
    service: string,
    serviceKey: string,
    keyInput: unknown,
    leaseId?: string,
    mustExist = false
  ): Promise<string> {
    const response = await this.request<ServiceRunResponse>("POST", "/v1/services/ensure", {
      project,
      service,
      serviceKey,
      keyInput,
      leaseId,
      mustExist,
    }, leaseId ? this.requireLeaseAuthToken(leaseId) : this.bootstrapAuthToken);

    return response.run.id;
  }

  async resolveServiceSend(
    leaseId: string,
    spec: { serviceRunId: string; name: string; key: string; payload: unknown }
  ): Promise<ServiceCallResolveResponse["result"]> {
    const response = await this.request<ServiceCallResolveResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/services/send`,
      spec,
      this.requireLeaseAuthToken(leaseId)
    );

    return response.result;
  }

  async resolveServiceAsk(
    leaseId: string,
    spec: { serviceRunId: string; name: string; key: string; payload: unknown; timeoutMs?: number }
  ): Promise<ServiceCallResolveResponse["result"]> {
    const response = await this.request<ServiceCallResolveResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/services/ask`,
      spec,
      this.requireLeaseAuthToken(leaseId)
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
      spec,
      this.requireLeaseAuthToken(leaseId)
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
      body,
      this.requireLeaseAuthToken(leaseId)
    );
  }

  async failServiceTurn(
    leaseId: string,
    envelopeId: string,
    error: Record<string, unknown>,
    retry?: ResolvedRetryPolicy
  ): Promise<ServiceTurnFailResponse> {
    return await this.request<ServiceTurnFailResponse>(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/service-turns/${encodeURIComponent(envelopeId)}/fail`,
      {
        error,
        maxAttempts: retry?.maxAttempts,
        backoffKind: retry?.backoffKind,
        backoffMs: retry?.backoffMs,
        backoffStepMs: retry?.backoffStepMs,
        backoffFactor: retry?.backoffFactor,
        maxBackoffMs: retry?.maxBackoffMs,
        backoffJitterKind: retry?.backoffJitterKind,
        backoffJitterRatio: retry?.backoffJitterRatio,
        retryOn: retry?.retryOn,
      },
      this.requireLeaseAuthToken(leaseId)
    );
  }

  async completeRun(leaseId: string, result: unknown): Promise<void> {
    await this.request("POST", `/v1/leases/${encodeURIComponent(leaseId)}/complete`, {
      result,
    }, this.requireLeaseAuthToken(leaseId));
  }

  async failRun(leaseId: string, error: Record<string, unknown>): Promise<void> {
    await this.request("POST", `/v1/leases/${encodeURIComponent(leaseId)}/fail`, {
      error,
    }, this.requireLeaseAuthToken(leaseId));
  }

  clearLeaseAuthToken(leaseId: string): void {
    this.leaseAuthTokens.delete(leaseId);
  }

  private requireLeaseAuthToken(leaseId: string): string {
    const token = this.leaseAuthTokens.get(leaseId);
    if (!token) {
      throw new Error(`Missing Vilano lease auth token for activation ${leaseId}`);
    }

    return token;
  }

  private async request<T>(method: string, pathname: string, body?: unknown, authToken?: string): Promise<T> {
    const url = new URL(pathname, this.serverUrl);
    const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const transport = url.protocol === "https:" ? https.request : http.request;
      const request = transport(
        url,
        {
          method,
          headers: {
            accept: "application/json",
            ...(payload
              ? { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) }
              : {}),
            ...(authToken ? { "x-vilano-token": authToken } : {}),
          },
        },
        (response) => {
          response.setEncoding("utf8");
          let responseBody = "";
          response.on("data", (chunk) => {
            responseBody += chunk;
          });
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 500,
              body: responseBody,
            });
          });
        }
      );

      request.on("error", reject);

      if (payload) {
        request.write(payload);
      }

      request.end();
    });

    const parsed = raw.body ? JSON.parse(raw.body) : {};

    if (raw.status < 200 || raw.status >= 300) {
      const message =
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        parsed.error &&
        typeof parsed.error.message === "string"
          ? parsed.error.message
          : raw.body
            ? `Worker request failed with status ${raw.status}: ${raw.body}`
            : `Worker request failed with status ${raw.status}`;

      const code =
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        parsed.error &&
        typeof parsed.error.code === "string"
          ? parsed.error.code
          : undefined;

      throw new WorkerRequestError(message, {
        status: raw.status,
        code,
      });
    }

    return parsed as T;
  }
}
