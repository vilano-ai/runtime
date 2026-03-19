import { cancelRun, inspectRun, listRuns, replayRun, startWorkflowRun } from "../daemon-client.ts";
import { CliError } from "../cli-error.ts";
import type { CommandFlags } from "../args.ts";
import { parseJsonFlag, resolveRunProjectScope, resolveWorkflowReference } from "../command-support.ts";
import { writeOutput } from "../output.ts";
import {
  buildRunExplain,
  decorateRunInspect,
  renderRun,
  renderRunExplain,
  renderRunInspect,
  renderRunList,
  renderRunReplay,
} from "../run-views.ts";

export async function handleRun(
  args: string[],
  flags: CommandFlags
): Promise<number> {
  const command = args[0];

  switch (command) {
    case "start": {
      const reference = args[1];
      if (!reference) {
        throw new CliError("Usage: vilano run start <workflow-ref> [--input '{...}']");
      }

      const { project, definition } = await resolveWorkflowReference(reference, flags, {
        autoStart: true,
      });
      const input = parseJsonFlag(flags.input, "input", {});
      const response = await startWorkflowRun(project.name, definition.name, input);
      writeOutput(flags, response, (body) => renderRun(body.run));
      return 0;
    }
    case "list": {
      const response = await listRuns(await resolveRunProjectScope(flags));
      writeOutput(flags, response, (body) => renderRunList(body.project, body.runs));
      return 0;
    }
    case "inspect": {
      const runId = args[1];
      if (!runId) {
        throw new CliError("Usage: vilano run inspect <run-id>");
      }

      const response = decorateRunInspect(await inspectRun(runId));
      writeOutput(flags, response, (body) =>
        renderRunInspect(
          body.run,
          body.events,
          body.steps,
          body.execs,
          body.waits,
          body.signals,
          body.children,
          body.envelopes,
          body.turns,
          body.retrySeries ?? []
        )
      );
      return 0;
    }
    case "explain": {
      const runId = args[1];
      if (!runId) {
        throw new CliError("Usage: vilano run explain <run-id>");
      }

      const response = decorateRunInspect(await inspectRun(runId));
      const body = {
        ok: true as const,
        run: response.run,
        explain: buildRunExplain(
          response.run,
          response.steps,
          response.execs,
          response.waits,
          response.children,
          response.envelopes,
          response.turns
        ),
      };
      writeOutput(flags, body, () =>
        renderRunExplain(
          response.run,
          response.steps,
          response.execs,
          response.waits,
          response.children,
          response.envelopes,
          response.turns
        )
      );
      return 0;
    }
    case "replay": {
      const runId = args[1];
      if (!runId) {
        throw new CliError("Usage: vilano run replay <run-id>");
      }

      const response = decorateRunInspect(await replayRun(runId));
      writeOutput(flags, response, (body) =>
        renderRunReplay(body.run, body.timeline, body.retrySeries ?? [])
      );
      return 0;
    }
    case "cancel": {
      const runId = args[1];
      if (!runId) {
        throw new CliError("Usage: vilano run cancel <run-id>");
      }

      const response = await cancelRun(runId);
      writeOutput(flags, response, (body) =>
        [
          renderRun(body.run),
          `had_active_lease: ${body.hadActiveLease}`,
          `cancelled_waits: ${body.cancelledWaitCount}`,
          `cancelled_child_runs: ${body.cancelledChildRunCount}`,
          `cancelled_service_asks: ${body.cancelledServiceAskCount}`,
          `stopped_envelopes: ${body.stoppedEnvelopeCount}`,
          `had_in_flight_turn: ${body.hadInFlightTurn}`,
        ].join("\n")
      );
      return 0;
    }
    default:
      throw new CliError("Usage: vilano run start|list|inspect|explain|replay|cancel");
  }
}
