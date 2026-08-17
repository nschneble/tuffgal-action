"use strict";
//
// Unit tests for the results.json -> comment-entry adapter. Run with
// `node --test scripts/*.test.js`.
//
// This is the producer side of every fixture build-comment.test.js consumes, so
// the load-bearing arms are the ones nothing downstream can catch: which bucket a
// story lands in (and whether any approve key is dropped on the way), the
// a11y-only discriminator, the action-key allowlist, and the preview-root
// containment check.
//
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { buildStories, previewUrlFor, isMultiBreakpoint } = require("./build-stories.js");

const REPORT_ABS = path.resolve("/w/tuffgal/report");
const BASELINES_ABS = path.resolve("/w/tuffgal/baselines");
const PREVIEW = "https://pages.example/pr-4";

const urls = (previewUrl = PREVIEW) => ({
  previewUrl,
  reportAbs: REPORT_ABS,
  baselinesAbs: BASELINES_ABS,
});

const build = (result, previewUrl = PREVIEW) =>
  buildStories({
    result,
    previewUrl,
    reportAbs: REPORT_ABS,
    baselinesAbs: BASELINES_ABS,
  });

const action = (overrides = {}) => ({
  action: "visit-home",
  status: "changed",
  breakpoint: "desktop",
  ...overrides,
});

// --- preview URL resolution ------------------------------------------------ //

test("previewUrlFor: maps a report path and a baselines path to their staged roots", () => {
  assert.strictEqual(
    previewUrlFor(urls(), path.join(REPORT_ABS, "actual", "visit-home", "desktop.png")),
    `${PREVIEW}/report/actual/visit-home/desktop.png`
  );
  assert.strictEqual(
    previewUrlFor(urls(), path.join(BASELINES_ABS, "visit-home", "desktop.png")),
    `${PREVIEW}/baselines/visit-home/desktop.png`
  );
});

test("previewUrlFor: a sibling directory whose name merely PREFIXES a root is not under it", () => {
  // `/w/tuffgal/report-old` starts with `/w/tuffgal/report` as a string but is a
  // different directory — the same boundary run-skip.js and baseline-tree.js each
  // guard, and the reason the containment test appends a separator.
  assert.strictEqual(
    previewUrlFor(urls(), path.resolve("/w/tuffgal/report-old/actual/x.png")),
    null
  );
  assert.strictEqual(
    previewUrlFor(urls(), path.resolve("/w/tuffgal/baselines-backup/x.png")),
    null
  );
});

test("previewUrlFor: returns null with no preview, no path, or a path under neither root", () => {
  assert.strictEqual(previewUrlFor(urls(""), path.join(REPORT_ABS, "a.png")), null);
  assert.strictEqual(previewUrlFor(urls(), undefined), null);
  assert.strictEqual(previewUrlFor(urls(), path.resolve("/elsewhere/a.png")), null);
});

// --- bucketing -------------------------------------------------------------- //

test("a failed story lands in failed only, with its message and no approve keys", () => {
  const out = build({
    stories: [
      {
        story: "Home",
        status: "failed",
        actions: [
          action({ status: "failed", failureMessage: "boom", breakpoint: "mobile" }),
          action({ status: "changed" }),
        ],
      },
    ],
  });
  assert.deepStrictEqual(out.failed, [
    { index: 0, name: "Home", message: "boom", breakpoint: "mobile" },
  ]);
  assert.strictEqual(out.changed.length, 0);
  assert.strictEqual(out.added.length, 0);
});

test("a story that is BOTH new and changed appears in both sections, keeping every key", () => {
  // Filing it under one bucket dropped the other status's keys entirely, so those
  // candidates could not be approved from the comment at all.
  const out = build({
    stories: [
      {
        story: "Home",
        status: "changed",
        actions: [
          action({ action: "visit-home", status: "new" }),
          action({ action: "hover-cta", status: "changed" }),
        ],
      },
    ],
  });
  assert.deepStrictEqual(out.added[0].actionKeys, ["visit-home"]);
  assert.deepStrictEqual(out.changed[0].actionKeys, ["hover-cta"]);
  assert.strictEqual(out.added[0].shots.length, 1, "new section shows only its new shot");
  assert.strictEqual(out.changed[0].shots.length, 1, "changed section shows only its changed shot");
  assert.strictEqual(out.added[0].index, out.changed[0].index, "both deep-link to the same story");
});

test("a story's rollup status alone still buckets it (legacy artifact, no action statuses)", () => {
  const out = build({ stories: [{ story: "Home", status: "changed", actions: [] }] });
  assert.strictEqual(out.changed.length, 1);
  assert.deepStrictEqual(out.changed[0].actionKeys, []);
});

test("a passing story lands nowhere", () => {
  const out = build({
    stories: [{ story: "Home", status: "pass", actions: [action({ status: "pass" })] }],
  });
  assert.deepStrictEqual([out.changed, out.added, out.failed], [[], [], []]);
});

test("story names fall back to file, then to an ordinal, and newlines are flattened", () => {
  const out = build({
    stories: [
      { file: "stories/home.json", status: "changed", actions: [] },
      { status: "changed", actions: [] },
      { story: "two\nlines", status: "changed", actions: [] },
    ],
  });
  assert.deepStrictEqual(
    out.changed.map((entry) => entry.name),
    ["stories/home.json", "story 1", "two lines"]
  );
});

// --- action keys ------------------------------------------------------------ //

test("action keys are deduped across breakpoints", () => {
  const out = build({
    stories: [
      {
        story: "Home",
        status: "changed",
        actions: [
          action({ breakpoint: "mobile" }),
          action({ breakpoint: "desktop" }),
          action({ action: "hover-cta", breakpoint: "mobile" }),
        ],
      },
    ],
  });
  assert.deepStrictEqual(out.changed[0].actionKeys, ["visit-home", "hover-cta"]);
});

test("a malformed action key never reaches the approve marker", () => {
  const out = build({
    stories: [
      {
        story: "Home",
        status: "changed",
        actions: [
          action({ action: "Visit_Home" }),
          action({ action: "../escape" }),
          action({ action: "" }),
          action({ action: 42 }),
          action({ action: "visit-home" }),
        ],
      },
    ],
  });
  assert.deepStrictEqual(out.changed[0].actionKeys, ["visit-home"]);
});

// --- a11y-only discriminator ------------------------------------------------ //

test("a changed shot is a11y-only ONLY when a11yChanged is true and there is no diff", () => {
  const out = build({
    stories: [
      {
        story: "Home",
        status: "changed",
        actions: [
          action({ breakpoint: "a", a11yChanged: true }),
          action({ breakpoint: "b", a11yChanged: true, diffPath: "/w/tuffgal/report/diff/b.png" }),
          action({ breakpoint: "c" }),
          // A size-mismatch row: no diffPath, but it never sets a11yChanged.
          action({ breakpoint: "d", failureMessage: "resized", sizeMismatch: {} }),
        ],
      },
    ],
  });
  assert.deepStrictEqual(
    out.changed[0].shots.map((shot) => shot.a11yOnly),
    [true, false, false, false]
  );
});

test("a11yDiff rides along when present and is null on an older results.json", () => {
  const diff = { lines: ["+ x"], added: 1, removed: 0, truncated: false };
  const out = build({
    stories: [
      {
        story: "Home",
        status: "changed",
        actions: [
          action({ breakpoint: "a", a11yChanged: true, a11yDiff: diff }),
          action({ breakpoint: "b", a11yChanged: true }),
        ],
      },
    ],
  });
  assert.deepStrictEqual(out.changed[0].shots[0].a11yDiff, diff);
  assert.strictEqual(out.changed[0].shots[1].a11yDiff, null);
});

test("new shots carry an actual only — there is no prior baseline", () => {
  const out = build({
    stories: [
      {
        story: "Home",
        status: "new",
        actions: [
          action({
            status: "new",
            actualPath: path.join(REPORT_ABS, "actual", "visit-home", "desktop.png"),
            baselinePath: path.join(BASELINES_ABS, "visit-home", "desktop.png"),
          }),
        ],
      },
    ],
  });
  assert.deepStrictEqual(out.added[0].shots, [
    { breakpoint: "desktop", actual: `${PREVIEW}/report/actual/visit-home/desktop.png` },
  ]);
});

// --- deleted + breakpoints -------------------------------------------------- //

test("a story deleted at N breakpoints is grouped into ONE entry", () => {
  const out = build({
    deleted: [
      { action: "visit-admin", breakpoint: "mobile" },
      { action: "visit-admin", breakpoint: "desktop" },
      { action: "visit-old", breakpoint: "mobile" },
    ],
  });
  assert.deepStrictEqual(out.deleted, [
    { name: "visit-admin", breakpoints: ["mobile", "desktop"] },
    { name: "visit-old", breakpoints: ["mobile"] },
  ]);
});

test("isMultiBreakpoint counts distinct names across stories AND deleted records", () => {
  assert.strictEqual(
    isMultiBreakpoint({ stories: [{ actions: [action({ breakpoint: "desktop" })] }] }),
    false
  );
  assert.strictEqual(
    isMultiBreakpoint({
      stories: [{ actions: [action({ breakpoint: "desktop" })] }],
      deleted: [{ action: "x", breakpoint: "mobile" }],
    }),
    true
  );
  assert.strictEqual(isMultiBreakpoint({ stories: [{ actions: [{ action: "x" }] }] }), false);
});

test("environment mismatch keys ride through; an absent environment yields none", () => {
  assert.deepStrictEqual(
    build({ environment: { mismatchKeys: ["browser"] } }).mismatchKeys,
    ["browser"]
  );
  assert.deepStrictEqual(build({}).mismatchKeys, []);
});

test("an empty result yields empty sections, not a crash", () => {
  const out = build({});
  assert.deepStrictEqual(
    [out.changed, out.added, out.deleted, out.failed, out.multiBreakpoint],
    [[], [], [], [], false]
  );
});
