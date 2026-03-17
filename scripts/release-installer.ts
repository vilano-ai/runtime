import type {
  ReleaseArtifactMetadata,
  ReleaseMetadataManifest,
  ReleaseVersionMetadata,
} from "../cli/src/distribution-contract.ts";

export function renderInstallScript(manifest: ReleaseMetadataManifest): string {
  const latest = manifest.latest;
  const stableTarget = manifest.channels.stable ?? "";
  const previewTarget = manifest.channels.preview ?? "";
  const releaseCases = Object.values(manifest.releases)
    .sort((left, right) => left.version.localeCompare(right.version))
    .map((release) => renderReleaseCase(release))
    .join("\n");

  return `#!/usr/bin/env bash
set -euo pipefail

DEFAULT_INSTALL_ROOT="$HOME/.vilano"
INSTALL_ROOT="\${VILANO_INSTALL_ROOT:-$DEFAULT_INSTALL_ROOT}"
STATE_ROOT="\${VILANO_HOME:-$INSTALL_ROOT/state}"
SELECTED_CHANNEL="\${VILANO_RELEASE_CHANNEL:-stable}"
MANIFEST_LATEST=${shellQuote(latest)}
STABLE_TARGET=${shellQuote(stableTarget)}
PREVIEW_TARGET=${shellQuote(previewTarget)}

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

resolve_selected_version() {
  local selected_version="$MANIFEST_LATEST"

  case "$SELECTED_CHANNEL" in
    stable)
      if [ -n "$STABLE_TARGET" ]; then
        selected_version="$STABLE_TARGET"
      fi
      ;;
    preview)
      if [ -n "$PREVIEW_TARGET" ]; then
        selected_version="$PREVIEW_TARGET"
      fi
      ;;
    *)
      echo "Unsupported release channel: $SELECTED_CHANNEL" >&2
      exit 1
      ;;
  esac

  printf '%s\\n' "$selected_version"
}

select_release() {
  PLATFORM_KEY="$(detect_platform)"
  SELECTED_VERSION="$(resolve_selected_version)"
  VERSION=""
  CHANNEL=""
  ARTIFACT_URL=""
  ARTIFACT_SHA256=""
  ARTIFACT_MIN_DARWIN_KERNEL=""
  ARTIFACT_MIN_GLIBC_VERSION=""

  case "$SELECTED_VERSION" in
${releaseCases}
    *)
      echo "Release metadata does not contain version $SELECTED_VERSION" >&2
      exit 1
      ;;
  esac

  check_artifact_compatibility
}

verify_installed_payload() {
  local target_root="$1"
  local root_manifest="$target_root/install-manifest.json"
  local runtime_manifest="$target_root/runtime-dist/install-manifest.json"
  local bun_bin="$target_root/bun/bun"
  local cli_entry="$target_root/bin/vilano.ts"
  local kernel_bin="$target_root/runtime-dist/kernel-release/bin/vilano_kernel"
  local bun_worker_entry="$target_root/runtime-dist/worker/bun/src/cli.ts"
  local shared_worker_core="$target_root/runtime-dist/worker/shared/src/core.ts"
  local node_worker_entry="$target_root/runtime-dist/worker/node/src/cli.ts"
  local installed_version
  local supported_worker_runtimes

  if [ ! -f "$root_manifest" ]; then
    echo "Installed Vilano runtime is missing install-manifest.json at $root_manifest" >&2
    exit 1
  fi

  if [ ! -f "$runtime_manifest" ]; then
    echo "Installed Vilano runtime is missing runtime-dist/install-manifest.json at $runtime_manifest" >&2
    exit 1
  fi

  if [ ! -x "$bun_bin" ]; then
    echo "Installed Vilano runtime is missing bundled bun at $bun_bin" >&2
    exit 1
  fi

  if [ ! -f "$cli_entry" ]; then
    echo "Installed Vilano runtime is missing CLI entrypoint at $cli_entry" >&2
    exit 1
  fi

  if [ ! -x "$kernel_bin" ]; then
    echo "Installed Vilano runtime is missing packaged kernel release at $kernel_bin" >&2
    exit 1
  fi

  if [ ! -f "$bun_worker_entry" ]; then
    echo "Installed Vilano runtime is missing bundled Bun worker entrypoint at $bun_worker_entry" >&2
    exit 1
  fi

  if [ ! -f "$shared_worker_core" ]; then
    echo "Installed Vilano runtime is missing shared worker core at $shared_worker_core" >&2
    exit 1
  fi

  if ! installed_version="$("$bun_bin" -e 'const fs = require("node:fs"); const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(manifest.runtimeVersion ?? ""));' "$runtime_manifest")"; then
    echo "Installed Vilano runtime manifest could not be read from $runtime_manifest" >&2
    exit 1
  fi

  if ! supported_worker_runtimes="$("$bun_bin" -e 'const fs = require("node:fs"); const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const values = Array.isArray(manifest.supportedWorkerRuntimes) ? manifest.supportedWorkerRuntimes : []; process.stdout.write(values.join(","));' "$runtime_manifest")"; then
    echo "Installed Vilano runtime worker support could not be read from $runtime_manifest" >&2
    exit 1
  fi

  if [ "$installed_version" != "$VERSION" ]; then
    echo "Installed Vilano runtime version mismatch: expected $VERSION, got $installed_version" >&2
    exit 1
  fi

  case ",$supported_worker_runtimes," in
    *,node,*)
      if [ ! -f "$node_worker_entry" ]; then
        echo "Installed Vilano runtime declares Node worker support but is missing node worker entrypoint at $node_worker_entry" >&2
        exit 1
      fi
      ;;
  esac
}

path_contains_dir() {
  case ":$PATH:" in
    *:"$1":*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

select_release

TMP_DIR="$(mktemp -d)"
ARCHIVE_PATH="$TMP_DIR/vilano.tar.gz"
STAGING_DIR="$TMP_DIR/staging"
TARGET_ROOT="$INSTALL_ROOT/installs/$VERSION"
CURRENT_LINK="$INSTALL_ROOT/current"
BIN_DIR="$INSTALL_ROOT/bin"
INSTALL_STATE_FILE="$INSTALL_ROOT/install-state.json"
PREVIOUS_VERSION=""
LAUNCHER_CMD="vilano"
BUNDLED_BUN="$CURRENT_LINK/bun/bun"

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
verify_installed_payload "$TARGET_ROOT"

ln -sfn "$TARGET_ROOT" "$CURRENT_LINK"

cat > "$BIN_DIR/vilano" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CURRENT_ROOT="$INSTALL_ROOT/current"
BUN_BIN="$CURRENT_ROOT/bun/bun"
export VILANO_INSTALL_ROOT="${"${"}VILANO_INSTALL_ROOT:-$INSTALL_ROOT}"
export VILANO_HOME="${"${"}VILANO_HOME:-$INSTALL_ROOT/state}"
if [ ! -x "$BUN_BIN" ]; then
  echo "Vilano install is missing bundled bun at $BUN_BIN" >&2
  exit 1
fi
exec "$BUN_BIN" "$CURRENT_ROOT/bin/vilano.ts" "$@"
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
  "currentVersion": "$VERSION",
  "previousVersion": $PREVIOUS_VERSION_JSON,
  "channel": "$CHANNEL",
  "updatedAt": "$UPDATED_AT"
}
EOF

echo "Vilano $VERSION ($CHANNEL) installed to $INSTALL_ROOT"
if path_contains_dir "$BIN_DIR"; then
  echo "Run 'vilano version' to verify the install."
else
  LAUNCHER_CMD="$BIN_DIR/vilano"
  echo "Run '$BIN_DIR/vilano version' to verify the install."
  echo "To use 'vilano' directly in this shell, run:"
  printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
fi
echo "Bun 1.3.10+ is required for 'bun add @vilano/runtime' and for authoring Vilano Runtime projects."
echo "After Bun is installed and 'vilano' is on PATH, create a runnable starter project with:"
echo "  mkdir vilano-starter && cd vilano-starter"
echo "  vilano init . --starter"
echo "  bun add @vilano/runtime"
echo "  vilano project add . --name vilano-starter"
echo "  vilano run start vilano-starter/reviewCoordinator --input '{\"repoId\":\"repo_123\",\"note\":\"Ship 0.1\"}'"
`;
}

function renderReleaseCase(release: ReleaseVersionMetadata): string {
  const artifactCases = Object.entries(release.artifacts)
    .map(([platformKey, artifact]) => renderArtifactCase(platformKey, artifact))
    .join("\n");

  return [
    `    ${shellQuote(release.version)})`,
    `      VERSION=${shellQuote(release.version)}`,
    `      CHANNEL=${shellQuote(release.channel)}`,
    '      case "$PLATFORM_KEY" in',
    artifactCases,
    '        *)',
    '          echo "No Vilano release artifact available for $PLATFORM_KEY in version $SELECTED_VERSION" >&2',
    "          exit 1",
    "          ;;",
    "      esac",
    "      ;;",
  ].join("\n");
}

function renderArtifactCase(platformKey: string, artifact: ReleaseArtifactMetadata): string {
  return [
    `        ${shellQuote(platformKey)})`,
    `          ARTIFACT_URL=${shellQuote(artifact.url)}`,
    `          ARTIFACT_SHA256=${shellQuote(artifact.sha256)}`,
    `          ARTIFACT_MIN_DARWIN_KERNEL=${shellQuote(String(artifact.compatibility.minimumDarwinKernelMajor ?? ""))}`,
    `          ARTIFACT_MIN_GLIBC_VERSION=${shellQuote(artifact.compatibility.minimumGlibcVersion ?? "")}`,
    "          ;;",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\"'\"'`)}'`;
}
