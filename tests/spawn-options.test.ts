import { expect, test } from "bun:test";

import { nextSpawnOpKey } from "../worker/shared/src/turn-context-helpers.ts";

test("nextSpawnOpKey preserves explicit keys by default", () => {
  const counters = new Map<string, number>();

  expect(nextSpawnOpKey(counters, "childTask", { key: "job:123" })).toBe("job:123");
  expect(nextSpawnOpKey(counters, "childTask", { key: "job:123" })).toBe("job:123");
});

test("nextSpawnOpKey can force fresh keys from an explicit base key", () => {
  const counters = new Map<string, number>();

  expect(nextSpawnOpKey(counters, "childTask", { key: "job:123", policy: "fresh" })).toBe(
    "spawn:job:123:1"
  );
  expect(nextSpawnOpKey(counters, "childTask", { key: "job:123", policy: "fresh" })).toBe(
    "spawn:job:123:2"
  );
});

test("nextSpawnOpKey can force fresh implicit keys", () => {
  const counters = new Map<string, number>();

  expect(nextSpawnOpKey(counters, "childTask", { policy: "fresh" })).toBe("spawn:childTask:1");
  expect(nextSpawnOpKey(counters, "childTask", { policy: "fresh" })).toBe("spawn:childTask:2");
});
