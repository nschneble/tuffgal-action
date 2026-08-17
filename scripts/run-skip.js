"use strict";
//
// The READER side of the full-approval fast path: is the triggering commit
// provably the redundant baseline-promotion commit, so the suite can emit a fast
// pass instead of re-running Playwright against a byte-identical tree. Fires on
// the PAT-token path; check synthesis covers the `GITHUB_TOKEN` one.
//
// SECURITY: this trusts a commit-message trailer, so it is a build-speed
// optimization, NOT a security boundary — the SAME-REPO gate is what makes that
// acceptable (pushing to a base-repo branch already requires write access) and is
// checked FIRST, so a fork PR never reaches the trailer logic. Every ambiguous,
// malformed, or missing input fails SAFE to running the full suite.

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

// Skip only when ALL three hold: same-repo push (fork PRs never skip), the
// full-approval trailer names the SOLE parent (rules out merges and a rebase that
// picked up a new one), and every changed file sits under the baselines prefix
// with the file list known to be complete. Anything else fails safe to a full
// run.
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
