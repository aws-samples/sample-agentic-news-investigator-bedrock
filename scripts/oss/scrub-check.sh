#!/usr/bin/env bash
# SPDX-License-Identifier: MIT-0
# Fails when tracked text still carries operator specifics that must not reach
# the public repository: environment-specific names and identifiers, macOS
# service-manager and log paths, local absolute paths.
#
#   scripts/oss/scrub-check.sh [dir]     # dir defaults to the repository root
#
# Exits 1 on any hit outside the allowed locations (ops/ templates, which are
# operator-facing by design, and docs/OPERATIONS.md, which documents them).
# The dashboard's supervisor/log probes may name launchctl and ~/Library/Logs as
# the documented darwin DEFAULTS behind V2_SUPERVISOR / V2_WORKER_LOG_PATTERN.
set -uo pipefail

main() {
  local target pattern hits
  target="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
  target="$(cd "$target" && pwd)"
  local includes=(
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.rs'
    --include='*.sh' --include='*.json' --include='*.toml' --include='*.yml' --include='*.yaml'
    --include='*.md' --include='*.html' --include='*.css' --include='*.svg' --include='*.txt'
    --include='*.example' --include='Dockerfile' --include='*.service' --include='*.plist*'
  )

  # Generic checks only. Terms specific to the maintainer's environment are never
  # kept in this file: they come from SCRUB_EXTRA_PATTERN (case-insensitive) and
  # SCRUB_EXTRA_PATTERN_CS (case-sensitive) extended regexes, or from
  # scripts/oss/private-scrub.pattern and private-scrub-cs.pattern when those
  # private files exist (they are never exported). `homebrew` is case-sensitive
  # because HOMEBREW_PREFIX is a documented, portable fallback.
  local here
  here="$(cd "$(dirname "$0")" && pwd)"
  load_private() { [ -f "$here/$1" ] && grep -v '^#' "$here/$1" | tr -d '\n'; }
  : "${SCRUB_EXTRA_PATTERN:=$(load_private private-scrub.pattern)}"
  : "${SCRUB_EXTRA_PATTERN_CS:=$(load_private private-scrub-cs.pattern)}"
  pattern='amazon\.com|launchctl|Library/Logs|/Users/'
  if [ -n "${SCRUB_EXTRA_PATTERN:-}" ]; then pattern="$pattern|$SCRUB_EXTRA_PATTERN"; fi
  local pattern_cs='homebrew'
  if [ -n "${SCRUB_EXTRA_PATTERN_CS:-}" ]; then pattern_cs="$pattern_cs|$SCRUB_EXTRA_PATTERN_CS"; fi

  # Paths are made relative to the target before filtering so that the
  # checkout's own location (which may itself contain excluded names) cannot
  # mask hits.
  hits="$(
    {
      grep -rnEi "$pattern" "${includes[@]}" "$target" 2>/dev/null
      grep -rnE "$pattern_cs" "${includes[@]}" "$target" 2>/dev/null
    } \
      | sed "s#^$target/##" \
      | grep -vE '^([^:]*/)?(node_modules|dist|target|cdk\.out)/' \
      | grep -vE '^\.claude/' \
      | grep -vE '^scripts/oss/(scrub-check|export)\.sh:' \
      | grep -vE '^(ops/|docs/OPERATIONS\.md:)'\
      | grep -vE '^v2/(src/dashboard(-data)?\.ts|test/dashboard\.test\.ts):[0-9]+:.*(launchctl|Library/Logs)' \
      | grep -vE '^(SECURITY|CONTRIBUTING|CODE_OF_CONDUCT)\.md:[0-9]+:.*(aws\.amazon\.com|aws-security@amazon\.com|opensource-codeofconduct@amazon\.com)'
  )"

  if [ -n "$hits" ]; then
    echo "scrub-check: operator-specific text found:" >&2
    printf '%s\n' "$hits" >&2
    echo "scrub-check: $(printf '%s\n' "$hits" | wc -l | tr -d ' ') hit(s)" >&2
    return 1
  fi
  echo "scrub-check: clean ($target)"
}

main "$@"
