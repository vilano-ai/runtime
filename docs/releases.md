# Release Notes Guide

Vilano releases should be explicit about compatibility. The runtime has multiple moving parts:

- CLI
- BEAM kernel
- worker runtime(s)
- manifest contract
- protocol contract

Every release note should include a short compatibility section.

## Required Sections

### Runtime

- runtime version
- release type (`preview`, `alpha`, etc.)
- supported operating systems for that release

### Support Matrix

- supported path
- preview path(s)
- anything intentionally unsupported

### Protocol

- current protocol version
- whether the protocol changed in this release
- whether a CLI or worker upgrade is required

### Manifest

- current manifest version
- whether the explicit manifest schema changed
- whether cached manifests should be regenerated

### Upgrade Notes

- runtime-home changes
- migration behavior
- worker/runtime compatibility notes
- any manual operator steps

## Current OSS v1 Posture

For the first OSS release, the expected language is:

- Bun CLI: supported
- TypeScript SDK: supported
- BEAM kernel: supported
- Bun worker: supported
- Node worker: preview

Do not ship release notes that imply broader support than the current support matrix.

## Release Checklist

Before publishing a public OSS release:

1. Run the supported CI matrix cleanly.
2. Run `bun run build:release`.
3. Run `bun run smoke:release-install`.
4. Validate one clean-machine install path outside the repo checkout.
5. Confirm the release notes match:
   - supported platforms
   - supported worker runtimes
   - protocol/schema version
   - known limitations
6. Confirm `runtime.vilano.ai/install.sh` and `runtime.vilano.ai/release.json` point at the tagged
   GitHub Release assets.

## Clean-Machine Validation

The minimum pre-release validation on a machine without a repo checkout should be:

```bash
curl -fsSL https://runtime.vilano.ai/install.sh | bash
vilano version
vilano doctor
vilano update --check
```

Then register a real project with an explicit `vilano.manifest.json`, start the daemon, run one
workflow, and inspect/replay the result.
