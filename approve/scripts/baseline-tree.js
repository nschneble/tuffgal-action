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
// and calls these functions. `guard`, `toRepoPath`, `computeDeletions`, and
// `deriveFrames` reproduce the previous inline logic byte-for-byte; `walk`
// additionally rejects symlinks fail-closed (a deliberate divergence — see its
// SECURITY note).
//
const path = require('path');

// Tagged error type for a baselines-scope rejection thrown by `guard`. Callers
// that swallow expected errors (e.g. the commit step's `atHead` ls-tree catch,
// which treats a missing head tree as bootstrap) MUST re-throw this so a scope
// violation on any path can never be silently swallowed into a fail-open — the
// fail-closed posture is a property of the error type, not of catch placement.
class BaselineScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BaselineScopeError';
  }
}

// Reject any path that would escape the baselines scope. `prefix` is the
// repo-root-relative baselines directory (e.g. `tuffgal/baselines`, or
// `frontend/tuffgal/baselines` for a subdir working-directory). Rejects absolute
// paths and `..` traversal segments outright, then requires the path to be the
// prefix itself or nested under it. Returns the forward-slash-normalized path.
// Throws `BaselineScopeError` on any rejection.
function guard(candidatePath, prefix) {
  const norm = candidatePath.replace(/\\/g, '/');
  if (norm.startsWith('/') || norm.split('/').includes('..')) {
    throw new BaselineScopeError(`Refusing out-of-scope path: ${candidatePath}`);
  }
  if (!(norm === prefix || norm.startsWith(prefix + '/'))) {
    throw new BaselineScopeError(`Refusing path outside baselines directory: ${candidatePath}`);
  }
  return norm;
}

// Recursively collect every regular file under `dir`, returning absolute paths.
// `fs` is injected so the walk can run against a temp tree in tests.
//
// SECURITY: uses `fs.lstatSync` (does NOT follow symlinks) and REJECTS any
// symlink fail-closed by throwing. The tree walked here is materialized from the
// PR head via `git archive | tar -x` — UNTRUSTED input a write collaborator
// controls, and `git archive` faithfully recreates any symlink committed in it.
// The caller blobs each returned file's bytes via `fs.readFileSync` (which
// dereferences), so a followed symlink would commit the TARGET's bytes (e.g.
// `../../.npmrc`, `/proc/self/environ` holding the job token) onto the PR branch
// where the author reads them — write access → secret disclosure. So a symlink
// is refused outright: never followed, never silently skipped. `lstatSync` is
// load-bearing here — `statSync` would report a symlink-to-dir as a directory
// (recursing into the target) and a symlink-to-file as a plain file (blobbing
// the target). Mirrors `validate-artifact.sh`'s fail-closed posture for the
// sibling untrusted input (the candidates artifact).
function walk(dir, fs) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing symlink in baselines: ${full}`);
    }
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

// Derive the three baseline-path frames the commit step needs from the raw
// `working-directory` and (working-directory-relative) `baselines-path` inputs:
//   - workdirPrefix:     repo-root-relative working-directory ('' for '.'),
//                        used to re-anchor walk/ls-tree names to the repo root
//   - baselinesRelPosix: working-directory-relative baselines dir (for git
//                        pathspecs, which git resolves against the process cwd)
//   - prefix:            repo-root-relative baselines dir (for tree entries and
//                        the guard)
// Normalizes backslashes and trailing slashes so a `working-directory: frontend/`
// (trailing slash) and the `'.'` case both resolve correctly.
function deriveFrames(workdir, baselinesRel) {
  const workdirPrefix = workdir === '.' ? '' : workdir.replace(/\\/g, '/').replace(/\/$/, '');
  const baselinesRelPosix = baselinesRel.replace(/\\/g, '/').replace(/\/$/, '');
  const prefix = path.posix.join(workdirPrefix, baselinesRelPosix).replace(/\/$/, '');
  return { workdirPrefix, baselinesRelPosix, prefix };
}

// Deletions = files present at the head commit but no longer on disk after the
// approve (atHead \ onDisk). Both inputs are already repo-root-anchored,
// guarded paths. Bootstrap (empty atHead) and an unchanged set both yield [].
function computeDeletions(onDiskRepoPaths, atHeadRepoPaths) {
  const onDiskSet = new Set(onDiskRepoPaths);
  return atHeadRepoPaths.filter((repoPath) => !onDiskSet.has(repoPath));
}

module.exports = {
  BaselineScopeError,
  guard,
  walk,
  toRepoPath,
  deriveFrames,
  computeDeletions,
};
