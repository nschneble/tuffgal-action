"use strict";
//
// Unit tests for the pure sticky-comment body builder. No deps beyond Node's
// built-in `node:test` + `node:assert` — run with `node --test scripts/*.test.js`.
//
const { test } = require("node:test");
const assert = require("node:assert");

const {
  buildCommentBody,
  MARKER,
  renderTotalsTable,
  approveItemMarker,
} = require("./build-comment.js");

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
  deletedNames: [],
  failed: [],
  runUrl: "https://github.com/o/r/actions/runs/1",
});

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
        baseline: null,
        actual: null,
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
        baseline: "https://pages.example/pr-7/baselines/login.png",
        actual: "https://pages.example/pr-7/report/login.png",
      },
    ],
  });
  assert.match(body, /<summary>Login form<\/summary>/);
  // The table is baseline | actual only — the Diff column/cell is gone; the full
  // diff still lives in the linked report.
  assert.match(body, /\| Baseline \| Actual \|/);
  assert.doesNotMatch(body, /\| Baseline \| Actual \| Diff \|/);
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
    changed: [{ index: 0, name: "Widget", baseline: null, actual: null }],
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
        baseline: 'https://pages.example/pr-7/report/a"><script>b.png',
        actual: null,
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
        baseline: "https://pages.example/pr-7/report/x.png",
        actual: null,
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
        actual: "https://pages.example/pr-7/report/nav.png",
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
    added: [{ index: 0, name: "Nav bar", actual: null, actionKeys: ["nav"] }],
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
    deletedNames: ["Old header", "multi\nline name"],
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
    deletedNames: ['a <b> "c"'],
  });
  assert.match(body, /- a &lt;b&gt; "c"/);
});

test("the deleted section links the report's deleted heading when a preview is present", () => {
  const body = buildCommentBody({
    ...base(),
    outcome: "changed",
    counts: { ...base().counts, deleted: "1", total: "1" },
    previewUrl: "https://pages.example/pr-7",
    deletedNames: ["Old header"],
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
    deletedNames: ["Old header"],
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
    changed: [{ index: 0, name: "Home", baseline: null, actual: null }],
  });
  assert.match(body, /### Approve these changes/);
  assert.match(body, /<!-- tuffgal-approve-box -->/);
  assert.match(body, /📊 \[Open the full report\]/);
  assert.match(body, /@tuffgal approve/);
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
    changed: [{ index: 0, name: "Home", baseline: null, actual: null }],
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
      { index: 0, name: "Home", baseline: null, actual: null, actionKeys: ["home"] },
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
        baseline: null,
        actual: null,
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
      { index: 0, name: "Nav bar", actual: null, actionKeys: ["render-nav"] },
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
      {
        index: 0,
        name: "Home",
        baseline: null,
        actual: null,
        actionKeys: ["home"],
      },
      {
        index: 1,
        name: "About",
        baseline: null,
        actual: null,
        actionKeys: ["about"],
      },
    ],
    added: [
      { index: 2, name: "Contact", actual: null, actionKeys: ["contact"] },
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
      {
        index: 0,
        name: "Home",
        baseline: null,
        actual: null,
        actionKeys: ["home"],
      },
      {
        index: 1,
        name: "About",
        baseline: null,
        actual: null,
        actionKeys: ["about"],
      },
    ],
    added: [
      { index: 2, name: "Contact", actual: null, actionKeys: ["contact"] },
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
        baseline: null,
        actual: null,
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
      {
        index: 0,
        name: "Home",
        baseline: null,
        actual: null,
        actionKeys: ["home"],
      },
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
        baseline: null,
        actual: null,
        actionKeys: ["x"],
      },
    ],
  });
  assert.match(
    body,
    /- \[ \] <!-- tuffgal-approve-item:x --> Approve \*\*a &lt;b&gt; "c"\*\*/
  );
});
