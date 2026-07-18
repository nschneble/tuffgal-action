'use strict';
//
// Pure, unit-testable builder for the sticky PR comment body. Given the pieces
// the `Post sticky PR comment` step has already computed — the parsed outcome +
// counts, the env-mismatch flag and keys, the (possibly empty) preview URL, and
// the per-story image URLs read out of results.json — it returns the final
// markdown `body` string. Extracted out of the inline `actions/github-script`
// block so the branch matrix (preview vs none, changed/new/deleted sections,
// env-mismatch banner, approve CTA, pass/failed/no-results outcomes) is covered
// by a `node --test` suite, the same extract-and-unit-test precedent set by the
// sibling `approve/scripts/*.js` and `pages-push.js` modules.
//
// The GitHub API side of the step — reading env, resolving results.json image
// paths to preview URLs, and the `listComments` / `updateComment` /
// `createComment` upsert — STAYS inline; this module owns ONLY the pure body
// string. The marker and the table/banner renderers are extracted here for
// reuse; the bash step-summary still hand-duplicates them (bash can't `require`
// this module), so these are kept in step with that summary rather than being
// its single source of truth.

// Injected as the first line of every comment body. The upsert step greps for
// this marker to find the comment to update, so it is exported rather than
// duplicated at the call site.
const MARKER = '<!-- tuffgal-report -->';

// Escape text for HTML flow content (story names in a <summary>).
const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Escape text for an HTML attribute value (the <img> src URL and alt text).
// Extends the flow escape with `"` so a value carrying a double quote — a
// crafted story name in the alt, or a stray quote in an image path in the src —
// can't break out of the attribute. Cosmetic markdown-injection hardening.
const escapeAttribute = (text) => escapeHtml(text).replace(/"/g, '&quot;');

// One inline thumbnail, or an italic placeholder when its preview URL is null
// (preview off, or the image lives under neither report nor baselines root).
const thumbnail = (url, label) =>
  url
    ? `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(label)}" width="260">`
    : `<em>${escapeHtml(label)} unavailable</em>`;

// The env-mismatch banner. Extracted for reuse; the bash step-summary still
// hand-duplicates this wording, so the two are kept in step with each other.
function renderEnvMismatchBanner(mismatchKeys) {
  const out = [
    '> ⚠️ **Capture environment changed** — the committed baselines were captured in a different environment than this CI run. Comparison still ran, but expect a full re-approve.',
  ];
  if (mismatchKeys && mismatchKeys.length) {
    out.push('>');
    out.push('> Changed keys: ' + mismatchKeys.map((key) => '`' + key + '`').join(', '));
  }
  return out;
}

// The outcome totals table. Extracted for reuse; the bash step-summary still
// hand-duplicates it, so row order + labels are kept in step with that summary.
function renderTotalsTable(counts) {
  return [
    '| Status | Count |',
    '|--------|-------|',
    `| Pass | ${counts.passed} |`,
    `| Changed | ${counts.changed} |`,
    `| New | ${counts.new} |`,
    `| Deleted | ${counts.deleted} |`,
    `| Failed | ${counts.failed} |`,
    `| Total | ${counts.total} |`,
  ];
}

// The actionable next-step line for the two outcomes that otherwise degrade to a
// bare run link. Kept in step with the bash summary's equivalents.
const ACTIONABLE = {
  'no-results':
    'The run wrote no `results.json` — check the Run Tuffgal step log and confirm `report-path` matches `paths.report` in tuffgal.config.ts.',
  failed:
    'Download the `tuffgal-report` artifact and open `index.html` for story-by-story diffs and traces.',
};

// Build the full sticky-comment markdown body.
//
//   outcome       one of pass / changed / env-mismatch / failed / no-results
//   counts        { passed, changed, new, deleted, failed, total } as strings
//   envMismatch   boolean — render the capture-environment banner
//   mismatchKeys  string[] — the changed environment keys, listed under the banner
//   previewUrl    normalized Pages URL (no trailing slash), or '' when no preview
//   changed       [{ index, name, baseline, actual, diff }] — image URLs or null
//   added         [{ index, name, actual }] — proposed-baseline image URL or null
//   deletedNames  string[] — names of removed stories
//   runUrl        the workflow-run URL for the fallback link
function buildCommentBody({
  outcome,
  counts,
  envMismatch,
  mismatchKeys,
  previewUrl,
  changed,
  added,
  deletedNames,
  runUrl,
}) {
  const reportUrl = previewUrl ? `${previewUrl}/report/index.html` : null;
  const storyLink = (entry) => (reportUrl ? `${reportUrl}#story-${entry.index}` : null);
  const pending =
    (Number(counts.new) || 0) + (Number(counts.changed) || 0) + (Number(counts.deleted) || 0) > 0;

  const lines = [];
  lines.push(MARKER);
  lines.push('## 👁️ Tuffgal visual regression');
  lines.push('');
  lines.push(`Outcome: **${outcome}**`);
  lines.push('');
  if (envMismatch) {
    for (const line of renderEnvMismatchBanner(mismatchKeys)) lines.push(line);
    lines.push('');
  }
  for (const line of renderTotalsTable(counts)) lines.push(line);
  lines.push('');

  // Changed: with a preview, each story is a collapsible carrying inline
  // baseline / actual / diff thumbnails plus a deep-link that opens the report
  // scrolled to that story with its screenshots expanded. Without a preview,
  // fall back to a plain name list. The alt text threads the story name so a
  // screen-reader user gets per-image context in a multi-story comment.
  if (changed.length) {
    lines.push(`### Changed (${changed.length})`);
    lines.push('');
    for (const entry of changed) {
      if (previewUrl) {
        lines.push('<details>');
        lines.push(`<summary>${escapeHtml(entry.name)}</summary>`);
        lines.push('');
        lines.push('| Baseline | Actual | Diff |');
        lines.push('|---|---|---|');
        lines.push(
          `| ${thumbnail(entry.baseline, `baseline for ${entry.name}`)} | ${thumbnail(entry.actual, `actual for ${entry.name}`)} | ${thumbnail(entry.diff, `diff for ${entry.name}`)} |`,
        );
        lines.push('');
        lines.push(`[Open ${escapeHtml(entry.name)} in report →](${storyLink(entry)})`);
        lines.push('</details>');
      } else {
        lines.push(`- ${entry.name}`);
      }
    }
    lines.push('');
  }

  // New: no prior baseline to compare, so show the proposed one (the run's
  // actual = the candidate) inline.
  if (added.length) {
    lines.push(`### New (${added.length})`);
    lines.push('');
    for (const entry of added) {
      if (previewUrl) {
        lines.push('<details>');
        lines.push(`<summary>${escapeHtml(entry.name)}</summary>`);
        lines.push('');
        lines.push(
          `Proposed new baseline: ${thumbnail(entry.actual, `proposed baseline for ${entry.name}`)}`,
        );
        lines.push('');
        lines.push(`[Open ${escapeHtml(entry.name)} in report →](${storyLink(entry)})`);
        lines.push('</details>');
      } else {
        lines.push(`- ${entry.name}`);
      }
    }
    lines.push('');
  }

  if (deletedNames.length) {
    lines.push(`### Deleted (${deletedNames.length})`);
    for (const name of deletedNames) lines.push(`- ${String(name).replace(/[\r\n]+/g, ' ')}`);
    lines.push('');
  }

  // Name the concrete next step for the two outcomes that otherwise fall to a
  // bare run link, matching the tone of the approve preflight's messages.
  if (ACTIONABLE[outcome]) {
    lines.push(ACTIONABLE[outcome]);
    lines.push('');
  }

  if (pending) {
    lines.push('### Approve these changes');
    lines.push('');
    if (reportUrl) {
      lines.push(
        `📊 [Open the full report](${reportUrl}) — scrolls to each changed story with screenshots expanded.`,
      );
      lines.push('');
    }
    // Primary one-click path: tick the box. The approve workflow (see
    // examples/tuffgal-approve.yml) fires on the `edited` event, verifies the
    // ticker has write access, and promotes the candidate baselines. The literal
    // `<!-- tuffgal-approve-box -->` marker is what that workflow greps for, so
    // the checkbox can never be confused with an unrelated task list a reviewer
    // adds elsewhere.
    lines.push(
      '- [ ] <!-- tuffgal-approve-box --> **Approve these baselines** — tick to commit the candidate baselines to this PR (requires write access).',
    );
    lines.push('');
    lines.push(
      '…or comment `@tuffgal approve`. Prefer a local checkout? Download the `tuffgal-candidates` artifact from the run and run `npx tuffgal approve --from <extracted-dir> --prune`, then commit the updated baselines directory.',
    );
    lines.push('');
    lines.push(`[View the run →](${runUrl})`);
  } else if (reportUrl) {
    lines.push(`[Open the report →](${reportUrl}) · [View the run →](${runUrl})`);
  } else {
    lines.push(`[View the run →](${runUrl})`);
  }

  return lines.join('\n');
}

module.exports = {
  MARKER,
  buildCommentBody,
  renderEnvMismatchBanner,
  renderTotalsTable,
};
