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

// True only for a FULL clear — every pending baseline promoted, and at least one
// pending. Fail-closed on a partial, on nothing pending, and on any non-integer /
// NaN / missing count: never fabricate a passing check. See foldDeletions for why
// the deleted count rides in BOTH inputs.
function shouldSynthesizeCheck({ pendingTotal, keptCount } = {}) {
  if (!Number.isInteger(pendingTotal) || !Number.isInteger(keptCount)) {
    return false;
  }
  if (pendingTotal <= 0) {
    return false;
  }
  // Strict equality also fail-closes the impossible keptCount > pendingTotal case.
  return keptCount === pendingTotal;
}

// The run's deleted-baseline count from the already-parsed results.json, falling
// back `.totals.deleted` → `.deleted.length` → 0. GOTCHA: a non-integer
// `.totals.deleted` falls THROUGH to the array, a negative integer does not — it
// collapses to 0. The asymmetry is deliberate and pinned by tests.
function parseDeletedCount(results) {
  const fromTotals = results && results.totals && results.totals.deleted;
  const fromArray = Array.isArray(results && results.deleted) ? results.deleted.length : undefined;
  const n = Number.isInteger(fromTotals) ? fromTotals : fromArray;
  if (Number.isInteger(n) && n >= 0) {
    return n;
  }
  return 0;
}

// Fold the deleted count into BOTH gate counts. Adding the SAME number to each
// cancels it out of the strict-equality gate (a deletion can never flip a partial
// into a full clear) while rescuing a deletion-only clear, where the candidate-dir
// count is 0. An asymmetric fold would silently corrupt the gate.
function foldDeletions({ candidateCount, promotedCount, deletedCount } = {}) {
  return {
    pendingTotal: candidateCount + deletedCount,
    keptCount: promotedCount + deletedCount,
  };
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

module.exports = { shouldSynthesizeCheck, parseCheckNames, parseDeletedCount, foldDeletions };
