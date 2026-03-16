import { expect, test } from "bun:test";

import { renderRun } from "../cli/src/run-views/base.ts";
import type { RunRecord } from "../cli/src/types.ts";

test("renderRun handles wakeReason-only service passivation", () => {
  const output = renderRun({
    id: "run_service",
    project: "demo",
    definitionKind: "service",
    definitionName: "reviewer",
    status: "idle",
    input: { repoId: "repo_123" },
    output: null,
    error: null,
    passivation: {
      state: "passivated",
      wakeReason: "message",
    },
    createdAt: "2026-03-16T00:00:00.000Z",
    updatedAt: "2026-03-16T00:00:00.000Z",
  } satisfies RunRecord);

  expect(output).toContain("passivation_state: passivated");
  expect(output).toContain("wake_reason: message");
  expect(output).not.toContain("wake_on:");
});
