'use strict';
//
// Pure, unit-testable logic for the approve flow's "Commit baselines to PR head
// branch" step. Extracted out of the inline `actions/github-script` block so the
// security-sensitive path handling and deletion math can be exercised by a
// `node --test` suite without a live GitHub run — the same extract-and-unit-test
// precedent set by the sibling `validate-artifact.sh`.
//
// This module owns ONLY the pure pieces. The thin GitHub API calls
// (createBlob / createTree / createCommit / updateRef) and the `git ls-tree`
// execFileSync stay inline in action.yml; the inline script requires this module
// and calls these functions. Behavior is byte-identical to the previous inline
// implementation.
//
const path = require('path');

// Reject any path that would escape the baselines scope. `prefix` is the
// repo-root-relative baselines directory (e.g. `tuffgal/baselines`, or
// `frontend/tuffgal/baselines` for a subdir working-directory). Rejects absolute
// paths and `..` traversal segments outright, then requires the path to be the
// prefix itself or nested under it. Returns the forward-slash-normalized path.
function guard(p, prefix) {
  const norm = p.replace(/\\/g, '/');
  if (norm.startsWith('/') || norm.split('/').includes('..')) {
    throw new Error(`Refusing out-of-scope path: ${p}`);
  }
  if (!(norm === prefix || norm.startsWith(prefix + '/'))) {
    throw new Error(`Refusing path outside baselines directory: ${p}`);
  }
  return norm;
}

// Recursively collect every regular file under `dir`, returning absolute paths.
// `fs` is injected so the walk can run against a temp tree in tests.
//
// NOTE: uses `fs.statSync` (follows symlinks) deliberately — this wave is
// behavior-preserving. Hardening the walk against symlinked directories with
// `lstatSync` is a separate, tracked change; do NOT switch it here.
function walk(dir, fs) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, fs));
    else out.push(full);
  }
  return out;
}

// Re-anchor a working-directory-relative file name (as produced by `walk` or by
// `git ls-tree` run from the working-directory cwd) to the repo-root frame by
// prepending `workdirPrefix`, then run it through `guard`. This is what keeps
// onDisk, atHead, `prefix`, and the git-tree API all in agreement for both a
// '.' working-directory (empty prefix) and a subdir one.
function toRepoPath(name, workdirPrefix, prefix) {
  return guard(path.posix.join(workdirPrefix, name), prefix);
}

// Deletions = files present at the head commit but no longer on disk after the
// approve (atHead \ onDisk). Both inputs are already repo-root-anchored,
// guarded paths. Bootstrap (empty atHead) and an unchanged set both yield [].
function computeDeletions(onDiskRepoPaths, atHeadRepoPaths) {
  const onDiskSet = new Set(onDiskRepoPaths);
  return atHeadRepoPaths.filter((p) => !onDiskSet.has(p));
}

module.exports = { guard, walk, toRepoPath, computeDeletions };
