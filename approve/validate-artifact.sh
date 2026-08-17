#!/usr/bin/env bash
#
# Validate a tuffgal-candidates artifact zip BEFORE extraction. Fails closed:
# every entry must be a relative, symlink-free path with no traversal and an
# allowed extension. Any violation aborts with a non-zero exit and a per-entry
# reason. Symlink entries are rejected outright — an allowed extension on a
# symlink does not make it safe, so the name-based checks alone are not enough.
#
# Usage: validate-artifact.sh <path-to-zip>
#
# The artifact is UNTRUSTED input (an attacker could publish a same-named
# artifact on a run for their PR head SHA), so this runs before any file is
# written to disk. Kept as a standalone script so it can be unit-tested against
# crafted malicious zips without a live GitHub run.
set -euo pipefail

zip="${1:?usage: validate-artifact.sh <zip>}"

bad=0

# Both passes below read a `zipinfo` LISTING that is captured here, with its exit
# status CHECKED. Reading `zipinfo` straight into a loop through process
# substitution hides its failure: an unreadable or non-zip file yields zero lines,
# both loops read nothing, `bad` stays 0, and this script announces success on an
# artifact it never inspected. `set -e` does not cover a process substitution, so
# the check has to be explicit.
listing="$(mktemp "${TMPDIR:-/tmp}/tuffgal-zip-listing.XXXXXX")"
names="$(mktemp "${TMPDIR:-/tmp}/tuffgal-zip-names.XXXXXX")"
trap 'rm -f "$listing" "$names"' EXIT

if ! zipinfo "$zip" >"$listing" 2>&1; then
  cat "$listing" >&2
  echo "Rejected unreadable artifact (not a zip, or truncated): $zip" >&2
  exit 1
fi
if ! zipinfo -1 "$zip" >"$names"; then
  echo "Rejected unreadable artifact (not a zip, or truncated): $zip" >&2
  exit 1
fi

# Pass 1 — symlink detection. Read the LONG `zipinfo` listing (no `-1`) so each
# line carries the Unix mode string in its first column. That mode's leading
# character is the file-type char (`l` symlink, `d` directory, `-` regular) — a
# raw byte, not a translated word, so it is locale-stable. `zipinfo -1` gives
# names only and would hide a symlink behind an allowed extension.
#
# awk anchors on a real mode string in $1 (type char + 9 permission chars),
# which skips the `Archive:` header and the trailing totals line, then prints
# "<type-char>\t<name>". The name is everything from the 9th field onward so
# paths containing spaces survive intact (a plain $NF would truncate them).
#
# Process substitution keeps the loop in THIS shell (not a pipe subshell), so
# `bad` survives and actually gates the exit.
while IFS=$'\t' read -r ftype entry; do
  [ -z "$entry" ] && continue
  case "$ftype" in
    l) echo "Rejected symlink entry in artifact: $entry" >&2; bad=1 ;;
  esac
done < <(awk '
  $1 ~ /^[-dlbcps][-rwxsStT]{9}$/ {
    name = $9
    for (i = 10; i <= NF; i++) name = name " " $i
    printf "%s\t%s\n", substr($1, 1, 1), name
  }
' "$listing")

# Pass 2 — name-based checks, read from `zipinfo -1` (no column parsing, so
# names with spaces stay byte-faithful). The path rules run on EVERY entry; only
# the extension rule skips directories. Skip a directory outright and a
# `../../escape/` entry never reaches an arm that would catch it.
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  case "$entry" in
    /*)   echo "Rejected absolute path in artifact: $entry" >&2; bad=1 ;;
    *..*) echo "Rejected path traversal in artifact: $entry" >&2; bad=1 ;;
    *\\*) echo "Rejected backslash in artifact path: $entry" >&2; bad=1 ;;
  esac
  case "$entry" in
    */) continue ;;                       # directory entry: no extension to check
  esac
  case "$entry" in
    *.png|*.yaml|*.yml|*.json) : ;;
    *) echo "Rejected disallowed file type in artifact: $entry" >&2; bad=1 ;;
  esac
done <"$names"

if [ "$bad" -ne 0 ]; then
  echo "Artifact failed validation; aborting." >&2
  exit 1
fi

echo "Artifact validated: all entries are baselines-safe."
