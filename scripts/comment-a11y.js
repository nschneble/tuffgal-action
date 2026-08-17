"use strict";
//
// The accessibility-drift half of the sticky comment: recognizing an entry whose
// pixels matched, and rendering the `a11y.yaml` line diff that stands in for the
// thumbnails it would otherwise show.

const { escapeHtml } = require("./comment-markup.js");

// An entry whose every drifted shot was an accessibility-snapshot drift with
// matching pixels. build-stories.js sets `a11yOnly` per shot and owns that
// discriminator.
const isA11yOnlyEntry = (entry) => {
  const shots = (entry && entry.shots) || [];
  return shots.length > 0 && shots.every((shot) => shot && shot.a11yOnly);
};

// The rendered diff budget for ONE shot in a comment. tuffgal already clips its
// payload; this is the tighter comment-side ceiling, since a run can carry many
// drifted stories and the whole body shares one comment.
const MAX_A11Y_DIFF_LINES = 20;

// A fenced ```diff block for one shot's a11y drift, or an italic line when the
// result carried no diff (an older tuffgal, or snapshots too large to diff
// line-by-line — in which case the recorded counts still name the change).
//
// The fence is grown past the longest backtick run in the content, so a snapshot
// carrying a literal ``` in an accessible name cannot break out of the block.
function renderA11yDiff(diff) {
  const all = (diff && diff.lines) || [];
  if (!all.length) {
    const size =
      diff && (diff.added || diff.removed)
        ? ` (${diff.added} added, ${diff.removed} removed)`
        : "";
    return [`_No line diff available${size} — open the report for the full snapshot._`];
  }
  const clipped = all.slice(0, MAX_A11Y_DIFF_LINES);
  const longestRun = clipped.reduce((longest, line) => {
    const runs = String(line).match(/`+/g) || [];
    return runs.reduce((max, run) => Math.max(max, run.length), longest);
  }, 2);
  const fence = "`".repeat(longestRun + 1);
  const out = [`${fence}diff`, ...clipped, fence];
  if (all.length > clipped.length || (diff && diff.truncated)) {
    out.push("");
    // The counts are optional on the payload (see the no-lines branch above), so
    // a clipped render states the full size only when it actually has one —
    // never `undefined added, undefined removed`.
    out.push(
      diff.added === undefined || diff.removed === undefined
        ? "_Diff clipped — open the report for the full snapshot._"
        : `_Diff clipped — ${diff.added} added, ${diff.removed} removed in full._`
    );
  }
  return out;
}

module.exports = { MAX_A11Y_DIFF_LINES, isA11yOnlyEntry, renderA11yDiff };
