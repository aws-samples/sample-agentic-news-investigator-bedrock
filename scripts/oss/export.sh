#!/usr/bin/env bash
# SPDX-License-Identifier: MIT-0
# Builds the public export of this repository into a clean directory.
#
#   scripts/oss/export.sh <target-dir> [ref] [--strict]
#
# Takes `git archive` of <ref> (default HEAD) — committed files only, so nothing
# in the working tree leaks — then removes what stays private (operator history,
# backlog, letters, the one-pager, agent instructions, scratch corpora,
# evaluation output, leaderboard results and any paths listed in the private
# repository's scripts/oss/private-paths) and moves the
# post-mortem under docs/postmortems/. Prints a
# summary and runs scripts/oss/scrub-check.sh over the result; with --strict any
# scrub hit fails the export. Nothing is pushed anywhere: the target directory is
# for review and for the single public commit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="${1:?usage: export.sh <target-dir> [ref] [--strict]}"
REF="HEAD"
STRICT=0
shift
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    *) REF="$arg" ;;
  esac
done

mkdir -p "$TARGET"
if [ -n "$(ls -A "$TARGET")" ]; then
  echo "export: target directory is not empty: $TARGET" >&2
  exit 1
fi
TARGET="$(cd "$TARGET" && pwd)"

git -C "$ROOT" archive --format=tar "$REF" | tar -x -C "$TARGET"
total_before="$(find "$TARGET" -type f | wc -l | tr -d ' ')"

removed=()
remove() {
  local p
  for p in "$@"; do
    if [ -e "$TARGET/$p" ]; then
      rm -rf "${TARGET:?}/${p:?}"
      removed+=("$p")
    fi
  done
}

# Private history and operator material.
remove docs/project-history.md docs/backlog.md docs/open-source-plan.md CLAUDE.md
for f in "$TARGET"/docs/one-pager.*; do
  [ -e "$f" ] && remove "docs/$(basename "$f")"
done

# Letters: keep the directory marker only.
for f in "$TARGET"/v2/reports/*; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in
    .gitkeep) ;;
    *) remove "v2/reports/$(basename "$f")" ;;
  esac
done

# Images: only files the docs package marked public ship.
if [ -d "$TARGET/docs/images" ]; then
  while IFS= read -r -d '' f; do
    remove "docs/images/$(basename "$f")"
  done < <(find "$TARGET/docs/images" -type f -not -name '*-public*' -print0)
fi

# Scratch trees and private review tracking that must never be public.
remove eval .claude .data-review

# Generated per-deployment results (the README's leaderboard block ships empty).
remove leaderboard

# Maintainer-specific material: paths listed one per line in scripts/oss/private-paths
# and extra scrub terms in scripts/oss/private-scrub.pattern (an extended regex, passed
# to scrub-check.sh as SCRUB_EXTRA_PATTERN). Both files live only in the private
# repository; neither is ever exported.
if [ -f "$ROOT/scripts/oss/private-paths" ]; then
  while IFS= read -r p; do
    case "$p" in '' | '#'*) ;; *) remove "$p" ;; esac
  done < "$ROOT/scripts/oss/private-paths"
fi
if [ -f "$ROOT/scripts/oss/private-scrub.pattern" ] && [ -z "${SCRUB_EXTRA_PATTERN:-}" ]; then
  SCRUB_EXTRA_PATTERN="$(grep -v '^#' "$ROOT/scripts/oss/private-scrub.pattern" | tr -d '\n')"
  export SCRUB_EXTRA_PATTERN
fi
remove scripts/oss/private-paths scripts/oss/private-scrub.pattern
find "$TARGET" -name '.DS_Store' -type f -delete

# The post-mortem stays, filed where a reader expects it.
moved=""
if [ -f "$TARGET/docs/2026-08-28-digest-equity-bug.md" ]; then
  mkdir -p "$TARGET/docs/postmortems"
  mv "$TARGET/docs/2026-08-28-digest-equity-bug.md" "$TARGET/docs/postmortems/2026-08-28-digest-equity-bug.md"
  moved="docs/2026-08-28-digest-equity-bug.md -> docs/postmortems/2026-08-28-digest-equity-bug.md"
fi

total_after="$(find "$TARGET" -type f | wc -l | tr -d ' ')"

echo "export: $REF -> $TARGET"
echo "export: $total_before files archived, $total_after kept, ${#removed[@]} removed"
for p in "${removed[@]}"; do echo "  - $p"; done
[ -n "$moved" ] && echo "  ~ $moved"

check="$ROOT/scripts/oss/scrub-check.sh"
if [ -x "$check" ]; then
  if "$check" "$TARGET"; then
    :
  elif [ "$STRICT" -eq 1 ]; then
    echo "export: scrub check failed (strict)" >&2
    exit 1
  else
    echo "export: scrub check reported hits; re-run with --strict to fail on them" >&2
  fi
fi
echo "export: done (nothing was pushed)"
