# Debut Release Checklist

Use this before cutting the first public Vilano Runtime release.

## Product Story

- [ ] The one-line positioning is consistent across README, website, and release notes.
- [ ] Public copy clearly says "durable runtime for building agent systems" instead of generic workflow/job-runner language.
- [x] Public copy matches the supported release path exactly.
- [x] Public copy stays aligned with the local-first runtime posture.

## Public Docs

- [x] The top-level README points to the first-run walkthrough, support matrix, troubleshooting, and trust model.
- [ ] The first-run walkthrough has been executed exactly as written on a clean machine.
- [ ] The troubleshooting page covers the most likely operator failures.
- [x] The release notes include supported platforms, worker runtimes, protocol/schema versions, and runtime posture.

## Verification

- [x] `bun run check:launch` passes locally on a release candidate.
- [ ] The Launch Gate workflow passes on macOS and Linux.
- [ ] Public clean-machine validation passes against the real installer and release metadata.
- [x] The packaged install path proves inspect/replay and service inspection, not just `version`.
- [ ] `@vilano/runtime` is published and resolves publicly from the intended package registry.

## Manual Launch-Day Checks

- [ ] Install from `runtime.vilano.ai/install.sh` on a clean machine.
- [x] Run `vilano version`, `vilano doctor`, and `vilano update --check`.
- [x] Register a real project with an explicit manifest.
- [x] Run one workflow to completion, inspect it, and replay it.
- [x] Verify rollback / reinstall behavior once.

## Evidence

- [ ] Save links to the green CI run and Launch Gate run.
- [x] Save the exact release notes file used for the release body.
- [x] Save the public `release.json` and `install.sh` verification command and result.

Current evidence:
- [`docs/release-evidence/v0.1.0.md`](/Users/mcl0vin/Documents/Code/runtime/docs/release-evidence/v0.1.0.md)

## Release Call

- [ ] Every remaining limitation is either fixed or explicitly documented.
- [x] The release scope is intentionally smaller than the ambition of the product.
- [ ] The team can explain, in one minute, why this release is credible.
