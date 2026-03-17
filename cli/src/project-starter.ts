import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "./json-file.ts";
import { writeExplicitProjectManifest } from "./project-manifest.ts";

export interface StarterProjectResult {
  rootPath: string;
  manifestPath: string;
  files: string[];
  packageName: string;
  projectName: string;
}

const STARTER_FILES = [
  ".gitignore",
  "README.md",
  "package.json",
  "src/definitions.ts",
  "vilano.manifest.json",
];

export async function writeStarterProject(
  projectPath: string,
  options: { force?: boolean } = {}
): Promise<StarterProjectResult> {
  const rootPath = path.resolve(projectPath);
  await ensureStarterTarget(rootPath, options.force ?? false);
  await ensureDir(path.join(rootPath, "src"));

  const packageName = toPackageName(path.basename(rootPath));
  const projectName = toProjectName(path.basename(rootPath));
  const starterFiles = buildStarterFiles(projectName, packageName);

  await Promise.all(
    Object.entries(starterFiles).map(async ([relativePath, contents]) => {
      const targetPath = path.join(rootPath, relativePath);
      await ensureDir(path.dirname(targetPath));
      await fs.writeFile(targetPath, contents, "utf8");
    })
  );

  const manifest = await writeExplicitProjectManifest(rootPath, { force: true });

  return {
    rootPath,
    manifestPath: manifest.manifestPath,
    files: STARTER_FILES,
    packageName,
    projectName,
  };
}

async function ensureStarterTarget(rootPath: string, force: boolean): Promise<void> {
  try {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) {
      throw new Error(`Starter target is not a directory: ${rootPath}`);
    }

    const entries = await fs.readdir(rootPath);
    if (entries.length > 0 && !force) {
      throw new Error(
        `Starter init expects an empty or missing directory: ${rootPath}. Re-run with --force to overwrite starter files in place.`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await ensureDir(rootPath);
      return;
    }

    throw error;
  }
}

function buildStarterFiles(projectName: string, packageName: string): Record<string, string> {
  return {
    ".gitignore": ["node_modules/", ".vilano/", "dist/"].join("\n") + "\n",
    "README.md": renderStarterReadme(projectName),
    "package.json": `${JSON.stringify(
      {
        name: packageName,
        private: true,
        type: "module",
      },
      null,
      2
    )}\n`,
    "src/definitions.ts": renderStarterDefinitions(),
  };
}

function renderStarterDefinitions(): string {
  return [
    'import { service, workflow } from "@vilano/runtime";',
    "",
    "export const reviewer = service({",
    '  name: "reviewer",',
    "  key: (input: { repoId: string }) => input.repoId,",
    "  init: async (input: { repoId: string }) => ({",
    "    repoId: input.repoId,",
    "    notes: [] as string[],",
    "  }),",
    "  onSend: {",
    '    hint: async (payload: { note: string }, state) => ({',
    "      state: {",
    "        ...state,",
    "        notes: [...state.notes, payload.note],",
    "      },",
    "    }),",
    "  },",
    "  onAsk: {",
    "    status: async (_payload: void, state) => ({",
    "      reply: {",
    "        repoId: state.repoId,",
    "        noteCount: state.notes.length,",
    "        notes: state.notes,",
    "      },",
    "    }),",
    "  },",
    "});",
    "",
    "export const reviewCoordinator = workflow({",
    '  name: "reviewCoordinator",',
    "  run: async (input: { repoId: string; note: string }, ctx) => {",
    "    const reviewerRef = await ctx.connect(reviewer, { repoId: input.repoId });",
    "    await reviewerRef.send.hint({ note: input.note });",
    "    const status = await reviewerRef.ask.status();",
    "",
    "    return {",
    "      reviewerRunId: reviewerRef.id,",
    "      status,",
    "    };",
    "  },",
    "});",
    "",
  ].join("\n");
}

function renderStarterReadme(projectName: string): string {
  return [
    "# Vilano Starter",
    "",
    "This starter gives you one workflow and one durable keyed service:",
    "",
    "- `reviewCoordinator` connects to `reviewer`, sends a note, then asks for status.",
    "- `reviewer` stores notes durably per `repoId`.",
    "",
    "Install Bun 1.3.10+ from https://bun.sh/ before running the commands below.",
    "",
    "## Try It",
    "",
    "```bash",
    "bun add @vilano/runtime",
    `vilano project add . --name ${projectName}`,
    `vilano run start ${projectName}/reviewCoordinator --input '{"repoId":"repo_123","note":"Ship 0.1"}'`,
    `vilano service ask ${projectName}/reviewer status --service-key repo_123 --wait-timeout 30s`,
    "```",
    "",
    "The first `project add` or `run start` will start the local runtime if it is not already running.",
    "",
  ].join("\n");
}

function toPackageName(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-._]+$/, "");

  return normalized.length > 0 ? normalized : "vilano-starter";
}

function toProjectName(input: string): string {
  const normalized = input
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[-._]+$/, "");

  return normalized.length > 0 ? normalized : "demo";
}
