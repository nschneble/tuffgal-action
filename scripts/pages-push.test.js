'use strict';
//
// Unit tests for the pure retryable-vs-terminal push classifier. No deps beyond
// Node's built-in `node:test` + `node:assert` — run with
// `node --test scripts/*.test.js`.
//
const { test } = require('node:test');
const assert = require('node:assert');

const { isRetryablePushError } = require('./pages-push.js');

// Real `git push` stderr for a concurrent-PR race: the shared branch tip
// advanced between our shallow clone and our push, so ours is rejected
// non-fast-forward. This is the whole reason the retry exists.
const NON_FAST_FORWARD = [
  'To https://github.com/owner/repo.git',
  ' ! [rejected]        HEAD -> gh-pages (non-fast-forward)',
  "error: failed to push some refs to 'https://github.com/owner/repo.git'",
  "hint: Updates were rejected because the tip of your current branch is behind",
  'hint: its remote counterpart. Integrate the remote changes (e.g.',
  "hint: 'git pull ...') before pushing again.",
].join('\n');

test('a non-fast-forward rejection is retryable', () => {
  assert.strictEqual(isRetryablePushError(NON_FAST_FORWARD), true);
});

test('a "fetch first" rejection is retryable', () => {
  const out = [
    ' ! [rejected]        gh-pages -> gh-pages (fetch first)',
    "error: failed to push some refs to 'https://github.com/owner/repo.git'",
  ].join('\n');
  assert.strictEqual(isRetryablePushError(out), true);
});

test('a lost ref compare-and-swap is retryable', () => {
  const out =
    "error: cannot lock ref 'refs/heads/gh-pages': is at 1111111 but expected 2222222";
  assert.strictEqual(isRetryablePushError(out), true);
});

test('a 403 (no contents: write) is terminal', () => {
  const out =
    "remote: Permission to owner/repo.git denied to tuffgal[bot].\n" +
    "fatal: unable to access 'https://github.com/owner/repo.git/': The requested URL returned error: 403";
  assert.strictEqual(isRetryablePushError(out), false);
});

test('a 401 authentication failure is terminal', () => {
  const out =
    "fatal: Authentication failed for 'https://github.com/owner/repo.git/'\n" +
    'remote: HTTP 401';
  assert.strictEqual(isRetryablePushError(out), false);
});

test('a write-access denial is terminal', () => {
  const out =
    'remote: Write access to repository not granted.\n' +
    "fatal: unable to access 'https://github.com/owner/repo.git/'";
  assert.strictEqual(isRetryablePushError(out), false);
});

// The trap: a protected-branch decline ALSO prints "failed to push some refs"
// and a "[remote rejected]" line. It must be classified terminal (retrying a
// server-side hook decline never helps), which is why the terminal signals are
// checked before the non-fast-forward ones.
test('a protected-branch decline is terminal despite a rejected line', () => {
  const out = [
    'remote: error: GH006: Protected branch update failed for refs/heads/gh-pages.',
    'remote: error: Required status check is expected.',
    ' ! [remote rejected] gh-pages -> gh-pages (protected branch hook declined)',
    "error: failed to push some refs to 'https://github.com/owner/repo.git'",
  ].join('\n');
  assert.strictEqual(isRetryablePushError(out), false);
});

test('an unrecognized error is treated as terminal (no blind retry)', () => {
  assert.strictEqual(isRetryablePushError('fatal: the remote end hung up unexpectedly'), false);
});

test('empty / nullish input is terminal', () => {
  assert.strictEqual(isRetryablePushError(''), false);
  assert.strictEqual(isRetryablePushError(undefined), false);
  assert.strictEqual(isRetryablePushError(null), false);
});
