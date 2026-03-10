import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { buildProjectManifest } from "../cli/src/registry.ts";
import { writeExplicitProjectManifest } from "../cli/src/project-manifest.ts";

test("project registration respects explicit vilano.manifest.json even during regeneration", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-manifest-explicit-"));

  try {
    await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "src", "definitions.ts"),
      [
        "function workflow(definition) {",
        "  return { kind: 'workflow', ...definition };",
        "}",
        "",
        'export const scannedWorkflow = workflow({',
        '  name: "scannedWorkflow",',
        "});",
        "",
        'export const ignoredWorkflow = workflow({',
        '  name: "ignoredWorkflow",',
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
                name: "scannedWorkflow",
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
        name: "scannedWorkflow",
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
        "function workflow(definition) {",
        "  return { kind: 'workflow', ...definition };",
        "}",
        "",
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

test("explicit manifests cannot point outside the project root", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-manifest-outside-"));

  try {
    await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "..", "outside.ts"), "export const outside = 1;\n", "utf8");
    await fs.writeFile(
      path.join(projectDir, "vilano.manifest.json"),
      `${JSON.stringify(
        {
          manifestVersion: 1,
          definitions: {
            workflows: [
              {
                kind: "workflow",
                name: "outsideWorkflow",
                exportName: "outsideWorkflow",
                file: "../outside.ts",
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

    await expect(buildProjectManifest("demo", projectDir, { regenerate: true })).rejects.toThrow(
      "must stay within the project root"
    );
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(path.join(projectDir, "..", "outside.ts"), { force: true });
  }
});

test("explicit manifest validation does not import project definition modules", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-manifest-no-import-"));
  const markerPath = path.join(projectDir, "imported.txt");

  try {
    await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "src", "definitions.ts"),
      [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(markerPath)}, 'imported');`,
        "",
        "function workflow(definition) {",
        "  return { kind: 'workflow', ...definition };",
        "}",
        "",
        'export const safeWorkflow = workflow({',
        '  name: "safeWorkflow",',
        "});",
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
                name: "safeWorkflow",
                exportName: "safeWorkflow",
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

    await buildProjectManifest("demo", projectDir, { regenerate: true });

    await expect(fs.access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test("explicit manifests must reference files that exist", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-manifest-missing-"));

  try {
    await fs.writeFile(
      path.join(projectDir, "vilano.manifest.json"),
      `${JSON.stringify(
        {
          manifestVersion: 1,
          definitions: {
            workflows: [
              {
                kind: "workflow",
                name: "missingWorkflow",
                exportName: "missingWorkflow",
                file: "src/missing.ts",
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

    await expect(buildProjectManifest("demo", projectDir, { regenerate: true })).rejects.toThrow(
      "file does not exist"
    );
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test("writeExplicitProjectManifest writes an explicit vilano.manifest.json contract", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-manifest-init-"));

  try {
    await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "src", "definitions.ts"),
      [
        "function workflow(definition) {",
        "  return { kind: 'workflow', ...definition };",
        "}",
        "",
        "function service(definition) {",
        "  return { kind: 'service', ...definition };",
        "}",
        "",
        'export const planner = workflow({',
        '  name: "planner",',
        "});",
        "",
        'export const reviewer = service({',
        '  name: "reviewer",',
        "});",
      ].join("\n"),
      "utf8"
    );

    const result = await writeExplicitProjectManifest(projectDir);
    expect(result.manifestPath).toBe(path.join(projectDir, "vilano.manifest.json"));
    expect(result.manifest.definitions.workflows).toHaveLength(1);
    expect(result.manifest.definitions.services).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(result.manifestPath, "utf8"))).toEqual(result.manifest);
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test("explicit manifests reject symlinked definition files", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-manifest-symlink-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-manifest-symlink-target-"));

  try {
    await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
    await fs.writeFile(path.join(outsideDir, "outside.ts"), "export const outsideWorkflow = 1;\n", "utf8");
    await fs.symlink(path.join(outsideDir, "outside.ts"), path.join(projectDir, "src", "outside.ts"));
    await fs.writeFile(
      path.join(projectDir, "vilano.manifest.json"),
      `${JSON.stringify(
        {
          manifestVersion: 1,
          definitions: {
            workflows: [
              {
                kind: "workflow",
                name: "outsideWorkflow",
                exportName: "outsideWorkflow",
                file: "src/outside.ts",
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

    await expect(buildProjectManifest("demo", projectDir, { regenerate: true })).rejects.toThrow(
      "must not be a symbolic link"
    );
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});
