import path from "node:path";

import {
  buildProjectManifestFile,
  getProjectManifestPath,
} from "../cli/src/project-manifest.ts";
import { validateProjectManifest } from "../cli/src/project-manifest-contract.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const exampleProjectPath = path.join(ROOT, "examples", "bootstrap-demo");

const manifest = await buildProjectManifestFile(exampleProjectPath);
const validation = await validateProjectManifest(manifest, {
  projectPath: exampleProjectPath,
});

if (!validation.ok) {
  throw new Error(
    `Generated manifest does not satisfy protocol/v1/project-manifest.schema.json: ${validation.errors.join("; ")}`
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      manifestPath: getProjectManifestPath(exampleProjectPath),
      manifestVersion: manifest.manifestVersion,
      definitions: {
        workflows: manifest.definitions.workflows.length,
        services: manifest.definitions.services.length,
      },
    },
    null,
    2
  )}\n`
);
