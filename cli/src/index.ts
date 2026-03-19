import process from "node:process";
import { CliError } from "./cli-error.ts";
import { parseArgs, shouldApplyProjectConfig, writeCliError } from "./args.ts";
import { handleInitCommand, handleProjectCommand } from "./commands/project.ts";
import { handleRun } from "./commands/run.ts";
import { handleService } from "./commands/service.ts";
import { handleSignal } from "./commands/signal.ts";
import {
  handleDaemonCommand,
  handleDoctorCommand,
  handleRollbackCommand,
  handleUpdateCommand,
  handleVersionCommand,
  handleWorkerCommand,
} from "./commands/system.ts";
import { handleWorkflow } from "./commands/workflow.ts";
import { renderHelp } from "./help.ts";
import { writeOutput } from "./output.ts";
import { applyProjectConfigForCwd } from "./project-config.ts";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (shouldApplyProjectConfig(parsed)) {
      await applyProjectConfigForCwd();
    }
    if (parsed.positionals[0] === "help") {
      writeOutput(parsed.flags, renderHelp(parsed.positionals.slice(1)));
      return 0;
    }

    if (parsed.positionals.length === 0 || parsed.flags.help || parsed.flags.h) {
      writeOutput(parsed.flags, renderHelp(parsed.positionals));
      return 0;
    }

    const [group, ...rest] = parsed.positionals;

    switch (group) {
      case "version":
        return handleVersionCommand(parsed.flags);
      case "update":
        return handleUpdateCommand(parsed.flags);
      case "rollback":
        return handleRollbackCommand(parsed.flags);
      case "doctor":
        return handleDoctorCommand(parsed.flags);
      case "init":
        return handleInitCommand(rest, parsed.flags);
      case "daemon":
        return handleDaemonCommand(rest, parsed.flags);
      case "project":
        return handleProjectCommand(rest, parsed.flags);
      case "workflow":
        return handleWorkflow(rest, parsed.flags);
      case "run":
        return handleRun(rest, parsed.flags);
      case "worker":
        return handleWorkerCommand(rest, parsed.flags);
      case "service":
        return handleService(rest, parsed.flags);
      case "signal":
        return handleSignal(rest, parsed.flags);
      default:
        throw new CliError(`Unknown command group: ${group}`);
    }
  } catch (error) {
    return writeCliError(error, argv);
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
