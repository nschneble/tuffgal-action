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
  contents: write # push the per-PR Pages preview to gh-pages
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

(Also available at [`examples/tuffgal.yml`](examples/tuffgal.yml).)

For a static-site project that doesn't need a database, you can drop the
`services:` block and the `setup-script` input.

> **`permissions: pull-requests: write` is required** for the sticky PR
> comment. Without it the comment step fails to post (the run still reports
> its outcome via the job status and step summary). On a non-PR event
> (`push`, `workflow_dispatch`) the comment step skips silently.

### Per-PR preview (deep-linkable report)

When `pages-preview` is on, a run with pending changes publishes the report
and baselines to a per-PR GitHub Pages preview. The sticky comment then
carries, for each changed story, inline side-by-side baseline / actual
thumbnails and an open-in-report link that jumps straight to that story with
its screenshots — including the full diff — expanded.

It needs two things on the consumer repo:

- **`contents: write`** on the job so the preview can push to `gh-pages`.
- **GitHub Pages enabled**, source = the `gh-pages` branch. PUBLIC repos only
  (private Pages is Enterprise-only). **Enable it once, by hand** — Settings →
  Pages → _Deploy from a branch_ → `gh-pages` / root. The branch is created on
  the first run, so you can turn Pages on right after (or before — an empty
  branch is fine).

> **Why the manual step?** GitHub reserves Pages **site creation** for a
> repo-admin credential. The `GITHUB_TOKEN` the action runs under can _push_ the
> branch (with `contents: write`) but cannot _create_ the site, so it can't flip
> Pages on for you. To skip the manual click, pass an admin PAT / GitHub App
> token via the **`pages-token`** input — then the first run enables Pages
> itself. (`pages: write` alone does **not** grant site creation.)

The preview is best-effort. Expected not-configured states — Pages off, the
repo is private, or the push is blocked — log a notice; only unexpected git/API
failures log a warning. Either way the comment falls back to the
artifact-download links. Set `pages-preview: false` to skip it entirely.

Your app must boot and seed deterministically in CI. That's the one
contract the CI-owned-baselines model asks of a consumer.

## Inputs

| Name                | Default               | Description                                                                                                                                                                                                       |
| ------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baselines-path`    | `tuffgal/baselines`   | Path to the baselines directory, relative to `working-directory` (must match `paths.baselines`)                                                                                                                   |
| `coverage`          | `false`               | Run with `--coverage` to emit a monocart V8 coverage report                                                                                                                                                       |
| `fail-on-changed`   | `true`                | Fail the job when stories have pending visual changes (`new`, `changed`, or `deleted`) awaiting review. Set `false` to surface changes via artifact + comment without blocking the job                            |
| `headed`            | `false`               | Run with `--headed` (rarely useful in CI)                                                                                                                                                                         |
| `install-browsers`  | `true`                | Run `npx playwright install --with-deps chromium` before the harness                                                                                                                                              |
| `node-version`      | `22`                  | Node.js version (Tuffgal requires Node 22+)                                                                                                                                                                       |
| `pages-branch`      | `gh-pages`            | Branch the per-PR preview is published to (only used when `pages-preview` is on)                                                                                                                                  |
| `pages-preview`     | `true`                | Publish the report + baselines to a per-PR GitHub Pages preview so the comment can deep-link to changed stories. Needs `contents: write` + Pages enabled; PUBLIC repos only; degrades to artifact links otherwise |
| `pages-token`       | `${{ github.token }}` | Token to push the preview branch and auto-enable Pages. The default `GITHUB_TOKEN` pushes but can't create the Pages site (enable Pages once by hand); pass an admin PAT / App token to auto-enable it            |
| `report-path`       | `tuffgal/report`      | Path to the report directory, relative to `working-directory` (must match `paths.report` in `tuffgal.config.ts`)                                                                                                  |
| `retention-days`    | `14`                  | Artifact retention (days)                                                                                                                                                                                         |
| `setup-script`      | `''`                  | Optional npm script to run before the harness (e.g. DB bootstrap)                                                                                                                                                 |
| `story`             | `''`                  | Filter to a single story (`--story <name>`)                                                                                                                                                                       |
| `upload-artifacts`  | `true`                | Upload the report + candidate baselines as workflow artifacts when visual changes await review                                                                                                                    |
| `working-directory` | `.`                   | Directory containing `tuffgal.config.ts` and `package.json`                                                                                                                                                       |

## Outputs

| Name              | Description                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changed`         | Number of stories whose committed baseline changed (pixels or a11y snapshot)                                                                                                        |
| `deleted`         | Number of orphaned baseline entries with no matching story/action (pruned on approve)                                                                                               |
| `env-mismatch`    | `'true'` when the capture environment in `baselines/manifest.json` no longer matches this CI run (expect a full re-approve)                                                         |
| `failed`          | Number of stories that failed                                                                                                                                                       |
| `new`             | Number of stories with no committed baseline yet (candidate written)                                                                                                                |
| `outcome`         | One of `pass`, `changed` (pending new/changed/deleted review), `env-mismatch`, `failed`, or `no-results`                                                                            |
| `passed`          | Number of stories that passed                                                                                                                                                       |
| `preview-url`     | Base URL of the per-PR Pages preview (e.g. `https://owner.github.io/repo/pr-41`), or empty when the preview was off/skipped/failed. Append `/report/index.html` for the report      |
| `short-circuited` | `'true'` when the visual suite was skipped because the triggering commit only promotes already-approved baselines (a same-repo full-approval commit); `'false'` on every normal run |
| `total`           | Total stories executed                                                                                                                                                              |

`outcome` follows Tuffgal's exit-code precedence: `failed` (broken stories) >
`env-mismatch` (capture environment changed) > `changed` (pending visual
review) > `pass`.

## What it does, step by step

On a PR event, a fast pre-check runs first: it inspects the head commit, and if
that commit is a same-repo **full-approval** commit that only promotes
already-approved baselines (a `Tuffgal-Full-Approval` trailer, a single matching
parent, and a diff confined to `baselines-path`), the action skips the setup and
Tuffgal-run steps below (setup-node through `tuffgal run`); the parse step then
reports `outcome=pass` with `short-circuited: true` — the promoted tree is
byte-identical to the run that was already approved, so re-running it would
reproduce the same result. Anything ambiguous (a fork PR, a merge commit, a
commit that also touches source, an API error) falls through to the normal run
below. Otherwise:

1. `actions/setup-node@v4` with the requested Node version and npm cache
2. `npm ci` in `working-directory`
3. `npx playwright install --with-deps chromium` (unless `install-browsers: false`)
4. `npm run <setup-script>` if `setup-script` is provided (skipped otherwise)
5. `npx tuffgal run --ci --manage-servers [--story X] [--headed] [--coverage]` with `continue-on-error: true` so artifacts upload even when stories fail
6. Parse `<report-path>/results.json` for `totals.{passed,changed,new,deleted,failed,stories}` and `environment.mismatch`, then write outputs + a `$GITHUB_STEP_SUMMARY` table
7. Copy `results.json` into `<report-path>/candidates/` so the candidates artifact is self-contained for `tuffgal approve --from`
8. Upload `<report-path>/` as `tuffgal-report` (on failures, no-results, or pending changes) and `<report-path>/candidates/` as `tuffgal-candidates` (when visual changes await review)
9. On a PR with pending changes (and `pages-preview: true`), publish `<report-path>/` + `<baselines-path>/` to the `gh-pages` branch under `pr-<n>/`, so the report and every PNG have a real URL (best-effort — a failure just leaves the comment on the artifact-download path)
10. On a PR event, upsert a sticky comment (marker `<!-- tuffgal-report -->`) with the totals and, when a preview published, per-changed-story inline side-by-side baseline/actual thumbnails + an **Open in report →** deep-link, a **Failed** section listing each broken story (with its failure message and a report deep-link), and a report link on the **Deleted** section; otherwise the plain story names + artifact-download instructions. When a run spans more than one breakpoint, the Changed/New thumbnails become a per-breakpoint table (one row per drifted breakpoint) and the Deleted, Failed, and per-story approve-checkbox lines name which breakpoints drifted; a single-breakpoint run renders exactly as before. Includes an environment-mismatch banner when set, an approve checkbox + `@tuffgal approve` command, and a link to the run
11. Re-surface a non-zero exit when `outcome` is `failed`, `no-results`, `env-mismatch`, or `changed` (when `fail-on-changed: true`)

## Approving candidate baselines

When a run reports `changed` (any `new` / `changed` / `deleted`), the sticky PR
comment lists the affected stories and links the `tuffgal-candidates` artifact.
There are two clickable ways to approve, both driven by the same workflow below.

### Checkbox: tick the box in the comment

The sticky comment carries an **Approve these baselines** checkbox. A maintainer
ticks it; the workflow fires on the `edited` event, verifies the person who
ticked it has write access, and promotes the candidates exactly like the
command below. This is the one-click path — no command to remember. Ticking is
recognized only in the bot's own report comment (it carries a hidden
`tuffgal-approve-box` marker), so an unrelated task list elsewhere on the PR
can't trigger it, and the bot's own comment refreshes never loop back into an
approval.

Each new or changed baseline also gets its own **Approve _name_** checkbox. Tick
individual ones to promote just those baselines and leave the rest pending, or
tick the master **Approve these baselines** box to take them all. The master box
wins if both are ticked. (Deleted baselines have no checkbox — they're always
pruned on approve.)

### Command: `@tuffgal approve`

Alternatively a maintainer comments `@tuffgal approve` on the PR. The bot
verifies the commenter has write access, downloads the candidates artifact from
the PR's latest run, applies it with `tuffgal approve --from <dir> --prune`, and
commits the updated baselines to the PR head branch.

### Live status in the sticky comment

Approving takes a couple of minutes (fetching candidates, then committing them).
Rather than leave the report comment looking frozen behind a lone 👀 reaction,
the bot edits that same comment in place as the run progresses:

- **⚙️ In-flight** — the moment the approver is verified: _Approving baselines —
  fetching the approved candidates and committing them…_
- **📦 Milestone** — once the candidates are fetched and filtered: _committing
  the approved baselines…_
- **✅ Final** — after the commit lands. A full approval reports _All baselines
  approved and committed as `<sha>`_ and removes the now-pointless approve
  checkbox; a partial approval reports _Promoted N of M candidate baselines_ and
  leaves the remaining boxes in place. The banner's closing line depends on the
  token: with the default `GITHUB_TOKEN` it explains the visual check won't
  re-run on its own and how to kick it; with a custom PAT / App token it notes
  the check re-runs against the new baselines (and, on a full approval,
  short-circuits to a fast pass).
- **⚠️ Failure** — if approval doesn't complete, the banner says so and invites a
  retry. The approve boxes are already re-tickable (they're unticked the instant
  approval starts).

These edits are made with the default `GITHUB_TOKEN` and always leave every
approve checkbox **unticked**, so the bot can never edit its own comment into a
shape that re-triggers the approve workflow.

Both paths use the same workflow. Copy this into
`.github/workflows/tuffgal-approve.yml`:

```yaml
name: tuffgal-approve

on:
  issue_comment:
    # `created` catches the @tuffgal approve mention; `edited` catches a ticked
    # approve checkbox in the bot's sticky report comment.
    types: [created, edited]

jobs:
  approve:
    if: >-
      github.event.issue.pull_request && (
        contains(github.event.comment.body, '@tuffgal approve') ||
        (github.event.action == 'edited' &&
         contains(github.event.comment.body, 'tuffgal-approve-box') &&
         (contains(github.event.comment.body, '[x] <!-- tuffgal-approve-box') ||
          contains(github.event.comment.body, '[X] <!-- tuffgal-approve-box') ||
          contains(github.event.comment.body, '[x] <!-- tuffgal-approve-item:') ||
          contains(github.event.comment.body, '[X] <!-- tuffgal-approve-item:')))
      )
    runs-on: ubuntu-latest
    permissions:
      contents: write # commit baselines to the PR head branch
      pull-requests: write # react + reply on the comment
      actions: read # download the candidates artifact from the PR run
      checks: write # synthesize the passing required check on a full-clear approve (only if you set check-name)
    steps:
      - uses: nschneble/tuffgal-action/approve@v1
        with:
          working-directory: .
          # artifact-name: tuffgal-candidates # set a unique name per visual job for matrix / smoke suites
          # baselines-path: tuffgal/baselines
          # check-name: tuffgal # required-check name(s) to mark passing on a full-clear approve (comma-separate per job); needs checks: write
          # git-user-email: tuffgal-bot@users.noreply.github.com
          # git-user-name: tuffgal[bot]
          # node-version: "22"
          # token: ${{ secrets.TUFFGAL_APPROVE_TOKEN }}
```

(Also available at [`examples/tuffgal-approve.yml`](examples/tuffgal-approve.yml).)

If a single workflow run uploads more than one visual job's candidates,
give each job a unique `upload-artifact` name and set the matching
`artifact-name` here so approve knows which candidate set to promote.
Approve fails closed when the selected run carries more than one artifact
with this name rather than promoting an arbitrary set.

**Re-running the visual check.** By default the bot commits the approved
baselines with the workflow's `GITHUB_TOKEN`. GitHub deliberately doesn't
trigger workflows for commits pushed with `GITHUB_TOKEN`, so your visual
regression check will not re-run on its own after approval. It stays stale
or failing until you kick it. The success comment explains how: close and
reopen the PR, push an empty commit, or re-run the visual workflow from the
**Actions** tab.

To make the pushed commit trigger workflows normally — so the check re-runs and
clears itself automatically — pass a PAT or GitHub App installation token via the
`token` input:

```yaml
- uses: nschneble/tuffgal-action/approve@v1
  with:
    token: ${{ secrets.TUFFGAL_APPROVE_TOKEN }}
```

**Trade-off.** A PAT / App token widens the blast radius of the commit step: it
pushes with broader identity and reach than the scoped `GITHUB_TOKEN`, so it is
opt-in. Leave `token` unset to keep the conservative default and kick the check
by hand.

**Skipping the re-run entirely.** Both options above still run the _real_ visual
check again — they differ only in whether you kick it by hand or a PAT re-runs it
for you. A third option skips the re-run altogether. On a **full-clear**
approval — every pending baseline (new, changed, and deleted) approved at once
with nothing left outstanding — the commit touches only the baselines directory,
so a fresh Tuffgal run would reproduce the same result. Rather than pay for that
redundant run, the action can mark your required check passing directly on the
new commit.

Enable it by setting the `check-name` input to your required check's exact name
(the one that appears in the PR's checks list) and adding `checks: write` to the
approve job's `permissions:` — both are shown, commented, in the workflow above.
For a matrix or smoke suite that gates on several checks, comma-separate one name
per job (mirroring `artifact-name`). Left empty — the default — nothing changes
and the check re-runs (or waits to be kicked) exactly as above.

The synthesized check is honest about what it is: its summary on GitHub reads
"No Playwright run backs this status; it is a synthesized shortcut for the
required check" and names the commit whose baselines were approved. It reports
success because the promoted tree is byte-identical to the run that captured the
candidates, not because anything re-ran.

It fires **only** on a full clear. A partial approve — ticking some story boxes
and leaving others pending — never synthesizes a check; the required check keeps
whatever state it already had, so the still-pending baselines stay gated behind a
real run.

The shortcut is orthogonal to the token choice above. It works with the default
`GITHUB_TOKEN` or a PAT / App token, because it writes the check result directly
via GitHub's Checks API rather than relying on the commit to trigger a workflow.
Mix and match: the shortcut alone (skip the re-run on full clears), a PAT alone
(a full clear short-circuits fast; only a partial approve triggers a real re-run
that clears itself — see "The PAT path skips too" below), both, or neither.

**The PAT path skips too.** The synthesized check above (from v1.5.0) only ever
helped the default-`GITHUB_TOKEN` path — where the approval push fires no workflow
at all, so there is nothing to skip. With a PAT / App token the push _does_
retrigger your visual workflow, and until now that rerun re-ran the whole suite
against a tree it had just approved. The main action now closes that gap: it
recognizes its own trigger commit as a full-approval commit and skips the suite
before it starts, reporting `outcome=pass` and `short-circuited: true` in a few
seconds instead of re-running Playwright. It gates the skip on a **same-repo**
push whose commit carries the `Tuffgal-Full-Approval` trailer, has exactly one
parent equal to that trailer's SHA, and changes only files under your baselines
directory — a fork PR, a merge commit, or any commit that also touches source
falls through to a normal run. (This is a build-speed optimization, not a security
boundary: a same-repo push already requires write access, and anyone with write
access could approve the baselines for real; the fork exclusion is what keeps an
untrusted fork author from forging the trailer.) Under a PAT **and** a configured
`check-name`, both mechanisms fire on the same approval — the synthesized check
plus a real-but-instant short-circuited run under the same check name — and both
land green, which is expected.

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
  baselines directory. Absolute paths, path traversal, backslash paths,
  symlink entries, or unexpected file types in the artifact fail the job
  closed.
- It reads the PR head's existing baselines as data, but **refuses any symlink
  among them fail-closed** — a write collaborator could otherwise commit
  `baselines/x.png -> ../../.npmrc` (or `/proc/self/environ`), and following it
  would blob the secret target's bytes back onto the branch. A symlink there
  fails the job closed.
- The comment body is never interpolated into a shell command.

To report a vulnerability, see [SECURITY.md](.github/SECURITY.md).

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

## Migrating an existing consumer

Moving a repo from v0 to v1 takes two PRs, and the order matters. Both
constraints below fall out of the [approve command](#command-tuffgal-approve)'s
trusted-code-only security model, so the fix is sequencing, not configuration.

1. **Merge a small PR to the default branch first.** It carries
   `.github/workflows/tuffgal-approve.yml` (from
   [`examples/tuffgal-approve.yml`](examples/tuffgal-approve.yml)) plus the
   tuffgal dependency bump (`>= 0.2.0-alpha.1`) in `package.json` and the
   lockfile.
2. **Open the migration PR.** Bump the workflow's `uses:` to
   `nschneble/tuffgal-action@v1` and delete the stale baselines so CI proposes
   fresh candidates.
3. **Comment `@tuffgal approve` on the migration PR.** With step 1 already on
   the default branch, the bot fires and commits the new baselines to the PR
   head branch.

Two reasons the pre-step PR has to land first:

- **`issue_comment` workflows run the definition from the default branch.**
  GitHub always executes the version of `tuffgal-approve.yml` that lives on the
  default branch, never the copy on the PR head. So the workflow cannot fire on
  the very PR that introduces it. It has to be on the default branch already.
- **The approve sub-action runs `npm ci` from the default branch's lockfile.**
  It checks out the default branch (never PR-branch code) and installs from
  _that_ lockfile, so the tuffgal bump (`>= 0.2.0-alpha.1`) must also be on the
  default branch before the first `@tuffgal approve` resolves the right CLI.

**Neither pre-step is a security hole.** The workflow is inert until someone
comments `@tuffgal approve`, and even then it re-validates the command and the
commenter's write access before touching anything (see the
[security model](#approving-candidate-baselines) above). Merging the dependency
bump ahead of the `@v1` workflow is fine too: the new CLI running against the
old baselines is tolerated by the v0 action's soft gate, where `fail-on-changed`
defaults to `false`, so the pre-step PR's own visual run cannot block the merge.

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
