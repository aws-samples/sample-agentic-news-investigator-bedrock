#!/usr/bin/env bash
# SPDX-License-Identifier: MIT-0
# Fails when tracked text still carries operator specifics that must not reach
# the public repository: internal auth tooling, personal identifiers, the
# private account id, macOS service-manager and log paths, local absolute paths.
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

  # Matched case-insensitively ("Midway" once slipped past a case-sensitive
  # check), except the credential tool `ada` (collides with the ADA ticker) and
  # `homebrew` (HOMEBREW_PREFIX is a documented, portable fallback).
  # Terms specific to one maintainer (alias, account id, local tool names) are not
  # kept in this file: pass them as an extended regex in SCRUB_EXTRA_PATTERN.
  pattern='midway|mwinit|amazon\.com|launchctl|Library/Logs|isengard|/Users/|aws\.dev|a2z\.com|\bOSSM\b|\bPCSR\b'
  if [ -n "${SCRUB_EXTRA_PATTERN:-}" ]; then pattern="$pattern|$SCRUB_EXTRA_PATTERN"; fi
  local pattern_cs='\bada\b|homebrew'

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
