"use strict";
//
// Pure, unit-testable decision for the MAIN action's "skip the redundant rerun"
// shortcut — the READER side of the full-approval fast path. After a maintainer
// approves the pending baselines, approve/action.yml commits them onto the PR
// head branch. When that push is made with a custom PAT / GitHub App token (a
// documented, legitimate option), GitHub DOES retrigger the consumer's visual
// workflow — and the whole Tuffgal suite reruns against a tree byte-identical to
// the one that was just approved. This module decides whether the triggering
// commit is provably that redundant full-approval commit, so the main action can
// emit a fast `outcome=pass` instead of re-running Playwright.
//
// The v1.5.0 #31 shortcut (approve/scripts/check-shortcut.js) only ever helped
// the default-`GITHUB_TOKEN` path, where the push fires no workflow at all so
// there is nothing to skip. This module closes the PAT-token gap. Both can fire
// on the same approval under a PAT + a configured check-name — the synthesized
// check plus this real-but-instant short-circuited run, both green.
//
// SECURITY: this trusts a commit-message trailer as a "was this genuinely
// approved" signal, so skipping incorrectly is the sharp edge. It is judged an
// acceptable build-speed optimization, NOT a security boundary, because the skip
// is gated on a SAME-REPO push: pushing to a branch in the base repo already
// requires write access, and an actor with write access could simply approve the
// baselines for real. A fork PR's head lives in a repo the fork author does not
// control write-wise on the base side, so the same-repo gate is the load-bearing
// exclusion and is checked FIRST — a fork PR can never reach the trailer/file
// logic. Every ambiguous, malformed, or missing input fails SAFE: it falls back
// to running the full suite (today's behavior), never skips. No cryptographic
// verification is added — out of scope for this threat model; any tampering is
// visible in git history via the trailer + parent-SHA linkage.

// The commit-message trailer the WRITER (approve/action.yml) stamps onto a
// full-clear approval commit. This is a HAND-DUPLICATED cross-package contract:
// the two action packages cannot cross-require, so this literal MUST stay
// byte-identical to the copy approve/action.yml emits. ci.yml
// approve-trailer-source-lock greps both files to pin them together.
const TRAILER = "Tuffgal-Full-Approval:";

// The full trailer LINE: the literal above, a single space, and a 40-hex commit
// SHA, anchored to a whole line (`m` flag). Built from TRAILER so the literal has
// exactly one source of truth inside this module. Anchoring on both ends defeats
// a crafted message that embeds a real SHA with trailing junk, or the trailer
// mid-line.
const TRAILER_RE = new RegExp(`^${TRAILER} ([0-9a-f]{40})$`, "m");

// POSIX-join the action's `working-directory` and `baselines-path` inputs into a
// single repo-root-relative prefix, the frame `getCommit`'s changed-file paths
// arrive in. Empty and `.` segments are dropped, so `working-directory: '.'`
// yields `tuffgal/baselines` (never `./tuffgal/baselines`), a subdirectory
// working-directory nests correctly (`packages/web` + `tuffgal/baselines` ->
// `packages/web/tuffgal/baselines`), and a trailing slash is absorbed. Kept as a
// tiny local join rather than pulling in a path library — this repo ships no
// dependency for the main action, and the only cases that matter (`.`, a subdir,
// a trailing slash) are unit-locked directly.
function baselinesPrefixFrom(workingDirectory, baselinesPath) {
  const segments = [];
  for (const part of [workingDirectory, baselinesPath]) {
    if (typeof part !== "string") continue;
    for (const segment of part.split("/")) {
      if (segment === "" || segment === ".") continue;
      segments.push(segment);
    }
  }
  return segments.join("/");
}

// Decide whether the triggering commit is provably a redundant full-approval
// commit whose visual suite can be skipped.
//   input:
//     - message:           the triggering commit's message.
//     - parentShas:        that commit's parent SHAs (string[]).
//     - headRepoFullName:  `owner/repo` of the PR head (fork side).
//     - baseRepoFullName:  `owner/repo` of the PR base.
//     - files:             the commit's changed files as [{ path }] (repo-root
//                          relative, POSIX).
//     - filesTruncated:    true when the changed-file list is incomplete
//                          (>= 300 files -> the API paginated), so scope is
//                          unverifiable.
//     - baselinesPrefix:   repo-root-relative baselines prefix (from
//                          baselinesPrefixFrom).
//   output: { skip: boolean, reason: string }. skip is true ONLY when ALL hold:
//     1. head repo === base repo (a same-repo push; fork PRs never skip).
//     2. the message carries the full-approval trailer, its SHA equals the SOLE
//        parent (exactly one parent — rules out merges and a rebase/replay whose
//        approval commit picked up a new parent).
//     3. the changed-file list is fully known, non-empty, and EVERY file sits
//        under `<baselinesPrefix>/`.
//   Any missing / malformed / ambiguous input -> { skip: false } (fail-safe:
//   fall back to running the full suite).
function decideRunSkip({
  message,
  parentShas,
  headRepoFullName,
  baseRepoFullName,
  files,
  filesTruncated,
  baselinesPrefix,
} = {}) {
  // (1) Same-repo push. Checked FIRST and hardest: a fork PR's head lives in a
  // different repo, so it must never short-circuit. A null/absent head repo (a
  // deleted fork) is not a string and fails here too.
  if (
    typeof headRepoFullName !== "string" ||
    typeof baseRepoFullName !== "string" ||
    headRepoFullName.length === 0 ||
    headRepoFullName !== baseRepoFullName
  ) {
    return {
      skip: false,
      reason: "not a same-repo push (fork PR or unknown head repo) — never short-circuit",
    };
  }

  // (2) Full-approval trailer whose SHA is the single parent.
  if (typeof message !== "string") {
    return { skip: false, reason: "no commit message to inspect" };
  }
  const match = message.match(TRAILER_RE);
  if (!match) {
    return { skip: false, reason: "commit carries no Tuffgal-Full-Approval trailer" };
  }
  if (!Array.isArray(parentShas) || parentShas.length !== 1) {
    return {
      skip: false,
      reason: "commit does not have exactly one parent (merge or rebased commit)",
    };
  }
  if (match[1] !== parentShas[0]) {
    return { skip: false, reason: "trailer SHA does not match the commit's parent" };
  }

  // (3) Every changed file under the baselines prefix, with full scope known.
  const prefix =
    typeof baselinesPrefix === "string"
      ? baselinesPrefix.replace(/^\.\//, "").replace(/\/+$/, "")
      : "";
  if (prefix === "") {
    return { skip: false, reason: "baselines prefix could not be resolved" };
  }
  if (filesTruncated) {
    return {
      skip: false,
      reason: "changed-file list is truncated (>= 300 files) — scope cannot be verified",
    };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return {
      skip: false,
      reason: "no changed files reported — cannot confirm a baselines-only commit",
    };
  }
  const underPrefix = (file) =>
    file && typeof file.path === "string" && file.path.startsWith(prefix + "/");
  if (!files.every(underPrefix)) {
    return {
      skip: false,
      reason: "commit changes files outside the baselines directory — not a pure promotion",
    };
  }

  return { skip: true, reason: `baselines fully approved against ${match[1]}` };
}

module.exports = { TRAILER, decideRunSkip, baselinesPrefixFrom };
