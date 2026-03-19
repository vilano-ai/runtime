import { inspectWorkflowDefinition, listDefinitions } from "../daemon-client.ts";
import { CliError } from "../cli-error.ts";
import type { CommandFlags } from "../args.ts";
import {
  renderDefinitionInspect,
  renderDefinitionList,
  writeOutput,
} from "../output.ts";
import {
  resolveProjectScope,
  resolveWorkflowReference,
} from "../command-support.ts";

export async function handleWorkflow(
  args: string[],
  flags: CommandFlags
): Promise<number> {
  const command = args[0];

  switch (command) {
    case "list": {
      const project = await resolveProjectScope(flags);
      const response = await listDefinitions("workflow", project);
      writeOutput(flags, response, (body) =>
        renderDefinitionList("workflow", body.project, body.definitions)
      );
      return 0;
    }
    case "inspect": {
      const reference = args[1];
      if (!reference) {
        throw new CliError("Usage: vilano workflow inspect <workflow-ref>");
      }

      const { project, definition } = await resolveWorkflowReference(reference, flags);
      const response = await inspectWorkflowDefinition(project.name, definition.name);
      writeOutput(flags, response, (body) =>
        renderDefinitionInspect(body.project, body.definition)
      );
      return 0;
    }
    default:
      throw new CliError("Usage: vilano workflow list|inspect");
  }
}
