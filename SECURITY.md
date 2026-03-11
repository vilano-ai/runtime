# Security Policy

Vilano Runtime is currently released as a local-first `0.x` BEAM-backed agent runtime. The current
OSS trust model is single-user and local-machine scoped.

The canonical runtime posture lives in [docs/trust-model.md](./docs/trust-model.md).

## Reporting a Vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report security issues to:

- `security@vilano.ai`

Include:

- affected version or commit
- operating system
- reproduction steps
- impact assessment

We will acknowledge receipt and follow up with next steps.

## Scope Notes

For the current OSS preview:

- the daemon is loopback-only
- the runtime does not claim strong isolation against arbitrary code running as the same OS user
- stronger sandboxing/isolation is future work, not a current guarantee

Please keep that trust model in mind when reporting issues.
