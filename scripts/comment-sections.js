"use strict";
//
// The New / Deleted / Failed sections. Each takes its entries plus the link and
// mode context the body already resolved, and returns its markdown lines; the
// assembly order (mirroring the totals-table rows) belongs to build-comment.js.
// The Changed section lives in comment-changed.js, which carries the branch
// matrix these three do not have.

const { escapeHtml, failureMessage, thumbnail } = require("./comment-markup.js");
const { approveItemCheckbox } = require("./comment-approve.js");

// New: no prior baseline to compare against, so the run's actual IS the proposed
// one. Without a preview there is no image to show, so the entry is its checkbox.
function renderAddedSection(added, { previewUrl, multiBreakpoint, storyLink }) {
  const lines = [];
  if (!added.length) return lines;

  lines.push(`### New (${added.length})`);
  lines.push("");
  for (const entry of added) {
    lines.push(approveItemCheckbox(entry, multiBreakpoint));
    if (!previewUrl) continue;

    lines.push("<details>");
    lines.push(`<summary>${escapeHtml(entry.name)}</summary>`);
    lines.push("");
    if (multiBreakpoint) {
      // One actual-only row per breakpoint — there is no prior baseline.
      lines.push("| Breakpoint | Actual |");
      lines.push("|---|---|");
      for (const shot of entry.shots || []) {
        lines.push(
          `| ${escapeHtml(
            shot.breakpoint == null ? "" : shot.breakpoint
          )} | ${thumbnail(shot.actual, `proposed baseline for ${entry.name}`)} |`
        );
      }
    } else {
      const shot = (entry.shots && entry.shots[0]) || {};
      lines.push(
        `Proposed new baseline: ${thumbnail(
          shot.actual,
          `proposed baseline for ${entry.name}`
        )}`
      );
    }
    lines.push("");
    lines.push(`[Open ${escapeHtml(entry.name)} in report →](${storyLink(entry)})`);
    lines.push("</details>");
    lines.push("");
  }
  lines.push("");
  return lines;
}

function renderDeletedSection(deleted, { multiBreakpoint, reportUrl }) {
  const lines = [];
  if (!deleted.length) return lines;

  lines.push(`### Deleted (${deleted.length})`);
  for (const entry of deleted) {
    let line = `- ${escapeHtml(String(entry.name).replace(/[\r\n]+/g, " "))}`;
    // The entries are grouped by story/action upstream, so a story dropped at N
    // breakpoints is listed ONCE with all of them — not N times.
    if (multiBreakpoint && entry.breakpoints && entry.breakpoints.length) {
      line += ` — ${entry.breakpoints.map(escapeHtml).join(", ")}`;
    }
    lines.push(line);
  }
  // The report renders a single `<h2 id="deleted-heading">`, not per-name
  // anchors, so this is one section-level link, never one per deleted story.
  if (reportUrl) {
    lines.push("");
    lines.push(`[View deleted baselines in report →](${reportUrl}#deleted-heading)`);
  }
  lines.push("");
  return lines;
}

// Hard failures, listed after Deleted to mirror the totals-table row order.
// Deliberately NO approve checkbox: a failure isn't an approvable baseline
// change, and the CTA gate counts only new/changed/deleted, so a failed-only run
// never offers approval.
function renderFailedSection(failed, { multiBreakpoint, storyLink }) {
  const lines = [];
  if (!failed.length) return lines;

  lines.push(`### Failed (${failed.length})`);
  lines.push("");
  for (const entry of failed) {
    const message = failureMessage(entry.message);
    const link = storyLink(entry);
    let line = `- **${escapeHtml(entry.name)}**`;
    if (multiBreakpoint && entry.breakpoint) {
      line += ` (${escapeHtml(entry.breakpoint)})`;
    }
    if (message) line += ` — ${message}`;
    if (link) line += ` [Open ${escapeHtml(entry.name)} in report →](${link})`;
    lines.push(line);
  }
  lines.push("");
  return lines;
}

module.exports = {
  renderAddedSection,
  renderDeletedSection,
  renderFailedSection,
};
