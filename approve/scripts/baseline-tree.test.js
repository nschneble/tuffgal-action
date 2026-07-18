'use strict';
//
// Unit tests for the pure baseline-tree logic. No deps beyond Node's built-in
// `node:test` + `node:assert` — run with `node --test approve/scripts/*.test.js`.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BaselineScopeError,
  guard,
  walk,
  toRepoPath,
  deriveFrames,
  computeDeletions,
} = require('./baseline-tree.js');

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

// --- guard scope rejections are a tagged type ---------------------------- //
// The commit step's `atHead` ls-tree catch swallows the genuine "no tree at
// head" bootstrap error but MUST re-throw a scope rejection. That fail-closed
// posture depends on the rejection being a distinguishable type, not on where
// the catch sits — so pin the type here. Reverting guard's throws back to a
// bare `Error` makes these fail.
test('guard: scope rejections throw the tagged BaselineScopeError type', () => {
  assert.throws(() => guard('/etc/passwd', 'tuffgal/baselines'), BaselineScopeError);
  assert.throws(
    () => guard('tuffgal/baselines/../../etc/passwd', 'tuffgal/baselines'),
    BaselineScopeError,
  );
  assert.throws(() => guard('some/other/dir/0.png', 'tuffgal/baselines'), BaselineScopeError);
});

test('guard: a BaselineScopeError is still an Error (instanceof both)', () => {
  try {
    guard('/etc/passwd', 'tuffgal/baselines');
    assert.fail('expected guard to throw');
  } catch (e) {
    assert.ok(e instanceof BaselineScopeError);
    assert.ok(e instanceof Error);
    assert.strictEqual(e.name, 'BaselineScopeError');
  }
});

// --- deriveFrames -------------------------------------------------------- //
// The commit step derives its three baseline-path frames from the raw
// working-directory + baselines-path inputs. This was inline and untested; a
// bug here (trailing slash, the '.' case, backslashes) is a frame bug invisible
// to the rest of the suite, which hardcoded workdirPrefix.

test("deriveFrames: '.' working-directory yields an empty prefix", () => {
  assert.deepStrictEqual(deriveFrames('.', 'tuffgal/baselines'), {
    workdirPrefix: '',
    baselinesRelPosix: 'tuffgal/baselines',
    prefix: 'tuffgal/baselines',
  });
});

test('deriveFrames: subdir working-directory re-anchors the prefix to repo root', () => {
  assert.deepStrictEqual(deriveFrames('frontend', 'tuffgal/baselines'), {
    workdirPrefix: 'frontend',
    baselinesRelPosix: 'tuffgal/baselines',
    prefix: 'frontend/tuffgal/baselines',
  });
});

test('deriveFrames: a trailing slash on working-directory is normalized away', () => {
  assert.deepStrictEqual(deriveFrames('frontend/', 'tuffgal/baselines'), {
    workdirPrefix: 'frontend',
    baselinesRelPosix: 'tuffgal/baselines',
    prefix: 'frontend/tuffgal/baselines',
  });
});

// --- frame correctness --------------------------------------------------- //
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
  const onDisk = onDiskNames.map((name) => toRepoPath(name, workdirPrefix, prefix));
  const atHead = atHeadNames.map((name) => toRepoPath(name, workdirPrefix, prefix));
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
  const onDisk = onDiskNames.map((name) => toRepoPath(name, workdirPrefix, prefix));
  const atHead = atHeadNames.map((name) => toRepoPath(name, workdirPrefix, prefix));
  assert.deepStrictEqual(onDisk, ['frontend/tuffgal/baselines/visit-home/desktop.png']);
  assert.deepStrictEqual(computeDeletions(onDisk, atHead), [
    'frontend/tuffgal/baselines/removed/desktop.png',
  ]);
});

// --- deletions math ------------------------------------------------------ //

test('deletions: atHead 50, onDisk 1 overlapping -> 49 deletions', () => {
  const atHead = Array.from({ length: 50 }, (_, index) => `tuffgal/baselines/s${index}/0.png`);
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

// --- walk symlink refusal ------------------------------------------------ //
// The tree walk runs over baselines materialized from the UNTRUSTED PR head.
// A symlink committed there (e.g. leak.png -> /proc/self/environ) would, if
// followed, get its TARGET's bytes blobbed onto the PR branch — secret exfil.
// walk() MUST refuse symlinks fail-closed. These cases pin the invariant in
// BOTH directions and MUST fail if the lstat/reject is reverted to statSync:
//   - symlink-to-file under statSync collects as a plain file (no throw)
//   - symlink-to-dir under statSync recurses into the target (no throw)

const mkTmp = (tag) =>
  fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), tag));

test('walk: refuses a symlink to a file fail-closed', () => {
  const root = mkTmp('bt-symfile-');
  try {
    fs.writeFileSync(path.join(root, 'real.png'), 'x');
    fs.symlinkSync(path.join(root, 'real.png'), path.join(root, 'leak.png'));
    assert.throws(() => walk(root, fs), /Refusing symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('walk: refuses a symlink to a directory fail-closed', () => {
  const root = mkTmp('bt-symdir-');
  try {
    fs.mkdirSync(path.join(root, 'realdir'));
    fs.writeFileSync(path.join(root, 'realdir', '0.png'), 'x');
    fs.symlinkSync(path.join(root, 'realdir'), path.join(root, 'linkdir'), 'dir');
    assert.throws(() => walk(root, fs), /Refusing symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('walk: refuses a symlink escaping the baselines dir (attack shape)', () => {
  const root = mkTmp('bt-symescape-');
  try {
    // The concrete attack: a link whose target is a secret outside the tree.
    fs.symlinkSync('/etc/passwd', path.join(root, 'leak.png'));
    assert.throws(() => walk(root, fs), /Refusing symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('walk: regular files pass; adding a symlink to that same tree refuses it', () => {
  // Direction 1 — a clean tree of regular files is collected as before.
  const clean = mkTmp('bt-clean-');
  try {
    fs.writeFileSync(path.join(clean, 'a.png'), 'x');
    assert.deepStrictEqual(walk(clean, fs), [path.join(clean, 'a.png')]);
  } finally {
    fs.rmSync(clean, { recursive: true, force: true });
  }
  // Direction 2 — the identical shape plus one symlink is refused fail-closed.
  const dirty = mkTmp('bt-dirty-');
  try {
    fs.writeFileSync(path.join(dirty, 'a.png'), 'x');
    fs.symlinkSync('/etc/passwd', path.join(dirty, 'leak.png'));
    assert.throws(() => walk(dirty, fs), /Refusing symlink/);
  } finally {
    fs.rmSync(dirty, { recursive: true, force: true });
  }
});
