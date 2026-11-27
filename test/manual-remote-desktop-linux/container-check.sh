#!/usr/bin/env bash
# Isolated amd64 CI check. The image build uses the worker's normal Debian packages.
# Worker and diagnostic containers have no network. --self-test does not contact Docker.
set -euo pipefail

fail() { echo "worker_check=$1" >&2; exit 1; }

payload() {
  cat <<'PY'
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import time

LIMIT = 512 * 1024 * 1024
CHROME = "/usr/lib/chromium/chromium"

def sandbox_denied(message):
    return bool(re.search(rb"no usable sandbox|failed to move to new namespace[^\n]*(?:not permitted|permission denied)|"
                          rb"(?:namespace_sandbox|zygote_host_impl_linux)[^\n]*(?:operation not permitted|permission denied)",
                          message, re.I))

def fields(path):
    return dict(line.split(":", 1) for line in path.read_text().splitlines() if ":" in line)

def ready():
    # Inspect only this disposable container's private procfs/cgroup. Never print argv or paths.
    init = fields(Path("/proc/1/status"))
    protected = (os.getuid() == os.getgid() == 10001 and int(init["NoNewPrivs"]) == 1
                 and int(init["Seccomp"]) == 2 and int(init["CapBnd"], 16) == 0
                 and int(init["CapEff"], 16) == 0)
    cg = Path("/sys/fs/cgroup")
    if (not protected or int((cg / "memory.max").read_text()) != LIMIT
            or int((cg / "memory.swap.max").read_text()) != 0
            or {dev.name for dev in Path("/sys/class/net").iterdir()} != {"lo"}):
        return "isolation_or_limits_mismatch"
    path = Path("/run/workspace/rfb.sock")
    deadline = time.monotonic() + 38
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(.15)
    if not path.exists():
        return "desktop_unavailable"
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 10001 or stat.S_IMODE(info.st_mode) != 0o600:
        return "rfb_socket_not_private"
    with socket.socket(socket.AF_UNIX) as rfb:
        rfb.settimeout(2)
        rfb.connect(str(path))
        with rfb.makefile("rb") as stream:
            if stream.read(12) not in (b"RFB 003.007\n", b"RFB 003.008\n"):
                return "rfb_handshake_failed"
    # A renderer must add its own BPF filter on top of Docker's inherited seccomp filter.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        for proc in Path("/proc").glob("[0-9]*"):
            try:
                if b"--type=renderer" not in (proc / "cmdline").read_bytes().split(b"\0"):
                    continue
                renderer = fields(proc / "status")
                if (int(renderer["Seccomp"]) == 2 and int(renderer["NoNewPrivs"]) == 1
                        and int(renderer["CapEff"], 16) == 0 and "Seccomp_filters" in init
                        and int(renderer.get("Seccomp_filters", "0")) > int(init["Seccomp_filters"])):
                    peak = int((cg / "memory.peak").read_text())
                    if peak <= 0:
                        return "peak_unavailable"
                    return f"ready peak_before_stop_mib={(peak + 1048575) // 1048576}"
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
        time.sleep(.15)
    return "renderer_sandbox_unverified"

def diagnose():
    # Reproduce a failure independently with normal Chromium and an offline, synthetic page.
    # Output only a classification, never the captured stderr, page or profile data.
    result = subprocess.run(
        [CHROME, "--headless", "--no-first-run", "--no-default-browser-check", "--user-data-dir=/profile",
         "--dump-dom", "data:text/html,<title>Workspace-CI</title>"],
        env={"PATH": "/usr/bin:/bin", "HOME": "/profile", "LANG": "C.UTF-8"},
        stdin=subprocess.DEVNULL, capture_output=True, timeout=18)
    if result.returncode and sandbox_denied(result.stderr):
        return "default_chromium_sandbox_incompatible"
    if result.returncode == 0 and b"Workspace-CI" in result.stdout:
        return "gui_worker_start_failed"
    return "browser_start_failure_unclassified"

try:
    action = sys.argv[1]
    if action == "self-test":
        assert sandbox_denied(b"FATAL: No usable sandbox!")
        assert sandbox_denied(b"Failed to move to new namespace: errno = Operation not permitted")
        assert not sandbox_denied(b"cannot open display")
        assert not sandbox_denied(b"font cache permission denied")
        print("self_test_passed")
    elif action == "seed":
        # Suppress the operational first-visit URL using the worker's existing installation marker.
        # The attached volume is fresh, disposable, and belongs only to this test.
        with Path("/profile/Local State").open("x", encoding="utf8") as initial:
            initial.write("{}")
        print("seeded")
    elif action == "ready":
        print(ready(), flush=True)
    elif action == "diagnose":
        print(diagnose(), flush=True)
    else:
        sys.exit(2)
except (OSError, ValueError, KeyError, subprocess.SubprocessError):
    print("diagnostics_unavailable", flush=True)
    sys.exit(1)
PY
}

if [[ ${1:-} == --self-test && $# == 1 ]]; then
  payload | python3 -IB - self-test
  exit
fi
[[ $# == 0 ]] || fail unexpected_arguments
[[ ${CI:-} == true && $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail requires_x86_64_linux_ci

# Pin the local socket to prevent a caller's Docker context from selecting a remote daemon.
engine=(docker --host unix:///var/run/docker.sock)
metadata=$("${engine[@]}" info --format '{{.OSType}} {{.Architecture}} {{.CgroupVersion}} {{range .SecurityOptions}}{{if or (eq . "name=seccomp,profile=builtin") (eq . "name=seccomp,profile=default")}}default-seccomp{{end}}{{end}}' 2>/dev/null) || fail docker_unavailable
[[ $metadata == "linux x86_64 2 default-seccomp" || $metadata == "linux amd64 2 default-seccomp" ]] || fail docker_amd64_cgroup_v2_or_default_seccomp_unverified

repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
nonce=$(python3 -IB -c 'import secrets; print(secrets.token_hex(12))')
image="id-manual-worker-ci:$nonce"
volume="id-manual-worker-ci-$nonce"
container=
have_image=0
have_volume=0
cleanup() {
  if [[ -n $container ]]; then "${engine[@]}" rm -f "$container" >/dev/null 2>&1 || :; fi
  if [[ $have_volume == 1 ]]; then "${engine[@]}" volume rm "$volume" >/dev/null 2>&1 || :; fi
  if [[ $have_image == 1 ]]; then "${engine[@]}" image rm "$image" >/dev/null 2>&1 || :; fi
}
trap cleanup EXIT
if "${engine[@]}" image inspect "$image" >/dev/null 2>&1 || "${engine[@]}" volume inspect "$volume" >/dev/null 2>&1; then fail ci_resource_collision; fi
"${engine[@]}" build --platform linux/amd64 -t "$image" "$repo/deploy/manual-desktop/worker" >/dev/null 2>&1 || fail worker_image_build_failed
have_image=1
"${engine[@]}" volume create "$volume" >/dev/null 2>&1 || fail fixture_volume_failed
have_volume=1
# Omit --pid and custom seccomp/AppArmor options to retain Docker's private/default modes.
base=(--pull=never --platform linux/amd64 --network none --ipc private --cgroupns private --read-only
      --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges=true
      --memory 512m --memory-swap 512m --pids-limit 512 --shm-size 128m
      --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=128m
      --tmpfs /run/workspace:rw,nosuid,nodev,mode=0700,uid=10001,gid=10001,size=4m)
profile=(--mount "type=volume,src=$volume,dst=/profile")
seed=$(payload | "${engine[@]}" run --rm -i "${base[@]}" "${profile[@]}" --entrypoint /usr/bin/python3 "$image" -IB - seed 2>/dev/null) || fail fixture_seed_failed
[[ $seed == seeded ]] || fail fixture_seed_failed
container=$("${engine[@]}" run -d "${base[@]}" "${profile[@]}" "$image" 2>/dev/null) || fail worker_container_start_failed
[[ $container =~ ^[a-f0-9]{64}$ ]] || fail worker_container_id_invalid
modes=$("${engine[@]}" inspect --format '{{.HostConfig.PidMode}}|{{.HostConfig.IpcMode}}|{{.HostConfig.Privileged}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.NetworkMode}}' "$container" 2>/dev/null) || fail runtime_settings_unavailable
[[ $modes == '|private|false|true|none' || $modes == 'private|private|false|true|none' ]] || fail runtime_namespaces_mismatch

result=$(payload | "${engine[@]}" exec -i "$container" /usr/bin/python3 -IB - ready 2>/dev/null) || result=${result:-desktop_unavailable}
if [[ ! $result =~ ^ready\ peak_before_stop_mib=[0-9]+$ ]]; then
  oom=$("${engine[@]}" inspect --format '{{.State.OOMKilled}}' "$container" 2>/dev/null) || fail worker_state_unavailable
  [[ $oom != true ]] || fail worker_memory_limit_reached
  case "$result" in
    isolation_or_limits_mismatch|rfb_socket_not_private|rfb_handshake_failed|peak_unavailable|renderer_sandbox_unverified) fail "$result";;
  esac
  "${engine[@]}" stop -t 35 "$container" >/dev/null 2>&1 || fail worker_stop_failed
  diagnostic=$(payload | "${engine[@]}" run --rm -i "${base[@]}" \
    --tmpfs /profile:rw,nosuid,nodev,mode=0700,uid=10001,gid=10001,size=128m \
    --entrypoint /usr/bin/python3 "$image" -IB - diagnose 2>/dev/null) || diagnostic=diagnostics_unavailable
  case "$diagnostic" in
    default_chromium_sandbox_incompatible|gui_worker_start_failed|browser_start_failure_unclassified) fail "$diagnostic";;
    *) fail diagnostics_unavailable;;
  esac
fi
"${engine[@]}" stop -t 35 "$container" >/dev/null 2>&1 || fail worker_stop_failed
state=$("${engine[@]}" inspect --format '{{.State.ExitCode}} {{.State.OOMKilled}}' "$container" 2>/dev/null) || fail worker_state_unavailable
[[ $state == '0 false' ]] || fail worker_did_not_exit_cleanly
echo "worker_check=passed $result clean_exit=true"
