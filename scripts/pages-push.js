'use strict';
//
// Pure, unit-testable decision for the per-PR Pages preview push: given the
// combined stdout/stderr/message of a failed `git push`, decide whether a
// re-sync + retry can plausibly succeed. Extracted out of the inline
// `actions/github-script` block so the retryable-vs-terminal classification —
// the one part of the retry loop with a right answer that live git can't
// exercise in CI — is covered by a `node --test` suite, the same
// extract-and-unit-test precedent set by the sibling `approve/scripts/*.js`
// modules. The git side effects themselves (clone / stage / commit / push /
// re-sync) stay inline; this module owns ONLY the verdict.
//
// Two visual runs on DIFFERENT PRs (or reruns) can overlap on the shared
// preview branch. Each replaces only its own `pr-<n>/` subtree, so the changes
// are disjoint — but the second push is rejected non-fast-forward because its
// shallow clone predates the first push. Re-fetching the advanced tip and
// re-applying this PR's (idempotent) subtree resolves it cleanly, so a
// non-fast-forward rejection is RETRYABLE.
//
// A permission / auth failure (no `contents: write`, protected branch, bad
// credential) will NEVER succeed on retry — retrying just wastes attempts and
// delays the artifact-link fallback — so it is TERMINAL. Anything we don't
// recognize is treated as terminal too: fall straight to the best-effort
// fallback rather than loop on an error we can't reason about.

// Signals that a push failed for a reason no retry can fix. Checked FIRST, so a
// server-side decline that also prints a generic "failed to push some refs"
// line is classified terminal, not mistaken for a non-fast-forward race.
const TERMINAL = [
  /\b40[13]\b/, // 403 Forbidden / 401 Unauthorized from the git-over-HTTPS endpoint
  /permission to .* denied/i,
  /write access to .* not granted/i,
  /authentication failed/i,
  /could not read (username|password)/i,
  /remote rejected/i, // server-side pre-receive/hook decline (e.g. protected branch)
  /protected branch/i,
  /\bGH006\b/, // GitHub's protected-branch push error code
];

// Signals that the local tip was behind the remote when we pushed — a
// concurrent push advanced the shared branch. Re-sync + re-apply + retry.
const RETRYABLE = [
  /non-fast-forward/i,
  /fetch first/i,
  /failed to push some refs/i,
  /tip of your (current )?branch is behind/i,
  /cannot lock ref/i, // concurrent ref update lost the compare-and-swap
  /!\s*\[rejected\]/i, // local rejection line from `git push`
];

// Classify a failed `git push`. `output` is the combined stdout + stderr +
// message of the thrown execFileSync error.
//   → true  : re-sync the branch tip, re-apply this PR's subtree, and retry
//   → false : terminal — fall straight to the artifact-link fallback
function isRetryablePushError(output) {
  const text = String(output || '');
  if (TERMINAL.some((pattern) => pattern.test(text))) return false;
  return RETRYABLE.some((pattern) => pattern.test(text));
}

// Every TERMINAL signal above is a recognized ACCESS reason: the token lacks
// write access, the credential is bad, or a branch protection declined the
// push. Distinguish that from a merely unrecognized terminal error (or an
// exhausted concurrent-PR race), which matches nothing here. Used ONLY to pick
// the log level of the best-effort fallback — a recognized access gap is an
// expected not-configured state (log a notice), anything else is surprising
// (log a warning). Never touches the retry decision.
function isPermissionPushError(output) {
  const text = String(output || '');
  return TERMINAL.some((pattern) => pattern.test(text));
}

module.exports = { isRetryablePushError, isPermissionPushError };
