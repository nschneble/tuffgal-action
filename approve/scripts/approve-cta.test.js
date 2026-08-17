'use strict';
//
// Unit tests for the CTA rewrites — what the "Approve these changes" section
// becomes after a full or partial approval. Run with
// `node --test approve/scripts/*.test.js`.
//
// The loop-safety arms are load-bearing: no rewrite may leave a ticked approve
// marker in the body, or the approve workflow retriggers on itself.
//
const { test } = require('node:test');
const assert = require('node:assert');

const { CTA_HEADING, stripApproveCta, applyPartialApproval } = require('./approve-cta.js');
const { REPORT_MARKER, hasTickedApproveMarker } = require('./report-comment.js');

// The real body builder — a cross-package require is fine in a test (it runs
// against the whole checkout), and it is what keeps the hand-duplicated
// CTA_HEADING honest.
const { buildCommentBody } = require('../../scripts/build-comment.js');

test('CTA_HEADING is byte-identical to the heading build-comment.js emits', () => {
  const body = buildCommentBody({
    outcome: 'changed',
    counts: { passed: '0', changed: '1', new: '0', deleted: '0', failed: '0', total: '1' },
    envMismatch: false,
    mismatchKeys: [],
    previewUrl: '',
    changed: [{ index: 0, name: 'Button', shots: [{}], actionKeys: ['button-primary'] }],
    added: [],
    deleted: [],
    failed: [],
    multiBreakpoint: false,
    runUrl: 'https://example/run',
  });
  assert.ok(
    body.split('\n').includes(CTA_HEADING),
    'the builder must emit this exact heading, or stripApproveCta silently stops stripping'
  );
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

// --- applyPartialApproval ------------------------------------------------- //

// The exact top-level CTA box line build-comment.js emits (its buildCommentBody
// approve-box line), and the relabeled form applyPartialApproval swaps its human
// text to while leaving the marker + `[ ]` prefix byte-identical.
const TOP_BOX_ORIGINAL =
  '- [ ] <!-- tuffgal-approve-box --> **Approve these baselines** — tick to commit the candidate baselines to this PR (requires write access).';
const TOP_BOX_RELABELED =
  '- [ ] <!-- tuffgal-approve-box --> **Approve remaining baselines** — tick to commit the remaining candidate baselines to this PR (requires write access).';

// A realistic unticked partial-approve body: a Changed section with three per-item
// boxes and the top-level CTA box (the shape untickApproveBoxes hands to
// applyPartialApproval).
function partialBody(items) {
  return [
    REPORT_MARKER,
    '## 👁️ Tuffgal visual regression',
    '',
    `### Changed (${items.length})`,
    '',
    ...items,
    '',
    '### Approve these changes',
    '',
    TOP_BOX_ORIGINAL,
    '',
    '…or comment `@tuffgal approve`.',
    '',
    '[View the run →](https://example/run)',
  ].join('\n');
}

test('applyPartialApproval: converts a per-item box to a checkless "✅ Approved" line and drops its marker', () => {
  const body = partialBody(['- [ ] <!-- tuffgal-approve-item:a --> Approve **Alpha**', '- [ ] <!-- tuffgal-approve-item:b --> Approve **Bravo**']);
  const out = applyPartialApproval(body, ['a']);
  assert.match(out, /^- ✅ Approved \*\*Alpha\*\*$/m);
  // The approved line carries neither the item marker nor any checkbox syntax.
  assert.doesNotMatch(out, /tuffgal-approve-item:a/);
  const alphaLine = out.split('\n').find((line) => line.includes('Alpha'));
  assert.ok(!alphaLine.includes('[ ]') && !alphaLine.includes('<!--'), 'approved line must have no checkbox or marker');
});

test('applyPartialApproval: a two-key item is approved ONLY when BOTH keys are in the selection', () => {
  const body = partialBody(['- [ ] <!-- tuffgal-approve-item:a,b --> Approve **Combo**']);
  // Both keys approved -> converted.
  assert.match(applyPartialApproval(body, ['a', 'b']), /^- ✅ Approved \*\*Combo\*\*$/m);
  // Only one of the two keys approved -> left completely untouched.
  const partial = applyPartialApproval(body, ['a']);
  assert.match(partial, /^- \[ \] <!-- tuffgal-approve-item:a,b --> Approve \*\*Combo\*\*$/m);
  assert.doesNotMatch(partial, /✅ Approved \*\*Combo\*\*/);
});

test('applyPartialApproval: some items approved, some left alone, in the same body', () => {
  const body = partialBody([
    '- [ ] <!-- tuffgal-approve-item:a --> Approve **Alpha**',
    '- [ ] <!-- tuffgal-approve-item:b --> Approve **Bravo**',
    '- [ ] <!-- tuffgal-approve-item:c --> Approve **Charlie**',
  ]);
  const out = applyPartialApproval(body, ['a', 'c']);
  assert.match(out, /^- ✅ Approved \*\*Alpha\*\*$/m);
  assert.match(out, /^- ✅ Approved \*\*Charlie\*\*$/m);
  // Bravo was not approved: still an unticked, re-tickable box with its marker.
  assert.match(out, /^- \[ \] <!-- tuffgal-approve-item:b --> Approve \*\*Bravo\*\*$/m);
});

test('applyPartialApproval: an approved item preserves its breakpoint suffix verbatim', () => {
  const body = partialBody(['- [ ] <!-- tuffgal-approve-item:card-hover,card-focus --> Approve **Card** (mobile, desktop)']);
  const out = applyPartialApproval(body, ['card-hover', 'card-focus']);
  assert.match(out, /^- ✅ Approved \*\*Card\*\* \(mobile, desktop\)$/m);
  assert.doesNotMatch(out, /tuffgal-approve-item/);
});

test('applyPartialApproval: relabels the top-level box text only — marker + `[ ]` state byte-identical', () => {
  const body = partialBody([
    '- [ ] <!-- tuffgal-approve-item:a --> Approve **Alpha**',
    '- [ ] <!-- tuffgal-approve-item:b --> Approve **Bravo**',
  ]);
  const out = applyPartialApproval(body, ['a']);
  // Exact before/after: only the human label prose differs.
  assert.ok(!out.includes(TOP_BOX_ORIGINAL), 'original top-level label should be gone');
  assert.ok(out.includes(TOP_BOX_RELABELED), 'top-level box should carry the relabeled prose');
  // The marker + checkbox prefix is byte-identical (still a valid unticked box).
  assert.match(out, /^- \[ \] <!-- tuffgal-approve-box -->/m);
});

test('applyPartialApproval: an empty-payload item box approves nothing and stays pending', () => {
  const body = partialBody([
    '- [ ] <!-- tuffgal-approve-item: --> Approve **Nameless**',
    '- [ ] <!-- tuffgal-approve-item:a --> Approve **Alpha**',
  ]);
  const out = applyPartialApproval(body, ['a']);
  // The empty-payload box has no keys, so it is never marked approved.
  assert.match(out, /^- \[ \] <!-- tuffgal-approve-item: --> Approve \*\*Nameless\*\*$/m);
  assert.doesNotMatch(out, /✅ Approved \*\*Nameless\*\*/);
  // ...and because an unapproved box remains, the top-level box is relabeled, not stripped.
  assert.ok(out.includes(TOP_BOX_RELABELED));
});

test('applyPartialApproval: a partial that covers EVERY item strips the whole CTA (no dangling top-level box)', () => {
  const body = partialBody([
    '- [ ] <!-- tuffgal-approve-item:a --> Approve **Alpha**',
    '- [ ] <!-- tuffgal-approve-item:b --> Approve **Bravo**',
  ]);
  const out = applyPartialApproval(body, ['a', 'b']);
  // Both items converted...
  assert.match(out, /^- ✅ Approved \*\*Alpha\*\*$/m);
  assert.match(out, /^- ✅ Approved \*\*Bravo\*\*$/m);
  // ...and with nothing left to approve, the CTA (heading + top-level box) is gone.
  assert.doesNotMatch(out, /### Approve these changes/);
  assert.doesNotMatch(out, /tuffgal-approve-box/);
  assert.doesNotMatch(out, /Approve remaining baselines/);
});

test('applyPartialApproval: output NEVER carries a ticked approve marker (loop-safe)', () => {
  const body = partialBody([
    '- [ ] <!-- tuffgal-approve-item:a --> Approve **Alpha**',
    '- [ ] <!-- tuffgal-approve-item:b --> Approve **Bravo**',
  ]);
  assert.strictEqual(hasTickedApproveMarker(applyPartialApproval(body, ['a'])), false);
  assert.strictEqual(hasTickedApproveMarker(applyPartialApproval(body, ['a', 'b'])), false);
});

test('applyPartialApproval: tolerates a non-array selection (defensive) — no item is approved', () => {
  const body = partialBody(['- [ ] <!-- tuffgal-approve-item:a --> Approve **Alpha**']);
  const out = applyPartialApproval(body, undefined);
  // No keys approved, so the box stays pending and the top-level box is relabeled.
  assert.match(out, /^- \[ \] <!-- tuffgal-approve-item:a --> Approve \*\*Alpha\*\*$/m);
  assert.ok(out.includes(TOP_BOX_RELABELED));
});

