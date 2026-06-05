# 🪵 Changelog

**All notable project changes will be documented in this file.** The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Pride Versioning](https://pridever.org) → `PROUD.DEFAULT.SHAME`

## [Unreleased]

_Nothing right now_

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

[Unreleased]: https://github.com/nschneble/linklater/compare/v0.1.0...HEAD
[v0.1.0]: https://github.com/nschneble/linklater/releases/tag/v0.1.0
