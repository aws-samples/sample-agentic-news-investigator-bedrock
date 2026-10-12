#!/usr/bin/env bash
# SPDX-License-Identifier: MIT-0
# Halt / resume an arm through its SSM kill switch.
#
#   ./scripts/kill-switch.sh on|off|status                 # the pipeline arm (v1)
#   ./scripts/kill-switch.sh --arm v2 on|off|status        # an agent arm
#
# The parameter name follows the registry rule in v2/src/arms.ts (armResources):
#   pipeline arm : /<prefix>/kill-switch
#   agent arm    : /<prefix>/<key>/kill-switch
# <prefix> and the arm's kind are read from arms.json (node); without node the
# prefix defaults to "fin" and --arm is assumed to name an agent arm.
# V2_KILL_SWITCH_PARAM overrides the derived name; AWS_REGION defaults to us-east-1.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ARMS_FILE="${V2_ARMS_FILE:-$HERE/../arms.json}"
REGION="${AWS_REGION:-us-east-1}"
ARM=""
ACTION="status"

while [ $# -gt 0 ]; do
  case "$1" in
    --arm) ARM="${2:?--arm needs a key}"; shift 2 ;;
    on|off|status) ACTION="$1"; shift ;;
    -h|--help) echo "usage: $0 [--arm <key>] on|off|status" >&2; exit 0 ;;
    *) echo "usage: $0 [--arm <key>] on|off|status" >&2; exit 1 ;;
  esac
done

PREFIX="fin"
KIND="agent"
[ -z "$ARM" ] && KIND="pipeline"
if command -v node >/dev/null 2>&1 && [ -f "$ARMS_FILE" ]; then
  # Same rule as v2/src/arms.ts armResources; keep the two in step.
  # shellcheck disable=SC2016 # single-quoted on purpose: the ${...} are JS template literals.
  RESOLVED="$(node -e '
    const fs = require("fs");
    const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const key = process.argv[2];
    const arm = key ? reg.arms.find((a) => a.key === key) : reg.arms.find((a) => a.kind === "pipeline");
    if (key && !arm) { console.error(`unknown arm "${key}" (arms.json has: ${reg.arms.map((a) => a.key).join(", ")})`); process.exit(3); }
    console.log(`${reg.prefix} ${arm ? arm.kind : "pipeline"}`);
  ' "$ARMS_FILE" "$ARM")"
  PREFIX="${RESOLVED% *}"
  KIND="${RESOLVED#* }"
fi

if [ "$KIND" = "pipeline" ]; then
  PARAM="${V2_KILL_SWITCH_PARAM:-/$PREFIX/kill-switch}"
  LABEL="${ARM:-pipeline}"
else
  PARAM="${V2_KILL_SWITCH_PARAM:-/$PREFIX/$ARM/kill-switch}"
  LABEL="$ARM"
fi

case "$ACTION" in
  on)  aws ssm put-parameter --region "$REGION" --name "$PARAM" --value "true"  --overwrite >/dev/null; echo "$LABEL kill switch ON — trading halted ($PARAM)" ;;
  off) aws ssm put-parameter --region "$REGION" --name "$PARAM" --value "false" --overwrite >/dev/null; echo "$LABEL kill switch OFF — trading enabled ($PARAM)" ;;
  status) aws ssm get-parameter --region "$REGION" --name "$PARAM" --query 'Parameter.Value' --output text ;;
esac
