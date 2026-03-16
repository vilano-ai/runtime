# Manifest Guide

Vilano Runtime uses two manifest forms:

- **project manifest**
  - `vilano.manifest.json`
  - explicit project contract
  - validated against [protocol/v1/project-manifest.schema.json](../protocol/v1/project-manifest.schema.json)
- **generated cache**
  - `.vilano/project-manifest.json`
  - local cache derived from project source when no explicit manifest is present

If you are using the packaged install and have not added `~/.vilano/bin` to `PATH`, use
`~/.vilano/bin/vilano` for CLI commands below. For starter or manifest setup without a host Bun
install, use `~/.vilano/current/bun/bun`.

## Manifest Contract

The tracked contract is:

- `manifestVersion`
- `definitions.workflows[]`
- `definitions.services[]`

Each definition entry includes:

- `kind`
- `name`
- `exportName`
- `file`
- `runtimeKind`
- `sourceLanguage`

For the current release path, these entries describe JS/TS definitions executed through the
`javascript` runtime kind:

- workflows define durable orchestration behavior
- services define durable keyed agent behavior

That contract is validated by [cli/src/project-manifest-contract.ts](../cli/src/project-manifest-contract.ts)
and checked in CI through `bun run check:manifest`.

## Manifest Resolution

When a project is registered or synced, the CLI resolves its manifest in this order:

1. `vilano.manifest.json` if present
2. `.vilano/project-manifest.json` cache if present and valid
3. project-source discovery, which writes the generated cache

Vilano prefers explicit manifests over discovery. For the canonical OSS release path,
`vilano.manifest.json` is the normal project contract.

To scaffold a runnable new project:

```bash
~/.vilano/bin/vilano init /path/to/project --starter
cd /path/to/project
~/.vilano/current/bun/bun add @vilano/runtime
```

To bootstrap an explicit manifest for an existing TS/JS repo:

```bash
~/.vilano/bin/vilano init /path/to/project
```

That command writes `vilano.manifest.json` from the current definition set. Review the generated
manifest before relying on it for non-trivial export patterns.

## Registration Behavior

Vilano Runtime treats `exportName` as authoritative. Registration validates schema, paths, and
export-name syntax. During `project add` and `project sync`, the CLI then imports the declared
definitions from the pinned project snapshot so the definition file must export that exact symbol
and the exported value must match the declared `kind` and `name` before registration completes.
Activation re-validates the same identity when the worker imports the module again.

For the current trust posture, registration should be treated as a trusted local-code step because
the CLI imports the declared definitions from the pinned snapshot. See
[Trust Model](./trust-model.md).

## Generated Cache

The generated cache is a convenience path for local TS/JS repos:

- it keeps local registration and sync flows fast
- it lets the CLI materialize a project contract before an explicit manifest exists
- it stays subordinate to `vilano.manifest.json` whenever an explicit manifest is present

Projects that already maintain an explicit `vilano.manifest.json` stay on the strongest and most
portable contract surface in the current release.
