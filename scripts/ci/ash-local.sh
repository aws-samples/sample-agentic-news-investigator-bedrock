#!/usr/bin/env bash
# SPDX-License-Identifier: MIT-0
# ASH in local mode for CI runners that cannot run Docker (no privileged
# containers, so no docker:dind): installs the scanners ASH's own container image
# carries, at the versions that image pins, then runs ASH and fails if any
# scanner found something or could not run.
#
#   scripts/ci/ash-local.sh        # in a Debian-based Python image, as root
#
# Container mode (`ash --mode container`, needs Docker) remains the way to run it
# on a workstation; the policy and every suppression are in .ash/.ash.yaml.
set -euo pipefail

ASH_COMMIT=af1206aff596f1288ad066828058b3011de2a998   # v3.7.1
SYFT_VERSION=1.42.4
SYFT_SHA256=590650c2743b83f327d1bf9bec64f6f83b7fec504187bb84f500c862bf8f2a0f
GRYPE_VERSION=0.111.0
GRYPE_SHA256=18ed2048d7a233566b681121d4632364f5f25d72cca86acc4c7ac57210d78a87
OPENGREP_VERSION=1.15.1
OPENGREP_SHA256=c4f6aab1edc8130c7a46e8f5e5215763420740fb94198fc9301215135a372900
BUNDLER_VERSION=2.4.22

apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  git curl ca-certificates nodejs npm ruby ruby-dev build-essential > /dev/null
git config --global --add safe.directory "$PWD"

fetch() { # name version sha256
  local tgz="$1_$2_linux_amd64.tar.gz"
  curl -fsSL -o "/tmp/$tgz" "https://github.com/anchore/$1/releases/download/v$2/$tgz"
  echo "$3  /tmp/$tgz" | sha256sum -c --quiet -
  tar -xzf "/tmp/$tgz" -C /usr/local/bin "$1"
}
fetch syft "$SYFT_VERSION" "$SYFT_SHA256"
fetch grype "$GRYPE_VERSION" "$GRYPE_SHA256"
curl -fsSL -o /usr/local/bin/opengrep \
  "https://github.com/opengrep/opengrep/releases/download/v${OPENGREP_VERSION}/opengrep_manylinux_x86"
echo "$OPENGREP_SHA256  /usr/local/bin/opengrep" | sha256sum -c --quiet -
chmod +x /usr/local/bin/opengrep

python3 -m venv /tmp/ash
# shellcheck disable=SC1091
. /tmp/ash/bin/activate
pip install -q "git+https://github.com/awslabs/automated-security-helper.git@${ASH_COMMIT}"

# cfn-nag from ASH's own Gemfile and lockfile.
assets="$(python3 -c 'import automated_security_helper, os; print(os.path.join(os.path.dirname(automated_security_helper.__file__), "assets"))')"
echo "gem: --no-document" > /etc/gemrc
gem install -q bundler -v "$BUNDLER_VERSION"
BUNDLE_GEMFILE="$assets/Gemfile" bundle install --quiet
gembin="$(gem env gemdir)/bin"
export PATH="$gembin:$PATH"

status=0
ash --mode local --config .ash/.ash.yaml --fail-on-findings || status=$?

# A scanner whose tool is absent reports MISSING and finds nothing, which
# --fail-on-findings alone would let through.
python3 - <<'EOF' || status=1
import json, sys
d = json.load(open(".ash/ash_output/ash_aggregated_results.json"))
bad = []
def walk(node, path):
    if isinstance(node, dict):
        if node.get("status") == "MISSING" or node.get("dependencies_satisfied") is False:
            # cdk-nag is disabled in .ash/.ash.yaml (it runs inside cdk synth instead).
            if not node.get("excluded") and not path.endswith("/cdk-nag"):
                bad.append(path)
        for k, v in node.items():
            walk(v, f"{path}/{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, f"{path}[{i}]")
walk(d.get("scanner_results", {}), "scanner_results")
for b in bad:
    print(f"scanner did not run: {b}")
sys.exit(1 if bad else 0)
EOF
exit "$status"
