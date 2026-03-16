# Release Notes Guide

Vilano releases should be explicit about compatibility. The runtime has multiple moving parts:

- CLI
- BEAM kernel
- worker runtime(s)
- manifest contract
- protocol contract

Release notes should also make the product thesis obvious: Vilano is a durable runtime for
building agent systems, not a generic background job runner.

Every release note should include a short compatibility section.

## Required Sections

### Runtime

- runtime version
- release type
- supported operating systems for that release

### Runtime Surface

- supported path
- additional runtime lanes, if any

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

Do not ship release notes that imply broader support than the current support matrix.
Do call out the agent-runtime primitives that are actually part of the release surface: workflows,
durable keyed services, supervision, mailbox control, passivation, discovery, and pubsub where
applicable.

## Release Checklist

Before publishing a public OSS release:

1. Run `bun run check:launch`.
2. Run the Launch Gate workflow cleanly across both supported operating systems.
3. Run `bun run build:release`.
4. Merge platform artifacts with `VILANO_RELEASE_INPUT_DIR=/path/to/release-input bun run merge:release`.
5. Run `bun run verify:release`.
6. Run `bun run smoke:release-install`.
7. Validate one clean-machine install path outside the repo checkout.
8. Confirm the release notes match:
   - supported platforms
   - supported worker runtimes
   - protocol/schema version
   - runtime posture
9. Confirm `runtime.vilano.ai/install.sh` and `runtime.vilano.ai/release.json` point at the tagged
   GitHub Release assets.

Release notes should live in `docs/release-notes/vX.Y.Z.md`, and the tag workflow publishes that
file as the GitHub Release body.

## Clean-Machine Validation

The minimum pre-release validation on a machine without a repo checkout should be:

```bash
curl -fsSL https://runtime.vilano.ai/install.sh | bash
~/.vilano/bin/vilano version
~/.vilano/bin/vilano doctor
~/.vilano/bin/vilano update --check
```

The public installer and `vilano update` both default to the stable channel. Alternate channels
are selected with `VILANO_RELEASE_CHANNEL`.

The local pre-release gate should be:

```bash
bun run check:launch
```

Then register a real project with an explicit `vilano.manifest.json`, start the daemon, run one
workflow, and inspect/replay the result.

When `runtime.vilano.ai` is live, verify the public endpoints directly:

```bash
bun scripts/verify-release-publication.ts \
  --release-manifest https://runtime.vilano.ai/release.json \
  --installer https://runtime.vilano.ai/install.sh \
  --channel stable \
  --expected-version 0.1.0 \
  --platform darwin-arm64 \
  --platform linux-x64 \
  --artifact-url-prefix https://github.com/vilano-ai/runtime/releases/download/v0.1.0/ \
  --expected-notes-url https://github.com/vilano-ai/runtime/blob/v0.1.0/docs/release-notes/v0.1.0.md
```
