import {
  askService,
  ensureServiceRun,
  inspectServiceRun,
  replayRun,
  sendServiceMessage,
  sendServiceSignal,
  stopServiceRun,
  listDefinitions,
  listServiceRuns,
} from "../daemon-client.ts";
import { CliError } from "../cli-error.ts";
import type { CommandFlags } from "../args.ts";
import {
  parseDurationFlag,
  parseJsonFlag,
  resolveProjectScope,
  resolveServiceTarget,
  waitForServiceEnvelope,
} from "../command-support.ts";
import {
  renderDefinitionList,
  writeOutput,
} from "../output.ts";
import {
  decorateRunInspect,
  renderRun,
  renderRunInspect,
  renderRunReplay,
  renderServiceRunList,
} from "../run-views.ts";

export async function handleService(
  args: string[],
  flags: CommandFlags
): Promise<number> {
  const command = args[0];

  switch (command) {
    case "list": {
      if (flags.instances) {
        const project = await resolveProjectScope(flags);
        const response = await listServiceRuns(project, Boolean(flags.active));
        writeOutput(flags, response, (body) =>
          renderServiceRunList(body.project, body.activeOnly, body.runs)
        );
        return 0;
      }

      const project = await resolveProjectScope(flags);
      const response = await listDefinitions("service", project);
      writeOutput(flags, response, (body) =>
        renderDefinitionList("service", body.project, body.definitions)
      );
      return 0;
    }
    case "ensure": {
      const reference = args[1];
      if (!reference) {
        throw new CliError(
          "Usage: vilano service ensure <service-ref> --service-key <key> [--key-json '{...}']"
        );
      }

      const target = await resolveServiceTarget(reference, flags, { autoStart: true });
      const response = await ensureServiceRun(
        target.project.name,
        target.definition.name,
        target.serviceKey,
        target.keyInput
      );
      writeOutput(flags, response, (body) =>
        `${renderRun(body.run)}\nservice_key: ${target.serviceKey}`
      );
      return 0;
    }
    case "inspect": {
      const reference = args[1];
      if (!reference) {
        throw new CliError("Usage: vilano service inspect <service-ref> --service-key <key>");
      }

      const target = await resolveServiceTarget(reference, flags, { autoStart: true });
      const response = decorateRunInspect(
        await inspectServiceRun(
          target.project.name,
          target.definition.name,
          target.serviceKey
        )
      );
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
    case "history": {
      const reference = args[1];
      if (!reference) {
        throw new CliError("Usage: vilano service history <service-ref> --service-key <key>");
      }

      const target = await resolveServiceTarget(reference, flags, { autoStart: true });
      const inspected = await inspectServiceRun(
        target.project.name,
        target.definition.name,
        target.serviceKey
      );
      const response = decorateRunInspect(await replayRun(inspected.run.id));
      writeOutput(flags, response, (body) =>
        renderRunReplay(body.run, body.timeline, body.retrySeries ?? [])
      );
      return 0;
    }
    case "send": {
      const reference = args[1];
      const messageName = args[2];
      if (!reference || !messageName) {
        throw new CliError(
          "Usage: vilano service send <service-ref> <message-name> --service-key <key> [--input '{...}'] [--key-json '{...}']"
        );
      }

      const target = await resolveServiceTarget(reference, flags, { autoStart: true });
      const payload = parseJsonFlag(flags.input, "input", null);
      const response = await sendServiceMessage(
        target.project.name,
        target.definition.name,
        target.serviceKey,
        target.keyInput,
        messageName,
        payload
      );
      writeOutput(flags, response, (body) =>
        [
          `service: ${target.project.name}/${target.definition.name}`,
          `service_key: ${target.serviceKey}`,
          `run: ${body.run.id}`,
          `envelope: ${body.envelope.id}`,
          `queued: send ${messageName}`,
        ].join("\n")
      );
      return 0;
    }
    case "ask": {
      const reference = args[1];
      const messageName = args[2];
      if (!reference || !messageName) {
        throw new CliError(
          "Usage: vilano service ask <service-ref> <ask-name> --service-key <key> [--input '{...}'] [--key-json '{...}'] [--wait-timeout 30s]"
        );
      }

      if (flags.timeout !== undefined) {
        throw new CliError(
          "External service asks use --wait-timeout for CLI polling. Durable ask timeouts are only supported from workflow/service code today."
        );
      }

      const target = await resolveServiceTarget(reference, flags, { autoStart: true });
      const payload = parseJsonFlag(flags.input, "input", null);
      const initial = await askService(
        target.project.name,
        target.definition.name,
        target.serviceKey,
        target.keyInput,
        messageName,
        payload
      );
      const timeoutMs = parseDurationFlag(flags["wait-timeout"], 30_000, "wait-timeout");
      const envelope = await waitForServiceEnvelope(initial.envelope.id, timeoutMs);

      if (envelope.status === "failed") {
        const message =
          envelope.error &&
          typeof envelope.error === "object" &&
          "message" in envelope.error &&
          typeof envelope.error.message === "string"
            ? envelope.error.message
            : `Service ask '${messageName}' failed`;
        throw new CliError(message);
      }

      const body = {
        ok: true as const,
        run: initial.run,
        envelope,
        reply: envelope.reply,
      };

      writeOutput(flags, body, (value) =>
        [
          `service: ${target.project.name}/${target.definition.name}`,
          `service_key: ${target.serviceKey}`,
          `run: ${value.run.id}`,
          `envelope: ${value.envelope.id}`,
          `reply: ${JSON.stringify(value.reply)}`,
        ].join("\n")
      );
      return 0;
    }
    case "stop": {
      const reference = args[1];
      if (!reference) {
        throw new CliError("Usage: vilano service stop <service-ref> --service-key <key>");
      }

      const target = await resolveServiceTarget(reference, flags, { autoStart: true });
      const response = await stopServiceRun(
        target.project.name,
        target.definition.name,
        target.serviceKey
      );
      writeOutput(flags, response, (body) =>
        [
          `service: ${target.project.name}/${target.definition.name}`,
          `service_key: ${target.serviceKey}`,
          `run: ${body.run.id}`,
          `status: ${body.run.status}`,
          `stopped_envelopes: ${body.stoppedEnvelopeCount}`,
          `cancelled_waits: ${body.cancelledWaitCount}`,
          `cancelled_child_runs: ${body.cancelledChildRunCount ?? 0}`,
          `cancelled_service_asks: ${body.cancelledServiceAskCount ?? 0}`,
          `had_in_flight_turn: ${body.hadInFlightTurn}`,
        ].join("\n")
      );
      return 0;
    }
    case "signal": {
      const reference = args[1];
      const signalName = args[2];
      if (!reference || !signalName) {
        throw new CliError(
          "Usage: vilano service signal <service-ref> <signal-name> --service-key <key> [--input '{...}'] [--key-json '{...}']"
        );
      }

      const target = await resolveServiceTarget(reference, flags, { autoStart: true });
      const payload = parseJsonFlag(flags.input, "input", null);
      const response = await sendServiceSignal(
        target.project.name,
        target.definition.name,
        target.serviceKey,
        target.keyInput,
        signalName,
        payload
      );
      writeOutput(flags, response, (body) =>
        [
          `service: ${target.project.name}/${target.definition.name}`,
          `service_key: ${target.serviceKey}`,
          `run: ${body.run.id}`,
          `envelope: ${body.envelope.id}`,
          `queued: signal ${signalName}`,
        ].join("\n")
      );
      return 0;
    }
    default:
      throw new CliError(
        "Usage: vilano service list|ensure|inspect|history|send|ask|signal|stop"
      );
  }
}
