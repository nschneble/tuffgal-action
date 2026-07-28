"use strict";
//
// Pure, unit-testable builder for the sticky PR comment body. Given the pieces
// the `Post sticky PR comment` step has already computed — the parsed outcome +
// counts, the env-mismatch flag and keys, the (possibly empty) preview URL, the
// per-story per-breakpoint image URLs read out of results.json, and whether the
// run spanned more than one breakpoint — it returns the final markdown `body`
// string. Extracted out of the inline `actions/github-script`
// block so the branch matrix (preview vs none, changed/new/deleted/failed
// sections, env-mismatch banner, approve CTA, pass/failed/no-results outcomes,
// and the compact short-circuit skipped-suite body) is covered
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
// duplicated at the call site. The approve action's
// approve/scripts/report-comment.js keeps a HAND-DUPLICATED byte-identical copy
// of this literal as its REPORT_MARKER — it lives in a SEPARATE action package
// that cannot cross-require this one — so keep the two byte-identical.
const MARKER = "<!-- tuffgal-report -->";

// The action-key allowlist, applied on the WRITE side so a malformed key never
// even reaches the rendered marker. Intentionally hand-duplicated (not imported)
// from `approve/scripts/filter-candidates.js`'s `ACTION_NAME_PATTERN` because
// that lives in a SEPARATE action package which this module can't cross-require —
// the same hand-duplication precedent already used for `MARKER` and the other
// cross-package constants in this repo. Keep byte-identical to that copy.
const ACTION_NAME_PATTERN = /^[a-z0-9-]+$/;

// Per-item approve marker. Each Changed/New baseline entry gets its own GFM
// task-list checkbox carrying this marker with the entry's candidate-tree
// action keys embedded directly in the HTML comment — comma-joined, each key
// matching `[a-z0-9-]+` so the join is unambiguous to split back apart. The
// trigger parser (`resolve-approver.js`) regex-extracts `(marker keys) +
// (ticked state)` per line straight from the comment body, with no external
// index/lookup table. The `:` prefix keeps it distinct from the master
// `<!-- tuffgal-approve-box -->` box so neither grep can match the other. Keys
// are allowlist-filtered before the join (defense in depth, not trust in the
// upstream `keysAt` caller), so a malformed key never reaches the comment; an
// empty result renders an empty payload (`tuffgal-approve-item:`), never a
// malformed marker.
const APPROVE_ITEM_MARKER_PREFIX = "tuffgal-approve-item:";
const approveItemMarker = (actionKeys) =>
  `<!-- ${APPROVE_ITEM_MARKER_PREFIX}${(actionKeys || [])
    .filter((key) => typeof key === "string" && ACTION_NAME_PATTERN.test(key))
    .join(",")} -->`;

// The distinct, non-empty breakpoint names an entry drifted at, in first-seen
// order. Drives both the multi-breakpoint checkbox suffix and (via the caller)
// the per-breakpoint detail rows. Empty for a single-config/legacy run whose
// actions carry no `breakpoint`.
const distinctBreakpoints = (shots) => {
  const out = [];
  for (const shot of shots || []) {
    if (shot && shot.breakpoint && !out.includes(shot.breakpoint)) {
      out.push(shot.breakpoint);
    }
  }
  return out;
};

// One per-item approve checkbox line. Rendered as a top-level task-list item
// (not nested inside the entry's `<details>`) on purpose: a checkbox toggled
// inside a `<details>` bubbles its click to the collapsible and snaps it shut,
// so the interactive box lives on its own line above the thumbnails.
//
// In multi-breakpoint mode a plain-text `(mobile, desktop)` suffix naming the
// drifted breakpoints is appended AFTER the marker + tick-box. That suffix is
// free text to `resolve-approver.js`'s `CHECKED_ITEM_BOX` regex, which matches
// only the literal marker through its `-->` and the tick state — never trailing
// text — so the suffix can never perturb which keys a ticked box approves.
const approveItemCheckbox = (entry, multiBreakpoint) => {
  let line = `- [ ] ${approveItemMarker(entry.actionKeys)} Approve **${escapeHtml(
    entry.name
  )}**`;
  if (multiBreakpoint) {
    const bps = distinctBreakpoints(entry.shots);
    if (bps.length) line += ` (${bps.map(escapeHtml).join(", ")})`;
  }
  return line;
};

// Escape text for HTML flow content (story names in a <summary>).
const escapeHtml = (text) =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// Escape text for an HTML attribute value (the <img> src URL and alt text).
// Extends the flow escape with `"` so a value carrying a double quote — a
// crafted story name in the alt, or a stray quote in an image path in the src —
// can't break out of the attribute. Cosmetic markdown-injection hardening.
const escapeAttribute = (text) => escapeHtml(text).replace(/"/g, "&quot;");

// The character budget for a rendered failure message in the Failed section.
// Long harness/Playwright errors get clipped to keep the comment scannable; the
// full message stays in the linked report and the `tuffgal-report` artifact.
const MAX_FAILURE_MESSAGE = 140;

// Normalize a story's failure message for one-line rendering: collapse every
// whitespace run (newlines, tabs, indentation) to a single space, trim, clip to
// the budget with an ellipsis marker, then HTML-escape. Escaping happens LAST so
// the clip can never split a `&lt;`-style entity mid-sequence.
const failureMessage = (message) => {
  const oneLine = String(message == null ? "" : message)
    .replace(/\s+/g, " ")
    .trim();
  const clipped =
    oneLine.length > MAX_FAILURE_MESSAGE
      ? oneLine.slice(0, MAX_FAILURE_MESSAGE).trimEnd() + "…"
      : oneLine;
  return escapeHtml(clipped);
};

// One inline thumbnail, or an italic placeholder when its preview URL is null
// (preview off, or the image lives under neither report nor baselines root).
const thumbnail = (url, label) =>
  url
    ? `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(
        label
      )}" width="260">`
    : `<em>${escapeHtml(label)} unavailable</em>`;

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
//   changed       [{ index, name, shots, actionKeys }] — `shots` is one entry
//                 per drifted breakpoint: { breakpoint, baseline, actual } with
//                 image URLs or null. Single-breakpoint/legacy runs carry one
//                 shot (breakpoint absent) and render `shots[0]` exactly as
//                 before; multi-breakpoint runs render one detail row per shot.
//                 actionKeys is the story's changed candidate-tree keys.
//   added         [{ index, name, shots, actionKeys }] — same shape; each shot's
//                 `actual` is the proposed baseline (no `baseline` — none exists
//                 yet). actionKeys is the story's new keys.
//   deleted       [{ name, breakpoints }] — one entry per removed story/action
//                 (grouped across breakpoints, so a multi-breakpoint deletion is
//                 listed once, not once per breakpoint). `breakpoints` is the
//                 breakpoint names it was removed at; rendered only in
//                 multi-breakpoint mode.
//   failed        [{ index, name, message, breakpoint }] — hard-failed stories
//                 with the first failed action's failure message (already
//                 collapsed to one line at the call site, re-normalized +
//                 truncated here) and that action's breakpoint (labelled only in
//                 multi-breakpoint mode). No approve checkbox: a failure is not
//                 an approvable change.
//   multiBreakpoint  boolean — true when this run spans more than one distinct
//                 breakpoint. Drives per-breakpoint detail rows + labels; false
//                 (the common single-config case, and legacy artifacts with no
//                 `breakpoint` field) renders byte-identically to the prior
//                 single-representative-shot output.
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

  // Changed: with a preview, each story is a collapsible carrying inline
  // baseline / actual thumbnails plus a deep-link that opens the report
  // scrolled to that story with its screenshots (including the full diff)
  // expanded. Without a preview,
  // fall back to a plain name list. The alt text threads the story name so a
  // screen-reader user gets per-image context in a multi-story comment.
  if (changed.length) {
    lines.push(`### Changed (${changed.length})`);
    lines.push("");
    for (const entry of changed) {
      lines.push(approveItemCheckbox(entry, multiBreakpoint));
      if (previewUrl) {
        lines.push("<details>");
        lines.push(`<summary>${escapeHtml(entry.name)}</summary>`);
        lines.push("");
        if (multiBreakpoint) {
          // One row per drifted breakpoint, each labelled with its mode name.
          lines.push("| Breakpoint | Baseline | Actual |");
          lines.push("|---|---|---|");
          for (const shot of entry.shots || []) {
            lines.push(
              `| ${escapeHtml(
                shot.breakpoint == null ? "" : shot.breakpoint
              )} | ${thumbnail(
                shot.baseline,
                `baseline for ${entry.name}`
              )} | ${thumbnail(shot.actual, `actual for ${entry.name}`)} |`
            );
          }
        } else {
          // Single representative shot — byte-identical to the pre-breakpoint
          // two-column table.
          const shot = (entry.shots && entry.shots[0]) || {};
          lines.push("| Baseline | Actual |");
          lines.push("|---|---|");
          lines.push(
            `| ${thumbnail(
              shot.baseline,
              `baseline for ${entry.name}`
            )} | ${thumbnail(shot.actual, `actual for ${entry.name}`)} |`
          );
        }
        lines.push("");
        lines.push(
          `[Open ${escapeHtml(entry.name)} in report →](${storyLink(entry)})`
        );
        lines.push("</details>");
        lines.push("");
      }
    }
    lines.push("");
  }

  // New: no prior baseline to compare, so show the proposed one (the run's
  // actual = the candidate) inline.
  if (added.length) {
    lines.push(`### New (${added.length})`);
    lines.push("");
    for (const entry of added) {
      lines.push(approveItemCheckbox(entry, multiBreakpoint));
      if (previewUrl) {
        lines.push("<details>");
        lines.push(`<summary>${escapeHtml(entry.name)}</summary>`);
        lines.push("");
        if (multiBreakpoint) {
          // One actual-only row per breakpoint — there is no prior baseline.
          lines.push("| Breakpoint | Actual |");
          lines.push("|---|---|");
          for (const shot of entry.shots || []) {
            lines.push(
              `| ${escapeHtml(
                shot.breakpoint == null ? "" : shot.breakpoint
              )} | ${thumbnail(
                shot.actual,
                `proposed baseline for ${entry.name}`
              )} |`
            );
          }
        } else {
          const shot = (entry.shots && entry.shots[0]) || {};
          lines.push(
            `Proposed new baseline: ${thumbnail(
              shot.actual,
              `proposed baseline for ${entry.name}`
            )}`
          );
        }
        lines.push("");
        lines.push(
          `[Open ${escapeHtml(entry.name)} in report →](${storyLink(entry)})`
        );
        lines.push("</details>");
        lines.push("");
      }
    }
    lines.push("");
  }

  if (deleted.length) {
    lines.push(`### Deleted (${deleted.length})`);
    for (const entry of deleted) {
      let line = `- ${escapeHtml(String(entry.name).replace(/[\r\n]+/g, " "))}`;
      // In multi-breakpoint mode, name the breakpoints the story was removed at.
      // The entries are grouped by story/action upstream, so a story dropped at
      // N breakpoints is listed ONCE with all its breakpoints — not N times.
      if (multiBreakpoint && entry.breakpoints && entry.breakpoints.length) {
        line += ` — ${entry.breakpoints.map(escapeHtml).join(", ")}`;
      }
      lines.push(line);
    }
    // With a preview, link the report's stable deleted-baselines heading. The
    // report renders a single `<h2 id="deleted-heading">`, not per-name anchors,
    // so this is one section-level link, never one per deleted story.
    if (reportUrl) {
      lines.push("");
      lines.push(
        `[View deleted baselines in report →](${reportUrl}#deleted-heading)`
      );
    }
    lines.push("");
  }

  // Failed: hard failures, listed after Deleted to mirror the totals-table row
  // order (Pass, Changed, New, Deleted, Failed, Total). Each is a plain bullet —
  // name, the normalized/truncated failure message, and a report deep-link when
  // a preview exists. Deliberately NO approve checkbox: a failure isn't an
  // approvable baseline change, and `pending` (the approve-CTA gate) counts only
  // new/changed/deleted, so a failed-only run never offers approval.
  if (failed.length) {
    lines.push(`### Failed (${failed.length})`);
    lines.push("");
    for (const entry of failed) {
      const message = failureMessage(entry.message);
      const link = storyLink(entry);
      let line = `- **${escapeHtml(entry.name)}**`;
      // In multi-breakpoint mode, name which breakpoint failed right after the
      // story name; single-breakpoint mode stays label-free (pre-breakpoint output).
      if (multiBreakpoint && entry.breakpoint) {
        line += ` (${escapeHtml(entry.breakpoint)})`;
      }
      if (message) line += ` — ${message}`;
      if (link)
        line += ` [Open ${escapeHtml(entry.name)} in report →](${link})`;
      lines.push(line);
    }
    lines.push("");
  }

  // Name the concrete next step for the two outcomes that otherwise fall to a
  // bare run link, matching the tone of the approve preflight's messages.
  if (ACTIONABLE[outcome]) {
    lines.push(ACTIONABLE[outcome]);
    lines.push("");
  }

  if (pending) {
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
  approveItemMarker,
  buildCommentBody,
  renderEnvMismatchBanner,
  renderTotalsTable,
};
