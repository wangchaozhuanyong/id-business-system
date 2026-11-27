#!/usr/bin/env bash
# Isolated amd64 CI check using the same seccomp profile as the deployed worker.
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
# Chromium can rewrite /proc command lines as a space-delimited process title.
RENDERER_ARG = re.compile(rb"(?:^|[\x00 ])--type=renderer(?:[\x00 ]|$)")

def sandbox_denied(message):
    return bool(re.search(rb"no usable sandbox|failed to move to new namespace[^\n]*(?:not permitted|permission denied)|"
                          rb"(?:namespace_sandbox|zygote_host_impl_linux)[^\n]*(?:operation not permitted|permission denied)|"
                          rb"check failed: sys_chroot\(",
                          message, re.I))

def fields(path):
    return dict(line.split(":", 1) for line in path.read_text().splitlines() if ":" in line)

def active_interfaces():
    # The kernel can create disabled tunnel devices in a fresh namespace.
    # Docker must attach no external network and the only up interface is lo.
    return {dev.name for dev in Path("/sys/class/net").iterdir()
            if dev.is_dir() and int((dev / "flags").read_text(), 16) & 1}

def ready():
    # Inspect only this disposable container's private procfs/cgroup. Never print argv or paths.
    init = fields(Path("/proc/1/status"))
    protected = (os.getuid() == os.getgid() == 10001 and int(init["NoNewPrivs"]) == 1
                 and int(init["Seccomp"]) == 2 and int(init["CapBnd"], 16) == 0
                 and int(init["CapEff"], 16) == 0)
    cg = Path("/sys/fs/cgroup")
    if (not protected or int((cg / "memory.max").read_text()) != LIMIT
            or int((cg / "memory.swap.max").read_text()) != 0
            or active_interfaces() != {"lo"}):
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
    # A renderer must enter a nested PID namespace and add its own BPF filter
    # on top of the container's inherited seccomp filter.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        for proc in Path("/proc").glob("[0-9]*"):
            try:
                if not RENDERER_ARG.search((proc / "cmdline").read_bytes()):
                    continue
                renderer = fields(proc / "status")
                if (int(renderer["Seccomp"]) == 2 and int(renderer["NoNewPrivs"]) == 1
                        and int(renderer["CapEff"], 16) == 0 and "Seccomp_filters" in init
                        and int(renderer.get("Seccomp_filters", "0")) > int(init["Seccomp_filters"])
                        and len(renderer["NSpid"].split()) > len(init["NSpid"].split())):
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
        return "chromium_namespace_sandbox_unavailable"
    if result.returncode == 0 and b"Workspace-CI" in result.stdout:
        return "gui_worker_start_failed"
    return "browser_start_failure_unclassified"

try:
    action = sys.argv[1]
    if action == "self-test":
        assert sandbox_denied(b"FATAL: No usable sandbox!")
        assert sandbox_denied(b"Failed to move to new namespace: errno = Operation not permitted")
        assert sandbox_denied(b'Check failed: sys_chroot("/proc/self/fdinfo/") == 0')
        assert not sandbox_denied(b"cannot open display")
        assert not sandbox_denied(b"font cache permission denied")
        assert RENDERER_ARG.search(b"chromium\0--type=renderer\0--lang=en")
        assert RENDERER_ARG.search(b"chromium --type=renderer --lang=en\0")
        assert not RENDERER_ARG.search(b"chromium --type=renderer-utility --lang=en")
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
archive_dir=
verified_image=
case "$#:${1:-}" in
  0:) ;;
  2:--archive-dir)
    archive_dir=$2
    [[ -n $archive_dir ]] || fail invalid_archive_directory
    ;;
  2:--verified-image)
    verified_image=$2
    [[ $verified_image =~ ^sha256:[a-f0-9]{64}$ ]] || fail worker_image_id_invalid
    ;;
  *) fail unexpected_arguments ;;
esac
[[ ${CI:-} == true && $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail requires_x86_64_linux_ci

# Pin the local socket to prevent a caller's Docker context from selecting a remote daemon.
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
seccomp="$repo/deploy/manual-desktop/chromium-seccomp.json"
[[ -f $seccomp && ! -L $seccomp ]] || fail worker_seccomp_profile_missing
if [[ -n $archive_dir ]]; then
  [[ $archive_dir == "$repo/.runtime/website-release" || $archive_dir == "$repo/.runtime/manual-remote-desktop-linux" ]] ||
    fail invalid_archive_directory
  [[ -d $archive_dir && ! -L $archive_dir && ! -L $repo/.runtime ]] || fail invalid_archive_directory
  [[ ${RELEASE_SHA:-} =~ ^[a-f0-9]{40}$ && $(git -C "$repo" rev-parse HEAD) == "$RELEASE_SHA" ]] ||
    fail worker_archive_source_unverified
  source_changes=$(git -C "$repo" status --porcelain --untracked-files=normal -- \
    deploy/manual-desktop/worker deploy/manual-desktop/chromium-seccomp.json \
    test/manual-remote-desktop-linux/container-check.sh) || fail worker_archive_source_unverified
  [[ -z $source_changes ]] || fail worker_archive_source_unverified
  archive="$archive_dir/independent-manual-image-$RELEASE_SHA"
  [[ ! -e $archive.tar.gz && ! -L $archive.tar.gz && ! -e $archive.id && ! -L $archive.id ]] ||
    fail worker_archive_exists
fi

engine=(docker --host unix:///var/run/docker.sock)
metadata=$("${engine[@]}" info --format '{{.OSType}} {{.Architecture}} {{.CgroupVersion}}' 2>/dev/null) || fail docker_unavailable
[[ $metadata == "linux x86_64 2" || $metadata == "linux amd64 2" ]] || fail docker_amd64_cgroup_v2_unverified
nonce=$(python3 -IB -c 'import secrets; print(secrets.token_hex(12))')
tag="id-manual-worker-ci:$nonce"
volume="id-manual-worker-ci-$nonce"
container=
staging=
have_image=0
have_volume=0
cleanup() {
  if [[ -n $container ]]; then "${engine[@]}" rm -f "$container" >/dev/null 2>&1 || :; fi
  if [[ $have_volume == 1 ]]; then "${engine[@]}" volume rm "$volume" >/dev/null 2>&1 || :; fi
  if [[ $have_image == 1 ]]; then "${engine[@]}" image rm "$tag" >/dev/null 2>&1 || :; fi
  if [[ -n $staging ]]; then
    rm -f -- "$staging/image.tar.gz" "$staging/image.id"
    rmdir -- "$staging"
  fi
}
trap cleanup EXIT
if "${engine[@]}" volume inspect "$volume" >/dev/null 2>&1; then fail ci_resource_collision; fi
if [[ -n $verified_image ]]; then
  reference=$verified_image
else
  if "${engine[@]}" image inspect "$tag" >/dev/null 2>&1; then fail ci_resource_collision; fi
  "${engine[@]}" build --platform linux/amd64 -t "$tag" "$repo/deploy/manual-desktop/worker" >/dev/null 2>&1 || fail worker_image_build_failed
  have_image=1
  reference=$tag
fi
image_metadata=$("${engine[@]}" image inspect --format '{{.Id}} {{.Os}} {{.Architecture}}' "$reference" 2>/dev/null) ||
  fail worker_image_unavailable
[[ $image_metadata =~ ^(sha256:[a-f0-9]{64})\ linux\ amd64$ ]] || fail worker_image_platform_unverified
image=${BASH_REMATCH[1]}
[[ -z $verified_image || $verified_image == "$image" ]] || fail worker_image_id_mismatch
"${engine[@]}" volume create "$volume" >/dev/null 2>&1 || fail fixture_volume_failed
have_volume=1
# Keep Docker's private namespaces and default LSM policy. Apply the audited
# syscall allowlist to this container only.
base=(--pull=never --platform linux/amd64 --network none --ipc private --cgroupns private --read-only
      --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges=true
      --security-opt "seccomp=$seccomp"
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
    chromium_namespace_sandbox_unavailable|gui_worker_start_failed|browser_start_failure_unclassified) fail "$diagnostic";;
    *) fail diagnostics_unavailable;;
  esac
fi
"${engine[@]}" stop -t 35 "$container" >/dev/null 2>&1 || fail worker_stop_failed
state=$("${engine[@]}" inspect --format '{{.State.ExitCode}} {{.State.OOMKilled}}' "$container" 2>/dev/null) || fail worker_state_unavailable
[[ $state == '0 false' ]] || fail worker_did_not_exit_cleanly
if [[ -n $archive_dir ]]; then
  staging=$(mktemp -d -- "$archive_dir/.manual-worker.XXXXXXXX") || fail worker_archive_directory_failed
  "${engine[@]}" image save --platform linux/amd64 "$image" | gzip -n > "$staging/image.tar.gz" ||
    fail worker_archive_save_failed
  gzip -t "$staging/image.tar.gz" || fail worker_archive_invalid
  printf '%s\n' "$image" > "$staging/image.id" || fail worker_archive_id_failed
  ln -- "$staging/image.tar.gz" "$archive.tar.gz" || fail worker_archive_publish_failed
  if ! ln -- "$staging/image.id" "$archive.id"; then
    if [[ $archive.tar.gz -ef $staging/image.tar.gz ]]; then rm -- "$archive.tar.gz"; fi
    fail worker_archive_publish_failed
  fi
fi
echo "worker_check=passed $result clean_exit=true"
