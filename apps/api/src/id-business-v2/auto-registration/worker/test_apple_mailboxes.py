"""Offline Apple-alias acceptance: fixtures only; all registration is mocked."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import importlib
import inspect
import json
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
import flow_evidence as flow
import workspace


class AppleMailboxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        output = workspace.PROJECT_ROOT / ".runtime/apple-hidden-mailbox-20261009"
        output.mkdir(parents=True, exist_ok=True)
        cls.runtime = tempfile.TemporaryDirectory(prefix="python-unit-", dir=output)
        cls.token = secrets.token_urlsafe(32)
        cls.headers = {"X-ID-Workspace-Token": cls.token}
        cls.app = workspace.create_workspace_app({"runtimeDir": cls.runtime.name,
                                                 "internalToken": cls.token,
                                                 "encryptionKey": secrets.token_urlsafe(48)})
        cls.client_context = TestClient(cls.app)
        cls.client = cls.client_context.__enter__()
        cls.integration = cls.app.state.apple_mailboxes
        cls.store = cls.integration.store
        cls.apple = importlib.import_module("apple_mailboxes")
        cls.models = importlib.import_module("src.database.models")
        cls.sessions = importlib.import_module("src.database.session")

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        cls.sessions.get_session_manager().engine.dispose()
        cls.sessions._db_manager = None
        cls.runtime.cleanup()

    def setUp(self):
        self.email = self._testMethodName.lower() + "@example.invalid"
        self.alias = "offline-alias-" + self._testMethodName
        network_guard = patch.object(importlib.import_module("curl_cffi.requests").Session, "request",
                                     side_effect=AssertionError("禁止离线测试访问真实网络"))
        network_guard.start()
        self.addCleanup(network_guard.stop)

    def tearDown(self):
        with self.integration.lock:
            for task_uuid, context in list(self.integration.contexts.items()):
                if context["email"].startswith(self._testMethodName.lower()):
                    self.integration.contexts.pop(task_uuid, None)
                    self.integration.jobs.pop(task_uuid, None)
                    self.integration.running_threads.discard(task_uuid)
            for identifier, request in list(self.integration.requests.items()):
                if request["email"].startswith(self._testMethodName.lower()):
                    self.integration.requests.pop(identifier)
            self.integration.stopping = False

    def post(self, path, data):
        if path.endswith("/sync-ack") and "fingerprint" not in data:
            task_uuid = path.split("/")[1]
            with self.sessions.get_db() as db:
                _, binding = self.store.task_data(db, task_uuid)
            data = {**data, "fingerprint": binding.get("syncPayload", {}).get("fingerprint")}
        return self.client.post("/internal/apple-mailboxes/" + path,
                                json=data, headers=self.headers)

    def read(self, email=None):
        return self.store.records([email or self.email])[0]

    def marked(self, status="unregistered", address=None, revision=None, email=None):
        email = email or self.email
        payload = {"items": [{"aliasId": self.alias, "email": email,
                              "revision": self.read(email)["revision"] if revision is None else revision}],
                   "registrationStatus": status, "registrationIp": address,
                   "note": "离线夹具登记", "operatorId": "offline-admin"}
        return self.post("mark", payload)

    def reservation(self, email=None):
        email = email or self.email
        self.assertEqual(self.marked(email=email).status_code, 200)
        task_uuid = str(uuid.uuid4())
        request = self.apple.StartInput(aliasId=self.alias, email=email,
                                        revision=self.read(email)["revision"], operatorId="offline-admin")
        record = self.store.reserve(request, task_uuid)
        context = {"taskUuid": task_uuid, "aliasId": self.alias, "email": email,
                   "startedAt": time.time(), "cancelled": False, "integration": self.integration}
        self.integration.contexts[task_uuid] = context
        self.integration.jobs[task_uuid] = SimpleNamespace(done=lambda: False)
        provider = self.apple.AppleHiddenMailboxProvider(self.integration, context)
        provider.otp_lower_bound = context["startedAt"]
        return context, provider, record

    def request_waiting(self):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            pending = [item for item in self.integration.pending_requests() if item["email"] == self.email]
            if pending:
                return pending[0]
            time.sleep(0.01)
        self.fail("未产生离线验证码请求")

    def test_private_endpoints_require_internal_token(self):
        task = str(uuid.uuid4())
        for suffix in ("records", "mark", "start", "recover", "batch", "batches/" + task + "/cancel",
                       "tasks/" + task + "/sync-ack", "tasks/" + task + "/sync-retry",
                       "tasks/" + task + "/local-save-retry"):
            response = self.client.post("/internal/apple-mailboxes/" + suffix, json={})
            self.assertEqual(response.status_code, 401)
        for suffix in ("requests", "sync-pending", "tasks-active", "batches/" + task,
                       "tasks/" + task + "/sync-payload"):
            self.assertEqual(self.client.get("/internal/apple-mailboxes/" + suffix).status_code, 401)

    def test_default_unregistered_is_normalized_and_not_persisted(self):
        response = self.post("records", {"emails": ["  " + self.email.upper() + "  "]})
        record = response.json()["records"][0]
        self.assertEqual(record["email"], self.email)
        self.assertEqual(record["registrationStatus"], "unregistered")
        self.assertEqual(record["revision"], 0)
        with self.sessions.get_db() as db:
            self.assertIsNone(db.get(self.models.Setting, self.apple.key_for(self.email)))

    def test_invalid_email_ip_revision_and_extra_fields_are_rejected(self):
        self.assertEqual(self.post("records", {"emails": ["invalid"]}).status_code, 400)
        self.assertEqual(self.marked("registered", "not-an-ip").status_code, 400)
        self.assertEqual(self.marked("registered", revision=True).status_code, 422)
        self.assertEqual(self.post("records", {"emails": [], "queryCode": "fixture"}).status_code, 422)
        self.assertEqual(self.read()["revision"], 0)

    def test_manual_registered_can_have_unknown_ip(self):
        response = self.marked("registered")
        self.assertEqual(response.status_code, 200)
        record = response.json()["records"][0]
        self.assertEqual(record["source"], "manual")
        self.assertIsNone(record["registrationIp"])
        self.assertIsNone(record["registrationIpSource"])
        self.assertEqual(record["operatorId"], "offline-admin")
        self.assertIsNotNone(record["markedAt"])

    def test_manual_ipv4_and_ipv6_are_normalized(self):
        for index, address in enumerate(("198.51.100.9", "2001:0db8:0000:0000:0000:0000:0000:0001")):
            response = self.marked("registered", address, email=f"{self._testMethodName}_{index}@example.invalid")
            self.assertEqual(response.status_code, 200)
            record = response.json()["records"][0]
            self.assertEqual(record["registrationIp"], ("198.51.100.9", "2001:db8::1")[index])
            self.assertEqual(record["registrationIpSource"], "manual")

    def test_unregistered_cannot_claim_historical_registration_ip(self):
        self.assertEqual(self.marked("unregistered", "198.51.100.9").status_code, 400)
        self.assertEqual(self.read()["registrationStatus"], "unregistered")

    def test_cas_rejects_stale_mark_without_overwriting(self):
        self.assertEqual(self.marked("registered", "198.51.100.9").status_code, 200)
        self.assertEqual(self.marked("unregistered", revision=0).status_code, 409)
        self.assertEqual(self.read()["registrationIp"], "198.51.100.9")

    def test_bulk_mark_is_atomic_on_conflict(self):
        first = "first_" + self.email
        self.assertEqual(self.marked(email=first).status_code, 200)
        response = self.post("mark", {"items": [
            {"aliasId": self.alias, "email": self.email, "revision": 0},
            {"aliasId": self.alias, "email": first, "revision": 0}],
            "registrationStatus": "registered", "registrationIp": None,
            "operatorId": "offline-admin", "note": ""})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.read()["revision"], 0)
        self.assertEqual(self.read(first)["registrationStatus"], "unregistered")

    def test_duplicate_normalized_email_and_batch_limits(self):
        response = self.post("mark", {"items": [
            {"aliasId": "a", "email": self.email, "revision": 0},
            {"aliasId": "b", "email": self.email.upper(), "revision": 0}],
            "registrationStatus": "registered", "registrationIp": None, "operatorId": "offline-admin"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.post("records", {"emails": [self.email] * 10001}).status_code, 422)
        items = [{"aliasId": "a", "email": f"{index}@example.invalid", "revision": 0} for index in range(101)]
        self.assertEqual(self.post("mark", {"items": items, "registrationStatus": "unknown", "operatorId": "offline-admin"}).status_code, 422)

    def test_unknown_and_registered_cannot_start(self):
        for status in ("unknown", "registered"):
            self.assertEqual(self.marked(status).status_code, 200)
            response = self.post("start", {"aliasId": self.alias, "email": self.email,
                "revision": self.read()["revision"], "operatorId": "offline-admin"})
            self.assertEqual(response.status_code, 409)

    def test_two_aliases_same_email_have_exclusive_lease(self):
        context, _, record = self.reservation()
        request = self.apple.StartInput(aliasId="another-alias", email=self.email.upper(),
                                       revision=record["revision"], operatorId="other-admin")
        with self.assertRaises(HTTPException) as raised:
            self.store.reserve(request, str(uuid.uuid4()))
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(self.read()["activeTaskUuid"], context["taskUuid"])
        self.assertEqual(self.marked("registered").status_code, 409)

    def test_concurrent_cas_has_only_one_winner(self):
        self.assertEqual(self.marked().status_code, 200)
        request = self.apple.StartInput(aliasId=self.alias, email=self.email,
                                       revision=self.read()["revision"], operatorId="offline-admin")
        barrier = threading.Barrier(2)

        def reserve():
            barrier.wait()
            try:
                return self.store.reserve(request, str(uuid.uuid4()))["activeTaskUuid"]
            except HTTPException as error:
                return error.status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: reserve(), range(2)))
        self.assertEqual(sum(isinstance(value, str) for value in results), 1)
        self.assertIn(409, results)

    def test_records_and_task_mapping_are_encrypted_without_schema_change(self):
        context, _, _ = self.reservation()
        self.store.observe(self.email, context["taskUuid"], attemptIp="198.51.100.9")
        self.store.registered(self.email, context["taskUuid"], existing=False)
        with sqlite3.connect(Path(self.runtime.name) / "database.db") as db:
            values = db.execute("SELECT value FROM settings WHERE key IN (?, ?)",
                                (self.apple.key_for(self.email), self.apple.TASK_PREFIX + context["taskUuid"])).fetchall()
            self.assertEqual(len(values), 2)
            for (value,) in values:
                self.assertTrue(value.startswith("idenc:v1:"))
                self.assertNotIn(self.email, value)
                self.assertNotIn("198.51.100.9", value)
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertFalse(any("apple" in name for name in tables))

    def test_flow_v2_error_shapes_are_encrypted_and_returned_only_on_task(self):
        context, _, _ = self.reservation()
        task_uuid = context["taskUuid"]
        response = self.diagnostic_response(200, {"page": {"type": "password"},
            "error": {"code": "offline-private-code", "message": "offline-private-response"},
            "errors": ["offline-private-response"], "access_token": "offline-private-token"})
        evidence = flow.observation(response, "signup")
        before_record = self.read()
        self.assertTrue(self.store.record_flow_evidence(task_uuid, "signup", evidence))
        with self.sessions.get_db() as db:
            _, binding = self.store.task_data(db, task_uuid)
        self.assertEqual(binding["flowEvidence"], {"version": 2, "signup": evidence})
        self.assertEqual(binding["flowEvidence"]["signup"]["responseDetails"], {
            "errorSignal": "both", "errorShape": "object", "errorsShape": "list",
            "errorKind": "other", "pageShape": "type_known"})
        self.assertEqual((evidence["pageKind"], evidence["decision"], evidence["reason"]),
                         ("new_account", "rejected", "upstream_error"))
        result = self.integration.task(task_uuid)
        self.assertEqual(result["flowEvidence"], binding["flowEvidence"])
        self.assertNotIn("flowEvidence", result["record"])
        self.assertEqual(self.read(), before_record)
        for marker in ("offline-private-code", "offline-private-response", "offline-private-token"):
            self.assertNotIn(marker, json.dumps(binding))
            self.assertNotIn(marker, json.dumps(result))
        with sqlite3.connect(Path(self.runtime.name) / "database.db") as db:
            cipher = db.execute("SELECT value FROM settings WHERE key=?", (self.apple.TASK_PREFIX + task_uuid,)).fetchone()[0]
            self.assertTrue(cipher.startswith("idenc:v1:"))
            self.assertNotIn("responseDetails", cipher)
            self.assertNotIn(self.email, cipher)

    def test_flow_v1_continuation_keeps_old_slots_first_failure_and_manual_facts(self):
        context, _, _ = self.reservation()
        task_uuid = context["taskUuid"]
        self.store.observe(self.email, task_uuid, registrationStatus="registered", source="manual",
            registrationIp="198.51.100.9", registrationIpSource="manual", registrationCountry="US",
            note="离线人工登记不得被诊断覆盖", operatorId="offline-manual-admin")
        self.store.record_failure(task_uuid, "password", "account_creation_failed", 400, 17)
        old_signup = flow.observation_v1("signup", flow.observation(self.diagnostic_response(), "signup"))
        with self.store.transaction() as db:
            row, data = self.store.task_data(db, task_uuid)
            data["flowEvidence"] = {"version": 1, "signup": old_signup}
            row.value = json.dumps(data)
        original_record = self.read()
        original_failure = original_record["firstFailure"]
        with sqlite3.connect(Path(self.runtime.name) / "database.db") as db:
            original_cipher = db.execute("SELECT value FROM settings WHERE key=?", (self.apple.key_for(self.email),)).fetchone()[0]
        rejected = flow.observation(self.diagnostic_response(200,
            {"page": {"type": "email_otp_verification"}, "error": {"code": "user_exists"}}), "signup")
        self.assertTrue(self.store.record_flow_evidence(task_uuid, "signup", rejected))
        password = flow.observation(self.diagnostic_response(400), "password")
        self.assertTrue(self.store.record_flow_evidence(task_uuid, "password", password))
        self.store.record_failure(task_uuid, "signup", "user_exists", 200, 999)
        with self.sessions.get_db() as db:
            _, binding = self.store.task_data(db, task_uuid)
        self.assertEqual(binding["flowEvidence"], {"version": 1, "signup": old_signup,
            "password": flow.observation_v1("password", password)})
        self.assertEqual(binding["firstFailure"], original_failure)
        self.assertEqual(self.read(), original_record)
        self.assertEqual(self.integration.task(task_uuid)["flowEvidence"], binding["flowEvidence"])
        with sqlite3.connect(Path(self.runtime.name) / "database.db") as db:
            current_cipher = db.execute("SELECT value FROM settings WHERE key=?", (self.apple.key_for(self.email),)).fetchone()[0]
        self.assertEqual(current_cipher, original_cipher)

    def test_invalid_v2_details_do_not_replace_existing_encrypted_task_evidence(self):
        context, _, _ = self.reservation()
        task_uuid = context["taskUuid"]
        evidence = flow.observation(self.diagnostic_response(), "signup")
        self.assertTrue(self.store.record_flow_evidence(task_uuid, "signup", evidence))
        with sqlite3.connect(Path(self.runtime.name) / "database.db") as db:
            original_cipher = db.execute("SELECT value FROM settings WHERE key=?", (self.apple.TASK_PREFIX + task_uuid,)).fetchone()[0]
        invalid = json.loads(json.dumps(evidence))
        invalid.pop("responseDetails")
        with self.assertRaises(ValueError):
            self.store.record_flow_evidence(task_uuid, "signup", invalid)
        with sqlite3.connect(Path(self.runtime.name) / "database.db") as db:
            current_cipher = db.execute("SELECT value FROM settings WHERE key=?", (self.apple.TASK_PREFIX + task_uuid,)).fetchone()[0]
        self.assertEqual(current_cipher, original_cipher)
        self.assertEqual(self.integration.task(task_uuid)["flowEvidence"], {"version": 2, "signup": evidence})

    def test_early_new_account_fact_survives_later_failure(self):
        context, _, _ = self.reservation()
        task_uuid = context["taskUuid"]
        self.store.observe(self.email, task_uuid, attemptIp="198.51.100.9", attemptCountry="US")
        self.store.registered(self.email, task_uuid, existing=False)
        with self.sessions.get_db() as db:
            task = db.query(self.models.RegistrationTask).filter_by(task_uuid=task_uuid).one()
            task.status = "failed"
            db.commit()
        self.store.finish(self.email, task_uuid, cancelled=False)
        record = self.read()
        self.assertEqual(record["registrationStatus"], "registered")
        self.assertEqual(record["registrationIp"], "198.51.100.9")
        self.assertEqual(record["registrationIpSource"], "observed")
        self.assertEqual(record["registrationCountry"], "US")
        self.assertEqual(record["lastResultKind"], "new_registration")
        self.assertEqual(record["taskStatus"], "failed")

    def test_existing_account_attempt_ip_is_not_historical_registration_ip(self):
        context, _, _ = self.reservation()
        self.store.observe(self.email, context["taskUuid"], attemptIp="198.51.100.10", attemptCountry="JP")
        self.store.registered(self.email, context["taskUuid"], existing=True)
        record = self.read()
        self.assertEqual(record["registrationStatus"], "registered")
        self.assertEqual(record["attemptIp"], "198.51.100.10")
        self.assertIsNone(record["registrationIp"])
        self.assertIsNone(record["registrationCountry"])
        self.assertEqual(record["lastResultKind"], "existing_account")

    def test_cancel_and_failed_finish_do_not_demote_registered_fact(self):
        context, _, _ = self.reservation()
        self.store.registered(self.email, context["taskUuid"], existing=True)
        self.store.finish(self.email, context["taskUuid"], cancelled=True)
        self.assertEqual(self.read()["registrationStatus"], "registered")
        self.assertEqual(self.read()["taskStatus"], "cancelled")

    def test_interrupted_requires_explicit_cas_recovery_to_unknown(self):
        context, _, record = self.reservation()
        self.integration.jobs.pop(context["taskUuid"])
        response = self.post("records", {"emails": [self.email]})
        self.assertEqual(response.json()["records"][0]["taskStatus"], "interrupted")
        self.assertEqual(self.client.get("/internal/apple-mailboxes/tasks/" + context["taskUuid"], headers=self.headers).json()["status"], "interrupted")
        response = self.post("recover", {"aliasId": self.alias, "email": self.email,
            "revision": record["revision"], "operatorId": "offline-admin"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["record"]["registrationStatus"], "unknown")
        self.assertIsNone(response.json()["record"]["activeTaskUuid"])

    def test_recovery_preserves_registration_fact(self):
        context, _, _ = self.reservation()
        self.store.registered(self.email, context["taskUuid"], existing=True)
        self.integration.jobs.pop(context["taskUuid"])
        response = self.post("recover", {"aliasId": self.alias, "email": self.email,
            "revision": self.read()["revision"], "operatorId": "offline-admin"})
        self.assertEqual(response.json()["record"]["registrationStatus"], "registered")

    def test_unknown_result_requires_manual_recovery_before_mark_and_keeps_cas_and_live_guard(self):
        context, _, reserved = self.reservation()
        self.store.update_task(context["taskUuid"], sideEffectPossible=True)
        self.store.finish(self.email, context["taskUuid"], False)
        unknown = self.read()
        self.assertEqual(unknown["taskStatus"], "awaiting_review")
        self.assertEqual(self.marked(status="registered").status_code, 409)
        request = {"aliasId": self.alias, "email": self.email, "revision": unknown["revision"], "operatorId": "offline-admin"}
        self.assertEqual(self.post("recover", request).status_code, 409)
        self.integration.jobs.pop(context["taskUuid"])
        self.assertEqual(self.post("recover", {**request, "revision": reserved["revision"]}).status_code, 409)
        response = self.post("recover", request)
        self.assertEqual(response.status_code, 200)
        released = response.json()["record"]
        self.assertIsNone(released["activeTaskUuid"])
        self.assertEqual(released["registrationStatus"], "unknown")
        self.assertEqual(released["lastTaskUuid"], context["taskUuid"])
        self.assertEqual(self.marked(status="registered", address="203.0.113.9").status_code, 200)
        self.assertEqual(self.read()["registrationIp"], "203.0.113.9")

    def test_recovery_rejects_live_async_job_or_actual_thread(self):
        context, _, _ = self.reservation()
        request = {"aliasId": self.alias, "email": self.email,
            "revision": self.read()["revision"], "operatorId": "offline-admin"}
        self.assertEqual(self.post("recover", request).status_code, 409)
        self.integration.jobs.pop(context["taskUuid"])
        self.integration.running_threads.add(context["taskUuid"])
        self.assertEqual(self.post("recover", request).status_code, 409)

    def test_provider_returns_exact_existing_address_never_creates_or_deletes(self):
        _, provider, _ = self.reservation()
        self.assertEqual(provider.create_email(), {"email": self.email, "service_id": self.alias})
        self.assertFalse(provider.delete_email(self.alias))

    def test_provider_rejects_wrong_alias_address_or_old_timestamp(self):
        context, provider, _ = self.reservation()
        with self.assertRaises(ValueError):
            provider.get_verification_code("different@example.invalid", self.alias, timeout=0)
        with self.assertRaises(ValueError):
            provider.get_verification_code(self.email, "wrong-alias", timeout=0)
        with self.assertRaises(ValueError):
            provider.get_verification_code(self.email, self.alias, timeout=0, otp_sent_at=context["startedAt"] - 10)

    def test_private_mail_bridge_accepts_only_six_digits_and_consumes_once(self):
        context, provider, _ = self.reservation()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(provider.get_verification_code, self.email, self.alias, 3)
            pending = self.request_waiting()
            self.assertEqual(pending["aliasId"], self.alias)
            for code in ("12345678", "https://auth.openai.com/verify", "00012", "abcdef", "١٢٣٤٥٦"):
                self.assertEqual(self.post("requests/" + pending["id"], {"code": code, "mailId": "mail-fixture"}).status_code, 400)
            response = self.post("requests/" + pending["id"], {"code": "123456", "mailId": "mail-fixture"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(future.result(timeout=4), "123456")
            self.assertEqual(self.post("requests/" + pending["id"], {"code": "123456", "mailId": "mail-fixture"}).status_code, 409)
        self.assertEqual(self.read()["lastMailId"], "mail-fixture")
        public = self.post("records", {"emails": [self.email]}).json()["records"][0]
        self.assertNotIn("consumedMailIds", public)
        self.assertNotIn("lastMailId", public)

    def test_new_task_resets_previous_mail_id_but_retains_consumed_ids(self):
        context, _, _ = self.reservation()
        self.store.observe(self.email, context["taskUuid"], lastMailId="old-task-mail", consumedMailIds=["old-task-mail"])
        self.store.finish(self.email, context["taskUuid"], cancelled=False)
        request = self.apple.StartInput(aliasId=self.alias, email=self.email,
                                       revision=self.read()["revision"], operatorId="offline-admin")
        self.store.reserve(request, str(uuid.uuid4()))
        self.assertIsNone(self.read()["lastMailId"])
        self.assertEqual(self.read()["consumedMailIds"], ["old-task-mail"])

    def test_mail_id_replay_cannot_be_consumed_again(self):
        context, provider, _ = self.reservation()
        self.store.observe(self.email, context["taskUuid"], lastMailId="already-consumed", consumedMailIds=["already-consumed"])
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(provider.get_verification_code, self.email, self.alias, 0.5)
            pending = self.request_waiting()
            self.assertEqual(pending["previousId"], "already-consumed")
            self.assertEqual(self.post("requests/" + pending["id"], {"code": "123456", "mailId": "already-consumed"}).status_code, 409)
            self.assertIsNone(future.result(timeout=2))

    def test_mail_error_is_controlled_and_contains_no_authorization(self):
        _, provider, _ = self.reservation()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(provider.get_verification_code, self.email, self.alias, 3)
            pending = self.request_waiting()
            self.assertEqual(self.post("requests/" + pending["id"], {"code": None, "mailId": None, "error": "raw-secret-value"}).status_code, 400)
            self.assertEqual(self.post("requests/" + pending["id"], {"code": None, "mailId": None, "error": "address_changed"}).status_code, 200)
            with self.assertRaises(ValueError) as raised:
                future.result(timeout=4)
            self.assertNotIn("address_changed", str(raised.exception))

    def test_cancellation_wakes_mail_poll_without_releasing_lease(self):
        context, provider, _ = self.reservation()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(provider.get_verification_code, self.email, self.alias, 120)
            self.request_waiting()
            self.assertTrue(self.integration.cancel(context["taskUuid"])["accepted"])
            self.assertIsNone(future.result(timeout=2))
        self.assertEqual(self.read()["activeTaskUuid"], context["taskUuid"])

    def test_trace_observer_uses_original_response_once(self):
        context, provider, _ = self.reservation()
        response = SimpleNamespace(text="ip=198.51.100.12\nloc=US\n")
        get = Mock(return_value=response)
        engine = SimpleNamespace(http_client=SimpleNamespace(get=get),
            _submit_signup_form=Mock(return_value=SimpleNamespace(is_existing_account=False)),
            _send_verification_code=Mock(return_value=True), _create_user_account=Mock(return_value=True),
            _mark_email_as_registered=Mock(return_value=None), email_service=provider,
            email_info={"email": self.email, "service_id": self.alias},
            oauth_manager=SimpleNamespace(client_id="offline-client"), proxy_url=None)
        self.store.password_checkpoint(context["taskUuid"], lambda: "offline-checkpoint-password")
        self.integration.observe_engine(engine, provider)
        actual = engine.http_client.get("https://cloudflare.com/cdn-cgi/trace", timeout=10)
        self.assertIs(actual, response)
        get.assert_called_once_with("https://cloudflare.com/cdn-cgi/trace", timeout=10)
        self.assertEqual(self.read()["attemptIp"], "198.51.100.12")
        self.assertEqual(self.read()["attemptCountry"], "US")
        self.assertTrue(engine._create_user_account())
        self.assertEqual(self.read()["registrationIp"], "198.51.100.12")

    def test_existing_observer_captures_request_start_and_retains_return(self):
        _, provider, _ = self.reservation()
        result = SimpleNamespace(success=True, is_existing_account=True, page_type="email_otp_verification")
        engine = SimpleNamespace(http_client=SimpleNamespace(get=Mock()),
            _submit_signup_form=Mock(return_value=result), _send_verification_code=Mock(return_value=True),
            _create_user_account=Mock(return_value=True), _mark_email_as_registered=Mock())
        self.observed_signup_fixture(engine, provider, result)
        self.integration.observe_engine(engine, provider)
        self.assertIs(engine._submit_signup_form("device", "fixture"), result)
        self.assertGreaterEqual(provider.otp_lower_bound, provider.context["startedAt"])
        self.assertIsNone(self.read()["lastResultKind"])
        self.assertEqual(self.read()["reason"], "existing_account_suspected")
        self.assertEqual(self.read()["registrationStatus"], "unregistered")

    def test_normal_factory_is_preserved_and_context_dispatch_is_private(self):
        factory = self.apple.EmailServiceFactory
        self.assertIsNone(getattr(self.apple._context, "task", None))
        service = factory.create(self.apple.EmailServiceType.TEMP_MAIL,
                                 {"base_url": "https://example.invalid", "admin_password": "offline-fixture", "domain": "example.invalid"})
        self.assertNotIsInstance(service, self.apple.AppleHiddenMailboxProvider)
        context, _, _ = self.reservation()
        self.apple._context.task = context
        try:
            service = factory.create(self.apple.EmailServiceType.TEMP_MAIL, {})
            self.assertIsInstance(service, self.apple.AppleHiddenMailboxProvider)
        finally:
            self.apple._context.task = None

    def test_start_uses_original_runner_and_cancellation_keeps_live_lease(self):
        self.assertEqual(self.marked().status_code, 200)
        release = threading.Event()
        calls = []

        async def fake_runner(task_uuid, *args):
            calls.append((task_uuid, args))
            while not release.is_set():
                await asyncio.sleep(0.01)
            self.store.registered(self.email, task_uuid, existing=False)
            with self.sessions.get_db() as db:
                task = db.query(self.models.RegistrationTask).filter_by(task_uuid=task_uuid).one()
                task.status = "completed"
                db.commit()

        with patch.object(self.integration.route, "run_registration_task", side_effect=fake_runner):
            response = self.post("start", {"aliasId": self.alias, "email": self.email,
                "revision": self.read()["revision"], "operatorId": "offline-admin"})
            self.assertEqual(response.status_code, 200)
            task_uuid = response.json()["taskUuid"]
            try:
                deadline = time.monotonic() + 3
                while not calls and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(calls[0][1], ("temp_mail", None, {}, None, "", "", False, [], False, [], False, []))
                self.assertEqual(self.post("tasks/" + task_uuid + "/cancel", {}).status_code, 200)
                self.assertEqual(self.read()["activeTaskUuid"], task_uuid)
            finally:
                release.set()
                deadline = time.monotonic() + 3
                while self.integration.live(task_uuid) and time.monotonic() < deadline:
                    time.sleep(0.01)
            self.assertIsNone(self.read()["activeTaskUuid"])
            self.assertEqual(self.read()["taskStatus"], "cancelled")
            self.assertEqual(self.read()["registrationStatus"], "registered")

    def test_served_service_label_is_chinese_without_changing_original_types(self):
        original = (workspace.UPSTREAM_DIR / "static/js/utils.js").read_text()
        fragment = original[original.index("const statusMap ="):original.index("const accountStatusIconMap")]
        fragment += "\n// offline fixture comment with no trailing newline"
        delivered = workspace.transform_asset(fragment, asset_name="utils.js")
        self.assertTrue(delivered.startswith(fragment + "\n"))
        self.assertTrue(delivered.endswith("\n"))
        script = delivered + "\nprocess.stdout.write(JSON.stringify(['apple_hidden','tempmail','outlook','custom_domain','temp_mail','unknown'].map(getServiceTypeText)));"
        actual = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True).stdout
        self.assertEqual(json.loads(actual), ["苹果隐藏邮箱", "Tempmail.lol", "Outlook", "自定义域名", "Temp-Mail（自部署）", "unknown"])
        self.assertEqual((workspace.UPSTREAM_DIR / "static/js/utils.js").read_text(), original)
        self.assertNotIn("statusMap.service.apple_hidden", workspace.transform_asset(fragment, asset_name="accounts.js"))

    def test_cancelled_real_executor_keeps_lease_until_actual_thread_returns(self):
        registration = importlib.import_module("src.core.register")
        self.assertEqual(self.marked().status_code, 200)
        entered, release = threading.Event(), threading.Event()
        thread_names = []

        def blocked_engine(engine):
            thread_names.append(threading.current_thread().name)
            context = engine.email_service.context
            self.store.registered(self.email, context["taskUuid"], existing=False)
            entered.set()
            release.wait(timeout=5)
            return registration.RegistrationResult(success=False, error_message="离线取消夹具")

        client_class = importlib.import_module("src.core.http_client").HTTPClient
        with patch.object(registration.RegistrationEngine, "run", blocked_engine), \
                patch.object(self.integration.route, "get_proxy_for_registration", return_value=(None, None)), \
                patch.object(client_class, "request", side_effect=AssertionError("禁止离线测试访问网络")):
            task_uuid = None
            try:
                response = self.post("start", {"aliasId": self.alias, "email": self.email,
                    "revision": self.read()["revision"], "operatorId": "offline-admin"})
                self.assertEqual(response.status_code, 200)
                task_uuid = response.json()["taskUuid"]
                self.assertTrue(entered.wait(timeout=3))
                self.assertTrue(thread_names[0].startswith("reg_worker"))
                self.assertIn(task_uuid, self.integration.running_threads)
                self.assertEqual(self.post("tasks/" + task_uuid + "/cancel", {}).status_code, 200)
                self.assertEqual(self.read()["activeTaskUuid"], task_uuid)
                self.assertEqual(self.read()["registrationStatus"], "registered")
                self.assertIn(task_uuid, self.integration.running_threads)
                self.assertEqual(self.post("recover", {"aliasId": self.alias, "email": self.email,
                    "revision": self.read()["revision"], "operatorId": "offline-admin"}).status_code, 409)
            finally:
                release.set()
                deadline = time.monotonic() + 5
                while task_uuid and self.read()["activeTaskUuid"] and time.monotonic() < deadline:
                    time.sleep(0.01)
            self.assertIsNone(self.read()["activeTaskUuid"])
            self.assertNotIn(task_uuid, self.integration.running_threads)
            self.assertEqual(self.integration.task(task_uuid)["status"], "cancelled")
            self.assertEqual(self.read()["registrationStatus"], "registered")

    def run_original_algorithm_offline(self, existing=False, fail_after_created=False, fail_save=False, verified_identity=True):
        registration = importlib.import_module("src.core.register")
        engine_class = registration.RegistrationEngine
        self.assertEqual(self.marked().status_code, 200)

        def signup(engine, *args):
            engine.session.post(registration.OPENAI_API_ENDPOINTS["signup"])
            engine._is_existing_account = existing
            return registration.SignupFormResult(success=True, is_existing_account=existing,
                page_type="email_otp_verification" if existing else "password")

        returns = {
            "_check_ip_location": (True, "US"), "_start_oauth": True,
            "_get_device_id": "offline-device", "_check_sentinel": None,
            "_send_verification_code": True,
            "_get_verification_code": "123456", "_validate_verification_code": True,
            "_create_user_account": True,
            "_get_workspace_id": None if fail_after_created else "offline-workspace",
            "_select_workspace": "https://example.invalid/callback",
            "_follow_redirects": "https://example.invalid/callback",
            "_handle_oauth_callback": {"account_id": "offline-account", "access_token": "offline-official-access"},
        }
        with ExitStack() as stack:
            if fail_save:
                def unavailable(task_uuid, result, original_save, identity):
                    self.store.update_task(task_uuid, localSaveStatus="failed", syncStatus="blocked",
                                           syncErrorKind="local_save_failed", reason="local_save_failed")
                    raise ValueError("离线凭据保存失败")
                stack.enter_context(patch.object(self.integration, "persist_result", side_effect=unavailable))
            stack.enter_context(patch.object(engine_class, "_submit_signup_form", signup))
            def initialize_session(engine):
                engine.session = self.official_session(malformed=not verified_identity)
                engine.session.post.return_value = self.diagnostic_response(200, {
                    "page": {"type": "email_otp_verification" if existing else "password"}})
                return True

            stack.enter_context(patch.object(engine_class, "_init_session", initialize_session))
            methods = {name: stack.enter_context(patch.object(engine_class, name, return_value=value))
                       for name, value in returns.items()}
            password_calls = Mock()

            def password(engine):
                password_calls()
                engine.password = engine._generate_password()
                return True, engine.password

            stack.enter_context(patch.object(engine_class, "_register_password", password))
            methods["_register_password"] = password_calls
            client_class = importlib.import_module("src.core.http_client").HTTPClient
            stack.enter_context(patch.object(client_class, "request", side_effect=AssertionError("禁止离线测试访问网络")))
            response = self.post("start", {"aliasId": self.alias, "email": self.email,
                "revision": self.read()["revision"], "operatorId": "offline-admin"})
            self.assertEqual(response.status_code, 200)
            task_uuid = response.json()["taskUuid"]
            deadline = time.monotonic() + 5
            while self.integration.live(task_uuid) and time.monotonic() < deadline:
                time.sleep(0.01)
            if existing and not verified_identity:
                self.assertEqual(self.read()["activeTaskUuid"], task_uuid)
            else:
                self.assertIsNone(self.read()["activeTaskUuid"])
            task = self.integration.task(task_uuid)
            if existing:
                methods["_register_password"].assert_not_called()
                methods["_send_verification_code"].assert_not_called()
                methods["_create_user_account"].assert_not_called()
            return task

    def test_original_algorithm_with_new_provider_saves_new_registration(self):
        task = self.run_original_algorithm_offline()
        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["resultKind"], "new_registration")
        self.assertEqual(task["record"]["registrationStatus"], "registered")
        with self.sessions.get_db() as db:
            account = db.query(self.models.Account).filter_by(email=self.email).one()
            self.assertEqual(account.email_service, "apple_hidden")
            self.assertEqual(account.email_service_id, self.alias)
            self.assertEqual(account.source, "register")

    def test_original_algorithm_existing_login_is_classified_without_new_registration(self):
        task = self.run_original_algorithm_offline(existing=True)
        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["resultKind"], "existing_account")
        self.assertIsNone(task["record"]["registrationIp"])
        with self.sessions.get_db() as db:
            account = db.query(self.models.Account).filter_by(email=self.email).one()
            self.assertEqual(account.source, "login")

    def test_original_algorithm_oauth_failure_keeps_early_registration_fact(self):
        task = self.run_original_algorithm_offline(fail_after_created=True)
        self.assertEqual(task["status"], "failed")
        self.assertEqual(task["resultKind"], "new_registration")
        self.assertEqual(task["record"]["registrationStatus"], "registered")
        self.assertEqual(task["localSaveStatus"], "saved")
        self.assertEqual(task["record"]["authorizationStatus"], "pending")
        with self.sessions.get_db() as db:
            account = db.query(self.models.Account).filter_by(email=self.email).one()
            self.assertTrue(account.password)
            self.assertIsNone(account.access_token)
            self.assertIsNone(account.account_id)

    def official_session(self, email=None, cookie=False, status=200, redirected=False, malformed=False):
        endpoint = "https://chatgpt.com/api/auth/session" if cookie else "https://chatgpt.com/backend-api/me"
        user = {"id": "offline-official-user", "email": email or self.email}
        payload = {"user": user, "accessToken": "offline-session-access"} if cookie else user
        response = SimpleNamespace(status_code=status, url="https://example.invalid/redirect" if redirected else endpoint,
                                   json=Mock(return_value={} if malformed else payload))
        return SimpleNamespace(cookies={"__Secure-next-auth.session-token": "offline-cookie"} if cookie else {},
                               get=Mock(return_value=response), post=Mock(), close=Mock())

    def observed_signup_fixture(self, engine, provider, result):
        """A mocked signup method still supplies a real guarded fake response."""
        registration = importlib.import_module("src.core.register")
        response = self.diagnostic_response(200, {"page": {"type": result.page_type}})
        session = SimpleNamespace(get=Mock(), post=Mock(return_value=response))
        self.integration.guard_session(engine, provider.context["taskUuid"], session)
        def signup(*_args, **_kwargs):
            session.post(registration.OPENAI_API_ENDPOINTS["signup"])
            return result
        engine._submit_signup_form = signup

    def successful_saved_task(self, verified=True, creation=True):
        context, provider, _ = self.reservation()
        registration = importlib.import_module("src.core.register")
        password = self.store.password_checkpoint(context["taskUuid"], lambda: "offline-checkpoint-password")
        self.store.registered(self.email, context["taskUuid"], existing=not creation)
        identity = self.apple.verify_identity(self.official_session(), self.email, "offline-access") if verified else {
            "identityStatus": "awaiting_identity", "reason": "identity_missing"}
        engine = registration.RegistrationEngine(provider, task_uuid=context["taskUuid"])
        engine.email_info = {"email": self.email, "service_id": self.alias}
        engine._apple_identity = identity
        result = registration.RegistrationResult(success=True, email=self.email, password=password if creation else "",
                                                source="register" if creation else "login",
                                                access_token="offline-access", refresh_token="offline-refresh")
        self.assertTrue(engine.save_to_database(result))
        return context, engine, result

    def test_historical_unknown_setting_and_existing_accounts_never_default_fresh(self):
        self.assertEqual(self.marked("unknown").status_code, 200)
        self.assertEqual(self.read()["registrationStatus"], "unknown")
        with self.sessions.get_db() as db:
            db.add(self.models.Account(email="history_" + self.email, password="", email_service="apple_hidden"))
            db.add(self.models.Account(email="failed_" + self.email, password="", email_service="apple_hidden", status="failed"))
            db.commit()
        self.assertEqual(self.read("history_" + self.email)["registrationStatus"], "registered")
        self.assertEqual(self.read("failed_" + self.email)["registrationStatus"], "unknown")
        self.assertEqual(self.marked("unregistered", email="history_" + self.email).status_code, 409)

    def test_password_checkpoint_is_reused_across_concurrent_calls(self):
        context, _, _ = self.reservation()
        generate = Mock(return_value="offline-generated-password")
        with ThreadPoolExecutor(max_workers=4) as pool:
            values = list(pool.map(lambda _: self.store.password_checkpoint(context["taskUuid"], generate), range(4)))
        self.assertEqual(values, ["offline-generated-password"] * 4)
        generate.assert_called_once()

    def test_literal_email_characters_do_not_bind_another_historical_account(self):
        for character in ("_", "%"):
            with self.subTest(character=character):
                email = character + self.email
                with self.sessions.get_db() as db:
                    db.add(self.models.Account(email="x" + self.email, password="",
                                               email_service="apple_hidden"))
                    db.commit()
                self.assertEqual(self.read(email)["registrationStatus"], "unregistered")
                self.assertIsNone(self.integration.persisted_account(email))
                self.assertEqual(self.marked(email=email).status_code, 200)
                request = self.apple.StartInput(aliasId=self.alias, email=email,
                    revision=self.read(email)["revision"], operatorId="offline-admin")
                record = self.store.reserve(request, str(uuid.uuid4()))
                self.assertIsNotNone(record["activeTaskUuid"])
                with self.sessions.get_db() as db:
                    db.query(self.models.Account).filter_by(email="x" + self.email).delete()
                    db.commit()

    def test_exact_email_match_remains_case_insensitive_for_history_and_save_receipts(self):
        with self.sessions.get_db() as db:
            db.add(self.models.Account(email=self.email.upper(), password="",
                                       email_service="apple_hidden"))
            db.commit()
        self.assertEqual(self.read()["registrationStatus"], "registered")
        account = self.integration.persisted_account(self.email)
        self.assertEqual(account.email, self.email.upper())
        self.assertEqual(self.marked("unregistered").status_code, 409)
        request = self.apple.StartInput(aliasId=self.alias, email=self.email,
            revision=self.read()["revision"], operatorId="offline-admin")
        with self.assertRaises(HTTPException) as raised:
            self.store.reserve(request, str(uuid.uuid4()))
        self.assertEqual(raised.exception.status_code, 409)

    def test_failed_checkpoint_commit_blocks_original_password_post(self):
        context, provider, _ = self.reservation()
        registration = importlib.import_module("src.core.register")
        engine = registration.RegistrationEngine(provider, task_uuid=context["taskUuid"])
        engine.email = self.email
        engine._log = Mock()
        session = self.official_session()
        original_post = session.post
        engine.http_client._session = session
        self.assertTrue(engine._init_session())
        from sqlalchemy.orm import Session
        with patch.object(Session, "commit", side_effect=RuntimeError("offline-storage-failure")):
            self.assertEqual(engine._register_password(), (False, None))
        original_post.assert_not_called()
        with self.sessions.get_db() as db:
            _, data = self.store.task_data(db, context["taskUuid"])
            self.assertNotIn("passwordCheckpoint", data)
            self.assertFalse(data["sideEffectPossible"])

    def test_original_password_post_has_durable_checkpoint_and_marks_unknown_side_effect(self):
        context, provider, _ = self.reservation()
        registration = importlib.import_module("src.core.register")
        engine = registration.RegistrationEngine(provider, task_uuid=context["taskUuid"])
        engine.email = self.email
        engine._log = Mock()
        session = self.official_session()

        def submitted(url, **kwargs):
            with self.sessions.get_db() as db:
                _, data = self.store.task_data(db, context["taskUuid"])
                self.assertEqual(json.loads(kwargs["data"])["password"], data["passwordCheckpoint"])
                self.assertTrue(data["sideEffectPossible"])
            raise TimeoutError("offline-response-lost")

        session.post = Mock(side_effect=submitted)
        engine.http_client._session = session
        self.assertTrue(engine._init_session())
        self.assertEqual(engine._register_password(), (False, None))
        self.store.finish(self.email, context["taskUuid"], False)
        self.assertEqual(self.read()["registrationStatus"], "unknown")
        self.assertEqual(self.read()["activeTaskUuid"], context["taskUuid"])
        self.assertEqual(self.read()["taskStatus"], "awaiting_review")

    def test_official_identity_requires_authenticated_matching_structured_user(self):
        session = self.official_session()
        self.assertEqual(self.apple.verify_identity(session, self.email)["identityStatus"], "awaiting_identity")
        session.get.assert_not_called()
        identity = self.apple.verify_identity(session, self.email, "offline-access")
        self.assertEqual(identity["identityStatus"], "verified")
        self.assertEqual(identity["identityEvidence"]["source"], "official_me_response")
        self.assertEqual(session.get.call_args.args, ("https://chatgpt.com/backend-api/me",))
        self.assertIn("authorization", session.get.call_args.kwargs["headers"])
        for fixture in (self.official_session(status=403), self.official_session(malformed=True),
                        self.official_session(redirected=True)):
            self.assertEqual(self.apple.verify_identity(fixture, self.email, "offline-access")["identityStatus"], "awaiting_identity")
        self.assertEqual(self.apple.verify_identity(self.official_session(email="other@example.invalid"),
                                                  self.email, "offline-access")["identityStatus"], "mismatch")
        cookie_session = self.official_session(cookie=True)
        self.assertEqual(self.apple.verify_identity(cookie_session, self.email)["identityStatus"], "verified")
        self.assertEqual(cookie_session.get.call_args.args, ("https://chatgpt.com/api/auth/session",))

    def test_sync_payload_is_durable_stable_private_and_ack_is_idempotent(self):
        context, _, _ = self.successful_saved_task()
        task_uuid = context["taskUuid"]
        payload = self.client.get("/internal/apple-mailboxes/tasks/" + task_uuid + "/sync-payload", headers=self.headers).json()
        self.assertEqual(payload["sourceTaskUuid"], task_uuid)
        self.assertEqual(payload["fingerprint"], importlib.import_module("apple_closed_loop").fingerprint(payload))
        self.assertEqual(self.store.sync_payload(task_uuid), payload)
        public = json.dumps(self.integration.task(task_uuid))
        self.assertNotIn("offline-checkpoint-password", public)
        self.assertNotIn("offline-access", public)
        raw_bytes = (Path(self.runtime.name) / "database.db").read_bytes()
        self.assertNotIn(b"offline-checkpoint-password", raw_bytes)
        self.assertNotIn(b"offline-refresh", raw_bytes)
        self.assertIn(task_uuid, [item["taskUuid"] for item in self.store.sync_pending()["tasks"]])
        for status in ("saved", "saved", "failed"):
            response = self.post("tasks/" + task_uuid + "/sync-ack", {"accountId": payload["accountId"], "status": status})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["syncStatus"], "saved")
        self.assertEqual(self.post("tasks/" + task_uuid + "/sync-ack", {"accountId": str(uuid.uuid4()), "status": "saved"}).status_code, 409)
        self.assertEqual(self.post("tasks/" + task_uuid + "/sync-retry", {}).json()["syncStatus"], "saved")

    def test_awaiting_identity_can_only_resume_from_actual_readonly_response(self):
        context, _, _ = self.successful_saved_task(verified=False, creation=False)
        task_uuid = context["taskUuid"]
        self.assertEqual(self.read()["syncStatus"], "awaiting_identity")
        self.assertEqual(self.client.get("/internal/apple-mailboxes/tasks/" + task_uuid + "/sync-payload", headers=self.headers).status_code, 409)
        client_module = importlib.import_module("src.core.http_client")
        session = self.official_session()
        with patch.object(client_module, "OpenAIHTTPClient", return_value=SimpleNamespace(session=session, close=Mock())):
            response = self.post("tasks/" + task_uuid + "/sync-retry", {})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["syncStatus"], "pending")
        session.get.assert_called_once()
        self.assertEqual(self.store.sync_payload(task_uuid)["identityStatus"], "verified")

    def test_local_save_false_is_failed_task_and_recovery_never_registers_or_duplicates(self):
        task = self.run_original_algorithm_offline(fail_save=True)
        self.assertEqual(task["status"], "failed")
        self.assertEqual(task["record"]["registrationStatus"], "registered")
        self.assertEqual(task["localSaveStatus"], "failed")
        registration = importlib.import_module("src.core.register")
        with patch.object(registration.RegistrationEngine, "run", side_effect=AssertionError("禁止重新注册")):
            for _ in range(2):
                response = self.post("tasks/" + task["taskUuid"] + "/local-save-retry", {})
                self.assertEqual(response.status_code, 200)
        with self.sessions.get_db() as db:
            accounts = db.query(self.models.Account).filter_by(email=self.email).all()
            self.assertEqual(len(accounts), 1)
            self.assertEqual(accounts[0].extra_data["idSourceTaskUuid"], task["taskUuid"])

    def test_save_conflict_keeps_manual_account_and_password_untouched(self):
        context, provider, _ = self.reservation()
        with self.sessions.get_db() as db:
            db.add(self.models.Account(email=self.email, password="offline-manual-password", email_service="custom_domain"))
            db.commit()
        registration = importlib.import_module("src.core.register")
        engine = registration.RegistrationEngine(provider, task_uuid=context["taskUuid"])
        result = registration.RegistrationResult(success=True, email=self.email, source="login", password="")
        with self.assertRaisesRegex(ValueError, "其他来源"):
            engine.save_to_database(result)
        with self.sessions.get_db() as db:
            account = db.query(self.models.Account).filter_by(email=self.email).one()
            self.assertEqual(account.password, "offline-manual-password")
            self.assertEqual(account.email_service, "custom_domain")
        self.assertEqual(self.read()["syncStatus"], "conflict")

    def test_late_result_and_ack_cannot_advance_newer_mailbox_lease(self):
        context, _, _ = self.successful_saved_task()
        task_uuid = context["taskUuid"]
        payload = self.store.sync_payload(task_uuid)
        with self.store.transaction() as db:
            record = self.store.read(db, self.email)
            record.update(activeTaskUuid=str(uuid.uuid4()), lastTaskUuid=str(uuid.uuid4()), syncStatus="not_started")
            self.store.write(db, record)
        self.assertFalse(self.store.update_task(task_uuid, creationConfirmed=True))
        self.assertEqual(self.read()["syncStatus"], "not_started")
        self.assertEqual(self.post("tasks/" + task_uuid + "/sync-ack", {"accountId": payload["accountId"], "status": "saved"}).status_code, 409)
        self.assertNotIn(task_uuid, [item["taskUuid"] for item in self.store.sync_pending()["tasks"]])

    def test_batch_persists_all_bindings_atomically_and_reuses_scheduler_options(self):
        emails = [self.email, "second_" + self.email]
        calls, release = [], threading.Event()

        async def scheduler(*args):
            calls.append(args)
            while not release.is_set():
                await asyncio.sleep(0.01)

        items = [{"aliasId": self.alias + str(index), "email": email, "revision": 0} for index, email in enumerate(emails)]
        options = {"auto_upload_cpa": True, "cpa_service_ids": [3], "auto_upload_sub2api": True,
                   "sub2api_service_ids": [4], "auto_upload_tm": True, "tm_service_ids": [5],
                   "mailboxSelection": "automatic"}
        with patch.object(self.integration.route, "run_batch_registration", side_effect=scheduler):
            try:
                response = self.post("batch", {"items": items, "operatorId": "offline-admin", "options": options,
                    "mode": "parallel", "concurrency": 2, "interval_min": 1, "interval_max": 2})
                self.assertEqual(response.status_code, 200)
                batch = response.json()
                self.assertEqual(len(set(batch["taskUuids"])), 2)
                deadline = time.monotonic() + 3
                while not calls and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(calls[0][2:], ("temp_mail", None, {}, None, 1, 2, 2, "parallel", True, [3], True, [4], True, [5]))
                active = self.client.get("/internal/apple-mailboxes/tasks-active", headers=self.headers).json()["tasks"]
                self.assertEqual({task["email"] for task in active if task["taskUuid"] in batch["taskUuids"]}, set(emails))
                with self.sessions.get_db() as db:
                    row = db.get(self.models.Setting, self.apple.BATCH_PREFIX + batch["batchId"])
                    self.assertEqual(json.loads(row.value)["taskUuids"], batch["taskUuids"])
                    for task_uuid, item in zip(batch["taskUuids"], items):
                        _, data = self.store.task_data(db, task_uuid)
                        self.assertEqual(data["email"], item["email"])
                        self.assertEqual(data["batchId"], batch["batchId"])
                        self.assertIsInstance(data["startedAt"], str)
                        self.assertEqual(data["mailboxSelection"], "automatic")
                        self.assertEqual(data["proxySource"], "default")
                        self.assertIsNone(data["proxyId"])
                self.assertEqual(self.post("batches/" + batch["batchId"] + "/cancel", {}).status_code, 200)
            finally:
                release.set()
                deadline = time.monotonic() + 3
                while any(self.read(email)["activeTaskUuid"] for email in emails) and time.monotonic() < deadline:
                    time.sleep(0.01)

    def test_batch_storage_failure_rolls_back_every_mailbox_and_child_task(self):
        items = [{"aliasId": self.alias, "email": self.email, "revision": 0},
                 {"aliasId": self.alias + "2", "email": "second_" + self.email, "revision": 0}]
        from sqlalchemy.orm import Session
        request = self.apple.BatchInput(items=items, operatorId="offline-admin")
        with patch.object(Session, "commit", side_effect=RuntimeError("offline-batch-commit-failure")):
            with self.assertRaises(RuntimeError):
                asyncio.run(self.integration.batch(request))
        for item in items:
            self.assertIsNone(self.read(item["email"])["activeTaskUuid"])
        with self.sessions.get_db() as db:
            for row in db.query(self.models.Setting).filter(self.models.Setting.key.startswith(self.apple.TASK_PREFIX)).all():
                self.assertNotIn(json.loads(row.value)["email"], [item["email"] for item in items])

    def test_sync_error_and_conflict_retry_are_controlled_and_saved_never_downgrades(self):
        context, _, _ = self.successful_saved_task()
        task_uuid = context["taskUuid"]
        payload = self.store.sync_payload(task_uuid)
        self.assertEqual(self.post("tasks/" + task_uuid + "/sync-ack", {
            "accountId": payload["accountId"], "status": "failed", "errorKind": "raw-secret-error"}).status_code, 400)
        self.assertEqual(self.post("tasks/" + task_uuid + "/sync-ack", {
            "accountId": payload["accountId"], "status": "failed", "errorKind": "storage_unavailable"}).status_code, 200)
        self.assertEqual(self.post("tasks/" + task_uuid + "/sync-retry", {}).json()["syncStatus"], "pending")
        self.assertEqual(self.post("tasks/" + task_uuid + "/sync-ack", {
            "accountId": payload["accountId"], "status": "conflict", "errorKind": "email_conflict"}).status_code, 200)
        self.assertEqual(self.post("tasks/" + task_uuid + "/sync-retry", {}).status_code, 409)

    def test_stale_password_and_wrong_result_email_are_blocked_without_saving(self):
        context, provider, _ = self.reservation()
        self.store.password_checkpoint(context["taskUuid"], lambda: "offline-fixed-password")
        registration = importlib.import_module("src.core.register")
        engine = registration.RegistrationEngine(provider, task_uuid=context["taskUuid"])
        result = registration.RegistrationResult(success=True, email=self.email, password="offline-other-password")
        with self.assertRaises(ValueError):
            engine.save_to_database(result)
        self.assertEqual(self.read()["reason"], "password_missing")
        result.email = "other@example.invalid"
        with self.assertRaises(ValueError):
            engine.save_to_database(result)
        with self.sessions.get_db() as db:
            self.assertIsNone(db.query(self.models.Account).filter_by(email=self.email).first())

    def test_account_creation_failure_and_loose_existing_hint_hold_review_lease(self):
        context, provider, _ = self.reservation()
        engine = SimpleNamespace(http_client=SimpleNamespace(get=Mock()),
            _submit_signup_form=Mock(return_value=SimpleNamespace(is_existing_account=False)),
            _send_verification_code=Mock(return_value=True), _create_user_account=Mock(return_value=False),
            _mark_email_as_registered=Mock())
        self.integration.observe_engine(engine, provider)
        self.assertFalse(engine._create_user_account())
        self.store.finish(self.email, context["taskUuid"], False)
        self.assertEqual(self.read()["reason"], "account_creation_failed")
        self.assertEqual(self.read()["registrationStatus"], "unknown")
        self.assertEqual(self.read()["activeTaskUuid"], context["taskUuid"])
        engine._mark_email_as_registered()
        self.assertEqual(self.read()["reason"], "existing_account_suspected")
        self.assertEqual(self.read()["registrationStatus"], "unknown")

    def test_unsafe_proxy_failure_happens_before_claiming_mailbox(self):
        with patch.object(self.apple, "resolve_system_proxy", side_effect=ValueError("代理暂不可用")):
            response = self.post("start", {"aliasId": self.alias, "email": self.email, "revision": 0,
                "operatorId": "offline-admin", "options": {"system_proxy": {"mode": "dynamic"}}})
        self.assertEqual(response.status_code, 409)
        self.assertIsNone(self.read()["activeTaskUuid"])
        self.assertEqual(self.read()["revision"], 0)

    def test_system_proxy_resolver_reuses_shared_parser_and_encodes_credentials(self):
        helper = importlib.import_module("apple_closed_loop")
        proxy_directory = workspace.PROJECT_ROOT / "apps/api/src/id-business-v2/auto-recharge/worker"
        sys.path.append(str(proxy_directory))
        server_proxy = importlib.import_module("server_proxy")
        config = {"mode": "dynamic", "type": "socks5", "extractionUrl": "https://example.invalid/proxy"}
        with patch.object(server_proxy, "resolve_proxy", return_value={"server": "socks5://8.8.8.8:1234",
                           "username": "offline:user", "password": "offline@password"}) as resolve:
            self.assertEqual(helper.resolve_system_proxy(config), "socks5://offline%3Auser:offline%40password@8.8.8.8:1234")
        resolve.assert_called_once_with(config)

    def test_batch_skips_registered_and_reuses_one_resolved_proxy_for_all_children(self):
        registered = "registered_" + self.email
        fresh = "fresh_" + self.email
        self.assertEqual(self.marked("registered", email=registered).status_code, 200)
        items = [{"aliasId": self.alias, "email": self.email, "revision": 0},
                 {"aliasId": self.alias + "2", "email": fresh, "revision": 0},
                 {"aliasId": self.alias + "3", "email": registered, "revision": self.read(registered)["revision"]}]
        calls, release = [], threading.Event()

        async def scheduler(*args):
            calls.append(args)
            while not release.is_set():
                await asyncio.sleep(0.01)

        options = {"system_proxy": {"mode": "dynamic", "type": "https", "extractionUrl": "https://example.invalid/one"}}
        with patch.object(self.apple, "resolve_system_proxy", return_value="https://8.8.8.8:1234") as resolve, \
                patch.object(self.integration.route, "run_batch_registration", side_effect=scheduler):
            try:
                response = self.post("batch", {"items": items, "operatorId": "offline-admin", "options": options})
                self.assertEqual(response.status_code, 200)
                batch = response.json()
                self.assertEqual(len(batch["taskUuids"]), 2)
                self.assertEqual(len(batch["skipped"]), 1)
                deadline = time.monotonic() + 3
                while not calls and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(calls[0][3], "https://8.8.8.8:1234")
                self.assertEqual({self.integration.contexts[task_uuid]["proxy"] for task_uuid in batch["taskUuids"]},
                                 {"https://8.8.8.8:1234"})
                resolve.assert_called_once()
                public = self.client.get("/internal/apple-mailboxes/batches/" + batch["batchId"], headers=self.headers).text
                self.assertNotIn("extractionUrl", public)
                self.assertNotIn("system_proxy", public)
            finally:
                release.set()
                deadline = time.monotonic() + 3
                while any(self.read(email)["activeTaskUuid"] for email in (self.email, fresh)) and time.monotonic() < deadline:
                    time.sleep(0.01)

    def test_login_branch_without_official_identity_stays_unknown_until_readonly_retry(self):
        task = self.run_original_algorithm_offline(existing=True, verified_identity=False)
        self.assertEqual(task["record"]["registrationStatus"], "unknown")
        self.assertEqual(task["syncStatus"], "awaiting_identity")
        self.assertEqual(task["record"]["activeTaskUuid"], task["taskUuid"])
        client_module = importlib.import_module("src.core.http_client")
        session = self.official_session()
        with patch.object(client_module, "OpenAIHTTPClient", return_value=SimpleNamespace(session=session, close=Mock())):
            response = self.post("tasks/" + task["taskUuid"] + "/sync-retry", {})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["syncStatus"], "pending")
        self.assertEqual(self.read()["registrationStatus"], "registered")
        self.assertEqual(self.read()["lastResultKind"], "existing_account")
        self.assertIsNone(self.read()["registrationIp"])
        self.assertIsNone(self.read()["activeTaskUuid"])

    def test_deleted_local_account_cannot_be_restored_by_old_save_or_sync_payload(self):
        context, _, _ = self.successful_saved_task()
        task_uuid = context["taskUuid"]
        with self.sessions.get_db() as db:
            db.delete(db.query(self.models.Account).filter_by(email=self.email).one())
            db.commit()
        self.integration.jobs.pop(task_uuid, None)
        self.assertEqual(self.client.get("/internal/apple-mailboxes/tasks/" + task_uuid + "/sync-payload", headers=self.headers).status_code, 409)
        self.assertEqual(self.post("tasks/" + task_uuid + "/local-save-retry", {}).status_code, 409)
        self.assertEqual(self.read()["syncErrorKind"], "deleted_account")
        with self.sessions.get_db() as db:
            self.assertIsNone(db.query(self.models.Account).filter_by(email=self.email).first())

    def test_local_save_recovery_preserves_metadata_client_id_proxy_and_complete_tokens(self):
        context, provider, _ = self.reservation()
        registration = importlib.import_module("src.core.register")
        proxy = "https://offline-proxy-user:offline-proxy-secret@8.8.8.8:1234"
        password = self.store.password_checkpoint(context["taskUuid"], lambda: "offline-snapshot-password")
        self.store.registered(self.email, context["taskUuid"], existing=False)
        with patch.object(registration.RegistrationEngine, "save_to_database", return_value=False):
            engine = registration.RegistrationEngine(provider, proxy_url=proxy, task_uuid=context["taskUuid"])
            engine._apple_identity = self.apple.verify_identity(self.official_session(), self.email, "offline-access")
            result = registration.RegistrationResult(success=True, email=self.email, password=password,
                access_token="offline-complete-access-token-should-not-be-truncated",
                refresh_token="offline-complete-refresh-token-should-not-be-truncated",
                metadata={"registered_at": "2026-10-11T00:00:00", "is_existing_account": False, "proxy_used": proxy})
            with self.assertRaises(ValueError):
                engine.save_to_database(result)
        self.store.finish(self.email, context["taskUuid"], False)
        self.integration.jobs.pop(context["taskUuid"], None)
        with self.sessions.get_db() as db:
            _, data = self.store.task_data(db, context["taskUuid"])
            original_client_id = data["configurationCheckpoint"]["clientId"]
        original_settings = registration.get_settings()
        changed = SimpleNamespace(openai_client_id="offline-changed-client-id")
        with patch.object(registration, "get_settings", return_value=original_settings):
            # The engine initializer imports current settings too; isolate the
            # save read itself so both old/new configurations are exercised.
            original_save = registration.RegistrationEngine.save_to_database

            def current_settings_save(engine, result):
                with patch.object(registration, "get_settings", return_value=changed):
                    return original_save(engine, result)

            with patch.object(registration.RegistrationEngine, "save_to_database", current_settings_save):
                response = self.post("tasks/" + context["taskUuid"] + "/local-save-retry", {})
        self.assertEqual(response.status_code, 200)
        with self.sessions.get_db() as db:
            account = db.query(self.models.Account).filter_by(email=self.email).one()
            self.assertEqual(account.client_id, original_client_id)
            self.assertEqual(account.proxy_used, proxy)
            self.assertEqual(account.access_token, result.access_token)
            self.assertEqual(account.refresh_token, result.refresh_token)
            self.assertEqual(account.extra_data["registered_at"], "2026-10-11T00:00:00")
        public = json.dumps(response.json())
        self.assertNotIn("offline-proxy-secret", public)
        self.assertNotIn("offline-complete-access-token", public)

    def test_batch_all_candidates_skipped_does_not_persist_or_schedule_empty_batch(self):
        emails = [self.email, "second_" + self.email]
        for email in emails:
            self.assertEqual(self.marked("registered", email=email).status_code, 200)
        items = [{"aliasId": self.alias + str(index), "email": email, "revision": self.read(email)["revision"]}
                 for index, email in enumerate(emails)]
        with self.sessions.get_db() as db:
            batches_before = db.query(self.models.Setting).filter(self.models.Setting.key.startswith(self.apple.BATCH_PREFIX)).count()
            tasks_before = db.query(self.models.RegistrationTask).count()
        with patch.object(self.integration.route, "run_batch_registration") as runner:
            response = self.post("batch", {"items": items, "operatorId": "offline-admin"})
            self.assertEqual(response.status_code, 200)
            self.assertIsNone(response.json()["batchId"])
            self.assertEqual(response.json()["taskUuids"], [])
            self.assertEqual(len(response.json()["skipped"]), 2)
            runner.assert_not_called()
        with self.sessions.get_db() as db:
            self.assertEqual(db.query(self.models.Setting).filter(self.models.Setting.key.startswith(self.apple.BATCH_PREFIX)).count(), batches_before)
            self.assertEqual(db.query(self.models.RegistrationTask).count(), tasks_before)
        for email in emails:
            self.assertIsNone(self.read(email)["activeTaskUuid"])

    def assert_reliable_fact_cannot_reenter_pool(self):
        self.assertEqual(self.marked("unknown").status_code, 409)
        self.assertEqual(self.marked("unregistered").status_code, 409)
        self.assertEqual(self.read()["registrationStatus"], "registered")
        request = self.apple.StartInput(aliasId=self.alias, email=self.email,
            revision=self.read()["revision"], operatorId="offline-admin")
        with self.assertRaises(HTTPException) as rejected:
            self.store.reserve(request, str(uuid.uuid4()))
        self.assertEqual(rejected.exception.status_code, 409)

    def assert_pending_created_account(self, task):
        with self.sessions.get_db() as db:
            account = db.query(self.models.Account).filter_by(email=self.email).one()
            _, data = self.store.task_data(db, task["taskUuid"])
            self.assertTrue(data["creationConfirmed"])
            self.assertTrue(account.password)
            self.assertEqual(account.password, data["passwordCheckpoint"])
            self.assertEqual(account.source, "register")
            self.assertEqual(account.status, "expired")
            self.assertEqual(account.extra_data["idSourceTaskUuid"], task["taskUuid"])
            self.assertEqual(account.extra_data["idAuthorizationStatus"], "pending")
            for field in ("access_token", "refresh_token", "id_token", "session_token", "account_id", "workspace_id"):
                self.assertIsNone(getattr(account, field), field)

    def test_remote_creation_oauth_failure_task_fact_prevents_manual_unknown_and_new_registration(self):
        task = self.run_original_algorithm_offline(fail_after_created=True)
        self.assertEqual(task["record"]["source"], "automatic")
        self.assert_pending_created_account(task)
        self.assert_reliable_fact_cannot_reenter_pool()
        self.assert_pending_created_account(task)

    def test_local_save_failure_task_fact_prevents_manual_unknown_and_new_registration(self):
        task = self.run_original_algorithm_offline(fail_save=True)
        self.assertEqual(task["record"]["localSaveStatus"], "failed")
        self.assert_pending_created_account(task)
        self.assert_reliable_fact_cannot_reenter_pool()
        self.assert_pending_created_account(task)

    def test_deleted_local_account_retains_registration_fact_against_manual_unknown_and_reserve(self):
        context, _, _ = self.successful_saved_task()
        self.store.finish(self.email, context["taskUuid"], False)
        with self.sessions.get_db() as db:
            db.delete(db.query(self.models.Account).filter_by(email=self.email).one())
            db.commit()
        self.assert_reliable_fact_cannot_reenter_pool()

    def test_legacy_registration_task_survives_old_unknown_bypass_and_later_task_binding(self):
        task = self.run_original_algorithm_offline(fail_after_created=True)
        with self.store.transaction() as db:
            row = db.get(self.models.Setting, self.apple.key_for(self.email))
            record = json.loads(row.value)
            record.pop("registrationEvidenceTaskUuid", None)
            record.update(registrationStatus="unregistered", source="manual", lastTaskUuid=str(uuid.uuid4()))
            row.value = json.dumps(record)
            binding, data = self.store.task_data(db, task["taskUuid"])
            data.pop("creationConfirmed", None)
            binding.value = json.dumps(data)
        self.assertEqual(self.read()["registrationStatus"], "registered")
        self.assert_reliable_fact_cannot_reenter_pool()

    def test_unverified_existing_hint_still_allows_explicit_historical_correction(self):
        context, provider, _ = self.reservation()
        engine = SimpleNamespace(http_client=SimpleNamespace(get=Mock()),
            _submit_signup_form=Mock(return_value=SimpleNamespace(is_existing_account=True)),
            _send_verification_code=Mock(return_value=True), _create_user_account=Mock(return_value=False),
            _mark_email_as_registered=Mock())
        self.observed_signup_fixture(engine, provider,
            SimpleNamespace(success=True, is_existing_account=True, page_type="email_otp_verification"))
        self.integration.observe_engine(engine, provider)
        engine._submit_signup_form()
        self.store.finish(self.email, context["taskUuid"], False)
        self.integration.jobs.pop(context["taskUuid"], None)
        recovery = self.post("recover", {"aliasId": self.alias, "email": self.email,
            "revision": self.read()["revision"], "operatorId": "offline-admin"})
        self.assertEqual(recovery.status_code, 200)
        self.assertEqual(self.marked("unregistered").status_code, 200)
        request = self.apple.StartInput(aliasId=self.alias, email=self.email,
            revision=self.read()["revision"], operatorId="offline-admin")
        self.assertEqual(self.store.reserve(request, str(uuid.uuid4()))["registrationStatus"], "unregistered")

    def test_verified_existing_login_fact_survives_deleted_local_account(self):
        task = self.run_original_algorithm_offline(existing=True)
        with self.sessions.get_db() as db:
            _, data = self.store.task_data(db, task["taskUuid"])
            self.assertTrue(data["verifiedExistingAccount"])
            self.assertEqual(data["identityStatus"], "verified")
            self.assertNotIn("creationConfirmed", data)
            db.delete(db.query(self.models.Account).filter_by(email=self.email).one())
            db.commit()
        self.assert_reliable_fact_cannot_reenter_pool()
        self.assertIsNone(self.read()["registrationIp"])

    def test_manual_registered_without_reliable_task_fact_remains_correctable(self):
        self.assertEqual(self.marked("registered").status_code, 200)
        self.assertEqual(self.marked("unknown").status_code, 200)
        self.assertEqual(self.marked("unregistered").status_code, 200)

    def diagnostic_engine(self, email=None, response=None):
        context, provider, _ = self.reservation(email=email)
        registration = importlib.import_module("src.core.register")
        engine = registration.RegistrationEngine(provider, task_uuid=context["taskUuid"])
        engine.email = context["email"]
        engine.email_info = {"email": context["email"], "service_id": self.alias}
        engine._log = Mock()
        session = self.official_session(email=context["email"])
        if response is not None:
            session.get.return_value = response
            session.post.return_value = response
        session._offline_get_transport = session.get
        session._offline_post_transport = session.post
        engine.http_client._session = session
        self.assertTrue(engine._init_session())
        return context, engine, session

    def diagnostic_response(self, status=200, payload=None):
        return SimpleNamespace(status_code=status, json=Mock(return_value=payload if payload is not None else {"page": {"type": "password"}}),
                               text="offline-secret-response", headers={},
                               url="https://auth.openai.com/api/accounts/create_account")

    def test_task_sources_are_safe_and_frozen_without_proxy_credentials(self):
        request = self.apple.StartInput(aliasId=self.alias, email=self.email, revision=0,
            operatorId="offline-admin", options={"proxySource": "system", "proxyId": " offline-proxy-1 ",
            "mailboxSelection": "automatic", "proxy": "http://offline:user@8.8.8.8:1234"})
        task_uuid = str(uuid.uuid4())
        record = self.store.reserve(request, task_uuid)
        public = self.integration.public_record(record)
        for key, value in {"proxySource": "system", "proxyId": "offline-proxy-1",
                           "mailboxSelection": "automatic", "firstFailure": None}.items():
            self.assertEqual(public[key], value)
        with self.sessions.get_db() as db:
            _, data = self.store.task_data(db, task_uuid)
        self.assertEqual(data["proxyId"], "offline-proxy-1")
        self.assertNotIn("offline:user", json.dumps(public))
        self.assertNotIn("proxy", data)
        self.assertEqual(self.apple.ExecutionOptions(proxySource="explicit").proxyId, None)
        self.assertEqual(self.apple.ExecutionOptions().proxySource, "default")

    def test_task_sources_reject_unbound_system_proxy_and_unknown_values(self):
        for options in ({"proxySource": "system"}, {"proxySource": "default", "proxyId": "proxy-1"},
                        {"proxySource": "system", "proxyId": "http://secret.invalid"},
                        {"proxySource": "uncontrolled"}, {"mailboxSelection": "uncontrolled"}):
            with self.subTest(options=options):
                response = self.post("start", {"aliasId": self.alias, "email": self.email, "revision": 0,
                    "operatorId": "offline-admin", "options": options})
                self.assertEqual(response.status_code, 422)
        self.assertIsNone(self.read()["activeTaskUuid"])

    def test_first_terminal_failure_is_immutable_and_validated(self):
        context, _, _ = self.reservation()
        task_uuid = context["taskUuid"]
        self.store.record_failure(task_uuid, "create_account", "account_creation_failed", 400, 17)
        first = self.read()["firstFailure"]
        self.assertEqual(first["stage"], "create_account")
        self.assertEqual(first["elapsedMs"], 17)
        self.assertRegex(first["observedAt"], r"^\d{4}-\d{2}-\d{2}T")
        self.assertEqual(set(first), {"stage", "errorKind", "httpStatus", "elapsedMs", "observedAt"})
        self.store.record_failure(task_uuid, "oauth", "network_error", None, 999)
        self.assertEqual(self.read()["firstFailure"], first)
        with self.sessions.get_db() as db:
            _, data = self.store.task_data(db, task_uuid)
        self.assertEqual(data["firstFailure"], first)
        for stage, kind, status, elapsed in (("raw-url", "unknown", None, 0),
                ("oauth", "raw-token", None, 0), ("oauth", "unknown", True, 0),
                ("oauth", "unknown", 600, 0), ("oauth", "unknown", None, -1)):
            with self.subTest(stage=stage, kind=kind, status=status, elapsed=elapsed):
                with self.assertRaises(ValueError):
                    self.store.record_failure(task_uuid, stage, kind, status, elapsed)

    def test_create_rejection_uses_its_own_status_and_structured_official_code(self):
        context, engine, session = self.diagnostic_engine()
        session._offline_post_transport.side_effect = [self.diagnostic_response(200), self.diagnostic_response(400,
            {"error": {"code": "account_creation_failed", "message": "offline-secret-message"}})]
        self.assertTrue(engine._submit_signup_form("offline-device", None).success)
        self.assertIsNone(self.read()["firstFailure"])
        self.assertFalse(engine._create_user_account())
        failure = self.read()["firstFailure"]
        self.assertEqual((failure["stage"], failure["errorKind"], failure["httpStatus"]),
                         ("create_account", "account_creation_failed", 400))
        self.assertNotIn("offline-secret", json.dumps(self.integration.task(context["taskUuid"])))
        self.store.finish(self.email, context["taskUuid"], False)
        self.assertEqual(self.read()["registrationStatus"], "unknown")
        self.assertEqual(self.read()["activeTaskUuid"], context["taskUuid"])

    def test_create_network_failure_does_not_reuse_previous_signup_200(self):
        _, engine, session = self.diagnostic_engine()
        session._offline_post_transport.side_effect = [self.diagnostic_response(200), TimeoutError("offline-secret-url-token")]
        self.assertTrue(engine._submit_signup_form("offline-device", None).success)
        self.assertFalse(engine._create_user_account())
        failure = self.read()["firstFailure"]
        self.assertEqual((failure["stage"], failure["errorKind"], failure["httpStatus"]),
                         ("create_account", "network_error", None))
        self.assertIsNone(self.read()["lastHttpStatus"])

    def test_unrecognized_error_code_and_response_content_never_enter_diagnostics(self):
        _, engine, session = self.diagnostic_engine()
        session._offline_post_transport.return_value = self.diagnostic_response(403,
            {"error": {"code": "Bearer offline-secret https://secret.invalid?code=private",
                       "message": "offline-secret-message"}, "access_token": "offline-secret-token"})
        self.assertFalse(engine._create_user_account())
        failure = self.read()["firstFailure"]
        self.assertEqual(failure["errorKind"], "http_rejected")
        self.assertEqual(failure["httpStatus"], 403)
        self.assertNotIn("offline-secret", json.dumps(failure))
        self.assertNotIn("secret.invalid", json.dumps(failure))

    def test_exact_otp_workspace_selection_redirect_and_oauth_stages(self):
        cases = (("send", "verification_code", 503), ("fetch", "verification_code", None),
                 ("validate", "verification_validate", 422), ("workspace", "workspace", None),
                 ("select", "select_workspace", 500), ("redirect", "redirect", 200),
                 ("oauth", "oauth", None))
        for name, stage, status in cases:
            with self.subTest(name=name):
                email = self.email.replace("@", "_" + name + "@")
                _, engine, _ = self.diagnostic_engine(email, self.diagnostic_response(status or 200))
                if name == "send":
                    result = engine._send_verification_code()
                elif name == "fetch":
                    with patch.object(engine.email_service, "get_verification_code", return_value=None):
                        result = engine._get_verification_code()
                elif name == "validate":
                    result = engine._validate_verification_code("123456")
                elif name == "workspace":
                    result = engine._get_workspace_id()
                elif name == "select":
                    result = engine._select_workspace("offline-workspace")
                elif name == "redirect":
                    result = engine._follow_redirects("https://example.invalid/start?code=offline-secret")
                else:
                    result = engine._handle_oauth_callback("https://example.invalid/callback?code=offline-secret")
                self.assertFalse(result)
                failure = self.read(email)["firstFailure"]
                self.assertEqual(failure["stage"], stage)
                self.assertEqual(failure["httpStatus"], status)
                self.assertNotIn("offline-secret", json.dumps(failure))

    def test_original_oauth_post_status_arguments_and_other_manager_are_preserved(self):
        _, engine, _ = self.diagnostic_engine()
        oauth = importlib.import_module("src.core.openai.oauth")
        engine.oauth_start = SimpleNamespace(state="offline-state", code_verifier="offline-verifier")
        engine.oauth_manager.proxy_url = "http://8.8.8.8:1234"
        plain = oauth.OAuthManager(proxy_url="http://8.8.8.8:1234")
        self.assertIs(plain.handle_callback.__func__, oauth.OAuthManager.handle_callback)
        self.assertEqual(inspect.signature(engine.oauth_manager.handle_callback), inspect.signature(plain.handle_callback))
        with patch.object(oauth.cffi_requests, "post", return_value=self.diagnostic_response(401)) as post:
            self.assertIsNone(engine._handle_oauth_callback(
                "http://localhost/callback?code=offline-code&state=offline-state"))
            arguments = dict(post.call_args.kwargs)
            self.assertEqual(post.call_args.args, (engine.oauth_manager.token_url,))
            self.assertEqual(arguments["data"], {"grant_type": "authorization_code",
                "client_id": engine.oauth_manager.client_id, "code": "offline-code",
                "redirect_uri": engine.oauth_manager.redirect_uri, "code_verifier": "offline-verifier"})
            self.assertEqual(arguments["timeout"], 30)
            self.assertEqual(arguments["proxies"], {"http": "http://8.8.8.8:1234", "https": "http://8.8.8.8:1234"})
            self.assertEqual(arguments["impersonate"], "chrome")
            with self.assertRaises(RuntimeError):
                plain.handle_callback("http://localhost/callback?code=offline-code&state=offline-state",
                                      "offline-state", "offline-verifier")
            self.assertEqual(post.call_count, 2)
        failure = self.read()["firstFailure"]
        self.assertEqual((failure["stage"], failure["errorKind"], failure["httpStatus"]),
                         ("oauth", "http_rejected", 401))

    def test_original_oauth_network_failure_has_no_status_or_exception_text(self):
        _, engine, _ = self.diagnostic_engine()
        oauth = importlib.import_module("src.core.openai.oauth")
        engine.oauth_start = SimpleNamespace(state="offline-state", code_verifier="offline-verifier")
        with patch.object(oauth.cffi_requests, "post", side_effect=oauth.cffi_requests.RequestsError("offline-secret-url-token")):
            self.assertIsNone(engine._handle_oauth_callback(
                "http://localhost/callback?code=offline-code&state=offline-state"))
        failure = self.read()["firstFailure"]
        self.assertEqual((failure["stage"], failure["errorKind"], failure["httpStatus"]),
                         ("oauth", "network_error", None))
        self.assertNotIn("offline-secret", json.dumps(failure))

    def test_oauth_state_rejection_stays_local_unknown_without_sending_http(self):
        _, engine, _ = self.diagnostic_engine()
        oauth = importlib.import_module("src.core.openai.oauth")
        engine.oauth_start = SimpleNamespace(state="offline-state", code_verifier="offline-verifier")
        with patch.object(oauth.cffi_requests, "post") as post:
            self.assertIsNone(engine._handle_oauth_callback(
                "http://localhost/callback?code=offline-code&state=offline-wrong-state"))
            post.assert_not_called()
        failure = self.read()["firstFailure"]
        self.assertEqual((failure["stage"], failure["errorKind"], failure["httpStatus"]),
                         ("oauth", "unknown", None))

    def replaced_device_session(self, engine):
        first = engine.session
        first._offline_get_transport.return_value = self.diagnostic_response(503)
        replacement = self.official_session()
        replacement.get.return_value = self.diagnostic_response(200)
        transport = replacement.post
        replacement.cookies = {"oai-did": "offline-replaced-device"}
        http = importlib.import_module("src.core.http_client")
        registration = importlib.import_module("src.core.register")
        engine.oauth_start = SimpleNamespace(auth_url="https://auth.openai.com/oauth/authorize?state=offline-secret")
        with patch.object(http, "Session", return_value=replacement) as factory, patch.object(registration.time, "sleep"):
            self.assertEqual(engine._get_device_id(), "offline-replaced-device")
            factory.assert_called_once()
        first.close.assert_called_once()
        self.assertIs(engine.session, replacement)
        self.assertIsNone(self.read()["firstFailure"])
        return replacement, transport

    def test_recovered_device_retry_keeps_password_guard_before_actual_post(self):
        context, engine, _ = self.diagnostic_engine()
        _, transport = self.replaced_device_session(engine)
        calls = []
        def submitted(url, **kwargs):
            with self.sessions.get_db() as db:
                _, data = self.store.task_data(db, context["taskUuid"])
                self.assertEqual(json.loads(kwargs["data"])["password"], data["passwordCheckpoint"])
                self.assertTrue(data["sideEffectPossible"])
                self.assertEqual(data["passwordStatus"], "submitted")
            calls.append(url)
            return self.diagnostic_response(200)
        transport.side_effect = submitted
        success, password = engine._register_password()
        self.assertTrue(success)
        self.assertTrue(password)
        self.assertEqual(len(calls), 1)
        self.assertIsNone(self.read()["firstFailure"])

    def test_replaced_session_checkpoint_failure_sends_no_password_post(self):
        context, engine, _ = self.diagnostic_engine()
        _, transport = self.replaced_device_session(engine)
        from sqlalchemy.orm import Session
        with patch.object(Session, "commit", side_effect=RuntimeError("offline-storage-failure")):
            self.assertEqual(engine._register_password(), (False, None))
        transport.assert_not_called()
        with self.sessions.get_db() as db:
            _, data = self.store.task_data(db, context["taskUuid"])
        self.assertNotIn("passwordCheckpoint", data)
        self.assertFalse(data["sideEffectPossible"])

    def test_device_retry_records_only_the_final_failed_response(self):
        _, engine, first = self.diagnostic_engine()
        first._offline_get_transport.return_value = self.diagnostic_response(503)
        second, third = self.official_session(), self.official_session()
        second.get.return_value = self.diagnostic_response(502)
        third.get.return_value = self.diagnostic_response(403)
        engine.oauth_start = SimpleNamespace(auth_url="https://auth.openai.com/oauth/authorize")
        http = importlib.import_module("src.core.http_client")
        registration = importlib.import_module("src.core.register")
        with patch.object(http, "Session", side_effect=[second, third]) as factory, patch.object(registration.time, "sleep"):
            self.assertIsNone(engine._get_device_id())
            self.assertEqual(factory.call_count, 2)
        first.close.assert_called_once()
        second.close.assert_called_once()
        third.close.assert_not_called()
        failure = self.read()["firstFailure"]
        self.assertEqual((failure["stage"], failure["errorKind"], failure["httpStatus"]),
                         ("queued", "http_rejected", 403))

    def test_created_fact_survives_exact_oauth_failure_and_cannot_reregister(self):
        context, engine, _ = self.diagnostic_engine(response=self.diagnostic_response(200))
        self.store.password_checkpoint(context["taskUuid"], lambda: "offline-created-password")
        self.assertTrue(engine._create_user_account())
        self.assertIsNone(engine._handle_oauth_callback("https://example.invalid/callback"))
        self.store.finish(self.email, context["taskUuid"], False)
        self.assertEqual(self.read()["registrationStatus"], "registered")
        self.assertEqual(self.read()["firstFailure"]["stage"], "oauth")
        self.assertIsNone(self.read()["firstFailure"]["httpStatus"])
        self.assert_reliable_fact_cannot_reenter_pool()

    def test_password_user_exists_is_controlled_hint_without_registration_proof(self):
        context, engine, session = self.diagnostic_engine()
        session._offline_post_transport.return_value = self.diagnostic_response(409,
            {"error": {"code": "user_exists", "message": "offline-existing-hint"}})
        self.assertEqual(engine._register_password(), (False, None))
        failure = self.read()["firstFailure"]
        self.assertEqual((failure["stage"], failure["errorKind"], failure["httpStatus"]),
                         ("password", "user_exists", 409))
        self.assertEqual(self.read()["registrationStatus"], "unregistered")
        self.store.finish(self.email, context["taskUuid"], False)
        self.assertEqual(self.read()["registrationStatus"], "unknown")
        self.assertEqual(self.read()["activeTaskUuid"], context["taskUuid"])

    def test_step_preserves_original_terminal_exception_without_exposing_its_text(self):
        context, _, _ = self.reservation()
        diagnostics = importlib.import_module("apple_registration_diagnostics")
        exception = ValueError("offline-private https://secret.invalid?token=private")
        engine = SimpleNamespace(_select_workspace=Mock(side_effect=exception))
        diagnostics.RegistrationDiagnostics(self.store, context["taskUuid"]).install(engine)
        with self.assertRaises(ValueError) as raised:
            engine._select_workspace("offline-workspace")
        self.assertIs(raised.exception, exception)
        failure = self.read()["firstFailure"]
        self.assertEqual((failure["stage"], failure["errorKind"], failure["httpStatus"]),
                         ("select_workspace", "unknown", None))
        self.assertNotIn("offline-private", json.dumps(failure))

    def test_concurrent_oauth_engines_keep_separate_http_failure_observations(self):
        pairs = [self.diagnostic_engine(self.email.replace("@", "_" + name + "@"))
                 for name in ("left", "right")]
        oauth = importlib.import_module("src.core.openai.oauth")
        barrier = threading.Barrier(2)
        def response(url, **kwargs):
            barrier.wait(timeout=3)
            return self.diagnostic_response(401 if kwargs["data"]["code"] == "left" else 403)
        for _, engine, _ in pairs:
            engine.oauth_start = SimpleNamespace(state="offline-state", code_verifier="offline-verifier")
        with patch.object(oauth.cffi_requests, "post", side_effect=response) as post, ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(engine._handle_oauth_callback,
                "http://localhost/callback?code=" + name + "&state=offline-state")
                for name, (_, engine, _) in zip(("left", "right"), pairs)]
            self.assertEqual([future.result(timeout=4) for future in futures], [None, None])
            self.assertEqual(post.call_count, 2)
        for status, (context, _, _) in zip((401, 403), pairs):
            failure = self.read(context["email"])["firstFailure"]
            self.assertEqual((failure["stage"], failure["httpStatus"]), ("oauth", status))
        self.assertIs(oauth.OAuthManager().handle_callback.__func__, oauth.OAuthManager.handle_callback)


if __name__ == "__main__":
    unittest.main()
