'use strict';
//
// Which candidate action-dirs a partial approve keeps and which it removes. The
// `readdir` and `rmSync` stay inline in action.yml, which joins every `remove`
// entry UNDER $CAND_DIR rather than trusting a name as a path.
//
// SECURITY: `selection` is UNTRUSTED — it is parsed from a PR comment body a
// write-permission actor can edit. Every key is re-validated here against
// `ACTION_NAME_PATTERN`; a failing key is silently DROPPED (never thrown, so one
// spoofed key can't abort the whole approve) and `remove` is only ever a subset of
// the allowlist-valid present dirs, so the deletion set is provably clean.

// The action-key allowlist. Kept byte-identical to the tuffgal CLI's own
// `ACTION_NAME_PATTERN` (exported from tuffgal's baselineStore) — the CLI names
// each candidate action-dir with a key matching this, so a validated selected key
// is exactly the set of dir names the extracted tree can legitimately contain.
const ACTION_NAME_PATTERN = /^[a-z0-9-]+$/;

// Partition the present candidate action-dirs into keep / remove for a resolved
// selection. `presentDirNames` is DIRECTORY entries only, so a file can never
// enter either output, and the two outputs always partition it. A selected key
// that fails the allowlist or names a dir that isn't present is a no-op, never an
// error.
function computeCandidateFilter(selection, presentDirNames) {
  const present = [...presentDirNames];

  // A full approve promotes everything, so this branch must leave the tree
  // untouched.
  if (selection === 'all') {
    return { keep: present, remove: [] };
  }

  const selectedValid = new Set(
    (Array.isArray(selection) ? selection : []).filter((key) => ACTION_NAME_PATTERN.test(key)),
  );
  // `remove` is the deletion set, so it is the sharp edge: a present dir whose
  // own name fails the allowlist is left alone rather than reaching the inline
  // rmSync loop, which would abort the whole approve on a malformed entry.
  const remove = present.filter(
    (name) => !selectedValid.has(name) && ACTION_NAME_PATTERN.test(name),
  );
  const removeSet = new Set(remove);
  const keep = present.filter((name) => !removeSet.has(name));
  return { keep, remove };
}

module.exports = { computeCandidateFilter, ACTION_NAME_PATTERN };
