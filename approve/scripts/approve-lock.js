'use strict';
//
// The approve flow's LOCK: the transforms and the decision that keep a PR to one
// running approval at a time. Split out of report-comment.js, which owns the
// sticky comment's status blocks and CTA rewrites; this module owns only the
// question "can this request start, and what does a locked comment look like".
//
// LOOP SAFETY (load-bearing). A locked box carries no checkbox syntax at all, so
// no body this module returns can re-fire the consumer's approve workflow. The
// caller still asserts report-comment.js's `hasTickedApproveMarker` on every
// outgoing body — this module is one of the transforms feeding that assertion,
// never a substitute for it.

// Rendered as the first line INSIDE the status block by the two in-flight phases
// (in-flight, milestone) and by NEITHER terminal banner, so the lock is released
// by the terminal write that replaces the whole block.
//
// It carries the OWNING run's id, digits only. A cancelled job runs no terminal
// step, so without the id a killed run would leave a lock nothing could clear and
// every later approval would refuse itself forever.
const IN_FLIGHT_MARKER_PREFIX = '<!-- tuffgal-approve-inflight:';
const IN_FLIGHT_MARKER_RE = /<!--\s*tuffgal-approve-inflight:(\d+)\s*-->/;

// The inert stand-in for a checkbox while an approval is in flight. GitHub renders
// a task-list checkbox for `- [ ]` only; with the brackets gone the line is plain
// text, so there is nothing to click and no way to fire a second approval from a
// comment that is mid-run. The marker comment is left untouched, so the swap is
// reversible line-for-line (see unlockApproveBoxes) with no stashed state.
const LOCK_GLYPH = '⏳';

// Appended to the TOP-LEVEL box's line (only) while locked, so the inert control
// says why it is inert. Stripped byte-for-byte on unlock, which is why it is a
// literal rather than composed prose.
const LOCKED_BOX_SUFFIX = ' ⏳ Locked while an approval runs.';

// Approve boxes in ANY tick state (`[ ]`, `[x]`, `[X]`) — the lock's read side,
// which must catch a box the caller has not unticked yet. Group 1 is the leading
// `- `, group 2 the marker comment; the tick state between them is what the swap
// replaces. Non-global (a global regex is stateful under `.test`), applied per
// line, where at most one box can appear.
const ANY_APPROVE_ALL_BOX = /(-\s*)\[[ xX]\](\s*<!--\s*tuffgal-approve-box\s*-->)/;
const ANY_APPROVE_ITEM_BOX = /(-\s*)\[[ xX]\](\s*<!--\s*tuffgal-approve-item:[a-z0-9,-]*\s*-->)/;

// The same two lines in their LOCKED form — the unlock read side.
const LOCKED_APPROVE_ALL_BOX = new RegExp(`(-\\s*)${LOCK_GLYPH}(\\s*<!--\\s*tuffgal-approve-box\\s*-->)`);
const LOCKED_APPROVE_ITEM_BOX = new RegExp(
  `(-\\s*)${LOCK_GLYPH}(\\s*<!--\\s*tuffgal-approve-item:[a-z0-9,-]*\\s*-->)`
);

const asString = (value) => String(value == null ? '' : value);

const inFlightMarker = (runId) => `${IN_FLIGHT_MARKER_PREFIX}${String(runId).replace(/\D/g, '')} -->`;

// The id of the run currently holding the lock, or `null` when the body carries
// no in-flight marker.
function inFlightRunId(body) {
  const match = asString(body).match(IN_FLIGHT_MARKER_RE);
  return match ? match[1] : null;
}

// Swap every approve box — top-level and per-item, in any tick state — for its
// inert LOCKED form, so a comment mid-approval offers nothing to click. Called on
// the way IN to each in-flight phase write; `unlockApproveBoxes` reverses it at
// every terminal state. Idempotent: an already-locked line has no `[…]` left to
// match, so the suffix is never appended twice.
function lockApproveBoxes(body) {
  return asString(body)
    .split('\n')
    .map((line) => {
      if (ANY_APPROVE_ITEM_BOX.test(line)) {
        return line.replace(ANY_APPROVE_ITEM_BOX, `$1${LOCK_GLYPH}$2`);
      }
      if (ANY_APPROVE_ALL_BOX.test(line)) {
        return line.replace(ANY_APPROVE_ALL_BOX, `$1${LOCK_GLYPH}$2`) + LOCKED_BOX_SUFFIX;
      }
      return line;
    })
    .join('\n');
}

// Restore every LOCKED approve box to its untickable `[ ]` form, dropping the
// top-level box's locked suffix. The inverse of lockApproveBoxes, and idempotent
// the same way. Every terminal path (success, already-up-to-date, failure) runs
// this so the comment is interactive again the moment nothing is in flight.
function unlockApproveBoxes(body) {
  return asString(body)
    .split('\n')
    .map((line) => {
      if (LOCKED_APPROVE_ITEM_BOX.test(line)) {
        return line.replace(LOCKED_APPROVE_ITEM_BOX, '$1[ ]$2');
      }
      if (LOCKED_APPROVE_ALL_BOX.test(line)) {
        const restored = line.replace(LOCKED_APPROVE_ALL_BOX, '$1[ ]$2');
        return restored.endsWith(LOCKED_BOX_SUFFIX)
          ? restored.slice(0, -LOCKED_BOX_SUFFIX.length)
          : restored;
      }
      return line;
    })
    .join('\n');
}

// Can this request start, given the lock the sticky comment carries? Pure, so the
// five arms below are unit-tested; the caller performs the API lookup that fills
// `otherRunStatus` / `lookupFailed` and acts on `busy`.
//
//   inFlightId     run id from the comment's marker, or null when unlocked
//   runId          THIS run's id — its own marker never blocks it (a re-entered
//                  step, or a phase write this run already made)
//   otherRunStatus the owning run's Actions status ('completed', 'in_progress',
//                  'queued', …), or null when it was not looked up / not found
//   lookupFailed   the lookup errored for a reason OTHER than "no such run"
//
// FAIL DIRECTION. A completed owner, or one the API says does not exist, is a
// stale lock left by a cancelled job: take it, or that PR can never be approved
// again. Every other failure means we could not ASK — refuse, because refusing
// costs the user a retry while taking a live lock races two runs to one branch.
function decideApproveLock({ inFlightId, runId, otherRunStatus, lookupFailed }) {
  if (inFlightId === null || inFlightId === undefined) {
    return { busy: false, reason: 'no lock held' };
  }
  if (String(inFlightId) === String(runId)) {
    return { busy: false, reason: 'lock is held by this run' };
  }
  if (lookupFailed) {
    return { busy: true, reason: `could not read run ${inFlightId}; assuming its lock is live` };
  }
  if (otherRunStatus === null || otherRunStatus === undefined) {
    return { busy: false, reason: `run ${inFlightId} no longer exists; lock is stale` };
  }
  if (otherRunStatus === 'completed') {
    return { busy: false, reason: `run ${inFlightId} has completed; lock is stale` };
  }
  return { busy: true, reason: `run ${inFlightId} is ${otherRunStatus}` };
}

module.exports = {
  LOCK_GLYPH,
  LOCKED_BOX_SUFFIX,
  lockApproveBoxes,
  unlockApproveBoxes,
  inFlightMarker,
  inFlightRunId,
  decideApproveLock,
};
