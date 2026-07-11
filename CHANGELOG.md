# 🪵 Changelog

**All notable project changes will be documented in this file.** The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Pride Versioning](https://pridever.org) → `PROUD.DEFAULT.SHAME`

## [Unreleased]

### Fixed

- `approve` now reacts 👀 the moment the permission gate accepts, before download or apply, so a mid-run failure is distinguishable from an unheard trigger

## [v1.0.0] - 2026-07-10

Hold onto your butts. Tuffgal Action moves to the CI-owned baselines model
introduced with Tuffgal v0.2.0-alpha.1. CI is now the sole source of truth
for committed baselines, and visual changes become a PR review gate instead
of a local `approve` step. This is a breaking release.

### Breaking

- The action now runs `npx tuffgal run --ci --manage-servers`
  - Requires `tuffgal@0.2.0-alpha.1` or newer
- `fail-on-changed` now defaults to `true`
  - Pending visual changes (`new`, `changed`, or `deleted`) fail the job so they become a review gate
  - Set `fail-on-changed: false` to keep the old surface-but-don't-block behavior
- The `tuffgal-baselines` artifact is replaced by `tuffgal-candidates`
  - `<report>/candidates/` tree plus a copy of `results.json`
  - Ready for `tuffgal approve --from <dir> --prune`

### Added

- New outputs: `deleted`, `env-mismatch`, and `new`
  - The `outcome` mapping gains `env-mismatch`
  - Treats `new`/`deleted` as pending review
  - Follows Tuffgal's exit-code precedence (`failed` > `env-mismatch` > `changed` > `pass`)
- Sticky PR comment: `<!-- tuffgal-report -->`
  - Totals table
  - Changed/new/deleted story names
  - Environment-mismatch banner
  - Link to the run
  - Approve instructions
  - Requires `permissions: pull-requests: write`
  - Skips silently on non-PR events
- `approve` sub-action: `nschneble/tuffgal-action/approve`
  - A `@tuffgal approve` PR comment commits the candidate baselines to the PR head branch
  - The approve job never checks out or executes PR-branch code
  - Fork PRs use the implicit download-and-approve path

## [v0.2.1] - 2026-06-06

Finished the `eval` hardening pass started in `v0.2.0`. The `setup-script`
input now flows through an `env:`-mapped variable instead of being
interpolated directly into `npm run`, so unusual script names can't break
out of the harness invocation. The `report-path` input is now env-mapped
in the parse step for the same reason.

Added `set -euo pipefail` to the parse step so a mid-block `jq` failure
won't leak partial outputs.

## [v0.2.0] - 2026-06-05

Who doesn't love a fast follow maintenance release?

Replaced `eval "npx tuffgal $args"` with a Bash array passed through
`env:`-mapped variables so unusual `story` values can't break out of the
harness invocation.

Added `.github/workflows/ci.yml` with two jobs:

- **Lint** validates every workflow + `action.yml` via [`reviewdog/action-actionlint@v1`](https://github.com/reviewdog/action-actionlint)
- **Smoke** runs the action against `tests/fixture/`, a minimal static-site project (plain Node `http` server + one story) and asserts `outcome == 'pass'`

Added `tests/fixture/` with a baked baseline so the smoke job has a deterministic pass-state to compare against.

## [v0.1.0] - 2026-06-05

This is the initial release! Tuffgal Action is a composite action wrapping
the `tuffgal run --manage-servers` CI script.

It parses `tuffgal/report/results.json` for `passed`, `changed`, `failed`,
and `total` counts.

It uploads a `tuffgal-report` artifact when stories fail or change. It also
uploads a `tuffgal-baselines` artifact when stories change, so reviewers
can drop new PNGs into follow-up commits.

Inputs:

- `baselines-path`
- `coverage`
- `fail-on-changed`
- `headed`
- `install-browsers`
- `node-version`
- `report-path`
- `retention-days`
- `setup-script`
- `story`
- `upload-artifacts`
- `working-directory`

Outputs:

- `changed`
- `failed`
- `outcome`
- `passed`
- `total`

Targets Node 22+
Compatible with `tuffgal@^0.1.0-alpha.2`

[Unreleased]: https://github.com/nschneble/tuffgal-action/compare/v1.0.0...HEAD
[v1.0.0]: https://github.com/nschneble/tuffgal-action/releases/tag/v1.0.0
[v0.2.1]: https://github.com/nschneble/tuffgal-action/releases/tag/v0.2.1
[v0.2.0]: https://github.com/nschneble/tuffgal-action/releases/tag/v0.2.0
[v0.1.0]: https://github.com/nschneble/tuffgal-action/releases/tag/v0.1.0
