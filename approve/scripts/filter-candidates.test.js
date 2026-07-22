'use strict';
//
// Unit tests for the pure candidate-selection filter. No deps beyond Node's
// built-in `node:test` + `node:assert` — run with
// `node --test approve/scripts/*.test.js`.
//
// This is a security-load-bearing filter: it turns an UNTRUSTED per-item approve
// selection (parsed from a PR comment a write actor can edit) into the set of
// candidate action-dirs the CLI is allowed to promote. The malformed-key and the
// 'all' no-op arms are the load-bearing cases — the first MUST drop spoofed keys
// fail-closed (never keep, never remove, never throw), the second MUST leave the
// tree untouched so every existing full-approve consumer is byte-for-byte
// unchanged. Both MUST fail if the corresponding guard is reverted.
//
const { test } = require('node:test');
const assert = require('node:assert');

const { computeCandidateFilter, ACTION_NAME_PATTERN } = require('./filter-candidates.js');

// A representative extracted candidate tree's top-level DIRECTORY names (results.json
// is a FILE, so the caller's withFileTypes filter never puts it in this list).
const present = ['home-hero', 'about-team', 'footer'];

// A keep/remove result must always be a partition of the present dirs: the two
// arrays are disjoint and their union is exactly `present` (order-independent).
function assertPartition(result, presentDirs) {
  const union = [...result.keep, ...result.remove].sort();
  assert.deepStrictEqual(union, [...presentDirs].sort(), 'keep ∪ remove must equal present');
  for (const name of result.keep) {
    assert.ok(!result.remove.includes(name), `${name} appears in both keep and remove`);
  }
}

// --- 'all' is a strict no-op (the regression guard) ---------------------- //

test("selection 'all': keeps every present dir, removes nothing (byte-identical no-op)", () => {
  const result = computeCandidateFilter('all', present);
  assert.deepStrictEqual(result.remove, []);
  assert.deepStrictEqual(result.keep, present);
  assertPartition(result, present);
});

test("selection 'all': an empty present tree still removes nothing", () => {
  assert.deepStrictEqual(computeCandidateFilter('all', []), { keep: [], remove: [] });
});

// --- subset selection ---------------------------------------------------- //

test('subset selection: keeps only the selected present dirs, removes the rest', () => {
  const result = computeCandidateFilter(['home-hero', 'footer'], present);
  assert.deepStrictEqual(result.keep.sort(), ['footer', 'home-hero']);
  assert.deepStrictEqual(result.remove, ['about-team']);
  assertPartition(result, present);
});

test('single-key selection: keeps just that dir, removes the other two', () => {
  const result = computeCandidateFilter(['about-team'], present);
  assert.deepStrictEqual(result.keep, ['about-team']);
  assert.deepStrictEqual(result.remove.sort(), ['footer', 'home-hero']);
  assertPartition(result, present);
});

// --- a selected key not present in the tree is a no-op for that key ------- //

test('selection naming an absent key: that key is a no-op, present dirs still partition', () => {
  // `stale-story` was already promoted / never existed — it is simply not kept,
  // and it never appears anywhere (keep only ever intersects present).
  const result = computeCandidateFilter(['home-hero', 'stale-story'], present);
  assert.deepStrictEqual(result.keep, ['home-hero']);
  assert.ok(!result.keep.includes('stale-story'));
  assert.ok(!result.remove.includes('stale-story'));
  assert.deepStrictEqual(result.remove.sort(), ['about-team', 'footer']);
  assertPartition(result, present);
});

test('selection of ONLY absent keys: keeps nothing, removes every present dir', () => {
  const result = computeCandidateFilter(['ghost-a', 'ghost-b'], present);
  assert.deepStrictEqual(result.keep, []);
  assert.deepStrictEqual(result.remove.sort(), [...present].sort());
  assertPartition(result, present);
});

// --- malformed / spoofed keys are dropped fail-closed -------------------- //
// A write actor can edit their own past comment, so a selection key is untrusted
// free text. Anything that isn't a bare allowlisted action key MUST be dropped:
// never kept, never used to name a dir, never thrown. Reverting the
// ACTION_NAME_PATTERN validation makes these leak into `keep`.

test('malformed keys (traversal, uppercase, spaces, slash) are dropped, never keep/throw', () => {
  const malformed = ['../etc', 'UPPER', 'has spaces', 'key/with/slash', '..', 'a/../b', ''];
  // Pair each malformed key with the one legitimate present key so we can assert
  // the good one still drives the approve while every bad one vanishes.
  const result = computeCandidateFilter([...malformed, 'home-hero'], present);
  assert.deepStrictEqual(result.keep, ['home-hero']);
  for (const bad of malformed) {
    assert.ok(!result.keep.includes(bad), `${JSON.stringify(bad)} leaked into keep`);
    assert.ok(!result.remove.includes(bad), `${JSON.stringify(bad)} leaked into remove`);
  }
  // remove is only ever present dirs — never a spoofed name that could name a path.
  assert.deepStrictEqual(result.remove.sort(), ['about-team', 'footer']);
  assertPartition(result, present);
});

test('a selection of ONLY malformed keys keeps nothing and removes every present dir', () => {
  const result = computeCandidateFilter(['../../secret', 'Home-Hero', 'a b c'], present);
  assert.deepStrictEqual(result.keep, []);
  assert.deepStrictEqual(result.remove.sort(), [...present].sort());
  // No malformed key is ever in the output that the caller turns into an rm path.
  for (const name of result.remove) {
    assert.ok(ACTION_NAME_PATTERN.test(name), `${name} in remove is not an allowlisted key`);
  }
  assertPartition(result, present);
});

// --- empty selection array ----------------------------------------------- //
// resolveApprover already fails `proceed` on a zero-item selection, so this path
// is not reached in practice — but the pure function's own contract is tested
// defensively: ticking nothing keeps nothing.

test('empty selection array: keeps nothing, removes everything present', () => {
  const result = computeCandidateFilter([], present);
  assert.deepStrictEqual(result.keep, []);
  assert.deepStrictEqual(result.remove.sort(), [...present].sort());
  assertPartition(result, present);
});

// --- results.json / non-directory entries never surface ------------------ //
// The caller passes DIRECTORY names only (withFileTypes filter), so results.json
// is never an input. Belt-and-suspenders: even if a caller regression leaked it,
// `results.json` fails the allowlist (the dot), so it can never be KEPT — and it
// can only ever land in `remove` if a caller passed it, which the inline caller's
// own withFileTypes filter + re-validation prevent.

test('results.json is never kept even if a selection names it (dot fails the allowlist)', () => {
  // A spoofed selection that tries to keep the results file: dropped by the pattern.
  const result = computeCandidateFilter(['results.json', 'home-hero'], present);
  assert.deepStrictEqual(result.keep, ['home-hero']);
  assert.ok(!result.keep.includes('results.json'));
  assertPartition(result, present);
});

test("results.json is never an input under the caller's dir-only contract, so never in either array", () => {
  // present holds DIRECTORY names only; results.json (a file) is absent by
  // construction, mirroring the inline readdir({ withFileTypes: true }) filter.
  const result = computeCandidateFilter(['home-hero'], present);
  assert.ok(!result.keep.includes('results.json'));
  assert.ok(!result.remove.includes('results.json'));
});

// --- the allowlist matches the tuffgal CLI's own action-key pattern ------- //

test('ACTION_NAME_PATTERN accepts real action keys and rejects the spoof shapes', () => {
  assert.ok(ACTION_NAME_PATTERN.test('home-hero'));
  assert.ok(ACTION_NAME_PATTERN.test('visit-home'));
  assert.ok(ACTION_NAME_PATTERN.test('a1'));
  assert.ok(!ACTION_NAME_PATTERN.test('../etc'));
  assert.ok(!ACTION_NAME_PATTERN.test('UPPER'));
  assert.ok(!ACTION_NAME_PATTERN.test('has spaces'));
  assert.ok(!ACTION_NAME_PATTERN.test('key/with/slash'));
  assert.ok(!ACTION_NAME_PATTERN.test('results.json'));
  assert.ok(!ACTION_NAME_PATTERN.test(''));
});
