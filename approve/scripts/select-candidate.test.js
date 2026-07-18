'use strict';
//
// Unit tests for the pure candidate-artifact selection logic. No deps beyond
// Node's built-in `node:test` + `node:assert` — run with
// `node --test approve/scripts/*.test.js`.
//
// This is the #14 fail-closed selection fix: its whole point is that ambiguity
// (a run carrying more than one same-named artifact) fails closed rather than
// coin-flipping. The ambiguous arm is security-load-bearing and MUST fail if the
// `matches.length > 1` guard is reverted to picking `matches[0]`.
//
const { test } = require('node:test');
const assert = require('node:assert');

const { sortRunsNewestFirst, classifyMatches } = require('./select-candidate.js');

const NAME = 'tuffgal-candidates';

// --- classifyMatches ----------------------------------------------------- //

test('classify: a single matching artifact is selected', () => {
  const arts = [{ id: 1, name: NAME, expired: false }];
  assert.deepStrictEqual(classifyMatches(arts, NAME), {
    kind: 'selected',
    artifact: { id: 1, name: NAME, expired: false },
  });
});

test('classify: TWO matching artifacts in a run are ambiguous (fail closed)', () => {
  const arts = [
    { id: 1, name: NAME, expired: false },
    { id: 2, name: NAME, expired: false },
  ];
  assert.deepStrictEqual(classifyMatches(arts, NAME), { kind: 'ambiguous', count: 2 });
});

test('classify: no matching artifact yields none', () => {
  const arts = [{ id: 1, name: 'something-else', expired: false }];
  assert.deepStrictEqual(classifyMatches(arts, NAME), { kind: 'none' });
});

test('classify: an empty / missing artifact list yields none', () => {
  assert.deepStrictEqual(classifyMatches([], NAME), { kind: 'none' });
  assert.deepStrictEqual(classifyMatches(undefined, NAME), { kind: 'none' });
});

test('classify: expired same-named artifacts are filtered out', () => {
  // One expired + one live match → resolves to the single LIVE one, not ambiguous.
  const arts = [
    { id: 1, name: NAME, expired: true },
    { id: 2, name: NAME, expired: false },
  ];
  assert.deepStrictEqual(classifyMatches(arts, NAME), {
    kind: 'selected',
    artifact: { id: 2, name: NAME, expired: false },
  });
});

test('classify: all matches expired yields none', () => {
  const arts = [
    { id: 1, name: NAME, expired: true },
    { id: 2, name: NAME, expired: true },
  ];
  assert.deepStrictEqual(classifyMatches(arts, NAME), { kind: 'none' });
});

test('classify: a custom artifact-name is honored', () => {
  const custom = 'smoke-candidates';
  const arts = [
    { id: 1, name: NAME, expired: false }, // default name — must be ignored
    { id: 2, name: custom, expired: false },
  ];
  assert.deepStrictEqual(classifyMatches(arts, custom), {
    kind: 'selected',
    artifact: { id: 2, name: custom, expired: false },
  });
});

// --- sortRunsNewestFirst ------------------------------------------------- //

test('sort: orders runs newest-first by created_at without mutating input', () => {
  const runs = [
    { id: 'old', created_at: '2026-07-01T00:00:00Z' },
    { id: 'new', created_at: '2026-07-03T00:00:00Z' },
    { id: 'mid', created_at: '2026-07-02T00:00:00Z' },
  ];
  const sorted = sortRunsNewestFirst(runs);
  assert.deepStrictEqual(
    sorted.map((run) => run.id),
    ['new', 'mid', 'old'],
  );
  // Input array order is preserved (a new array is returned).
  assert.deepStrictEqual(
    runs.map((run) => run.id),
    ['old', 'new', 'mid'],
  );
});

// --- newest-run-first selection (composed, mirrors the inline loop) ------- //
// This replay mirrors action.yml's download-step loop EXACTLY: sort runs
// newest-first, then classify each run's artifacts lazily, acting on the first
// run with any match. It proves the end-to-end "newest-run-first wins" property
// the module's two pure pieces compose into.
function selectOverRuns(runs, artifactsByRunId, artifactName) {
  for (const run of sortRunsNewestFirst(runs)) {
    const result = classifyMatches(artifactsByRunId[run.id] || [], artifactName);
    if (result.kind === 'none') {
      continue;
    }
    if (result.kind === 'ambiguous') {
      return { kind: 'ambiguous', runId: run.id, count: result.count };
    }
    return { kind: 'selected', runId: run.id, artifact: result.artifact };
  }
  return { kind: 'none' };
}

test('select: the newest run carrying a match wins over an older one', () => {
  const runs = [
    { id: 'old', created_at: '2026-07-01T00:00:00Z' },
    { id: 'new', created_at: '2026-07-03T00:00:00Z' },
  ];
  const artifactsByRunId = {
    old: [{ id: 10, name: NAME, expired: false }],
    new: [{ id: 20, name: NAME, expired: false }],
  };
  assert.deepStrictEqual(selectOverRuns(runs, artifactsByRunId, NAME), {
    kind: 'selected',
    runId: 'new',
    artifact: { id: 20, name: NAME, expired: false },
  });
});

test('select: skips a newer run with no match and selects from an older one', () => {
  const runs = [
    { id: 'old', created_at: '2026-07-01T00:00:00Z' },
    { id: 'new', created_at: '2026-07-03T00:00:00Z' },
  ];
  const artifactsByRunId = {
    new: [{ id: 20, name: 'unrelated', expired: false }],
    old: [{ id: 10, name: NAME, expired: false }],
  };
  assert.deepStrictEqual(selectOverRuns(runs, artifactsByRunId, NAME), {
    kind: 'selected',
    runId: 'old',
    artifact: { id: 10, name: NAME, expired: false },
  });
});

test('select: ambiguity in the newest matching run fails closed before older runs', () => {
  const runs = [
    { id: 'old', created_at: '2026-07-01T00:00:00Z' },
    { id: 'new', created_at: '2026-07-03T00:00:00Z' },
  ];
  const artifactsByRunId = {
    // The newest run is ambiguous; a clean older run must NOT rescue it.
    new: [
      { id: 20, name: NAME, expired: false },
      { id: 21, name: NAME, expired: false },
    ],
    old: [{ id: 10, name: NAME, expired: false }],
  };
  assert.deepStrictEqual(selectOverRuns(runs, artifactsByRunId, NAME), {
    kind: 'ambiguous',
    runId: 'new',
    count: 2,
  });
});

test('select: no run carrying a match yields none', () => {
  const runs = [{ id: 'a', created_at: '2026-07-01T00:00:00Z' }];
  assert.deepStrictEqual(selectOverRuns(runs, { a: [] }, NAME), { kind: 'none' });
});
