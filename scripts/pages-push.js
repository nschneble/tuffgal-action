'use strict';
//
// The Pages-preview step's pure decisions: what of the report tree may be
// published, and whether a failed `git push` is worth retrying. Side effects
// (the copy, the git commands) stay inline.
//
// Two runs on DIFFERENT PRs can overlap on the branch. Their `pr-<n>/` subtrees
// are disjoint, so a non-fast-forward rejection is RETRYABLE — re-fetch the
// advanced tip, re-apply this PR's idempotent subtree. A permission / auth /
// protected-branch failure never succeeds on retry, so it is TERMINAL, as is
// anything unrecognized: fall to the artifact-link fallback rather than loop on an
// error we can't reason about.

// The preview branch is public: a trace carries the app's request and response
// headers, the dev-server log its stdout. Neither is referenced by the report.
const PREVIEW_EXCLUDED = new Set(['traces', 'dev-servers.log']);

// Keyed on the path RELATIVE to the report root, so the match binds to those two
// root entries — a nested dir sharing the name still ships, and the root itself
// relativizes to '' and is never excluded, so the copy always starts.
function isPublishablePreviewEntry(relativePath) {
  return !PREVIEW_EXCLUDED.has(relativePath);
}

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

// True for the whole TERMINAL set — an auth failure, a bad credential, or a
// branch protection declining the push: every one is an EXPECTED, recognized
// reason a push can't succeed. Distinguish that from a merely unrecognized
// terminal error (or an exhausted concurrent-PR race), which matches nothing
// here. Used ONLY to pick the log level of the best-effort fallback — a
// recognized failure is an expected not-configured state (log a notice),
// anything else is surprising (log a warning). Never touches the retry decision.
function isExpectedPushFailure(output) {
  const text = String(output || '');
  return TERMINAL.some((pattern) => pattern.test(text));
}

module.exports = {
  isPublishablePreviewEntry,
  isRetryablePushError,
  isExpectedPushFailure,
};
