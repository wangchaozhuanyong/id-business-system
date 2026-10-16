"""Pure leased-browser tests: no upstream imports, database or real network."""
from contextlib import contextmanager
from contextvars import ContextVar
import asyncio
import ast
from dataclasses import dataclass
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import sys
import threading
import typing
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import apple_browser_registration as browser
import release_safety as safety
from fastapi import HTTPException
from pydantic import ValidationError

TASK = "882a45c8-536a-4776-b431-d3534d244c09"
NONCE = "d" * 64
PROFILE = "registration_profile"
EMAIL = "synthetic-browser@example.invalid"


def checkpoint():
    return {"version": 1, "phase": "claimed",
        "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
        "claimIdHash": hashlib.sha256(NONCE.encode()).hexdigest(), "sequence": 0, "lastEvent": None,
        "lastEventHash": None, "profileId": None, "passwordAcknowledged": False, "browserOpened": False,
        "emailSubmitted": False, "failureReason": None, "creationEvidence": None}


def event(name, sequence, **kwargs):
    return browser.EventInput(claimId=NONCE, event=name, sequence=sequence, profileId=PROFILE, **kwargs)


def result_input(**changes):
    value = {"claimId": NONCE, "email": EMAIL, "officialUserId": "user_synthetic",
        "creationObserved": True, "creationStatus": 200,
        "creationEvidence": {"pathKind": "create_account", "httpStatus": 200, "noError": True, "officialOrigin": True},
        "session": {"accessToken": "synthetic-access-never-a-real-token"}, "profileId": PROFILE}
    return browser.ResultInput.model_validate({**value, **changes})


class MemoryStore:
    """Small transactional fake; production SQLite is intentionally unavailable."""
    def __init__(self):
        self.row = SimpleNamespace(value=json.dumps({"email": EMAIL, "aliasId": "alias_synthetic", "operatorId": "admin",
            "browserRegistration": checkpoint(), "sideEffectPossible": False,
            "configurationCheckpoint": {"clientId": "synthetic-client", "proxyUsed": None},
            "passwordCheckpoint": "synthetic-checkpoint-only"}))
        self.record = {"email": EMAIL, "activeTaskUuid": TASK, "lastTaskUuid": TASK,
                       "registrationStatus": "unregistered", "source": "manual", "note": "keep this fact",
                       "registrationIp": None, "registrationCountry": None, "attemptIp": None, "attemptCountry": None}
        self.task = SimpleNamespace(status="running", completed_at=None, error_message=None)
        self.db = SimpleNamespace(query=lambda _: SimpleNamespace(filter_by=lambda **kw: SimpleNamespace(first=lambda: self.task)))
        self.commits = 0
        self.reject_commit = False
        self.saved = []

    @contextmanager
    def transaction(self):
        saved = (self.row.value, deepcopy(self.record), deepcopy(self.task.__dict__))
        try:
            yield self.db
            if self.reject_commit:
                raise RuntimeError("synthetic storage rejection")
            self.commits += 1
        except BaseException:
            self.row.value, self.record = saved[0], saved[1]
            self.task.__dict__.clear()
            self.task.__dict__.update(saved[2])
            raise

    @contextmanager
    def get_db(self):
        yield self.db

    def task_data(self, db, task_uuid):
        if task_uuid != TASK:
            raise HTTPException(404, "任务不存在")
        return self.row, json.loads(self.row.value)

    def current(self, db, task_uuid, data):
        return self.record if self.record.get("lastTaskUuid") == task_uuid else None

    def write(self, db, value):
        self.record = deepcopy(value)
        return self.record

    def read(self, db, email):
        return deepcopy(self.record)

    def observe(self, email, task_uuid, *, db=None, **values):
        if db is None:
            with self.transaction() as connection:
                return self.observe(email, task_uuid, db=connection, **values)
        assert db is self.db
        assert self.record["activeTaskUuid"] == task_uuid
        self.record.update(values)
        return self.write(db, self.record)

    def record_failure(self, task_uuid, stage, error_kind, http_status, elapsed_ms):
        with self.transaction():
            data = json.loads(self.row.value)
            if data.get("firstFailure") is not None:
                return
            failure = {"stage": stage, "errorKind": error_kind, "httpStatus": http_status,
                       "elapsedMs": elapsed_ms, "observedAt": browser.timestamp()}
            data.update(firstFailure=failure, lastHttpStatus=http_status)
            self.row.value = json.dumps(data)
            self.record.update(firstFailure=deepcopy(failure), lastHttpStatus=http_status)

    def update_task(self, task_uuid, **values):
        with self.transaction():
            data = json.loads(self.row.value)
            data.update(values)
            self.row.value = json.dumps(data)
        return True

    def finish(self, email, task_uuid, cancelled):
        data = json.loads(self.row.value)
        if data.get("sideEffectPossible") and self.record["registrationStatus"] != "registered":
            self.record.update(registrationStatus="unknown", taskStatus="awaiting_review")
        else:
            self.record["activeTaskUuid"] = None

    def registered(self, email, task_uuid, existing, identity=None):
        assert not existing
        self.record.update(registrationStatus="registered", source="automatic")
        self.update_task(task_uuid, creationConfirmed=True, **identity)

    def capture_result(self, task_uuid, value, identity):
        self.saved.append(value)
        self.update_task(task_uuid, rawResult={"email": value.email}, **identity)
        return True


class BrowserUnitTests(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()
        self.integration = SimpleNamespace(store=self.store, lock=threading.RLock(), contexts={TASK: {
            "taskUuid": TASK, "email": EMAIL, "aliasId": "alias_synthetic", "browserMode": True,
            "cancelled": False, "startedAt": datetime.now(timezone.utc).timestamp()}},
            stopping=False, requests={}, sessions=SimpleNamespace(get_db=self.store.get_db),
            models=SimpleNamespace(RegistrationTask=object), task=lambda _: {"status": "completed"})
        self.actor = SimpleNamespace(get=lambda: "admin")
        self.adapter = browser.BrowserRegistration(self.integration, self.actor)

    def ready(self):
        for item in (event("browser_opened", 1, directConnection=True), event("email_submitting", 2),
                     event("password_submitting", 3), event("official_identity_observed", 4)):
            self.adapter.event(TASK, item)

    def test_both_validators_accept_only_closed_browser_checkpoint_and_old_task_still_valid(self):
        state = checkpoint()
        browser.validate_checkpoint(state)
        safety.validate_browser_checkpoint(state)
        old = {"email": EMAIL, "aliasId": "alias_synthetic", "resultKind": None}
        safety.validate_task(TASK, old)
        safety.validate_task(TASK, {**old, "browserRegistration": state})
        for addition in ({"accessToken": "never expose"}, {"url": "https://unexpected.invalid"}):
            with self.assertRaises(ValueError):
                browser.validate_checkpoint({**state, **addition})
            with self.assertRaises(safety.SafetyError):
                safety.validate_browser_checkpoint({**state, **addition})

    def test_password_submission_is_durable_before_ack_and_storage_rejection_cannot_ack(self):
        self.adapter.event(TASK, event("browser_opened", 1, directConnection=True))
        self.adapter.event(TASK, event("email_submitting", 2))
        committed = self.store.commits
        self.store.reject_commit = True
        with self.assertRaises(RuntimeError):
            self.adapter.event(TASK, event("password_submitting", 3))
        self.assertEqual(self.store.commits, committed)
        self.assertFalse(json.loads(self.store.row.value)["sideEffectPossible"])
        self.store.reject_commit = False
        self.assertEqual(self.adapter.event(TASK, event("password_submitting", 3)), {"accepted": True})
        data = json.loads(self.store.row.value)
        self.assertTrue(data["sideEffectPossible"])
        self.assertEqual(data["passwordStatus"], "submitted")

    def test_password_requires_bound_browser_email_and_checkpoint(self):
        with self.assertRaises(HTTPException):
            self.adapter.event(TASK, event("password_submitting", 1))
        self.adapter.event(TASK, event("browser_opened", 1, directConnection=True))
        self.adapter.event(TASK, event("email_submitting", 2))
        data = json.loads(self.store.row.value)
        data.pop("passwordCheckpoint")
        self.store.row.value = json.dumps(data)
        with self.assertRaises(HTTPException):
            self.adapter.event(TASK, event("password_submitting", 3))

    def test_replay_is_identical_payload_only_and_new_sequence_allows_waiting_state(self):
        opened = event("browser_opened", 1, directConnection=True)
        self.adapter.event(TASK, opened)
        before = self.store.row.value
        self.adapter.event(TASK, opened)
        self.assertEqual(before, self.store.row.value)
        with self.assertRaises(HTTPException):
            self.adapter.event(TASK, event("browser_opened", 1, directConnection=False))
        self.adapter.event(TASK, event("human_verification_required", 2))
        self.adapter.event(TASK, event("human_verification_required", 3))
        with self.assertRaises(HTTPException):
            self.adapter.event(TASK, event("human_verification_required", 5))

    def test_window_substitution_and_wrong_claim_never_mutate(self):
        self.adapter.event(TASK, event("browser_opened", 1, directConnection=True))
        before = self.store.row.value
        bad = event("email_submitting", 2).model_copy(update={"profileId": "another_profile"})
        with self.assertRaises(HTTPException):
            self.adapter.event(TASK, bad)
        wrong = event("email_submitting", 2).model_copy(update={"claimId": "f" * 64})
        with self.assertRaises(HTTPException):
            self.adapter.event(TASK, wrong)
        with self.assertRaises(HTTPException):
            self.adapter.finish(TASK, browser.FailInput(claimId="f" * 64, reason="timeout", sideEffectPossible=True))
        self.assertEqual(before, self.store.row.value)
        self.assertFalse(self.integration.contexts[TASK]["cancelled"])

    def test_cancellation_keeps_unknown_lease_and_manual_note_after_password_ack(self):
        self.ready()
        self.adapter.finish(TASK, cancelled=True)
        self.assertEqual(self.store.record["activeTaskUuid"], TASK)
        self.assertEqual(self.store.record["registrationStatus"], "unknown")
        self.assertEqual(self.store.record["note"], "keep this fact")
        self.assertEqual(self.store.task.status, "cancelled")

    def test_restart_cannot_reclaim_or_submit_result_and_can_safely_cancel(self):
        self.ready()
        self.integration.contexts.clear()
        with self.assertRaises(HTTPException):
            self.adapter.claim(TASK, browser.PrivateInput(claimId=NONCE))
        with self.assertRaises(HTTPException):
            self.adapter.result(TASK, result_input())
        self.adapter.finish(TASK, cancelled=True)
        self.assertEqual(self.store.record["activeTaskUuid"], TASK)

    def test_proxy_direct_confirmation_and_credentials_are_never_public(self):
        for proxy in ("http://user:synthetic@127.0.0.1:18080", "socks5://proxy.example.invalid:1080", None):
            self.assertEqual(browser.fixed_proxy(proxy), proxy)
        for proxy in ("file:///tmp/file", "https://proxy.invalid", "https://proxy.invalid:443/?token=secret"):
            with self.assertRaises(HTTPException):
                browser.fixed_proxy(proxy)
        with self.assertRaises(HTTPException):
            browser.advance_event(checkpoint(), event("browser_opened", 1), None)
        state = browser.advance_event(checkpoint(), event("browser_opened", 1, directConnection=False), "http://proxy.invalid:80")
        public = browser.public_summary(state)
        self.assertEqual(set(public), {"phase", "needAction", "profileId"})
        self.assertNotIn(NONCE, json.dumps(public))

    def test_profile_and_human_verification_require_action_and_expiry_is_read_only(self):
        for phase in ("profile_required", "human_verification_required"):
            state = {**checkpoint(), "phase": phase}
            self.assertTrue(browser.public_summary(state)["needAction"])
        state = {**checkpoint(), "expiresAt": "2000-01-01T00:00:00Z"}
        original = deepcopy(state)
        self.assertEqual(browser.public_summary(state)["phase"], "expired")
        self.assertEqual(state, original)
        self.assertEqual(browser.public_summary(checkpoint(), live=False)["phase"], "interrupted")

    def test_claim_is_same_nonce_idempotent_generates_password_once_and_refuses_second_nonce(self):
        data = json.loads(self.store.row.value)
        data["browserRegistration"].update(phase="waiting_for_browser", claimIdHash=None)
        data.pop("passwordCheckpoint")
        self.store.row.value = json.dumps(data)
        first = self.adapter.claim(TASK, browser.PrivateInput(claimId=NONCE))
        self.assertEqual(set(first), {"taskUuid", "email", "password", "proxy"})
        self.assertEqual(first, self.adapter.claim(TASK, browser.PrivateInput(claimId=NONCE)))
        with self.assertRaises(HTTPException):
            self.adapter.claim(TASK, browser.PrivateInput(claimId="a" * 64))
        self.assertEqual(first["password"], json.loads(self.store.row.value)["passwordCheckpoint"])

    def test_existing_login_without_password_ack_is_not_registration_success(self):
        self.adapter.event(TASK, event("browser_opened", 1, directConnection=True))
        self.adapter.event(TASK, event("email_submitting", 2))
        with self.assertRaises(HTTPException):
            self.adapter.event(TASK, event("official_identity_observed", 3))
        with self.assertRaises(HTTPException):
            self.adapter.result(TASK, result_input())
        self.assertEqual(self.store.saved, [])

    def test_creation_evidence_is_strict_no_error_official_and_success_status_required(self):
        for changed in ({"creationObserved": False}, {"creationStatus": 500}, {"creationObserved": 1},
                        {"creationEvidence": {"pathKind": "create_account", "httpStatus": 200, "noError": False, "officialOrigin": True}},
                        {"creationEvidence": {"pathKind": "create_account", "httpStatus": 201, "noError": True, "officialOrigin": True}}):
            with self.assertRaises(ValidationError):
                result_input(**changed)
        with self.assertRaises(ValidationError):
            browser.FailInput(claimId=NONCE, reason="raw vendor error with secret", sideEffectPossible=False)

    def result_modules(self):
        client = SimpleNamespace(session=SimpleNamespace(cookies=SimpleNamespace(set=Mock())), close=Mock())
        return client, {"src.core.http_client": SimpleNamespace(OpenAIHTTPClient=Mock(return_value=client)),
                        "src.core.register": SimpleNamespace(RegistrationResult=lambda **kw: SimpleNamespace(**kw))}

    def test_independent_official_identity_required_before_creation_or_save(self):
        self.ready()
        client, modules = self.result_modules()
        with patch.dict(sys.modules, modules), patch.object(browser, "verify_identity", return_value={"identityStatus": "mismatch", "reason": "identity_mismatch"}):
            with self.assertRaises(HTTPException):
                self.adapter.result(TASK, result_input())
        self.assertEqual(self.store.saved, [])
        self.assertEqual(self.store.record["registrationStatus"], "unknown")
        self.assertEqual(self.store.record["activeTaskUuid"], TASK)
        self.assertTrue(client.close.called)

    def test_identity_hash_must_match_same_window_user_not_only_email(self):
        self.ready()
        _, modules = self.result_modules()
        wrong = {"identityStatus": "verified", "identityEvidence": {"officialUserIdHash": "0" * 64}}
        with patch.dict(sys.modules, modules), patch.object(browser, "verify_identity", return_value=wrong):
            with self.assertRaises(HTTPException):
                self.adapter.result(TASK, result_input())
        self.assertEqual(self.store.saved, [])

    def test_verified_new_creation_uses_existing_save_sync_and_result_replay_does_not_resubmit(self):
        self.ready()
        identity = {"identityStatus": "verified", "identityEvidence": {
            "officialUserIdHash": hashlib.sha256(b"user_synthetic").hexdigest()}}
        self.integration.persist_result = Mock(return_value=True)
        self.integration.route = SimpleNamespace(RegistrationEngine=SimpleNamespace(save_to_database=Mock(return_value=True)))
        client, modules = self.result_modules()
        with patch.dict(sys.modules, modules), patch.object(browser, "verify_identity", return_value=identity) as verify:
            self.assertTrue(self.adapter.result(TASK, result_input())["accepted"])
            self.assertTrue(self.adapter.result(TASK, result_input())["accepted"])
            self.assertEqual(verify.call_count, 1)
        self.assertEqual(self.integration.persist_result.call_count, 1)
        self.assertEqual(self.store.record["registrationStatus"], "registered")
        self.assertEqual(self.store.task.status, "completed")
        self.assertEqual(self.store.saved[0].password, "synthetic-checkpoint-only")
        self.assertEqual(json.loads(self.store.row.value)["browserRegistration"]["phase"], "completed")
        self.assertTrue(client.close.called)

    def test_cancellation_during_identity_request_prevents_late_credential_save(self):
        self.ready()
        _, modules = self.result_modules()
        def verify(*args):
            self.adapter.finish(TASK, cancelled=True)
            return {"identityStatus": "verified", "identityEvidence": {"officialUserIdHash": hashlib.sha256(b"user_synthetic").hexdigest()}}
        with patch.dict(sys.modules, modules), patch.object(browser, "verify_identity", side_effect=verify):
            with self.assertRaises(HTTPException):
                self.adapter.result(TASK, result_input())
        self.assertEqual(self.store.saved, [])
        self.assertEqual(self.store.record["registrationStatus"], "unknown")

    def test_actor_mismatch_does_not_write_or_cancel(self):
        self.actor.get = lambda: "another_admin"
        original = self.store.row.value
        with self.assertRaises(HTTPException):
            self.adapter.claim(TASK, browser.PrivateInput(claimId=NONCE))
        with self.assertRaises(HTTPException):
            self.adapter.finish(TASK, cancelled=True)
        self.assertEqual(self.store.row.value, original)
        self.assertFalse(self.integration.contexts[TASK]["cancelled"])

    def start_fixture(self):
        self.integration.contexts.clear()
        async def proxy(options):
            return None
        self.integration.execution_proxy = proxy
        self.integration.public_record = lambda record: dict(record)
        self.integration.route = SimpleNamespace(crud=SimpleNamespace(get_random_proxy=Mock(return_value=None)),
            run_registration_task=Mock(side_effect=AssertionError("protocol executor forbidden")))
        self.store.reserve = Mock(return_value=self.store.record)
        self.store.db.flush = Mock()
        self.settings = SimpleNamespace(openai_client_id="synthetic-client", proxy_dynamic_enabled=False, proxy_url=None)
        request = SimpleNamespace(operatorId="admin", aliasId="alias_synthetic", email=EMAIL,
            options=SimpleNamespace(auto_upload_cpa=False, auto_upload_sub2api=False, auto_upload_tm=False, proxySource="default"))
        return request

    def execute_immediate(self, coroutine):
        # All awaited dependencies in this fixture complete synchronously; no
        # event loop, socket pair, network transport or database is created.
        try:
            coroutine.send(None)
        except StopIteration as done:
            return done.value
        self.fail("pure fixture unexpectedly scheduled external work")

    def test_start_reserves_and_freezes_mode_atomically_without_protocol_execution(self):
        request = self.start_fixture()
        module = SimpleNamespace(get_settings=lambda: self.settings)
        with patch.dict(sys.modules, {"src.config.settings": module}), patch.object(browser.uuid, "uuid4", return_value=TASK):
            value = self.execute_immediate(self.adapter.start(request))
        state = json.loads(self.store.row.value)
        self.assertEqual(value["taskUuid"], TASK)
        self.assertEqual(state["browserRegistration"]["phase"], "waiting_for_browser")
        self.assertEqual(state["configurationCheckpoint"], {"clientId": "synthetic-client", "proxyUsed": None})
        self.assertTrue(self.store.db.flush.called)
        self.assertTrue(self.integration.contexts[TASK]["browserMode"])
        self.integration.route.run_registration_task.assert_not_called()

    def test_start_failed_commit_does_not_create_a_live_browser_context(self):
        request = self.start_fixture()
        self.store.reject_commit = True
        module = SimpleNamespace(get_settings=lambda: self.settings)
        with patch.dict(sys.modules, {"src.config.settings": module}), patch.object(browser.uuid, "uuid4", return_value=TASK):
            with self.assertRaises(RuntimeError):
                self.execute_immediate(self.adapter.start(request))
        self.assertEqual(self.integration.contexts, {})
        self.integration.route.run_registration_task.assert_not_called()

    def test_dynamic_default_requires_fixed_selection_before_reserving(self):
        request = self.start_fixture()
        self.settings.proxy_dynamic_enabled = True
        module = SimpleNamespace(get_settings=lambda: self.settings)
        with patch.dict(sys.modules, {"src.config.settings": module}):
            with self.assertRaises(HTTPException):
                self.execute_immediate(self.adapter.start(request))
        self.store.reserve.assert_not_called()

    def test_native_cancellation_prevents_callbacks_even_if_context_survives(self):
        self.ready()
        before = self.store.row.value
        self.store.task.status = "cancelled"
        with self.assertRaises(HTTPException):
            self.adapter.event(TASK, event("official_identity_observed", 5))
        with self.assertRaises(HTTPException):
            self.adapter.result(TASK, result_input())
        self.assertEqual(before, self.store.row.value)

    def test_browser_validation_response_does_not_echo_rejected_credentials(self):
        from fastapi import FastAPI
        from fastapi.exceptions import RequestValidationError
        app = FastAPI()
        browser.install_browser_registration(app, self.integration, browser.PrivateInput, self.actor)
        handler = app.exception_handlers[RequestValidationError]
        request = SimpleNamespace(url=SimpleNamespace(path="/internal/apple-mailboxes/browser/tasks/synthetic/result"))
        response = self.execute_immediate(handler(request, ValueError("synthetic credential must not appear")))
        self.assertEqual(response.status_code, 422)
        self.assertNotIn(b"credential", response.body)

    def test_only_exact_successful_private_claim_retains_fixed_proxy_credentials(self):
        import workspace
        path = "/internal/apple-mailboxes/browser/tasks/" + TASK + "/claim"
        payload = {"taskUuid": TASK, "email": EMAIL, "password": "synthetic-only",
                   "proxy": "http://synthetic:credential@proxy.example.invalid:80"}
        actual = workspace.sanitize_http_payload(payload, path, "POST", 200)
        self.assertEqual(actual["proxy"], payload["proxy"])
        self.assertEqual(set(actual), set(payload))
        for changed, url, method, status in ((payload, path, "GET", 200), (payload, path, "POST", 500),
                ({**payload, "logs": []}, path, "POST", 200), (payload, "/api/accounts", "POST", 200),
                ({**payload, "taskUuid": "another-task"}, path, "POST", 200)):
            safe = workspace.sanitize_http_payload(changed, url, method, status)
            self.assertNotIn("credential", safe["proxy"])

    def test_authenticated_actor_context_survives_private_async_thread_bridge(self):
        actor = ContextVar("synthetic_browser_actor", default=None)
        self.adapter.actor = actor
        token = actor.set("admin")
        try:
            async def call():
                return await asyncio.to_thread(self.adapter.claim, TASK, browser.PrivateInput(claimId=NONCE))
            self.assertEqual(asyncio.run(call())["taskUuid"], TASK)
        finally:
            actor.reset(token)
        self.assertIsNone(actor.get())

    def test_real_asgi_validation_never_echoes_invalid_session_token(self):
        from fastapi import FastAPI
        import httpx
        app = FastAPI()
        browser.install_browser_registration(app, self.integration, browser.PrivateInput, self.actor)
        async def call():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://offline.invalid") as client:
                body = result_input().model_dump()
                body["session"] = {"sessionToken": "synthetic-secret-do-not-echo\n"}
                return await client.post("/internal/apple-mailboxes/browser/tasks/" + TASK + "/result", json=body)
        result = asyncio.run(call())
        self.assertEqual(result.status_code, 422)
        self.assertNotIn("synthetic-secret", result.text)

    def test_browser_trace_observation_is_strict_complete_and_only_at_browser_opened(self):
        valid = event("browser_opened", 1, directConnection=True, attemptIp="2001:db8:0::1",
                      attemptCountry="JP", observationSource="cloudflare_trace")
        self.assertEqual(valid.attemptIp, "2001:db8::1")
        for fields in ({"attemptIp": "127.0.0.1:80", "attemptCountry": "JP", "observationSource": "cloudflare_trace"},
                {"attemptIp": "2001:db8::1%en0", "attemptCountry": "JP", "observationSource": "cloudflare_trace"},
                {"attemptIp": "2001:db8::1", "attemptCountry": "jp", "observationSource": "cloudflare_trace"},
                {"attemptIp": "203.0.113.1", "attemptCountry": "JP"}, {"attemptCountry": "JP"},
                {"attemptIp": "203.0.113.1", "attemptCountry": "JP", "observationSource": "proxy_country"}):
            with self.assertRaises(ValidationError):
                event("browser_opened", 1, **fields)
        with self.assertRaises(ValidationError):
            event("email_submitting", 2, attemptIp="203.0.113.1", attemptCountry="JP", observationSource="cloudflare_trace")

    def test_trace_is_committed_with_event_ack_and_different_observation_replay_is_rejected(self):
        observed = event("browser_opened", 1, directConnection=True, attemptIp="203.0.113.10",
                         attemptCountry="PH", observationSource="cloudflare_trace")
        self.store.reject_commit = True
        with self.assertRaises(RuntimeError):
            self.adapter.event(TASK, observed)
        self.assertIsNone(self.store.record["attemptIp"])
        self.assertNotIn("attemptIp", self.integration.contexts[TASK])
        self.store.reject_commit = False
        self.assertTrue(self.adapter.event(TASK, observed)["accepted"])
        self.assertEqual(self.store.record["attemptIp"], "203.0.113.10")
        self.assertEqual(self.integration.contexts[TASK]["attemptCountry"], "PH")
        self.assertTrue(self.adapter.event(TASK, observed)["accepted"])
        with self.assertRaises(HTTPException):
            self.adapter.event(TASK, observed.model_copy(update={"attemptIp": "203.0.113.11"}))
        with self.assertRaises(HTTPException):
            self.adapter.event(TASK, observed.model_copy(update={"attemptCountry": "JP"}))

    def test_failed_trace_stays_unknown_and_created_but_unbound_profile_id_is_retained(self):
        self.adapter.event(TASK, event("browser_opened", 1, directConnection=True))
        self.assertIsNone(self.store.record["attemptIp"])
        self.assertIsNone(self.store.record["attemptCountry"])
        self.store.row.value = json.dumps({**json.loads(self.store.row.value), "browserRegistration": checkpoint()})
        self.adapter.finish(TASK, browser.FailInput(claimId=NONCE, reason="browser_unavailable",
                                                  sideEffectPossible=False, profileId="created_but_detail_failed"))
        saved = json.loads(self.store.row.value)["browserRegistration"]
        self.assertEqual(saved["profileId"], "created_but_detail_failed")

    def test_existing_real_registration_fact_writer_reuses_browser_observed_ip_country(self):
        observed = event("browser_opened", 1, directConnection=True, attemptIp="203.0.113.10",
                         attemptCountry="PH", observationSource="cloudflare_trace")
        self.adapter.event(TASK, observed)
        tree = ast.parse((Path(__file__).with_name("apple_mailboxes.py")).read_text())
        facts = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "RegistrationFacts")
        method = next(node for node in facts.body if isinstance(node, ast.FunctionDef) and node.name == "registered")
        namespace = {"json": json, "now_iso": browser.timestamp, "HTTPException": HTTPException, "TASK_PREFIX": "id.apple-task."}
        exec(compile(ast.Module(body=[method], type_ignores=[]), "actual-registered-fact-writer", "exec"), namespace)
        self.store.models = SimpleNamespace(Setting=object)
        self.store.db.get = lambda model, key: self.store.row
        namespace["registered"](self.store, EMAIL, TASK, False)
        self.assertEqual(self.store.record["registrationIp"], "203.0.113.10")
        self.assertEqual(self.store.record["registrationCountry"], "PH")
        self.assertEqual(self.store.record["registrationIpSource"], "observed")

    def test_actual_frozen_result_and_save_method_accept_browser_saver_without_engine_init(self):
        upstream = Path(__file__).resolve().parent.parent / "upstream/src/core/register.py"
        tree = ast.parse(upstream.read_text())
        result = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "RegistrationResult")
        engine = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "RegistrationEngine")
        save = next(node for node in engine.body if isinstance(node, ast.FunctionDef) and node.name == "save_to_database")
        create = Mock(return_value=SimpleNamespace(id=7))
        namespace = {"dataclass": dataclass, "Dict": dict, "Any": typing.Any,
            "get_settings": lambda: SimpleNamespace(openai_client_id="actual-client-contract"),
            "get_db": self.store.get_db, "crud": SimpleNamespace(create_account=create)}
        exec(compile(ast.Module(body=[result, save], type_ignores=[]), str(upstream), "exec"), namespace)
        self.ready()
        client, modules = self.result_modules()
        modules["src.core.register"].RegistrationResult = namespace["RegistrationResult"]
        self.integration.route = SimpleNamespace(RegistrationEngine=SimpleNamespace(save_to_database=namespace["save_to_database"]))
        def persist(task_uuid, value, original_save, identity):
            self.assertIsInstance(value, namespace["RegistrationResult"])
            self.assertTrue(original_save(value))
        self.integration.persist_result = persist
        identity = {"identityStatus": "verified", "identityEvidence": {"officialUserIdHash": hashlib.sha256(b"user_synthetic").hexdigest()}}
        with patch.dict(sys.modules, modules), patch.object(browser, "verify_identity", return_value=identity):
            self.assertTrue(self.adapter.result(TASK, result_input(officialAccountId="account_synthetic"))["accepted"])
        values = create.call_args.kwargs
        self.assertEqual(values["account_id"], "account_synthetic")
        self.assertEqual(values["workspace_id"], "")
        self.assertEqual(values["password"], "synthetic-checkpoint-only")
        self.assertEqual(values["email_service"], "apple_hidden")
        self.assertEqual(values["email_service_id"], "alias_synthetic")
        self.assertEqual(values["extra_data"]["idSourceTaskUuid"], TASK)

    def test_actual_frozen_http_client_constructor_session_and_close_match_verifier_contract(self):
        upstream = Path(__file__).resolve().parent.parent / "upstream/src/core/http_client.py"
        tree = ast.parse(upstream.read_text())
        names = {"RequestConfig", "HTTPClient", "OpenAIHTTPClient"}
        nodes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name in names]
        session = SimpleNamespace(close=Mock())
        constructor = Mock(return_value=session)
        namespace = {**vars(typing), "dataclass": dataclass, "Session": constructor, "Response": object,
                     "HTTPClientError": RuntimeError}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(upstream), "exec"), namespace)
        proxy = "socks5://synthetic:credential@proxy.example.invalid:1080"
        client = namespace["OpenAIHTTPClient"](proxy_url=proxy)
        constructor.assert_not_called()
        self.assertIs(client.session, session)
        self.assertEqual(constructor.call_args.kwargs["proxies"], {"http": proxy, "https": proxy})
        client.close()
        session.close.assert_called_once()

    def test_failed_independent_identity_keeps_creation_observation_but_never_credential_or_success(self):
        self.ready()
        client, modules = self.result_modules()
        with patch.dict(sys.modules, modules), patch.object(browser, "verify_identity", side_effect=RuntimeError("synthetic network error")):
            with self.assertRaises(HTTPException):
                self.adapter.result(TASK, result_input())
        data = json.loads(self.store.row.value)
        self.assertEqual(data["browserRegistration"]["creationEvidence"], result_input().creationEvidence.model_dump())
        self.assertEqual(data["browserRegistration"]["failureReason"], "identity_missing")
        self.assertEqual(data["identityStatus"], "awaiting_identity")
        self.assertEqual(self.store.record["registrationStatus"], "unknown")
        self.assertEqual(self.store.record["activeTaskUuid"], TASK)
        self.assertEqual(self.store.saved, [])
        self.assertNotIn("rawResult", data)
        self.assertNotIn("sessionToken", data)
        self.assertEqual(data["passwordCheckpoint"], "synthetic-checkpoint-only")
        client.close.assert_called_once()

    def test_failed_post_identity_commit_does_not_latch_cancellation_guard(self):
        self.ready()
        _, modules = self.result_modules()
        def verify(*args):
            self.store.reject_commit = True
            return {"identityStatus": "verified", "identityEvidence": {"officialUserIdHash": hashlib.sha256(b"user_synthetic").hexdigest()}}
        with patch.dict(sys.modules, modules), patch.object(browser, "verify_identity", side_effect=verify):
            with self.assertRaises(RuntimeError):
                self.adapter.result(TASK, result_input())
        self.assertFalse(self.integration.contexts[TASK].get("browserCommitting", False))
        self.store.reject_commit = False
        self.assertTrue(self.adapter.finish(TASK, cancelled=True)["accepted"])
        self.assertEqual(self.store.record["activeTaskUuid"], TASK)

    def test_official_password_400_records_safe_failure_and_keeps_uncertain_lease(self):
        self.ready()
        request = browser.FailInput(claimId=NONCE, reason="official_rejected", sideEffectPossible=True,
                                    profileId=PROFILE, stage="password", httpStatus=400)
        self.assertTrue(self.adapter.finish(TASK, request)["accepted"])
        data = json.loads(self.store.row.value)
        self.assertEqual(data["firstFailure"]["stage"], "password")
        self.assertEqual(data["firstFailure"]["errorKind"], "http_rejected")
        self.assertEqual(data["firstFailure"]["httpStatus"], 400)
        self.assertGreaterEqual(data["firstFailure"]["elapsedMs"], 0)
        self.assertEqual(self.store.record["lastHttpStatus"], 400)
        self.assertEqual(self.store.record["note"], "keep this fact")
        self.assertEqual(self.store.record["activeTaskUuid"], TASK)
        self.assertEqual(self.store.record["registrationStatus"], "unknown")

    def test_official_failure_diagnostic_rejects_invalid_stage_status_pairs_and_reason(self):
        base = {"claimId": NONCE, "reason": "official_rejected", "sideEffectPossible": True, "profileId": PROFILE}
        for extra in ({"stage": "oauth", "httpStatus": 400}, {"stage": "password"}, {"httpStatus": 400},
                {"stage": "signup", "httpStatus": 200}, {"stage": "signup", "httpStatus": 600},
                {"stage": "signup", "httpStatus": 400.0}, {"stage": "signup", "httpStatus": True},
                {"stage": "signup", "httpStatus": 400, "reason": "connector_error"}):
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                browser.FailInput.model_validate({**base, **extra})
        browser.FailInput.model_validate(base)
        for stage in ("signup", "password", "verification_validate", "create_account"):
            browser.FailInput.model_validate({**base, "stage": stage, "httpStatus": 599})

    def test_rejection_never_replaces_original_failure_or_manual_note(self):
        self.ready()
        original = {"stage": "signup", "errorKind": "network_error", "httpStatus": None,
                    "elapsedMs": 7, "observedAt": "2026-10-16T01:00:00Z"}
        data = json.loads(self.store.row.value)
        data["firstFailure"] = deepcopy(original)
        self.store.row.value = json.dumps(data)
        self.store.record["firstFailure"] = deepcopy(original)
        self.adapter.finish(TASK, browser.FailInput(claimId=NONCE, reason="official_rejected", sideEffectPossible=True,
            profileId=PROFILE, stage="create_account", httpStatus=500))
        self.assertEqual(json.loads(self.store.row.value)["firstFailure"], original)
        self.assertEqual(self.store.record["firstFailure"], original)
        self.assertEqual(self.store.record["lastHttpStatus"], 500)
        self.assertEqual(self.store.record["note"], "keep this fact")


if __name__ == "__main__":
    unittest.main()
