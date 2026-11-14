"""Publish health evidence from the existing backups and Sheets worker."""

import datetime as dt
import json
import os
import re
import stat
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path("/opt/id-business-independent")
FORMAL = ROOT / "formal"
DIRECTORY = FORMAL / "backup-monitoring/receipts"
RECHARGE = "id-business-independent-recharge-backup"
SHEETS_WORKER = "id-business-independent-sheets-sync"
SHEETS_INTEGRITY_CODES = {
    "SHEETS_HEADER_MISMATCH", "SHEETS_TAB_MISSING", "SHEETS_TARGET_INVALID",
    "SHEETS_TARGET_NOT_PRIVATE", "SHEETS_SOURCE_KEY_INVALID", "SHEETS_SOURCE_REPLACED",
}


def read_receipt(path, uid, limit=1024):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as file:
            info = os.fstat(file.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or
                    stat.S_IMODE(info.st_mode) != 0o600):
                return None
            raw = file.read(limit + 1)
            value = json.loads(raw) if len(raw) <= limit else None
            return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def timestamp(value):
    return type(value) is int and 0 < value <= 2**53 - 1


def drive_fields(receipt):
    if receipt is None:
        return None
    at, verified, failures, integrity = (receipt.get(key) for key in
                                         ("at", "verifiedAt", "failures", "integrityFailure"))
    if (not timestamp(at) or type(failures) is not int or failures < 0 or type(integrity) is not bool or
            (verified is not None and (not timestamp(verified) or verified > at))):
        return None
    summary = {"at": at, "verifiedAt": verified, "failures": failures, "integrityFailure": integrity}
    captured = receipt.get("capturedAt")
    if timestamp(captured) and verified is not None and captured <= verified:
        summary["capturedAt"] = captured
    return summary


def mysql_fields(receipt):
    if receipt is None:
        return None
    captured = receipt.get("capturedAt")
    verified = receipt.get("verifiedAt")
    if not isinstance(captured, str) or not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", captured):
        return None
    if not isinstance(verified, str):
        return None
    if not re.fullmatch(rf"mysql/daily/independent-recharge/{captured}/[a-f0-9]{{40}}/manifest.json",
                        str(receipt.get("key"))):
        return None
    if not re.fullmatch(r"[a-f0-9]{64}", str(receipt.get("cipherSha256"))):
        return None
    for name in ("blobVersionId", "manifestVersionId"):
        value = receipt.get(name)
        if not isinstance(value, str) or not value or value == "null":
            return None
    try:
        capture_time = dt.datetime.strptime(captured, "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
        verify_time = dt.datetime.fromisoformat(verified)
        if verify_time.tzinfo is None or capture_time > verify_time:
            return None
        result = {"capturedAt": int(capture_time.timestamp() * 1000), "verifiedAt": int(verify_time.timestamp() * 1000)}
        if "recoveryStateStatus" not in receipt:
            return result
        recovery = receipt.get("recoveryState")
        recovery_status = "capture_failed" if receipt.get("recoveryStateStatus") == "capture_failed" else "missing"
        if (receipt.get("recoveryStateStatus") == "verified" and isinstance(recovery, dict) and
                recovery.get("key") == receipt["key"].removesuffix("manifest.json") + "recovery-state.idbackup" and
                isinstance(recovery.get("versionId"), str) and recovery["versionId"] not in ("", "null") and
                re.fullmatch(r"[a-f0-9]{64}", str(recovery.get("cipherSha256"))) and
                type(recovery.get("cipherBytes")) is int and recovery["cipherBytes"] > 0):
            recovery_status = "verified"
        return {**result, "recoveryStatus": recovery_status}
    except (ValueError, OverflowError):
        return None


def sheets_fields(logs):
    events = []
    for line in logs.splitlines():
        stamp, separator, payload = line.partition(" ")
        time_parts = re.fullmatch(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z", stamp)
        if not separator or not time_parts or len(payload) > 512 or not payload.startswith("{"):
            continue
        try:
            whole_seconds = dt.datetime.fromisoformat(time_parts[1] + "+00:00").timestamp()
            milliseconds = int((time_parts[2] or "").ljust(3, "0")[:3])
            at = int(whole_seconds) * 1000 + milliseconds
            value = json.loads(payload)
        except (ValueError, OverflowError):
            continue
        if not timestamp(at) or not isinstance(value, dict):
            continue
        if value.get("status") == "verified" and set(value) == {"status", "writes", "rows"}:
            rows, writes = value["rows"], value["writes"]
            if (type(writes) is int and writes >= 0 and isinstance(rows, dict) and len(rows) == 4
                    and all(type(count) is int and count >= 0 for count in rows.values())):
                events.append((at, "verified"))
        elif value.get("status") in ("retry", "integrity-failed") and set(value) == {"status", "code"}:
            if isinstance(value["code"], str) and re.fullmatch(r"[A-Z][A-Z0-9_]{3,70}", value["code"]):
                # Older workers log integrity errors as retries.
                status = "integrity-failed" if value["code"] in SHEETS_INTEGRITY_CODES else value["status"]
                events.append((at, status))
    if not events:
        return None
    verified, failures, integrity = None, 0, False
    for at, status in sorted(events, key=lambda event: event[0]):
        if status == "verified":
            verified, failures, integrity = at, 0, False
        else:
            failures = min(failures + 1, 7)
            integrity = integrity or status == "integrity-failed"
    return {"at": at, "verifiedAt": verified, "failures": failures, "integrityFailure": integrity}


def collect_sheets(group):
    try:
        result = subprocess.run(
            ["/usr/bin/docker", "logs", "--timestamps", "--since", "24h", "--tail", "128", SHEETS_WORKER],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace", timeout=4, check=True,
        )
        report = sheets_fields(result.stdout)
        if report:
            write_receipt("sheets-status.json", report, group)
    except (OSError, ValueError, subprocess.SubprocessError):
        # Keep the last observation for freshness checks when the worker log is temporarily unreadable.
        pass


def write_receipt(name, report, group):
    with tempfile.NamedTemporaryFile(mode="w", dir=DIRECTORY, prefix=".status-", delete=False) as file:
        path = Path(file.name)
        try:
            os.fchown(file.fileno(), 0, group)
            os.fchmod(file.fileno(), 0o640)
            json.dump(report, file, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
            path.replace(DIRECTORY / name)
        finally:
            path.unlink(missing_ok=True)


def unit_status(name):
    result = subprocess.run(
        ["/usr/bin/systemctl", "show", name, "-p", "LoadState,ActiveState,UnitFileState,Result,ExecMainStatus"],
        capture_output=True, text=True, timeout=5,
    )
    if result.returncode:
        return {}
    return dict(line.split("=", 1) for line in result.stdout.splitlines())


def collect():
    site = (FORMAL / "data").lstat()
    directory = DIRECTORY.lstat()
    if (site.st_uid == 0 or not stat.S_ISDIR(site.st_mode) or DIRECTORY.resolve() != DIRECTORY or
            not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_gid != site.st_gid or
            stat.S_IMODE(directory.st_mode) != 0o750):
        raise RuntimeError("backup_monitor_directory_invalid")
    drive = drive_fields(read_receipt(FORMAL / "google-drive-backup/outbox/monitoring-backup.json", site.st_uid))
    mysql = mysql_fields(read_receipt(ROOT / "backups/scheduled-recharge/last-upload.json", 0, limit=16384))
    timer = unit_status(RECHARGE + ".timer")
    service = unit_status(RECHARGE + ".service")
    report = {
        "at": time.time_ns() // 1_000_000,
        "drive": drive,
        "mysql": mysql,
        "mysqlTimerActive": timer.get("ActiveState") == "active" and timer.get("UnitFileState") == "enabled",
        "mysqlAttemptFailed": (service.get("LoadState"), service.get("Result"), service.get("ExecMainStatus")) !=
                              ("loaded", "success", "0"),
    }
    write_receipt("backup-status.json", report, site.st_gid)
    collect_sheets(site.st_gid)


if __name__ == "__main__":
    try:
        collect()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        raise SystemExit("backup_monitor_collection_failed")
