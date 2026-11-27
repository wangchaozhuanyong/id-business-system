#!/bin/bash
# Run only as root on a disposable systemd Linux QA machine with the worker packages,
# Debian noVNC, python3-aiohttp, tini, util-linux, Node 24 and Playwright already available.
# Set ID_RECHARGE_QA_PLAYWRIGHT to the local Playwright entry file if needed.
# ID_MANUAL_QA_SINGLE=1 runs two lightweight tabs in a 512 MiB worker with swap disabled.
# ID_MANUAL_QA_PHONE_WIDTH=320|390 selects the touch viewport (default 390).
# ID_MANUAL_QA_NATIVE_CLOSE=window|quit additionally tests Chromium's own window close or menu exit.
# The web gateway and worker are the real implementations; business identities and webpages are fixtures.
set -euo pipefail
[[ "$(uname -s)" == Linux && "$EUID" == 0 && "${ID_MANUAL_REMOTE_QA_VM:-}" == 1 ]] || { echo 'A dedicated Linux QA VM and ID_MANUAL_REMOTE_QA_VM=1 are required.' >&2; exit 1; }
root=/run/id-manual-qa
unit=/run/systemd/system/id-manual-workspace@.service
suite=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$(cd -- "$suite/../.." && pwd)
output="$repo/.runtime/manual-remote-desktop-linux"
stop_lab() {
  [[ -e "$root/owns-unit" ]] || return 0
  while read -r key; do systemctl stop "id-manual-workspace@$key.service" || true; done < "$root/keys"
  systemctl stop manualqa-broker.service || true
  if [[ -e "$root/slice" ]]; then systemctl stop "$(cat "$root/slice")" || true; fi
  rm -f "${unit}.d/test-limits.conf" "$unit"
  rmdir "${unit}.d" 2>/dev/null || true
  systemctl daemon-reload
  rm -rf -- "$root"
}
case "${1:-run}" in
  stop) stop_lab; exit ;;
  run) ;;
  *) echo 'Usage: run.sh [run|stop]' >&2; exit 2 ;;
esac
[[ ! -e "$root" && ! -e "${unit}.d" ]] && ! systemctl cat id-manual-workspace@.service >/dev/null 2>&1 || { echo 'An existing lab or worker unit is present.' >&2; exit 1; }
mkdir "$root"
trap stop_lab EXIT
install -d "$root/profiles" "$root/workers" "$root/broker" "$output"
install -d -m 0700 "$root/claims"
install -d /profile /run/workspace
node --input-type=module - "$repo" > "$root/keys" <<'JS'
const {manualDesktopWorkspaceKey}=await import(process.argv[2]+'/server/manual-desktop-workspace.mjs');
for (const [operatorId, accountId] of [['fixture-owner','alpha'],['fixture-owner','delta'],['fixture-colleague','bravo']]) {
  console.log(manualDesktopWorkspaceKey({operatorId, accountId}));
}
JS
while read -r key; do
  install -d -m 0700 -o 10001 -g 10001 "$root/profiles/$key" "$root/workers/$key"
done < "$root/keys"
install -m 0644 "$repo/deploy/manual-desktop/worker/worker.py" "$root/worker.py"
install -m 0644 "$suite/fixture.py" "$root/fixture.py"
install -m 0644 "$suite/isolation.py" "$root/isolation.py"
install -m 0644 "$suite/lifecycle.py" "$root/lifecycle.py"
install -m 0644 "$suite/id-manual-workspace@.service" "$unit"
touch "$root/owns-unit"
slice="manualqa$(date +%s)$$.slice"
printf '%s\n' "$slice" > "$root/slice"
mkdir "${unit}.d"
printf '[Service]\nSlice=%s\n' "$slice" > "${unit}.d/test-limits.conf"
if [[ "${ID_MANUAL_QA_SINGLE:-}" == 1 ]]; then
  printf 'MemoryMax=512M\nMemorySwapMax=0\n' >> "${unit}.d/test-limits.conf"
fi
systemctl daemon-reload
systemd-run --quiet --unit=manualqa-broker --collect -p "Slice=$slice" -p MemoryAccounting=yes \
  /usr/bin/python3 -IB "$repo/deploy/manual-desktop/broker.py" --socket "$root/broker/web.sock" --workers "$root/workers" --assets /usr/share/novnc --claims "$root/claims" --start-units --max-active 2 --min-available-mib 256
for _ in {1..60}; do [ ! -S "$root/broker/web.sock" ] || break; sleep .1; done
run_output=$(mktemp -d "$output/run-XXXXXXXX")
echo "QA results: $run_output"
ID_MANUAL_QA_SLICE="$slice" ID_MANUAL_QA_OUTPUT="$run_output" node "$suite/verify.mjs"
