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
import unittest
from unittest.mock import patch
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_safety as safety
import workspace


class ReleaseSafetyTests(unittest.TestCase):
    def setUp(self):
        output = workspace.PROJECT_ROOT / ".runtime/apple-hidden-mailbox-20261009"
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
        output = workspace.PROJECT_ROOT / ".runtime/apple-hidden-mailbox-20261009"
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
