"""Offline Apple-alias acceptance: fixtures only; all registration is mocked."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import importlib
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
        for suffix in ("records", "mark", "start", "recover"):
            response = self.client.post("/internal/apple-mailboxes/" + suffix, json={})
            self.assertEqual(response.status_code, 401)
        self.assertEqual(self.client.get("/internal/apple-mailboxes/requests").status_code, 401)

    def test_default_unknown_is_normalized_and_not_persisted(self):
        response = self.post("records", {"emails": ["  " + self.email.upper() + "  "]})
        record = response.json()["records"][0]
        self.assertEqual(record["email"], self.email)
        self.assertEqual(record["registrationStatus"], "unknown")
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
        self.assertEqual(self.read()["registrationStatus"], "unknown")

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
            _mark_email_as_registered=Mock(return_value=None))
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
        result = SimpleNamespace(is_existing_account=True)
        engine = SimpleNamespace(http_client=SimpleNamespace(get=Mock()),
            _submit_signup_form=Mock(return_value=result), _send_verification_code=Mock(return_value=True),
            _create_user_account=Mock(return_value=True), _mark_email_as_registered=Mock())
        self.integration.observe_engine(engine, provider)
        self.assertIs(engine._submit_signup_form("device", "fixture"), result)
        self.assertGreaterEqual(provider.otp_lower_bound, provider.context["startedAt"])
        self.assertEqual(self.read()["lastResultKind"], "existing_account")

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
            self.assertEqual(calls[0][1], ("temp_mail", None, {}, None))
            self.assertEqual(self.post("tasks/" + task_uuid + "/cancel", {}).status_code, 200)
            self.assertEqual(self.read()["activeTaskUuid"], task_uuid)
            release.set()
            deadline = time.monotonic() + 3
            while self.read()["activeTaskUuid"] and time.monotonic() < deadline:
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

    def run_original_algorithm_offline(self, existing=False, fail_after_created=False):
        registration = importlib.import_module("src.core.register")
        engine_class = registration.RegistrationEngine
        self.assertEqual(self.marked().status_code, 200)

        def signup(engine, *args):
            engine._is_existing_account = existing
            return registration.SignupFormResult(success=True, is_existing_account=existing)

        returns = {
            "_check_ip_location": (True, "US"), "_start_oauth": True,
            "_get_device_id": "offline-device", "_check_sentinel": None,
            "_register_password": (True, ""), "_send_verification_code": True,
            "_get_verification_code": "123456", "_validate_verification_code": True,
            "_create_user_account": True,
            "_get_workspace_id": None if fail_after_created else "offline-workspace",
            "_select_workspace": "https://example.invalid/callback",
            "_follow_redirects": "https://example.invalid/callback",
            "_handle_oauth_callback": {"account_id": "offline-account"},
        }
        with ExitStack() as stack:
            stack.enter_context(patch.object(engine_class, "_submit_signup_form", signup))
            methods = {name: stack.enter_context(patch.object(engine_class, name, return_value=value))
                       for name, value in returns.items()}
            client_class = importlib.import_module("src.core.http_client").HTTPClient
            stack.enter_context(patch.object(client_class, "request", side_effect=AssertionError("禁止离线测试访问网络")))
            response = self.post("start", {"aliasId": self.alias, "email": self.email,
                "revision": self.read()["revision"], "operatorId": "offline-admin"})
            self.assertEqual(response.status_code, 200)
            task_uuid = response.json()["taskUuid"]
            deadline = time.monotonic() + 5
            while self.read()["activeTaskUuid"] and time.monotonic() < deadline:
                time.sleep(0.01)
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


if __name__ == "__main__":
    unittest.main()
