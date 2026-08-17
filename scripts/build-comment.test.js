"use strict";
//
// Tests for the sticky-comment body builder.
//
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildCommentBody,
  MARKER,
  renderTotalsTable,
  approveItemMarker,
} = require("./build-comment.js");

// Cross-package require is fine in a test file — it runs from the repo root and
// this is compile-time verification, never a runtime cross-package require. We
// feed a rendered (multi-breakpoint, suffixed) checkbox line through the ACTUAL
// approve-trigger parser to prove the breakpoint suffix stays invisible to it.
const {
  resolveApprover,
} = require("../approve/scripts/resolve-approver.js");

// A baseline set of args. Individual tests override only what they exercise so
// the branch under test is isolated from the rest of the body.
const base = () => ({
  outcome: "pass",
  counts: {
    passed: "3",
    changed: "0",
    new: "0",
    deleted: "0",
    failed: "0",
    total: "3",
  },
  envMismatch: false,
  mismatchKeys: [],
  previewUrl: "",
  changed: [],
  added: [],
  deleted: [],
  failed: [],
  multiBreakpoint: false,
  runUrl: "https://github.com/o/r/actions/runs/1",
});

// A single-breakpoint changed shot: one entry, no breakpoint name — the shape
// action.yml emits for a single-config run.
const changedShot = (baseline, actual) => [{ breakpoint: undefined, baseline, actual }];
// A single-breakpoint new shot: actual only (no prior baseline exists yet).
const newShot = (actual) => [{ breakpoint: undefined, actual }];

test("every body opens with the sticky marker so the upsert can find it", () => {
  const body = buildCommentBody(base());
  assert.ok(body.startsWith(MARKER + "\n"));
  assert.match(body, /## 👁️ Tuffgal visual regression/);
});

test("the outcome and totals table are always rendered", () => {
  const body = buildCommentBody(base());
  assert.match(body, /Outcome: \*\*pass\*\*/);
  assert.match(body, /\| Pass \| 3 \|/);
  assert.match(body, /\| Total \| 3 \|/);
});

test("a passing run with no pending work degrades to a bare run link", () => {
  const body = buildCommentBody(base());
  assert.match(
    body,
    /\[View the run →\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)/
  );
  assert.doesNotMatch(body, /Approve these changes/);
  assert.doesNotMatch(body, /Open the report/);
});

test("a pass with a preview but no pending work offers report + run links", () => {
  const body = buildCommentBody({
    ...base(),
    previewUrl: "https://pages.example/pr-7",
  });
  assert.match(
    body,
    /\[Open the report →\]\(https:\/\/pages\.example\/pr-7\/report\/index\.html\)/
  );
  assert.match(body, /\[View the run →\]/);
  assert.doesNotMatch(body, /Approve these changes/);
});

test("env-mismatch banner renders with its changed keys when the flag is set", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "env-mismatch",
    envMismatch: true,
    mismatchKeys: ["os", "viewport"],
  });
  assert.match(body, /⚠️ \*\*Capture environment changed\*\*/);
  assert.match(body, /captured in a different environment than this CI run/);
  assert.match(body, /Changed keys: `os`, `viewport`/);
});

test("env-mismatch banner omits the keys line when none are reported", () => {
  const body = buildCommentBody({
    ...base(),
    envMismatch: true,
    mismatchKeys: [],
  });
  assert.match(body, /⚠️ \*\*Capture environment changed\*\*/);
  assert.doesNotMatch(body, /Changed keys:/);
});

test("no banner when the environment matched", () => {
  const body = buildCommentBody(base());
  assert.doesNotMatch(body, /Capture environment changed/);
});

test("changed stories without a preview still render a per-item approve checkbox", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    changed: [
      {
        index: 0,
        name: "Home page",
        shots: changedShot(null, null),
        actionKeys: ["home"],
      },
    ],
  });
  assert.match(body, /### Changed \(1\)/);
  // Approval must work even without a Pages preview, so the checkbox replaces
  // the old plain `- name` line rather than being dropped on the no-preview path.
  assert.match(
    body,
    /- \[ \] <!-- tuffgal-approve-item:home --> Approve \*\*Home page\*\*/
  );
  assert.doesNotMatch(body, /<details>/);
  // Pending work still renders the approve CTA without a preview, but the
  // report-only "Open the full report" line needs a preview URL, so it is absent.
  assert.match(body, /### Approve these changes/);
  assert.doesNotMatch(body, /Open the full report/);
});

test("changed stories with a preview render a two-column table, a deep link, and name-bearing alt text", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    previewUrl: "https://pages.example/pr-7",
    changed: [
      {
        index: 2,
        name: "Login form",
        shots: changedShot(
          "https://pages.example/pr-7/baselines/login.png",
          "https://pages.example/pr-7/report/login.png"
        ),
      },
    ],
  });
  assert.match(body, /<summary>Login form<\/summary>/);
  // The single-breakpoint table is baseline | actual only — no Breakpoint
  // column, no Diff column; the full diff still lives in the linked report.
  assert.match(body, /^\| Baseline \| Actual \|$/m);
  assert.doesNotMatch(body, /\| Baseline \| Actual \| Diff \|/);
  assert.doesNotMatch(body, /Breakpoint/);
  // Alt text threads the story name for per-image screen-reader context.
  assert.match(body, /alt="baseline for Login form"/);
  assert.match(body, /alt="actual for Login form"/);
  assert.doesNotMatch(body, /alt="diff for Login form"/);
  assert.match(
    body,
    /<img src="https:\/\/pages\.example\/pr-7\/baselines\/login\.png"/
  );
  assert.match(
    body,
    /\[Open Login form in report →\]\(https:\/\/pages\.example\/pr-7\/report\/index\.html#story-2\)/
  );
});

test("a missing image URL renders an unavailable placeholder, not a broken img", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "1" },
    previewUrl: "https://pages.example/pr-7",
    changed: [{ index: 0, name: "Widget", shots: changedShot(null, null) }],
  });
  assert.match(body, /<em>baseline for Widget unavailable<\/em>/);
  assert.doesNotMatch(body, /<img/);
});

test("the img src is attribute-escaped so a crafted path cannot break out", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "1" },
    previewUrl: "https://pages.example/pr-7",
    changed: [
      {
        index: 0,
        name: "X",
        shots: changedShot(
          'https://pages.example/pr-7/report/a"><script>b.png',
          null
        ),
      },
    ],
  });
  assert.doesNotMatch(body, /src="[^"]*"><script>/);
  assert.match(body, /&quot;&gt;&lt;script&gt;/);
});

test("a story name with HTML metacharacters is escaped in summary and alt", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "1" },
    previewUrl: "https://pages.example/pr-7",
    changed: [
      {
        index: 0,
        name: 'a <b> "c"',
        shots: changedShot("https://pages.example/pr-7/report/x.png", null),
      },
    ],
  });
  assert.match(body, /<summary>a &lt;b&gt; "c"<\/summary>/);
  assert.match(body, /alt="baseline for a &lt;b&gt; &quot;c&quot;"/);
});

test("new stories with a preview show a proposed baseline with name-bearing alt", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, new: "1", total: "1" },
    previewUrl: "https://pages.example/pr-7",
    added: [
      {
        index: 1,
        name: "Nav bar",
        shots: newShot("https://pages.example/pr-7/report/nav.png"),
      },
    ],
  });
  assert.match(body, /### New \(1\)/);
  assert.match(body, /Proposed new baseline: <img/);
  assert.match(body, /alt="proposed baseline for Nav bar"/);
});

test("new stories without a preview still render a per-item approve checkbox", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, new: "1", total: "1" },
    added: [{ index: 0, name: "Nav bar", shots: newShot(null), actionKeys: ["nav"] }],
  });
  assert.match(
    body,
    /- \[ \] <!-- tuffgal-approve-item:nav --> Approve \*\*Nav bar\*\*/
  );
  assert.doesNotMatch(body, /<details>/);
});

test("deleted stories are listed with newlines flattened", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, deleted: "2", total: "2" },
    deleted: [
      { name: "Old header", breakpoints: [] },
      { name: "multi\nline name", breakpoints: [] },
    ],
  });
  assert.match(body, /### Deleted \(2\)/);
  assert.match(body, /- Old header/);
  assert.match(body, /- multi line name/);
});

test("a deleted story name with HTML metacharacters is escaped", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, deleted: "1", total: "1" },
    deleted: [{ name: 'a <b> "c"', breakpoints: [] }],
  });
  assert.match(body, /- a &lt;b&gt; "c"/);
});

test("the deleted section links the report's deleted heading when a preview is present", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, deleted: "1", total: "1" },
    previewUrl: "https://pages.example/pr-7",
    deleted: [{ name: "Old header", breakpoints: [] }],
  });
  assert.match(body, /### Deleted \(1\)/);
  assert.match(body, /- Old header/);
  // One section-level anchor to the report's stable <h2 id="deleted-heading">,
  // not a per-name link.
  assert.match(
    body,
    /\[View deleted baselines in report →\]\(https:\/\/pages\.example\/pr-7\/report\/index\.html#deleted-heading\)/
  );
});

test("the deleted section omits the report link when no preview is present", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, deleted: "1", total: "1" },
    deleted: [{ name: "Old header", breakpoints: [] }],
  });
  assert.match(body, /### Deleted \(1\)/);
  assert.doesNotMatch(body, /View deleted baselines in report/);
});

test("pending work renders the approve CTA and the approve-box marker", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "1" },
    previewUrl: "https://pages.example/pr-7",
    changed: [{ index: 0, name: "Home", shots: changedShot(null, null) }],
  });
  assert.match(body, /### Approve these changes/);
  assert.match(body, /<!-- tuffgal-approve-box -->/);
  assert.match(body, /📊 \[Open the full report\]/);
  assert.match(body, /@tuffgal approve/);
});

test("a deletion-only run (no changed/new) still renders the approve CTA", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, deleted: "1", total: "1" },
    deleted: [{ name: "old-footer", breakpoints: [] }],
  });
  // `pending` gates the CTA on new + changed + deleted > 0. A regression that
  // dropped `deleted` from that formula would silently hide approval for a
  // deletion-only run — so pin that deleted alone still renders both the CTA
  // heading and the approve-box marker.
  assert.match(body, /### Approve these changes/);
  assert.match(body, /<!-- tuffgal-approve-box -->/);
});

test("a short-circuited run renders a compact body with NEITHER approve marker", () => {
  const body = buildCommentBody({
    shortCircuit: { sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" },
    runUrl: "https://github.com/o/r/actions/runs/9",
  });
  // Marker (so the sticky upsert still finds it), header, pass outcome, the
  // reviewed short SHA, and a run link.
  assert.ok(body.startsWith(MARKER + "\n"));
  assert.match(body, /## 👁️ Tuffgal visual regression/);
  assert.match(body, /Outcome: \*\*pass\*\*/);
  assert.match(body, /`a1b2c3d`/);
  assert.match(
    body,
    /\[View the run →\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/9\)/
  );
  // Critically: NO approve-checkbox markers of any kind — nothing is pending.
  assert.doesNotMatch(body, /tuffgal-approve-box/);
  assert.doesNotMatch(body, /tuffgal-approve-item:/);
  // And none of the full-layout scaffolding leaked in.
  assert.doesNotMatch(body, /\| Status \| Count \|/);
  assert.doesNotMatch(body, /### Approve these changes/);
});

test("a no-results outcome names the concrete config fix", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "no-results",
    counts: {
      passed: "0",
      changed: "0",
      new: "0",
      deleted: "0",
      failed: "0",
      total: "0",
    },
  });
  assert.match(body, /The run wrote no `results\.json`/);
  assert.match(
    body,
    /`report-path` matches `paths\.report` in tuffgal\.config\.ts/
  );
  assert.match(body, /\[View the run →\]/);
  assert.doesNotMatch(body, /Approve these changes/);
});

test("a failed outcome points at the report artifact", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "failed",
    counts: {
      passed: "2",
      changed: "0",
      new: "0",
      deleted: "0",
      failed: "1",
      total: "3",
    },
  });
  assert.match(
    body,
    /Download the `tuffgal-report` artifact and open `index\.html`/
  );
});

test("a failed outcome that also has pending work keeps the approve CTA", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "failed",
    counts: {
      passed: "1",
      changed: "1",
      new: "0",
      deleted: "0",
      failed: "1",
      total: "3",
    },
    changed: [{ index: 0, name: "Home", shots: changedShot(null, null) }],
  });
  assert.match(body, /Download the `tuffgal-report` artifact/);
  assert.match(body, /### Approve these changes/);
});

// The Failed section — hard failures, rendered after Deleted (mirroring the
// totals-table row order) as plain bullets with no approve checkbox.

test("a failed story renders in the Failed section with its message and no checkbox", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "failed",
    counts: { ...base().counts, passed: "2", failed: "1", total: "3" },
    failed: [
      { index: 0, name: "Checkout", message: "Timeout waiting for selector" },
    ],
  });
  assert.match(body, /### Failed \(1\)/);
  assert.match(body, /- \*\*Checkout\*\* — Timeout waiting for selector/);
  // A hard failure is not an approvable change: no per-item checkbox/marker.
  assert.doesNotMatch(body, /tuffgal-approve-item/);
  assert.doesNotMatch(body, /Approve \*\*Checkout\*\*/);
  // No preview URL, so no report deep-link on the entry.
  assert.doesNotMatch(body, /Open Checkout in report/);
});

test("a failed story deep-links to the report when a preview is present", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "failed",
    counts: { ...base().counts, passed: "2", failed: "1", total: "3" },
    previewUrl: "https://pages.example/pr-7",
    failed: [{ index: 3, name: "Checkout", message: "boom" }],
  });
  assert.match(
    body,
    /- \*\*Checkout\*\* — boom \[Open Checkout in report →\]\(https:\/\/pages\.example\/pr-7\/report\/index\.html#story-3\)/
  );
});

test("a failed entry with an empty message renders just the name (no dangling dash)", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "failed",
    counts: { ...base().counts, passed: "2", failed: "1", total: "3" },
    failed: [{ index: 0, name: "Checkout", message: "" }],
  });
  assert.match(body, /### Failed \(1\)/);
  const failedLine = body
    .split("\n")
    .find((l) => l.includes("**Checkout**"));
  assert.strictEqual(failedLine, "- **Checkout**");
});

test("a failed message is HTML-escaped", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "failed",
    counts: { ...base().counts, passed: "2", failed: "1", total: "3" },
    failed: [{ index: 0, name: "S", message: 'a <b> "c" & d' }],
  });
  // escapeHtml handles & < > (not quotes, matching the rest of the module).
  assert.match(body, /- \*\*S\*\* — a &lt;b&gt; "c" &amp; d/);
});

test("a failed message collapses its newlines and whitespace runs to single spaces", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "failed",
    counts: { ...base().counts, passed: "2", failed: "1", total: "3" },
    failed: [{ index: 0, name: "S", message: "a\nb\r\n  c\td" }],
  });
  assert.match(body, /- \*\*S\*\* — a b c d/);
});

test("a long failed message is truncated to ~140 chars with an ellipsis marker", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "failed",
    counts: { ...base().counts, passed: "2", failed: "1", total: "3" },
    failed: [{ index: 0, name: "S", message: "A".repeat(200) }],
  });
  // Exactly 140 A's, then the ellipsis; never the full 200-char run.
  assert.match(body, /A{140}…/);
  assert.doesNotMatch(body, /A{141}/);
});

test("a failed-only run (no new/changed/deleted) does NOT render the approve CTA", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "failed",
    counts: {
      passed: "2",
      changed: "0",
      new: "0",
      deleted: "0",
      failed: "1",
      total: "3",
    },
    failed: [{ index: 0, name: "Checkout", message: "boom" }],
  });
  assert.match(body, /### Failed \(1\)/);
  // The `pending` gate counts only new/changed/deleted, so a failed-only run
  // must never offer approval — neither the CTA heading nor the box marker.
  assert.doesNotMatch(body, /### Approve these changes/);
  assert.doesNotMatch(body, /tuffgal-approve-box/);
});

test("a failed story alongside changed work keeps the approve CTA for the changed work only", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "failed",
    counts: {
      passed: "0",
      changed: "1",
      new: "0",
      deleted: "0",
      failed: "1",
      total: "2",
    },
    changed: [
      { index: 0, name: "Home", shots: changedShot(null, null), actionKeys: ["home"] },
    ],
    failed: [{ index: 1, name: "Checkout", message: "boom" }],
  });
  // Both sections render...
  assert.match(body, /### Changed \(1\)/);
  assert.match(body, /### Failed \(1\)/);
  // ...the approve CTA still fires for the changed/new/deleted work...
  assert.match(body, /### Approve these changes/);
  // ...the changed story gets its checkbox, the failed story does not.
  assert.match(body, /tuffgal-approve-item:home/);
  assert.doesNotMatch(body, /Approve \*\*Checkout\*\*/);
});

test("empty story lists render only the outcome, table, and fallback link", () => {
  const body = buildCommentBody(base());
  assert.doesNotMatch(body, /### Changed/);
  assert.doesNotMatch(body, /### New/);
  assert.doesNotMatch(body, /### Deleted/);
  assert.doesNotMatch(body, /### Failed/);
});

// The exported renderers are extracted for reuse and kept in step with the bash
// step-summary; lock their shape here.
test("renderTotalsTable emits the fixed row order", () => {
  const rows = renderTotalsTable({
    passed: "1",
    changed: "2",
    new: "3",
    deleted: "4",
    failed: "5",
    total: "6",
  });
  assert.deepStrictEqual(rows, [
    "| Status | Count |",
    "|--------|-------|",
    "| Pass | 1 |",
    "| Changed | 2 |",
    "| New | 3 |",
    "| Deleted | 4 |",
    "| Failed | 5 |",
    "| Total | 6 |",
  ]);
});

// Per-item approve checkboxes — the contract the trigger parser
// (`resolve-approver.js`) consumes. Each Changed/New entry gets its own
// task-list checkbox whose marker embeds the entry's candidate-tree action keys,
// so the parser can regex `(keys, ticked)` per line with no external index.

test("approveItemMarker embeds comma-joined action keys in an HTML comment", () => {
  assert.strictEqual(
    approveItemMarker(["one", "two"]),
    "<!-- tuffgal-approve-item:one,two -->"
  );
  // Empty keys still render a well-formed (empty-payload) marker, never junk.
  assert.strictEqual(approveItemMarker([]), "<!-- tuffgal-approve-item: -->");
  assert.strictEqual(
    approveItemMarker(undefined),
    "<!-- tuffgal-approve-item: -->"
  );
  // Write-side allowlist (defense in depth): a malformed key is dropped before the
  // join, so it never reaches the rendered marker; the valid key survives.
  assert.strictEqual(
    approveItemMarker(["good-key", "../etc", "UPPER", "has spaces"]),
    "<!-- tuffgal-approve-item:good-key -->"
  );
  // A selection of only malformed keys renders the empty payload, never junk.
  assert.strictEqual(
    approveItemMarker(["../../secret"]),
    "<!-- tuffgal-approve-item: -->"
  );
});

test("approveItemMarker drops nullish keys instead of string-coercing them", () => {
  // Regression: the allowlist filter uses RegExp.test(), which string-coerces its
  // argument — /^[a-z0-9-]+$/.test(undefined) tests "undefined" and returns true,
  // same for null. A nullish/missing `.action` key (dropped by the old
  // `.filter(Boolean)`) must NOT survive as a literal "undefined"/"null" segment.
  assert.strictEqual(
    approveItemMarker([undefined]),
    "<!-- tuffgal-approve-item: -->"
  );
  assert.strictEqual(
    approveItemMarker([null]),
    "<!-- tuffgal-approve-item: -->"
  );
  // A valid key survives while its nullish siblings are dropped — no coercion junk.
  assert.strictEqual(
    approveItemMarker(["good-key", undefined, null]),
    "<!-- tuffgal-approve-item:good-key -->"
  );
});

test("a single changed entry renders one per-item approve checkbox with its key", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "1" },
    previewUrl: "https://pages.example/pr-7",
    changed: [
      {
        index: 0,
        name: "Home page",
        shots: changedShot(null, null),
        actionKeys: ["visit-home"],
      },
    ],
  });
  assert.match(
    body,
    /- \[ \] <!-- tuffgal-approve-item:visit-home --> Approve \*\*Home page\*\*/
  );
  // The checkbox sits ABOVE the collapsible, not inside it, so ticking it can't
  // snap the <details> shut.
  const checkboxAt = body.indexOf("tuffgal-approve-item:visit-home");
  const detailsAt = body.indexOf("<details>");
  assert.ok(checkboxAt !== -1 && detailsAt !== -1 && checkboxAt < detailsAt);
});

test("a single new entry renders one per-item approve checkbox with its key", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, new: "1", total: "1" },
    previewUrl: "https://pages.example/pr-7",
    added: [
      { index: 0, name: "Nav bar", shots: newShot(null), actionKeys: ["render-nav"] },
    ],
  });
  assert.match(
    body,
    /- \[ \] <!-- tuffgal-approve-item:render-nav --> Approve \*\*Nav bar\*\*/
  );
});

test("multiple entries each render their own per-item approve checkbox", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "2", new: "1", total: "3" },
    changed: [
      { index: 0, name: "Home", shots: changedShot(null, null), actionKeys: ["home"] },
      { index: 1, name: "About", shots: changedShot(null, null), actionKeys: ["about"] },
    ],
    added: [
      { index: 2, name: "Contact", shots: newShot(null), actionKeys: ["contact"] },
    ],
  });
  assert.match(body, /<!-- tuffgal-approve-item:home -->/);
  assert.match(body, /<!-- tuffgal-approve-item:about -->/);
  assert.match(body, /<!-- tuffgal-approve-item:contact -->/);
  // One checkbox per entry, no more, no fewer.
  assert.strictEqual((body.match(/tuffgal-approve-item:/g) || []).length, 3);
});

test("with a preview, each per-item checkbox after the first is separated from the prior entry's </details> by a blank line", () => {
  const body = buildCommentBody({
    ...base(),
    previewUrl: "https://pages.example/pr-7",
    outcome: "changed",
    counts: { ...base().counts, changed: "2", new: "1", total: "3" },
    changed: [
      { index: 0, name: "Home", shots: changedShot(null, null), actionKeys: ["home"] },
      { index: 1, name: "About", shots: changedShot(null, null), actionKeys: ["about"] },
    ],
    added: [
      { index: 2, name: "Contact", shots: newShot(null), actionKeys: ["contact"] },
    ],
  });
  const lines = body.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.startsWith("- [ ]") && i > 0 && lines[i - 1] === "</details>") {
      assert.fail(
        `checkbox line "${line}" directly follows </details> with no blank line`
      );
    }
  }
});

test("a story with 2+ actions comma-joins its keys in one marker", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "1" },
    changed: [
      {
        index: 0,
        name: "Dashboard",
        shots: changedShot(null, null),
        actionKeys: ["load-dashboard", "open-panel", "hover-tile"],
      },
    ],
  });
  assert.match(
    body,
    /- \[ \] <!-- tuffgal-approve-item:load-dashboard,open-panel,hover-tile --> Approve \*\*Dashboard\*\*/
  );
});

test("per-item checkboxes leave the master approve-box markup byte-for-byte unchanged", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "1" },
    previewUrl: "https://pages.example/pr-7",
    changed: [
      { index: 0, name: "Home", shots: changedShot(null, null), actionKeys: ["home"] },
    ],
  });
  // The master checkbox — its literal marker, label, and helper text — is the
  // contract the existing approve workflow greps for, so it stays byte-for-byte
  // stable even as the per-item checkboxes render alongside it.
  assert.ok(
    body.includes(
      "- [ ] <!-- tuffgal-approve-box --> **Approve these baselines** — tick to commit the candidate baselines to this PR (requires write access)."
    )
  );
  // The per-item marker and the master marker never collide under a grep.
  assert.doesNotMatch(body, /tuffgal-approve-item:[^\s]*box/);
});

test("a story name with HTML metacharacters is escaped in its per-item checkbox", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "1" },
    changed: [
      {
        index: 0,
        name: 'a <b> "c"',
        shots: changedShot(null, null),
        actionKeys: ["x"],
      },
    ],
  });
  assert.match(
    body,
    /- \[ \] <!-- tuffgal-approve-item:x --> Approve \*\*a &lt;b&gt; "c"\*\*/
  );
});

// ---------------------------------------------------------------------------
// Single-breakpoint parity — the common case. A single-config run (one shot per
// entry, no `breakpoint`, multiBreakpoint false) must render byte-for-byte the
// same body as the pre-breakpoint (single-shot) builder did. The golden fixture
// was generated from the single-representative-shot builder against an
// equivalent flat-shape fixture, so this locks the whole single-breakpoint
// surface — banner, tables, deleted, failed, approve CTA — against any drift.
// ---------------------------------------------------------------------------
test("a single-breakpoint run renders byte-for-byte identical to the pre-breakpoint output", () => {
  const body = buildCommentBody({
    outcome: "changed",
    counts: {
      passed: "2",
      changed: "1",
      new: "1",
      deleted: "1",
      failed: "1",
      total: "6",
    },
    envMismatch: true,
    mismatchKeys: ["os", "viewport"],
    previewUrl: "https://pages.example/pr-7",
    changed: [
      {
        index: 0,
        name: "Home hero",
        shots: changedShot(
          "https://pages.example/pr-7/baselines/home/0.png",
          "https://pages.example/pr-7/report/home/0.png"
        ),
        actionKeys: ["visit-home", "hover-cta"],
      },
    ],
    added: [
      {
        index: 1,
        name: "Nav bar",
        shots: newShot("https://pages.example/pr-7/report/nav/0.png"),
        actionKeys: ["render-nav"],
      },
    ],
    deleted: [{ name: "old-footer", breakpoints: [] }],
    failed: [
      {
        index: 2,
        name: "Checkout flow",
        message: 'Timeout 30000ms exceeded waiting for selector ".pay"',
        breakpoint: undefined,
      },
    ],
    multiBreakpoint: false,
    runUrl: "https://github.com/o/r/actions/runs/1",
  });
  const golden = fs.readFileSync(
    path.join(__dirname, "build-comment.single-breakpoint-parity.txt"),
    "utf8"
  );
  assert.strictEqual(body, golden);
});

// ---------------------------------------------------------------------------
// Multi-breakpoint mode — the new behavior. Detail tables gain a Breakpoint
// column with one row per drifted breakpoint; the checkbox, deleted, and failed
// lines carry breakpoint labels.
// ---------------------------------------------------------------------------
test("a multi-breakpoint changed story renders a Breakpoint | Baseline | Actual table with one row per breakpoint", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "1" },
    previewUrl: "https://pages.example/pr-7",
    multiBreakpoint: true,
    changed: [
      {
        index: 0,
        name: "Home hero",
        shots: [
          {
            breakpoint: "mobile",
            baseline: "https://pages.example/pr-7/baselines/home/mobile.png",
            actual: "https://pages.example/pr-7/report/home/mobile.png",
          },
          {
            breakpoint: "desktop",
            baseline: "https://pages.example/pr-7/baselines/home/desktop.png",
            actual: "https://pages.example/pr-7/report/home/desktop.png",
          },
        ],
        actionKeys: ["visit-home"],
      },
    ],
  });
  // Three-column header, never the single-breakpoint two-column one.
  assert.match(body, /^\| Breakpoint \| Baseline \| Actual \|$/m);
  assert.doesNotMatch(body, /^\| Baseline \| Actual \|$/m);
  // One labelled row per breakpoint, each carrying that breakpoint's images.
  assert.match(
    body,
    /^\| mobile \| <img src="https:\/\/pages\.example\/pr-7\/baselines\/home\/mobile\.png"[^|]*\| <img src="https:\/\/pages\.example\/pr-7\/report\/home\/mobile\.png"[^|]*\|$/m
  );
  assert.match(
    body,
    /^\| desktop \| <img src="https:\/\/pages\.example\/pr-7\/baselines\/home\/desktop\.png"[^|]*\| <img src="https:\/\/pages\.example\/pr-7\/report\/home\/desktop\.png"[^|]*\|$/m
  );
  // The checkbox names which breakpoints drifted, after the marker + tick-box.
  assert.match(
    body,
    /- \[ \] <!-- tuffgal-approve-item:visit-home --> Approve \*\*Home hero\*\* \(mobile, desktop\)/
  );
});

test("a multi-breakpoint new story renders a Breakpoint | Actual table (actual-only), one row per breakpoint", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, new: "1", total: "1" },
    previewUrl: "https://pages.example/pr-7",
    multiBreakpoint: true,
    added: [
      {
        index: 0,
        name: "Nav bar",
        shots: [
          { breakpoint: "mobile", actual: "https://pages.example/pr-7/report/nav/mobile.png" },
          { breakpoint: "desktop", actual: "https://pages.example/pr-7/report/nav/desktop.png" },
        ],
        actionKeys: ["render-nav"],
      },
    ],
  });
  assert.match(body, /^\| Breakpoint \| Actual \|$/m);
  // No Baseline column for a new story, and not the single-breakpoint prose line.
  assert.doesNotMatch(body, /Baseline/);
  assert.doesNotMatch(body, /Proposed new baseline:/);
  assert.match(
    body,
    /^\| mobile \| <img src="https:\/\/pages\.example\/pr-7\/report\/nav\/mobile\.png"[^|]*\|$/m
  );
  assert.match(
    body,
    /^\| desktop \| <img src="https:\/\/pages\.example\/pr-7\/report\/nav\/desktop\.png"[^|]*\|$/m
  );
  assert.match(
    body,
    /Approve \*\*Nav bar\*\* \(mobile, desktop\)/
  );
});

test("a multi-breakpoint deleted story lists all its breakpoints on one grouped line", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, deleted: "2", total: "2" },
    multiBreakpoint: true,
    deleted: [{ name: "old-footer", breakpoints: ["mobile", "desktop"] }],
  });
  // One grouped bullet (not one per breakpoint), with the breakpoints joined.
  assert.match(body, /^- old-footer — mobile, desktop$/m);
  assert.strictEqual((body.match(/- old-footer/g) || []).length, 1);
});

test("a multi-breakpoint failed story carries a (breakpoint) label after its name", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "failed",
    counts: { ...base().counts, passed: "1", failed: "1", total: "2" },
    multiBreakpoint: true,
    failed: [{ index: 0, name: "Checkout", message: "boom", breakpoint: "mobile" }],
  });
  assert.match(body, /- \*\*Checkout\*\* \(mobile\) — boom/);
});

test("breakpoint names are HTML-escaped everywhere they render", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", deleted: "1", total: "2" },
    previewUrl: "https://pages.example/pr-7",
    multiBreakpoint: true,
    changed: [
      {
        index: 0,
        name: "Home",
        shots: [
          { breakpoint: "a<b", baseline: null, actual: null },
        ],
        actionKeys: ["home"],
      },
    ],
    deleted: [{ name: "old", breakpoints: ["a<b"] }],
  });
  // Checkbox suffix, table row, and deleted line all escape the metacharacter.
  assert.match(body, /Approve \*\*Home\*\* \(a&lt;b\)/);
  assert.match(body, /^\| a&lt;b \|/m);
  assert.match(body, /- old — a&lt;b/);
  assert.doesNotMatch(body, /a<b/);
});

// ---------------------------------------------------------------------------
// Legacy fallback — a results.json artifact predating the `breakpoint` field.
// action.yml computes multiBreakpoint === false (no non-empty breakpoint names),
// so the body must take the single-breakpoint path: two-column table, plain
// deleted names, no breakpoint labels anywhere.
// ---------------------------------------------------------------------------
test("a legacy fixture with no breakpoint field renders via the single-breakpoint path", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", deleted: "1", failed: "1", total: "3" },
    previewUrl: "https://pages.example/pr-7",
    multiBreakpoint: false,
    changed: [
      {
        index: 0,
        name: "Home",
        shots: changedShot(
          "https://pages.example/pr-7/baselines/home/0.png",
          "https://pages.example/pr-7/report/home/0.png"
        ),
        actionKeys: ["home"],
      },
    ],
    deleted: [{ name: "old-footer", breakpoints: [] }],
    failed: [{ index: 1, name: "Checkout", message: "boom", breakpoint: undefined }],
  });
  // Single-breakpoint two-column table, no Breakpoint column anywhere.
  assert.match(body, /^\| Baseline \| Actual \|$/m);
  assert.doesNotMatch(body, /Breakpoint/);
  // Plain deleted name, no breakpoint suffix.
  assert.match(body, /^- old-footer$/m);
  // Plain failed line, no (breakpoint) label.
  assert.match(body, /- \*\*Checkout\*\* — boom/);
  // Checkbox carries no breakpoint suffix.
  assert.match(body, /Approve \*\*Home\*\*$/m);
});

// ---------------------------------------------------------------------------
// Marker integrity — the breakpoint suffix is free text AFTER the per-item
// marker + tick-box, so it must be invisible to resolve-approver.js's actual
// CHECKED_ITEM_BOX regex. We render a real multi-breakpoint body, tick the box,
// and feed the whole thing through the ACTUAL approver parser (not a re-derived
// regex) to prove the ticked box still resolves to exactly its action keys.
// ---------------------------------------------------------------------------
test("the multi-breakpoint checkbox suffix stays invisible to resolve-approver's marker regex", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "1" },
    previewUrl: "https://pages.example/pr-7",
    multiBreakpoint: true,
    changed: [
      {
        index: 0,
        name: "Home hero",
        shots: [
          { breakpoint: "mobile", baseline: null, actual: null },
          { breakpoint: "desktop", baseline: null, actual: null },
        ],
        actionKeys: ["visit-home", "hover-cta"],
      },
    ],
  });
  // The rendered checkbox actually carries the suffix we are testing against.
  const checkboxLine = body
    .split("\n")
    .find((l) => l.includes("tuffgal-approve-item:visit-home,hover-cta"));
  assert.match(checkboxLine, /Approve \*\*Home hero\*\* \(mobile, desktop\)$/);

  // Tick it and feed the whole body through the real approve-trigger parser.
  const tickedBody = body.replace(
    "- [ ] <!-- tuffgal-approve-item:visit-home,hover-cta -->",
    "- [x] <!-- tuffgal-approve-item:visit-home,hover-cta -->"
  );
  const verdict = resolveApprover({
    eventName: "issue_comment",
    action: "edited",
    comment: { body: tickedBody, user: { login: "maintainer" } },
    issue: { pull_request: {} },
    contextActor: "maintainer",
  });
  assert.strictEqual(verdict.proceed, true);
  assert.strictEqual(verdict.via, "checkbox");
  // The suffix did not perturb key extraction: exactly the two embedded keys.
  assert.deepStrictEqual(verdict.selection.sort(), ["hover-cta", "visit-home"]);
});

// An a11y-only changed shot: pixels matched, the accessibility tree drifted, so
// the shot carries results.json's a11yDiff payload instead of a real image pair.
const a11yShot = (overrides = {}) => [
  {
    breakpoint: undefined,
    baseline: null,
    actual: null,
    a11yOnly: true,
    a11yDiff: {
      lines: [' - navigation:', '-  - link "Home"', '+  - link "Home page"'],
      added: 1,
      removed: 1,
      truncated: false,
    },
    ...overrides,
  },
];

const a11yEntry = (shots) => ({
  index: 0,
  name: "Home hero",
  shots,
  actionKeys: ["visit-home"],
});

// The a11y snapshot is the one string rendered RAW, and it traces back to the
// page under test. The consumer's approve prefilter greps the body as a plain
// substring, so a marker inside the fence still fires it.
test("a newline inside an a11y diff line cannot close the fence", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    changed: [
      a11yEntry(
        a11yShot({ a11yDiff: { lines: ["nav\n```\n\n## injected heading"] } })
      ),
    ],
  });

  const lines = body.split("\n");
  assert.ok(!lines.some((line) => line.startsWith("## injected heading")));
  assert.ok(lines.includes("nav ``` ## injected heading"));
});

test("a ticked approve marker inside an a11y diff line is defanged", () => {
  const lines = [
    "- [x] <!-- tuffgal-approve-box --> all",
    "[X] <!-- tuffgal-approve-item:visit-home --> one",
  ];
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    changed: [a11yEntry(a11yShot({ a11yDiff: { lines } }))],
  });

  for (const substring of [
    "[x] <!-- tuffgal-approve-box",
    "[X] <!-- tuffgal-approve-box",
    "[x] <!-- tuffgal-approve-item:",
    "[X] <!-- tuffgal-approve-item:",
  ]) {
    assert.ok(!body.includes(substring), `body still carries ${substring}`);
  }
  // Defanged, not dropped: the reviewer still sees what the snapshot said.
  assert.ok(body.includes("[ ] <!-- tuffgal-approve-box --> all"));
});

test("an a11y-only changed story renders its diff instead of thumbnails, preview or not", () => {
  for (const previewUrl of ["", "https://pages.example/pr-1"]) {
    const body = buildCommentBody({
      ...base(),
      outcome: "changed",
      counts: { ...base().counts, changed: "1", total: "4" },
      previewUrl,
      changed: [a11yEntry(a11yShot())],
    });
    assert.match(body, /Pixels unchanged\. The accessibility snapshot drifted\./);
    assert.match(body, /```diff\n - navigation:\n-  - link "Home"\n\+  - link "Home page"\n```/);
    assert.ok(!body.includes("<img"), "no thumbnails for two identical PNGs");
    assert.ok(!body.includes("| Baseline | Actual |"), "no screenshot table");
  }
});

test("an a11y-only checkbox names why the entry has no visible change", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    changed: [a11yEntry(a11yShot())],
  });
  const checkboxLine = body
    .split("\n")
    .find((l) => l.includes("tuffgal-approve-item:visit-home"));
  assert.match(checkboxLine, /Approve \*\*Home hero\*\* — a11y only$/);
});

test("the a11y-only suffix stays invisible to resolve-approver's marker regex", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    changed: [a11yEntry(a11yShot())],
  });
  const tickedBody = body.replace(
    "- [ ] <!-- tuffgal-approve-item:visit-home -->",
    "- [x] <!-- tuffgal-approve-item:visit-home -->"
  );
  const verdict = resolveApprover({
    eventName: "issue_comment",
    action: "edited",
    comment: { body: tickedBody, user: { login: "maintainer" } },
    issue: { pull_request: {} },
    contextActor: "maintainer",
  });
  assert.strictEqual(verdict.proceed, true);
  assert.deepStrictEqual(verdict.selection, ["visit-home"]);
});

test("an a11y-only story links the report when a preview is present", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    previewUrl: "https://pages.example/pr-1",
    changed: [a11yEntry(a11yShot())],
  });
  assert.match(
    body,
    /\[Open Home hero in report →\]\(https:\/\/pages\.example\/pr-1\/report\/index\.html#story-0\)/
  );
});

test("an a11y-only story with no recorded diff degrades to prose with its counts", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    changed: [
      a11yEntry(
        a11yShot({ a11yDiff: { lines: [], added: 2100, removed: 2100, truncated: true } })
      ),
    ],
  });
  assert.match(body, /_No line diff available \(2100 added, 2100 removed\) — open the report/);
  assert.ok(!body.includes("```diff"), "no empty diff block");
});

test("an a11y-only story from a tuffgal with no a11yDiff field still explains itself", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    changed: [a11yEntry(a11yShot({ a11yDiff: null }))],
  });
  assert.match(body, /Pixels unchanged\. The accessibility snapshot drifted\./);
  assert.match(body, /_No line diff available — open the report/);
});

test("a long a11y diff is clipped in the comment and says so with the full counts", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `+  - link "${i}"`);
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    changed: [
      a11yEntry(
        a11yShot({ a11yDiff: { lines, added: 30, removed: 0, truncated: false } })
      ),
    ],
  });
  assert.ok(body.includes('+  - link "19"'), "keeps the first 20 lines");
  assert.ok(!body.includes('+  - link "20"'), "drops the rest");
  assert.match(body, /_Diff clipped — 30 added, 0 removed in full\._/);
});

test("the diff fence grows past a backtick run inside a snapshot line", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    changed: [
      a11yEntry(
        a11yShot({
          a11yDiff: {
            lines: ['+  - code "```"'],
            added: 1,
            removed: 0,
            truncated: false,
          },
        })
      ),
    ],
  });
  assert.match(body, /````diff\n\+  - code "```"\n````/);
});

test("a multi-breakpoint story mixes a thumbnail row with an a11y diff section", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    previewUrl: "https://pages.example/pr-1",
    multiBreakpoint: true,
    changed: [
      {
        index: 0,
        name: "Home hero",
        actionKeys: ["visit-home"],
        shots: [
          {
            breakpoint: "mobile",
            baseline: "https://pages.example/pr-1/baselines/visit-home/mobile.png",
            actual: "https://pages.example/pr-1/report/actual/visit-home/mobile.png",
            a11yOnly: false,
            a11yDiff: null,
          },
          {
            breakpoint: "desktop",
            baseline: null,
            actual: null,
            a11yOnly: true,
            a11yDiff: {
              lines: ['-  - link "Home"', '+  - link "Home page"'],
              added: 1,
              removed: 1,
              truncated: false,
            },
          },
        ],
      },
    ],
  });
  assert.match(body, /\| mobile \| <img src="https:\/\/pages\.example\/pr-1\/baselines/);
  assert.ok(
    !/\| desktop \|/.test(body),
    "the a11y-only breakpoint gets no thumbnail row"
  );
  assert.match(
    body,
    /\*\*desktop\*\* — pixels unchanged, accessibility snapshot drifted\./
  );
  assert.match(body, /```diff\n-  - link "Home"\n\+  - link "Home page"\n```/);
  // The entry still drifted in pixels somewhere, so it is not labelled a11y-only.
  const checkboxLine = body
    .split("\n")
    .find((l) => l.includes("tuffgal-approve-item:visit-home"));
  assert.ok(!checkboxLine.includes("a11y only"));
});

test("a pixel-drifted changed story is unaffected by the a11y-only branch", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    previewUrl: "https://pages.example/pr-1",
    changed: [
      {
        index: 0,
        name: "Home hero",
        actionKeys: ["visit-home"],
        shots: [
          {
            breakpoint: undefined,
            baseline: "https://pages.example/pr-1/baselines/visit-home/0.png",
            actual: "https://pages.example/pr-1/report/actual/visit-home/0.png",
            a11yOnly: false,
            a11yDiff: null,
          },
        ],
      },
    ],
  });
  assert.match(body, /\| Baseline \| Actual \|/);
  assert.ok(!body.includes("```diff"));
  assert.ok(!body.includes("a11y only"));
});

test("a diff line carrying a newline cannot break out of its fenced block", () => {
  // tuffgal's payload is one entry per line, but the comment is markdown: a line
  // smuggling its own newline plus a fence would otherwise close the block early
  // and let raw HTML through. The fence grows past the longest backtick RUN,
  // which is measured across the whole entry, newline included.
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, changed: "1", total: "4" },
    changed: [
      a11yEntry(
        a11yShot({
          a11yDiff: {
            lines: ['+  - text "a\n```\n<img src=x onerror=alert(1)>"'],
            added: 1,
            removed: 0,
            truncated: false,
          },
        })
      ),
    ],
  });
  const fence = "`".repeat(4);
  assert.ok(body.includes(`${fence}diff`), "the fence grew past the embedded run");
  // Everything between the opening and closing fence is inert; nothing after the
  // embedded newline escapes into the surrounding markdown.
  const opened = body.split(`${fence}diff\n`)[1];
  const inside = opened.split(`\n${fence}`)[0];
  assert.ok(inside.includes("<img src=x onerror=alert(1)>"), "payload stays inside the fence");
  // The embedded 3-backtick run sits INSIDE the block: the block's own closing
  // fence is the 4-backtick one after the payload, not the smuggled one.
  assert.ok(inside.includes("```"), "the smuggled fence is inert content");
  assert.strictEqual(
    body.indexOf(`\n${fence}\n`) > body.indexOf("<img src=x"),
    true,
    "the block closes after the payload, not before it"
  );
});
