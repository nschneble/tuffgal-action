# 🪵 Changelog

**All notable project changes will be documented in this file.** The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Pride Versioning](https://pridever.org) → `PROUD.DEFAULT.SHAME`

## [Unreleased]

### Changed

- The sticky PR comment's Changed table drops its Diff column — side-by-side baseline / actual is enough, and the full diff still lives in the linked report
- The sticky PR comment now lists every Failed story individually, with its failure message and (when a preview published) a deep link to that story in the report
- The Deleted section now links the report's deleted-baselines heading when a preview published
- The sticky PR comment is now breakpoint-aware: when a run spans more than one breakpoint, the Changed and New tables show one thumbnail row per drifted breakpoint and the Deleted, Failed, and per-story approve-checkbox lines name which breakpoints drifted; a single-breakpoint run renders exactly as before. Deleted entries are also grouped per story, so a story removed at several breakpoints is listed once instead of once per breakpoint

## [v1.5.0] - 2026-07-24

### Added

GH CI now skips the redundant Tuffgal re-run after a full baseline
approval.

## [v1.4.1] - 2026-07-22

Fixed a bug that kept per-baseline approvals from, you know, WORKING. Shame
bump.

## [v1.4.0] - 2026-07-22

### Added

Per-baseline approvals. You can now tick an individual story's checkbox in
the sticky comment to promote just that baseline, or the main checkbox to
approve them all.

## [v1.3.0] - 2026-07-18

### Added

- Security policy routing vulnerability reports to GitHub's private vulnerability reporting

### Changed

- `approve` commit-step logic extracted into a unit-tested module
- `approve` gate resolver and candidate selection extracted into unit-tested modules
- `approve` refuses symlinks in the PR head's seeded baselines
- CI now exercises the `failed` / `no-results` exit-code legs and the artifact validator's backslash-path rejection
- Every third-party action is SHA-pinned, with a Dependabot config keeping the pins fresh
- Input declarations are alphabetized across `action.yml`, `approve/action.yml`, and the README input table
- Per-PR Pages preview masks its push token and redacts it from git error logs
- Primary `visual-regression` usage workflow now ships as a linted `examples/tuffgal.yml`
- Sticky PR-comment body building extracted into a unit-tested module
- The `Run Tuffgal` harness step now runs under `set -euo pipefail`

### Fixed

- `approve` no longer wipes unchanged baselines when working directory is a subdirectory
- `approve` preflight points at the real version requirement
- Malformed `results.json` now reports `no-results` instead of crashing the parse step
- `no-results` and `failed` PR comments now name the concrete next step instead of dropping to a bare run link
- Per-PR Pages preview survives overlapping visual runs (the push retries instead of dropping to artifact links)
- Per-PR Pages preview logs expected degradation as a notice instead of a warning
- PR-comment thumbnails now name their story in the alt text, giving screen-reader users per-image context
- PR-comment image `src` URLs are now attribute-escaped
- README now notes the `retention-days` unit, matches the `deleted` output's wording, documents the approve inputs, and the approve checkbox example accepts a manually-typed `[X]`
- Step-summary and PR-comment env-mismatch banners now share one wording

## [v1.2.1] - 2026-07-16

### Added

- `pages-token` input to auto-enable the per-PR Pages preview
  - Pass an admin PAT / GitHub App token to have the first run create the Pages site; defaults to `GITHUB_TOKEN`

### Fixed

- Docs no longer claim `GITHUB_TOKEN` + `pages: write` auto-enables Pages — GitHub reserves site creation for a repo-admin credential, so enable Pages once by hand or supply `pages-token`
- The auto-enable warning now names the concrete fix (enable by hand, or set `pages-token`)

## [v1.2.0] - 2026-07-16

### Added

- Dynamic per-PR previews
- PRs with pending story changes get a published report
- Stories can be deep-linked (courtesy Tuffgal 0.2.0-alpha.3)
- Checkbox approval to compliment the @tuffgal approve comment

## [v1.1.0] - 2026-07-11

Lots of nuanced changes to the `approve` sub-action.

### Added

- `approve` sub-action: opt-in `token` input for the baseline commit
  - Defaults to `GITHUB_TOKEN`, which GitHub will not use to re-trigger the consumer's visual workflow
  - Supply a PAT or GitHub app installation token to have the visual check re-run automatically against the new baselines

### Fixed

- `approve` now reacts "👀" the moment the permission gate accepts
- `approve` no longer coin-flips when a run carries multiple candidates artifacts
- `approve` success comment no longer claims the next visual run "should pass"
  - With the default `GITHUB_TOKEN` it now explains the check will not re-run on its own and lists how to kick it
  - With a custom `token` it states the check re-runs automatically

## [v1.0.1] - 2026-07-11

Did an oopsie. Changes triggered GitHub's secondary rate limit and kinda
made the whole thing… not work. Now it does again! Probably.

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

[Unreleased]: https://github.com/nschneble/tuffgal-action/compare/v1.5.0...HEAD
[v1.5.0]: https://github.com/nschneble/tuffgal-action/releases/tag/v1.5.0
[v1.4.1]: https://github.com/nschneble/tuffgal-action/releases/tag/v1.4.1
[v1.4.0]: https://github.com/nschneble/tuffgal-action/releases/tag/v1.4.0
[v1.3.0]: https://github.com/nschneble/tuffgal-action/releases/tag/v1.3.0
[v1.2.1]: https://github.com/nschneble/tuffgal-action/releases/tag/v1.2.1
[v1.2.0]: https://github.com/nschneble/tuffgal-action/releases/tag/v1.2.0
[v1.1.0]: https://github.com/nschneble/tuffgal-action/releases/tag/v1.1.0
[v1.0.1]: https://github.com/nschneble/tuffgal-action/releases/tag/v1.0.1
[v1.0.0]: https://github.com/nschneble/tuffgal-action/releases/tag/v1.0.0
[v0.2.1]: https://github.com/nschneble/tuffgal-action/releases/tag/v0.2.1
[v0.2.0]: https://github.com/nschneble/tuffgal-action/releases/tag/v0.2.0
[v0.1.0]: https://github.com/nschneble/tuffgal-action/releases/tag/v0.1.0
