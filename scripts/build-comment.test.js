'use strict';
//
// Unit tests for the pure sticky-comment body builder. No deps beyond Node's
// built-in `node:test` + `node:assert` — run with `node --test scripts/*.test.js`.
//
const { test } = require('node:test');
const assert = require('node:assert');

const { buildCommentBody, MARKER, renderTotalsTable, renderEnvMismatchBanner } = require('./build-comment.js');

// A baseline set of args. Individual tests override only what they exercise so
// the branch under test is isolated from the rest of the body.
const base = () => ({
  outcome: 'pass',
  counts: { passed: '3', changed: '0', new: '0', deleted: '0', failed: '0', total: '3' },
  envMismatch: false,
  mismatchKeys: [],
  previewUrl: '',
  changed: [],
  neu: [],
  deletedNames: [],
  runUrl: 'https://github.com/o/r/actions/runs/1',
});

test('every body opens with the sticky marker so the upsert can find it', () => {
  const body = buildCommentBody(base());
  assert.ok(body.startsWith(MARKER + '\n'));
  assert.match(body, /## 👁️ Tuffgal visual regression/);
});

test('the outcome and totals table are always rendered', () => {
  const body = buildCommentBody(base());
  assert.match(body, /Outcome: \*\*pass\*\*/);
  assert.match(body, /\| Pass \| 3 \|/);
  assert.match(body, /\| Total \| 3 \|/);
});

test('a passing run with no pending work degrades to a bare run link', () => {
  const body = buildCommentBody(base());
  assert.match(body, /\[View the run →\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)/);
  assert.doesNotMatch(body, /Approve these changes/);
  assert.doesNotMatch(body, /Open the report/);
});

test('a pass with a preview but no pending work offers report + run links', () => {
  const body = buildCommentBody({ ...base(), previewUrl: 'https://pages.example/pr-7' });
  assert.match(body, /\[Open the report →\]\(https:\/\/pages\.example\/pr-7\/report\/index\.html\)/);
  assert.match(body, /\[View the run →\]/);
  assert.doesNotMatch(body, /Approve these changes/);
});

test('env-mismatch banner renders with its changed keys when the flag is set', () => {
  const body = buildCommentBody({
    ...base(),
    outcome: 'env-mismatch',
    envMismatch: true,
    mismatchKeys: ['os', 'viewport'],
  });
  assert.match(body, /⚠️ \*\*Capture environment changed\*\*/);
  assert.match(body, /Changed keys: `os`, `viewport`/);
});

test('env-mismatch banner omits the keys line when none are reported', () => {
  const body = buildCommentBody({ ...base(), envMismatch: true, mismatchKeys: [] });
  assert.match(body, /⚠️ \*\*Capture environment changed\*\*/);
  assert.doesNotMatch(body, /Changed keys:/);
});

test('no banner when the environment matched', () => {
  const body = buildCommentBody(base());
  assert.doesNotMatch(body, /Capture environment changed/);
});

test('changed stories without a preview list plain names', () => {
  const body = buildCommentBody({
    ...base(),
    outcome: 'changed',
    counts: { ...base().counts, changed: '1', total: '4' },
    changed: [{ index: 0, name: 'Home page', baseline: null, actual: null, diff: null }],
  });
  assert.match(body, /\*\*Changed \(1\)\*\*/);
  assert.match(body, /- Home page/);
  assert.doesNotMatch(body, /<details>/);
});

test('changed stories with a preview render thumbnails, a deep link, and name-bearing alt text', () => {
  const body = buildCommentBody({
    ...base(),
    outcome: 'changed',
    counts: { ...base().counts, changed: '1', total: '4' },
    previewUrl: 'https://pages.example/pr-7',
    changed: [{
      index: 2,
      name: 'Login form',
      baseline: 'https://pages.example/pr-7/baselines/login.png',
      actual: 'https://pages.example/pr-7/report/login.png',
      diff: 'https://pages.example/pr-7/report/login.diff.png',
    }],
  });
  assert.match(body, /<summary>Login form<\/summary>/);
  // Alt text threads the story name for per-image screen-reader context.
  assert.match(body, /alt="baseline for Login form"/);
  assert.match(body, /alt="actual for Login form"/);
  assert.match(body, /alt="diff for Login form"/);
  assert.match(body, /<img src="https:\/\/pages\.example\/pr-7\/baselines\/login\.png"/);
  assert.match(body, /\[Open in report →\]\(https:\/\/pages\.example\/pr-7\/report\/index\.html#story-2\)/);
});

test('a missing image URL renders an unavailable placeholder, not a broken img', () => {
  const body = buildCommentBody({
    ...base(),
    outcome: 'changed',
    counts: { ...base().counts, changed: '1', total: '1' },
    previewUrl: 'https://pages.example/pr-7',
    changed: [{ index: 0, name: 'Widget', baseline: null, actual: null, diff: null }],
  });
  assert.match(body, /<em>baseline for Widget unavailable<\/em>/);
  assert.doesNotMatch(body, /<img/);
});

test('the img src is attribute-escaped so a crafted path cannot break out', () => {
  const body = buildCommentBody({
    ...base(),
    outcome: 'changed',
    counts: { ...base().counts, changed: '1', total: '1' },
    previewUrl: 'https://pages.example/pr-7',
    changed: [{
      index: 0,
      name: 'X',
      baseline: 'https://pages.example/pr-7/report/a"><script>b.png',
      actual: null,
      diff: null,
    }],
  });
  assert.doesNotMatch(body, /src="[^"]*"><script>/);
  assert.match(body, /&quot;&gt;&lt;script&gt;/);
});

test('a story name with HTML metacharacters is escaped in summary and alt', () => {
  const body = buildCommentBody({
    ...base(),
    outcome: 'changed',
    counts: { ...base().counts, changed: '1', total: '1' },
    previewUrl: 'https://pages.example/pr-7',
    changed: [{ index: 0, name: 'a <b> "c"', baseline: 'https://pages.example/pr-7/report/x.png', actual: null, diff: null }],
  });
  assert.match(body, /<summary>a &lt;b&gt; "c"<\/summary>/);
  assert.match(body, /alt="baseline for a &lt;b&gt; &quot;c&quot;"/);
});

test('new stories with a preview show a proposed baseline with name-bearing alt', () => {
  const body = buildCommentBody({
    ...base(),
    outcome: 'changed',
    counts: { ...base().counts, new: '1', total: '1' },
    previewUrl: 'https://pages.example/pr-7',
    neu: [{ index: 1, name: 'Nav bar', actual: 'https://pages.example/pr-7/report/nav.png' }],
  });
  assert.match(body, /\*\*New \(1\)\*\*/);
  assert.match(body, /Proposed new baseline: <img/);
  assert.match(body, /alt="proposed baseline for Nav bar"/);
});

test('new stories without a preview list plain names', () => {
  const body = buildCommentBody({
    ...base(),
    outcome: 'changed',
    counts: { ...base().counts, new: '1', total: '1' },
    neu: [{ index: 0, name: 'Nav bar', actual: null }],
  });
  assert.match(body, /- Nav bar/);
  assert.doesNotMatch(body, /<details>/);
});

test('deleted stories are listed with newlines flattened', () => {
  const body = buildCommentBody({
    ...base(),
    outcome: 'changed',
    counts: { ...base().counts, deleted: '2', total: '2' },
    deletedNames: ['Old header', 'multi\nline name'],
  });
  assert.match(body, /\*\*Deleted \(2\)\*\*/);
  assert.match(body, /- Old header/);
  assert.match(body, /- multi line name/);
});

test('pending work renders the approve CTA and the approve-box marker', () => {
  const body = buildCommentBody({
    ...base(),
    outcome: 'changed',
    counts: { ...base().counts, changed: '1', total: '1' },
    previewUrl: 'https://pages.example/pr-7',
    changed: [{ index: 0, name: 'Home', baseline: null, actual: null, diff: null }],
  });
  assert.match(body, /### Approve these changes/);
  assert.match(body, /<!-- tuffgal-approve-box -->/);
  assert.match(body, /📊 \[Open the full report\]/);
  assert.match(body, /@tuffgal approve/);
});

test('a no-results outcome names the concrete config fix', () => {
  const body = buildCommentBody({
    ...base(),
    outcome: 'no-results',
    counts: { passed: '0', changed: '0', new: '0', deleted: '0', failed: '0', total: '0' },
  });
  assert.match(body, /The run wrote no `results\.json`/);
  assert.match(body, /`report-path` matches `paths\.report` in tuffgal\.config\.ts/);
  assert.match(body, /\[View the run →\]/);
  assert.doesNotMatch(body, /Approve these changes/);
});

test('a failed outcome points at the report artifact', () => {
  const body = buildCommentBody({
    ...base(),
    outcome: 'failed',
    counts: { passed: '2', changed: '0', new: '0', deleted: '0', failed: '1', total: '3' },
  });
  assert.match(body, /Download the `tuffgal-report` artifact and open `index\.html`/);
});

test('a failed outcome that also has pending work keeps the approve CTA', () => {
  const body = buildCommentBody({
    ...base(),
    outcome: 'failed',
    counts: { passed: '1', changed: '1', new: '0', deleted: '0', failed: '1', total: '3' },
    changed: [{ index: 0, name: 'Home', baseline: null, actual: null, diff: null }],
  });
  assert.match(body, /Download the `tuffgal-report` artifact/);
  assert.match(body, /### Approve these changes/);
});

test('a pass outcome adds no actionable next-step line', () => {
  const body = buildCommentBody(base());
  assert.doesNotMatch(body, /Download the `tuffgal-report`/);
  assert.doesNotMatch(body, /The run wrote no/);
});

test('empty story lists render only the outcome, table, and fallback link', () => {
  const body = buildCommentBody(base());
  assert.doesNotMatch(body, /\*\*Changed/);
  assert.doesNotMatch(body, /\*\*New/);
  assert.doesNotMatch(body, /\*\*Deleted/);
});

// The exported renderers are the single source of truth the step summary can
// adopt later; lock their shape here.
test('renderTotalsTable emits the fixed row order', () => {
  const rows = renderTotalsTable({ passed: '1', changed: '2', new: '3', deleted: '4', failed: '5', total: '6' });
  assert.deepStrictEqual(rows, [
    '| Status | Count |',
    '|--------|-------|',
    '| Pass | 1 |',
    '| Changed | 2 |',
    '| New | 3 |',
    '| Deleted | 4 |',
    '| Failed | 5 |',
    '| Total | 6 |',
  ]);
});

test('renderEnvMismatchBanner appends the keys line only when keys exist', () => {
  assert.strictEqual(renderEnvMismatchBanner([]).length, 1);
  assert.strictEqual(renderEnvMismatchBanner(['os']).length, 3);
});
