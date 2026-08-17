"use strict";
//
// The results.json -> sticky-comment adapter. Turns a parsed `RunResult` (tuffgal's
// machine contract, documented in that repo's docs/reporting.md) into the
// `changed` / `added` / `deleted` / `failed` entry arrays `buildCommentBody`
// renders, resolving every image path to its Pages-preview URL on the way.
//
// The bucket assignment, the a11y-only discriminator, the action-key allowlist,
// and the preview-root containment check are covered by a `node --test` suite;
// the API side (reading the file, posting the comment) stays inline in
// action.yml.

const path = require("node:path");

const { ACTION_NAME_PATTERN } = require("./build-comment.js");

// Distinct, non-empty breakpoint names this run captured at, across every story
// action AND every deleted-baseline record. More than one -> multi-breakpoint
// mode (per-breakpoint detail rows + labels). A run with a single breakpoint, or
// a legacy artifact whose actions carry no `breakpoint`, stays single-breakpoint.
function isMultiBreakpoint(result) {
  const names = new Set();
  for (const story of result.stories || []) {
    for (const action of story.actions || []) {
      if (action && action.breakpoint) names.add(action.breakpoint);
    }
  }
  for (const entry of result.deleted || []) {
    if (entry && typeof entry === "object" && entry.breakpoint) {
      names.add(entry.breakpoint);
    }
  }
  return names.size > 1;
}

// Map an absolute results.json image path to its preview URL. The preview stages
// report-path under `pr-<n>/report` and baselines-path under `pr-<n>/baselines`,
// so relativize against whichever root the path lives under. Returns null for a
// path under NEITHER — a sibling directory whose name merely starts with a root's
// name (`/w/tuffgal/report-old` vs `/w/tuffgal/report`) is not under it, hence
// the separator in the containment test.
function previewUrlFor({ previewUrl, reportAbs, baselinesAbs }, abs) {
  if (!previewUrl || !abs) return null;
  const resolved = path.resolve(abs);
  const under = (root) =>
    resolved === root || resolved.startsWith(root + path.sep);
  if (under(reportAbs)) {
    return `${previewUrl}/report/${path
      .relative(reportAbs, resolved)
      .split(path.sep)
      .join("/")}`;
  }
  if (under(baselinesAbs)) {
    return `${previewUrl}/baselines/${path
      .relative(baselinesAbs, resolved)
      .split(path.sep)
      .join("/")}`;
  }
  return null;
}

// A story's candidate-tree action keys at one status, deduped. `tuffgal approve`
// selects by these `.action` directory keys, so a per-item checkbox must carry
// every matching one — not just the representative shot rendered in the preview.
// The same action runs once PER breakpoint, so a multi-breakpoint story yields the
// same key N times; the marker carries each distinct key once.
//
// Allowlist-filtered on this WRITE side too (defense in depth, symmetric with the
// read side in resolve-approver.js and the delete side in filter-candidates.js),
// so a malformed action key never reaches a rendered approve marker.
function keysAt(actions, want) {
  return [
    ...new Set(
      actions
        .filter((action) => action.status === want)
        .map((action) => action.action)
        .filter((key) => typeof key === "string" && ACTION_NAME_PATTERN.test(key))
    ),
  ];
}

// One shot per action that drifted at the given status, each tagged with its
// breakpoint so the multi-breakpoint renderer shows one detail row per
// breakpoint. Changed shots carry baseline + actual; new shots carry actual only
// (no prior baseline exists yet).
//
// A changed shot also carries whether it drifted in the accessibility tree ALONE
// (pixels matched), plus that run's rendered `a11yDiff`, so the comment can show
// the diff instead of two identical thumbnails. The a11y-only test is the
// POSITIVE `a11yChanged === true` + no `diffPath` pair from the tuffgal schema: a
// size-mismatch row also lacks a diffPath but never sets `a11yChanged`, so the two
// never collide. `a11yDiff` is absent on results from a tuffgal predating the
// field; the builder then names the drift without the lines.
function shotsAt(actions, want, withBaseline, urls) {
  return actions
    .filter((action) => action.status === want)
    .map((action) =>
      withBaseline
        ? {
            breakpoint: action.breakpoint,
            baseline: previewUrlFor(urls, action.baselinePath),
            actual: previewUrlFor(urls, action.actualPath),
            a11yOnly: action.a11yChanged === true && !action.diffPath,
            a11yDiff: action.a11yDiff || null,
          }
        : {
            breakpoint: action.breakpoint,
            actual: previewUrlFor(urls, action.actualPath),
          }
    );
}

// Deleted baselines are recorded one entry PER breakpoint per action, so group by
// display name: a story dropped at N breakpoints is listed once carrying all N,
// never N duplicate rows.
function deletedEntries(result) {
  const index = new Map();
  const out = [];
  for (const entry of result.deleted || []) {
    const name =
      typeof entry === "string"
        ? entry
        : entry.action || entry.story || entry.path || JSON.stringify(entry);
    const breakpoint =
      entry && typeof entry === "object" ? entry.breakpoint : undefined;
    let group = index.get(name);
    if (!group) {
      group = { name, breakpoints: [] };
      index.set(name, group);
      out.push(group);
    }
    if (breakpoint && !group.breakpoints.includes(breakpoint)) {
      group.breakpoints.push(breakpoint);
    }
  }
  return out;
}

// Build the comment's entry arrays from a parsed results.json. `index` is the
// story's position in the stories array — the ordinal tuffgal's report renders as
// `id="story-<index>"`, so `#story-<index>` lands on the right story.
//
// BUCKETING. A hard failure takes the whole story and carries no approve keys. A
// story that BOTH wrote a fresh baseline and drifted an existing one is listed in
// both sections, each with only its own status's shots and keys — one bucket would
// silently drop the other's keys, leaving those candidates unapprovable.
function buildStories({ result, previewUrl, reportAbs, baselinesAbs }) {
  const urls = { previewUrl, reportAbs, baselinesAbs };
  const changed = [];
  const added = [];
  const failed = [];

  (result.stories || []).forEach((story, index) => {
    const actions = story.actions || [];
    const name = String(story.story || story.file || `story ${index}`).replace(
      /[\r\n]+/g,
      " "
    );

    if (story.status === "failed") {
      const action = actions.find((entry) => entry.status === "failed") || {};
      failed.push({
        index,
        name,
        message: action.failureMessage || "",
        breakpoint: action.breakpoint,
      });
      return;
    }
    // The story's own rollup status counts alongside its actions', so a legacy
    // artifact whose actions carry no per-action status still renders.
    const at = (want) =>
      story.status === want || actions.some((action) => action.status === want);
    const newKeys = keysAt(actions, "new");
    const changedKeys = keysAt(actions, "changed");
    if (at("new")) {
      added.push({
        index,
        name,
        shots: shotsAt(actions, "new", false, urls),
        actionKeys: newKeys,
      });
    }
    if (at("changed")) {
      changed.push({
        index,
        name,
        shots: shotsAt(actions, "changed", true, urls),
        actionKeys: changedKeys,
      });
    }
  });

  return {
    changed,
    added,
    deleted: deletedEntries(result),
    failed,
    multiBreakpoint: isMultiBreakpoint(result),
    mismatchKeys: (result.environment && result.environment.mismatchKeys) || [],
  };
}

module.exports = { buildStories, previewUrlFor, isMultiBreakpoint };
