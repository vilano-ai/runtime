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
  const bundledRoot = path.join(cliRoot, "runtime-dist");
  const bundledKernel = path.join(bundledRoot, "kernel", "mix.exs");

  if (fs.existsSync(bundledKernel)) {
    return {
      cliRoot,
      runtimeRoot: bundledRoot,
      kernelDir: path.join(bundledRoot, "kernel"),
      workerDir: path.join(bundledRoot, "worker", "bun"),
      bundled: true,
    };
  }

  const repoRoot = path.resolve(cliRoot, "..");
  const repoKernel = path.join(repoRoot, "kernel", "mix.exs");
  if (fs.existsSync(repoKernel)) {
    return {
      cliRoot,
      runtimeRoot: repoRoot,
      kernelDir: path.join(repoRoot, "kernel"),
      workerDir: path.join(repoRoot, "worker", "bun"),
      bundled: false,
    };
  }

  throw new Error(
    `Unable to locate the Vilano runtime bundle from ${cliRoot}. Expected kernel/mix.exs in either ${path.join(
      bundledRoot,
      "kernel"
    )} or ${path.join(repoRoot, "kernel")}.`
  );
}
