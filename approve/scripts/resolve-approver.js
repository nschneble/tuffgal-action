'use strict';
//
// Pure, unit-testable logic for the approve flow's permission-gate step: deciding
// whether a comment event is an approve trigger, WHO the approver is, and the
// fail-closed early-outs. Extracted out of the inline `actions/github-script`
// block so the who-can-approve trust boundary can be exercised by a `node --test`
// suite without a live GitHub run — the same extract-and-unit-test precedent set
// by the sibling `validate-artifact.sh` and `baseline-tree.js`.
//
// This module owns ONLY the pure decision. The API-bound side effects that
// FOLLOW it — the 👀 reaction, the repository-permission lookup, the fork
// decline, and the PR-head resolution — stay inline in action.yml; the inline
// script requires this module and acts on its verdict.
//
// TWO trigger shapes drive the approve. They differ in WHO the approver is and —
// for a partial per-item approve — in WHAT gets promoted (a mention or the master
// box approves everything; ticked item boxes narrow to the selected stories):
//   - mention:  a human comments `@tuffgal approve` → the approver is the comment
//               AUTHOR (`comment.user.login`).
//   - checkbox: a human TICKS a box in the bot's sticky report comment
//               (`issue_comment: edited`). The comment author is the bot, so the
//               approver is the EDITOR (`context.actor`). Two box shapes count as
//               a checkbox trigger, both gated behind the report marker + edited
//               event (the identical trust boundary):
//                 · MASTER box  — the checked `<!-- tuffgal-approve-box -->` box:
//                   approve everything (`selection: 'all'`).
//                 · ITEM boxes  — one or more checked
//                   `<!-- tuffgal-approve-item:key,… -->` per-story boxes:
//                   approve only the union of those ticked stories' action
//                   keys (`selection: string[]`).
//               The master box wins when both are ticked — the user asked for
//               everything, so a partial state underneath it is moot.
//
// All shapes fail closed: a comment that is not on a PR, is neither trigger, or
// whose approver is a bot (e.g. the visual workflow refreshing the sticky comment
// with UNchecked boxes — an `edited` event we must never loop back into an
// approval) resolves to `{ proceed: false }` and never reacts.

// Per-item approve marker prefix from the comment body. Each ticked per-story box
// carries its candidate-tree action keys comma-joined in the HTML comment, each
// key matching `[a-z0-9-]+`. Kept in step with `scripts/build-comment.js`'s
// `APPROVE_ITEM_MARKER_PREFIX` / `approveItemCheckbox` renderers — this regex is
// the read side of what that module writes. An empty payload
// (`tuffgal-approve-item:` with nothing after the colon) is a valid render and
// contributes no keys; the `*` (not `+`) capture matches it without matching a
// malformed marker.
const CHECKED_ITEM_BOX = /-\s*\[[xX]\]\s*<!--\s*tuffgal-approve-item:([a-z0-9,-]*)\s*-->/g;

// Collect the deduped union of action keys from every CHECKED per-item box in the
// body. Empty / malformed payloads drop out (an empty key never enters the set),
// so a ticked box with no keys contributes nothing to the selection.
function checkedItemKeys(body) {
  const keys = new Set();
  for (const match of body.matchAll(CHECKED_ITEM_BOX)) {
    for (const key of match[1].split(',')) {
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

// Resolve the approve trigger + approver + selection from a comment event's shape.
//   input:  { eventName, action, comment, issue, contextActor }
//   output: { proceed, actor, via, reason, selection }
//     - proceed true  → via is 'mention' | 'checkbox', reason null, and
//                        selection is 'all' (mention or master box) or a
//                        string[] of action keys (partial per-item approve).
//     - proceed false → reason 'no-trigger'    (not a PR, or neither trigger) or
//                        reason 'ignored-actor' (bot-authored edit / missing actor),
//                        and selection null (no meaningful approve).
// The comment body is only ever read and pattern-matched here — it is never
// interpolated into a shell command downstream.
function resolveApprover({ eventName, action, comment, issue, contextActor }) {
  const body = String((comment && comment.body) || '');
  const isMention = /(^|\s)@tuffgal\s+approve(\s|$)/i.test(body);

  // Both checkbox shapes share the master box's trust boundary: an `edited`
  // sticky-comment event carrying the report marker.
  const isEditedReport =
    eventName === 'issue_comment' &&
    action === 'edited' &&
    /<!--\s*tuffgal-report\s*-->/.test(body);
  const isMasterBox =
    isEditedReport && /-\s*\[[xX]\]\s*<!--\s*tuffgal-approve-box\s*-->/.test(body);
  // A partial approve fires only when at least one ticked item box yields a key;
  // a ticked but empty-payload box alone is not a trigger (nothing to approve).
  const itemKeys = isEditedReport ? checkedItemKeys(body) : [];
  const isItemBox = itemKeys.length > 0;
  const isCheckedBox = isMasterBox || isItemBox;

  // For a mention the approver is the comment author; for a checkbox edit the
  // author is the bot, so the approver is the editor (context actor).
  const actor = isMention ? (comment && comment.user && comment.user.login) : contextActor;

  if (!issue || !issue.pull_request || (!isMention && !isCheckedBox)) {
    return { proceed: false, actor, via: null, reason: 'no-trigger', selection: null };
  }
  // A bot-authored edit of the sticky comment fires `edited` too (e.g. the visual
  // workflow refreshing it) — never treat that as an approval, and never react.
  if (!actor || /\[bot\]$/.test(actor)) {
    return { proceed: false, actor, via: null, reason: 'ignored-actor', selection: null };
  }
  // Mention and the master box both mean "approve everything"; the master box
  // also takes precedence over any partial item state ticked alongside it. Only a
  // partial per-item approve (no master, no mention) narrows to the ticked keys.
  const selection = isMention || isMasterBox ? 'all' : itemKeys;
  return { proceed: true, actor, via: isMention ? 'mention' : 'checkbox', reason: null, selection };
}

module.exports = { resolveApprover };
