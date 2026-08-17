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

// Per-item approve marker: the entry's candidate-tree keys, comma-joined into an
// HTML comment that `resolve-approver.js` regex-extracts straight back out. The
// `:` prefix keeps it from matching the master box's grep. Keys are
// allowlist-filtered before the join, so a malformed one never reaches the
// comment; an empty result renders an empty payload, never a broken marker.
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

// One per-item approve checkbox line, deliberately OUTSIDE the entry's
// `<details>`: a checkbox toggled inside one bubbles its click to the collapsible
// and snaps it shut. Trailing suffixes are free text to the trigger parser, which
// matches only the marker and the tick state.
//
// approve-cta.js's `applyPartialApproval` READS this line, keying its relabel off
// the ` Approve **name**` shape — keep the two in step.
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
