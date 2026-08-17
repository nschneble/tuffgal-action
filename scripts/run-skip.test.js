"use strict";
//
// Unit tests for the pure run-skip decision (the MAIN action's full-approval
// fast path). No deps beyond Node's built-in `node:test` + `node:assert` — run
// with `node --test scripts/*.test.js`.
//
const { test } = require("node:test");
const assert = require("node:assert");

const { TRAILER, decideRunSkip, baselinesPrefixFrom } = require("./run-skip.js");

// The reviewed (parent) SHA the candidates were captured against. Distinct,
// valid 40-hex SHAs for the accept case and the mismatch cases.
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

// A fully-valid full-approval input: same-repo push, trailer whose SHA is the
// single parent, and a baselines-only diff. Individual tests override exactly
// one field to isolate the reject arm under test.
const valid = (overrides = {}) => ({
  message: `chore(tuffgal): approve candidate baselines\n\n${TRAILER} ${SHA}`,
  parentShas: [SHA],
  headRepoFullName: "owner/repo",
  baseRepoFullName: "owner/repo",
  files: [
    { path: "tuffgal/baselines/visit-home/0.png" },
    { path: "tuffgal/baselines/manifest.json" },
  ],
  filesTruncated: false,
  baselinesPrefix: "tuffgal/baselines",
  ...overrides,
});

// The trailer literal is a hand-duplicated cross-package contract with
// approve/action.yml. Pin its exact bytes from the reader side so a drift here
// is caught by this suite as well as the source-lock CI job.
test("TRAILER is the exact hand-duplicated contract literal", () => {
  assert.strictEqual(TRAILER, "Tuffgal-Full-Approval:");
});

// ---- accept ---------------------------------------------------------------

test("a genuine same-repo full-approval commit skips", () => {
  const result = decideRunSkip(valid());
  assert.strictEqual(result.skip, true);
  // The reason names the reviewed SHA so the caller can surface it.
  assert.match(result.reason, new RegExp(SHA));
});

test("a subdirectory working-directory full approval skips", () => {
  const prefix = baselinesPrefixFrom("packages/web", "tuffgal/baselines");
  const result = decideRunSkip(
    valid({
      baselinesPrefix: prefix,
      files: [
        { path: "packages/web/tuffgal/baselines/visit-home/0.png" },
        { path: "packages/web/tuffgal/baselines/manifest.json" },
      ],
    })
  );
  assert.strictEqual(result.skip, true);
});

// The blank line before the trailer is NOT load-bearing: TRAILER_RE carries the
// `m` flag and anchors `^` at every line start, so a lone `\n` (no blank line)
// before the trailer still lands it at a line start and still matches. Pins that
// fact so no one re-introduces the (false) belief that a dropped blank line breaks
// the skip. The character that DOES gate the match is the space after the colon —
// see the reject case in the anchored-regex block below.
test("a trailer after a single newline (no blank line) still skips (m-flag anchor)", () => {
  const message = `chore(tuffgal): approve candidate baselines\nTuffgal-Full-Approval: ${SHA}`;
  const result = decideRunSkip(valid({ message }));
  assert.strictEqual(result.skip, true);
});

// ---- reject: every way the commit could be lying / malformed / ambiguous ---

test("a partial approve (single-line message, no trailer) does not skip", () => {
  const result = decideRunSkip(
    valid({ message: "chore(tuffgal): approve candidate baselines" })
  );
  assert.strictEqual(result.skip, false);
});

test("a trailer SHA that does not match the parent does not skip", () => {
  const result = decideRunSkip(valid({ parentShas: [OTHER_SHA] }));
  assert.strictEqual(result.skip, false);
});

test("a two-parent (merge) commit does not skip", () => {
  const result = decideRunSkip(valid({ parentShas: [SHA, OTHER_SHA] }));
  assert.strictEqual(result.skip, false);
});

test("a fork PR (head repo != base repo) does not skip", () => {
  const result = decideRunSkip(valid({ headRepoFullName: "forker/repo" }));
  assert.strictEqual(result.skip, false);
});

test("a null head repo (deleted fork) does not skip", () => {
  const result = decideRunSkip(valid({ headRepoFullName: null }));
  assert.strictEqual(result.skip, false);
});

test("a truncated changed-file list does not skip", () => {
  const result = decideRunSkip(valid({ filesTruncated: true }));
  assert.strictEqual(result.skip, false);
});

test("an empty changed-file list does not skip", () => {
  const result = decideRunSkip(valid({ files: [] }));
  assert.strictEqual(result.skip, false);
});

test("a commit touching a file outside the baselines prefix does not skip", () => {
  const result = decideRunSkip(
    valid({
      files: [
        { path: "tuffgal/baselines/visit-home/0.png" },
        { path: "src/index.ts" },
      ],
    })
  );
  assert.strictEqual(result.skip, false);
});

// Pins the `prefix + "/"` boundary specifically: a sibling directory that SHARES
// the baselines prefix as a raw string (`tuffgal/baselines-backup/` vs the
// `tuffgal/baselines` prefix) would pass a naive `startsWith(prefix)`. The reader
// appends `"/"` before the check, so this sibling correctly stays out of scope
// and the commit does NOT short-circuit. Distinct from the `src/index.ts` case
// above, which fails the check whether or not the trailing slash is present.
test("a sibling directory sharing the baselines prefix does not skip (trailing-slash boundary)", () => {
  const result = decideRunSkip(
    valid({ files: [{ path: "tuffgal/baselines-backup/x.png" }] })
  );
  assert.strictEqual(result.skip, false);
});

test("a trailer with trailing junk after the SHA does not match (anchored)", () => {
  const result = decideRunSkip(
    valid({ message: `approve\n\n${TRAILER} ${SHA} not-really` })
  );
  assert.strictEqual(result.skip, false);
});

test("a 39-hex (short) trailer SHA does not match", () => {
  const short = "a".repeat(39);
  const result = decideRunSkip(
    valid({ message: `approve\n\n${TRAILER} ${short}`, parentShas: [short] })
  );
  assert.strictEqual(result.skip, false);
});

// The space after the colon IS the load-bearing character: TRAILER_RE requires
// `Tuffgal-Full-Approval: ` (colon + space) before the 40-hex SHA, so a writer that
// dropped the space (`Tuffgal-Full-Approval:<sha>`) would silently stop matching
// and the whole skip feature would quietly break with no CI failure. This locks the
// reader's half of that contract; ci.yml's approve-trailer-source-lock locks the
// writer's copy of the same space, so the two cannot drift apart unseen.
test("a trailer with no space after the colon does not match (space is load-bearing)", () => {
  const result = decideRunSkip(
    valid({ message: `approve\n\nTuffgal-Full-Approval:${SHA}` })
  );
  assert.strictEqual(result.skip, false);
});

// ---- reject: missing / malformed inputs all fail SAFE ----------------------

test("missing inputs fail safe (do not skip)", () => {
  assert.strictEqual(decideRunSkip().skip, false);
  assert.strictEqual(decideRunSkip({}).skip, false);
  assert.strictEqual(decideRunSkip(valid({ message: undefined })).skip, false);
  assert.strictEqual(decideRunSkip(valid({ parentShas: undefined })).skip, false);
  assert.strictEqual(decideRunSkip(valid({ files: undefined })).skip, false);
  assert.strictEqual(
    decideRunSkip(valid({ baselinesPrefix: undefined })).skip,
    false
  );
  assert.strictEqual(decideRunSkip(valid({ baselinesPrefix: "" })).skip, false);
});

// ---- the path-join helper --------------------------------------------------

test("baselinesPrefixFrom collapses '.' working-directory to a clean prefix", () => {
  assert.strictEqual(
    baselinesPrefixFrom(".", "tuffgal/baselines"),
    "tuffgal/baselines"
  );
});

test("baselinesPrefixFrom nests a subdirectory working-directory", () => {
  assert.strictEqual(
    baselinesPrefixFrom("packages/web", "tuffgal/baselines"),
    "packages/web/tuffgal/baselines"
  );
});

test("baselinesPrefixFrom absorbs leading './' and trailing slashes", () => {
  assert.strictEqual(
    baselinesPrefixFrom("./app", "tuffgal/baselines/"),
    "app/tuffgal/baselines"
  );
});
