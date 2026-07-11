# Tuffgal Action

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

GitHub Action wrapper for [Tuffgal](https://github.com/nschneble/tuffgal),
a JSON-driven visual regression testing framework for web apps.

<img src="tuffgal-action.jpg" alt="Tuffgal Action" />

Runs Tuffgal in **CI mode**, where CI is the sole source of truth for
committed baselines. Local baselines rendered on macOS never match CI's Linux
render pixel-for-pixel, so instead of comparing against locally-approved
images, the action treats visual changes as a PR review gate: CI proposes
candidate baselines, surfaces them in a sticky PR comment, and a maintainer
approves them by commenting `@tuffgal approve` (or by downloading the
candidates and running `tuffgal approve --from` locally).

The action handles Node + Playwright setup, runs the harness with
`--ci --manage-servers`, parses `results.json`, uploads the report + candidate
baselines as artifacts, and posts the sticky comment.

## Usage

```yaml
name: visual-regression

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write # required for the sticky PR comment

jobs:
  tuffgal:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: myapp_testing_ui
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    env:
      TUFFGAL: "1"
      TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/myapp_testing_ui

    steps:
      - uses: actions/checkout@v4
      - uses: nschneble/tuffgal-action@v1
        with:
          setup-script: test:ui:setup
```

For a static-site project that doesn't need a database, you can drop the
`services:` block and the `setup-script` input.

> **`permissions: pull-requests: write` is required** for the sticky PR
> comment. Without it the comment step fails to post (the run still reports
> its outcome via the job status and step summary). On a non-PR event
> (`push`, `workflow_dispatch`) the comment step skips silently.

Your app must boot and seed deterministically in CI — that's the one contract
the CI-owned-baselines model asks of a consumer.

## Inputs

| Name                | Default             | Description                                                                                                                                                                            |
| ------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baselines-path`    | `tuffgal/baselines` | Path to the baselines directory, relative to `working-directory` (must match `paths.baselines`)                                                                                        |
| `coverage`          | `false`             | Run with `--coverage` to emit a monocart V8 coverage report                                                                                                                            |
| `fail-on-changed`   | `true`              | Fail the job when stories have pending visual changes (`new`, `changed`, or `deleted`) awaiting review. Set `false` to surface changes via artifact + comment without blocking the job |
| `headed`            | `false`             | Run with `--headed` (rarely useful in CI)                                                                                                                                              |
| `install-browsers`  | `true`              | Run `npx playwright install --with-deps chromium` before the harness                                                                                                                   |
| `node-version`      | `22`                | Node.js version (Tuffgal requires Node 22+)                                                                                                                                            |
| `report-path`       | `tuffgal/report`    | Path to the report directory, relative to `working-directory` (must match `paths.report` in `tuffgal.config.ts`)                                                                       |
| `retention-days`    | `14`                | Artifact retention                                                                                                                                                                     |
| `setup-script`      | `''`                | Optional npm script to run before the harness (e.g. DB bootstrap)                                                                                                                      |
| `story`             | `''`                | Filter to a single story (`--story <name>`)                                                                                                                                            |
| `upload-artifacts`  | `true`              | Upload the report + candidate baselines as workflow artifacts when visual changes await review                                                                                         |
| `working-directory` | `.`                 | Directory containing `tuffgal.config.ts` and `package.json`                                                                                                                            |

## Outputs

| Name           | Description                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `changed`      | Number of stories whose committed baseline changed (pixels or a11y snapshot)                                                |
| `deleted`      | Number of orphaned baseline entries with no matching story (pruned on approve)                                              |
| `env-mismatch` | `'true'` when the capture environment in `baselines/manifest.json` no longer matches this CI run (expect a full re-approve) |
| `failed`       | Number of stories that failed                                                                                               |
| `new`          | Number of stories with no committed baseline yet (candidate written)                                                        |
| `outcome`      | One of `pass`, `changed` (pending new/changed/deleted review), `env-mismatch`, `failed`, or `no-results`                    |
| `passed`       | Number of stories that passed                                                                                               |
| `total`        | Total stories executed                                                                                                      |

`outcome` follows Tuffgal's exit-code precedence: `failed` (broken stories) >
`env-mismatch` (capture environment changed) > `changed` (pending visual
review) > `pass`.

## What it does, step by step

1. `actions/setup-node@v4` with the requested Node version and npm cache
2. `npm ci` in `working-directory`
3. `npx playwright install --with-deps chromium` (unless `install-browsers: false`)
4. `npm run <setup-script>` if `setup-script` is provided (skipped otherwise)
5. `npx tuffgal run --ci --manage-servers [--story X] [--headed] [--coverage]` with `continue-on-error: true` so artifacts upload even when stories fail
6. Parse `<report-path>/results.json` for `totals.{passed,changed,new,deleted,failed,stories}` and `environment.mismatch`, then write outputs + a `$GITHUB_STEP_SUMMARY` table
7. Copy `results.json` into `<report-path>/candidates/` so the candidates artifact is self-contained for `tuffgal approve --from`
8. Upload `<report-path>/` as `tuffgal-report` (on failures, no-results, or pending changes) and `<report-path>/candidates/` as `tuffgal-candidates` (when visual changes await review)
9. On a PR event, upsert a sticky comment (marker `<!-- tuffgal-report -->`) with the totals, changed/new/deleted story names, an environment-mismatch banner when set, a link to the run, and approve instructions
10. Re-surface a non-zero exit when `outcome` is `failed`, `no-results`, `env-mismatch`, or `changed` (when `fail-on-changed: true`)

## Approving candidate baselines

When a run reports `changed` (any `new` / `changed` / `deleted`), the sticky PR
comment lists the affected stories and links the `tuffgal-candidates` artifact.
There are two ways to approve.

### Command: `@tuffgal approve`

Add the approve workflow to your consumer repo and a maintainer can comment
`@tuffgal approve` on the PR. The bot verifies the commenter has write access,
downloads the candidates artifact from the PR's latest run, applies it with
`tuffgal approve --from <dir> --prune`, and commits the updated baselines to
the PR head branch.

Copy this into `.github/workflows/tuffgal-approve.yml`:

```yaml
name: tuffgal-approve

on:
  issue_comment:
    types: [created]

jobs:
  approve:
    if: >-
      github.event.issue.pull_request &&
      contains(github.event.comment.body, '@tuffgal approve')
    runs-on: ubuntu-latest
    permissions:
      contents: write # commit baselines to the PR head branch
      pull-requests: write # react + reply on the comment
      actions: read # download the candidates artifact from the PR run
    steps:
      - uses: nschneble/tuffgal-action/approve@v1
        with:
          working-directory: .
          # baselines-path: tuffgal/baselines
          # node-version: "22"
```

(Also available at [`examples/tuffgal-approve.yml`](examples/tuffgal-approve.yml).)

**Security model.** The approve job is deliberately conservative:

- It **never checks out or executes PR-branch code.** It checks out only the
  base repo's default branch (trusted) to run the CLI, reads the PR head's
  existing baselines as data, and commits to the head branch via the git data
  API.
- It verifies the commenter's repository permission (`write` / `maintain` /
  `admin`) **before** any checkout, download, or write. Unauthorized
  commenters get a "👀" reaction and nothing else. An accepted command also
  gets an immediate acknowledgement so a mid-run failure is distinguishable
  from an unresponsive trigger, then "🚀" once the baselines land.
- It writes **only** files from the candidates artifact, path-scoped to the
  baselines directory. Absolute paths, path traversal, or unexpected file
  types in the artifact fail the job closed.
- The comment body is never interpolated into a shell command.

### Implicit: download and approve locally

Any contributor can approve without the bot: download the `tuffgal-candidates`
artifact from the run, then run

```bash
npx tuffgal approve --from <extracted-dir> --prune
```

and commit the updated baselines directory.

### Fork PRs

The default `GITHUB_TOKEN` cannot push to a fork's branch, so the
`@tuffgal approve` command **does not work for fork PRs** — the bot replies
with a note. Fork contributors use the implicit path above (download the
candidates artifact, run `tuffgal approve --from`, and commit to their fork
branch). Broader fork support is intentionally out of scope for now.

## Reviewing a failed run

When a job fails, the workflow run page lists `tuffgal-report` as a
downloadable artifact. Unzip it and open `index.html` in a web browser to see
story-by-story status, screenshot diffs, and Playwright traces. The
`tuffgal-candidates` artifact holds the proposed new baselines (plus a copy of
`results.json`) ready for `tuffgal approve --from`.

## Versioning

Pinned tags: `v1.0.0`, `v1.0.1`, etc.

Floating major: `v1` follows the latest `v1.x.y` release. Pin to `v1` for
automatic patch/minor updates within `v1.x`.

Breaking changes ship under `v2`, etc. with separate floating tags.

> **v1 is a breaking release.** The action now runs Tuffgal in CI mode,
> `fail-on-changed` defaults to `true`, and the old `tuffgal-baselines`
> artifact is replaced by `tuffgal-candidates`. See the
> [CHANGELOG](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgements

The Tuffgal logo is an illustration by [Art Attack](https://unsplash.com/@artattackzone)
on [Unsplash](https://unsplash.com/illustrations/a-woman-with-two-dumbs-in-her-hands-0GxJHpQzVvs)
with a little [Securitocat](https://octodex.github.com/securitocat/) mixed
in for a little whimsy.
