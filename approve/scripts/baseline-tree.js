'use strict';
//
// The path handling and deletion math behind the approve flow's baseline commit.
// The API calls (createBlob / createTree / createCommit / updateRef) and the
// `git ls-tree` stay inline in action.yml.
//
// Two functions fail closed with the tagged `BaselineScopeError` rather than a
// bare Error, so a caller can re-throw a scope rejection instead of swallowing it:
// `guard` (out-of-scope path) and `walk` (symlink).
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
  const normalized = candidatePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new BaselineScopeError(`Refusing out-of-scope path: ${candidatePath}`);
  }
  if (!(normalized === prefix || normalized.startsWith(prefix + '/'))) {
    throw new BaselineScopeError(`Refusing path outside baselines directory: ${candidatePath}`);
  }
  return normalized;
}

// Recursively collect every regular file under `dir`, returning absolute paths.
// `fs` is injected so the walk can run against a temp tree in tests.
//
// SECURITY: this tree comes from the PR head via `git archive | tar -x`, so a
// write collaborator can commit a symlink into it, and the caller blobs each
// returned file with `readFileSync` (which dereferences) — a followed symlink
// would commit the TARGET's bytes onto the PR branch. Symlinks are refused
// outright, throwing `BaselineScopeError`. `lstatSync` is load-bearing: `statSync`
// would report a symlink-to-dir as a directory and recurse into the target.
function walk(dir, fs) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stats = fs.lstatSync(full);
    if (stats.isSymbolicLink()) {
      throw new BaselineScopeError(`Refusing symlink in baselines: ${full}`);
    }
    if (stats.isDirectory()) out.push(...walk(full, fs));
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
