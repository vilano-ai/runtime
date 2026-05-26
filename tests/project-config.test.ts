import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyProjectConfigForCwd, loadProjectConfigForCwd } from "../cli/src/project-config.ts";

test("loadProjectConfigForCwd picks the nearest vilano.toml", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-project-config-"));
  const appRoot = path.join(root, "app");
  const nestedRoot = path.join(appRoot, "nested");
  const workDir = path.join(nestedRoot, "src");

  try {
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(appRoot, "vilano.toml"), "[runtime]\nport = 4141\n", "utf8");
    await fs.writeFile(path.join(nestedRoot, "vilano.toml"), "[runtime]\nport = 5151\n", "utf8");

    const loaded = await loadProjectConfigForCwd(workDir);

    expect(loaded).not.toBeNull();
    expect(loaded?.path).toBe(path.join(nestedRoot, "vilano.toml"));
    expect(loaded?.rootDir).toBe(nestedRoot);
    expect(loaded?.config.runtime?.port).toBe(5151);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("applyProjectConfigForCwd maps runtime config into env defaults", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-project-config-"));

  try {
    await fs.writeFile(
      path.join(root, "vilano.toml"),
      [
        "[runtime]",
        "port = 5151",
        'execution_home = ".vilano/execution"',
        "managed_workers = 4",
        'managed_worker_runtime = "bun"',
        'managed_worker_mode = "pooled"',
        "repo_pool_size = 7",
        "lease_duration_seconds = 45",
        "sqlite_busy_timeout_ms = 15000",
      ].join("\n"),
      "utf8"
    );

    const env: NodeJS.ProcessEnv = {};
    await applyProjectConfigForCwd(root, env);

    expect(env.VILANO_KERNEL_PORT).toBe("5151");
    expect(env.VILANO_EXECUTION_HOME).toBe(path.join(root, ".vilano", "execution"));
    expect(env.VILANO_MANAGED_WORKERS).toBe("4");
    expect(env.VILANO_MANAGED_WORKER_RUNTIME).toBe("bun");
    expect(env.VILANO_MANAGED_WORKER_MODE).toBe("pooled");
    expect(env.VILANO_REPO_POOL_SIZE).toBe("7");
    expect(env.VILANO_LEASE_DURATION_SECONDS).toBe("45");
    expect(env.VILANO_SQLITE_BUSY_TIMEOUT_MS).toBe("15000");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("applyProjectConfigForCwd maps storage snapshot config into env defaults", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-project-config-"));

  try {
    await fs.writeFile(
      path.join(root, "vilano.toml"),
      [
        "[storage]",
        'snapshot_excludes = ["logs", "tmp/cache"]',
        "snapshot_include_node_modules = false",
        "prune_run_workspace_ttl_seconds = 3600",
        "prune_event_payload_grace_seconds = 30",
        "exec_capture_max_bytes = 4096",
        "exec_artifact_max_bytes = 8192",
      ].join("\n"),
      "utf8"
    );

    const env: NodeJS.ProcessEnv = {};
    await applyProjectConfigForCwd(root, env);

    expect(env.VILANO_SNAPSHOT_EXCLUDES).toBe(JSON.stringify(["logs", "tmp/cache"]));
    expect(env.VILANO_SNAPSHOT_INCLUDE_NODE_MODULES).toBe("false");
    expect(env.VILANO_PRUNE_RUN_WORKSPACE_TTL_SECONDS).toBe("3600");
    expect(env.VILANO_PRUNE_EVENT_PAYLOAD_GRACE_SECONDS).toBe("30");
    expect(env.VILANO_EXEC_CAPTURE_MAX_BYTES).toBe("4096");
    expect(env.VILANO_EXEC_ARTIFACT_MAX_BYTES).toBe("8192");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadProjectConfigForCwd rejects unsafe storage snapshot excludes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-project-config-"));

  try {
    await fs.writeFile(
      path.join(root, "vilano.toml"),
      ["[storage]", 'snapshot_excludes = ["../outside"]'].join("\n"),
      "utf8"
    );

    await expect(loadProjectConfigForCwd(root)).rejects.toThrow("must not contain . or .. segments");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("applyProjectConfigForCwd loads env files without overriding shell env", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-project-config-"));

  try {
    await fs.writeFile(
      path.join(root, "vilano.toml"),
      ['[project]', 'env_file = [".env", ".env.local"]'].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, ".env"),
      ["API_KEY=from-env", "MODEL=base", 'SHARED="hello\\nworld"'].join("\n"),
      "utf8"
    );
    await fs.writeFile(path.join(root, ".env.local"), ["MODEL=local", "EXTRA=1"].join("\n"), "utf8");

    const env: NodeJS.ProcessEnv = {
      MODEL: "shell",
    };

    await applyProjectConfigForCwd(root, env);

    expect(env.API_KEY).toBe("from-env");
    expect(env.MODEL).toBe("shell");
    expect(env.EXTRA).toBe("1");
    expect(env.SHARED).toBe("hello\nworld");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
