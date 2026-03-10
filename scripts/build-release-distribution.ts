import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import {
  RELEASE_METADATA_VERSION,
  type ReleaseArtifactMetadata,
  type ReleaseChannel,
  type ReleaseMetadataManifest,
  type RuntimeInstallManifest,
} from "../cli/src/distribution-contract.ts";
import { copyPackageDependencyTree } from "../cli/src/dependency-tree.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI_DIR = path.join(ROOT, "cli");
const DIST_DIR = path.join(ROOT, "dist", "release");

const PLATFORM_KEY = resolvePlatformKey();
const RELEASE_CHANNEL = resolveReleaseChannel();

await fs.rm(DIST_DIR, { recursive: true, force: true });
await fs.mkdir(DIST_DIR, { recursive: true });

const cliPackage = await readJson(path.join(CLI_DIR, "package.json"));
const runtimeVersion = cliPackage.version ?? "0.0.0";
const artifactFileName = `vilano-v${runtimeVersion}-${PLATFORM_KEY}.tar.gz`;
const artifactRootName = `vilano-v${runtimeVersion}-${PLATFORM_KEY}`;
const artifactPath = path.join(DIST_DIR, artifactFileName);
const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "vilano-release-build-"));

try {
  const artifactRoot = path.join(stagingDir, artifactRootName);
  await copyCliRuntime(artifactRoot);
  await copyBundledBun(artifactRoot);
  await copyPackageDependencyTree(CLI_DIR, artifactRoot);
  await copyInstallManifest(artifactRoot);
  await createTarball(stagingDir, artifactRootName, artifactPath);

  const sha256 = await hashFileSha256(artifactPath);
  const stat = await fs.stat(artifactPath);
  const releaseMetadata = await buildReleaseMetadata({
    runtimeVersion,
    releaseChannel: RELEASE_CHANNEL,
    artifactFileName,
    sha256,
    sizeBytes: stat.size,
  });

  await fs.writeFile(
    path.join(DIST_DIR, "release.json"),
    `${JSON.stringify(releaseMetadata, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(DIST_DIR, "SHA256SUMS"),
    `${sha256}  ${artifactFileName}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(DIST_DIR, "install.sh"),
    renderInstallScript(releaseMetadata),
    "utf8"
  );
  await fs.chmod(path.join(DIST_DIR, "install.sh"), 0o755);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        version: runtimeVersion,
        channel: RELEASE_CHANNEL,
        platform: PLATFORM_KEY,
        artifactPath,
        releaseMetadataPath: path.join(DIST_DIR, "release.json"),
        installerPath: path.join(DIST_DIR, "install.sh"),
      },
      null,
      2
    )}\n`
  );
} finally {
  await fs.rm(stagingDir, { recursive: true, force: true });
}

async function copyCliRuntime(targetRoot: string): Promise<void> {
  await fs.mkdir(targetRoot, { recursive: true });
  for (const entry of ["bin", "src", "runtime-dist", "README.md", "LICENSE", "package.json"]) {
    await fs.cp(path.join(CLI_DIR, entry), path.join(targetRoot, entry), {
      recursive: true,
      force: true,
    });
  }
}

async function copyBundledBun(targetRoot: string): Promise<void> {
  const bunDir = path.join(targetRoot, "bun");
  const targetPath = path.join(bunDir, "bun");
  await fs.mkdir(bunDir, { recursive: true });
  await fs.copyFile(process.execPath, targetPath);
  await fs.chmod(targetPath, 0o755);
}

async function copyInstallManifest(targetRoot: string): Promise<void> {
  const installManifestPath = path.join(targetRoot, "runtime-dist", "install-manifest.json");
  await fs.copyFile(installManifestPath, path.join(targetRoot, "install-manifest.json"));
}

async function createTarball(sourceDir: string, rootName: string, targetPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-czf", targetPath, "-C", sourceDir, rootName], {
      stdio: "ignore",
      env: process.env,
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Failed to build release artifact tarball (exit ${code ?? 1})`));
    });
  });
}

async function buildReleaseMetadata(input: {
  runtimeVersion: string;
  releaseChannel: ReleaseChannel;
  artifactFileName: string;
  sha256: string;
  sizeBytes: number;
}): Promise<ReleaseMetadataManifest> {
  const baseUrl = resolveReleaseBaseUrl();
  const installManifest = (await readJson(
    path.join(CLI_DIR, "runtime-dist", "install-manifest.json")
  )) as RuntimeInstallManifest;
  const artifact: ReleaseArtifactMetadata = {
    url: resolveArtifactUrl(baseUrl, input.artifactFileName),
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    compatibility: installManifest.compatibility,
  };

  return {
    manifestVersion: RELEASE_METADATA_VERSION,
    latest: input.runtimeVersion,
    channels: {
      [input.releaseChannel]: input.runtimeVersion,
    },
    releases: {
      [input.runtimeVersion]: {
        version: input.runtimeVersion,
        channel: input.releaseChannel,
        protocolVersion: installManifest.protocolVersion,
        schemaMin: installManifest.schemaMin,
        schemaMax: installManifest.schemaMax,
        supportedWorkerRuntimes: installManifest.supportedWorkerRuntimes,
        releasedAt: new Date().toISOString(),
        artifacts: {
          [PLATFORM_KEY]: artifact,
        },
      },
    },
  };
}

function resolveArtifactUrl(baseUrl: string, artifactFileName: string): string {
  if (baseUrl.startsWith("file://")) {
    return new URL(artifactFileName, ensureTrailingSlash(baseUrl)).toString();
  }

  return `${ensureNoTrailingSlash(baseUrl)}/${artifactFileName}`;
}

function resolveReleaseBaseUrl(): string {
  if (process.env.VILANO_RELEASE_BASE_URL) {
    return process.env.VILANO_RELEASE_BASE_URL;
  }

  return new URL(`file://${DIST_DIR}/`).toString();
}

function resolvePlatformKey(): string {
  const actual = `${process.platform}-${os.arch()}`;
  const expected = process.env.VILANO_RELEASE_PLATFORM;

  if (expected && expected !== actual) {
    throw new Error(
      `Release platform mismatch: expected ${expected} from VILANO_RELEASE_PLATFORM, got ${actual} from the current runner.`
    );
  }

  return actual;
}

function renderInstallScript(manifest: ReleaseMetadataManifest): string {
  const latest = manifest.releases[manifest.latest];
  if (!latest) {
    throw new Error(`Missing latest release ${manifest.latest} in release metadata`);
  }

  const artifactCases = Object.entries(latest.artifacts)
    .map(([platformKey, artifact]) => {
      return [
        `  ${shellQuote(platformKey)})`,
        `    ARTIFACT_URL=${shellQuote(artifact.url)}`,
        `    ARTIFACT_SHA256=${shellQuote(artifact.sha256)}`,
        `    ARTIFACT_MIN_DARWIN_KERNEL=${shellQuote(String(artifact.compatibility.minimumDarwinKernelMajor ?? ""))}`,
        `    ARTIFACT_MIN_GLIBC_VERSION=${shellQuote(artifact.compatibility.minimumGlibcVersion ?? "")}`,
        "    ;;",
      ].join("\n");
    })
    .join("\n");

  return `#!/usr/bin/env bash
set -euo pipefail

DEFAULT_INSTALL_ROOT="$HOME/.vilano"
INSTALL_ROOT="\${VILANO_INSTALL_ROOT:-$DEFAULT_INSTALL_ROOT}"
STATE_ROOT="\${VILANO_HOME:-$INSTALL_ROOT/state}"
VERSION=${shellQuote(latest.version)}
CHANNEL=${shellQuote(latest.channel)}

detect_platform() {
  local os
  local arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *)
      echo "Unsupported operating system: $os" >&2
      exit 1
      ;;
  esac

  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *)
      echo "Unsupported architecture: $arch" >&2
      exit 1
      ;;
  esac

  printf '%s-%s\\n' "$os" "$arch"
}

compute_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi

  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $2}'
    return
  fi

  echo "No SHA-256 command found (tried sha256sum, shasum, openssl)." >&2
  exit 1
}

version_gte() {
  local left="$1"
  local right="$2"
  local left_part
  local right_part

  while [ -n "$left" ] || [ -n "$right" ]; do
    left_part="\${left%%.*}"
    right_part="\${right%%.*}"

    if [ "$left" = "$left_part" ]; then
      left=""
    else
      left="\${left#*.}"
    fi

    if [ "$right" = "$right_part" ]; then
      right=""
    else
      right="\${right#*.}"
    fi

    left_part="\${left_part:-0}"
    right_part="\${right_part:-0}"

    if [ "$left_part" -gt "$right_part" ]; then
      return 0
    fi

    if [ "$left_part" -lt "$right_part" ]; then
      return 1
    fi
  done

  return 0
}

check_artifact_compatibility() {
  if [ -n "$ARTIFACT_MIN_DARWIN_KERNEL" ]; then
    local current_kernel
    current_kernel="$(uname -r | cut -d. -f1)"
    if [ "\${current_kernel:-0}" -lt "$ARTIFACT_MIN_DARWIN_KERNEL" ]; then
      echo "Vilano runtime requires Darwin kernel $ARTIFACT_MIN_DARWIN_KERNEL+, current host is $current_kernel" >&2
      exit 1
    fi
  fi

  if [ -n "$ARTIFACT_MIN_GLIBC_VERSION" ]; then
    if ! command -v getconf >/dev/null 2>&1; then
      echo "Vilano runtime requires glibc $ARTIFACT_MIN_GLIBC_VERSION+, but getconf is unavailable to verify compatibility" >&2
      exit 1
    fi

    local glibc_line
    local current_glibc
    glibc_line="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
    current_glibc="$(printf '%s' "$glibc_line" | awk '{print $2}')"

    if [ -z "$current_glibc" ]; then
      echo "Vilano runtime requires glibc $ARTIFACT_MIN_GLIBC_VERSION+, but glibc could not be detected on this host" >&2
      exit 1
    fi

    if ! version_gte "$current_glibc" "$ARTIFACT_MIN_GLIBC_VERSION"; then
      echo "Vilano runtime requires glibc $ARTIFACT_MIN_GLIBC_VERSION+, current host is $current_glibc" >&2
      exit 1
    fi
  fi
}

PLATFORM_KEY="$(detect_platform)"
ARTIFACT_URL=""
ARTIFACT_SHA256=""
ARTIFACT_MIN_DARWIN_KERNEL=""
ARTIFACT_MIN_GLIBC_VERSION=""
case "$PLATFORM_KEY" in
${artifactCases}
  *)
    echo "No Vilano release artifact available for $PLATFORM_KEY" >&2
    exit 1
    ;;
esac

check_artifact_compatibility

TMP_DIR="$(mktemp -d)"
ARCHIVE_PATH="$TMP_DIR/vilano.tar.gz"
STAGING_DIR="$TMP_DIR/staging"
TARGET_ROOT="$INSTALL_ROOT/installs/$VERSION"
CURRENT_LINK="$INSTALL_ROOT/current"
BIN_DIR="$INSTALL_ROOT/bin"
INSTALL_STATE_FILE="$INSTALL_ROOT/install-state.json"
PREVIOUS_VERSION=""

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$INSTALL_ROOT/installs" "$BIN_DIR" "$INSTALL_ROOT/cache" "$STATE_ROOT"

if [ -L "$CURRENT_LINK" ]; then
  PREVIOUS_VERSION="$(basename "$(readlink "$CURRENT_LINK")")"
fi

echo "Downloading Vilano $VERSION for $PLATFORM_KEY..."
curl -fsSL "$ARTIFACT_URL" -o "$ARCHIVE_PATH"

ACTUAL_SHA256="$(compute_sha256 "$ARCHIVE_PATH")"
if [ "$ACTUAL_SHA256" != "$ARTIFACT_SHA256" ]; then
  echo "Checksum mismatch for downloaded Vilano artifact." >&2
  echo "Expected: $ARTIFACT_SHA256" >&2
  echo "Actual:   $ACTUAL_SHA256" >&2
  exit 1
fi

mkdir -p "$STAGING_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$STAGING_DIR"

EXTRACTED_ROOT="$STAGING_DIR"
SUBDIR_COUNT="$(find "$STAGING_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
FILE_COUNT="$(find "$STAGING_DIR" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')"
if [ "$SUBDIR_COUNT" = "1" ] && [ "$FILE_COUNT" = "0" ]; then
  EXTRACTED_ROOT="$(find "$STAGING_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
fi

rm -rf "$TARGET_ROOT"
mv "$EXTRACTED_ROOT" "$TARGET_ROOT"

ln -sfn "$TARGET_ROOT" "$CURRENT_LINK"

cat > "$BIN_DIR/vilano" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
INSTALL_ROOT="\$(cd "\$SCRIPT_DIR/.." && pwd)"
CURRENT_ROOT="\$INSTALL_ROOT/current"
BUN_BIN="\$CURRENT_ROOT/bun/bun"
export VILANO_INSTALL_ROOT="\${VILANO_INSTALL_ROOT:-\$INSTALL_ROOT}"
export VILANO_HOME="\${VILANO_HOME:-\$INSTALL_ROOT/state}"
if [ ! -x "\$BUN_BIN" ]; then
  echo "Vilano install is missing bundled bun at \$BUN_BIN" >&2
  exit 1
fi
exec "\$BUN_BIN" "\$CURRENT_ROOT/bin/vilano.ts" "\$@"
EOF
chmod 755 "$BIN_DIR/vilano"

UPDATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
PREVIOUS_VERSION_JSON="null"
if [ -n "$PREVIOUS_VERSION" ]; then
  PREVIOUS_VERSION_JSON="\\\"$PREVIOUS_VERSION\\\""
fi

cat > "$INSTALL_STATE_FILE" <<EOF
{
  "version": 1,
  "currentVersion": ${jsonQuote(latest.version)},
  "previousVersion": $PREVIOUS_VERSION_JSON,
  "channel": ${jsonQuote(latest.channel)},
  "updatedAt": "$UPDATED_AT"
}
EOF

echo "Vilano $VERSION installed to $INSTALL_ROOT"
echo "Run '$BIN_DIR/vilano version' to verify the install."
`;
}

function jsonQuote(value: string): string {
  return JSON.stringify(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function ensureNoTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function hashFileSha256(filePath: string): Promise<string> {
  const digest = crypto.createHash("sha256");
  digest.update(await fs.readFile(filePath));
  return digest.digest("hex");
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

function resolveReleaseChannel(): ReleaseChannel {
  const candidate = process.env.VILANO_RELEASE_CHANNEL ?? "stable";
  if (candidate !== "stable" && candidate !== "preview") {
    throw new Error(`Unsupported release channel: ${candidate}`);
  }

  return candidate;
}
