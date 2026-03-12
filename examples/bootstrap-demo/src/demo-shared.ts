import fs from "node:fs/promises";

export type DemoRetryFamily =
  | "always"
  | "application"
  | "timeout"
  | "process_exit"
  | "process_spawn";

export type DemoRetryJitter =
  | "full"
  | "half"
  | {
      kind: "ratio";
      ratio: number;
    };

export type DemoRetryBackoff =
  | string
  | {
      kind: "fixed";
      delay: string;
      jitter?: DemoRetryJitter;
    }
  | {
      kind: "linear";
      initial: string;
      step?: string;
      max?: string;
      jitter?: DemoRetryJitter;
    }
  | {
      kind: "exponential";
      initial: string;
      factor?: number;
      max?: string;
      jitter?: DemoRetryJitter;
    };

export async function bumpMarkerAttempt(markerPath: string): Promise<number> {
  await fs.mkdir("tmp", { recursive: true });

  try {
    const current = Number((await fs.readFile(markerPath, "utf8")).trim() || "0");
    const next = current + 1;
    await fs.writeFile(markerPath, String(next));
    return next;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.writeFile(markerPath, "1");
      return 1;
    }

    throw error;
  }
}
