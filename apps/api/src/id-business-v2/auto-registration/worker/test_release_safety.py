"""Synthetic read-only backup/restore and maintenance-fence acceptance."""

import asyncio
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_safety as safety
import workspace


class ReleaseSafetyTests(unittest.TestCase):
    def setUp(self):
        output = workspace.PROJECT_ROOT / ".runtime/registration-closed-loop-20261011"
        output.mkdir(exist_ok=True, parents=True)
        self.directory = tempfile.TemporaryDirectory(prefix="release-safety-", dir=output)
        self.root = Path(self.directory.name)
        self.path = self.root / "database.db"
        self.key = secrets.token_urlsafe(48)
        self.email = "offline-sensitive-alias@example.invalid"
        self.uuid = str(uuid.uuid4())
        self.make_database()

    def tearDown(self):
        self.directory.cleanup()

    def encrypt(self, value, key=None):
        nonce = secrets.token_bytes(12)
        packed = AESGCM(hashlib.sha256((key or self.key).encode()).digest()).encrypt(nonce, value.encode(), b"id-auto-registration-v1")
        return "idenc:v1:" + base64.urlsafe_b64encode(nonce + packed).decode()

    def make_database(self):
        with sqlite3.connect(self.path) as db:
            for table, fields in safety.ENCRYPTED_COLUMNS.items():
                if table == "settings":
                    db.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
                    db.execute("INSERT INTO settings VALUES (?,?)", (safety.HEALTH_KEY, self.encrypt(safety.HEALTH_VALUE)))
                    continue
                extra = ",task_uuid TEXT UNIQUE,status TEXT,logs TEXT" if table == "registration_tasks" else ""
                names = ",".join('"' + name + '" TEXT' for name in fields)
                db.execute('CREATE TABLE "' + table + '" (id INTEGER PRIMARY KEY,' + names + extra + ")")
                values = [self.encrypt("{}" if (table, field) in safety.JSON_COLUMNS else "offline-sensitive-column-" + field) for field in fields]
                columns = list(fields)
                if table == "registration_tasks":
                    columns += ["task_uuid", "status", "logs"]
                    values += [self.uuid, "completed", "普通离线日志"]
                db.execute('INSERT INTO "' + table + '" (' + ",".join('"' + name + '"' for name in columns) + ") VALUES (" + ",".join("?" for _ in values) + ")", values)

    def input(self, **updates):
        return {"mode": "inspect", "databasePath": str(self.path), "encryptionKey": self.key, **updates}

    def receipt(self, **updates):
        result = subprocess.run([sys.executable, "-B", str(Path(safety.__file__))],
                                input=json.dumps(self.input(**updates)) + "\n", capture_output=True, text=True)
        self.assertEqual(result.stderr, "")
        parsed = json.loads(result.stdout)
        for value in (self.key, self.email, self.uuid, str(self.path), "offline-sensitive-column"):
            self.assertNotIn(value, result.stdout)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        return result.returncode, parsed

    def assert_blocked(self, code, **updates):
        exit_code, result = self.receipt(**updates)
        self.assertEqual(exit_code, 2)
        self.assertEqual(result, {"version": 1, "status": "FAIL", "code": code, "businessActions": 0})

    def record(self, **updates):
        return {"email": self.email, "aliasId": "offline-alias", "registrationStatus": "unknown", "revision": 1,
                "registrationIp": None, "registrationIpSource": None, "source": "manual", "markedAt": "2026-10-09T00:00:00Z",
                "operatorId": "offline-admin", "note": "离线备注", "activeTaskUuid": None, "attemptIp": None,
                "attemptCountry": None, "registrationCountry": None, "lastTaskUuid": None,
                "lastResultKind": None, "taskStatus": None, **updates}

    def apple_setting(self, record=None, raw=None, key=None):
        record = record or self.record()
        key = key or safety.APPLE_PREFIX + hashlib.sha256(self.email.encode()).hexdigest()
        with sqlite3.connect(self.path) as db:
            db.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (key, self.encrypt(raw if raw is not None else json.dumps(record))))

    def binding(self, **updates):
        with sqlite3.connect(self.path) as db:
            db.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (safety.APPLE_TASK_PREFIX + self.uuid,
                self.encrypt(json.dumps({"email": self.email, "aliasId": "offline-alias", "resultKind": None, **updates}))))

    def closed_task(self, **updates):
        identity = {"source": "official_me_response", "emailMatched": True,
                    "officialUserIdHash": "a" * 64, "observedAt": "2026-10-11T00:00:00Z"}
        result = {field: "" for field in safety.RESULT_FIELDS}
        result.update(success=True, email=self.email, source="register", password="offline-checkpoint",
                      metadata={"email_service": "apple_hidden", "proxy_used": None,
                                "registered_at": "2026-10-11T00:00:00", "is_existing_account": False,
                                "idSourceTaskUuid": self.uuid})
        return {"email": self.email, "aliasId": "offline-alias", "operatorId": "offline-admin",
                "resultKind": "new_registration", "mirrorAccountId": str(uuid.uuid4()), "attempt": 1,
                "localSaveStatus": "saved", "syncStatus": "awaiting_identity", "stage": "sync",
                "sideEffectPossible": True, "batchId": None, "startedAt": "2026-10-11T00:00:00Z",
                "configurationCheckpoint": {"clientId": "offline-client", "proxyUsed": None},
                "passwordCheckpoint": "offline-checkpoint", "passwordSavedAt": "2026-10-11T00:00:00Z",
                "passwordStatus": "submitted", "creationConfirmed": True,
                "existingAccountIndication": False, "verifiedExistingAccount": False,
                "rawResult": result, "identityStatus": "verified", "identityEvidence": identity,
                "reason": None, "lastHttpStatus": 200, "upstreamAccountId": "1",
                "proxySource": "default", "proxyId": None, "mailboxSelection": "specified", "firstFailure": None,
                "systemAccountId": None, "syncErrorKind": None, "syncedAt": None,
                "needsReview": False, "lateFacts": [{"observedAt": "2026-10-11T00:00:00Z", "stage": "sync", "rawResult": result}],
                **updates}

    def closed_fixture(self, **updates):
        task = self.closed_task(**updates)
        self.apple_setting(self.record(registrationStatus="registered", source="automatic", lastTaskUuid=self.uuid,
            lastResultKind="new_registration", taskStatus="completed", registrationEvidenceTaskUuid=self.uuid,
            **{field: task[field] for field in safety.PUBLIC_FACT_FIELDS}))
        self.binding(**task)
        return task

    def batch_fixture(self, task, **updates):
        batch_id = str(uuid.uuid4())
        task["batchId"] = batch_id
        self.binding(**task)
        batch = {"batchId": batch_id, "operatorId": "offline-admin", "taskUuids": [self.uuid],
                 "cancelled": False, "createdAt": "2026-10-11T00:00:00Z", "mode": "pipeline",
                 "concurrency": 1, "interval_min": 0, "interval_max": 1,
                 "skipped": [{"aliasId": "offline-skipped", "reason": "mailbox_unavailable"}], **updates}
        self.apple_setting(record=batch, key=safety.APPLE_BATCH_PREFIX + batch_id)
        return batch_id, batch

    def sync_fixture(self, task):
        sync = {"accountId": task["mirrorAccountId"], "sourceTaskUuid": self.uuid,
                "upstreamAccountId": "1", "operatorId": task["operatorId"], "aliasId": task["aliasId"],
                "email": self.email, "password": task["passwordCheckpoint"], "registrationCountry": None,
                "source": "register", "identityStatus": "verified", "identityEvidence": task["identityEvidence"]}
        fields = {field: sync[field] for field in ("accountId", "sourceTaskUuid", "upstreamAccountId", "email", "registrationCountry", "source")}
        sync["fingerprint"] = hashlib.sha256(json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        return sync

    def test_valid_receipt_is_closed_and_does_not_modify_database(self):
        self.apple_setting()
        before, modified = self.path.read_bytes(), self.path.stat().st_mtime_ns
        exit_code, result = self.receipt()
        self.assertEqual(exit_code, 0)
        self.assertEqual(set(result), {"version", "status", "schemaSha256", "logicalSha256", "tableCounts", "taskCounts", "activeAppleLeaseCount", "corruptEncryptedValueCount", "businessActions"})
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(set(result["tableCounts"]), set(safety.BUSINESS_TABLES))
        self.assertEqual(result["taskCounts"], {"pending": 0, "running": 0, "completed": 1, "failed": 0, "cancelled": 0})
        self.assertEqual(result["activeAppleLeaseCount"], 0)
        self.assertEqual(result["corruptEncryptedValueCount"], 0)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.path.stat().st_mtime_ns, modified)
        self.assertEqual({path.name for path in self.root.iterdir()}, {"database.db"})

    def test_closed_loop_record_checkpoint_batch_and_sync_payload_restore(self):
        task = self.closed_fixture()
        task["syncPayload"] = self.sync_fixture(task)
        self.batch_fixture(task)
        source = safety.inspect_database(self.input())
        copied = self.root / "closed-loop-backup.db"
        with sqlite3.connect(self.path) as db, sqlite3.connect(copied) as backup:
            db.backup(backup)
        before = copied.read_bytes()
        exit_code, restored = self.receipt(mode="restore", databasePath=str(copied), expectedLogicalSha256=source["logicalSha256"])
        self.assertEqual(exit_code, 0)
        self.assertEqual(source["logicalSha256"], restored["logicalSha256"])
        self.assertEqual(before, copied.read_bytes())
        for value in (self.email, task["passwordCheckpoint"]):
            self.assertFalse(value.encode() in self.path.read_bytes(), "敏感资料未加密")

    def test_closed_loop_enums_and_history_source_are_accepted(self):
        for field, values in safety.FACT_ENUMS.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    self.apple_setting(self.record(source="account_history", **{field: value},
                        **({"proxyId": "offline-proxy"} if field == "proxySource" and value == "system" else {})))
                    self.assertEqual(self.receipt()[0], 0)
        self.apple_setting(self.record(taskStatus="awaiting_review"))
        self.assertEqual(self.receipt()[0], 0)

    def test_closed_loop_unknown_fields_are_rejected_at_each_nested_boundary(self):
        for target in ("record", "task", "configurationCheckpoint", "rawResult", "metadata", "identityEvidence", "lateFacts", "batch", "skipped"):
            with self.subTest(target=target):
                task = self.closed_fixture()
                if target == "record":
                    self.apple_setting(self.record(password="unexpected-sensitive-field"))
                elif target in {"batch", "skipped"}:
                    batch_id, batch = self.batch_fixture(task)
                    (batch if target == "batch" else batch["skipped"][0])["unexpected"] = "value"
                    self.apple_setting(record=batch, key=safety.APPLE_BATCH_PREFIX + batch_id)
                else:
                    selected = task if target == "task" else (task["rawResult"]["metadata"] if target == "metadata"
                        else task["lateFacts"][0] if target == "lateFacts" else task[target])
                    selected["unexpected"] = "value"
                    self.binding(**task)
                self.assert_blocked("APPLE_RECORD_INVALID")
                with sqlite3.connect(self.path) as db:
                    db.execute("DELETE FROM settings WHERE key LIKE ?", (safety.APPLE_BATCH_PREFIX + "%",))

    def test_first_failure_and_selected_proxy_survive_backup_restore(self):
        task = self.closed_fixture(proxySource="system", proxyId="offline-proxy", mailboxSelection="automatic",
            firstFailure={"stage": "workspace", "errorKind": "http_rejected", "httpStatus": 403,
                          "elapsedMs": 1500, "observedAt": "2026-10-11T00:00:00Z"})
        source = safety.inspect_database(self.input())
        copied = self.root / "diagnostic-backup.db"
        with sqlite3.connect(self.path) as db, sqlite3.connect(copied) as backup:
            db.backup(backup)
        exit_code, restored = self.receipt(mode="restore", databasePath=str(copied), expectedLogicalSha256=source["logicalSha256"])
        self.assertEqual(exit_code, 0)
        self.assertEqual(source["logicalSha256"], restored["logicalSha256"])
        self.assertFalse(task["proxyId"].encode() in copied.read_bytes())

    def test_first_failure_rejects_raw_values_extra_fields_and_invalid_numbers(self):
        valid = {"stage": "create_account", "errorKind": "account_creation_failed", "httpStatus": 400,
                 "elapsedMs": 1500, "observedAt": "2026-10-11T00:00:00Z"}
        for updates in ({"stage": "raw stage"}, {"errorKind": "secret server message"}, {"response": "raw body"},
                        {"httpStatus": True}, {"httpStatus": 600}, {"elapsedMs": True}, {"elapsedMs": -1},
                        {"elapsedMs": 1.5}, {"observedAt": None}, {"observedAt": "invalid"}):
            with self.subTest(fields=list(updates)):
                self.closed_fixture(firstFailure={**valid, **updates})
                self.assert_blocked("APPLE_RECORD_INVALID")

    def test_proxy_diagnostic_source_requires_matching_safe_identifier(self):
        for updates in ({"proxySource": "arbitrary"}, {"proxySource": "system", "proxyId": None},
                        {"proxySource": "system", "proxyId": "http://user:secret@proxy.test"},
                        {"proxySource": "default", "proxyId": "offline-proxy"},
                        {"mailboxSelection": "arbitrary"}):
            with self.subTest(fields=list(updates)):
                self.closed_fixture(**updates)
                self.assert_blocked("APPLE_RECORD_INVALID")

    def test_closed_loop_invalid_types_and_new_enums_remain_rejected(self):
        invalid = [{"localSaveStatus": "arbitrary"}, {"identityStatus": []}, {"syncStatus": "done"},
                   {"stage": "password-token"}, {"reason": "raw server error"}, {"lastHttpStatus": True},
                   {"attempt": True}, {"creationConfirmed": 1}, {"mirrorAccountId": "bad"},
                   {"passwordCheckpoint": ""}, {"configurationCheckpoint": {"clientId": "x", "proxyUsed": [], "password": "bad"}},
                   {"lateFacts": [{"observedAt": "bad", "stage": "sync"}]}, {"lateFacts": [{}] * 5}]
        for updates in invalid:
            with self.subTest(fields=list(updates)):
                self.closed_fixture(**updates)
                self.assert_blocked("APPLE_RECORD_INVALID")

    def test_fact_index_and_batch_references_are_validated(self):
        task = self.closed_fixture()
        self.apple_setting(self.record(registrationEvidenceTaskUuid=str(uuid.uuid4())))
        self.assert_blocked("APPLE_RECORD_INVALID")
        task = self.closed_fixture(creationConfirmed=False, resultKind="failed", identityStatus="not_verified")
        self.assert_blocked("APPLE_RECORD_INVALID")
        task = self.closed_fixture()
        batch_id, batch = self.batch_fixture(task)
        self.assertEqual(self.receipt()[0], 0)
        batch["taskUuids"] = [str(uuid.uuid4())]
        self.apple_setting(record=batch, key=safety.APPLE_BATCH_PREFIX + batch_id)
        self.assert_blocked("APPLE_RECORD_INVALID")

    def test_sync_payload_exact_fields_fingerprint_and_binding_are_required(self):
        for updates in ({"unexpected": "value"}, {"email": "other@example.invalid"}, {"sourceTaskUuid": str(uuid.uuid4())},
                        {"accountId": str(uuid.uuid4())}, {"fingerprint": "0" * 64}, {"password": []},
                        {"identityEvidence": {"source": "unsigned_jwt", "emailMatched": True}}):
            with self.subTest(fields=list(updates)):
                task = self.closed_fixture()
                task["syncPayload"] = {**self.sync_fixture(task), **updates}
                self.binding(**task)
                self.assert_blocked("APPLE_RECORD_INVALID")

    def test_batch_types_and_bounds_are_required(self):
        for updates in ({"cancelled": 1}, {"concurrency": True}, {"concurrency": 51}, {"interval_min": -1},
                        {"interval_max": 3601}, {"interval_min": 2, "interval_max": 1}, {"mode": "unknown"},
                        {"taskUuids": [self.uuid, self.uuid]}, {"skipped": [{"aliasId": "offline", "reason": "server secret"}]}):
            with self.subTest(fields=list(updates)):
                with sqlite3.connect(self.path) as db:
                    db.execute("DELETE FROM settings WHERE key LIKE ?", (safety.APPLE_BATCH_PREFIX + "%",))
                task = self.closed_fixture()
                self.batch_fixture(task, **updates)
                self.assert_blocked("APPLE_RECORD_INVALID")
    def test_closed_loop_settings_must_be_encrypted_and_awaiting_review_still_blocks(self):
        task = self.closed_fixture()
        batch_id, batch = self.batch_fixture(task)
        for key, payload in ((safety.APPLE_TASK_PREFIX + self.uuid, task), (safety.APPLE_BATCH_PREFIX + batch_id, batch)):
            with sqlite3.connect(self.path) as db:
                original = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()[0]
                db.execute("UPDATE settings SET value=? WHERE key=?", (json.dumps(payload), key))
            self.assert_blocked("ENCRYPTED_VALUES_INVALID")
            with sqlite3.connect(self.path) as db:
                db.execute("UPDATE settings SET value=? WHERE key=?", (original, key))
        self.apple_setting(self.record(activeTaskUuid=self.uuid, lastTaskUuid=self.uuid, taskStatus="awaiting_review"))
        self.assert_blocked("APPLE_LEASE_ACTIVE")

    def test_actual_worker_model_sqlite_backup_and_restore_remain_read_only(self):
        from fastapi.testclient import TestClient
        runtime = self.root / "actual-worker"
        key = secrets.token_urlsafe(48)
        token = secrets.token_urlsafe(32)
        captured = {}
        with patch.dict(os.environ), patch("curl_cffi.requests.Session.request", side_effect=AssertionError("离线验收禁止网络")):
            app = workspace.create_workspace_app({"runtimeDir": str(runtime), "internalToken": token, "encryptionKey": key})
            sessions = importlib.import_module("src.database.session")
            models = importlib.import_module("src.database.models")
            apple = importlib.import_module("apple_mailboxes")
            try:
                with TestClient(app):
                    store = app.state.apple_mailboxes.store
                    task_uuid = str(uuid.uuid4())
                    email = "actual-model-closed-loop@example.invalid"
                    request = apple.StartInput(aliasId="offline-actual-alias", email=email, revision=0, operatorId="offline-admin",
                        options={"proxySource": "system", "proxyId": "offline-proxy", "mailboxSelection": "automatic"})
                    store.reserve(request, task_uuid)
                    password = store.password_checkpoint(task_uuid, lambda: "offline-actual-password")
                    store.configuration_checkpoint(task_uuid, "offline-client", "http://offline-proxy-user:offline-proxy-secret@127.0.0.1:1234")
                    store.registered(email, task_uuid, existing=False)
                    store.record_failure(task_uuid, "workspace", "http_rejected", 403, 1500)
                    identity = {"identityStatus": "verified", "reason": None, "identityEvidence": {
                        "source": "official_me_response", "emailMatched": True,
                        "officialUserIdHash": "b" * 64, "observedAt": "2026-10-11T00:00:00Z"}}
                    result = SimpleNamespace(success=True, email=email, password=password, account_id="offline-account",
                        workspace_id="offline-workspace", access_token="offline-complete-access", refresh_token="offline-complete-refresh",
                        id_token="offline-complete-id", session_token="offline-complete-session", source="register",
                        metadata={"email_service": "apple_hidden", "proxy_used": None, "registered_at": "2026-10-11T00:00:00", "is_existing_account": False})
                    self.assertTrue(store.capture_result(task_uuid, result, identity))
                    with sessions.get_db() as db:
                        account = models.Account(email=email, password=password, access_token=result.access_token,
                            refresh_token=result.refresh_token, id_token=result.id_token, session_token=result.session_token,
                            email_service="apple_hidden", extra_data={"idSourceTaskUuid": task_uuid})
                        db.add(account)
                        db.commit()
                        db.refresh(account)
                        account = SimpleNamespace(id=account.id, email=account.email, extra_data=account.extra_data)
                    self.assertTrue(store.account_saved(task_uuid, account, identity))
                    with sessions.get_db() as db:
                        _, task = store.task_data(db, task_uuid)
                        mirror_id = task["mirrorAccountId"]
                    self.assertTrue(store.sync_ack(task_uuid, mirror_id, "saved",
                        payload_fingerprint=task["syncPayload"]["fingerprint"])["accepted"])
                    batch_id = str(uuid.uuid4())
                    with sessions.get_db() as db:
                        binding, task = store.task_data(db, task_uuid)
                        task["batchId"] = batch_id
                        binding.value = json.dumps(task)
                        db.add(models.Setting(key=safety.APPLE_BATCH_PREFIX + batch_id, category="general", description="离线批次夹具",
                            value=json.dumps({"batchId": batch_id, "operatorId": "offline-admin", "taskUuids": [task_uuid],
                                "cancelled": False, "createdAt": "2026-10-11T00:00:00Z", "mode": "parallel",
                                "concurrency": 1, "interval_min": 0, "interval_max": 0, "skipped": []})))
                        db.add(models.Setting(key=safety.APPLE_PREFIX + hashlib.sha256(self.email.encode()).hexdigest(), category="general",
                            description="旧登记夹具", value=json.dumps(self.record())))
                        db.query(models.RegistrationTask).filter_by(task_uuid=task_uuid).one().status = "completed"
                        db.commit()
                    store.finish(email, task_uuid, False)
                    source_path = runtime / "database.db"
                    config = {"mode": "inspect", "databasePath": str(source_path), "encryptionKey": key}
                    before = source_path.read_bytes()
                    captured["source"] = safety.inspect_database(config)
                    self.assertEqual(source_path.read_bytes(), before)
                    backup_path = self.root / "actual-worker-backup.db"
                    with sqlite3.connect(source_path) as db, sqlite3.connect(backup_path) as copied:
                        db.backup(copied)
                    backup_before = backup_path.read_bytes()
                    captured["restore"] = safety.inspect_database({**config, "mode": "restore", "databasePath": str(backup_path),
                        "expectedLogicalSha256": captured["source"]["logicalSha256"]})
                    self.assertEqual(backup_path.read_bytes(), backup_before)
                    self.assertEqual(captured["source"]["logicalSha256"], captured["restore"]["logicalSha256"])
                    for secret in (password, result.access_token, result.refresh_token, result.id_token, result.session_token, "offline-proxy-secret"):
                        self.assertFalse(secret.encode() in before, "敏感资料未加密")
                    captured.update(actualWorkerSchema=True, encryptedCheckpoint=True,
                        recordFormats=["legacy", "closed_loop", "batch"], sourceReadOnly=True, restoredReadOnly=True,
                        externalRequests=0, registrationExecutions=0)
                    evidence = workspace.PROJECT_ROOT / ".runtime/registration-closed-loop-20261011"
                    shutil.copy2(source_path, evidence / "release-safety-closed-loop-source.sqlite")
                    shutil.copy2(backup_path, evidence / "release-safety-closed-loop-backup.sqlite")
                    (evidence / "release-safety-sqlite.json").write_text(json.dumps(captured, ensure_ascii=False, indent=2) + "\n")
            finally:
                sessions.get_session_manager().engine.dispose()
                sessions._db_manager = None

    def test_wrong_key_and_missing_marker_fail_closed(self):
        self.assert_blocked("HEALTH_MARKER_INVALID", encryptionKey=secrets.token_urlsafe(48))
        with sqlite3.connect(self.path) as db:
            db.execute("DELETE FROM settings WHERE key=?", (safety.HEALTH_KEY,))
        self.assert_blocked("HEALTH_MARKER_INVALID")

    def test_other_secret_with_wrong_key_or_plaintext_is_not_hidden_by_valid_marker(self):
        for value in (self.encrypt("offline-value", key=secrets.token_urlsafe(48)), "legacy-plaintext"):
            with sqlite3.connect(self.path) as db:
                db.execute("UPDATE accounts SET password=?", (value,))
            self.assert_blocked("ENCRYPTED_VALUES_INVALID")

    def test_each_encrypted_table_and_column_is_checked(self):
        for table, columns in safety.ENCRYPTED_COLUMNS.items():
            for column in columns:
                if table == "settings":
                    continue
                with self.subTest(table=table, column=column):
                    with sqlite3.connect(self.path) as db:
                        original = db.execute('SELECT "' + column + '" FROM "' + table + '"').fetchone()[0]
                        db.execute('UPDATE "' + table + '" SET "' + column + '"=?', ("bad-cipher",))
                    self.assert_blocked("ENCRYPTED_VALUES_INVALID")
                    with sqlite3.connect(self.path) as db:
                        db.execute('UPDATE "' + table + '" SET "' + column + '"=?', (original,))

    def test_invalid_json_and_duplicate_keys_are_rejected(self):
        for raw in ("{broken", '{"email":"a","email":"b"}', '[]', '{"revision":NaN}'):
            self.apple_setting(raw=raw)
            self.assert_blocked("APPLE_RECORD_INVALID")

    def test_record_types_enums_ip_key_and_consumed_ids_are_checked(self):
        for updates in ({"revision": True}, {"registrationStatus": []}, {"taskStatus": "arbitrary"},
                        {"note": 3}, {"registrationIp": "not-ip"}, {"activeTaskUuid": "bad-uuid"},
                        {"attemptCountry": "unknown"}, {"consumedMailIds": ["mail", "mail"]}, {"extra": "value"}):
            with self.subTest(updates=list(updates)):
                self.apple_setting(self.record(**updates))
                self.assert_blocked("APPLE_RECORD_INVALID")
        self.apple_setting(self.record(email="changed@example.invalid"))
        self.assert_blocked("APPLE_RECORD_INVALID")

    def test_task_binding_types_and_missing_record_are_rejected(self):
        self.binding()
        self.assert_blocked("APPLE_RECORD_INVALID")
        self.apple_setting()
        self.binding(resultKind=["failed"])
        self.assert_blocked("APPLE_RECORD_INVALID")
        self.apple_setting(self.record(lastTaskUuid=self.uuid, taskStatus="completed"))
        self.binding(resultKind="new_registration")
        self.assertEqual(self.receipt()[0], 0)

    def test_active_lease_blocks_even_when_sql_task_is_cancelled(self):
        self.apple_setting(self.record(activeTaskUuid=self.uuid, lastTaskUuid=self.uuid, taskStatus="running"))
        self.binding()
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE registration_tasks SET status='cancelled'")
        self.assert_blocked("APPLE_LEASE_ACTIVE")

    def test_pending_running_and_unknown_status_are_blocked(self):
        for status, code in (("pending", "REGISTRATION_TASK_ACTIVE"), ("running", "REGISTRATION_TASK_ACTIVE"),
                             ("arbitrary", "REGISTRATION_TASK_STATUS_UNKNOWN"), (None, "REGISTRATION_TASK_STATUS_UNKNOWN")):
            with sqlite3.connect(self.path) as db:
                db.execute("UPDATE registration_tasks SET status=?", (status,))
            self.assert_blocked(code)

    def test_record_pending_or_running_blocks_even_if_lease_is_abnormally_absent(self):
        for status in ("pending", "running"):
            self.apple_setting(self.record(taskStatus=status))
            self.assert_blocked("REGISTRATION_TASK_ACTIVE")

    def test_historical_cancelled_is_counted_for_controllers_conservative_legacy_guard(self):
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE registration_tasks SET status='cancelled'")
        exit_code, result = self.receipt()
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["taskCounts"]["cancelled"], 1)

    def test_restored_copy_proves_same_logical_snapshot_and_remains_unmodified(self):
        source = safety.inspect_database(self.input())
        restored = self.root / "restored.db"
        with sqlite3.connect(self.path) as db, sqlite3.connect(restored) as copy:
            db.backup(copy)
        before = restored.read_bytes()
        exit_code, result = self.receipt(mode="restore", databasePath=str(restored), expectedLogicalSha256=source["logicalSha256"])
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["logicalSha256"], source["logicalSha256"])
        self.assertEqual(result["schemaSha256"], source["schemaSha256"])
        self.assertEqual(restored.read_bytes(), before)
        with sqlite3.connect(restored) as db:
            db.execute("UPDATE registration_tasks SET logs='changed fixture'")
        self.assert_blocked("LOGICAL_FINGERPRINT_MISMATCH", mode="restore", databasePath=str(restored), expectedLogicalSha256=source["logicalSha256"])

    def test_every_table_data_change_changes_logical_digest(self):
        with sqlite3.connect(self.path) as db:
            before = safety.logical_summary(db)
            db.execute("UPDATE tm_services SET api_key=?", (self.encrypt("changed-fixture"),))
            after = safety.logical_summary(db)
        self.assertNotEqual(before["logicalSha256"], after["logicalSha256"])
        self.assertEqual(before["schemaSha256"], after["schemaSha256"])

    def test_helper_and_read_snapshot_work_while_controller_holds_immediate_write_fence(self):
        with sqlite3.connect(self.path) as fence:
            fence.execute("BEGIN IMMEDIATE")
            source = safety.logical_summary(fence)
            exit_code, result = self.receipt()
            self.assertEqual(exit_code, 0)
            self.assertEqual(result["logicalSha256"], source["logicalSha256"])
            fence.rollback()

    def test_unknown_schema_and_missing_required_column_fail(self):
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE unreviewed_business (id INTEGER)")
        self.assert_blocked("DATABASE_SCHEMA_INVALID")
        with sqlite3.connect(self.path) as db:
            db.execute("DROP TABLE unreviewed_business")
            db.execute("ALTER TABLE accounts DROP COLUMN password")
        self.assert_blocked("DATABASE_SCHEMA_INVALID")

    def test_missing_corrupt_database_and_symlink_paths_fail_closed(self):
        self.assert_blocked("DATABASE_UNAVAILABLE", databasePath=str(self.root / "missing.db"))
        linked = self.root / "linked.db"
        linked.symlink_to(self.path)
        self.assert_blocked("DATABASE_UNAVAILABLE", databasePath=str(linked))
        parent = self.root / "linked-parent"
        parent.symlink_to(self.root, target_is_directory=True)
        self.assert_blocked("DATABASE_UNAVAILABLE", databasePath=str(parent / "database.db"))
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = Path(str(self.path) + suffix)
            sidecar.symlink_to(self.path)
            self.assert_blocked("DATABASE_UNAVAILABLE")
            sidecar.unlink()
        corrupt = self.root / "corrupt.db"
        corrupt.write_bytes(b"offline not sqlite")
        self.assert_blocked("DATABASE_SCHEMA_INVALID", databasePath=str(corrupt))

    def test_invalid_input_produces_closed_failure(self):
        for updates in ({"mode": "unexpected"}, {"expectedLogicalSha256": "bad"}, {"databasePath": "relative.db"}, {"encryptionKey": "short"}):
            exit_code, result = self.receipt(**updates)
            self.assertEqual(exit_code, 2)
            self.assertEqual(set(result), {"version", "status", "code", "businessActions"})

    def test_stdlib_only_import_and_fingerprint_do_not_import_worker_crypto_or_network(self):
        script = '''import builtins,importlib.util,json,sqlite3,sys
original=builtins.__import__
def guarded(name,*args,**kwargs):
 if name.split('.')[0] in {'workspace','apple_mailboxes','fastapi','sqlalchemy','cryptography','src','socket','requests','curl_cffi'}: raise AssertionError('forbidden import')
 return original(name,*args,**kwargs)
builtins.__import__=guarded
spec=importlib.util.spec_from_file_location('pure_safety',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
db=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True); db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
summary=module.logical_summary(db); print(json.dumps({'sha':summary['logicalSha256'],'tables':len(summary['tableCounts'])})); db.close()
'''
        result = subprocess.run([sys.executable, "-B", "-c", script, str(Path(safety.__file__)), str(self.path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["tables"], len(safety.BUSINESS_TABLES))


class MaintenanceBoundaryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        output = workspace.PROJECT_ROOT / ".runtime/registration-closed-loop-20261011"
        output.mkdir(exist_ok=True, parents=True)
        self.directory = tempfile.TemporaryDirectory(prefix="maintenance-", dir=output)
        self.root = Path(self.directory.name)
        self.marker = self.root / safety.MAINTENANCE_FILE
        self.token = secrets.token_urlsafe(32)
        self.called = 0

    def tearDown(self):
        self.directory.cleanup()

    async def request(self, method="POST", token=None):
        async def app(scope, receive, send):
            self.called += 1
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": b'{"ready":true}'})
        messages = []
        async def send(message):
            messages.append(message)
        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}
        scope = {"type": "http", "method": method, "path": "/health", "headers": [(b"x-id-workspace-token", (self.token if token is None else token).encode())]}
        await workspace.WorkspaceGatewayBoundary(app, self.token, self.root)(scope, receive, send)
        return messages

    async def test_missing_marker_preserves_existing_behavior(self):
        messages = await self.request()
        self.assertEqual(messages[0]["status"], 200)
        self.assertEqual(self.called, 1)

    async def test_any_marker_blocks_writes_after_auth_but_leaves_reads(self):
        self.marker.write_text('{"version":1}')
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            messages = await self.request(method)
            self.assertEqual(messages[0]["status"], 503)
            self.assertIn("正在维护", messages[1]["body"].decode())
        self.assertEqual(self.called, 0)
        self.assertEqual((await self.request(token="incorrect"))[0]["status"], 401)
        for method in ("GET", "HEAD", "OPTIONS"):
            self.assertEqual((await self.request(method))[0]["status"], 200)

    async def test_symlink_unreadable_and_unknown_filesystem_are_fail_closed(self):
        self.marker.symlink_to(self.root / "missing-target")
        self.assertEqual((await self.request())[0]["status"], 503)
        self.marker.unlink()
        self.marker.write_text("")
        self.marker.chmod(0)
        self.assertEqual((await self.request())[0]["status"], 503)
        self.marker.chmod(0o600)
        self.marker.unlink()
        with patch.object(safety.os, "lstat", side_effect=PermissionError):
            self.assertEqual((await self.request())[0]["status"], 503)

    async def websocket(self, maintenance, create_before_cancel=False):
        mutations, outgoing = [], []
        incoming = [{"type": "websocket.connect"}, {"type": "websocket.receive", "text": '{"type":"ping"}'},
                    {"type": "websocket.receive", "text": '{"type":"cancel"}'}, {"type": "websocket.disconnect", "code": 1000}]
        if maintenance:
            self.marker.write_text("{}")
        async def receive():
            item = incoming.pop(0)
            if create_before_cancel and item.get("text") == '{"type":"cancel"}':
                self.marker.write_text("{}")
            return item
        async def send(message):
            outgoing.append(message)
        async def app(scope, receive, send):
            await receive()
            await send({"type": "websocket.accept"})
            while True:
                message = await receive()
                if message["type"] == "websocket.disconnect":
                    break
                payload = json.loads(message["text"])
                if payload["type"] == "cancel":
                    mutations.append("cancel")
                await send({"type": "websocket.send", "text": json.dumps({"type": "pong"})})
        scope = {"type": "websocket", "path": "/api/ws/task/offline", "headers": [], "subprotocols": [self.token]}
        await workspace.WorkspaceGatewayBoundary(app, self.token, self.root)(scope, receive, send)
        return mutations, outgoing

    async def test_websocket_heartbeat_is_read_only_and_cancel_is_closed_in_maintenance(self):
        mutations, outgoing = await self.websocket(True)
        self.assertEqual(mutations, [])
        self.assertTrue(any(item.get("text") == '{"type": "pong"}' for item in outgoing))
        self.assertEqual(outgoing[-1]["type"], "websocket.close")
        self.assertEqual(outgoing[-1]["code"], 1013)

    async def test_established_websocket_rechecks_new_fence_before_cancel(self):
        mutations, outgoing = await self.websocket(False, create_before_cancel=True)
        self.assertEqual(mutations, [])
        self.assertEqual(outgoing[-1]["code"], 1013)

    async def test_nonmaintenance_websocket_keeps_original_cancel_behavior(self):
        mutations, outgoing = await self.websocket(False)
        self.assertEqual(mutations, ["cancel"])
        self.assertFalse(any(item["type"] == "websocket.close" for item in outgoing))


if __name__ == "__main__":
    unittest.main()
