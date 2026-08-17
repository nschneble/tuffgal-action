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
    // A mention is always a full approve.
    selection: 'all',
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

// One per-item approve checkbox line, mirroring `scripts/build-comment.js`'s
// `approveItemCheckbox` render: box state, the item marker with a comma-joined
// key payload, then the bold story name.
const itemLine = (box, keys, name) =>
  `- [${box}] <!-- tuffgal-approve-item:${keys} --> **${name}**`;

// A full report body carrying the (unticked) master box plus a set of per-item
// boxes, so the master-vs-item precedence and item-union math are exercised
// against a body shaped like the real comment.
const itemReportBody = (masterBox, items) =>
  [
    '<!-- tuffgal-report -->',
    'Some visual report table…',
    ...items.map(({ box, keys, name }) => itemLine(box, keys, name)),
    `- [${masterBox}] <!-- tuffgal-approve-box --> Approve these baselines`,
  ].join('\n');

test('checkbox: a ticked master box on an edited report resolves to the EDITOR and full approve', () => {
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
    // The master box means approve everything.
    selection: 'all',
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
  assert.strictEqual(result.selection, null);
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

// --- partial per-item approve shape -------------------------------------- //
// The new trigger: with the master box UNticked, one or more per-story item
// boxes ticked is itself a valid approve, narrowed to the union of the ticked
// stories' action keys. Same trust boundary as the master box (edited event +
// report marker), so the actor is the editor.

test('item: one ticked item box (master unticked) approves just that story key', () => {
  const body = itemReportBody(' ', [{ box: 'x', keys: 'home-hero', name: 'Home hero' }]);
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body, user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.deepStrictEqual(result, {
    proceed: true,
    actor: 'the-editor',
    via: 'checkbox',
    reason: null,
    selection: ['home-hero'],
  });
});

test('item: multiple ticked item boxes across stories union their keys (deduped)', () => {
  const body = itemReportBody(' ', [
    { box: 'x', keys: 'home-hero', name: 'Home hero' },
    { box: ' ', keys: 'about-team', name: 'About team' }, // unticked → excluded
    { box: 'X', keys: 'home-hero,footer', name: 'Footer (also home-hero)' }, // dup home-hero
  ]);
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body, user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.strictEqual(result.proceed, true);
  assert.strictEqual(result.via, 'checkbox');
  // Union of the two TICKED boxes, home-hero deduped; about-team never enters.
  assert.deepStrictEqual(result.selection, ['home-hero', 'footer']);
});

test('item: a single ticked box with a multi-key payload contributes every key', () => {
  const body = itemReportBody(' ', [{ box: 'x', keys: 'key-one,key-two', name: 'Two keys' }]);
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body, user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.strictEqual(result.proceed, true);
  assert.deepStrictEqual(result.selection, ['key-one', 'key-two']);
});

test('item + master both ticked: the master box wins (full approve)', () => {
  const body = itemReportBody('x', [{ box: 'x', keys: 'home-hero', name: 'Home hero' }]);
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body, user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.strictEqual(result.proceed, true);
  assert.strictEqual(result.via, 'checkbox');
  // Master takes precedence over the partial item state ticked alongside it.
  assert.strictEqual(result.selection, 'all');
});

test('item: no boxes ticked at all is a no-op (unchanged fail-closed behavior)', () => {
  const body = itemReportBody(' ', [
    { box: ' ', keys: 'home-hero', name: 'Home hero' },
    { box: ' ', keys: 'about-team', name: 'About team' },
  ]);
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body, user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
  assert.strictEqual(result.selection, null);
});

// A ticked item box whose payload is empty (rendered as `tuffgal-approve-item:`
// for a story with no action keys) contributes nothing — so if it's the only
// ticked box, there is nothing to approve and it is not a trigger.
test('item: a ticked box with an empty payload contributes nothing (no-op alone)', () => {
  const body = itemReportBody(' ', [{ box: 'x', keys: '', name: 'Keyless story' }]);
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body, user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
  assert.strictEqual(result.selection, null);
});

// An empty-payload ticked box alongside a keyed ticked box: the empty one drops
// out, the keyed one still drives a partial approve.
test('item: an empty-payload ticked box drops out but a keyed sibling still triggers', () => {
  const body = itemReportBody(' ', [
    { box: 'x', keys: '', name: 'Keyless story' },
    { box: 'x', keys: 'home-hero', name: 'Home hero' },
  ]);
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body, user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.strictEqual(result.proceed, true);
  assert.deepStrictEqual(result.selection, ['home-hero']);
});

test('item: a ticked item box on a non-edited (created) event does NOT trigger', () => {
  const body = itemReportBody(' ', [{ box: 'x', keys: 'home-hero', name: 'Home hero' }]);
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'created',
    comment: { body, user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
  assert.strictEqual(result.selection, null);
});

test('item: ticked item boxes missing the report marker do NOT trigger', () => {
  const body = itemLine('x', 'home-hero', 'Home hero'); // no <!-- tuffgal-report -->
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body, user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'the-editor',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
  assert.strictEqual(result.selection, null);
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
  assert.strictEqual(result.selection, null);
});

// The same bot-suffix guard must ignore a bot editor who ticked per-item boxes,
// not just the master box — the partial trigger shares the master's actor gate.
test('actor: a bot-authored per-item box edit is ignored (fail closed)', () => {
  const body = itemReportBody(' ', [{ box: 'x', keys: 'home-hero', name: 'Home hero' }]);
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body, user: { login: 'tuffgal[bot]' } },
    issue: prIssue,
    contextActor: 'tuffgal[bot]',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'ignored-actor');
  assert.strictEqual(result.selection, null);
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

// --- isAllowedPermission: the who-may-approve boundary --------------------- //

const { APPROVE_PERMISSIONS, isAllowedPermission } = require('./resolve-approver.js');

test('isAllowedPermission: admin, maintain, and write may approve', () => {
  for (const level of ['admin', 'maintain', 'write']) {
    assert.strictEqual(isAllowedPermission(level), true, `${level} may approve`);
  }
  assert.deepStrictEqual(APPROVE_PERMISSIONS, ['admin', 'maintain', 'write']);
});

test('isAllowedPermission: read and none may NOT approve', () => {
  for (const level of ['read', 'none', 'triage']) {
    assert.strictEqual(isAllowedPermission(level), false, `${level} must be refused`);
  }
});

test('isAllowedPermission: a failed lookup (undefined/null/empty) fails closed', () => {
  // The gate seeds `level = 'none'` and only overwrites it on a successful
  // lookup, but the predicate must refuse these outright regardless.
  for (const level of [undefined, null, '', 'ADMIN', 'write ', 0, {}]) {
    assert.strictEqual(isAllowedPermission(level), false, `${String(level)} must be refused`);
  }
});
