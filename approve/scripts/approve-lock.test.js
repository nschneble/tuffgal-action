'use strict';
//
// Unit tests for the approval lock — the box lock/unlock transforms, the
// in-flight run-id marker, and the pure can-this-request-start decision. Run
// with `node --test approve/scripts/*.test.js`.
//
// The load-bearing arms: a locked body must be DECLINED by the real trigger
// parser and carry none of the consumer workflow's prefilter substrings, and
// decideApproveLock must refuse whenever it could not confirm the owning run is
// finished.
//
const { test } = require('node:test');
const assert = require('node:assert');

const {
  lockApproveBoxes,
  unlockApproveBoxes,
  inFlightMarker,
  inFlightRunId,
  decideApproveLock,
} = require('./approve-lock.js');
const {
  REPORT_MARKER,
  TRIGGER_SUBSTRINGS,
  hasTickedApproveMarker,
  untickApproveBoxes,
  withStatusBanner,
  withQueuedNote,
} = require('./report-comment.js');

// The real trigger parser + the real body builder.
const { resolveApprover } = require('./resolve-approver.js');
const { buildCommentBody } = require('../../scripts/build-comment.js');

// A realistic sticky body with both box shapes, ticked as a human would leave
// them — the genuine trigger state the lock has to neutralize.
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
  return body
    .replace('- [ ] <!-- tuffgal-approve-box', '- [x] <!-- tuffgal-approve-box')
    .replace('- [ ] <!-- tuffgal-approve-item:', '- [x] <!-- tuffgal-approve-item:');
}

// --- lock / unlock while an approval is in flight -------------------------- //

test('lockApproveBoxes: swaps every box for the inert glyph, keeping the marker', () => {
  const body = [
    '- [ ] <!-- tuffgal-approve-item:visit-home --> Approve **Home hero**',
    '- [ ] <!-- tuffgal-approve-box --> **Approve these baselines** — tick to commit.',
  ].join('\n');
  assert.strictEqual(
    lockApproveBoxes(body),
    [
      '- ⏳ <!-- tuffgal-approve-item:visit-home --> Approve **Home hero**',
      '- ⏳ <!-- tuffgal-approve-box --> **Approve these baselines** — tick to commit. ⏳ Locked while an approval runs.',
    ].join('\n')
  );
});

test('lockApproveBoxes: locks a still-TICKED box too, so nothing can retrigger', () => {
  const locked = lockApproveBoxes('- [x] <!-- tuffgal-approve-item:visit-home --> Approve **Home hero**');
  assert.strictEqual(locked, '- ⏳ <!-- tuffgal-approve-item:visit-home --> Approve **Home hero**');
  assert.strictEqual(hasTickedApproveMarker(locked), false);
});

test('lockApproveBoxes: is idempotent — the locked suffix is never doubled', () => {
  const once = lockApproveBoxes('- [ ] <!-- tuffgal-approve-box --> **Approve these baselines** — tick to commit.');
  assert.strictEqual(lockApproveBoxes(once), once);
});

test('unlockApproveBoxes: restores both box shapes and drops the locked suffix', () => {
  const original = [
    '- [ ] <!-- tuffgal-approve-item:visit-home --> Approve **Home hero**',
    '- [ ] <!-- tuffgal-approve-box --> **Approve these baselines** — tick to commit.',
  ].join('\n');
  assert.strictEqual(unlockApproveBoxes(lockApproveBoxes(original)), original);
});

test('unlockApproveBoxes: is idempotent on an already-unlocked body', () => {
  const body = '- [ ] <!-- tuffgal-approve-item:visit-home --> Approve **Home hero**';
  assert.strictEqual(unlockApproveBoxes(body), body);
});

test('a locked body is DECLINED by the REAL resolveApprover', () => {
  const locked = lockApproveBoxes(tickedStickyBody());
  assert.strictEqual(hasTickedApproveMarker(locked), false);
  const result = resolveApprover({
    eventName: 'issue_comment',
    action: 'edited',
    comment: { body: locked, user: { login: 'tuffgal[bot]' } },
    issue: { number: 7, pull_request: { url: 'https://api/pulls/7' } },
    contextActor: 'maintainer',
  });
  assert.strictEqual(result.proceed, false);
});

test('a locked body carries none of the consumer workflow prefilter substrings', () => {
  const locked = lockApproveBoxes(tickedStickyBody());
  for (const substring of TRIGGER_SUBSTRINGS) {
    assert.ok(!locked.includes(substring), `locked body still carries ${substring}`);
  }
});

test('lock then unlock round-trips a real sticky body byte-for-byte', () => {
  const unticked = untickApproveBoxes(tickedStickyBody());
  assert.strictEqual(unlockApproveBoxes(lockApproveBoxes(unticked)), unticked);
});

// --- the in-flight lock marker -------------------------------------------- //

test('inFlightMarker embeds the run id; inFlightRunId reads it back', () => {
  const marker = inFlightMarker(4242);
  assert.strictEqual(marker, '<!-- tuffgal-approve-inflight:4242 -->');
  assert.strictEqual(inFlightRunId(`${REPORT_MARKER}\n${marker}\nbody`), '4242');
});

test('inFlightMarker strips anything that is not a digit from the run id', () => {
  assert.strictEqual(inFlightMarker('42x/../7'), '<!-- tuffgal-approve-inflight:427 -->');
});

test('inFlightRunId is null for a body with no marker, and for a terminal banner', () => {
  assert.strictEqual(inFlightRunId(`${REPORT_MARKER}\nnothing here`), null);
  const terminal = withStatusBanner(`${REPORT_MARKER}\nbody`, ['> ✅ **All baselines approved**.']);
  assert.strictEqual(inFlightRunId(terminal), null);
});

test('the terminal banner write releases an in-flight lock', () => {
  const inFlight = withStatusBanner(`${REPORT_MARKER}\nbody`, [
    inFlightMarker(99),
    '> ⚙️ **Approving baselines** — committing…',
  ]);
  assert.strictEqual(inFlightRunId(inFlight), '99');
  const done = withStatusBanner(inFlight, ['> ✅ **All baselines approved**.']);
  assert.strictEqual(inFlightRunId(done), null);
});


// --- decideApproveLock: can this request start? ---------------------------- //

test('decideApproveLock: an unlocked comment lets the request through', () => {
  assert.strictEqual(decideApproveLock({ inFlightId: null, runId: 7 }).busy, false);
});

test('decideApproveLock: this run is never blocked by its own lock', () => {
  const verdict = decideApproveLock({ inFlightId: '7', runId: 7, otherRunStatus: null });
  assert.strictEqual(verdict.busy, false);
  assert.match(verdict.reason, /this run/);
});

test('decideApproveLock: a still-running owner blocks the request', () => {
  for (const status of ['in_progress', 'queued', 'waiting', 'requested']) {
    const verdict = decideApproveLock({ inFlightId: '99', runId: 7, otherRunStatus: status });
    assert.strictEqual(verdict.busy, true, `${status} must read as a live lock`);
  }
});

test('decideApproveLock: a completed owner is a stale lock the request takes over', () => {
  // The cancelled-job case: a killed run writes no terminal banner, so nothing
  // else would ever clear its marker.
  const verdict = decideApproveLock({ inFlightId: '99', runId: 7, otherRunStatus: 'completed' });
  assert.strictEqual(verdict.busy, false);
  assert.match(verdict.reason, /stale/);
});

test('decideApproveLock: an owner the API says does not exist is stale too', () => {
  const verdict = decideApproveLock({ inFlightId: '99', runId: 7, otherRunStatus: null });
  assert.strictEqual(verdict.busy, false);
  assert.match(verdict.reason, /no longer exists/);
});

test('decideApproveLock: a FAILED lookup refuses — could not ask is not the same as gone', () => {
  // Rate limit, 5xx, or a missing `actions: read` scope. Refusing costs a retry;
  // taking a live lock races two approvals to the same branch.
  const verdict = decideApproveLock({
    inFlightId: '99',
    runId: 7,
    otherRunStatus: null,
    lookupFailed: true,
  });
  assert.strictEqual(verdict.busy, true);
});

// --- the refusal write preserves the OTHER run's lock ---------------------- //

test('a refusal never releases the lock it refused against', () => {
  // The one write performed by a job that does NOT own the lock. If this chain
  // ever dropped the in-flight marker, the next request would take a live lock.
  const owned = withStatusBanner(`${REPORT_MARKER}\n${tickedStickyBody()}`, [
    inFlightMarker(99),
    '> ⚙️ **Approving baselines** — committing…',
  ]);
  const note = ['> ⏳ **Another approval is already running** — this request was ignored.'];
  const refused = withQueuedNote(lockApproveBoxes(untickApproveBoxes(owned)), note);
  assert.strictEqual(inFlightRunId(refused), '99', "run 99 still holds its lock");
  assert.strictEqual(hasTickedApproveMarker(refused), false);
  // A second refusal is equally harmless.
  const twice = withQueuedNote(lockApproveBoxes(untickApproveBoxes(refused)), note);
  assert.strictEqual(inFlightRunId(twice), '99');
  assert.strictEqual(hasTickedApproveMarker(twice), false);
});
