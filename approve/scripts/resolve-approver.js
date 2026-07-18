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
// TWO trigger shapes resolve to the same approve, differing only in WHO the
// approver is:
//   - mention:  a human comments `@tuffgal approve` → the approver is the comment
//               AUTHOR (`comment.user.login`).
//   - checkbox: a human TICKS the approve box in the bot's sticky report comment
//               (`issue_comment: edited`). The comment author is the bot, so the
//               approver is the EDITOR (`context.actor`). We recognize it by the
//               report + approve-box markers with the box CHECKED (`[x]`).
//
// Both shapes fail closed: a comment that is not on a PR, is neither trigger, or
// whose approver is a bot (e.g. the visual workflow refreshing the sticky comment
// with an UNchecked box — an `edited` event we must never loop back into an
// approval) resolves to `{ proceed: false }` and never reacts.

// Resolve the approve trigger + approver from a comment event's shape.
//   input:  { eventName, action, comment, issue, contextActor }
//   output: { proceed, actor, via, reason }
//     - proceed true  → via is 'mention' | 'checkbox', reason null
//     - proceed false → reason 'no-trigger'    (not a PR, or neither trigger) or
//                        reason 'ignored-actor' (bot-authored edit / missing actor)
// The comment body is only ever read and pattern-matched here — it is never
// interpolated into a shell command downstream.
function resolveApprover({ eventName, action, comment, issue, contextActor }) {
  const body = String((comment && comment.body) || '');
  const isMention = /(^|\s)@tuffgal\s+approve(\s|$)/i.test(body);
  const isCheckedBox =
    eventName === 'issue_comment' &&
    action === 'edited' &&
    /<!--\s*tuffgal-report\s*-->/.test(body) &&
    /-\s*\[[xX]\]\s*<!--\s*tuffgal-approve-box\s*-->/.test(body);

  // For a mention the approver is the comment author; for a checkbox edit the
  // author is the bot, so the approver is the editor (context actor).
  const actor = isMention ? (comment && comment.user && comment.user.login) : contextActor;

  if (!issue || !issue.pull_request || (!isMention && !isCheckedBox)) {
    return { proceed: false, actor, via: null, reason: 'no-trigger' };
  }
  // A bot-authored edit of the sticky comment fires `edited` too (e.g. the visual
  // workflow refreshing it) — never treat that as an approval, and never react.
  if (!actor || /\[bot\]$/.test(actor)) {
    return { proceed: false, actor, via: null, reason: 'ignored-actor' };
  }
  return { proceed: true, actor, via: isMention ? 'mention' : 'checkbox', reason: null };
}

module.exports = { resolveApprover };
