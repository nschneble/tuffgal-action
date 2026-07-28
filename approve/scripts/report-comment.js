'use strict';
//
// Pure, unit-testable helpers for the approve flow's LIVE sticky-comment status
// edits. As an approval runs (permission gate -> candidate fetch -> commit), the
// bot rewrites the SAME `<!-- tuffgal-report -->` sticky comment through
// in-flight -> milestone -> final banners so a maintainer watching the PR sees
// progress instead of a frozen comment. Extracted out of the inline
// `actions/github-script` blocks in approve/action.yml so the loop-safety-critical
// body transforms are exercised by a `node --test` suite — the same
// extract-and-unit-test precedent set by the sibling resolve-approver.js /
// check-shortcut.js modules. The GitHub API side (listComments / getComment /
// updateComment) stays inline in action.yml.
//
// LOOP SAFETY (load-bearing). The consumer's tuffgal-approve workflow retriggers
// on an `issue_comment: edited` whose body contains a TICKED approve marker (see
// examples/tuffgal-approve.yml's `if:`). Every body this module hands back for a
// comment edit MUST carry ALL approve markers in their UNTICKED `[ ]` form, or the
// bot could edit its own comment into a shape that re-fires the approve workflow
// on itself — an infinite loop. `untickApproveBoxes` is that transform;
// `hasTickedApproveMarker` is the defensive predicate action.yml asserts against
// the outgoing body before every write. (A second, independent barrier — using the
// default GITHUB_TOKEN for these edits, which GitHub does not fire workflow events
// for — lives in action.yml.)

// The sticky report comment's marker line. HAND-DUPLICATED, byte-for-byte, from
// `scripts/build-comment.js`'s `MARKER` constant, which lives in the SEPARATE
// main-action package this module cannot cross-require (the same documented
// hand-duplication precedent build-comment.js itself uses for its own
// cross-package constants). Keep byte-identical to that copy.
const REPORT_MARKER = '<!-- tuffgal-report -->';

// Delimiters bounding the injected status banner. Placed immediately after the
// REPORT_MARKER line so the banner is the first visible thing in the comment. The
// close marker's leading slash keeps it distinct from the open so the replace
// regex below can never mismatch one for the other.
const STATUS_OPEN = '<!-- tuffgal-approve-status -->';
const STATUS_CLOSE = '<!-- /tuffgal-approve-status -->';

// The `### Approve these changes` CTA section heading (see build-comment.js
// buildCommentBody). On a FULL approve the whole CTA section — heading, the
// approve-all box, and everything after it (it is always the tail section) — is
// stripped, because there is nothing left to approve.
const CTA_HEADING = '### Approve these changes';

// Ticked approve boxes, in the SAME syntactic shapes resolve-approver.js reads
// (its `isMasterBox` and `CHECKED_ITEM_BOX` regexes). Capturing groups wrap
// everything AROUND the tick state so an unticking replace preserves the marker
// comment and the exact surrounding spacing byte-for-byte, and any trailing text
// after `-->` (a story name, or a `(mobile, desktop)` multi-breakpoint suffix)
// is never in the match, so it is left completely untouched. Global so a single
// `.replace` rewrites every occurrence.
const TICKED_APPROVE_ALL = /(-\s*\[)[xX](\]\s*<!--\s*tuffgal-approve-box\s*-->)/g;
const TICKED_APPROVE_ITEM = /(-\s*\[)[xX](\]\s*<!--\s*tuffgal-approve-item:[a-z0-9,-]*\s*-->)/g;

// Non-global detection twins of the two regexes above (a global regex is stateful
// under `.test`, so detection uses its own instances). These match exactly what
// resolve-approver.js would treat as a ticked trigger.
const HAS_TICKED_APPROVE_ALL = /-\s*\[[xX]\]\s*<!--\s*tuffgal-approve-box\s*-->/;
const HAS_TICKED_APPROVE_ITEM = /-\s*\[[xX]\]\s*<!--\s*tuffgal-approve-item:[a-z0-9,-]*\s*-->/;

// The four literal substrings the CONSUMER'S trigger workflow prefilters on
// (examples/tuffgal-approve.yml's `if:`). HAND-DUPLICATED from that file: the
// workflow fires — spending a job run — the instant a body contains any of these,
// BEFORE resolve-approver.js gets a vote. So the true loop trigger is these
// literals, and the defensive predicate keys on them directly (in addition to the
// parser regexes above) so it can never green-light a body that would re-fire the
// workflow. Keep byte-identical to that `if:` condition.
const TRIGGER_SUBSTRINGS = [
  '[x] <!-- tuffgal-approve-box',
  '[X] <!-- tuffgal-approve-box',
  '[x] <!-- tuffgal-approve-item:',
  '[X] <!-- tuffgal-approve-item:',
];

const asString = (value) => String(value == null ? '' : value);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Rewrite every TICKED approve box (approve-all or per-item, `[x]` or `[X]`) to
// its UNTICKED `[ ]` form, leaving the marker comment and any trailing text
// untouched. Idempotent: an already-unticked box has no `[xX]` to match, so a
// second pass is a no-op. Only the two approve markers are touched — an unrelated
// task-list checkbox elsewhere in the body (there shouldn't be one in this
// bot-authored comment, but be precise) is never rewritten.
function untickApproveBoxes(body) {
  return asString(body).replace(TICKED_APPROVE_ALL, '$1 $2').replace(TICKED_APPROVE_ITEM, '$1 $2');
}

// True when the body still carries ANY ticked approve marker — in EITHER the
// parser's regex shape (would make resolve-approver.js proceed) OR one of the
// consumer prefilter's literal substrings (would fire the trigger workflow's
// `if:`). The union is deliberate: it is the complete "would this body risk a
// retrigger?" question. action.yml asserts `!hasTickedApproveMarker(newBody)`
// before every comment write and skips the write if it ever trips.
function hasTickedApproveMarker(body) {
  const text = asString(body);
  if (HAS_TICKED_APPROVE_ALL.test(text) || HAS_TICKED_APPROVE_ITEM.test(text)) {
    return true;
  }
  return TRIGGER_SUBSTRINGS.some((substring) => text.includes(substring));
}

// Insert (or, on a repeated call within one approve run, REPLACE) a status banner
// block delimited by STATUS_OPEN / STATUS_CLOSE, immediately after the
// REPORT_MARKER line so it is the first visible content. `lines` is an array of
// markdown lines (a single string is accepted too). Idempotent across the
// in-flight -> milestone -> final lifecycle: when the delimiters already exist the
// content between them is swapped in place — never duplicated — and the banner
// stays anchored where the first insert placed it (right after the marker).
function withStatusBanner(body, lines) {
  const text = asString(body);
  const content = (Array.isArray(lines) ? lines : [lines]).map(asString);
  const block = [STATUS_OPEN, ...content, STATUS_CLOSE].join('\n');

  // Replace an existing banner in place. A function replacer keeps `block`
  // literal (no `$`-pattern interpretation).
  if (text.includes(STATUS_OPEN) && text.includes(STATUS_CLOSE)) {
    const region = new RegExp(escapeRegExp(STATUS_OPEN) + '[\\s\\S]*?' + escapeRegExp(STATUS_CLOSE));
    return text.replace(region, () => block);
  }

  // First insertion: drop the block right after the marker line, blank-line
  // padded so the surrounding markdown still renders.
  const bodyLines = text.split('\n');
  const markerIndex = bodyLines.findIndex((line) => line.includes(REPORT_MARKER));
  if (markerIndex === -1) {
    // Defensive: the caller only ever passes a real report body, but never
    // silently drop the banner if the marker is somehow absent.
    return [block, '', text].join('\n');
  }
  bodyLines.splice(markerIndex + 1, 0, '', block, '');
  return bodyLines.join('\n');
}

// Strip the entire `### Approve these changes` CTA section — the heading, the
// approve-all box, and everything after it. buildCommentBody always emits this
// section LAST, so removing from the heading to the end of the body drops the
// whole CTA. The blank line(s) that preceded the heading are trimmed too so the
// body ends cleanly. Idempotent: with the heading already gone, a second call is a
// no-op. Only ever called on a FULL approve, where nothing is left to approve.
function stripApproveCta(body) {
  const text = asString(body);
  const bodyLines = text.split('\n');
  const headingIndex = bodyLines.findIndex((line) => line.trim() === CTA_HEADING);
  if (headingIndex === -1) {
    return text;
  }
  let end = headingIndex;
  while (end > 0 && bodyLines[end - 1].trim() === '') {
    end -= 1;
  }
  return bodyLines.slice(0, end).join('\n');
}

module.exports = {
  REPORT_MARKER,
  STATUS_OPEN,
  STATUS_CLOSE,
  TRIGGER_SUBSTRINGS,
  untickApproveBoxes,
  hasTickedApproveMarker,
  withStatusBanner,
  stripApproveCta,
};
