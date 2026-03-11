import os from "node:os";
import { spawn } from "node:child_process";

import type { RuntimeBuildInfo, RuntimeCompatibility } from "./distribution-contract.ts";

export interface RuntimeHostInfo {
  platformKey: string;
  os: NodeJS.Platform;
  arch: string;
  osRelease: string;
  darwinKernelMajor?: number;
  glibcVersion?: string;
}

export async function collectRuntimeBuildInfo(): Promise<{
  compatibility: RuntimeCompatibility;
  build: RuntimeBuildInfo;
}> {
  const host = await detectCurrentRuntimeHost();

  return {
    compatibility: {
      platformKey: host.platformKey,
      os: host.os,
      arch: host.arch,
      minimumDarwinKernelMajor: host.darwinKernelMajor,
      minimumGlibcVersion: host.glibcVersion,
    },
    build: {
      source: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "local",
      osRelease: host.osRelease,
      libcFamily: host.glibcVersion ? "glibc" : undefined,
      libcVersion: host.glibcVersion,
    },
  };
}

export async function detectCurrentRuntimeHost(): Promise<RuntimeHostInfo> {
  const currentOs = os.platform();
  const currentArch = os.arch();
  const info: RuntimeHostInfo = {
    platformKey: `${currentOs}-${currentArch}`,
    os: currentOs,
    arch: currentArch,
    osRelease: os.release(),
  };

  if (currentOs === "darwin") {
    info.darwinKernelMajor = parseDarwinKernelMajor(info.osRelease);
    return info;
  }

  if (currentOs === "linux") {
    info.glibcVersion = await detectGlibcVersion();
  }

  return info;
}

export async function getRuntimeCompatibilityIssues(
  compatibility: RuntimeCompatibility
): Promise<string[]> {
  const host = await detectCurrentRuntimeHost();
  const issues: string[] = [];

  if (host.platformKey !== compatibility.platformKey) {
    issues.push(
      `artifact targets ${compatibility.platformKey} but current host is ${host.platformKey}`
    );
    return issues;
  }

  if (
    compatibility.minimumDarwinKernelMajor !== undefined &&
    host.darwinKernelMajor !== undefined &&
    host.darwinKernelMajor < compatibility.minimumDarwinKernelMajor
  ) {
    issues.push(
      `artifact requires Darwin kernel ${compatibility.minimumDarwinKernelMajor}+ but current host is ${host.darwinKernelMajor}`
    );
  }

  if (compatibility.minimumGlibcVersion) {
    if (!host.glibcVersion) {
      issues.push(
        `artifact requires glibc ${compatibility.minimumGlibcVersion}+ but current host glibc could not be detected`
      );
    } else if (compareVersionStrings(host.glibcVersion, compatibility.minimumGlibcVersion) < 0) {
      issues.push(
        `artifact requires glibc ${compatibility.minimumGlibcVersion}+ but current host is ${host.glibcVersion}`
      );
    }
  }

  return issues;
}

export async function assertRuntimeCompatibility(
  compatibility: RuntimeCompatibility,
  label: string
): Promise<void> {
  const issues = await getRuntimeCompatibilityIssues(compatibility);
  if (issues.length === 0) {
    return;
  }

  throw new Error(`Incompatible ${label}: ${issues.join("; ")}`);
}

function parseDarwinKernelMajor(osRelease: string): number | undefined {
  const [major] = osRelease.split(".", 1);
  if (!major) {
    return undefined;
  }

  const parsed = Number.parseInt(major, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function detectGlibcVersion(): Promise<string | undefined> {
  const gnuLibc = await runCommand("getconf", ["GNU_LIBC_VERSION"]);
  if (gnuLibc) {
    const match = gnuLibc.trim().match(/glibc\s+([0-9.]+)/i);
    if (match?.[1]) {
      return match[1];
    }
  }

  const lddVersion = await runCommand("ldd", ["--version"]);
  if (!lddVersion) {
    return undefined;
  }

  const firstLine = lddVersion.split("\n", 1)[0] ?? "";
  const match = firstLine.match(/([0-9]+(?:\.[0-9]+)+)/);
  return match?.[1];
}

function compareVersionStrings(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

async function runCommand(command: string, args: string[]): Promise<string | undefined> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
    });

    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.once("error", () => resolve(undefined));
    child.once("exit", (code) => resolve(code === 0 ? stdout : undefined));
  });
}
