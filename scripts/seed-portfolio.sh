#!/usr/bin/env bash
# SPDX-License-Identifier: MIT-0
# Seed the PIPELINE arm's paper portfolio (the Rust chain, v1) with starting cash.
# Idempotent: the put fails if the book already exists.
#
#   ./scripts/seed-portfolio.sh [--table <name>] [--region <region>] [<cash-usd>]
#
# Default table is <prefix>-trading with <prefix> from arms.json ("fin"), the same
# rule as v2/src/arms.ts armResources for a pipeline arm. Agent arms are seeded
# with the TypeScript tool instead:  cd v2 && npm run seed -- --arm <key> --cash <usd> --apply
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ARMS_FILE="${V2_ARMS_FILE:-$HERE/../arms.json}"
REGION="${AWS_REGION:-us-east-1}"
TABLE=""
CASH="100000"

while [ $# -gt 0 ]; do
  case "$1" in
    --table) TABLE="${2:?--table needs a name}"; shift 2 ;;
    --region) REGION="${2:?--region needs a region}"; shift 2 ;;
    -h|--help) echo "usage: $0 [--table <name>] [--region <region>] [<cash-usd>]" >&2; exit 0 ;;
    --*) echo "usage: $0 [--table <name>] [--region <region>] [<cash-usd>]" >&2; exit 1 ;;
    *) CASH="$1"; shift ;;
  esac
done

if [ -z "$TABLE" ]; then
  PREFIX="fin"
  if command -v node >/dev/null 2>&1 && [ -f "$ARMS_FILE" ]; then
    PREFIX="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).prefix)' "$ARMS_FILE")"
  fi
  TABLE="$PREFIX-trading"
fi

aws dynamodb put-item \
  --region "$REGION" \
  --table-name "$TABLE" \
  --item "{
    \"pk\": {\"S\": \"PORTFOLIO\"},
    \"sk\": {\"S\": \"SNAPSHOT\"},
    \"cash\": {\"N\": \"$CASH\"},
    \"realized_pnl_today\": {\"N\": \"0\"},
    \"day_key\": {\"S\": \"$(date -u +%F)\"}
  }" \
  --condition-expression "attribute_not_exists(pk)"
echo "Seeded $TABLE with \$$CASH cash."
