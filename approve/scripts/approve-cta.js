'use strict';
//
// The approve flow's CTA rewrites: what the sticky comment's "Approve these
// changes" section becomes once an approval lands. Split out of
// report-comment.js, which owns the status/queued blocks around it.
//
// LOOP SAFETY (load-bearing). A rewritten item line carries neither the item
// marker nor any checkbox syntax, and the top-level box is only ever relabeled,
// never re-ticked — so nothing here can produce a body that re-fires the approve
// workflow. action.yml still asserts report-comment.js's hasTickedApproveMarker
// on the composed body before writing.

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

const asString = (value) => String(value == null ? '' : value);

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
  CTA_HEADING,
  APPROVE_REMAINING_LABEL,
  stripApproveCta,
  applyPartialApproval,
};
