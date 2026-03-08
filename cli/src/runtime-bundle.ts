import fs from "node:fs";
import path from "node:path";

export interface RuntimeBundlePaths {
  cliRoot: string;
  runtimeRoot: string;
  kernelDir: string;
  workerDir: string;
  bundled: boolean;
}

export function resolveRuntimeBundlePaths(): RuntimeBundlePaths {
  const cliRoot = path.resolve(import.meta.dir, "..");
  const repoRoot = path.resolve(cliRoot, "..");
  const repoKernel = path.join(repoRoot, "kernel", "mix.exs");
  const repoWorker = path.join(repoRoot, "worker", "bun", "src", "cli.ts");

  if (fs.existsSync(repoKernel) && fs.existsSync(repoWorker)) {
    return {
      cliRoot,
      runtimeRoot: repoRoot,
      kernelDir: path.join(repoRoot, "kernel"),
      workerDir: path.join(repoRoot, "worker", "bun"),
      bundled: false,
    };
  }

  const bundledRoot = path.join(cliRoot, "runtime-dist");
  const bundledKernel = path.join(bundledRoot, "kernel", "mix.exs");
  const bundledWorker = path.join(bundledRoot, "worker", "bun", "src", "cli.ts");

  if (fs.existsSync(bundledKernel) && fs.existsSync(bundledWorker)) {
    return {
      cliRoot,
      runtimeRoot: bundledRoot,
      kernelDir: path.join(bundledRoot, "kernel"),
      workerDir: path.join(bundledRoot, "worker", "bun"),
      bundled: true,
    };
  }

  throw new Error(
    `Unable to locate the Vilano runtime bundle from ${cliRoot}. Expected kernel/mix.exs and worker/bun/src/cli.ts in either ${path.join(
      bundledRoot,
      "kernel"
    )} or ${path.join(repoRoot, "kernel")}.`
  );
}
