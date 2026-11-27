#!/usr/bin/env bash
# Exercise the real installer, systemd authorization and ordinary-record cold start on a disposable runner.
set -euo pipefail
umask 022
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${GITHUB_EVENT_NAME:-} == pull_request ]]
[[ $# == 1 && $1 =~ ^sha256:[0-9a-f]{64}$ ]]
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
revision=$(git -C "$repo" rev-parse HEAD)
fixture=/opt/id-business-workspace-ci/releases/$revision
scratch="$repo/.runtime/manual-remote-desktop-linux/host"
[[ ! -e "$fixture" && ! -e "$scratch" ]]
mkdir -p "$scratch/novnc"
python3 -B - "$repo" "$scratch/novnc" <<'PY'
from pathlib import Path
import sys
sys.path.insert(0, str(Path(sys.argv[1]) / "deploy/website"))
from build_manual_workspace import browser_client
browser_client(Path(sys.argv[2]))
PY
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends python3-aiohttp polkitd
sudo install -d -m 0755 "$fixture/source"
git -C "$repo" -c tar.umask=0022 archive "$revision" deploy/manual-desktop | sudo tar -xf - -C "$fixture/source"
sudo cp -R "$scratch/novnc" "$fixture/novnc"
namei -l "$fixture/source/deploy/manual-desktop/host/provision.py" "$fixture/novnc/core/rfb.js"
installer=(sudo /usr/bin/python3 -IB "$fixture/source/deploy/manual-desktop/host/provision.py")
settings=(--release-root "$fixture" --image-id "$1" --assets "$fixture/novnc"
          --max-active 1 --min-available-mib 512 --block-network 203.0.113.1/32)
"${installer[@]}" check "${settings[@]}"
"${installer[@]}" install "${settings[@]}"
trap '"${installer[@]}" deactivate "${settings[@]}"' EXIT
"${installer[@]}" smoke "${settings[@]}"
