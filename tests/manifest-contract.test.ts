import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { buildProjectManifest } from "../cli/src/registry.ts";

test("project registration respects explicit vilano.manifest.json even during regeneration", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-manifest-explicit-"));

  try {
    await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "src", "definitions.ts"),
      [
        'export const scannedWorkflow = workflow({',
        '  name: "scannedWorkflow",',
        "});",
        "",
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(projectDir, "vilano.manifest.json"),
      `${JSON.stringify(
        {
          manifestVersion: 1,
          definitions: {
            workflows: [
              {
                kind: "workflow",
                name: "explicitWorkflow",
                exportName: "scannedWorkflow",
                file: "src/definitions.ts",
                runtimeKind: "javascript",
                sourceLanguage: "typescript",
              },
            ],
            services: [],
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const manifest = await buildProjectManifest("demo", projectDir, { regenerate: true });

    expect(manifest.definitions.workflows).toEqual([
      {
        kind: "workflow",
        name: "explicitWorkflow",
        exportName: "scannedWorkflow",
        file: "src/definitions.ts",
        runtimeKind: "javascript",
        sourceLanguage: "typescript",
      },
    ]);
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test("generated manifest fallback records javascript source files correctly", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-manifest-js-"));

  try {
    await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "src", "definitions.js"),
      [
        'export const jsWorkflow = workflow({',
        '  name: "jsWorkflow",',
        "});",
        "",
      ].join("\n"),
      "utf8"
    );

    const manifest = await buildProjectManifest("demo", projectDir, { regenerate: true });

    expect(manifest.definitions.workflows).toEqual([
      {
        kind: "workflow",
        name: "jsWorkflow",
        exportName: "jsWorkflow",
        file: "src/definitions.js",
        runtimeKind: "javascript",
        sourceLanguage: "javascript",
      },
    ]);
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});
