'use strict';
//
// Pure, unit-testable helpers for the approve flow's LIVE sticky-comment status
// edits. As an approval runs (permission gate -> candidate fetch -> commit), the
// bot rewrites the SAME `<!-- tuffgal-report -->` sticky comment through
// in-flight -> milestone -> final banners so a maintainer watching the PR sees
// progress instead of a frozen comment. For the duration it also LOCKS every
// approve box (see lockApproveBoxes) so nothing in the comment can start a second
// approval against a branch this run is already committing to, and stamps the
// running job's id into the banner so a trigger that lands mid-run can refuse
// itself (inFlightRunId) and say so (withQueuedNote). Extracted out of the inline
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

// Rendered as the first line INSIDE the status block by the two in-flight phases
// (in-flight, milestone) and by NEITHER terminal banner. Its presence in a body
// is the "an approval is running right now" signal a second trigger reads to
// refuse itself, so it lives and dies with the phase banner that carries it: the
// terminal write replaces the whole block, taking the marker with it.
//
// It carries the OWNING run's id, digits only. A cancelled job runs no terminal
// step, so without the id a killed run would leave a lock nothing could clear and
// every later approval would refuse itself forever. With it, the refusing job
// asks the API whether that run is still going and takes the lock when it is not.
const IN_FLIGHT_MARKER_PREFIX = '<!-- tuffgal-approve-inflight:';
const IN_FLIGHT_MARKER_RE = /<!--\s*tuffgal-approve-inflight:(\d+)\s*-->/;

const inFlightMarker = (runId) => `${IN_FLIGHT_MARKER_PREFIX}${String(runId).replace(/\D/g, '')} -->`;

// The id of the run currently holding the lock, or `null` when the body carries
// no in-flight marker. Callers treat a non-null id as "locked, unless that run has
// since finished".
function inFlightRunId(body) {
  const match = asString(body).match(IN_FLIGHT_MARKER_RE);
  return match ? match[1] : null;
}

// Delimiters for the queued-request note — a block of its OWN, written directly
// after the status block. Deliberately not part of the status block: the running
// job rewrites that block at each phase, which would wipe a note the running job
// never knew was added. This block is written by the REFUSED job and cleared by
// the running job when it reaches a terminal state.
const QUEUED_OPEN = '<!-- tuffgal-approve-queued -->';
const QUEUED_CLOSE = '<!-- /tuffgal-approve-queued -->';

// The inert stand-in for a checkbox while an approval is in flight. GitHub renders
// a task-list checkbox for `- [ ]` only; with the brackets gone the line is plain
// text, so there is nothing to click and no way to fire a second approval from a
// comment that is mid-run. The marker comment is left untouched, so the swap is
// reversible line-for-line (see unlockApproveBoxes) with no stashed state.
const LOCK_GLYPH = '⏳';

// Appended to the TOP-LEVEL box's line (only) while locked, so the inert control
// says why it is inert. Stripped byte-for-byte on unlock, which is why it is a
// literal rather than composed prose.
const LOCKED_BOX_SUFFIX = ' ⏳ Locked while an approval runs.';

// Approve boxes in ANY tick state (`[ ]`, `[x]`, `[X]`) — the lock's read side,
// which must catch a box the caller has not unticked yet. Group 1 is the leading
// `- `, group 2 the marker comment; the tick state between them is what the swap
// replaces. Non-global (a global regex is stateful under `.test`), applied per
// line, where at most one box can appear.
const ANY_APPROVE_ALL_BOX = /(-\s*)\[[ xX]\](\s*<!--\s*tuffgal-approve-box\s*-->)/;
const ANY_APPROVE_ITEM_BOX = /(-\s*)\[[ xX]\](\s*<!--\s*tuffgal-approve-item:[a-z0-9,-]*\s*-->)/;

// The same two lines in their LOCKED form — the unlock read side.
const LOCKED_APPROVE_ALL_BOX = new RegExp(`(-\\s*)${LOCK_GLYPH}(\\s*<!--\\s*tuffgal-approve-box\\s*-->)`);
const LOCKED_APPROVE_ITEM_BOX = new RegExp(
  `(-\\s*)${LOCK_GLYPH}(\\s*<!--\\s*tuffgal-approve-item:[a-z0-9,-]*\\s*-->)`
);

// The `### Approve these changes` CTA section heading. HAND-DUPLICATED,
// byte-for-byte, from `scripts/build-comment.js`'s buildCommentBody, which
// hardcodes this same heading for the CTA section it emits; that module lives in
// the SEPARATE main-action package this one cannot cross-require (the same
// documented hand-duplication precedent as REPORT_MARKER above). Keep
// byte-identical to that copy — stripApproveCta below matches this exact literal.
// On a FULL approve the whole CTA section — heading, the approve-all box, and
// everything after it (it is always the tail section) — is stripped, because there
// is nothing left to approve.
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

// A per-item box in its UNTICKED `[ ]` form — the loop-safe shape this module only
// ever hands back, and the state a body is in by the time applyPartialApproval runs
// (untickApproveBoxes has already normalized every box). Mirrors
// resolve-approver.js's CHECKED_ITEM_BOX read side (same
// `tuffgal-approve-item:([a-z0-9,-]*)` key capture), matched per line: group 1 is
// the leading indent, group 2 the marker's comma-joined key list, group 3 the text
// after the marker (the ` Approve **name**` label plus any breakpoint suffix,
// captured verbatim so it re-emits untouched). Not global: applied line-by-line.
const UNTICKED_ITEM_BOX = /^(\s*)-\s*\[ \]\s*<!--\s*tuffgal-approve-item:([a-z0-9,-]*)\s*-->(.*)$/;

// The top-level approve box in its UNTICKED form. Group 1 captures the marker +
// checkbox prefix VERBATIM so a relabel re-emits it byte-for-byte — the marker and
// its `[ ]` state must stay identical for the still-pending box to remain a valid
// re-trigger; group 2 is the human label text that a relabel replaces. `m` so `^`/
// `$` anchor per line when applied to the whole body.
const UNTICKED_APPROVE_BOX_LINE = /^(\s*-\s*\[ \]\s*<!--\s*tuffgal-approve-box\s*-->)(.*)$/m;

// The top-level box's human label after a partial approve leaves some items still
// pending. A deliberate VARIANT of build-comment.js's original
// "**Approve these baselines** — tick to commit the candidate baselines …" CTA
// line, narrowed to "remaining" — the marker + `[ ]` prefix is NOT part of this
// string; it is preserved untouched via UNTICKED_APPROVE_BOX_LINE's group 1, so
// only the human prose changes. Kept stylistically in step with that CTA wording.
const APPROVE_REMAINING_LABEL =
  ' **Approve remaining baselines** — tick to commit the remaining candidate baselines to this PR (requires write access).';

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

// Swap every approve box — top-level and per-item, in any tick state — for its
// inert LOCKED form, so a comment mid-approval offers nothing to click. Called on
// the way IN to each in-flight phase write; `unlockApproveBoxes` reverses it at
// every terminal state. Idempotent: an already-locked line has no `[…]` left to
// match, so the suffix is never appended twice.
//
// LOOP SAFETY. The locked form carries no checkbox syntax at all, so it satisfies
// `hasTickedApproveMarker` trivially and can never fire the consumer workflow's
// prefilter. Locking a still-TICKED box is therefore also a valid untick — but
// callers still untick first, so the two transforms stay independently correct.
function lockApproveBoxes(body) {
  return asString(body)
    .split('\n')
    .map((line) => {
      if (ANY_APPROVE_ITEM_BOX.test(line)) {
        return line.replace(ANY_APPROVE_ITEM_BOX, `$1${LOCK_GLYPH}$2`);
      }
      if (ANY_APPROVE_ALL_BOX.test(line)) {
        return line.replace(ANY_APPROVE_ALL_BOX, `$1${LOCK_GLYPH}$2`) + LOCKED_BOX_SUFFIX;
      }
      return line;
    })
    .join('\n');
}

// Restore every LOCKED approve box to its untickable `[ ]` form, dropping the
// top-level box's locked suffix. The inverse of lockApproveBoxes, and idempotent
// the same way. Every terminal path (success, already-up-to-date, failure) runs
// this so the comment is interactive again the moment nothing is in flight.
function unlockApproveBoxes(body) {
  return asString(body)
    .split('\n')
    .map((line) => {
      if (LOCKED_APPROVE_ITEM_BOX.test(line)) {
        return line.replace(LOCKED_APPROVE_ITEM_BOX, '$1[ ]$2');
      }
      if (LOCKED_APPROVE_ALL_BOX.test(line)) {
        const restored = line.replace(LOCKED_APPROVE_ALL_BOX, '$1[ ]$2');
        return restored.endsWith(LOCKED_BOX_SUFFIX)
          ? restored.slice(0, -LOCKED_BOX_SUFFIX.length)
          : restored;
      }
      return line;
    })
    .join('\n');
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

// After a PARTIAL approve, rewrite the sticky comment body so the just-approved
// per-item boxes become non-interactive "✅ Approved" lines and the top-level box
// reflects that only the remaining items are still pending. `approvedKeys` is the
// flat array of action keys this trigger approved — resolveApprover's `selection`
// for a partial per-item approve. It is NEVER 'all' here: a full approve (mention
// or top-level box) strips the whole CTA instead and never calls this. Runs AFTER
// untickApproveBoxes, so every box is already in its `[ ]` form.
//
//   - A per-item box whose EVERY marker key is present in `approvedKeys` (and that
//     carries at least one key — an empty-payload box approves nothing, mirroring
//     resolve-approver.js's "no keys, no trigger") is rewritten to
//     `- ✅ Approved **name** (suffix)`, dropping BOTH the checkbox and the marker
//     comment: an approved item leaves nothing to parse or re-trigger.
//   - A per-item box that is not (fully) approved is left completely untouched —
//     present, unticked, still re-tickable — exactly as untickApproveBoxes left it.
//   - When any per-item box remains, the top-level box keeps its marker + `[ ]`
//     state byte-identical and only its human label changes to "Approve remaining
//     baselines …". When NONE remains (a partial that happened to cover every
//     item), the whole CTA is stripped instead — the same terminal state a full
//     approve reaches — so no "remaining" label dangles over zero remaining items.
//
// LOOP SAFETY (load-bearing). An "✅ Approved" line carries neither the item marker
// nor any checkbox syntax, and the top-level box is only ever relabeled (never
// re-ticked), so the returned body can never gain a ticked approve marker. The
// caller in action.yml still asserts !hasTickedApproveMarker on the composed body
// before writing, same discipline as every other transform in this module.
function applyPartialApproval(body, approvedKeys) {
  const approved = new Set((Array.isArray(approvedKeys) ? approvedKeys : []).map(asString));
  const lines = asString(body).split('\n');
  let remainingItemBoxes = 0;

  const rewritten = lines.map((line) => {
    const match = line.match(UNTICKED_ITEM_BOX);
    if (!match) return line;
    const [, indent, keyList, tail] = match;
    const keys = keyList.split(',').filter(Boolean);
    const isApproved = keys.length > 0 && keys.every((key) => approved.has(key));
    if (!isApproved) {
      // Still pending: leave the box exactly as untickApproveBoxes left it.
      remainingItemBoxes += 1;
      return line;
    }
    // Approved: drop the checkbox + marker, keep the name and any breakpoint suffix.
    // The builder renders the marker's trailing text as ` Approve <name…>`
    // (build-comment.js approveItemCheckbox); relabel it to the past-tense form.
    const label = tail.replace(/^\s*Approve\s+/, '');
    return `${indent}- ✅ Approved ${label}`;
  });

  const result = rewritten.join('\n');

  if (remainingItemBoxes > 0) {
    // Some items are still approvable: relabel the top-level box's human text only,
    // re-emitting its marker + `[ ]` prefix (group 1) byte-for-byte.
    return result.replace(UNTICKED_APPROVE_BOX_LINE, (whole, prefix) => `${prefix}${APPROVE_REMAINING_LABEL}`);
  }
  // Nothing left to approve: strip the whole CTA, matching a full approve.
  return stripApproveCta(result);
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
  lockApproveBoxes,
  unlockApproveBoxes,
  inFlightMarker,
  inFlightRunId,
  withQueuedNote,
  clearQueuedNote,
  withStatusBanner,
  stripApproveCta,
  applyPartialApproval,
};
