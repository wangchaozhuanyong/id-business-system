"""Read-only release and restore proof; never imports a worker or executor.

Only the private stdin carries the existing encryption key. Stdout contains a
closed safe receipt, never SQL values, addresses, task identifiers or exceptions.
logical_summary is deliberately stdlib-only for the controller's locked read.
"""

from __future__ import annotations

import base64
from datetime import datetime
import hashlib
import importlib.util
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

# Release probes load this file by absolute path from outside the worker. Keep
# that existing use independent of cwd/sys.path and avoid importing an app.
_flow_spec = importlib.util.spec_from_file_location("id_registration_flow_evidence", Path(__file__).with_name("flow_evidence.py"))
_flow_module = importlib.util.module_from_spec(_flow_spec)
_flow_spec.loader.exec_module(_flow_module)
# The flow validator accepts closed v1/v2 records; validation never upgrades
# stored evidence or imports the executor/its database initialization.
validate_flow_evidence = _flow_module.validate_flow_evidence

MAINTENANCE_FILE = ".id-release-maintenance.json"
HEALTH_KEY = "id.integration.health"
HEALTH_VALUE = "id-auto-registration-encryption-v1"
APPLE_PREFIX = "id.apple-mailbox."
APPLE_TASK_PREFIX = "id.apple-task."
APPLE_BATCH_PREFIX = "id.apple-batch."
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
PUBLIC_FACT_FIELDS = {"localSaveStatus", "syncStatus", "systemAccountId", "syncErrorKind", "identityStatus", "passwordStatus", "stage", "reason", "lastHttpStatus", "proxySource", "proxyId", "mailboxSelection", "firstFailure"}
OPTIONAL_RECORD_FIELDS = {"lastMailId", "consumedMailIds", "registrationEvidenceTaskUuid", "registeredAt",
                          "manualSyncId", "creationConfirmed", "authorizationStatus"} | PUBLIC_FACT_FIELDS
TASK_FIELDS = {"email", "aliasId", "resultKind"}
OPTIONAL_TASK_FIELDS = {"operatorId", "mirrorAccountId", "attempt", "sideEffectPossible", "batchId", "startedAt", "configurationCheckpoint", "passwordCheckpoint", "passwordSavedAt", "creationConfirmed", "existingAccountIndication", "verifiedExistingAccount", "rawResult", "identityEvidence", "upstreamAccountId", "syncPayload", "syncedAt", "needsReview", "lateFacts", "schemaVersion", "provider", "creationConfirmedAt", "syncRetryCount", "syncNextRetryAt", "providerCheckpoint", "flowEvidence"} | PUBLIC_FACT_FIELDS
RESULT_FIELDS = {"success", "email", "password", "account_id", "workspace_id", "access_token", "refresh_token", "id_token", "session_token", "source", "metadata"}
RESULT_METADATA_FIELDS = {"email_service", "proxy_used", "registered_at", "is_existing_account", "idSourceTaskUuid", "idAuthorizationStatus"}
IDENTITY_FIELDS = {"source", "emailMatched", "officialUserIdHash", "observedAt"}
SYNC_FIELDS = {"accountId", "sourceTaskUuid", "upstreamAccountId", "operatorId", "aliasId", "email", "password", "registrationCountry", "source", "identityStatus", "identityEvidence", "fingerprint"}
SYNC_V2_FIELDS = {"schemaVersion", "provider", "registrationIp", "registeredAt", "creationConfirmed"}
PROVIDERS = {"apple_hidden", "tempmail", "outlook", "custom_domain", "temp_mail"}
BATCH_FIELDS = {"batchId", "operatorId", "taskUuids", "cancelled", "createdAt", "mode", "concurrency", "interval_min", "interval_max", "skipped"}
SYNC_ERRORS = {"email_conflict", "deleted_account", "storage_unavailable", "sync_failed", "identity_missing", "identity_mismatch", "local_save_failed", "payload_invalid"}
FACT_ENUMS = {
    "localSaveStatus": {"not_started", "pending", "saved", "failed"},
    "syncStatus": {"not_started", "awaiting_identity", "blocked", "quarantined", "pending", "saved", "failed", "conflict"},
    "identityStatus": {"not_verified", "awaiting_identity", "mismatch", "verified"},
    "passwordStatus": {"not_started", "saved", "submitted"},
    "stage": {"queued", "signup", "password", "verification_code", "verification_validate", "create_account", "workspace", "select_workspace", "redirect", "oauth", "identity", "account_save", "sync"},
    "reason": {None, "existing_account_suspected", "account_creation_failed", "identity_missing", "identity_mismatch", "password_missing", "email_conflict", "local_save_failed", "deleted_account"},
    "syncErrorKind": {None} | SYNC_ERRORS,
    "proxySource": {"default", "explicit", "system"},
    "mailboxSelection": {"specified", "automatic"},
}
FAILURE_FIELDS = {"stage", "errorKind", "httpStatus", "elapsedMs", "observedAt"}
FAILURE_CODES = {"http_rejected", "network_error", "unknown", "account_creation_failed", "user_exists"}


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


def bounded_text(value: Any, maximum: int, *, nullable=False, empty=True) -> bool:
    return ((nullable and value is None) or (isinstance(value, str) and len(value) <= maximum
            and (empty or bool(value)) and "\x00" not in value))


def validate_public_facts(value: dict[str, Any]) -> None:
    if (any(field in value and not controlled(value[field], choices) for field, choices in FACT_ENUMS.items())
            or ("systemAccountId" in value and not nullable_id(value["systemAccountId"]))
            or ("lastHttpStatus" in value and value["lastHttpStatus"] is not None
                and (type(value["lastHttpStatus"]) is not int or not 100 <= value["lastHttpStatus"] <= 599))):
        raise SafetyError("APPLE_RECORD_INVALID")
    if "proxyId" in value or value.get("proxySource") == "system":
        proxy_id = value.get("proxyId")
        if ((value.get("proxySource") == "system" and (not isinstance(proxy_id, str)
                or not re.fullmatch(r"[a-zA-Z0-9_-]{1,191}", proxy_id)))
                or (value.get("proxySource") != "system" and proxy_id is not None)):
            raise SafetyError("APPLE_RECORD_INVALID")
    failure = value.get("firstFailure")
    if failure is not None and (not isinstance(failure, dict) or set(failure) != FAILURE_FIELDS
            or not controlled(failure.get("stage"), FACT_ENUMS["stage"])
            or not controlled(failure.get("errorKind"), FAILURE_CODES)
            or (failure.get("httpStatus") is not None and (type(failure["httpStatus"]) is not int
                or not 100 <= failure["httpStatus"] <= 599))
            or type(failure.get("elapsedMs")) is not int or not 0 <= failure["elapsedMs"] <= 9007199254740991
            or failure.get("observedAt") is None or not nullable_date(failure["observedAt"])):
        raise SafetyError("APPLE_RECORD_INVALID")


def validate_identity(value: Any) -> None:
    if value is None:
        return
    if (not isinstance(value, dict) or set(value) != IDENTITY_FIELDS
            or not controlled(value.get("source"), {"official_session_response", "official_me_response"})
            or value.get("emailMatched") is not True
            or not isinstance(value.get("officialUserIdHash"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", value["officialUserIdHash"])
            or value.get("observedAt") is None or not nullable_date(value["observedAt"])):
        raise SafetyError("APPLE_RECORD_INVALID")


def validate_result(value: Any, task_uuid: str) -> None:
    if (not isinstance(value, dict) or set(value) != RESULT_FIELDS
            or type(value.get("success")) is not bool
            or not controlled(value.get("source"), {"register", "login"})
            or any(not bounded_text(value.get(field), 1048576, nullable=True)
                   for field in RESULT_FIELDS - {"success", "source", "metadata"})):
        raise SafetyError("APPLE_RECORD_INVALID")
    metadata = value["metadata"]
    if (not isinstance(metadata, dict) or set(metadata) - RESULT_METADATA_FIELDS
            or metadata.get("idSourceTaskUuid") != task_uuid
            or ("is_existing_account" in metadata and type(metadata["is_existing_account"]) is not bool)
            or ("idAuthorizationStatus" in metadata and metadata["idAuthorizationStatus"] not in {"pending", "complete"})
            or any(field in metadata and not bounded_text(metadata[field], 16384, nullable=True)
                   for field in ("email_service", "proxy_used", "registered_at"))):
        raise SafetyError("APPLE_RECORD_INVALID")
    # Frozen upstream stores registered_at using datetime.now().isoformat().
    if metadata.get("registered_at") is not None:
        try:
            datetime.fromisoformat(metadata["registered_at"].replace("Z", "+00:00"))
        except ValueError:
            raise SafetyError("APPLE_RECORD_INVALID") from None


def validate_sync(value: Any, task_uuid: str, binding: dict[str, Any]) -> None:
    version2 = isinstance(value, dict) and value.get("schemaVersion") == 2
    if (not isinstance(value, dict) or set(value) != (SYNC_FIELDS | SYNC_V2_FIELDS if version2 else SYNC_FIELDS)
            or value.get("sourceTaskUuid") != task_uuid
            or any(value.get(field) != binding.get(field) for field in ("email", "aliasId", "operatorId", "upstreamAccountId"))
            or value.get("accountId") != binding.get("mirrorAccountId")
            or value.get("accountId") is None or not nullable_id(value["accountId"])
            or value.get("upstreamAccountId") is None or not nullable_id(value["upstreamAccountId"])
            or not bounded_text(value.get("password"), 255)
            or not controlled(value.get("source"), {"register", "login"})
            or not controlled(value.get("identityStatus"), FACT_ENUMS["identityStatus"] | ({"creation_confirmed"} if version2 else set()))
            or (value.get("registrationCountry") is not None and (not isinstance(value["registrationCountry"], str)
                or not re.fullmatch(r"[A-Z]{2}", value["registrationCountry"])))):
        raise SafetyError("APPLE_RECORD_INVALID")
    validate_identity(value["identityEvidence"])
    fields = {field: value[field] for field in ("accountId", "sourceTaskUuid", "upstreamAccountId", "email", "registrationCountry", "source")}
    if version2:
        if (not controlled(value.get("provider"), PROVIDERS) or not nullable_ip(value.get("registrationIp"))
                or not nullable_date(value.get("registeredAt")) or type(value.get("creationConfirmed")) is not bool
                or (value["creationConfirmed"] is True and (binding.get("creationConfirmed") is not True
                    or value.get("source") != "register"))
                or (value["identityStatus"] == "creation_confirmed" and (not value["creationConfirmed"]
                    or not value.get("password") or value["password"] != binding.get("passwordCheckpoint")))):
            raise SafetyError("APPLE_RECORD_INVALID")
        fields.update({field: value[field] for field in ("schemaVersion", "provider", "registrationIp", "registeredAt",
                       "creationConfirmed", "identityStatus")})
    expected = hashlib.sha256(json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    if value.get("fingerprint") != expected:
        raise SafetyError("APPLE_RECORD_INVALID")


def validate_task(task_uuid: str, value: Any, *, late=False) -> None:
    required = {"observedAt"} if late else TASK_FIELDS
    allowed = (OPTIONAL_TASK_FIELDS - {"lateFacts", "syncPayload"}) | {"observedAt"} if late else TASK_FIELDS | OPTIONAL_TASK_FIELDS
    if (not nullable_uuid(task_uuid) or not isinstance(value, dict) or not required.issubset(value)
            or set(value) - allowed or (not late and (not normalized_email(value.get("email"))
                or value.get("aliasId") is None or not nullable_id(value["aliasId"])
                or not controlled(value.get("resultKind"), {None, "new_registration", "existing_account", "failed"})))):
        raise SafetyError("APPLE_RECORD_INVALID")
    validate_public_facts(value)
    if "flowEvidence" in value:
        try:
            validate_flow_evidence(value["flowEvidence"])
        except (ValueError, TypeError):
            raise SafetyError("APPLE_RECORD_INVALID") from None
    if (any(field in value and not nullable_id(value[field]) for field in ("operatorId", "upstreamAccountId"))
            or any(field in value and not nullable_uuid(value[field]) for field in ("mirrorAccountId", "batchId"))
            or any(field in value and (value[field] is None or not nullable_date(value[field])) for field in ("startedAt", "passwordSavedAt", "observedAt"))
            or ("syncedAt" in value and not nullable_date(value["syncedAt"]))
            or ("attempt" in value and (type(value["attempt"]) is not int or value["attempt"] < 1))
            or any(field in value and type(value[field]) is not bool for field in ("sideEffectPossible", "creationConfirmed", "existingAccountIndication", "verifiedExistingAccount", "needsReview"))
            or ("passwordCheckpoint" in value and not bounded_text(value["passwordCheckpoint"], 255, empty=False))):
        raise SafetyError("APPLE_RECORD_INVALID")
    if (("schemaVersion" in value and value["schemaVersion"] != 2)
            or ("provider" in value and not controlled(value["provider"], PROVIDERS))
            or ("creationConfirmedAt" in value and not nullable_date(value["creationConfirmedAt"]))
            or ("syncNextRetryAt" in value and not nullable_date(value["syncNextRetryAt"]))
            or ("syncRetryCount" in value and (type(value["syncRetryCount"]) is not int or not 0 <= value["syncRetryCount"] <= 3))):
        raise SafetyError("APPLE_RECORD_INVALID")
    if "providerCheckpoint" in value:
        snapshot = value["providerCheckpoint"]
        if (not isinstance(snapshot, dict) or set(snapshot) != {"serviceType", "config", "emailInfo"}
                or not controlled(snapshot.get("serviceType"), PROVIDERS - {"apple_hidden"})
                or not isinstance(snapshot.get("config"), dict) or not isinstance(snapshot.get("emailInfo"), dict)
                or len(canonical(snapshot)) > 1048576 or snapshot["emailInfo"].get("email", "").strip().lower() != value["email"]):
            raise SafetyError("APPLE_RECORD_INVALID")
    if "configurationCheckpoint" in value:
        checkpoint = value["configurationCheckpoint"]
        if (not isinstance(checkpoint, dict) or set(checkpoint) != {"clientId", "proxyUsed"}
                or not bounded_text(checkpoint.get("clientId"), 255, empty=False)
                or not bounded_text(checkpoint.get("proxyUsed"), 16384, nullable=True)):
            raise SafetyError("APPLE_RECORD_INVALID")
    if "identityEvidence" in value:
        validate_identity(value["identityEvidence"])
    if "rawResult" in value:
        validate_result(value["rawResult"], task_uuid)
    if "syncPayload" in value:
        validate_sync(value["syncPayload"], task_uuid, value)
    if "lateFacts" in value:
        facts = value["lateFacts"]
        if not isinstance(facts, list) or len(facts) > 4:
            raise SafetyError("APPLE_RECORD_INVALID")
        for fact in facts:
            validate_task(task_uuid, fact, late=True)


def validate_batch(batch_id: str, value: Any) -> None:
    if (not nullable_uuid(batch_id) or not isinstance(value, dict) or set(value) != BATCH_FIELDS
            or value.get("batchId") != batch_id or value.get("operatorId") is None or not nullable_id(value["operatorId"])
            or type(value.get("cancelled")) is not bool
            or value.get("createdAt") is None or not nullable_date(value["createdAt"])
            or not controlled(value.get("mode"), {"pipeline", "parallel"})
            or type(value.get("concurrency")) is not int or not 1 <= value["concurrency"] <= 50
            or any(type(value.get(field)) is not int or not 0 <= value[field] <= 3600 for field in ("interval_min", "interval_max"))
            or value["interval_max"] < value["interval_min"]):
        raise SafetyError("APPLE_RECORD_INVALID")
    tasks, skipped = value.get("taskUuids"), value.get("skipped")
    if (not isinstance(tasks, list) or not 1 <= len(tasks) <= 100
            or any(item is None or not nullable_uuid(item) for item in tasks) or len(set(tasks)) != len(tasks)
            or not isinstance(skipped, list) or len(skipped) > 100
            or any(not isinstance(item, dict) or set(item) != {"aliasId", "reason"}
                or item.get("aliasId") is None or not nullable_id(item["aliasId"])
                or item.get("reason") != "mailbox_unavailable" for item in skipped)):
        raise SafetyError("APPLE_RECORD_INVALID")


def validate_record(key: str, value: Any) -> None:
    if (not isinstance(value, dict) or not RECORD_FIELDS.issubset(value)
            or set(value) - RECORD_FIELDS - OPTIONAL_RECORD_FIELDS
            or not normalized_email(value.get("email"))
            or key != APPLE_PREFIX + hashlib.sha256(value["email"].encode()).hexdigest()
            or not controlled(value.get("registrationStatus"), {"unknown", "unregistered", "registered"})
            or type(value.get("revision")) is not int or value["revision"] < 1
            or not controlled(value.get("registrationIpSource"), {None, "manual", "observed"})
            or not controlled(value.get("source"), {None, "manual", "automatic", "account_history"})
            or not controlled(value.get("lastResultKind"), {None, "new_registration", "existing_account", "failed"})
            or not controlled(value.get("taskStatus"), set(TASK_STATUSES) | {None, "interrupted", "awaiting_review"})
            or not isinstance(value.get("note"), str) or len(value["note"]) > 500):
        raise SafetyError("APPLE_RECORD_INVALID")
    validate_public_facts(value)
    if (any(not nullable_id(value.get(field)) for field in ("aliasId", "operatorId", "lastMailId"))
            or any(not nullable_uuid(value.get(field)) for field in ("activeTaskUuid", "lastTaskUuid", "registrationEvidenceTaskUuid"))
            or any(not nullable_ip(value.get(field)) for field in ("registrationIp", "attemptIp"))
            or not nullable_date(value.get("markedAt")) or not nullable_date(value.get("registeredAt"))
            or not nullable_uuid(value.get("manualSyncId"))
            or ("creationConfirmed" in value and type(value["creationConfirmed"]) is not bool)
            or not controlled(value.get("authorizationStatus"), {None, "pending", "complete"})
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
    batches = {}
    for key, value in connection.execute("SELECT key,value FROM settings"):
        if not isinstance(key, str):
            raise SafetyError("DATABASE_SCHEMA_INVALID")
        if not key.startswith((APPLE_PREFIX, APPLE_TASK_PREFIX, APPLE_BATCH_PREFIX)):
            continue
        payload = strict_json(decrypt_value(value, encryption_key))
        if key.startswith(APPLE_PREFIX):
            validate_record(key, payload)
            records[payload["email"]] = payload
        elif key.startswith(APPLE_TASK_PREFIX):
            task_uuid = key[len(APPLE_TASK_PREFIX):]
            validate_task(task_uuid, payload)
            bindings[task_uuid] = payload
        else:
            batch_id = key[len(APPLE_BATCH_PREFIX):]
            validate_batch(batch_id, payload)
            batches[batch_id] = payload
    for task_uuid, binding in bindings.items():
        if binding["email"] not in records:
            raise SafetyError("APPLE_RECORD_INVALID")
        batch_id = binding.get("batchId")
        if batch_id is not None and (batch_id not in batches or task_uuid not in batches[batch_id]["taskUuids"]
                or binding.get("operatorId") != batches[batch_id]["operatorId"]):
            raise SafetyError("APPLE_RECORD_INVALID")
    for batch_id, batch in batches.items():
        if any(task_uuid not in bindings or bindings[task_uuid].get("batchId") != batch_id for task_uuid in batch["taskUuids"]):
            raise SafetyError("APPLE_RECORD_INVALID")
    leases = 0
    for record in records.values():
        last = record["lastTaskUuid"]
        if last is not None and (last not in bindings or bindings[last]["email"] != record["email"]):
            raise SafetyError("APPLE_RECORD_INVALID")
        evidence = record.get("registrationEvidenceTaskUuid")
        if evidence is not None:
            fact = bindings.get(evidence, {})
            if (fact.get("email") != record["email"] or not (fact.get("creationConfirmed") is True
                    or fact.get("resultKind") == "new_registration" or fact.get("verifiedExistingAccount") is True
                    or (fact.get("identityStatus") == "verified" and (fact.get("rawResult") or {}).get("source") == "login"))):
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
