'use strict';
//
// Unit tests for the pure baseline-tree logic. No deps beyond Node's built-in
// `node:test` + `node:assert` — run with `node --test approve/scripts/`.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { guard, walk, toRepoPath, computeDeletions } = require('./baseline-tree.js');

// --- guard --------------------------------------------------------------- //

test('guard: rejects absolute paths', () => {
  assert.throws(() => guard('/etc/passwd', 'tuffgal/baselines'), /out-of-scope/);
});

test('guard: rejects `..` traversal segments', () => {
  assert.throws(
    () => guard('tuffgal/baselines/../../etc/passwd', 'tuffgal/baselines'),
    /out-of-scope/,
  );
});

test('guard: rejects paths outside the baselines prefix', () => {
  assert.throws(
    () => guard('some/other/dir/0.png', 'tuffgal/baselines'),
    /outside baselines directory/,
  );
});

test('guard: rejects a sibling that shares the prefix string but not the boundary', () => {
  // `tuffgal/baselines-evil` starts with the prefix text but is not nested
  // under `tuffgal/baselines/`.
  assert.throws(
    () => guard('tuffgal/baselines-evil/0.png', 'tuffgal/baselines'),
    /outside baselines directory/,
  );
});

test('guard: accepts the prefix itself and in-scope nested paths', () => {
  const prefix = 'tuffgal/baselines';
  assert.strictEqual(guard(prefix, prefix), prefix);
  assert.strictEqual(
    guard('tuffgal/baselines/visit-home/desktop.png', prefix),
    'tuffgal/baselines/visit-home/desktop.png',
  );
});

test('guard: normalizes backslashes before checking', () => {
  assert.strictEqual(
    guard('tuffgal\\baselines\\visit-home\\0.png', 'tuffgal/baselines'),
    'tuffgal/baselines/visit-home/0.png',
  );
});

// --- frame correctness (T1 unit lock) ------------------------------------ //
// Prove deletions are computed correctly under BOTH a '.' working-directory
// (empty prefix) and a subdir working-directory. This locks the same invariant
// the `approve-subdir-frame` smoke job covers, but at the unit level.

test("frame: '.' working-directory anchors and computes deletions correctly", () => {
  const workdirPrefix = ''; // working-directory '.'
  const prefix = 'tuffgal/baselines';
  // Names as produced by walk/ls-tree relative to the working-directory.
  const onDiskNames = ['tuffgal/baselines/visit-home/desktop.png'];
  const atHeadNames = [
    'tuffgal/baselines/visit-home/desktop.png',
    'tuffgal/baselines/old-story/desktop.png',
  ];
  const onDisk = onDiskNames.map((n) => toRepoPath(n, workdirPrefix, prefix));
  const atHead = atHeadNames.map((n) => toRepoPath(n, workdirPrefix, prefix));
  assert.deepStrictEqual(onDisk, ['tuffgal/baselines/visit-home/desktop.png']);
  assert.deepStrictEqual(computeDeletions(onDisk, atHead), [
    'tuffgal/baselines/old-story/desktop.png',
  ]);
});

test('frame: subdir working-directory re-anchors to repo root and computes deletions', () => {
  const workdirPrefix = 'frontend'; // working-directory: frontend
  const prefix = 'frontend/tuffgal/baselines';
  // ls-tree / walk names are workdir-relative; they must be re-anchored under
  // `frontend/` before guarding and before the set-difference.
  const onDiskNames = ['tuffgal/baselines/visit-home/desktop.png'];
  const atHeadNames = [
    'tuffgal/baselines/visit-home/desktop.png',
    'tuffgal/baselines/removed/desktop.png',
  ];
  const onDisk = onDiskNames.map((n) => toRepoPath(n, workdirPrefix, prefix));
  const atHead = atHeadNames.map((n) => toRepoPath(n, workdirPrefix, prefix));
  assert.deepStrictEqual(onDisk, ['frontend/tuffgal/baselines/visit-home/desktop.png']);
  assert.deepStrictEqual(computeDeletions(onDisk, atHead), [
    'frontend/tuffgal/baselines/removed/desktop.png',
  ]);
});

// --- deletions math ------------------------------------------------------ //

test('deletions: atHead 50, onDisk 1 overlapping -> 49 deletions', () => {
  const atHead = Array.from({ length: 50 }, (_, i) => `tuffgal/baselines/s${i}/0.png`);
  const onDisk = ['tuffgal/baselines/s0/0.png']; // overlaps the first
  const deletions = computeDeletions(onDisk, atHead);
  assert.strictEqual(deletions.length, 49);
  assert.ok(!deletions.includes('tuffgal/baselines/s0/0.png'));
});

test('deletions: identical sets -> 0', () => {
  const set = ['tuffgal/baselines/a/0.png', 'tuffgal/baselines/b/0.png'];
  assert.deepStrictEqual(computeDeletions(set, [...set]), []);
});

test('deletions: bootstrap (atHead empty) -> 0', () => {
  assert.deepStrictEqual(computeDeletions(['tuffgal/baselines/a/0.png'], []), []);
});

// --- walk ---------------------------------------------------------------- //

test('walk: collects nested files from a temp tree', () => {
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'bt-walk-'));
  try {
    fs.mkdirSync(path.join(root, 'visit-home'), { recursive: true });
    fs.mkdirSync(path.join(root, 'nested', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'top.png'), 'x');
    fs.writeFileSync(path.join(root, 'visit-home', '0.png'), 'y');
    fs.writeFileSync(path.join(root, 'nested', 'deep', 'z.png'), 'z');

    const found = walk(root, fs).sort();
    assert.deepStrictEqual(found, [
      path.join(root, 'nested', 'deep', 'z.png'),
      path.join(root, 'top.png'),
      path.join(root, 'visit-home', '0.png'),
    ].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('walk: missing directory yields an empty list', () => {
  assert.deepStrictEqual(walk('/nonexistent/path/should/not/exist', fs), []);
});
