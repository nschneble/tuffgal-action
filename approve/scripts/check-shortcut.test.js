'use strict';
//
// Unit tests for the pure check-run shortcut decision. No deps beyond Node's
// built-in `node:test` + `node:assert` — run with
// `node --test approve/scripts/*.test.js`.
//
// The false-positive direction is security-load-bearing: `shouldSynthesizeCheck`
// returning true on a PARTIAL approve would fabricate a passing required check while
// stories still await review. That direction is tested explicitly (not just the
// happy path), alongside the nothing-pending and garbage-input fail-closed arms.
//
const { test } = require('node:test');
const assert = require('node:assert');

const {
  shouldSynthesizeCheck,
  parseCheckNames,
  parseDeletedCount,
  foldDeletions,
} = require('./check-shortcut.js');

// --- full clear earns the shortcut --------------------------------------- //

test('full clear (keptCount === pendingTotal, pendingTotal > 0) → true', () => {
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: 1, keptCount: 1 }), true);
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: 3, keptCount: 3 }), true);
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: 7, keptCount: 7 }), true);
});

// --- deletion-folded counting (approve flow wiring semantics) ------------ //
// Deletions are not candidate action-dirs, so the filter step's `total`/`kept`
// never count them; `tuffgal approve --prune` resolves them unconditionally on
// any approve trigger. The commit step folds the run's deleted count into BOTH
// pendingTotal and keptCount before calling this gate. These cases pin that the
// folded numbers behave correctly — the module still only compares two integers.

test('deletion-only full clear (0 candidate dirs + N deleted folded into both) → true', () => {
  // 0 new/changed present + 2 deletions → pendingTotal 0+2, keptCount 0+2.
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: 2, keptCount: 2 }), true);
});

test('full clear with deletions (2 changed + 3 deleted folded into both) → true', () => {
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: 5, keptCount: 5 }), true);
});

test('partial approve WITH deletions still fails closed (deleted count cancels out)', () => {
  // 3 changed present, 1 ticked, 2 deletions folded: pendingTotal 3+2, keptCount 1+2.
  // The two unreviewed changed stories keep pendingTotal > keptCount → no shortcut.
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: 5, keptCount: 3 }), false);
});

// --- partial approve MUST fail closed (SECURITY-CRITICAL) ---------------- //
// A false positive here fabricates a green required check while stories still await
// review. This is the load-bearing direction — reverting the strict-equality gate
// must fail these.

test('partial approve (keptCount < pendingTotal) → false', () => {
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: 3, keptCount: 2 }), false);
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: 3, keptCount: 1 }), false);
});

test('partial approve promoting NONE of several pending (keptCount 0, pendingTotal > 0) → false', () => {
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: 5, keptCount: 0 }), false);
});

// --- nothing pending fails closed ---------------------------------------- //
// A stray comment trigger with an empty candidate set must not fabricate a check.

test('nothing pending (pendingTotal === 0) → false, even when keptCount is also 0', () => {
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: 0, keptCount: 0 }), false);
});

// --- defensive fail-closed arms ------------------------------------------ //
// keptCount > pendingTotal can't happen (kept is a subset of total), but the strict
// equality must still fail-close it rather than fabricate a check.

test('impossible keptCount > pendingTotal → false (strict equality fail-closes)', () => {
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: 2, keptCount: 3 }), false);
});

test('negative pendingTotal → false', () => {
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: -1, keptCount: -1 }), false);
});

test('non-integer / NaN / missing counts → false (garbage never earns the shortcut)', () => {
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: NaN, keptCount: NaN }), false);
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: 2.5, keptCount: 2.5 }), false);
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: '3', keptCount: '3' }), false);
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal: undefined, keptCount: undefined }), false);
  assert.strictEqual(shouldSynthesizeCheck({}), false);
  assert.strictEqual(shouldSynthesizeCheck(), false);
});

// --- parseDeletedCount (the deleted-count fallback ladder) --------------- //
// Directly covers the DECISION logic extracted out of the filter step's inline
// results.json read. The JSON.parse / readFileSync I/O stays inline in
// approve/action.yml; this function only decides which field wins. The prior
// coverage exercised zero of this ladder — a broken fallback order would have
// shipped green. Each case pins the EXACT current behavior (verified against the
// pre-extraction inline code), including the subtle negative-vs-non-integer split.

test('parseDeletedCount: valid .totals.deleted is used (authoritative per-run total)', () => {
  assert.strictEqual(parseDeletedCount({ totals: { deleted: 4 } }), 4);
});

test('parseDeletedCount: .totals.deleted preferred over the .deleted array length', () => {
  // Both present and disagree → totals wins (it is the authoritative total).
  assert.strictEqual(parseDeletedCount({ totals: { deleted: 3 }, deleted: ['a', 'b', 'c', 'd', 'e'] }), 3);
});

test('parseDeletedCount: .totals.deleted absent → falls back to .deleted array length', () => {
  assert.strictEqual(parseDeletedCount({ deleted: ['a', 'b', 'c'] }), 3);
});

test('parseDeletedCount: empty .deleted array → 0', () => {
  assert.strictEqual(parseDeletedCount({ deleted: [] }), 0);
});

test('parseDeletedCount: NON-INTEGER .totals.deleted falls through to the .deleted array', () => {
  // Number.isInteger(2.5) is false, so the ternary picks fromArray → array length.
  assert.strictEqual(parseDeletedCount({ totals: { deleted: 2.5 }, deleted: ['a', 'b'] }), 2);
});

test('parseDeletedCount: NEGATIVE-integer .totals.deleted does NOT fall through — it collapses to 0', () => {
  // Load-bearing asymmetry with the non-integer case above: Number.isInteger(-3) is
  // TRUE, so the ternary takes n = -3 (it never reaches the array), then the final
  // `n >= 0` guard rejects it → 0. This mirrors the exact pre-extraction inline
  // behavior; a naive "negative falls back to the array" reading is WRONG.
  assert.strictEqual(parseDeletedCount({ totals: { deleted: -3 }, deleted: ['a', 'b'] }), 0);
});

test('parseDeletedCount: non-integer .totals.deleted with no .deleted array → 0', () => {
  assert.strictEqual(parseDeletedCount({ totals: { deleted: 2.5 } }), 0);
});

test('parseDeletedCount: both fields absent → 0', () => {
  assert.strictEqual(parseDeletedCount({}), 0);
});

test('parseDeletedCount: malformed / non-array .deleted and no totals → 0', () => {
  assert.strictEqual(parseDeletedCount({ deleted: 'nope' }), 0);
  assert.strictEqual(parseDeletedCount({ totals: {}, deleted: 5 }), 0);
});

test('parseDeletedCount: null / non-object input → 0 (defensive, mirrors JSON.parse("null"))', () => {
  assert.strictEqual(parseDeletedCount(null), 0);
  assert.strictEqual(parseDeletedCount(undefined), 0);
});

// --- foldDeletions (symmetric fold into both gate inputs) ---------------- //
// The regression this guards is an ASYMMETRIC fold — adding deletedCount to
// pendingTotal but not keptCount (or vice versa), which would silently corrupt the
// full-clear gate. The prior coverage only checked the fold's DOWNSTREAM boolean
// via shouldSynthesizeCheck; these assert BOTH outputs directly, so an asymmetric
// fold fails HERE regardless of whether the boolean happens to survive.

test('foldDeletions: adds the SAME deletedCount to BOTH pendingTotal and keptCount', () => {
  assert.deepStrictEqual(foldDeletions({ candidateCount: 2, promotedCount: 1, deletedCount: 3 }), {
    pendingTotal: 5,
    keptCount: 4,
  });
});

test('foldDeletions: deletion-only run (0 candidate dirs) surfaces the deletions in both counts', () => {
  assert.deepStrictEqual(foldDeletions({ candidateCount: 0, promotedCount: 0, deletedCount: 2 }), {
    pendingTotal: 2,
    keptCount: 2,
  });
});

test('foldDeletions: zero deletions is a no-op pass-through of the two counts', () => {
  assert.deepStrictEqual(foldDeletions({ candidateCount: 3, promotedCount: 2, deletedCount: 0 }), {
    pendingTotal: 3,
    keptCount: 2,
  });
});

test('foldDeletions: the fold preserves a partial gap (kept < pending) exactly', () => {
  // 3 changed present, 1 ticked, 2 deletions: the 2-story gap must survive the fold
  // so shouldSynthesizeCheck still fails closed. Asserts the gap directly.
  const { pendingTotal, keptCount } = foldDeletions({ candidateCount: 3, promotedCount: 1, deletedCount: 2 });
  assert.strictEqual(pendingTotal - keptCount, 2);
  assert.strictEqual(shouldSynthesizeCheck({ pendingTotal, keptCount }), false);
});

// --- parseCheckNames ----------------------------------------------------- //

test('empty string → [] (feature disabled)', () => {
  assert.deepStrictEqual(parseCheckNames(''), []);
});

test('undefined → [] (feature disabled)', () => {
  assert.deepStrictEqual(parseCheckNames(undefined), []);
});

test('whitespace-only → []', () => {
  assert.deepStrictEqual(parseCheckNames('   '), []);
  assert.deepStrictEqual(parseCheckNames('\t \n'), []);
});

test('single name → [name]', () => {
  assert.deepStrictEqual(parseCheckNames('Tuffgal Visual'), ['Tuffgal Visual']);
});

test('single name with surrounding whitespace → trimmed', () => {
  assert.deepStrictEqual(parseCheckNames('  Tuffgal Visual  '), ['Tuffgal Visual']);
});

test('comma-separated multi-name → trimmed array, per-name whitespace stripped', () => {
  assert.deepStrictEqual(parseCheckNames('visual-chrome, visual-firefox , visual-webkit'), [
    'visual-chrome',
    'visual-firefox',
    'visual-webkit',
  ]);
});

test('leading / trailing / doubled commas drop empty segments', () => {
  assert.deepStrictEqual(parseCheckNames(',visual-chrome,,visual-firefox,'), [
    'visual-chrome',
    'visual-firefox',
  ]);
});

test('comma / whitespace-only input → []', () => {
  assert.deepStrictEqual(parseCheckNames(',,,'), []);
  assert.deepStrictEqual(parseCheckNames(' , , '), []);
});

test('non-string input → [] (defensive)', () => {
  assert.deepStrictEqual(parseCheckNames(null), []);
  assert.deepStrictEqual(parseCheckNames(42), []);
  assert.deepStrictEqual(parseCheckNames(['a', 'b']), []);
});
