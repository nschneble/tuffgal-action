'use strict';
//
// Unit tests for the pure sticky-comment status helpers. No deps beyond Node's
// built-in `node:test` + `node:assert` — run with
// `node --test approve/scripts/*.test.js`.
//
// The loop-safety arms are the security-load-bearing cases: untickApproveBoxes
// must strip every ticked approve marker, hasTickedApproveMarker must flag any
// body that could retrigger the approve workflow, and the integration test proves
// the transformed body is DECLINED by the REAL resolve-approver.js parser — not
// just by this module's own regexes. Those MUST fail if the corresponding guard
// regresses.
//
const { test } = require('node:test');
const assert = require('node:assert');

const {
  REPORT_MARKER,
  STATUS_OPEN,
  STATUS_CLOSE,
  untickApproveBoxes,
  hasTickedApproveMarker,
  withStatusBanner,
  stripApproveCta,
} = require('./report-comment.js');

// The real trigger parser + the real body builder — cross-file requires are fine
// in a test (it runs against the whole checkout).
const { resolveApprover } = require('./resolve-approver.js');
const { MARKER, buildCommentBody } = require('../../scripts/build-comment.js');

// The four literal substrings the consumer workflow prefilters on. Duplicated here
// so the "never in an untick output" assertion pins the real loop trigger.
const TRIGGER_SUBSTRINGS = [
  '[x] <!-- tuffgal-approve-box',
  '[X] <!-- tuffgal-approve-box',
  '[x] <!-- tuffgal-approve-item:',
  '[X] <!-- tuffgal-approve-item:',
];

// --- REPORT_MARKER stays in step with the real MARKER --------------------- //

test('REPORT_MARKER is byte-identical to build-comment.js MARKER', () => {
  assert.strictEqual(REPORT_MARKER, MARKER);
  assert.strictEqual(REPORT_MARKER, '<!-- tuffgal-report -->');
});

// --- untickApproveBoxes --------------------------------------------------- //

test('untickApproveBoxes: unticks the approve-all box in `[x]` form', () => {
  const body = '- [x] <!-- tuffgal-approve-box --> **Approve these baselines** — tick to commit.';
  assert.strictEqual(
    untickApproveBoxes(body),
    '- [ ] <!-- tuffgal-approve-box --> **Approve these baselines** — tick to commit.'
  );
});

test('untickApproveBoxes: unticks the approve-all box in `[X]` (capital) form', () => {
  const body = '- [X] <!-- tuffgal-approve-box --> **Approve these baselines**';
  assert.strictEqual(untickApproveBoxes(body), '- [ ] <!-- tuffgal-approve-box --> **Approve these baselines**');
});

test('untickApproveBoxes: unticks a per-item box and preserves the story name', () => {
  const body = '- [x] <!-- tuffgal-approve-item:button-primary --> Approve **Button**';
  assert.strictEqual(
    untickApproveBoxes(body),
    '- [ ] <!-- tuffgal-approve-item:button-primary --> Approve **Button**'
  );
});

test('untickApproveBoxes: unticks a per-item box in `[X]` form and preserves the breakpoint suffix', () => {
  const body = '- [X] <!-- tuffgal-approve-item:card-hover,card-focus --> Approve **Card** (mobile, desktop)';
  assert.strictEqual(
    untickApproveBoxes(body),
    '- [ ] <!-- tuffgal-approve-item:card-hover,card-focus --> Approve **Card** (mobile, desktop)'
  );
});

test('untickApproveBoxes: unticks an empty-payload per-item box', () => {
  const body = '- [x] <!-- tuffgal-approve-item: --> Approve **Nameless**';
  assert.strictEqual(untickApproveBoxes(body), '- [ ] <!-- tuffgal-approve-item: --> Approve **Nameless**');
});

test('untickApproveBoxes: rewrites BOTH the approve-all box and every per-item box in one body', () => {
  const body = [
    '- [x] <!-- tuffgal-approve-item:a --> Approve **A**',
    '- [X] <!-- tuffgal-approve-item:b --> Approve **B**',
    '- [x] <!-- tuffgal-approve-box --> **Approve these baselines**',
  ].join('\n');
  const out = untickApproveBoxes(body);
  assert.strictEqual(out, [
    '- [ ] <!-- tuffgal-approve-item:a --> Approve **A**',
    '- [ ] <!-- tuffgal-approve-item:b --> Approve **B**',
    '- [ ] <!-- tuffgal-approve-box --> **Approve these baselines**',
  ].join('\n'));
});

test('untickApproveBoxes: is idempotent (apply twice === apply once)', () => {
  const body = [
    '- [x] <!-- tuffgal-approve-box --> **Approve these baselines**',
    '- [X] <!-- tuffgal-approve-item:x,y --> Approve **X** (mobile)',
  ].join('\n');
  const once = untickApproveBoxes(body);
  const twice = untickApproveBoxes(once);
  assert.strictEqual(twice, once);
});

test('untickApproveBoxes: leaves already-unticked boxes untouched', () => {
  const body = [
    '- [ ] <!-- tuffgal-approve-box --> **Approve these baselines**',
    '- [ ] <!-- tuffgal-approve-item:x --> Approve **X**',
  ].join('\n');
  assert.strictEqual(untickApproveBoxes(body), body);
});

test('untickApproveBoxes: leaves an unrelated human-added checkbox untouched', () => {
  const body = [
    '- [x] some unrelated task a reviewer added',
    '- [x] <!-- tuffgal-approve-box --> **Approve these baselines**',
  ].join('\n');
  const out = untickApproveBoxes(body);
  assert.match(out, /- \[x\] some unrelated task a reviewer added/);
  assert.match(out, /- \[ \] <!-- tuffgal-approve-box -->/);
});

test('untickApproveBoxes: output NEVER contains any of the four consumer trigger substrings', () => {
  const body = [
    REPORT_MARKER,
    '- [x] <!-- tuffgal-approve-item:a --> Approve **A**',
    '- [X] <!-- tuffgal-approve-item:b,c --> Approve **B** (mobile, desktop)',
    '- [x] <!-- tuffgal-approve-box --> **Approve these baselines**',
    '- [X] <!-- tuffgal-approve-box --> duplicate somehow',
  ].join('\n');
  const out = untickApproveBoxes(body);
  for (const substring of TRIGGER_SUBSTRINGS) {
    assert.ok(!out.includes(substring), `untick output must not contain ${JSON.stringify(substring)}`);
  }
});

test('untickApproveBoxes: tolerates null / undefined', () => {
  assert.strictEqual(untickApproveBoxes(null), '');
  assert.strictEqual(untickApproveBoxes(undefined), '');
});

// --- hasTickedApproveMarker ----------------------------------------------- //

test('hasTickedApproveMarker: true for a ticked approve-all box (`[x]` and `[X]`)', () => {
  assert.ok(hasTickedApproveMarker('- [x] <!-- tuffgal-approve-box --> **Approve these baselines**'));
  assert.ok(hasTickedApproveMarker('- [X] <!-- tuffgal-approve-box --> **Approve these baselines**'));
});

test('hasTickedApproveMarker: true for a ticked per-item box (`[x]` and `[X]`)', () => {
  assert.ok(hasTickedApproveMarker('- [x] <!-- tuffgal-approve-item:a --> Approve **A**'));
  assert.ok(hasTickedApproveMarker('- [X] <!-- tuffgal-approve-item:a,b --> Approve **A** (mobile)'));
});

test('hasTickedApproveMarker: false once every box is unticked', () => {
  const body = [
    REPORT_MARKER,
    '- [ ] <!-- tuffgal-approve-box --> **Approve these baselines**',
    '- [ ] <!-- tuffgal-approve-item:a --> Approve **A**',
  ].join('\n');
  assert.strictEqual(hasTickedApproveMarker(body), false);
});

test('hasTickedApproveMarker: false for a body with no approve section at all', () => {
  const body = [REPORT_MARKER, '## 👁️ Tuffgal visual regression', '', 'Outcome: **pass**'].join('\n');
  assert.strictEqual(hasTickedApproveMarker(body), false);
});

test('hasTickedApproveMarker: catches a non-`-`-bulleted ticked box the parser regex would miss (prefilter substring)', () => {
  // A `*`-bulleted box does not match the `-\s*\[` parser shape, but the
  // consumer prefilter's plain substring check WOULD fire on it, so the guard
  // must still flag it (defense in depth).
  assert.ok(hasTickedApproveMarker('* [x] <!-- tuffgal-approve-box --> **Approve these baselines**'));
});

// --- withStatusBanner ----------------------------------------------------- //

const bannerBlockCount = (body) => body.split(STATUS_OPEN).length - 1;

test('withStatusBanner: inserts the banner immediately after the marker line', () => {
  const body = [REPORT_MARKER, '## 👁️ Tuffgal visual regression', '', 'Outcome: **changed**'].join('\n');
  const out = withStatusBanner(body, ['> ⚙️ Approving baselines…']);
  const lines = out.split('\n');
  assert.strictEqual(lines[0], REPORT_MARKER);
  // marker, blank, open, content, close, blank, then original next line.
  assert.strictEqual(lines[1], '');
  assert.strictEqual(lines[2], STATUS_OPEN);
  assert.strictEqual(lines[3], '> ⚙️ Approving baselines…');
  assert.strictEqual(lines[4], STATUS_CLOSE);
  assert.strictEqual(lines[5], '');
  assert.strictEqual(lines[6], '## 👁️ Tuffgal visual regression');
});

test('withStatusBanner: accepts a single string as well as an array', () => {
  const out = withStatusBanner(REPORT_MARKER, '> one line');
  assert.match(out, new RegExp(`${STATUS_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n> one line\\n`));
});

test('withStatusBanner: replaces an existing banner in place instead of duplicating (idempotent across calls)', () => {
  const body = [REPORT_MARKER, '## header', '', 'body'].join('\n');
  const first = withStatusBanner(body, ['> ⚙️ in-flight']);
  const second = withStatusBanner(first, ['> 📦 milestone']);
  const third = withStatusBanner(second, ['> ✅ done', '>', '> tail']);
  assert.strictEqual(bannerBlockCount(third), 1);
  assert.match(third, /> ✅ done/);
  assert.doesNotMatch(third, /in-flight/);
  assert.doesNotMatch(third, /milestone/);
});

test('withStatusBanner: re-applying the SAME content is a fixpoint', () => {
  const body = [REPORT_MARKER, 'x'].join('\n');
  const once = withStatusBanner(body, ['> same']);
  const twice = withStatusBanner(once, ['> same']);
  assert.strictEqual(twice, once);
});

test('withStatusBanner: banner lands right after the marker even when the marker is not the first line', () => {
  const body = ['leading junk', REPORT_MARKER, 'after'].join('\n');
  const out = withStatusBanner(body, ['> banner']);
  const lines = out.split('\n');
  const markerIndex = lines.indexOf(REPORT_MARKER);
  assert.strictEqual(lines[markerIndex + 1], '');
  assert.strictEqual(lines[markerIndex + 2], STATUS_OPEN);
});

test('withStatusBanner: a `$` in the banner content survives the replace path literally', () => {
  const body = [REPORT_MARKER, 'x'].join('\n');
  const first = withStatusBanner(body, ['> plain']);
  const second = withStatusBanner(first, ['> price is $5 & $$ special']);
  assert.match(second, /> price is \$5 & \$\$ special/);
  assert.strictEqual(bannerBlockCount(second), 1);
});

// --- stripApproveCta ------------------------------------------------------ //

test('stripApproveCta: removes the whole CTA section including the approve-all box', () => {
  const body = [
    REPORT_MARKER,
    '## 👁️ Tuffgal visual regression',
    '',
    '### Changed (1)',
    '',
    '- [ ] <!-- tuffgal-approve-item:a --> Approve **A**',
    '',
    '### Approve these changes',
    '',
    '- [ ] <!-- tuffgal-approve-box --> **Approve these baselines** — tick to commit.',
    '',
    '…or comment `@tuffgal approve`.',
    '',
    '[View the run →](https://example/run)',
  ].join('\n');
  const out = stripApproveCta(body);
  assert.doesNotMatch(out, /### Approve these changes/);
  assert.doesNotMatch(out, /tuffgal-approve-box/);
  assert.doesNotMatch(out, /@tuffgal approve/);
  // The per-item box in the Changed section is left intact.
  assert.match(out, /### Changed \(1\)/);
  assert.match(out, /tuffgal-approve-item:a/);
  // No trailing blank left dangling before the cut.
  assert.ok(!out.endsWith('\n'));
  assert.ok(out.trimEnd().endsWith('Approve **A**'));
});

test('stripApproveCta: is idempotent (no CTA heading -> unchanged)', () => {
  const body = [REPORT_MARKER, '### Changed (1)', '', '- [ ] <!-- tuffgal-approve-item:a --> Approve **A**'].join('\n');
  assert.strictEqual(stripApproveCta(body), body);
  assert.strictEqual(stripApproveCta(stripApproveCta(body)), body);
});

// --- integration: transformed body is declined by the REAL parser --------- //

// Build a realistic sticky body with both the approve-all box and a per-item box,
// then TICK them (as a human would) so we start from a genuine trigger state.
function tickedStickyBody() {
  const body = buildCommentBody({
    outcome: 'changed',
    counts: { passed: '1', changed: '1', new: '0', deleted: '0', failed: '0', total: '2' },
    envMismatch: false,
    mismatchKeys: [],
    previewUrl: '',
    changed: [{ index: 1, name: 'Button', shots: [{}], actionKeys: ['button-primary'] }],
    added: [],
    deleted: [],
    failed: [],
    multiBreakpoint: false,
    runUrl: 'https://example/run',
  });
  // Simulate a maintainer ticking BOTH the approve-all box and the per-item box.
  return body
    .replace('- [ ] <!-- tuffgal-approve-box', '- [x] <!-- tuffgal-approve-box')
    .replace('- [ ] <!-- tuffgal-approve-item:', '- [x] <!-- tuffgal-approve-item:');
}

test('integration: a ticked body really does trigger the parser (fixture sanity check)', () => {
  const ticked = tickedStickyBody();
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body: ticked, user: { login: 'tuffgal[bot]' } },
    issue: { number: 7, pull_request: { url: 'https://api/pulls/7' } },
    contextActor: 'maintainer',
  });
  // Sanity: without the untick, a human editor on a ticked box DOES proceed.
  assert.strictEqual(result.proceed, true);
});

test('integration: untick + banner makes the REAL resolveApprover DECLINE a re-trigger', () => {
  const ticked = tickedStickyBody();
  const transformed = withStatusBanner(untickApproveBoxes(ticked), [
    '> ⚙️ **Approving baselines** — committing…',
    '>',
    '> [View the run →](https://example/run)',
  ]);

  // The transformed body must not trip our own guard...
  assert.strictEqual(hasTickedApproveMarker(transformed), false);

  // ...and, fed straight back through the REAL parser as a human `edited` event,
  // must not resolve to an approval (loop-safety holds against the real reader).
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body: transformed, user: { login: 'tuffgal[bot]' } },
    issue: { number: 7, pull_request: { url: 'https://api/pulls/7' } },
    contextActor: 'maintainer',
  });
  assert.strictEqual(result.proceed, false);
  assert.strictEqual(result.reason, 'no-trigger');
});

test('integration: none of the four consumer trigger substrings survive the full transform', () => {
  const transformed = withStatusBanner(untickApproveBoxes(tickedStickyBody()), ['> banner']);
  for (const substring of TRIGGER_SUBSTRINGS) {
    assert.ok(!transformed.includes(substring), `transformed body must not contain ${JSON.stringify(substring)}`);
  }
});

test('integration: full-approve transform (untick + strip CTA + banner) is loop-safe and CTA-free', () => {
  const transformed = withStatusBanner(
    stripApproveCta(untickApproveBoxes(tickedStickyBody())),
    ['> ✅ **All baselines approved** and committed as [`abc1234`](https://example/commit/abc1234).']
  );
  assert.strictEqual(hasTickedApproveMarker(transformed), false);
  assert.doesNotMatch(transformed, /### Approve these changes/);
  assert.doesNotMatch(transformed, /tuffgal-approve-box/);
});
