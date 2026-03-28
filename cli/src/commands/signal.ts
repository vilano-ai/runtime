import { sendRunSignal } from "../daemon-client.ts";
import { CliError } from "../cli-error.ts";
import type { CommandFlags } from "../args.ts";
import { parseJsonFlag } from "../command-support.ts";
import { writeOutput } from "../output.ts";

export async function handleSignal(
  args: string[],
  flags: CommandFlags
): Promise<number> {
  const command = args[0];

  switch (command) {
    case "send": {
      const runId = args[1];
      const signalName = args[2];
      if (!runId || !signalName) {
        throw new CliError(
          "Usage: vilano signal send <run-id> <signal-name> [--input '{...}']"
        );
      }

      const payload = parseJsonFlag(flags.input, "input", null);
      const response = await sendRunSignal(runId, signalName, payload);
      writeOutput(flags, response, (body) =>
        `Sent signal ${body.signal.name} to ${body.signal.runId}`
      );
      return 0;
    }
    default:
      throw new CliError(
        "Usage: vilano signal send <run-id> <signal-name> [--input '{...}']"
      );
  }
}
