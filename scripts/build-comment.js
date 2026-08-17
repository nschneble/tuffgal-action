"use strict";
//
// Pure, unit-testable builder for the sticky PR comment body. Given the pieces
// the `Post sticky PR comment` step has already computed — the parsed outcome +
// counts, the env-mismatch flag and keys, the (possibly empty) preview URL, the
// per-story per-breakpoint image URLs read out of results.json, and whether the
// run spanned more than one breakpoint — it returns the final markdown `body`
// string, so the branch matrix (preview vs none, changed/new/deleted/failed
// sections, env-mismatch banner, approve CTA, pass/failed/no-results outcomes,
// and the compact short-circuit skipped-suite body) is covered by a
// `node --test` suite.
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
// duplicated at the call site. The approve action's
// approve/scripts/report-comment.js keeps a HAND-DUPLICATED byte-identical copy
// of this literal as its REPORT_MARKER — it lives in a SEPARATE action package
// that cannot cross-require this one — so keep the two byte-identical.
const MARKER = "<!-- tuffgal-report -->";

const { ACTION_NAME_PATTERN, approveItemMarker } = require("./comment-approve.js");
const { renderChangedSection } = require("./comment-changed.js");
const {
  renderAddedSection,
  renderDeletedSection,
  renderFailedSection,
} = require("./comment-sections.js");

// The env-mismatch banner. Extracted for reuse; the bash step-summary still
// hand-duplicates this wording, so the two are kept in step with each other.
function renderEnvMismatchBanner(mismatchKeys) {
  const out = [
    "> ⚠️ **Capture environment changed** — the committed baselines were captured in a different environment than this CI run. Comparison still ran, but expect a full re-approve.",
  ];
  if (mismatchKeys && mismatchKeys.length) {
    out.push(">");
    out.push(
      "> Changed keys: " + mismatchKeys.map((key) => "`" + key + "`").join(", ")
    );
  }
  return out;
}

// The outcome totals table. Extracted for reuse; the bash step-summary still
// hand-duplicates it, so row order + labels are kept in step with that summary.
function renderTotalsTable(counts) {
  return [
    "| Status | Count |",
    "|--------|-------|",
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
  "no-results":
    "The run wrote no `results.json` — check the Run Tuffgal step log and confirm `report-path` matches `paths.report` in tuffgal.config.ts.",
  failed:
    "Download the `tuffgal-report` artifact and open `index.html` for story-by-story diffs and traces.",
};

// Build the full sticky-comment markdown body.
//
//   outcome       one of pass / changed / env-mismatch / failed / no-results
//   counts        { passed, changed, new, deleted, failed, total } as strings
//   envMismatch   boolean — render the capture-environment banner
//   mismatchKeys  string[] — the changed environment keys, listed under the banner
//   previewUrl    normalized Pages URL (no trailing slash), or '' when no preview
//   changed       entries from build-stories.js, which documents their shape.
//                 A shot carrying `a11yOnly` renders as a fenced diff instead of
//                 thumbnails — and renders with no preview, since a diff needs
//                 nothing hosted.
//   added         same shape; each shot carries `actual` only (the proposed
//                 baseline — no prior one exists).
//   deleted       [{ name, breakpoints }] — one entry per removed story/action,
//                 grouped across breakpoints. `breakpoints` renders only in
//                 multi-breakpoint mode.
//   failed        [{ index, name, message, breakpoint }] — no approve checkbox:
//                 a failure is not an approvable change.
//   multiBreakpoint  boolean — drives per-breakpoint detail rows + labels.
//   runUrl        the workflow-run URL for the fallback link
//   shortCircuit  optional { sha } — when present, the run was skipped because
//                 the triggering commit only promotes already-approved
//                 baselines. Renders a compact body (marker + header + pass +
//                 one explanatory line naming the reviewed commit + run link)
//                 and returns early. Carries NO approve markers of any kind:
//                 nothing is pending, so there is nothing to tick.
function buildCommentBody({
  outcome,
  counts,
  envMismatch,
  mismatchKeys,
  previewUrl,
  changed,
  added,
  deleted,
  failed,
  multiBreakpoint,
  runUrl,
  shortCircuit,
}) {
  // Short-circuit: skip the full totals/sections layout entirely. Deliberately
  // emits neither the top-level `tuffgal-approve-box` nor any per-item
  // `tuffgal-approve-item:` marker — a stray marker on a nothing-pending comment
  // could be mistaken for something tickable.
  if (shortCircuit) {
    const shortSha = String(shortCircuit.sha || "").slice(0, 7);
    return [
      MARKER,
      "## 👁️ Tuffgal visual regression",
      "",
      "Outcome: **pass**",
      "",
      `✅ Baselines approved — the visual suite was skipped because this commit only promotes the baselines already reviewed in \`${shortSha}\`. Later pushes will run the suite normally.`,
      "",
      `[View the run →](${runUrl})`,
    ].join("\n");
  }

  const reportUrl = previewUrl ? `${previewUrl}/report/index.html` : null;
  const storyLink = (entry) =>
    reportUrl ? `${reportUrl}#story-${entry.index}` : null;
  const pending =
    (Number(counts.new) || 0) +
      (Number(counts.changed) || 0) +
      (Number(counts.deleted) || 0) >
    0;

  const lines = [];
  lines.push(MARKER);
  lines.push("## 👁️ Tuffgal visual regression");
  lines.push("");
  lines.push(`Outcome: **${outcome}**`);
  lines.push("");
  if (envMismatch) {
    for (const line of renderEnvMismatchBanner(mismatchKeys)) lines.push(line);
    lines.push("");
  }
  for (const line of renderTotalsTable(counts)) lines.push(line);
  lines.push("");

  for (const line of renderChangedSection(changed, { previewUrl, multiBreakpoint, storyLink })) lines.push(line);
  for (const line of renderAddedSection(added, { previewUrl, multiBreakpoint, storyLink })) lines.push(line);
  for (const line of renderDeletedSection(deleted, { multiBreakpoint, reportUrl })) lines.push(line);
  for (const line of renderFailedSection(failed, { multiBreakpoint, storyLink })) lines.push(line);

  // Name the concrete next step for the two outcomes that otherwise fall to a
  // bare run link, matching the tone of the approve preflight's messages.
  if (ACTIONABLE[outcome]) {
    lines.push(ACTIONABLE[outcome]);
    lines.push("");
  }

  if (pending) {
    // The CTA section heading. The approve action's
    // approve/scripts/report-comment.js keeps a HAND-DUPLICATED byte-identical
    // copy of this literal as its CTA_HEADING, which its stripApproveCta matches
    // to remove the whole CTA on a full approve — it lives in a SEPARATE action
    // package that cannot cross-require this one — so keep the two byte-identical.
    lines.push("### Approve these changes");
    lines.push("");
    if (reportUrl) {
      lines.push(
        `📊 [Open the full report](${reportUrl}) — scrolls to each changed story with screenshots expanded.`
      );
      lines.push("");
    }
    // Primary one-click path: tick the box. The approve workflow (see
    // examples/tuffgal-approve.yml) fires on the `edited` event, verifies the
    // ticker has write access, and promotes the candidate baselines. The literal
    // `<!-- tuffgal-approve-box -->` marker is what that workflow greps for, so
    // the checkbox can never be confused with an unrelated task list a reviewer
    // adds elsewhere.
    lines.push(
      "- [ ] <!-- tuffgal-approve-box --> **Approve these baselines** — tick to commit the candidate baselines to this PR (requires write access)."
    );
    lines.push("");
    lines.push(
      "…or comment `@tuffgal approve`. Prefer a local checkout? Download the `tuffgal-candidates` artifact from the run and run `npx tuffgal approve --from <extracted-dir> --prune`, then commit the updated baselines directory."
    );
    lines.push("");
    lines.push(`[View the run →](${runUrl})`);
  } else if (reportUrl) {
    lines.push(
      `[Open the report →](${reportUrl}) · [View the run →](${runUrl})`
    );
  } else {
    lines.push(`[View the run →](${runUrl})`);
  }

  return lines.join("\n");
}

module.exports = {
  MARKER,
  ACTION_NAME_PATTERN,
  approveItemMarker,
  buildCommentBody,
  renderEnvMismatchBanner,
  renderTotalsTable,
};
