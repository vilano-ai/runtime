import type { WorkerClient } from "./client.ts";
import { WorkerRequestError } from "./client.ts";
import type { RuntimeAdapter } from "./runtime-adapter.ts";
import type { StepContext } from "./runtime-sdk.ts";
import {
  ActivationCancelledError,
  isInactiveActivationError,
  StepControlError,
  throwAbortReason,
} from "./runtime-utils.ts";
import type { Activation } from "./turn-context-helpers.ts";

export function createStepController(
  adapter: RuntimeAdapter,
  client: WorkerClient,
  activation: Activation,
  step: {
    name: string;
    key: string;
    attempt: number;
    timeoutMs?: number;
  }
): {
  context: StepContext;
  checkCancelled(): void;
  dispose(): void;
} {
  const abortController = new AbortController();
  let leaseCheckInFlight = false;

  const abortWith = (reason: unknown) => {
    if (!abortController.signal.aborted) {
      abortController.abort(reason);
    }
  };

  const failForInactiveLease = () => {
    abortWith(
      new StepControlError(
        "activation_cancelled",
        `Step '${step.name}' stopped because activation ${activation.leaseId} is no longer active`
      )
    );
  };

  const timeoutTimer =
    step.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          abortWith(
            new StepControlError(
              "timeout",
              `Step '${step.name}' timed out after ${step.timeoutMs}ms`
            )
          );
        }, step.timeoutMs);

  const leasePoller = setInterval(() => {
    if (leaseCheckInFlight || abortController.signal.aborted) {
      return;
    }

    leaseCheckInFlight = true;
    void client
      .getLeaseStatus(activation.leaseId)
      .then((lease) => {
        if (!lease.active) {
          failForInactiveLease();
        }
      })
      .catch((error) => {
        if (error instanceof WorkerRequestError && (error.status === 401 || error.status === 404)) {
          failForInactiveLease();
        }
      })
      .finally(() => {
        leaseCheckInFlight = false;
      });
  }, 250);

  const checkCancelled = () => {
    if (!abortController.signal.aborted) {
      return;
    }

    throwAbortReason(abortController.signal.reason);
  };

  return {
    context: {
      attempt: step.attempt,
      signal: abortController.signal,
      checkCancelled,
      async yield() {
        checkCancelled();
        await adapter.sleep(0);
        checkCancelled();
      },
    },
    checkCancelled,
    dispose() {
      clearInterval(leasePoller);
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    },
  };
}
