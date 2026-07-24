'use strict';
//
// Pure, unit-testable decision for the approve flow's "skip the redundant rerun"
// shortcut. After a maintainer approves the pending baselines, approve/action.yml
// commits them to the PR head branch — but the approve step never touches source
// code (only `baselines-path`), so the committed tree is byte-identical to the run
// that captured the candidates. Clearing the required visual-regression check today
// therefore means a full, provably redundant re-run of the whole Tuffgal suite.
// This module owns ONLY the pure decision of whether an approval EARNED the
// shortcut — synthesizing a passing Check Run on the new commit SHA instead of
// forcing that rerun. The Checks API call, the SHA, and every other side effect
// stay inline in action.yml; this module never performs I/O, mirroring the
// extract-and-unit-test precedent set by baseline-tree.js, resolve-approver.js,
// select-candidate.js, and filter-candidates.js.
//
// SECURITY: the false-positive direction is the sharp edge. Synthesizing a passing
// check while stories still await review would fabricate a green required check
// over unreviewed baseline diffs. So the shortcut is earned ONLY by a FULL clear —
// every pending candidate promoted by THIS approval. Any partial approve, and any
// approve that promoted nothing (a stray comment trigger with nothing pending),
// MUST fail closed: no shortcut, fall back to the normal rerun. The gate is
// expressed as a strict equality plus a positivity guard, and it fail-closes on any
// input that isn't a concrete non-negative integer count — a garbage / NaN count
// must never fabricate a check.

// Decide whether an approval fully cleared the pending baselines and so earns the
// synthesized passing check (skipping the redundant rerun).
//   input:
//     - pendingTotal: how many stories were new / changed / deleted in the captured
//                     run (new + changed + deleted from that run's results.json
//                     totals). In the approve flow the caller builds this as the
//                     `total` output of the "Filter candidates to selection" step
//                     (candidate action-dirs physically present in the extracted
//                     tree — the new + changed set) PLUS the run's deleted count read
//                     from the bundled results.json. Deletions are not candidate
//                     dirs, so they never appear in `total`; folding the deleted
//                     count in here (and equally into keptCount) is what lets a
//                     deletion-only full clear reach pendingTotal > 0.
//     - keptCount:    how many of those THIS approval actually promoted. In the
//                     approve flow the caller builds this as the filter step's `kept`
//                     output (the length of computeCandidateFilter's `keep`
//                     partition) PLUS the SAME deleted count. `tuffgal approve
//                     --prune` resolves deletions unconditionally on any approve
//                     trigger (they are never gated by the per-item selection), so a
//                     deletion always counts as promoted. Adding the deleted count to
//                     both inputs cancels it out of the strict-equality gate — it can
//                     never flip a partial (kept < total) into a full clear.
//   output: boolean.
//     - true  → a FULL clear: keptCount === pendingTotal AND pendingTotal > 0.
//     - false → a partial approve (keptCount < pendingTotal), an approve with
//               nothing pending (pendingTotal <= 0), or any non-integer / NaN /
//               missing count. Fail-closed: never fabricate a check on a partial or
//               on garbage input.
function shouldSynthesizeCheck({ pendingTotal, keptCount } = {}) {
  // Fail-closed on anything that isn't a concrete non-negative integer count. A
  // NaN / undefined / non-integer count must never earn the shortcut.
  if (!Number.isInteger(pendingTotal) || !Number.isInteger(keptCount)) {
    return false;
  }
  // Nothing was pending → an approve that changes nothing must not fabricate a
  // passing check (defensive: a stray comment trigger against an empty candidate
  // set). Also collapses any negative count to false.
  if (pendingTotal <= 0) {
    return false;
  }
  // The full-clear gate. Strict equality also fail-closes the impossible
  // keptCount > pendingTotal case: only an exact full promote earns the shortcut.
  return keptCount === pendingTotal;
}

// Parse the raw `check-name` action input into the list of check-run names to
// synthesize. The input is a string, optionally comma-separated so a matrix / smoke
// suite can name one check per job (mirroring the `artifact-name` "set a unique name
// per visual job" convention). Empty, whitespace-only, or non-string input yields an
// empty array — the feature is disabled, and the caller creates no check run.
//   input:  a raw `check-name` string (possibly comma-separated, possibly empty /
//           undefined).
//   output: string[] of trimmed, non-empty names. Surrounding whitespace per name is
//           stripped; empty segments (leading / trailing / doubled commas) are
//           dropped, so a whitespace-or-comma-only input is an empty array.
function parseCheckNames(input) {
  if (typeof input !== 'string') {
    return [];
  }
  return input
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

module.exports = { shouldSynthesizeCheck, parseCheckNames };
