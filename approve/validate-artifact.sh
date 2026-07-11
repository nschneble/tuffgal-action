#!/usr/bin/env bash
#
# Validate a tuffgal-candidates artifact zip BEFORE extraction. Fails closed:
# every entry must be a relative path with no traversal and an allowed
# extension. Any violation aborts with a non-zero exit and a per-entry reason.
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
# Process substitution keeps the loop in THIS shell (not a pipe subshell), so
# `bad` survives and actually gates the exit.
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  case "$entry" in
    */) continue ;;                       # directory entry, structural
  esac
  case "$entry" in
    /*)   echo "Rejected absolute path in artifact: $entry" >&2; bad=1 ;;
    *..*) echo "Rejected path traversal in artifact: $entry" >&2; bad=1 ;;
    *\\*) echo "Rejected backslash in artifact path: $entry" >&2; bad=1 ;;
  esac
  case "$entry" in
    *.png|*.yaml|*.yml|*.json) : ;;
    *) echo "Rejected disallowed file type in artifact: $entry" >&2; bad=1 ;;
  esac
done < <(zipinfo -1 "$zip")

if [ "$bad" -ne 0 ]; then
  echo "Artifact failed validation; aborting." >&2
  exit 1
fi

echo "Artifact validated: all entries are baselines-safe."
