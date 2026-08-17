"use strict";
//
// The approve affordances the sticky comment carries: the per-item marker whose
// payload `resolve-approver.js` parses back out, the checkbox line wrapping it,
// and the action-key allowlist both are filtered through.
//
// LOOP SAFETY. Every box this module renders is UNTICKED. A ticked one in a
// bot-authored body would re-fire the consumer's approve workflow on the bot's
// own edit.

const { escapeHtml } = require("./comment-markup.js");
const { isA11yOnlyEntry } = require("./comment-a11y.js");

// The action-key allowlist, applied on the WRITE side so a malformed key never
// even reaches the rendered marker. Intentionally hand-duplicated (not imported)
// from `approve/scripts/filter-candidates.js`'s `ACTION_NAME_PATTERN`: that lives
// in a SEPARATE action package which this one can't cross-require. The two copies
// are pinned byte-equal by a test in filter-candidates.test.js.
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
//
// The approve action's `report-comment.js` `applyPartialApproval` also READS this
// line on a partial approve: it detects an item box by the marker (the
// load-bearing part), then relabels an approved one to
// `- ✅ Approved **name** (suffix)`, keying the label off the ` Approve ` prefix +
// the `**name**` wrapper rendered here. Keep this ` Approve **name**` prose +
// suffix layout in step with that reader — the same cross-file read-dependency
// precedent as resolve-approver.js reading the marker above.
const approveItemCheckbox = (entry, multiBreakpoint) => {
  let line = `- [ ] ${approveItemMarker(entry.actionKeys)} Approve **${escapeHtml(
    entry.name
  )}**`;
  if (multiBreakpoint) {
    const bps = distinctBreakpoints(entry.shots);
    if (bps.length) line += ` (${bps.map(escapeHtml).join(", ")})`;
  }
  // Free text to the trigger parser, exactly like the breakpoint suffix above.
  if (isA11yOnlyEntry(entry)) line += " — a11y only";
  return line;
};

module.exports = {
  ACTION_NAME_PATTERN,
  APPROVE_ITEM_MARKER_PREFIX,
  approveItemMarker,
  approveItemCheckbox,
  distinctBreakpoints,
};
