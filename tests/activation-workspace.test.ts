import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensureActivationWorkspace,
} from "../worker/shared/src/activation-workspace.ts";

test("activation workspaces share snapshot node_modules without an import cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-activation-workspace-"));
  const projectPath = path.join(root, "project");
  const workerHome = path.join(root, "worker-home");

  try {
    await fs.mkdir(path.join(projectPath, "src"), { recursive: true });
    await fs.mkdir(path.join(projectPath, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(projectPath, "src", "index.ts"), "export const value = 1;\n", "utf8");
    await fs.writeFile(
      path.join(projectPath, "node_modules", "pkg", "index.js"),
      "module.exports = { ok: true };\n",
      "utf8"
    );

    const firstActivation = {
      leaseId: "lease-1",
      project: { path: projectPath },
    } as any;
    const secondActivation = {
      leaseId: "lease-2",
      project: { path: projectPath },
    } as any;

    const firstWorkspace = await ensureActivationWorkspace(workerHome, firstActivation, projectPath);
    const secondWorkspace = await ensureActivationWorkspace(workerHome, secondActivation, projectPath);

    const firstNodeModulesLink = await fs.realpath(path.join(firstWorkspace, "node_modules"));
    const secondNodeModulesLink = await fs.realpath(path.join(secondWorkspace, "node_modules"));

    expect(firstNodeModulesLink).toBe(await fs.realpath(path.join(projectPath, "node_modules")));
    expect(secondNodeModulesLink).toBe(await fs.realpath(path.join(projectPath, "node_modules")));

    await expect(fs.access(path.join(workerHome, "import-cache"))).rejects.toThrow();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
