# Tuffgal Action

![GitHub License](https://img.shields.io/github/license/nschneble/tuffgal-action)

GitHub Action wrapper for [Tuffgal](https://github.com/nschneble/tuffgal),
a JSON-driven visual regression testing framework for web apps.

<img src="tuffgal-action.jpg" alt="Tuffgal Action" />

Collapses the [Tuffgal CI recipe](https://github.com/nschneble/tuffgal/blob/main/docs/ci.md)
into a single composite step. Handles Node + Playwright setup, runs the
harness with `--manage-servers`, parses `results.json`, and uploads the
report + updated baselines as workflow artifacts when stories fail or
change.

## Usage

```yaml
name: visual-regression

on:
  pull_request:
    branches: [main]

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
      - uses: nschneble/tuffgal-action@v0
        with:
          setup-script: test:ui:setup
```

For a static-site project that doesn't need a database, you can drop the
`services:` block and the `setup-script` input.

## Inputs

| Name                | Default             | Description                                                                                                       |
| ------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `baselines-path`    | `tuffgal/baselines` | Path to the baselines directory (must match `paths.baselines`)                                                    |
| `coverage`          | `false`             | Run with `--coverage` to emit a monocart V8 coverage report                                                       |
| `fail-on-changed`   | `false`             | Fail the job when any story has `changed` status (`false` lets reviewers approve visual drift w/out blocking PRs) |
| `headed`            | `false`             | Run with `--headed` (rarely useful in CI)                                                                         |
| `install-browsers`  | `true`              | Run `npx playwright install --with-deps chromium` before the harness                                              |
| `node-version`      | `22`                | Node.js version (Tuffgal requires Node 22+)                                                                       |
| `report-path`       | `tuffgal/report`    | Path to the report directory, relative to `working-directory` (must match `paths.report` in `tuffgal.config.ts`)  |
| `retention-days`    | `14`                | Artifact retention                                                                                                |
| `setup-script`      | `''`                | Optional npm script to run before the harness (e.g. DB bootstrap)                                                 |
| `story`             | `''`                | Filter to a single story (`--story <name>`)                                                                       |
| `upload-artifacts`  | `true`              | Upload report + baselines as workflow artifacts when stories fail or change                                       |
| `working-directory` | `.`                 | Directory containing `tuffgal.config.ts` and `package.json`                                                       |

## Outputs

| Name      | Description                                           |
| --------- | ----------------------------------------------------- |
| `changed` | Number of stories with visual changes awaiting review |
| `failed`  | Number of stories that failed                         |
| `outcome` | One of `pass`, `changed`, `failed`, or `no-results`   |
| `passed`  | Number of stories that passed                         |
| `total`   | Total stories executed                                |

## What it does, step by step

1. `actions/setup-node@v4` with the requested Node version and npm cache
2. `npm ci` in `working-directory`
3. `npx playwright install --with-deps chromium` (unless `install-browsers: false`)
4. `npm run <setup-script>` if `setup-script` is provided (skipped otherwise)
5. `npx tuffgal run --manage-servers [--story X] [--headed] [--coverage]` with `continue-on-error: true` so artifacts upload even when stories fail
6. Parse `<report-path>/results.json` for `totals.{passed,changed,failed,stories}`, then write counts to step outputs and `$GITHUB_STEP_SUMMARY`
7. Upload `<report-path>/` as `tuffgal-report` artifact when stories fail or change
8. Upload `<baselines-path>/` as `tuffgal-baselines` artifact when stories change, so reviewers can drop new PNGs into follow-up commits
9. Re-surface a non-zero exit when `outcome` is `failed`, `no-results`, or `changed` (when `fail-on-changed: true`)

## Reviewing a failed run

When a job fails, the workflow run page lists `tuffgal-report` as a
downloadable artifact. Unzip it and open `index.html` in a web browser to
see story-by-story status, screenshot diffs, and Playwright traces for each
failure.

When stories are `changed` with visual drift awaiting approval, download
the `tuffgal-baselines` artifact and drop the new PNGs into a follow-up
commit on the same branch to approve them.

## Versioning

Pinned tags: `v0.1.0`, `v0.1.1`, etc.

Floating major: `v0` follows the latest `v0.x.y` release. Pin to `v0` for
automatic patch/minor updates within `v0.x`.

Breaking changes ship under `v1`, `v2`, etc. with separate floating tags.

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgements

The Tuffgal logo is an illustration by [Art Attack](https://unsplash.com/@artattackzone)
on [Unsplash](https://unsplash.com/illustrations/a-woman-with-two-dumbs-in-her-hands-0GxJHpQzVvs)
with a little [Securitocat](https://octodex.github.com/securitocat/) mixed
in for a little whimsy.
