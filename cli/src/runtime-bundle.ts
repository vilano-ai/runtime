import fs from "node:fs";
import path from "node:path";

export interface RuntimeBundlePaths {
  cliRoot: string;
  runtimeRoot: string;
  kernelDir: string;
  workerDir: string;
  manifestFile: string;
  bundled: boolean;
}

export { type RuntimeInstallManifest as RuntimeBundleManifest } from "./distribution-contract.ts";

export function resolveRuntimeBundlePaths(): RuntimeBundlePaths {
  const cliRoot = path.resolve(import.meta.dir, "..");
  const repoRoot = path.resolve(cliRoot, "..");
  const repoKernel = path.join(repoRoot, "kernel", "mix.exs");
  const repoWorker = path.join(repoRoot, "worker", "bun", "src", "cli.ts");
  const repoSharedWorker = path.join(repoRoot, "worker", "shared", "src", "core.ts");

  if (fs.existsSync(repoKernel) && fs.existsSync(repoWorker) && fs.existsSync(repoSharedWorker)) {
    return {
      cliRoot,
      runtimeRoot: repoRoot,
      kernelDir: path.join(repoRoot, "kernel"),
      workerDir: path.join(repoRoot, "worker"),
      manifestFile: path.join(repoRoot, "protocol", "install-manifest.json"),
      bundled: false,
    };
  }

  const bundledRoot = path.join(cliRoot, "runtime-dist");
  const bundledKernelRelease = path.join(bundledRoot, "kernel-release", "bin", "vilano_kernel");
  const bundledWorker = path.join(bundledRoot, "worker", "bun", "src", "cli.ts");
  const bundledSharedWorker = path.join(bundledRoot, "worker", "shared", "src", "core.ts");
  const bundledManifest = path.join(bundledRoot, "install-manifest.json");

  if (fs.existsSync(bundledKernelRelease) && fs.existsSync(bundledWorker) && fs.existsSync(bundledSharedWorker)) {
    return {
      cliRoot,
      runtimeRoot: bundledRoot,
      kernelDir: path.join(bundledRoot, "kernel-release"),
      workerDir: path.join(bundledRoot, "worker"),
      manifestFile: bundledManifest,
      bundled: true,
    };
  }

  throw new Error(
    `Unable to locate the Vilano runtime bundle from ${cliRoot}. Expected a kernel release under ${path.join(
      bundledRoot,
      "kernel-release"
    )} or kernel source under ${path.join(repoRoot, "kernel")}.`
  );
}
