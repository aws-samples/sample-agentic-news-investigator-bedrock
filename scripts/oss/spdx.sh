#!/usr/bin/env bash
# SPDX-License-Identifier: MIT-0
# Adds an SPDX licence identifier as the first line of every source file that
# lacks one (after the shebang when there is one). Idempotent: files already
# carrying an SPDX line anywhere in their first three lines are left alone.
#
#   scripts/oss/spdx.sh            # apply
#   scripts/oss/spdx.sh --check    # list files missing a header, exit 1 if any
#
# Covered trees: v2/src, v2/test, infra/lib, infra/bin, crates, lambdas, scripts.
# v2/dashboard (static page, no build step) and generated trees (node_modules,
# target, dist, cdk.out) are deliberately excluded.
#
# The body lives in main() so bash parses the whole file before running it:
# this script is itself under scripts/ and rewrites its own first lines.
set -euo pipefail

TREES=(v2/src v2/test infra/lib infra/bin crates lambdas scripts)

comment_prefix() {
  case "$1" in
    *.ts|*.js|*.mjs|*.cjs|*.rs) echo "//" ;;
    *.sh|*.py|*.toml|*.yml|*.yaml) echo "#" ;;
    *) echo "" ;;
  esac
}

has_header() {
  head -n 3 "$1" | grep -q 'SPDX-License-Identifier'
}

list_files() {
  local root="$1" t
  for t in "${TREES[@]}"; do
    [ -d "$root/$t" ] || continue
    find "$root/$t" -type f \
      \( -name '*.ts' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.rs' \
         -o -name '*.sh' -o -name '*.py' -o -name '*.toml' -o -name '*.yml' -o -name '*.yaml' \) \
      -not -path '*/node_modules/*' -not -path '*/target/*' -not -path '*/dist/*' \
      -not -path '*/cdk.out/*' -not -path '*/v2/dashboard/*' -print0
  done | sort -z
}

main() {
  local root license_id mode missing=0 changed=0 f prefix header tmp
  root="$(cd "$(dirname "$0")/../.." && pwd)"
  license_id="${SPDX_LICENSE:-MIT-0}"
  mode="${1:-apply}"

  while IFS= read -r -d '' f; do
    prefix="$(comment_prefix "$f")"
    [ -n "$prefix" ] || continue
    if has_header "$f"; then continue; fi
    if [ "$mode" = "--check" ]; then
      echo "missing SPDX header: ${f#"$root"/}"
      missing=$((missing + 1))
      continue
    fi
    header="$prefix SPDX-License-Identifier: $license_id"
    tmp="$(mktemp)"
    if [ "$(head -c 2 "$f")" = "#!" ]; then
      { head -n 1 "$f"; echo "$header"; tail -n +2 "$f"; } > "$tmp"
    else
      { echo "$header"; cat "$f"; } > "$tmp"
    fi
    # Redirecting into the existing file keeps its mode (executable bits on scripts).
    cat "$tmp" > "$f"
    rm -f "$tmp"
    changed=$((changed + 1))
    echo "added SPDX header: ${f#"$root"/}"
  done < <(list_files "$root")

  if [ "$mode" = "--check" ]; then
    [ "$missing" -eq 0 ] && echo "all covered files carry an SPDX header"
    return $(( missing > 0 ))
  fi
  echo "spdx: $changed file(s) updated"
}

main "$@"
