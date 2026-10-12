"""Test-only SQLite half of the joint acceptance; private JSON pipes only.

The frozen engine, password checkpoint, original account save and original
parallel scheduler execute unchanged. External HTTP responses are synthetic.
Never run this driver against an existing runtime directory.
"""

from contextlib import ExitStack
import builtins
import importlib
import json
import logging
from pathlib import Path
import secrets
import signal
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import traceback
from types import SimpleNamespace
from unittest.mock import patch

logging.disable(logging.CRITICAL)
PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "apps/api/src/id-business-v2/auto-registration/worker"))


class DiscardOutput:
    def write(self, value):
        return len(value)

    def flush(self):
        pass


PRIVATE_PIPE = sys.stdout
# Frozen settings initialization contains print calls. Suppress all upstream
# output before importing it; only our closed JSON protocol can use the pipe.
sys.stdout = DiscardOutput()
sys.stderr = DiscardOutput()


class JointFixture:
    def __init__(self, operator_id):
        import workspace
        from fastapi.testclient import TestClient

        self.operator_id = operator_id
        self.stack = ExitStack()
        self.runtime = self.stack.enter_context(tempfile.TemporaryDirectory(
            prefix="sqlite-owned-", dir=PROJECT / ".runtime/registration-closed-loop-20261011"))
        token = secrets.token_urlsafe(32)
        self.headers = {"X-ID-Workspace-Token": token}
        self.app = workspace.create_workspace_app({"runtimeDir": self.runtime,
            "internalToken": token, "encryptionKey": secrets.token_urlsafe(48)})
        self.client_context = TestClient(self.app)
        self.client_entered = False
        self.client = self.client_context.__enter__()
        self.client_entered = True
        self.integration = self.app.state.apple_mailboxes
        self.store = self.integration.store
        self.sessions = importlib.import_module("src.database.session")
        self.models = importlib.import_module("src.database.models")
        self.registration = importlib.import_module("src.core.register")
        self.counters = {"runners": 0, "passwordPosts": 0, "created": 0,
                         "identityResponses": 0, "cpaUploads": 0, "sub2apiUploads": 0,
                         "teamManagerUploads": 0,
                         "blockedNetworkCalls": 0, "tmFlagsPassed": 0, "tmImportAttempts": 0}
        self.counter_lock = threading.Lock()
        self.task_uuids = []
        self.payloads = []
        self.upload_ids = self.seed_upload_services()
        self.install_offline_responses()

    def count(self, name):
        with self.counter_lock:
            self.counters[name] += 1

    def blocked(self, *args, **kwargs):
        self.count("blockedNetworkCalls")
        raise AssertionError("external-network-disabled")

    def seed_upload_services(self):
        ids = {}
        with self.sessions.get_db() as db:
            for key, model, credential in (
                ("cpa", self.models.CpaService, "api_token"),
                ("sub2api", self.models.Sub2ApiService, "api_key"),
                ("tm", self.models.TeamManagerService, "api_key"),
            ):
                row = model(name="隔离合成服务", api_url="https://upload.example.invalid",
                            enabled=True, **{credential: secrets.token_urlsafe(32)})
                db.add(row)
                db.flush()
                ids[key] = [row.id]
            db.commit()
        return ids

    def post(self, path, value):
        response = self.client.post("/internal/apple-mailboxes/" + path,
                                    json=value, headers=self.headers)
        assert response.status_code == 200, "private-api-rejected"
        return response.json()

    def get(self, path):
        response = self.client.get(path, headers=self.headers)
        assert response.status_code == 200, "read-api-rejected"
        return response.json()

    def install_offline_responses(self):
        fixture = self
        engine_class = self.registration.RegistrationEngine

        class OfficialSession:
            def __init__(self, engine):
                self.engine = engine
                self.cookies = {}

            def post(self, url, **kwargs):
                assert url == fixture.registration.OPENAI_API_ENDPOINTS["register"]
                with fixture.sessions.get_db() as db:
                    _, binding = fixture.store.task_data(db, self.engine.task_uuid)
                body = json.loads(kwargs["data"])
                assert binding["passwordCheckpoint"] == body["password"]
                assert binding["sideEffectPossible"] is True
                assert body["username"] == self.engine.email
                fixture.count("passwordPosts")
                return SimpleNamespace(status_code=200, url=url, text="", json=lambda: {})

            def get(self, url, **kwargs):
                assert url == "https://chatgpt.com/backend-api/me"
                assert kwargs.get("allow_redirects") is False
                assert kwargs["headers"]["authorization"].startswith("Bearer ")
                fixture.count("identityResponses")
                return SimpleNamespace(status_code=200, url=url,
                    json=lambda: {"id": "synthetic-official-user-" + self.engine.task_uuid,
                                  "email": self.engine.email})

            def close(self):
                pass

        def initialize(engine):
            engine.session = OfficialSession(engine)
            engine.http_client._session = engine.session
            return True

        def signup(engine, *args):
            engine._is_existing_account = False
            return fixture.registration.SignupFormResult(success=True, is_existing_account=False)

        def created(engine):
            fixture.count("created")
            return True

        def cpa_upload(*args, **kwargs):
            assert kwargs["api_url"] == "https://upload.example.invalid"
            fixture.count("cpaUploads")
            return True, "合成上传回执"

        def sub2api_upload(accounts, api_url, api_key):
            assert len(accounts) == 1 and accounts[0].email_service == "apple_hidden"
            assert api_url == "https://upload.example.invalid" and api_key
            fixture.count("sub2apiUploads")
            return True, "合成上传回执"

        route = self.integration.route
        original_runner = route._run_sync_registration_task

        def runner(task_uuid, *args, **kwargs):
            for index, name, expected in (
                (6, "auto_upload_cpa", True), (7, "cpa_service_ids", self.upload_ids["cpa"]),
                (8, "auto_upload_sub2api", True), (9, "sub2api_service_ids", self.upload_ids["sub2api"]),
                (10, "auto_upload_tm", True), (11, "tm_service_ids", self.upload_ids["tm"]),
            ):
                assert (args[index] if len(args) > index else kwargs[name]) == expected
            fixture.count("runners")
            fixture.count("tmFlagsPassed")
            return original_runner(task_uuid, *args, **kwargs)

        self.stack.enter_context(patch.object(route, "_run_sync_registration_task", runner))
        self.stack.enter_context(patch.object(engine_class, "_init_session", initialize))
        self.stack.enter_context(patch.object(engine_class, "_submit_signup_form", signup))
        self.stack.enter_context(patch.object(engine_class, "_create_user_account", created))
        for name, value in {
            "_check_ip_location": (True, "US"), "_start_oauth": True,
            "_get_device_id": "synthetic-device", "_check_sentinel": None,
            "_send_verification_code": True, "_get_verification_code": "123456",
            "_validate_verification_code": True, "_get_workspace_id": "synthetic-workspace",
            "_select_workspace": "https://callback.example.invalid",
            "_follow_redirects": "https://callback.example.invalid",
            "_handle_oauth_callback": {"account_id": "synthetic-account",
                "access_token": secrets.token_urlsafe(48), "refresh_token": secrets.token_urlsafe(48)},
        }.items():
            self.stack.enter_context(patch.object(engine_class, name, return_value=value))
        self.stack.enter_context(patch.object(importlib.import_module("src.core.upload.cpa_upload"),
                                              "upload_to_cpa", cpa_upload))
        self.stack.enter_context(patch.object(importlib.import_module("src.core.upload.sub2api_upload"),
                                              "upload_to_sub2api", sub2api_upload))
        # Execute the actual frozen Team Manager uploader through the installed
        # worker name adapter. Only the external HTTP response is synthetic.
        tm = importlib.import_module("src.core.upload.team_manager_upload")
        self.tm_import_available = hasattr(tm, "upload_account_to_tm")
        assert self.tm_import_available is True
        assert tm.upload_account_to_tm is tm.upload_to_team_manager

        def tm_post(url, **kwargs):
            assert url == "https://upload.example.invalid/api/accounts/import"
            assert kwargs["headers"]["X-API-Key"]
            assert kwargs["headers"]["Content-Type"] == "application/json"
            assert kwargs["proxies"] is None and kwargs["timeout"] == 30
            assert kwargs["impersonate"] == "chrome110"
            payload = kwargs["json"]
            assert payload["import_type"] == "single" and payload["access_token"]
            assert payload["email"].startswith("joint-registration-")
            fixture.count("teamManagerUploads")
            return SimpleNamespace(status_code=201)

        self.stack.enter_context(patch.object(tm.cffi_requests, "post", tm_post))
        original_import = builtins.__import__

        def imported(name, globals=None, locals=None, fromlist=(), level=0):
            if (name == "core.upload.team_manager_upload" and level == 3 and
                    "upload_account_to_tm" in fromlist and
                    (globals or {}).get("__name__") == "src.web.routes.registration"):
                fixture.count("tmImportAttempts")
            return original_import(name, globals, locals, fromlist, level)

        self.stack.enter_context(patch.object(builtins, "__import__", imported))
        self.stack.enter_context(patch.object(importlib.import_module("src.core.http_client").HTTPClient,
                                              "request", self.blocked))
        self.stack.enter_context(patch.object(importlib.import_module("curl_cffi.requests").Session,
                                              "request", self.blocked))
        self.stack.enter_context(patch.object(socket, "create_connection", self.blocked))
        # Block TCP directly without interfering with TestClient's local Unix
        # event-loop wakeup sockets.
        original_connect = socket.socket.connect

        def connect(sock, address):
            if sock.family in (socket.AF_INET, socket.AF_INET6):
                return fixture.blocked()
            return original_connect(sock, address)

        self.stack.enter_context(patch.object(socket.socket, "connect", connect))

    def prepare(self):
        items = [{"aliasId": "synthetic-alias-" + str(index),
                  "email": "joint-registration-" + str(index) + "@example.invalid",
                  "revision": 0} for index in range(3)]
        marked = self.post("mark", {"items": items, "registrationStatus": "unregistered",
                                    "note": "隔离合成验收", "operatorId": self.operator_id})
        assert len(marked["records"]) == 3
        for item in items:
            item["revision"] = self.store.records([item["email"]])[0]["revision"]
        options = {"auto_upload_cpa": True, "cpa_service_ids": self.upload_ids["cpa"],
                   "auto_upload_sub2api": True, "sub2api_service_ids": self.upload_ids["sub2api"],
                   "auto_upload_tm": True, "tm_service_ids": self.upload_ids["tm"]}
        single = self.post("start", {**items[0], "operatorId": self.operator_id, "options": options})
        self.task_uuids = [single["taskUuid"]]
        self.wait_completed()
        batch = self.post("batch", {"items": items[1:], "operatorId": self.operator_id,
            "mode": "parallel", "concurrency": 2, "interval_min": 0, "interval_max": 0, "options": options})
        assert len(batch["taskUuids"]) == 2 and not batch["skipped"]
        self.task_uuids.extend(batch["taskUuids"])
        self.wait_completed()
        self.batch_id = batch["batchId"]
        for task_uuid in self.task_uuids:
            task = self.integration.task(task_uuid)
            assert task["identityStatus"] == "verified" and task["syncStatus"] == "pending"
            self.payloads.append(self.get("/internal/apple-mailboxes/tasks/" + task_uuid + "/sync-payload"))
        assert len({p["email"] for p in self.payloads}) == 3
        assert len({p["accountId"] for p in self.payloads}) == 3
        assert len({p["upstreamAccountId"] for p in self.payloads}) == 3
        assert self.counters["runners"] == self.counters["created"] == self.counters["passwordPosts"] == 3
        assert self.counters["cpaUploads"] == self.counters["sub2apiUploads"] == 3
        assert self.counters["teamManagerUploads"] == 3
        assert self.counters["tmFlagsPassed"] == self.counters["tmImportAttempts"] == 3
        assert self.counters["blockedNetworkCalls"] == 0
        self.original_counts = dict(self.counters)
        self.assert_encryption_and_public_redaction()
        return {"payloads": self.payloads, "counts": dict(self.counters), "singleTasks": 1, "batchTasks": 2}

    def wait_completed(self):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if all(not self.integration.live(t) for t in self.task_uuids):
                assert all(self.integration.task(t)["status"] == "completed" for t in self.task_uuids)
                assert all(self.integration.task(t)["record"]["activeTaskUuid"] is None for t in self.task_uuids)
                return
            time.sleep(0.01)
        raise AssertionError("offline-task-timeout")

    def assert_encryption_and_public_redaction(self):
        with self.sessions.get_db() as db:
            rows = db.query(self.models.Account).all()
            assert len(rows) == 3
            for payload in self.payloads:
                account = next(row for row in rows if str(row.id) == payload["upstreamAccountId"])
                assert account.email == payload["email"] and account.password == payload["password"]
                assert account.email_service == "apple_hidden" and account.source == "register"
                assert account.extra_data["idSourceTaskUuid"] == payload["sourceTaskUuid"]
                assert account.cpa_uploaded
        with sqlite3.connect(Path(self.runtime) / "database.db") as db:
            assert all(row[0].startswith("idenc:v1:") for row in db.execute("SELECT password FROM accounts"))
            assert all(row[0].startswith("idenc:v1:") for row in db.execute("SELECT value FROM settings"))
        public_accounts = self.get("/api/accounts?page=1&page_size=100")
        assert public_accounts["total"] == len(public_accounts["accounts"]) == 3
        assert {str(row["id"]) for row in public_accounts["accounts"]} == {p["upstreamAccountId"] for p in self.payloads}
        public = json.dumps({"accounts": public_accounts,
                            "tasks": [self.integration.task(t) for t in self.task_uuids]})
        for payload in self.payloads:
            assert payload["password"] not in public
        forbidden = {"passwordCheckpoint", "rawResult", "syncPayload", "access_token", "refresh_token", "identityEvidence"}
        for task_uuid in self.task_uuids:
            assert not forbidden.intersection(self.integration.task(task_uuid))

    def acknowledge(self, values):
        assert len(values) == 3
        for value in values:
            assert value["sourceTaskUuid"] in self.task_uuids
            ack = self.post("tasks/" + value["sourceTaskUuid"] + "/sync-ack",
                            {"accountId": value["accountId"], "status": "saved"})
            assert ack == {"accepted": True, "syncStatus": "saved"}
        # These APIs only read stored checkpoints and never invoke the runner.
        for task_uuid in self.task_uuids:
            retry = self.post("tasks/" + task_uuid + "/sync-retry", {})
            assert retry["syncStatus"] == "saved"
            assert self.get("/internal/apple-mailboxes/tasks/" + task_uuid + "/sync-payload") == next(
                p for p in self.payloads if p["sourceTaskUuid"] == task_uuid)
        # Repeated registration requests must stop at the existing evidence,
        # before scheduling the original engine or any upload branch.
        items = []
        for payload in self.payloads:
            record = self.store.records([payload["email"]])[0]
            item = {"aliasId": payload["aliasId"], "email": payload["email"], "revision": record["revision"]}
            items.append(item)
            response = self.client.post("/internal/apple-mailboxes/start", headers=self.headers,
                json={**item, "operatorId": self.operator_id})
            assert response.status_code == 409
        skipped = self.post("batch", {"items": items, "operatorId": self.operator_id,
                                      "mode": "parallel", "concurrency": 2})
        assert skipped["batchId"] is None and skipped["taskUuids"] == [] and len(skipped["skipped"]) == 3
        self.assert_encryption_and_public_redaction()
        tasks = [self.integration.task(t) for t in self.task_uuids]
        assert all(t["syncStatus"] == "saved" and t["localSaveStatus"] == "saved" for t in tasks)
        assert all(t["record"]["registrationStatus"] == "registered" for t in tasks)
        assert {t["systemAccountId"] for t in tasks} == {p["accountId"] for p in self.payloads}
        assert self.get("/internal/apple-mailboxes/sync-pending") == {"tasks": []}
        batch = self.get("/internal/apple-mailboxes/batches/" + self.batch_id)
        assert batch["completed"] == 2 and len(batch["tasks"]) == 2
        assert self.counters == self.original_counts
        return {"sqliteAccounts": 3, "originalListAccounts": 3, "publicTasksSaved": 3,
                "batchSaved": 2, "singleSaved": 1, "pendingSync": 0,
                "distinctEmails": 3, "encryptedAtRest": True, "publicCredentialsRedacted": True,
                "retryRegistrationCalls": 0, "retryUploadCalls": 0,
                "blockedSingleRegistrationRetries": 3, "skippedBatchRegistrationRetries": 3,
                "flagsPassedOnce": 3, "cpaUploads": 3, "sub2apiUploads": 3, "teamManagerUploads": 3,
                "teamManagerImportAvailable": self.tm_import_available, "teamManagerImportAttempts": 3,
                "externalRequests": 0}

    def close(self):
        # Dispose ORM before deleting only the newly owned fixture directory.
        try:
            if getattr(self, "client_entered", False):
                self.client_context.__exit__(None, None, None)
        finally:
            try:
                sessions = getattr(self, "sessions", sys.modules.get("src.database.session"))
                if sessions is not None:
                    sessions.get_session_manager().engine.dispose()
                    sessions._db_manager = None
            finally:
                self.stack.close()


def main():
    fixture = None
    def terminate(signum, frame):
        raise SystemExit(1)
    signal.signal(signal.SIGTERM, terminate)
    try:
        for line in sys.stdin:
            request = json.loads(line)
            try:
                if request["command"] == "prepare":
                    assert fixture is None
                    fixture = JointFixture.__new__(JointFixture)
                    fixture.__init__(request["operatorId"])
                    result = fixture.prepare()
                elif request["command"] == "acknowledge":
                    result = fixture.acknowledge(request["accounts"])
                elif request["command"] == "close":
                    break
                else:
                    raise AssertionError("invalid-driver-command")
                # Payloads are deliberately delivered only through the parent
                # process's private stdout pipe, never to a tool or report file.
                print(json.dumps({"ok": True, "result": result}, separators=(",", ":")), file=PRIVATE_PIPE, flush=True)
            except Exception:
                frames = traceback.extract_tb(sys.exc_info()[2])
                print(json.dumps({"ok": False, "stage": "sqlite_fixture", "line": next(
                    (f.lineno for f in reversed(frames) if f.filename == __file__), 0)}), file=PRIVATE_PIPE, flush=True)
                break
    finally:
        if fixture is not None:
            fixture.close()


if __name__ == "__main__":
    main()
