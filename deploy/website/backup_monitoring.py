"""Publish only the health fields from the two existing backup receipts."""

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


def read_receipt(path, uid):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as file:
            info = os.fstat(file.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or
                    stat.S_IMODE(info.st_mode) != 0o600):
                return None
            raw = file.read(1025)
            value = json.loads(raw) if len(raw) <= 1024 else None
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
    return {"at": at, "verifiedAt": verified, "failures": failures, "integrityFailure": integrity}


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
        return {"capturedAt": int(capture_time.timestamp() * 1000), "verifiedAt": int(verify_time.timestamp() * 1000)}
    except (ValueError, OverflowError):
        return None


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
    mysql = mysql_fields(read_receipt(ROOT / "backups/scheduled-recharge/last-upload.json", 0))
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
    with tempfile.NamedTemporaryFile(mode="w", dir=DIRECTORY, prefix=".status-", delete=False) as file:
        path = Path(file.name)
        try:
            os.fchown(file.fileno(), 0, site.st_gid)
            os.fchmod(file.fileno(), 0o640)
            json.dump(report, file, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
            path.replace(DIRECTORY / "backup-status.json")
        finally:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        collect()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        raise SystemExit("backup_monitor_collection_failed")
