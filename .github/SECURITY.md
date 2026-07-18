# Security Policy

## Reporting a vulnerability

Please report security issues **privately** through GitHub's private
vulnerability reporting: open the repo's **Security** tab → **Report a
vulnerability**, or use the direct link:

[Report a vulnerability](https://github.com/nschneble/tuffgal-action/security/advisories/new)

This keeps the report confidential until a fix ships. **Please don't open a
public issue for a security report** — a public issue discloses the problem
before it's patched.

## Supported versions

| Version          | Supported |
| ---------------- | --------- |
| `v1.x` (current) | Yes       |
| `v0.x`           | No        |

`v1` is the current major and floating tag. Pin `@v1` to track patch/minor
fixes; breaking changes ship under `v2` (see the README
[Versioning](../README.md#versioning) section).

## Scope

**In scope** — this action's own code:

- the composite `action.yml` and `approve/action.yml`
- the embedded `github-script` / bash steps
- the extracted `scripts/*.js` and `approve/scripts/*.js` modules
- `approve/validate-artifact.sh`

A note on the trust boundaries, so a report lands in the right place: the
`approve` flow **never checks out or executes PR-branch code**, candidate
artifacts are **validated before extraction** (path-scoped, symlink- and
traversal-rejecting), and baseline commits are **path-scoped to the baselines
directory**. A finding that crosses one of those boundaries is exactly what
this policy is for.

**Out of scope:**

- the upstream [`tuffgal`](https://github.com/nschneble/tuffgal) CLI itself —
  report CLI issues on its own repo
- a consumer's own workflow misconfiguration (missing `permissions`, a
  wrongly-scoped token, etc.)

## What to expect

This is a solo-maintained project, so responses are best-effort rather than on
a fixed SLA. You'll get an acknowledgement as soon as I can, and I'll keep you
posted through the advisory as a fix comes together. Thanks for reporting
responsibly.
