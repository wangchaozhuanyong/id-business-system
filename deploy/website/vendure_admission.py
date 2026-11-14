"""Activate the separately managed Vendure gateway from a verified website release."""

import argparse
import fcntl
import hashlib
import hmac
import json
import os
import re
import sqlite3
import stat
import subprocess
import time
from contextlib import closing, contextmanager
from pathlib import Path

from remote import FORMAL, LOCK, ROOT, ReleaseError, digest, identity, inspect, require, require_main, run, write_new

UNIT = "id-business-independent-vendure.service"
WORKER_UNIT = "id-business-independent-vendure-worker.service"
WORKER_LAUNCHER = FORMAL / "operations/run-vendure-worker"
DROP = Path("/etc/systemd/system") / (UNIT + ".d") / "90-current-release.conf"
STATE = FORMAL / "vendure-state/vendure"
ADMISSION = FORMAL / "data/vendure-admission"
TARGET = "/run/id-vendure-admission"
PARTNER_DIR = ADMISSION / "partner"
PARTNER_TARGET = TARGET + "/partner"
PARTNER_ENV = "ID_RECHARGE_PARTNER_TASK_DIRECTORY=" + PARTNER_TARGET
UID, GID = 993, 992
PROTECTED = ("recharge", "recharge-native")
LAUNCHER_ANCHOR = '  --mount "type=bind,src=$formal/operations,dst=/operations,readonly" ' + chr(92)
SQLITE_FILENAME = "vendure-recharge-isolated.sqlite"
RETRY_ENV = "ID_VENDURE_RETRY_RECEIPT_SHA256"
STORAGE_CREDENTIAL = "independent-vendure-storage"


def stage_launcher(content, previous, target, refresh=False, retry_receipt=None, partner_api=False):
    mount = f'  --mount "type=bind,src=$formal/data/vendure-admission,dst={TARGET},readonly" ' + chr(92)
    env = f'  -e "ID_VENDURE_ADMISSION_SOCKET={TARGET}/lookup.sock" ' + chr(92)
    anchor = LAUNCHER_ANCHOR + "\n" + mount + "\n" + env
    require(content.count("sha=" + previous) == 1 and content.count(LAUNCHER_ANCHOR) == 1 and
            content.count("ID_VENDURE_ADMISSION_SOCKET") == int(refresh) and
            content.count(TARGET + ",readonly") == int(refresh) and
            (not refresh or content.count(anchor) == 1), "gateway_launcher_changed")
    candidate = content.replace("sha=" + previous, "sha=" + target)
    partner_wiring = (
        f'  --mount "type=bind,src=$formal/data/vendure-admission/partner,dst={PARTNER_TARGET}" ' + chr(92) + "\n"
        f'  -e "{PARTNER_ENV}" ' + chr(92)
    )
    has_partner = PARTNER_ENV in content
    if has_partner:
        require(content.count(PARTNER_ENV) == 1 and content.count(anchor + "\n" + partner_wiring) == 1,
                "gateway_partner_launcher_changed")
    elif partner_api:
        require(refresh, "gateway_partner_requires_refresh")
        candidate = candidate.replace(anchor, anchor + "\n" + partner_wiring)
    if retry_receipt:
        require(refresh and re.fullmatch(r"[a-f0-9]{64}", retry_receipt), "gateway_retry_receipt_invalid")
        approval = '  -e "' + RETRY_ENV + '=' + retry_receipt + '" ' + chr(92)
        retry_anchor = anchor + ("\n" + partner_wiring if has_partner or partner_api else "")
        if RETRY_ENV in candidate:
            require(candidate.count(RETRY_ENV) == 1 and candidate.count(retry_anchor + "\n" + approval) == 1,
                    "gateway_retry_launcher_changed")
        else:
            candidate = candidate.replace(retry_anchor, retry_anchor + "\n" + approval)
    return candidate if refresh else candidate.replace(LAUNCHER_ANCHOR, anchor)


def idle_snapshot(db):
    row = db.execute("SELECT revision, payload FROM vendure_recharge_isolated_state WHERE id = 1").fetchone()
    require(row is not None, "gateway_task_snapshot_missing")
    revision, payload = row
    tasks = json.loads(payload)["tasks"]
    require(isinstance(tasks, list) and not any(
        item["status"] in ("queued", "running") for item in tasks), "gateway_queue_not_idle")
    return revision, len(tasks)


@contextmanager
def lock_idle_queue(path, retry_receipt=None):
    require(path.is_file() and not path.is_symlink(), "gateway_task_store_unavailable")
    with closing(sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, timeout=8)) as db:
        # Hold the writer lock until the old service stops. A concurrent submit cannot
        # commit between the queue read and the service stop.
        db.execute("BEGIN IMMEDIATE")
        try:
            _, count = idle_snapshot(db)
            if retry_receipt:
                require_reviewed_receipt(db, retry_receipt)
            yield count
        finally:
            db.rollback()


def read_idle_queue(path):
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=3)) as db:
        return idle_snapshot(db)


def require_reviewed_receipt(db, receipt):
    revision, payload, integrity = db.execute(
        "SELECT revision, payload, integrity FROM vendure_recharge_isolated_state WHERE id = 1").fetchone()
    key = run(["systemd-creds", "decrypt", "--name=" + STORAGE_CREDENTIAL,
               str(FORMAL / "private" / (STORAGE_CREDENTIAL + ".cred")), "-"]).strip()
    require(re.fullmatch(rb"[a-f0-9]{64}", key), "gateway_retry_storage_identity_invalid")
    key = bytes.fromhex(key.decode("ascii"))

    def fingerprint(purpose, value):
        return hmac.new(key, (purpose + "\0" + value).encode(), hashlib.sha256).hexdigest()

    snapshot = json.dumps([revision, payload], ensure_ascii=False, separators=(",", ":"))
    require(hmac.compare_digest(integrity, fingerprint("snapshot", snapshot)), "gateway_retry_snapshot_mismatch")
    tasks = json.loads(payload)["tasks"]
    matches = [task for task in tasks if hashlib.sha256(task["id"].encode()).hexdigest() == receipt]
    require(len(matches) == 1, "gateway_retry_receipt_missing")
    task, = matches
    outcome = task.get("result") or {}
    require(task["status"] == "failed" and outcome.get("status") == "failed" and
            not task.get("upstreamJobId") and not outcome.get("upstreamJobId") and
            any(hmac.compare_digest(str(outcome.get("evidenceRef", "")),
                                    fingerprint("evidence", "codexdaichong:" + kind + ":" + task["id"]))
                for kind in ("route", "cards")), "gateway_retry_failure_not_confirmed")
    require(sum(item["codeRef"] == task["codeRef"] for item in tasks) == 1, "gateway_retry_code_has_other_attempt")


def worker_binding():
    require(UNIT in run(["systemctl", "show", "-p", "PartOf", "--value", WORKER_UNIT]).decode().split(),
            "gateway_worker_dependency_changed")
    return run(["systemctl", "show", "-p", "ExecStart", "--value", WORKER_UNIT]), digest(WORKER_LAUNCHER)


def worker_runtime(container):
    require(container["State"]["Running"], "gateway_worker_not_running")
    mounts = [m["Source"] for m in container["Mounts"] if m["Destination"] == "/app" and not m["RW"]]
    require(len(mounts) == 1, "gateway_worker_source_unavailable")
    return container["Image"], container["Config"]["User"], mounts[0]


def resume_worker(binding, expected, task_count):
    require(worker_binding() == binding, "gateway_worker_launcher_changed")
    path = STATE / SQLITE_FILENAME
    baseline, count = read_idle_queue(path)
    require(count == task_count, "gateway_task_snapshot_changed")
    # Stopping a systemd PartOf unit also stops the worker. Starting the gateway
    # does not start its dependent worker; restore the same worker explicitly.
    run(["systemctl", "start", WORKER_UNIT], timeout=35)
    for _ in range(12):
        try:
            container = inspect("vendure-worker")
        except subprocess.CalledProcessError:
            time.sleep(1)
            continue
        if not container["State"]["Running"]:
            time.sleep(1)
            continue
        require(worker_runtime(container) == expected, "gateway_worker_runtime_changed")
        revision, count = read_idle_queue(path)
        require(count == task_count, "gateway_task_snapshot_changed")
        if revision > baseline:
            return
        time.sleep(1)
    raise ReleaseError("gateway_worker_poll_not_observed")


def source_mount(container, path):
    return any(m["Destination"] == "/app" and m["Source"] == str(path) and not m["RW"]
               for m in container["Mounts"])


def read_gateway(sha, source, expected_image=None, retry_receipt=None, partner_api=False):
    container = inspect("vendure")
    current = identity(container)
    require(current["running"] and source_mount(container, source) and current["revision"] == sha and
            (expected_image is None or expected_image == current["image"]), "gateway_revision_mismatch")
    require(container["Config"]["User"] == f"{UID}:{GID}" and
            any(m["Destination"] == TARGET and m["Source"] == str(ADMISSION) and not m["RW"]
                for m in container["Mounts"]), "gateway_admission_mount_mismatch")
    if retry_receipt:
        matching = [value for value in container["Config"]["Env"] if value.startswith(RETRY_ENV + "=")]
        require(matching == [RETRY_ENV + "=" + retry_receipt], "gateway_retry_config_not_live")
    if partner_api:
        require(PARTNER_ENV in container["Config"]["Env"] and
                any(m["Destination"] == PARTNER_TARGET and m["Source"] == str(PARTNER_DIR) and m["RW"]
                    for m in container["Mounts"]), "gateway_partner_mount_mismatch")
        state = (PARTNER_DIR / "tasks.sock").lstat()
        require(stat.S_ISSOCK(state.st_mode) and state.st_uid == UID and stat.S_IMODE(state.st_mode) == 0o600,
                "gateway_partner_socket_unavailable")
    return current


def ready_socket():
    folder = ADMISSION.lstat()
    socket = (ADMISSION / "lookup.sock").lstat()
    require(stat.S_ISDIR(folder.st_mode) and folder.st_uid == UID and stat.S_IMODE(folder.st_mode) == 0o700 and
            stat.S_ISSOCK(socket.st_mode) and socket.st_uid == UID and stat.S_IMODE(socket.st_mode) == 0o600,
            "id_private_admission_socket_unavailable")


@contextmanager
def paused_submission_marker(sha, enabled):
    marker = ADMISSION / "accept-submissions"
    paused = ADMISSION / (".accept-submissions-paused-" + sha[:12])
    if enabled:
        require(not os.path.lexists(paused), "storefront_pause_marker_already_present")
        state = marker.lstat()
        require(stat.S_ISREG(state.st_mode) and state.st_uid == UID and
                stat.S_IMODE(state.st_mode) == 0o600, "storefront_acceptance_marker_invalid")
        marker.rename(paused)
    else:
        require(not os.path.lexists(marker), "storefront_acceptance_marker_already_present")

    # Never reopen intake if the service may have switched but hasn't been verified.
    progress = {"switch_started": False}
    try:
        yield progress
    except Exception:
        if enabled and not progress["switch_started"]:
            os.link(paused, marker)
            paused.unlink()
        raise
    else:
        if enabled:
            os.link(paused, marker)
            paused.unlink()


def check_refresh_baseline(sha, retry_receipt, partner_api=False):
    ready_socket()
    before = inspect("vendure")
    previous = identity(before)["revision"]
    require(isinstance(previous, str) and re.fullmatch(r"[a-f0-9]{40}", previous) and previous != sha,
            "gateway_revision_invalid")
    read_gateway(previous, ROOT / "releases" / previous / "source")
    launcher = ROOT / "releases" / previous / "operations/run-vendure"
    require(DROP.read_text().count("ExecStart=" + str(launcher)) == 1, "gateway_service_launcher_mismatch")
    stage_launcher(launcher.read_text(), previous, sha, refresh=True, retry_receipt=retry_receipt, partner_api=partner_api)
    marker = (ADMISSION / "accept-submissions").lstat()
    require(stat.S_ISREG(marker.st_mode) and marker.st_uid == UID and
            stat.S_IMODE(marker.st_mode) == 0o600, "storefront_acceptance_marker_invalid")
    worker_binding()
    worker_runtime(inspect("vendure-worker"))
    with closing(sqlite3.connect((STATE / SQLITE_FILENAME).as_uri() + "?mode=ro", uri=True, timeout=3)) as db:
        idle_snapshot(db)
        if retry_receipt:
            require_reviewed_receipt(db, retry_receipt)


def prepare_partner_socket_directory():
    if not os.path.lexists(PARTNER_DIR):
        PARTNER_DIR.mkdir(mode=0o700)
        os.chown(PARTNER_DIR, UID, GID)
    state = PARTNER_DIR.lstat()
    require(stat.S_ISDIR(state.st_mode) and state.st_uid == UID and stat.S_IMODE(state.st_mode) == 0o700,
            "gateway_partner_directory_invalid")


def cutover(sha, release, refresh=False, retry_receipt=None, partner_api=False):
    require_main(sha)
    require(identity(inspect("app"))["revision"] == sha, "id_app_release_not_live")
    ops = release / "operations"
    receipt = json.loads((ops / "release.receipt.json").read_text())
    require(receipt["mainSha"] == sha and receipt["appCanaryPassed"] is True,
            "id_app_release_receipt_missing")
    ready_socket()
    source = release / "source"
    before = identity(inspect("vendure"))
    previous = before["revision"]
    require(before["running"] and isinstance(previous, str) and previous != sha and
            re.fullmatch(r"[a-f0-9]{40}", previous), "gateway_revision_invalid")
    require(source_mount(inspect("vendure"), ROOT / "releases" / previous / "source"), "gateway_source_mismatch")
    if refresh:
        require(read_gateway(previous, ROOT / "releases" / previous / "source") == before,
                "gateway_baseline_changed")
    old_launcher = ROOT / "releases" / previous / "operations/run-vendure"
    launcher = ops / "run-vendure"
    old_drop = DROP.read_text()
    require(old_drop.count("ExecStart=" + str(old_launcher)) == 1, "gateway_service_launcher_mismatch")
    candidate = stage_launcher(old_launcher.read_text(), previous, sha, refresh=refresh, retry_receipt=retry_receipt,
                               partner_api=partner_api)
    if launcher.exists():
        require(not launcher.is_symlink() and launcher.read_text() == candidate, "gateway_candidate_launcher_changed")
    else:
        write_new(launcher, candidate, 0o755)
    run(["bash", "-n", str(launcher)])
    pending = DROP.with_name(f".moyao-admission-{sha[:12]}.conf")
    protected = {name: identity(inspect(name)) for name in PROTECTED}
    require(all(item["running"] for item in protected.values()), "original_recharge_runtime_not_ready")
    worker = worker_runtime(inspect("vendure-worker"))
    binding = worker_binding()
    if partner_api:
        prepare_partner_socket_directory()
    with paused_submission_marker(sha, refresh) as progress:
        with lock_idle_queue(STATE / SQLITE_FILENAME, retry_receipt) as retained_tasks:
            require_main(sha)
            require(DROP.read_text() == old_drop and identity(inspect("vendure")) == before,
                    "gateway_service_launcher_changed")
            progress["switch_started"] = True
            run(["systemctl", "stop", UNIT], timeout=45)
            require(not (STATE / "vendure-task-service.lock").exists(), "old_gateway_did_not_close_cleanly")
            write_new(pending, old_drop.replace(str(old_launcher), str(launcher)), 0o644)
            os.replace(pending, DROP)
            run(["systemctl", "daemon-reload"])
        run(["systemctl", "start", UNIT], timeout=45)
        for _ in range(12):
            try:
                current = read_gateway(sha, source, before["image"], retry_receipt, partner_api)
                break
            except (ReleaseError, subprocess.CalledProcessError, FileNotFoundError):
                time.sleep(1)
        else:
            raise ReleaseError("new_gateway_readback_failed")
        resume_worker(binding, worker, retained_tasks)
        require(all(identity(inspect(name)) == value for name, value in protected.items()),
                "original_recharge_runtime_changed")
        ready_socket()
    record = {"mainSha": sha, "gatewaySha": current["revision"], "previousGatewaySha": previous,
              "retainedTaskCount": retained_tasks, "originalRuntimeUnchanged": True,
              "workerSourceUnchanged": True, "workerPollingObserved": True, "accepting": refresh}
    if retry_receipt:
        record["singleRetryReceiptVerified"] = True
    if partner_api:
        record["partnerSocketVerified"] = True
    write_new(ops / "vendure-admission.receipt.json", json.dumps(record) + "\n", 0o600)
    return record


def open_submissions(sha, release):
    record = json.loads((release / "operations/vendure-admission.receipt.json").read_text())
    require(record["gatewaySha"] == sha and record["originalRuntimeUnchanged"] is True and
            record.get("workerPollingObserved") is True, "gateway_receipt_missing")
    read_gateway(sha, release / "source")
    worker_runtime(inspect("vendure-worker"))
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
    parser.add_argument("operation", choices=("cutover", "open", "refresh"))
    parser.add_argument("sha")
    options = parser.parse_args()
    require(re.fullmatch(r"[a-f0-9]{40}", options.sha), "invalid_release_revision")
    release = ROOT / "releases" / options.sha
    require(Path(__file__).resolve().parent == release / "source/deploy/website", "gateway_release_source_mismatch")
    with LOCK.open("r") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = open_submissions(options.sha, release) if options.operation == "open" else cutover(
            options.sha, release, refresh=options.operation == "refresh")
        print(json.dumps(result, sort_keys=True), flush=True)
