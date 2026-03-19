import type { ErrorResponse } from "../types.ts";
import { KernelRequestError } from "./common.ts";
import type { KernelStatusBody, RequestOptions } from "./common.ts";

export async function requestJsonWithState<T>(
  status: { port: number; authToken: string },
  { method, pathname, body }: RequestOptions
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${status.port}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(status.authToken ? { "x-vilano-token": status.authToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const raw = await response.text();
  const parsed = raw ? (JSON.parse(raw) as T | ErrorResponse) : ({} as T);

  if (!response.ok) {
    const errorCode =
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      parsed.error &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      "code" in parsed.error &&
      typeof parsed.error.code === "string"
        ? parsed.error.code
        : undefined;

    const message =
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      parsed.error &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      "message" in parsed.error &&
      typeof parsed.error.message === "string"
        ? parsed.error.message
        : `Kernel request failed with status ${response.status}`;

    throw new KernelRequestError(message, response.status, errorCode);
  }

  return parsed as T;
}

export async function pingKernelStatus(
  port: number,
  authToken?: string
): Promise<KernelStatusBody | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: authToken ? { "x-vilano-token": authToken } : undefined,
    });
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as KernelStatusBody;
  } catch {
    return null;
  }
}
