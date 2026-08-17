"use strict";
//
// The Changed section — the comment's most branched render, which is why it is
// its own module. Three things vary independently: whether a preview published
// (thumbnails need a host, a fenced a11y diff does not), whether the run spans
// several breakpoints, and whether a story drifted in pixels, in its
// accessibility tree, or in both.

const { escapeHtml, thumbnail } = require("./comment-markup.js");
const { isA11yOnlyEntry, renderA11yDiff } = require("./comment-a11y.js");
const { approveItemCheckbox } = require("./comment-approve.js");

const breakpointName = (shot) =>
  escapeHtml(shot.breakpoint == null ? "" : shot.breakpoint);

// One labelled a11y diff, used for a mixed entry's drifted breakpoints.
function a11yBreakpointBlock(shot) {
  return [
    "",
    `**${breakpointName(shot)}** — pixels unchanged, accessibility snapshot drifted.`,
    "",
    ...renderA11yDiff(shot.a11yDiff),
  ];
}

// An entry whose every drifted shot is a11y-only: its baseline and actual PNGs
// match, so the diff IS the content.
function a11yOnlyBody(entry, multiBreakpoint) {
  const lines = ["Pixels unchanged. The accessibility snapshot drifted.", ""];
  for (const shot of entry.shots) {
    if (multiBreakpoint && shot.breakpoint) {
      lines.push(`**${escapeHtml(shot.breakpoint)}**`);
      lines.push("");
    }
    lines.push(...renderA11yDiff(shot.a11yDiff));
    lines.push("");
  }
  return lines;
}

// The pixel half of a multi-breakpoint entry: one thumbnail row per drifted
// breakpoint. A breakpoint that drifted in the accessibility tree ALONE has no
// row worth showing (its two PNGs match) and renders as a diff below instead.
// With no preview there is nothing to link, so the drifted breakpoints are named
// in prose rather than left implicit.
function pixelRows(entry, pixelShots, previewUrl) {
  if (!previewUrl) {
    return [
      `Pixels drifted at ${pixelShots
        .map(breakpointName)
        .join(", ")} — see the report artifact.`,
    ];
  }
  return [
    "| Breakpoint | Baseline | Actual |",
    "|---|---|---|",
    ...pixelShots.map(
      (shot) =>
        `| ${breakpointName(shot)} | ${thumbnail(
          shot.baseline,
          `baseline for ${entry.name}`
        )} | ${thumbnail(shot.actual, `actual for ${entry.name}`)} |`
    ),
  ];
}

// The single-breakpoint two-column table.
function singleShotTable(entry) {
  const shot = (entry.shots && entry.shots[0]) || {};
  return [
    "| Baseline | Actual |",
    "|---|---|",
    `| ${thumbnail(shot.baseline, `baseline for ${entry.name}`)} | ${thumbnail(
      shot.actual,
      `actual for ${entry.name}`
    )} |`,
  ];
}

// Each story is a collapsible carrying inline baseline / actual thumbnails plus
// a deep-link that opens the report scrolled to that story with its screenshots
// (including the full diff) expanded. The alt text threads the story name so a
// screen-reader user gets per-image context in a multi-story comment.
function renderChangedSection(changed, { previewUrl, multiBreakpoint, storyLink }) {
  const lines = [];
  if (!changed.length) return lines;

  lines.push(`### Changed (${changed.length})`);
  lines.push("");
  for (const entry of changed) {
    lines.push(approveItemCheckbox(entry, multiBreakpoint));

    const a11yShots = (entry.shots || []).filter((shot) => shot && shot.a11yOnly);
    // Thumbnails need a preview to point at; a fenced a11y diff needs nothing
    // hosted. So an entry carrying ANY a11y-only shot opens its collapsible
    // either way — otherwise a preview-less run would render an approve box for
    // a drift with no way to see what moved.
    if (!previewUrl && !a11yShots.length) continue;

    lines.push("<details>");
    lines.push(`<summary>${escapeHtml(entry.name)}</summary>`);
    lines.push("");
    if (isA11yOnlyEntry(entry)) {
      lines.push(...a11yOnlyBody(entry, multiBreakpoint));
    } else {
      if (multiBreakpoint) {
        const pixelShots = (entry.shots || []).filter((shot) => !shot.a11yOnly);
        lines.push(...pixelRows(entry, pixelShots, previewUrl));
      } else if (previewUrl) {
        lines.push(...singleShotTable(entry));
      }
      // A mixed entry shows its a11y drifts under whichever pixel rendering ran.
      for (const shot of a11yShots) lines.push(...a11yBreakpointBlock(shot));
      lines.push("");
    }
    if (previewUrl) {
      lines.push(`[Open ${escapeHtml(entry.name)} in report →](${storyLink(entry)})`);
    }
    lines.push("</details>");
    lines.push("");
  }
  lines.push("");
  return lines;
}

module.exports = { renderChangedSection };
