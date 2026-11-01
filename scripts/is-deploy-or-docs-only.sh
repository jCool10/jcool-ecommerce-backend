#!/usr/bin/env bash
# Usage: scripts/is-deploy-or-docs-only.sh <base> <head>
# Exits 0 only when base..head changes at least one file and every changed path is under deploy/ or
# ends in .md. Every other outcome, including an empty diff or a git error, exits 1, so a caller that
# skips work on 0 can only err towards doing the work.
set -uo pipefail

[ $# -eq 2 ] || exit 1

# --no-renames: a move reports both paths, so code moved under deploy/ still counts as removed code.
changed=$(git diff --name-only --no-renames -z "$1" "$2" 2>/dev/null | tr '\0' '\n') || exit 1
[ -n "$changed" ] || exit 1

while IFS= read -r path; do
  case "$path" in
    deploy/* | *.md) ;;
    *) exit 1 ;;
  esac
done <<<"$changed"
exit 0
