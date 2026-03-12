import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { DaemonAuthState, DaemonState } from "../cli/src/types.ts";

export function deriveServiceKey(keyInput: unknown): string {
  if (typeof keyInput === "string" && keyInput.trim() !== "") {
    return keyInput;
  }

  if (keyInput && typeof keyInput === "object" && !Array.isArray(keyInput)) {
    const entries = Object.entries(keyInput as Record<string, unknown>).filter(
      ([, value]) =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    );

    if (entries.length === 1) {
      return String(entries[0]?.[1]);
    }
  }

  throw new Error(
    "RuntimeHarness could not derive a service key from key input. Pass a simple stable identifier."
  );
}

export async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export function expectInOrder(text: string, fragments: string[]): void {
  let lastIndex = -1;

  for (const fragment of fragments) {
    const nextIndex = text.indexOf(fragment, lastIndex + 1);
    if (nextIndex <= lastIndex) {
      throw new Error(`Expected fragment ordering after index ${lastIndex}, got ${nextIndex}`);
    }

    lastIndex = nextIndex;
  }
}

export async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  const startedAt = Date.now();

  while (Date.now() <= deadline) {
    try {
      const value = await fn();
      if (predicate(value)) {
        maybeLogTiming(`waitFor(${timeoutMs})`, Date.now() - startedAt);
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(150);
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error(`Timed out waiting after ${timeoutMs}ms`);
}

export async function cloneBootstrapDemoProject(
  projectDir: string,
  bootstrapDemoRoot: string,
  sdkRoot: string
): Promise<void> {
  await fs.mkdir(path.dirname(projectDir), { recursive: true });
  await fs.cp(bootstrapDemoRoot, projectDir, {
    recursive: true,
    force: true,
    filter: (_source, destination) => {
      const name = path.basename(destination);
      return name !== ".vilano" && name !== "tmp";
    },
  });

  const runtimePackageDir = path.join(projectDir, "node_modules", "@vilano", "runtime");
  await fs.mkdir(path.dirname(runtimePackageDir), { recursive: true });
  await fs.symlink(sdkRoot, runtimePackageDir, "dir");
}

export function choosePortCandidate(): number {
  const min = 20_000;
  const max = 50_000;
  return min + Math.floor(Math.random() * (max - min));
}

export async function readDaemonState(runtimeHome: string): Promise<DaemonState | null> {
  try {
    const raw = await fs.readFile(path.join(runtimeHome, "daemon.json"), "utf8");
    return JSON.parse(raw) as DaemonState;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function readDaemonAuthState(
  runtimeHome: string
): Promise<DaemonAuthState | null> {
  try {
    const raw = await fs.readFile(path.join(runtimeHome, "daemon-auth.json"), "utf8");
    return JSON.parse(raw) as DaemonAuthState;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export function parseQualifiedReference(reference: string): [string, string] {
  const slashIndex = reference.indexOf("/");
  if (slashIndex <= 0 || slashIndex === reference.length - 1) {
    throw new Error(`Expected qualified reference like 'project/name', got '${reference}'`);
  }

  return [reference.slice(0, slashIndex), reference.slice(slashIndex + 1)];
}

export function maybeLogTiming(label: string, durationMs: number): void {
  if (process.env.VILANO_TEST_TIMING !== "1") {
    return;
  }

  console.error(`[timing] ${label} ${durationMs}ms`);
}

export async function makeTreeWritable(rootPath: string): Promise<void> {
  const stat = await fs.lstat(rootPath);

  if (stat.isDirectory()) {
    const entries = await fs.readdir(rootPath);
    await Promise.all(entries.map((entry) => makeTreeWritable(path.join(rootPath, entry))));
    await fs.chmod(rootPath, stat.mode | 0o200);
    return;
  }

  if (stat.isFile()) {
    await fs.chmod(rootPath, stat.mode | 0o200);
  }
}
