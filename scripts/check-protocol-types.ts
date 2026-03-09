import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateProtocolTypes } from "./generate-protocol-types.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const GENERATED_DIR = path.join(ROOT, "protocol", "v1", "generated");
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-protocol-"));

try {
  await generateProtocolTypes(tempDir);
  await assertFileMatches("worker.ts");
  await assertFileMatches("control.ts");
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

async function assertFileMatches(fileName: string): Promise<void> {
  const current = await fs.readFile(path.join(GENERATED_DIR, fileName), "utf8");
  const regenerated = await fs.readFile(path.join(tempDir, fileName), "utf8");

  if (current !== regenerated) {
    throw new Error(
      `Generated protocol types are out of date for ${fileName}. Run \`bun run generate:protocol\` and commit the result.`
    );
  }
}
