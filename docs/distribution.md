# Distribution

This document describes the intended runtime distribution model for Vilano `0.1` and later.

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

## Current State

Today the repo still has a developer-oriented packaging path, but the runtime path helpers and
materialization logic now align with the install/state split above. That keeps the `0.1`
distribution work pointed at a stable filesystem contract.

## Intended Release Direction

The installer and updater should eventually operate only on:

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
  "supportedWorkerRuntimes": ["bun", "node"],
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

`vilano version` should report from this manifest. Future installer/update flows should validate it
before switching the active launcher.

## Release Metadata

The remote installer/update entrypoint should eventually consume a release metadata document served
from the Vilano release endpoint.

Shape:

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
        "macos-aarch64": {
          "url": "https://github.com/vilano-ai/runtime/releases/download/v0.1.0/vilano-v0.1.0-macos-aarch64.tar.gz",
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

The authoritative TypeScript definitions for both local install metadata and remote release
metadata live in [cli/src/distribution-contract.ts](/Users/mcl0vin/Documents/Code/runtime/cli/src/distribution-contract.ts).
