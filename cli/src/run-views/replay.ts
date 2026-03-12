import type { RunRecord, RunReplayEntry, RunRetrySeriesRecord } from "../types.ts";
import { renderRun } from "./base.ts";
import { renderRetrySeries } from "./retry.ts";

export function renderRunReplay(
  run: RunRecord,
  timeline: RunReplayEntry[],
  retrySeries: RunRetrySeriesRecord[]
): string {
  const timelineLines =
    timeline.length === 0
      ? ["timeline: none"]
      : [
          "timeline:",
          ...timeline.map(
            (entry) =>
              `  ${entry.seq}. ${entry.createdAt}\t${entry.type}${entry.summary ? `\t${entry.summary}` : ""}`
          ),
        ];
  const retrySeriesLines = renderRetrySeries(retrySeries);

  return [renderRun(run), ...retrySeriesLines, ...timelineLines].join("\n");
}
