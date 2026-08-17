"use strict";
//
// Markdown/HTML fragments the sticky comment is assembled from: the escapes, the
// inline thumbnail, and the one-line failure message. Nothing here knows about
// stories or sections — build-comment.js composes them.

// Escape text for HTML flow content (story names in a <summary>).
const escapeHtml = (text) =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// Escape text for an HTML attribute value (the <img> src URL and alt text).
// Extends the flow escape with `"` so a value carrying a double quote — a
// crafted story name in the alt, or a stray quote in an image path in the src —
// can't break out of the attribute. Cosmetic markdown-injection hardening.
const escapeAttribute = (text) => escapeHtml(text).replace(/"/g, "&quot;");

// The character budget for a rendered failure message in the Failed section.
// Long harness/Playwright errors get clipped to keep the comment scannable; the
// full message stays in the linked report and the `tuffgal-report` artifact.
const MAX_FAILURE_MESSAGE = 140;

// Normalize a story's failure message for one-line rendering: collapse every
// whitespace run (newlines, tabs, indentation) to a single space, trim, clip to
// the budget with an ellipsis marker, then HTML-escape. Escaping happens LAST so
// the clip can never split a `&lt;`-style entity mid-sequence.
const failureMessage = (message) => {
  const oneLine = String(message == null ? "" : message)
    .replace(/\s+/g, " ")
    .trim();
  const clipped =
    oneLine.length > MAX_FAILURE_MESSAGE
      ? oneLine.slice(0, MAX_FAILURE_MESSAGE).trimEnd() + "…"
      : oneLine;
  return escapeHtml(clipped);
};

// One inline thumbnail, or an italic placeholder when its preview URL is null
// (preview off, or the image lives under neither report nor baselines root).
const thumbnail = (url, label) =>
  url
    ? `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(
        label
      )}" width="260">`
    : `<em>${escapeHtml(label)} unavailable</em>`;

module.exports = {
  MAX_FAILURE_MESSAGE,
  escapeHtml,
  escapeAttribute,
  failureMessage,
  thumbnail,
};
