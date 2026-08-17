'use strict';
//
// Pure, unit-testable filter for the approve flow's per-baseline (partial-approve)
// step. Given the resolved `selection` (from resolve-approver.js) and the list of
// top-level directory names physically present in the extracted candidate tree,
// it computes which candidate action-dirs to KEEP and which to REMOVE before the
// CLI promotes them. Extracted out of the inline `actions/github-script` block so
// the security-sensitive key validation and keep/remove math can be exercised by a
// `node --test` suite without a live GitHub run — the same extract-and-unit-test
// precedent set by baseline-tree.js, resolve-approver.js, and select-candidate.js.
//
// This module owns ONLY the pure decision. The thin I/O — the `readdir` of the
// candidate dir and the `fs.rmSync` of each removed dir — stays inline in
// action.yml; the inline script requires this module, passes it the present
// DIRECTORY names, and acts on its verdict (joining every `remove` entry UNDER
// $CAND_DIR, never trusting a name as a full path).
//
// SECURITY: a `selection` array is UNTRUSTED free text parsed from a PR comment
// body — a write-permission actor can edit their own past comment, so the item
// keys resolve-approver.js pulled out of the checked boxes are attacker-influenced.
// Every selected key is re-validated here against `ACTION_NAME_PATTERN` (the same
// allowlist the tuffgal CLI constrains action keys to) — defense in depth, NOT
// trust in the upstream item-marker regex. A key that fails validation is silently
// DROPPED from the keep-set: it is never used to name a directory, never thrown as
// a fatal error (a malformed / spoofed key just means "that one wasn't promoted",
// never "abort the whole approve"), and can never enter `remove` (which is only
// ever a subset of the ALLOWLIST-VALID present directory names — a present dir
// whose own name fails the allowlist is left alone, never removed, so the deletion
// set is provably allowlist-clean without relying on an inline runtime throw).
// Mirrors the allowlist-reject posture of baseline-tree.js's `guard()`.

// The action-key allowlist. Kept byte-identical to the tuffgal CLI's own
// `ACTION_NAME_PATTERN` (exported from tuffgal's baselineStore) — the CLI names
// each candidate action-dir with a key matching this, so a validated selected key
// is exactly the set of dir names the extracted tree can legitimately contain.
const ACTION_NAME_PATTERN = /^[a-z0-9-]+$/;

// Compute the keep/remove partition of the present candidate action-dirs for a
// resolved selection.
//   input:
//     - selection:       'all' (a mention or the master box) or a string[] of
//                        action keys (a partial per-item approve), exactly as
//                        returned by resolveApprover.
//     - presentDirNames: the top-level DIRECTORY names physically present in the
//                        extracted candidate tree. The caller passes directory
//                        entries ONLY — never files like results.json — so a file
//                        can never enter either output array.
//   output: { keep: string[], remove: string[] } — a partition of presentDirNames
//            (keep ∪ remove === present, disjoint).
//     - selection === 'all' → keep = every present dir, remove = [] (a STRICT
//       no-op: the full tree is promoted unconditionally — the
//       regression guard for every existing full-approve consumer, since most
//       approvals stay full 'all' via the master box or a mention).
//     - selection is an array → remove = every ALLOWLIST-VALID present dir not in
//       the pattern-validated selection; keep = every present dir not removed (the
//       pattern-validated selected present dirs, PLUS any present dir whose own name
//       fails the allowlist — a malformed present entry is left alone, never
//       removed). A selected key that fails validation, or that names a dir not
//       actually present (stale / already-promoted), is a no-op — dropped from the
//       selection, never an error. An empty array removes every allowlist-valid
//       present dir and keeps the rest.
function computeCandidateFilter(selection, presentDirNames) {
  const present = [...presentDirNames];

  // A full approve promotes everything, so this branch must leave the tree
  // untouched.
  if (selection === 'all') {
    return { keep: present, remove: [] };
  }

  const selectedValid = new Set(
    (Array.isArray(selection) ? selection : []).filter((key) => ACTION_NAME_PATTERN.test(key)),
  );
  // `remove` is the deletion set, so it is the sharp edge: a present dir whose
  // own name fails the allowlist is left alone rather than reaching the inline
  // rmSync loop, which would abort the whole approve on a malformed entry.
  const remove = present.filter(
    (name) => !selectedValid.has(name) && ACTION_NAME_PATTERN.test(name),
  );
  const removeSet = new Set(remove);
  const keep = present.filter((name) => !removeSet.has(name));
  return { keep, remove };
}

module.exports = { computeCandidateFilter, ACTION_NAME_PATTERN };
