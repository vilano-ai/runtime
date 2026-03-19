import { getRunningDaemonStatus } from "../daemon-client.ts";
import { firstNonEmptyLine, runCommand } from "../process-utils.ts";

export interface ToolCheck {
  found: boolean;
  path: string | null;
  version: string | null;
}

export async function applyDoctorFixes(
  kernelDir: string,
  options: {
    bundled: boolean;
    depsReady: boolean;
    buildReady: boolean;
  }
): Promise<string[]> {
  const fixes: string[] = [];

  if (options.bundled && options.depsReady && options.buildReady) {
    fixes.push("packaged runtime already contains a ready kernel release");
    return fixes;
  }

  await runCommand("mix", ["local.hex", "--force"], { cwd: kernelDir });
  fixes.push("mix local.hex --force");

  await runCommand("mix", ["local.rebar", "--force"], { cwd: kernelDir });
  fixes.push("mix local.rebar --force");

  if (!options.depsReady) {
    await runCommand("mix", ["deps.get"], { cwd: kernelDir });
    fixes.push("mix deps.get");
  }

  if (!options.buildReady) {
    await runCommand("mix", ["compile"], { cwd: kernelDir });
    fixes.push("mix compile");
  }

  return fixes;
}

export async function getDaemonStatusReport(): Promise<{
  status: Awaited<ReturnType<typeof getRunningDaemonStatus>>;
  error: string | null;
}> {
  try {
    return {
      status: await getRunningDaemonStatus(),
      error: null,
    };
  } catch (error) {
    return {
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function inspectTool(command: string, args: string[]): Promise<ToolCheck> {
  const executable = Bun.which(command);
  if (!executable) {
    return {
      found: false,
      path: null,
      version: null,
    };
  }

  const result = await runCommand(command, args).catch(() => null);

  return {
    found: true,
    path: executable,
    version: result ? firstNonEmptyLine(`${result.stdout}\n${result.stderr}`) : null,
  };
}
