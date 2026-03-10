import fs from "node:fs/promises";
import path from "node:path";

import {
  RELEASE_METADATA_VERSION,
  type ReleaseChannel,
  type ReleaseMetadataManifest,
  type ReleaseVersionMetadata,
} from "../cli/src/distribution-contract.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const DIST_DIR = path.join(ROOT, "dist", "release");
const INPUT_DIR = process.env.VILANO_RELEASE_INPUT_DIR
  ? path.resolve(process.env.VILANO_RELEASE_INPUT_DIR)
  : DIST_DIR;
const OUTPUT_DIR = process.env.VILANO_RELEASE_OUTPUT_DIR
  ? path.resolve(process.env.VILANO_RELEASE_OUTPUT_DIR)
  : DIST_DIR;

const manifests = await collectReleaseManifests(INPUT_DIR);
if (manifests.length === 0) {
  throw new Error(`No release.json files found under ${INPUT_DIR}`);
}

const merged = mergeReleaseMetadata(manifests);
await fs.mkdir(OUTPUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUTPUT_DIR, "release.json"), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(OUTPUT_DIR, "SHA256SUMS"), await buildChecksums(INPUT_DIR), "utf8");
await fs.writeFile(path.join(OUTPUT_DIR, "install.sh"), renderInstallScript(merged), "utf8");
await fs.chmod(path.join(OUTPUT_DIR, "install.sh"), 0o755);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      inputDir: INPUT_DIR,
      outputDir: OUTPUT_DIR,
      version: merged.latest,
      platforms: Object.keys(merged.releases[merged.latest]?.artifacts ?? {}).sort(),
    },
    null,
    2
  )}\n`
);

async function collectReleaseManifests(rootDir: string): Promise<ReleaseMetadataManifest[]> {
  const files = await collectFiles(rootDir);
  const manifestFiles = files.filter((filePath) => path.basename(filePath) === "release.json");
  const manifests: ReleaseMetadataManifest[] = [];

  for (const filePath of manifestFiles) {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as ReleaseMetadataManifest;
    if (raw.manifestVersion !== RELEASE_METADATA_VERSION) {
      throw new Error(`Unsupported release metadata version in ${filePath}`);
    }
    manifests.push(raw);
  }

  return manifests;
}

function mergeReleaseMetadata(manifests: ReleaseMetadataManifest[]): ReleaseMetadataManifest {
  const first = manifests[0];
  if (!first) {
    throw new Error("No release manifests to merge");
  }

  const latest = first.latest;
  const mergedChannels = { ...first.channels };
  const mergedReleases: Record<string, ReleaseVersionMetadata> = {};

  for (const manifest of manifests) {
    if (manifest.latest !== latest) {
      throw new Error(`Release version mismatch while merging metadata: ${manifest.latest} != ${latest}`);
    }

    for (const [channel, version] of Object.entries(manifest.channels)) {
      if (!version) {
        continue;
      }
      if (mergedChannels[channel as ReleaseChannel] && mergedChannels[channel as ReleaseChannel] !== version) {
        throw new Error(`Release channel mismatch for ${channel}: ${mergedChannels[channel as ReleaseChannel]} != ${version}`);
      }
      mergedChannels[channel as ReleaseChannel] = version;
    }

    for (const [version, release] of Object.entries(manifest.releases)) {
      const existing = mergedReleases[version];
      if (!existing) {
        mergedReleases[version] = {
          ...release,
          artifacts: { ...release.artifacts },
        };
        continue;
      }

      if (
        existing.channel !== release.channel ||
        existing.protocolVersion !== release.protocolVersion ||
        existing.schemaMin !== release.schemaMin ||
        existing.schemaMax !== release.schemaMax ||
        existing.notesUrl !== release.notesUrl ||
        JSON.stringify(existing.supportedWorkerRuntimes) !== JSON.stringify(release.supportedWorkerRuntimes)
      ) {
        throw new Error(`Release metadata mismatch for version ${version}`);
      }

      for (const [platform, artifact] of Object.entries(release.artifacts)) {
        if (existing.artifacts[platform]) {
          throw new Error(`Duplicate artifact entry for ${version}/${platform}`);
        }
        existing.artifacts[platform] = artifact;
      }
    }
  }

  return {
    manifestVersion: RELEASE_METADATA_VERSION,
    latest,
    channels: mergedChannels,
    releases: mergedReleases,
  };
}

async function buildChecksums(rootDir: string): Promise<string> {
  const files = await collectFiles(rootDir);
  const checksumFiles = files.filter((filePath) => path.basename(filePath) === "SHA256SUMS");
  const lines = new Set<string>();

  for (const filePath of checksumFiles) {
    const content = await fs.readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed) {
        lines.add(trimmed);
      }
    }
  }

  return `${Array.from(lines).sort().join("\n")}\n`;
}

async function collectFiles(rootPath: string): Promise<string[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files.sort();
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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CURRENT_ROOT="$(cd "$INSTALL_ROOT/current" && pwd)"
export VILANO_INSTALL_ROOT="\${VILANO_INSTALL_ROOT:-$INSTALL_ROOT}"
export VILANO_HOME="\${VILANO_HOME:-$INSTALL_ROOT/state}"
exec "$CURRENT_ROOT/bun/bun" "$CURRENT_ROOT/bin/vilano.ts" "$@"
EOF
chmod +x "$BIN_DIR/vilano"

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
  return `'${value.replace(/'/gu, `'\"'\"'`)}'`;
}
