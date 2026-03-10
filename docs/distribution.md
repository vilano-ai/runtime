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
