'use strict';
//
// Unit tests for the pure permission-gate trigger/actor resolver. No deps beyond
// Node's built-in `node:test` + `node:assert` — run with
// `node --test approve/scripts/*.test.js`.
//
// This is the who-can-approve trust boundary; before this suite it was entirely
// untested. The fail-closed arms (bot-authored edit ignored, unchecked box no-op,
// non-PR no-op) are the security-load-bearing cases; they MUST fail if the
// corresponding guard is reverted.
//
const { test } = require('node:test');
const assert = require('node:assert');

const { resolveApprover } = require('./resolve-approver.js');

// A PR-bearing issue (issue_comment events on PRs carry `pull_request`).
const prIssue = { number: 7, pull_request: { url: 'https://api/pulls/7' } };
// A plain issue (comment on an issue, not a PR).
const plainIssue = { number: 7 };

// --- mention shape ------------------------------------------------------- //

test('mention: `@tuffgal approve` resolves the approver to the comment author', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'created',
    comment: { body: '@tuffgal approve', user: { login: 'maintainer' } },
    issue: prIssue,
    contextActor: 'someone-else',
  });
  assert.deepStrictEqual(result, {
    proceed: true,
    actor: 'maintainer',
    via: 'mention',
    reason: null,
  });
});

test('mention: matches at the start of a line and is case-insensitive', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'created',
    comment: { body: '@TuffGal APPROVE please', user: { login: 'maintainer' } },
    issue: prIssue,
    contextActor: 'ignored',
  });
  assert.strictEqual(result.proceed, true);
  assert.strictEqual(result.via, 'mention');
  assert.strictEqual(result.actor, 'maintainer');
});

test('mention: `@tuffgal approve` mid-sentence (preceded by whitespace) still triggers', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'created',
    comment: { body: 'looks good, @tuffgal approve now', user: { login: 'maintainer' } },
    issue: prIssue,
    contextActor: 'ignored',
  });
  assert.strictEqual(result.proceed, true);
  assert.strictEqual(result.via, 'mention');
});

test('mention: `@tuffgal approved` (no word boundary) does NOT trigger', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'created',
    comment: { body: 'already @tuffgal approved this', user: { login: 'maintainer' } },
    issue: prIssue,
    contextActor: 'ignored',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
});

test('mention: embedded in a larger token (`x@tuffgal approve`) does NOT trigger', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'created',
    comment: { body: 'x@tuffgal approve', user: { login: 'maintainer' } },
    issue: prIssue,
    contextActor: 'ignored',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
});

// --- checkbox shape ------------------------------------------------------ //

const reportBody = (box) =>
  [
    '<!-- tuffgal-report -->',
    'Some visual report table…',
    `- [${box}] <!-- tuffgal-approve-box --> Approve these baselines`,
  ].join('\n');

test('checkbox: a ticked approve box on an edited report resolves to the EDITOR', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    // The comment author is the bot; the approver is whoever ticked it.
    comment: { body: reportBody('x'), user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.deepStrictEqual(result, {
    proceed: true,
    actor: 'the-editor',
    via: 'checkbox',
    reason: null,
  });
});

test('checkbox: an UNCHECKED box is a no-op (fail closed)', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body: reportBody(' '), user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
});

test('checkbox: a ticked box on a non-edited (created) event does NOT trigger', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'created',
    comment: { body: reportBody('x'), user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
});

test('checkbox: a ticked box missing the report marker does NOT trigger', () => {
  const body = '- [x] <!-- tuffgal-approve-box --> Approve';
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body, user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
});

// The report marker is present and a box is ticked, but the ticked box is NOT
// the approve box (the approve box itself is unticked). This locks the
// marker-ADJACENCY requirement: a fail-open refactor that checked for the report
// marker plus any `[x]` separately — rather than a checked box immediately
// bearing the approve-box marker — would wrongly proceed here.
test('checkbox: a ticked unrelated box does NOT satisfy the approve box (fail closed)', () => {
  const body = [
    '<!-- tuffgal-report -->',
    '- [x] some unrelated checkbox',
    '- [ ] <!-- tuffgal-approve-box --> Approve these baselines',
  ].join('\n');
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body, user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
});

// --- fail-closed actor guard --------------------------------------------- //
// The bot-suffix ignore stops the visual workflow's own sticky-comment refresh
// (a `[bot]` editor) from looping back into an approval. Reverting the
// `/\[bot\]$/` guard makes this pass through as proceed:true.

test('actor: a bot-authored checkbox edit is ignored (fail closed)', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body: reportBody('x'), user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'tuffgal[bot]',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'ignored-actor');
  assert.strictEqual(result.actor, 'tuffgal[bot]');
});

test('actor: a mention whose author is a bot is ignored (fail closed)', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'created',
    comment: { body: '@tuffgal approve', user: { login: 'dependabot[bot]' } },
    issue: prIssue,
    contextActor: 'ignored',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'ignored-actor');
});

test('actor: a missing mention author is ignored (fail closed)', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'created',
    comment: { body: '@tuffgal approve' }, // no `user`
    issue: prIssue,
    contextActor: 'ignored',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'ignored-actor');
});

// --- not-a-PR early-out -------------------------------------------------- //

test('non-PR: a `@tuffgal approve` on a plain issue is a no-op', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'created',
    comment: { body: '@tuffgal approve', user: { login: 'maintainer' } },
    issue: plainIssue,
    contextActor: 'maintainer',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
});

test('non-PR: a missing issue is a no-op', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'created',
    comment: { body: '@tuffgal approve', user: { login: 'maintainer' } },
    issue: undefined,
    contextActor: 'maintainer',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
});

test('neither: a plain comment on a PR is a no-op', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'created',
    comment: { body: 'just a normal comment', user: { login: 'maintainer' } },
    issue: prIssue,
    contextActor: 'maintainer',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
});

test('missing comment yields an empty body and a no-op', () => {
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'created',
    comment: undefined,
    issue: prIssue,
    contextActor: 'maintainer',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
});
