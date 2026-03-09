import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

const metaPath = path.join(ROOT, "protocol", "v1", "meta.json");
const cliRuntimeVersionPath = path.join(ROOT, "cli", "src", "runtime-version.ts");
const sharedWorkerRuntimeVersionPath = path.join(ROOT, "worker", "shared", "src", "runtime-version.ts");
const kernelVersionPath = path.join(ROOT, "kernel", "lib", "vilano_kernel", "version.ex");

const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as {
  protocolVersion: number;
};

const cliProtocolVersion = await readTsConst(cliRuntimeVersionPath, "CLI_PROTOCOL_VERSION");
const workerProtocolVersion = await readTsConst(
  sharedWorkerRuntimeVersionPath,
  "WORKER_PROTOCOL_VERSION"
);
const kernelProtocolVersion = await readElixirAttribute(kernelVersionPath, "@protocol_version");

const mismatches = [
  ["protocol/v1/meta.json", meta.protocolVersion],
  ["cli/src/runtime-version.ts", cliProtocolVersion],
  ["worker/shared/src/runtime-version.ts", workerProtocolVersion],
  ["kernel/lib/vilano_kernel/version.ex", kernelProtocolVersion],
].filter(([, value]) => value !== meta.protocolVersion);

if (mismatches.length > 0) {
  throw new Error(
    `Protocol version mismatch detected. Expected ${meta.protocolVersion}, found ${mismatches
      .map(([file, value]) => `${file}=${String(value)}`)
      .join(", ")}`
  );
}

process.stdout.write(
  `${JSON.stringify({ ok: true, protocolVersion: meta.protocolVersion }, null, 2)}\n`
);

async function readTsConst(filePath: string, constantName: string): Promise<number> {
  const source = await fs.readFile(filePath, "utf8");
  const match = source.match(new RegExp(`export\\s+const\\s+${constantName}\\s*=\\s*(\\d+)`));
  if (!match) {
    throw new Error(`Unable to locate ${constantName} in ${filePath}`);
  }

  return Number.parseInt(match[1] ?? "0", 10);
}

async function readElixirAttribute(filePath: string, attributeName: string): Promise<number> {
  const source = await fs.readFile(filePath, "utf8");
  const match = source.match(new RegExp(`${escapeRegExp(attributeName)}\\s+(\\d+)`));
  if (!match) {
    throw new Error(`Unable to locate ${attributeName} in ${filePath}`);
  }

  return Number.parseInt(match[1] ?? "0", 10);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
