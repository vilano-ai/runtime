# Distribution

This document describes the current runtime distribution model for Vilano `0.1` and the release
artifacts it is moving toward.

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

Each packaged runtime payload now includes a bundled Elixir kernel release, the bundled Bun
runtime, CLI assets, worker assets, and an `install-manifest.json` describing the installed
version's protocol/schema compatibility.

The repo also includes a dedicated release-install smoke path:

```bash
bun run smoke:release-install
```

That path installs the built artifact into a clean root using the generated `install.sh`, then
verifies that the installed runtime can start the daemon and complete a real workflow.

## Cloudflare Front Door

This repo now includes a thin Cloudflare Worker under
[`deploy/cloudflare/runtime-installer`](../deploy/cloudflare/runtime-installer).

That Worker serves:

- `https://runtime.vilano.ai/install.sh`
- `https://runtime.vilano.ai/release.json`

It does not proxy the large runtime tarballs. The generated `release.json` points directly at
GitHub Releases for artifact download.

Sync the generated assets into the Worker before deployment:

```bash
bun run build:release
bun run sync:installer-worker
```

The tag-based release workflow publishes the GitHub release assets first, then deploys the Worker
so the served `release.json` always points at live artifacts.

## Install / Update Direction

The installer and updater operate only on:

- versioned runtime payloads under `installs/`
- launchers under `bin/`
- mutable daemon/database/artifact state under `state/`

They should not treat the installed package contents as mutable runtime state.

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
  "schemaVersion": 9,
  "schemaMin": 9,
  "schemaMax": 9,
  "bundleVersion": "cli-0.1.0-runtime-0.1.0-protocol-1",
  "bundleContentHash": "abcd1234",
  "supportedWorkerRuntimes": ["bun"],
  "platform": {
    "os": "darwin",
    "arch": "arm64"
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

The remote installer/update entrypoint should eventually consume a release metadata document served
from the Vilano release endpoint.

Current shape:

```json
{
  "manifestVersion": 1,
  "latest": "0.1.0",
  "channels": {
    "stable": "0.1.0",
    "preview": "0.2.0-beta.1"
  },
  "releases": {
    "0.1.0": {
      "version": "0.1.0",
      "channel": "stable",
      "protocolVersion": 1,
      "schemaMin": 9,
      "schemaMax": 9,
      "supportedWorkerRuntimes": ["bun"],
      "releasedAt": "2026-03-10T12:00:00.000Z",
      "artifacts": {
        "darwin-arm64": {
          "url": "https://github.com/vilano-ai/runtime/releases/download/v0.1.0/vilano-v0.1.0-darwin-arm64.tar.gz",
          "sha256": "..."
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

The current updater surface uses the same metadata contract and install layout for:

- release discovery (`vilano update --check`)
- artifact install and activation (`vilano update`)
- managed-version rollback (`vilano rollback`)

The authoritative TypeScript definitions for both local install metadata and remote release
metadata live in [cli/src/distribution-contract.ts](/Users/mcl0vin/Documents/Code/runtime/cli/src/distribution-contract.ts).
