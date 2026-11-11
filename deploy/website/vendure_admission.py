"""Activate the separately managed Vendure gateway from a verified website release."""

import argparse
import fcntl
import json
import os
import re
import sqlite3
import stat
import subprocess
import time
from contextlib import closing, contextmanager
from pathlib import Path

from remote import FORMAL, LOCK, ROOT, ReleaseError, identity, inspect, require, require_main, run, write_new

UNIT = "id-business-independent-vendure.service"
DROP = Path("/etc/systemd/system") / (UNIT + ".d") / "90-current-release.conf"
STATE = FORMAL / "vendure-state/vendure"
ADMISSION = FORMAL / "data/vendure-admission"
TARGET = "/run/id-vendure-admission"
UID, GID = 993, 992
PROTECTED = ("recharge", "recharge-native", "vendure-worker")
LAUNCHER_ANCHOR = '  --mount "type=bind,src=$formal/operations,dst=/operations,readonly" ' + chr(92)
SQLITE_FILENAME = "vendure-recharge-isolated.sqlite"


def stage_launcher(content, previous, target):
    require(content.count("sha=" + previous) == 1 and content.count(LAUNCHER_ANCHOR) == 1 and
            "ID_VENDURE_ADMISSION_SOCKET" not in content, "gateway_launcher_changed")
    mount = f'  --mount "type=bind,src=$formal/data/vendure-admission,dst={TARGET},readonly" ' + chr(92)
    env = f'  -e "ID_VENDURE_ADMISSION_SOCKET={TARGET}/lookup.sock" ' + chr(92)
    return content.replace("sha=" + previous, "sha=" + target).replace(
        LAUNCHER_ANCHOR, LAUNCHER_ANCHOR + "\n" + mount + "\n" + env)


@contextmanager
def lock_idle_queue(path):
    require(path.is_file() and not path.is_symlink(), "gateway_task_store_unavailable")
    with closing(sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, timeout=8)) as db:
        # Hold the writer lock until the old service stops. A concurrent submit cannot
        # commit between the queue read and the service stop.
        db.execute("BEGIN IMMEDIATE")
        try:
            row = db.execute("SELECT payload FROM vendure_recharge_isolated_state WHERE id = 1").fetchone()
            require(row is not None, "gateway_task_snapshot_missing")
            tasks = json.loads(row[0])["tasks"]
            require(isinstance(tasks, list) and not any(
                item["status"] in ("queued", "running") for item in tasks), "gateway_queue_not_idle")
            yield len(tasks)
        finally:
            db.rollback()


def source_mount(container, path):
    return any(m["Destination"] == "/app" and m["Source"] == str(path) and not m["RW"]
               for m in container["Mounts"])


def read_gateway(sha, source, expected_image=None):
    container = inspect("vendure")
    current = identity(container)
    require(current["running"] and source_mount(container, source) and current["revision"] == sha and
            (expected_image is None or expected_image == current["image"]), "gateway_revision_mismatch")
    require(container["Config"]["User"] == f"{UID}:{GID}" and
            any(m["Destination"] == TARGET and m["Source"] == str(ADMISSION) and not m["RW"]
                for m in container["Mounts"]), "gateway_admission_mount_mismatch")
    return current


def ready_socket():
    folder = ADMISSION.lstat()
    socket = (ADMISSION / "lookup.sock").lstat()
    require(stat.S_ISDIR(folder.st_mode) and folder.st_uid == UID and stat.S_IMODE(folder.st_mode) == 0o700 and
            stat.S_ISSOCK(socket.st_mode) and socket.st_uid == UID and stat.S_IMODE(socket.st_mode) == 0o600,
            "id_private_admission_socket_unavailable")


def cutover(sha, release):
    require_main(sha)
    require(identity(inspect("app"))["revision"] == sha, "id_app_release_not_live")
    ops = release / "operations"
    receipt = json.loads((ops / "release.receipt.json").read_text())
    require(receipt["mainSha"] == sha and receipt["appCanaryPassed"] is True,
            "id_app_release_receipt_missing")
    ready_socket()
    require(not os.path.lexists(ADMISSION / "accept-submissions"), "storefront_acceptance_marker_already_present")
    source = release / "source"
    before = identity(inspect("vendure"))
    previous = before["revision"]
    require(before["running"] and isinstance(previous, str) and previous != sha and
            re.fullmatch(r"[a-f0-9]{40}", previous), "gateway_revision_invalid")
    require(source_mount(inspect("vendure"), ROOT / "releases" / previous / "source"), "gateway_source_mismatch")
    old_launcher = ROOT / "releases" / previous / "operations/run-vendure"
    launcher = ops / "run-vendure"
    old_drop = DROP.read_text()
    require(old_drop.count("ExecStart=" + str(old_launcher)) == 1, "gateway_service_launcher_mismatch")
    candidate = stage_launcher(old_launcher.read_text(), previous, sha)
    if launcher.exists():
        require(not launcher.is_symlink() and launcher.read_text() == candidate, "gateway_candidate_launcher_changed")
    else:
        write_new(launcher, candidate, 0o755)
    run(["bash", "-n", str(launcher)])
    pending = DROP.with_name(f".moyao-admission-{sha[:12]}.conf")
    protected = {name: identity(inspect(name)) for name in PROTECTED}
    require(all(item["running"] for item in protected.values()), "original_recharge_runtime_not_ready")
    with lock_idle_queue(STATE / SQLITE_FILENAME) as retained_tasks:
        require_main(sha)
        run(["systemctl", "stop", UNIT], timeout=45)
        require(not (STATE / "vendure-task-service.lock").exists(), "old_gateway_did_not_close_cleanly")
        require(DROP.read_text() == old_drop, "gateway_service_launcher_changed")
        write_new(pending, old_drop.replace(str(old_launcher), str(launcher)), 0o644)
        os.replace(pending, DROP)
        run(["systemctl", "daemon-reload"])
    run(["systemctl", "start", UNIT], timeout=45)
    for _ in range(12):
        try:
            current = read_gateway(sha, source, before["image"])
            break
        except (ReleaseError, subprocess.CalledProcessError):
            time.sleep(1)
    else:
        raise ReleaseError("new_gateway_readback_failed")
    require(all(identity(inspect(name)) == value for name, value in protected.items()),
            "original_recharge_runtime_changed")
    record = {"mainSha": sha, "gatewaySha": current["revision"], "previousGatewaySha": previous,
              "retainedTaskCount": retained_tasks, "originalRuntimeUnchanged": True, "accepting": False}
    write_new(ops / "vendure-admission.receipt.json", json.dumps(record) + "\n", 0o600)
    return record


def open_submissions(sha, release):
    record = json.loads((release / "operations/vendure-admission.receipt.json").read_text())
    require(record["gatewaySha"] == sha and record["originalRuntimeUnchanged"] is True, "gateway_receipt_missing")
    read_gateway(sha, release / "source")
    ready_socket()
    marker = ADMISSION / "accept-submissions"
    pending = ADMISSION / f".accept-submissions-{sha[:12]}"
    write_new(pending, sha + "\n", 0o600)
    try:
        os.chown(pending, UID, GID)
        os.link(pending, marker)
    finally:
        pending.unlink()
    return {"gatewaySha": sha, "accepting": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("cutover", "open"))
    parser.add_argument("sha")
    options = parser.parse_args()
    require(re.fullmatch(r"[a-f0-9]{40}", options.sha), "invalid_release_revision")
    release = ROOT / "releases" / options.sha
    require(Path(__file__).resolve().parent == release / "source/deploy/website", "gateway_release_source_mismatch")
    with LOCK.open("r") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        operation = cutover if options.operation == "cutover" else open_submissions
        print(json.dumps(operation(options.sha, release), sort_keys=True), flush=True)
