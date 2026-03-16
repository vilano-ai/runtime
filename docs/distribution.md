# Distribution

This document describes the current distribution model for Vilano Runtime in `0.1`.

## Install Layout

Vilano separates installed software from mutable runtime state.

Default layout:

```text
~/.vilano/
  bin/
    vilano
  installs/
    <version>/
  cache/
  state/
    runtime.sqlite
    daemon.json
    daemon-auth.json
    execution/
    artifacts/
```

Meanings:

- `bin/`
  - stable launcher entrypoints
- `installs/`
  - versioned, immutable runtime payloads
- `cache/`
  - disposable installer/update cache
- `state/`
  - mutable runtime home (`VILANO_HOME` by default)

## Environment Variables

- `VILANO_HOME`
  - mutable runtime state directory
  - defaults to `~/.vilano/state`
- `VILANO_INSTALL_ROOT`
  - install root for packaged/runtime assets
  - defaults to the parent install root implied by `VILANO_HOME`, or `~/.vilano`
- `VILANO_EXECUTION_HOME`
  - optional override for execution/workspace state
  - defaults to `<VILANO_HOME>/execution`

## Current Release Tooling

The repo now includes a release-artifact build path:

```bash
bun run build:release
```

That command emits:

- `dist/release/vilano-v<version>-<platform>.tar.gz`
- `dist/release/release.json`
- `dist/release/SHA256SUMS`
- `dist/release/install.sh`

The generated installer installs the selected runtime into the managed layout described above,
creates the stable launcher under `bin/`, and writes install state for `vilano update` /
`vilano rollback`.

The public installer defaults to the stable channel, just like `vilano update`. Alternate release
channels are selected with `VILANO_RELEASE_CHANNEL`.

Each packaged runtime payload now includes a bundled Elixir kernel release, the bundled Bun
runtime, CLI assets, worker assets, and an `install-manifest.json` describing the installed
version's protocol/schema compatibility.

The repo also includes a dedicated release-install smoke path:

```bash
bun run smoke:release-install
```

That path installs the built artifact into a clean root using the generated `install.sh`, verifies
the launcher output and `PATH` guidance, runs `doctor`, checks `vilano update --check`, proves the
bundled Bun worker can start without host Bun on `PATH`, starts the daemon, and completes a real
workflow with inspect/replay coverage.

`smoke:release-install` validates the current `dist/release/` directory as-is. Use `build:release`
to prepare a fresh local bundle or `merge:release` to validate an assembled multi-platform bundle.

For a multi-platform release bundle assembled from per-platform outputs, run:

```bash
VILANO_RELEASE_INPUT_DIR=/path/to/release-input bun run merge:release
bun run verify:release
```

`verify:release` checks that the assembled `release.json` and `install.sh` agree, and that the
bundle contains both supported platform artifacts before publication.

## Cloudflare Front Door

This repo now includes a thin Cloudflare Worker under
[`deploy/cloudflare/runtime-installer`](../deploy/cloudflare/runtime-installer).

That Worker serves:

- `https://runtime.vilano.ai/install.sh`
- `https://runtime.vilano.ai/release.json`

The Worker serves the installer script and release metadata. The generated `release.json` points
directly at GitHub Releases for artifact download.

Sync the generated assets into the Worker before deployment:

```bash
VILANO_RELEASE_INPUT_DIR=/path/to/release-input bun run merge:release
bun run verify:release
bun run sync:installer-worker
```

That sync step should use the assembled multi-platform `dist/release/` output, not a single-platform
`build:release` directory from one machine.

The tag-based release workflow publishes the GitHub release assets first, verifies the assembled
bundle and release notes, then deploys the Worker so the served `release.json` always points at
live artifacts.

## Install / Update Direction

The installer and updater operate only on:

- versioned runtime payloads under `installs/`
- launchers under `bin/`
- mutable daemon/database/artifact state under `state/`

They should not treat the installed package contents as mutable runtime state.

The installer writes the managed launcher to `<install-root>/bin/vilano`. If that directory is not
already on `PATH`, the installer prints the exact command to verify the install and the `export
PATH=...` snippet needed for direct `vilano` usage.

## Runtime Install Manifest

Each packaged runtime payload should carry an `install-manifest.json` at the root of the installed
version.

Current contract:

```json
{
  "manifestVersion": 1,
  "kind": "runtime-install",
  "cliVersion": "0.1.0",
  "runtimeVersion": "0.1.0",
  "protocolVersion": 1,
  "schemaVersion": 13,
  "schemaMin": 13,
  "schemaMax": 13,
  "bundleVersion": "cli-0.1.0-runtime-0.1.0-protocol-1",
  "bundleContentHash": "abcd1234",
  "supportedWorkerRuntimes": ["bun"],
  "platform": {
    "os": "darwin",
    "arch": "arm64"
  },
  "compatibility": {
    "platformKey": "darwin-arm64",
    "os": "darwin",
    "arch": "arm64",
    "minimumDarwinKernelMajor": 25
  },
  "build": {
    "source": "github-actions",
    "osRelease": "25.0.0"
  },
  "generatedAt": "2026-03-10T12:00:00.000Z"
}
```

This manifest is the local source of truth for:

- installed runtime version
- protocol/schema compatibility of the installed payload
- supported bundled worker runtimes
- platform identity for the artifact that was installed

`vilano version` reports from this manifest, and install/update flows validate it before switching
the active launcher.

Current CLI support:

- `vilano version`
  - reports the local install manifest and current packaged/runtime state
- `vilano update --check`
  - fetches release metadata, selects the target channel, and reports whether a newer runtime is
    available for the current platform
- `vilano update`
  - downloads the selected artifact, verifies it, installs it under `installs/`, and switches the
    managed launcher
- `vilano rollback`
  - switches the managed launcher back to the previous installed version recorded in install state

## Release Metadata

The public installer and updater both consume a release metadata document served from the Vilano
release endpoint.

Current shape:

```json
{
  "manifestVersion": 1,
  "latest": "0.1.0",
  "channels": {
    "stable": "0.1.0"
  },
  "releases": {
    "0.1.0": {
      "version": "0.1.0",
      "channel": "stable",
      "protocolVersion": 1,
      "schemaMin": 13,
      "schemaMax": 13,
      "supportedWorkerRuntimes": ["bun"],
      "releasedAt": "2026-03-10T12:00:00.000Z",
      "artifacts": {
        "darwin-arm64": {
          "url": "https://github.com/vilano-ai/runtime/releases/download/v0.1.0/vilano-v0.1.0-darwin-arm64.tar.gz",
          "sha256": "...",
          "compatibility": {
            "platformKey": "darwin-arm64",
            "os": "darwin",
            "arch": "arm64",
            "minimumDarwinKernelMajor": 25
          }
        }
      }
    }
  }
}
```

That document is the contract for:

- `curl | bash` installation
- `vilano update`
- `vilano rollback`
- release-channel selection

The current release surface uses the same metadata contract and install layout for:

- release discovery during install (`install.sh`)
- release discovery (`vilano update --check`)
- artifact install and activation (`vilano update`)
- managed-version rollback (`vilano rollback`)

The authoritative TypeScript definitions for both local install metadata and remote release
metadata live in [cli/src/distribution-contract.ts](/Users/mcl0vin/Documents/Code/runtime/cli/src/distribution-contract.ts).
