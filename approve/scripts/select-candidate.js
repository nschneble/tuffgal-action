'use strict';
//
// Pure, unit-testable logic for the approve flow's "Download candidates artifact"
// step: ordering the PR head's completed runs newest-first and, WITHIN a run,
// deciding whether its artifacts yield a single promotable candidate, an
// ambiguous set, or nothing. The paginate calls and the comment / setFailed side
// effects stay inline, which lets action.yml fetch each run's artifacts LAZILY —
// this module classifies one already-fetched run at a time.
//
// FAIL-CLOSED: ambiguity WITHIN the selected run — a matrix / smoke
// suite that uploads multiple same-named artifacts — is an error, not a coin
// flip. Promoting an arbitrary set could ship the wrong baselines, so it fails
// closed rather than picking one.

// Order completed runs newest-first by `created_at`. Returns a new array; the
// caller's paginated run list is not mutated.
function sortRunsNewestFirst(runs) {
  return [...runs].sort((runA, runB) => new Date(runB.created_at) - new Date(runA.created_at));
}

// Classify one run's artifacts against the wanted name. Filters to entries that
// match the name AND are not expired, then:
//   - 0 matches  → { kind: 'none' }                 (caller continues to older run)
//   - 1 match    → { kind: 'selected', artifact }
//   - >1 matches → { kind: 'ambiguous', count }     (caller fails closed)
function classifyMatches(artifacts, artifactName) {
  const matches = (artifacts || []).filter(
    (artifact) => artifact.name === artifactName && !artifact.expired,
  );
  if (matches.length === 0) {
    return { kind: 'none' };
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous', count: matches.length };
  }
  return { kind: 'selected', artifact: matches[0] };
}

module.exports = { sortRunsNewestFirst, classifyMatches };
