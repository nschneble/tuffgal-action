'use strict';
//
// The status blocks the approve flow writes into the sticky comment as it runs.
// Box locking lives in the sibling approve-lock.js; the API calls stay inline.
//
// LOST-UPDATE. GitHub's comment API has no ETag / If-Match, so every write is
// last-writer-wins against a body read moments earlier. The refusal path re-reads
// immediately before writing; the rest rely on the consumer's per-PR concurrency
// group.
//
// LOOP SAFETY (load-bearing). The consumer workflow retriggers on an `edited`
// event whose body carries a TICKED approve marker, so every body handed back here
// must carry them UNTICKED or the bot re-fires the approve workflow on its own
// edit. `untickApproveBoxes` is that transform; `hasTickedApproveMarker` is the
// predicate action.yml asserts before every write.

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

// Delimiters for the queued-request note — a block of its OWN, written directly
// after the status block. Deliberately not part of the status block: the running
// job rewrites that block at each phase, which would wipe a note the running job
// never knew was added. This block is written by the REFUSED job and cleared by
// the running job when it reaches a terminal state.
const QUEUED_OPEN = '<!-- tuffgal-approve-queued -->';
const QUEUED_CLOSE = '<!-- /tuffgal-approve-queued -->';

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

// Insert or replace a delimited block, anchored after `anchor` on first insert.
// Shared by the status banner and the queued-request note, which differ only in
// their delimiters and where they first land.
function withBlock(body, open, close, lines, anchor) {
  const text = asString(body);
  const content = (Array.isArray(lines) ? lines : [lines]).map(asString);
  const block = [open, ...content, close].join('\n');

  // Replace an existing block in place. A function replacer keeps `block`
  // literal (no `$`-pattern interpretation).
  if (text.includes(open) && text.includes(close)) {
    const region = new RegExp(escapeRegExp(open) + '[\\s\\S]*?' + escapeRegExp(close));
    return text.replace(region, () => block);
  }

  // First insertion: drop the block right after the anchor line, blank-line
  // padded so the surrounding markdown still renders.
  const bodyLines = text.split('\n');
  const anchorIndex = bodyLines.findIndex((line) => line.includes(anchor));
  if (anchorIndex === -1) {
    // Defensive: the caller only ever passes a real report body, but never
    // silently drop the block if the anchor is somehow absent.
    return [block, '', text].join('\n');
  }
  bodyLines.splice(anchorIndex + 1, 0, '', block, '');
  return bodyLines.join('\n');
}

// Remove a delimited block and the blank line padding the insert added.
function withoutBlock(body, open, close) {
  const text = asString(body);
  if (!text.includes(open) || !text.includes(close)) {
    return text;
  }
  const region = new RegExp('\\n*' + escapeRegExp(open) + '[\\s\\S]*?' + escapeRegExp(close) + '\\n*');
  return text.replace(region, '\n\n');
}

// Note that a further approval was requested while this one was running, written
// as its own block directly under the status banner (see QUEUED_OPEN). Written by
// the REFUSED job; the running job clears it via `clearQueuedNote` when it
// finishes, so the note never outlives the run it was queued behind. Repeated
// refusals replace the note rather than stacking.
function withQueuedNote(body, lines) {
  const anchor = asString(body).includes(STATUS_CLOSE) ? STATUS_CLOSE : REPORT_MARKER;
  return withBlock(body, QUEUED_OPEN, QUEUED_CLOSE, lines, anchor);
}

function clearQueuedNote(body) {
  return withoutBlock(body, QUEUED_OPEN, QUEUED_CLOSE);
}

// Insert (or, on a repeated call within one approve run, REPLACE) a status banner
// block delimited by STATUS_OPEN / STATUS_CLOSE, immediately after the
// REPORT_MARKER line so it is the first visible content. `lines` is an array of
// markdown lines (a single string is accepted too). Idempotent across the
// in-flight -> milestone -> final lifecycle: when the delimiters already exist the
// content between them is swapped in place — never duplicated — and the banner
// stays anchored where the first insert placed it (right after the marker).
function withStatusBanner(body, lines) {
  return withBlock(body, STATUS_OPEN, STATUS_CLOSE, lines, REPORT_MARKER);
}

module.exports = {
  REPORT_MARKER,
  STATUS_OPEN,
  STATUS_CLOSE,
  QUEUED_OPEN,
  QUEUED_CLOSE,
  TRIGGER_SUBSTRINGS,
  untickApproveBoxes,
  hasTickedApproveMarker,
  withQueuedNote,
  clearQueuedNote,
  withStatusBanner,
};
