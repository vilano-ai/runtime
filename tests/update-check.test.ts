import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { expect, test } from "bun:test";

import { main } from "../cli/src/index.ts";

test("vilano update --check reports newer stable releases from release metadata", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-update-check-"));
  const manifestPath = path.join(tempDir, "release.json");
  const originalWrite = process.stdout.write.bind(process.stdout);
  const writes: string[] = [];

  try {
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          manifestVersion: 1,
          latest: "0.1.1",
          channels: {
            stable: "0.1.1",
            preview: "0.2.0-beta.1",
          },
          releases: {
            "0.1.1": {
              version: "0.1.1",
              channel: "stable",
              protocolVersion: 1,
              schemaMin: 12,
              schemaMax: 12,
              supportedWorkerRuntimes: ["bun"],
              releasedAt: "2026-03-10T12:00:00.000Z",
              artifacts: {
                [`${process.platform}-${process.arch}`]: {
                  url: "https://example.com/vilano-v0.1.1.tar.gz",
                  sha256: "abc123",
                },
              },
            },
            "0.2.0-beta.1": {
              version: "0.2.0-beta.1",
              channel: "preview",
              protocolVersion: 1,
              schemaMin: 12,
              schemaMax: 12,
              supportedWorkerRuntimes: ["bun", "node"],
              releasedAt: "2026-03-11T12:00:00.000Z",
              artifacts: {},
            },
          },
        },
        null,
        2
      )}\n`
    );

    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    const exitCode = await main([
      "update",
      "--check",
      "--release-manifest",
      manifestPath,
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const body = JSON.parse(writes.join("")) as {
      mode: string;
      channel: string;
      current: { version: string };
      latest: { version: string; artifact: { url: string } | null };
      updateAvailable: boolean;
      platform: { supported: boolean };
    };

    expect(body.mode).toBe("check");
    expect(body.channel).toBe("stable");
    expect(body.current.version).toBe("0.1.0");
    expect(body.latest.version).toBe("0.1.1");
    expect(body.latest.artifact?.url).toBe("https://example.com/vilano-v0.1.1.tar.gz");
    expect(body.platform.supported).toBe(true);
    expect(body.updateAvailable).toBe(true);
  } finally {
    process.stdout.write = originalWrite as typeof process.stdout.write;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
