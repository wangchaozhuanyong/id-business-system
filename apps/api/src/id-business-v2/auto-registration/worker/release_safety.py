"""Read-only release and restore proof; never imports a worker or executor.

Only the private stdin carries the existing encryption key. Stdout contains a
closed safe receipt, never SQL values, addresses, task identifiers or exceptions.
logical_summary is deliberately stdlib-only for the controller's locked read.
"""

from __future__ import annotations

import base64
from datetime import datetime
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
from typing import Any
import uuid

MAINTENANCE_FILE = ".id-release-maintenance.json"
HEALTH_KEY = "id.integration.health"
HEALTH_VALUE = "id-auto-registration-encryption-v1"
APPLE_PREFIX = "id.apple-mailbox."
APPLE_TASK_PREFIX = "id.apple-task."
BUSINESS_TABLES = ("accounts", "cpa_services", "email_services", "proxies", "registration_tasks", "settings", "sub2api_services", "tm_services")
TASK_STATUSES = ("pending", "running", "completed", "failed", "cancelled")
ENCRYPTED_COLUMNS = {
    "accounts": ("password", "access_token", "refresh_token", "id_token", "session_token", "cookies", "extra_data", "proxy_used"),
    "email_services": ("config",), "registration_tasks": ("proxy", "result"),
    "settings": ("value",), "proxies": ("username", "password"),
    "cpa_services": ("api_token",), "sub2api_services": ("api_key",), "tm_services": ("api_key",),
}
JSON_COLUMNS = {("accounts", "extra_data"), ("email_services", "config"), ("registration_tasks", "result")}
RECORD_FIELDS = {"email", "aliasId", "registrationStatus", "revision", "registrationIp", "registrationIpSource", "source", "markedAt", "operatorId", "note", "activeTaskUuid", "attemptIp", "attemptCountry", "registrationCountry", "lastTaskUuid", "lastResultKind", "taskStatus"}
OPTIONAL_RECORD_FIELDS = {"lastMailId", "consumedMailIds"}


class SafetyError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def maintenance_active(runtime_dir: Path) -> bool:
    """Absence alone opens the gate; links, unreadability and ambiguity close it."""
    try:
        os.lstat(runtime_dir / MAINTENANCE_FILE)
        return True
    except FileNotFoundError:
        try:
            return not stat.S_ISDIR(os.lstat(runtime_dir).st_mode)
        except OSError:
            return True
    except OSError:
        return True


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("ascii")


def hash_item(digest: Any, value: Any) -> None:
    encoded = canonical(value)
    digest.update(len(encoded).to_bytes(8, "big"))
    digest.update(encoded)


def sqlite_value(value: Any) -> list[str]:
    if value is None:
        return ["null"]
    if type(value) is int:
        return ["integer", str(value)]
    if type(value) is float:
        return ["real", value.hex()]
    if isinstance(value, str):
        return ["text", value]
    if isinstance(value, bytes):
        return ["blob", base64.b64encode(value).decode("ascii")]
    raise SafetyError("DATABASE_SCHEMA_INVALID")


def logical_summary(connection: sqlite3.Connection) -> dict[str, Any]:
    """Hash every business row including ciphertext, under caller's snapshot."""
    objects = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name").fetchall()
    tables = {row[1] for row in objects if row[0] == "table"}
    if not set(BUSINESS_TABLES).issubset(tables) or tables - set(BUSINESS_TABLES) - {"sqlite_sequence"}:
        raise SafetyError("DATABASE_SCHEMA_INVALID")
    schema = hashlib.sha256()
    hash_item(schema, ["id-registration-sqlite-schema-v1"])
    for item in objects:
        hash_item(schema, list(item))
    schema_hash = schema.hexdigest()
    logical = hashlib.sha256()
    hash_item(logical, ["id-registration-sqlite-logical-v1", schema_hash])
    counts: dict[str, int] = {}
    for table in sorted(tables):
        columns = connection.execute("PRAGMA table_info(" + quote_identifier(table) + ")").fetchall()
        if not columns:
            raise SafetyError("DATABASE_SCHEMA_INVALID")
        names = [column[1] for column in columns]
        primary = [column[1] for column in sorted(columns, key=lambda item: item[5]) if column[5]]
        ordering = primary or names
        hash_item(logical, ["table", table, names])
        count = 0
        sql = "SELECT " + ",".join(map(quote_identifier, names)) + " FROM " + quote_identifier(table)
        sql += " ORDER BY " + ",".join(map(quote_identifier, ordering))
        for row in connection.execute(sql):
            hash_item(logical, ["row", [sqlite_value(value) for value in row]])
            count += 1
        hash_item(logical, ["rows", count])
        if table in BUSINESS_TABLES:
            counts[table] = count
    task_counts = {status: 0 for status in TASK_STATUSES}
    try:
        for status, count in connection.execute("SELECT status,COUNT(*) FROM registration_tasks GROUP BY status"):
            if status not in task_counts or type(count) is not int:
                raise SafetyError("REGISTRATION_TASK_STATUS_UNKNOWN")
            task_counts[status] = count
    except sqlite3.Error:
        raise SafetyError("DATABASE_SCHEMA_INVALID") from None
    return {"schemaSha256": schema_hash, "logicalSha256": logical.hexdigest(), "tableCounts": counts, "taskCounts": task_counts}


def decrypt_value(value: Any, encryption_key: str) -> str:
    # Lazy import keeps logical_summary available to a stdlib-only host reader.
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if not isinstance(value, str) or not value.startswith("idenc:v1:"):
        raise SafetyError("ENCRYPTED_VALUES_INVALID")
    try:
        packed = base64.b64decode(value[9:], altchars=b"-_", validate=True)
        if len(packed) < 28:
            raise ValueError()
        cipher = AESGCM(hashlib.sha256(encryption_key.encode("utf-8")).digest())
        return cipher.decrypt(packed[:12], packed[12:], b"id-auto-registration-v1").decode("utf-8")
    except Exception:
        raise SafetyError("ENCRYPTED_VALUES_INVALID") from None


def strict_json(value: str) -> Any:
    def pairs(items):
        result = {}
        for key, item in items:
            if key in result:
                raise ValueError()
            result[key] = item
        return result
    try:
        return json.loads(value, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError):
        raise SafetyError("APPLE_RECORD_INVALID") from None


def normalized_email(value: Any) -> bool:
    return (isinstance(value, str) and value == value.strip().lower() and len(value) <= 254
            and not any(ord(character) < 33 or ord(character) == 127 for character in value)
            and bool(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value)))


def nullable_id(value: Any) -> bool:
    return value is None or (isinstance(value, str) and 0 < len(value) <= 191 and all(ord(character) >= 33 and ord(character) != 127 for character in value))


def nullable_uuid(value: Any) -> bool:
    if value is None:
        return True
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


def nullable_ip(value: Any) -> bool:
    if value is None:
        return True
    try:
        return isinstance(value, str) and str(ipaddress.ip_address(value)) == value
    except ValueError:
        return False


def nullable_date(value: Any) -> bool:
    if value is None:
        return True
    try:
        return isinstance(value, str) and datetime.fromisoformat(value.replace("Z", "+00:00")).utcoffset() is not None
    except ValueError:
        return False


def controlled(value: Any, choices: set[Any]) -> bool:
    return (value is None or isinstance(value, str)) and value in choices


def validate_record(key: str, value: Any) -> None:
    if (not isinstance(value, dict) or not RECORD_FIELDS.issubset(value)
            or set(value) - RECORD_FIELDS - OPTIONAL_RECORD_FIELDS
            or not normalized_email(value.get("email"))
            or key != APPLE_PREFIX + hashlib.sha256(value["email"].encode()).hexdigest()
            or not controlled(value.get("registrationStatus"), {"unknown", "unregistered", "registered"})
            or type(value.get("revision")) is not int or value["revision"] < 1
            or not controlled(value.get("registrationIpSource"), {None, "manual", "observed"})
            or not controlled(value.get("source"), {None, "manual", "automatic"})
            or not controlled(value.get("lastResultKind"), {None, "new_registration", "existing_account", "failed"})
            or not controlled(value.get("taskStatus"), set(TASK_STATUSES) | {None, "interrupted"})
            or not isinstance(value.get("note"), str) or len(value["note"]) > 500):
        raise SafetyError("APPLE_RECORD_INVALID")
    if (any(not nullable_id(value.get(field)) for field in ("aliasId", "operatorId", "lastMailId"))
            or any(not nullable_uuid(value.get(field)) for field in ("activeTaskUuid", "lastTaskUuid"))
            or any(not nullable_ip(value.get(field)) for field in ("registrationIp", "attemptIp"))
            or not nullable_date(value.get("markedAt"))
            or any(item is not None and (not isinstance(item, str) or not re.fullmatch(r"[A-Z]{2}", item)) for item in (value.get("attemptCountry"), value.get("registrationCountry")))):
        raise SafetyError("APPLE_RECORD_INVALID")
    consumed = value.get("consumedMailIds", [])
    if (not isinstance(consumed, list) or len(consumed) > 100
            or any(item is None or not nullable_id(item) for item in consumed)
            or len(set(consumed)) != len(consumed)
            or (value.get("lastMailId") is not None and value["lastMailId"] not in consumed)):
        raise SafetyError("APPLE_RECORD_INVALID")
    if ((value["registrationIp"] is None) != (value["registrationIpSource"] is None)
            or (value["registrationStatus"] != "registered" and value["registrationIp"] is not None)
            or (value["activeTaskUuid"] is not None and value["activeTaskUuid"] != value["lastTaskUuid"])):
        raise SafetyError("APPLE_RECORD_INVALID")


def encrypted_proof(connection: sqlite3.Connection, encryption_key: str) -> int:
    marker = connection.execute("SELECT value FROM settings WHERE key=?", (HEALTH_KEY,)).fetchone()
    try:
        if marker is None or decrypt_value(marker[0], encryption_key) != HEALTH_VALUE:
            raise SafetyError("HEALTH_MARKER_INVALID")
    except SafetyError:
        raise SafetyError("HEALTH_MARKER_INVALID") from None
    for table, names in ENCRYPTED_COLUMNS.items():
        existing = {row[1] for row in connection.execute("PRAGMA table_info(" + quote_identifier(table) + ")")}
        if not set(names).issubset(existing):
            raise SafetyError("DATABASE_SCHEMA_INVALID")
        for row in connection.execute("SELECT " + ",".join(map(quote_identifier, names)) + " FROM " + quote_identifier(table)):
            for name, value in zip(names, row):
                if value is None:
                    continue
                plain = decrypt_value(value, encryption_key)
                if (table, name) in JSON_COLUMNS:
                    try:
                        if not isinstance(strict_json(plain), dict):
                            raise ValueError()
                    except (SafetyError, ValueError):
                        raise SafetyError("ENCRYPTED_VALUES_INVALID") from None
    records = {}
    bindings = {}
    for key, value in connection.execute("SELECT key,value FROM settings"):
        if not isinstance(key, str):
            raise SafetyError("DATABASE_SCHEMA_INVALID")
        if not key.startswith((APPLE_PREFIX, APPLE_TASK_PREFIX)):
            continue
        payload = strict_json(decrypt_value(value, encryption_key))
        if key.startswith(APPLE_PREFIX):
            validate_record(key, payload)
            records[payload["email"]] = payload
        else:
            task_uuid = key[len(APPLE_TASK_PREFIX):]
            if (not nullable_uuid(task_uuid) or not isinstance(payload, dict)
                    or set(payload) != {"email", "aliasId", "resultKind"}
                    or not normalized_email(payload.get("email"))
                    or payload.get("aliasId") is None or not nullable_id(payload.get("aliasId"))
                    or not controlled(payload.get("resultKind"), {None, "new_registration", "existing_account", "failed"})):
                raise SafetyError("APPLE_RECORD_INVALID")
            bindings[task_uuid] = payload
    for binding in bindings.values():
        if binding["email"] not in records:
            raise SafetyError("APPLE_RECORD_INVALID")
    leases = 0
    for record in records.values():
        last = record["lastTaskUuid"]
        if last is not None and (last not in bindings or bindings[last]["email"] != record["email"]):
            raise SafetyError("APPLE_RECORD_INVALID")
        leases += record["activeTaskUuid"] is not None
        if record["activeTaskUuid"] is None and record["taskStatus"] in {"pending", "running"}:
            raise SafetyError("REGISTRATION_TASK_ACTIVE")
    return leases


def inspect_database(config: dict[str, Any]) -> dict[str, Any]:
    if (not isinstance(config, dict) or set(config) - {"mode", "databasePath", "encryptionKey", "expectedLogicalSha256"}
            or config.get("mode") not in {"inspect", "restore"}
            or not isinstance(config.get("databasePath"), str)
            or not isinstance(config.get("encryptionKey"), str) or len(config["encryptionKey"]) < 32
            or (config.get("expectedLogicalSha256") is not None and not re.fullmatch(r"[0-9a-f]{64}", str(config["expectedLogicalSha256"])))):
        raise SafetyError("INVALID_INPUT")
    path = Path(config["databasePath"])
    try:
        if not path.is_absolute() or ".." in path.parts:
            raise SafetyError("DATABASE_UNAVAILABLE")
        component = Path(path.anchor)
        for part in path.parts[1:]:
            component /= part
            mode = os.lstat(component).st_mode
            if stat.S_ISLNK(mode):
                raise SafetyError("DATABASE_UNAVAILABLE")
        if not stat.S_ISREG(mode):
            raise SafetyError("DATABASE_UNAVAILABLE")
        for suffix in ("-wal", "-shm", "-journal"):
            try:
                mode = os.lstat(str(path) + suffix).st_mode
                if not stat.S_ISREG(mode):
                    raise SafetyError("DATABASE_UNAVAILABLE")
            except FileNotFoundError:
                pass
        database = path.resolve(strict=True)
        uri = database.as_uri() + "?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=5)
    except (OSError, sqlite3.Error):
        raise SafetyError("DATABASE_UNAVAILABLE") from None
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        rows = connection.execute("PRAGMA integrity_check").fetchall()
        if rows != [("ok",)]:
            raise SafetyError("DATABASE_INTEGRITY_FAILED")
        summary = logical_summary(connection)
        leases = encrypted_proof(connection, config["encryptionKey"])
        if leases:
            raise SafetyError("APPLE_LEASE_ACTIVE")
        if summary["taskCounts"]["pending"] or summary["taskCounts"]["running"]:
            raise SafetyError("REGISTRATION_TASK_ACTIVE")
        expected = config.get("expectedLogicalSha256")
        if expected is not None and expected != summary["logicalSha256"]:
            raise SafetyError("LOGICAL_FINGERPRINT_MISMATCH")
        return {"version": 1, "status": "PASS", **summary, "activeAppleLeaseCount": 0,
                "corruptEncryptedValueCount": 0, "businessActions": 0}
    except sqlite3.Error:
        raise SafetyError("DATABASE_SCHEMA_INVALID") from None
    finally:
        connection.close()


def main() -> None:
    try:
        line = sys.stdin.buffer.readline(1048576)
        if not line or len(line) >= 1048576:
            raise SafetyError("INVALID_INPUT")
        config = strict_json(line.decode("utf-8"))
        result = inspect_database(config)
    except SafetyError as error:
        result = {"version": 1, "status": "FAIL", "code": error.code, "businessActions": 0}
    except BaseException:
        result = {"version": 1, "status": "FAIL", "code": "CHECK_FAILED", "businessActions": 0}
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
    raise SystemExit(0 if result["status"] == "PASS" else 2)


if __name__ == "__main__":
    main()
