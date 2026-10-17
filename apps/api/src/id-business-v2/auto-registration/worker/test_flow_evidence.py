"""Pure memory tests of real worker guards and frozen algorithm functions.

AST loading avoids upstream app/database initialization. Every test disables
SQLite and network connections; fake transports never submit an external POST.
"""
import ast
from contextlib import contextmanager
import copy
from dataclasses import dataclass
from datetime import datetime
import hashlib
import importlib
import json
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
from typing import Any, Dict, Optional, Tuple
import unittest
from unittest.mock import Mock, patch
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import flow_evidence as flow
import apple_registration_diagnostics as diagnostics
import release_safety as safety

TASK = "82b25c6d-404f-47e9-a624-e106bd1a22cb"
AUTHORIZE = "https://auth.openai.com/oauth/authorize?state=fixture-state"
ENDPOINTS = {"signup": "https://auth.openai.com/api/accounts/authorize/continue",
             "register": "https://auth.openai.com/api/accounts/user/register",
             "create_account": "https://auth.openai.com/api/accounts/create_account",
             "sentinel": "https://sentinel.openai.com/backend-api/sentinel/req"}


def definitions(path, classes, namespace):
    tree = ast.parse(path.read_text())
    selected = []
    for item in tree.body:
        if isinstance(item, ast.ClassDef) and item.name in classes:
            names = classes[item.name]
            if names is None:
                selected.append(item)
            else:
                selected.append(ast.ClassDef(name=item.name, bases=[], keywords=[],
                    body=[method for method in item.body if isinstance(method, ast.FunctionDef) and method.name in names],
                    decorator_list=[]))
    exec(compile(ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[])), str(path), "exec"), namespace)


class FakeResponse:
    def __init__(self, status=200, body=None, *, url="https://auth.openai.com/create-account",
                 invalid=False, headers=None, history=None):
        self.status_code, self.url = status, url
        self.body = {"page": {"type": "password"}} if body is None else body
        self.invalid = invalid
        self.headers = {"content-type": "application/json", **(headers or {})}
        self.history = history or []
        self.text = "fixture response content must never enter evidence"
        self.json_calls = 0

    def json(self):
        self.json_calls += 1
        if self.invalid:
            raise ValueError("fixture-secret-response-text")
        return self.body


def now_iso():
    return "2026-10-16T05:00:00Z"


NAMESPACE = {"__name__": __name__, "Any": Any, "Dict": Dict, "Optional": Optional, "Tuple": Tuple,
    "dataclass": dataclass, "datetime": datetime, "json": json,
    "time": SimpleNamespace(sleep=lambda _: None, time=time.time),
    "uuid": uuid, "importlib": SimpleNamespace(import_module=lambda _: SimpleNamespace(OPENAI_API_ENDPOINTS=ENDPOINTS)),
    "observation": flow.observation, "observation_v1": flow.observation_v1,
    "observation_for_version": flow.observation_for_version,
    "validate_flow_evidence": flow.validate_flow_evidence,
    "validate_observation": flow.validate_observation, "RegistrationDiagnostics": diagnostics.RegistrationDiagnostics,
    "STAGES": diagnostics.STAGES, "ERROR_KINDS": diagnostics.ERROR_KINDS, "now_iso": now_iso,
    "TASK_PREFIX": "id.apple-task.",
    "PUBLIC_FIELDS": {"firstFailure", "stage", "lastHttpStatus"},
    "TASK_STATUSES": {"pending", "running", "completed", "failed", "cancelled"},
    "context_authorization_only": lambda integration, task: bool(integration.contexts.get(task, {}).get("authorizationOnly")),
    "OPENAI_API_ENDPOINTS": ENDPOINTS,
    "OPENAI_PAGE_TYPES": {"EMAIL_OTP_VERIFICATION": "email_otp_verification", "PASSWORD_REGISTRATION": "password"}}
definitions(HERE / "apple_mailboxes.py", {"RegistrationFacts": {"record_flow_evidence", "record_failure"},
    "AppleMailboxIntegration": {"guard_session", "observe_engine", "task"}}, NAMESPACE)
definitions(HERE.parent / "upstream/src/core/register.py", {"SignupFormResult": None, "RegistrationResult": None,
    "RegistrationEngine": {"run", "_get_device_id", "_check_sentinel", "_submit_signup_form", "_register_password"}}, NAMESPACE)


class MemoryStore(NAMESPACE["RegistrationFacts"]):
    def __init__(self):
        self.row = SimpleNamespace(value=json.dumps({"email": "fixture@example.invalid", "aliasId": "fixture-alias",
            "resultKind": None, "passwordCheckpoint": "fixture-only-password", "syncStatus": "not_started"}))
        self.record = {"activeTaskUuid": TASK, "firstFailure": None}
        self.writes = 0

    @contextmanager
    def transaction(self):
        yield None

    def task_data(self, _db, _task):
        return self.row, json.loads(self.row.value)

    def current(self, _db, _task, _data):
        return self.record if self.record.get("activeTaskUuid") == TASK else None

    def write(self, _db, record):
        self.writes += 1
        self.record = record

    def update_task(self, task, **updates):
        row, data = self.task_data(None, task)
        data.update(updates)
        row.value = json.dumps(data)
        return self.current(None, task, data) is not None

    @property
    def data(self):
        return json.loads(self.row.value)

    def password_checkpoint(self, _task, _generate):
        return self.data["passwordCheckpoint"]


class FlowEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.stack = __import__("contextlib").ExitStack()
        self.stack.enter_context(patch.object(sqlite3, "connect", side_effect=AssertionError("database disabled")))
        self.stack.enter_context(patch.object(socket.socket, "connect", side_effect=AssertionError("network disabled")))
        self.addCleanup(self.stack.close)

    def engine(self, signup=None, *, authorize=None, password=None):
        integration = NAMESPACE["AppleMailboxIntegration"]()
        store = integration.store = MemoryStore()
        integration.contexts = {TASK: {"taskUuid": TASK, "email": "fixture@example.invalid"}}
        integration.lock = threading.RLock()
        integration.sessions = SimpleNamespace(get_db=store.transaction)
        session = SimpleNamespace(cookies={"oai-did": "old-fixture-cookie"}, get=Mock(return_value=authorize or FakeResponse()))
        session._offline_get_transport = session.get
        calls = []
        def post(url, *args, **kwargs):
            calls.append((url, args, kwargs))
            if url == ENDPOINTS["sentinel"]:
                return FakeResponse(body={"token": "fixture-only-sentinel-token",
                                          "proofofwork": {"required": False}, "turnstile": {"required": False}},
                                    url=ENDPOINTS["sentinel"])
            if url == ENDPOINTS["signup"]:
                return signup or FakeResponse()
            if url == ENDPOINTS["register"]:
                return password or FakeResponse(400, {"error": {"code": "account_creation_failed"}})
            raise AssertionError("unexpected request")
        session.post = Mock(side_effect=post)
        # Frozen HTTPClient.post uses Session.request directly; it does not
        # dispatch through the Session.post method guarded for signup/password.
        session.request = Mock(side_effect=lambda method, url, *args, **kwargs: post(url, *args, **kwargs))
        engine = NAMESPACE["RegistrationEngine"]()
        engine.email, engine.email_info = "fixture@example.invalid", {}
        engine.logs, engine._is_existing_account = [], False
        engine.session = None
        engine.oauth_start = SimpleNamespace(auth_url=AUTHORIZE)
        engine.http_client = SimpleNamespace(get=Mock(return_value=FakeResponse()),
                                              post=lambda url, *args, **kwargs: session.request("POST", url, *args, **kwargs),
                                              session=session, close=Mock())
        engine._log = lambda *_args: None
        engine._check_ip_location = lambda: (True, "PH")
        engine._create_email = lambda: True
        def initialize():
            engine.session = engine.http_client.session
            return True
        engine._init_session = initialize
        engine._start_oauth = lambda: True
        engine._send_verification_code = Mock(return_value=False)
        engine._create_user_account = Mock(return_value=False)
        engine._mark_email_as_registered = Mock()
        engine._get_verification_code = Mock(return_value=None)
        engine._generate_password = Mock(return_value="fixture-only-password")
        engine._offline_generate = engine._generate_password
        provider = SimpleNamespace(context=integration.contexts[TASK])
        integration.observe_engine(engine, provider)
        return integration, engine, session, calls

    def test_authorize_old_cookie_never_allows_403_or_500_to_reach_signup(self):
        for status in (403, 500):
            with self.subTest(status=status):
                integration, engine, session, calls = self.engine(authorize=FakeResponse(status))
                self.assertFalse(engine.run().success)
                self.assertEqual(calls, [])
                self.assertEqual(session._offline_get_transport.call_count, 3)  # Frozen GET retry bound, no new POST retry.
                evidence = integration.store.data["flowEvidence"]["authorize"]
                self.assertEqual((evidence["decision"], evidence["reason"]), ("rejected", "http_status"))
                self.assertEqual(integration.store.data["firstFailure"]["httpStatus"], status)
                self.assertEqual(integration.store.data["firstFailure"]["errorKind"], "http_rejected")

    def test_authorize_nonofficial_or_insecure_final_source_is_blocked_with_old_cookie(self):
        for url in ("https://other.invalid/path?state=fixture-private", "http://auth.openai.com/",
                    "https://auth.openai.com.evil.invalid/", "https://user:secret@auth.openai.com/", ""):
            with self.subTest(url=url):
                integration, engine, _session, calls = self.engine(authorize=FakeResponse(url=url))
                self.assertFalse(engine.run().success)
                self.assertEqual(calls, [])
                self.assertEqual(integration.store.data["flowEvidence"]["authorize"]["reason"], "untrusted_origin")

    def test_invalid_unknown_missing_signup_200_never_submits_password(self):
        cases = [FakeResponse(invalid=True, headers={"content-type": "text/html"}),
                 FakeResponse(body={}), FakeResponse(body={"page": {"type": "unexpected"}}),
                 FakeResponse(body=[]), FakeResponse(body={"page": {"type": "password"}, "error": {"code": "fixture"}})]
        for response in cases:
            with self.subTest(body=response.body, invalid=response.invalid):
                integration, engine, _session, calls = self.engine(signup=response)
                self.assertFalse(engine.run().success)
                self.assertEqual([url for url, *_ in calls], [ENDPOINTS["sentinel"], ENDPOINTS["signup"]])
                evidence = integration.store.data["flowEvidence"]["signup"]
                self.assertEqual(evidence["decision"], "rejected")
                self.assertEqual(integration.store.data["firstFailure"]["stage"], "signup")
                self.assertNotIn("sideEffectPossible", integration.store.data)
                engine._offline_generate.assert_not_called()

    def test_signup_known_page_from_untrusted_origin_cannot_select_either_branch(self):
        for page in ("password", "email_otp_verification"):
            integration, engine, _session, calls = self.engine(signup=FakeResponse(
                body={"page": {"type": page}}, url="https://other.invalid/"))
            self.assertFalse(engine.run().success)
            self.assertEqual(len(calls), 2)
            self.assertNotIn("existingAccountIndication", integration.store.data)

    def test_valid_new_account_submits_original_password_body_once(self):
        integration, engine, session, calls = self.engine()
        self.assertFalse(engine.run().success)  # Synthetic official rejection, not an external account.
        self.assertEqual([url for url, *_ in calls], [ENDPOINTS["sentinel"], ENDPOINTS["signup"], ENDPOINTS["register"]])
        sent = json.loads(calls[2][2]["data"])
        self.assertEqual(sent, {"password": "fixture-only-password", "username": "fixture@example.invalid"})
        self.assertEqual(calls[2][2]["headers"], {"referer": "https://auth.openai.com/create-account/password",
            "accept": "application/json", "content-type": "application/json"})
        flow_value = integration.store.data["flowEvidence"]
        self.assertEqual(set(flow_value), {"version", "authorize", "sentinel", "signup", "password"})
        self.assertEqual(flow_value["signup"]["pageKind"], "new_account")
        self.assertEqual(flow_value["password"]["decision"], "rejected")
        self.assertEqual(integration.store.data["firstFailure"]["errorKind"], "account_creation_failed")
        self.assertIs(engine.session, session)

    def test_known_new_page_with_nullable_errors_remains_valid(self):
        for extra in ({"error": None}, {"errors": None}, {"errors": []}, {"error": ""}):
            with self.subTest(extra=extra):
                response = FakeResponse(body={"page": {"type": "password"}, **extra})
                integration, engine, _session, calls = self.engine(signup=response)
                self.assertFalse(engine.run().success)
                self.assertEqual([url for url, *_ in calls], [ENDPOINTS["sentinel"], ENDPOINTS["signup"], ENDPOINTS["register"]])
                self.assertEqual(integration.store.data["flowEvidence"]["signup"]["decision"], "accepted")

    def test_truthy_upstream_errors_keep_known_page_but_block_password(self):
        cases = [({"error": {"code": "account_creation_failed"}}, "error", "account_creation_failed"),
                 ({"error": {"code": "user_exists"}}, "error", "user_exists"),
                 ({"errors": [{"code": "private-value"}]}, "errors", "other"),
                 ({"error": "private-value", "errors": True}, "both", "other")]
        for page in ("password", "email_otp_verification"):
            for extra, signal, error_kind in cases:
                with self.subTest(page=page, signal=signal, error_kind=error_kind):
                    integration, engine, _session, calls = self.engine(signup=FakeResponse(body={"page": {"type": page}, **extra}))
                    self.assertFalse(engine.run().success)
                    self.assertEqual([url for url, *_ in calls], [ENDPOINTS["sentinel"], ENDPOINTS["signup"]])
                    evidence = integration.store.data["flowEvidence"]["signup"]
                    self.assertEqual(integration.store.data["flowEvidence"]["version"], 3)
                    self.assertEqual(evidence["pageKind"], "new_account" if page == "password" else "existing_account")
                    self.assertEqual((evidence["decision"], evidence["reason"]), ("rejected", "upstream_error"))
                    self.assertEqual(evidence["responseDetails"]["errorSignal"], signal)
                    self.assertEqual(evidence["responseDetails"]["errorKind"], error_kind)
                    self.assertEqual(evidence["responseDetails"]["pageShape"], "type_known")
                    self.assertEqual(integration.store.data["firstFailure"]["errorKind"],
                                     error_kind if error_kind != "other" else "unknown")
                    self.assertNotIn("existingAccountIndication", integration.store.data)
                    self.assertNotIn("private-value", json.dumps(evidence))
                    engine._offline_generate.assert_not_called()

    def test_response_details_distinguish_missing_page_and_every_type_shape(self):
        cases = [({}, "missing", "missing"), ({"page": None}, "non_object", "missing"),
                 ({"page": []}, "non_object", "missing"), ({"page": "private-value"}, "non_object", "missing"),
                 ({"page": {}}, "type_missing", "missing"), ({"page": {"type": None}}, "type_non_string", "missing"),
                 ({"page": {"type": True}}, "type_non_string", "unknown"),
                 ({"page": {"type": {"private-value": "private-value"}}}, "type_non_string", "unknown"),
                 ({"page": {"type": ""}}, "type_unknown", "missing"),
                 ({"page": {"type": "private-value"}}, "type_unknown", "unknown"),
                 ({"page": {"type": "password"}}, "type_known", "new_account"),
                 ({"page": {"type": "email_otp_verification"}}, "type_known", "existing_account")]
        for body, shape, kind in cases:
            with self.subTest(shape=shape, kind=kind):
                value = flow.observation(FakeResponse(body=body), "signup")
                self.assertEqual(value["responseDetails"]["pageShape"], shape)
                self.assertEqual(value["pageKind"], kind)
                self.assertEqual(value["responseDetails"]["errorSignal"], "none")
                self.assertNotIn("private-value", json.dumps(value))

    def test_error_shape_classifier_and_original_truthiness_are_preserved(self):
        cases = [({}, "missing", False), ({"error": None}, "null", False),
                 ({"error": {}}, "object", False), ({"error": {"code": "private-value"}}, "object", True),
                 ({"error": ""}, "string", False), ({"error": "private-value"}, "string", True),
                 ({"error": []}, "list", False), ({"error": ["private-value"]}, "list", True),
                 ({"error": False}, "boolean", False), ({"error": True}, "boolean", True),
                 ({"error": 0}, "number", False), ({"error": 1.5}, "number", True)]
        for extra, shape, truthy in cases:
            for key in ("error", "errors"):
                renamed = {key: extra["error"]} if "error" in extra else {}
                with self.subTest(key=key, shape=shape, truthy=truthy):
                    value = flow.observation(FakeResponse(body={"page": {"type": "password"}, **renamed}), "signup")
                    details = value["responseDetails"]
                    self.assertEqual(details[key + "Shape"], shape)
                    self.assertEqual(details["errorSignal"], key if truthy else "none")
                    self.assertEqual(details["errorKind"], "other" if truthy else "none")
                    self.assertEqual(value["reason"], "upstream_error" if truthy else None)
                    self.assertNotIn("private-value", json.dumps(value))

    def test_invalid_or_nonobject_json_and_authorize_never_get_response_details(self):
        for response in (FakeResponse(invalid=True), FakeResponse(body=[]), FakeResponse(body="private-value")):
            value = flow.observation(response, "signup")
            self.assertNotIn("responseDetails", value)
            self.assertEqual(value["reason"], "invalid_json")
        response = FakeResponse(body={"error": {"code": "account_creation_failed"}})
        value = flow.observation(response, "authorize")
        self.assertNotIn("responseDetails", value)
        self.assertEqual(response.json_calls, 0)
        value = flow.observation(response, "password")
        self.assertEqual(response.json_calls, 1)
        self.assertEqual(value["reason"], "upstream_error")

    def test_error_reason_preserves_http_and_origin_gate_priority(self):
        body = {"page": {"type": "password"}, "error": {"code": "account_creation_failed"}}
        for status, url, reason in ((400, "https://auth.openai.com/", "http_status"),
                                    (200, "https://other.invalid/", "untrusted_origin")):
            value = flow.observation(FakeResponse(status, body, url=url), "signup")
            self.assertEqual(value["reason"], reason)
            self.assertEqual(value["responseDetails"]["errorKind"], "account_creation_failed")
            self.assertEqual(value["pageKind"], "new_account")

    def test_v1_projection_keeps_original_error_decision_and_closed_fields(self):
        value = flow.observation(FakeResponse(body={"page": {"type": "password"}, "error": "private-value"}), "signup")
        old = flow.observation_v1("signup", value)
        self.assertEqual(set(old), flow.FIELDS)
        self.assertEqual((old["pageKind"], old["decision"], old["reason"]), ("unknown", "rejected", "unexpected_page"))
        flow.validate_flow_evidence({"version": 1, "signup": old})
        self.assertEqual(value["pageKind"], "new_account")
        self.assertEqual(value["reason"], "upstream_error")

    def test_v1_active_continuation_never_upgrades_or_rewrites_existing_evidence(self):
        store = MemoryStore()
        original_failure = {"stage": "password", "errorKind": "account_creation_failed", "httpStatus": 400,
                            "elapsedMs": 7, "observedAt": now_iso()}
        old_signup = flow.observation_v1("signup", flow.observation(FakeResponse(), "signup"))
        store.update_task(TASK, flowEvidence={"version": 1, "signup": old_signup}, firstFailure=original_failure)
        changed_signup = flow.observation(FakeResponse(body={"error": "private-value"}), "signup")
        self.assertTrue(store.record_flow_evidence(TASK, "signup", changed_signup))
        self.assertEqual(store.data["flowEvidence"], {"version": 1, "signup": old_signup})
        self.assertTrue(store.record_flow_evidence(TASK, "password", flow.observation(FakeResponse(400), "password")))
        self.assertEqual(store.data["flowEvidence"]["version"], 1)
        self.assertEqual(store.data["flowEvidence"]["signup"], old_signup)
        self.assertEqual(set(store.data["flowEvidence"]["password"]), flow.FIELDS)
        self.assertEqual(store.data["firstFailure"], original_failure)
        self.assertEqual(store.writes, 0)

    def test_v2_closed_details_reject_raw_values_wrong_stage_and_inconsistent_decisions(self):
        value = flow.observation_for_version("signup", flow.observation(FakeResponse(), "signup"), 2)
        cases = [lambda x: x["responseDetails"].update(rawType="private-value"),
                 lambda x: x["responseDetails"].update(errorSignal="private-value"),
                 lambda x: x["responseDetails"].update(errorShape="private-value"),
                 lambda x: x["responseDetails"].update(errorsShape=[]),
                 lambda x: x["responseDetails"].update(errorKind="private-value"),
                 lambda x: x["responseDetails"].update(pageShape="private-value"),
                 lambda x: x["responseDetails"].update(errorSignal="error"),
                 lambda x: x["responseDetails"].update(pageShape="type_missing"),
                 lambda x: x.update(reason="upstream_error"),
                 lambda x: x.update(jsonKind="invalid")]
        for mutate in cases:
            bad = copy.deepcopy(value)
            mutate(bad)
            with self.subTest(value=bad), self.assertRaises(ValueError):
                flow.validate_flow_evidence({"version": 2, "signup": bad})
        for version in (1, True, 3):
            with self.subTest(version=version), self.assertRaises(ValueError):
                flow.validate_flow_evidence({"version": version, "signup": value})
        for stage in ("authorize", "password"):
            with self.subTest(stage=stage), self.assertRaises(ValueError):
                flow.validate_flow_evidence({"version": 2, stage: value})

    def test_v2_object_requires_details_but_legacy_v1_never_does(self):
        value = flow.observation_for_version("signup", flow.observation(FakeResponse(), "signup"), 2)
        value.pop("responseDetails")
        with self.assertRaises(ValueError):
            flow.validate_flow_evidence({"version": 2, "signup": value})
        flow.validate_flow_evidence({"version": 1, "signup": value})

    def test_valid_existing_account_skips_password_without_claiming_identity(self):
        integration, engine, _session, calls = self.engine(signup=FakeResponse(body={"page": {"type": "email_otp_verification"}}))
        self.assertFalse(engine.run().success)
        self.assertEqual([url for url, *_ in calls], [ENDPOINTS["sentinel"], ENDPOINTS["signup"]])
        self.assertEqual(integration.store.data["flowEvidence"]["signup"]["pageKind"], "existing_account")
        self.assertTrue(integration.store.data["existingAccountIndication"])
        self.assertNotIn("creationConfirmed", integration.store.data)
        engine._offline_generate.assert_not_called()

    def test_authorization_only_still_refuses_new_account_branch(self):
        integration, engine, _session, calls = self.engine()
        integration.contexts[TASK]["authorizationOnly"] = True
        self.assertFalse(engine.run().success)
        self.assertEqual([url for url, *_ in calls], [ENDPOINTS["sentinel"], ENDPOINTS["signup"]])
        engine._offline_generate.assert_not_called()

    def test_only_exact_authorize_url_is_gated_and_recorded(self):
        integration, engine, session, _calls = self.engine()
        engine._init_session()
        response = session.get("https://cloudflare.com/cdn-cgi/trace")
        self.assertIsNotNone(response)
        self.assertNotIn("flowEvidence", integration.store.data)

    def test_authorize_stays_unparsed_and_password_is_parsed_for_error_gate(self):
        for stage in ("authorize", "password"):
            response = FakeResponse()
            flow.observation(response, stage)
            self.assertEqual(response.json_calls, 0 if stage == "authorize" else 1)

    def test_sensitive_values_and_query_never_leave_closed_evidence(self):
        marker = "fixture-private-value"
        response = FakeResponse(body={"page": {"type": marker}, "password": marker, "access_token": marker},
            url="https://auth.openai.com/path?state=" + marker,
            headers={"x-request-id": marker, "cookie": marker, "content-type": "text/plain; " + marker},
            history=[SimpleNamespace(url="https://other.invalid/path?code=" + marker)] * 8)
        value = flow.observation(response, "signup")
        rendered = json.dumps(value)
        self.assertNotIn(marker, rendered)
        self.assertNotIn("other.invalid", rendered)
        self.assertEqual(value["redirectHosts"], ["other"] * 5)
        self.assertTrue(value["redirectsTruncated"])
        self.assertEqual(value["requestIdSha256"], hashlib.sha256(marker.encode()).hexdigest())

    def test_task_binding_slots_are_bounded_and_never_enter_record_or_sync(self):
        store = MemoryStore()
        original = {"stage": "password", "errorKind": "account_creation_failed", "httpStatus": 400,
                    "elapsedMs": 7, "observedAt": now_iso()}
        store.update_task(TASK, firstFailure=original, syncPayload={"fingerprint": "fixture-only"})
        for stage in ("authorize", "signup", "password", "signup"):
            self.assertTrue(store.record_flow_evidence(TASK, stage, flow.observation(FakeResponse(), stage)))
        self.assertEqual(store.data["firstFailure"], original)
        self.assertEqual(store.data["syncPayload"], {"fingerprint": "fixture-only"})
        self.assertEqual(store.data["syncStatus"], "not_started")
        self.assertEqual(set(store.data["flowEvidence"]), {"version", "authorize", "signup", "password"})
        self.assertNotIn("flowEvidence", store.record)
        self.assertEqual(store.writes, 0)
        store.record_failure(TASK, "signup", "unknown", 200, 99)
        self.assertEqual(store.data["firstFailure"], original)

    def test_changed_lease_cannot_publish_late_flow_evidence(self):
        store = MemoryStore()
        store.record["activeTaskUuid"] = "other-fixture-task"
        self.assertFalse(store.record_flow_evidence(TASK, "signup", flow.observation(FakeResponse(), "signup")))
        self.assertNotIn("flowEvidence", store.data)

    def test_old_task_and_new_closed_structure_validate_without_database(self):
        legacy = {"email": "fixture@example.invalid", "aliasId": "fixture-alias", "resultKind": None}
        safety.validate_task(TASK, legacy)
        for version in (1, 2, 3):
            evidence = flow.observation_for_version("signup", flow.observation(FakeResponse(), "signup"), version)
            value = {**legacy, "flowEvidence": {"version": version, "signup": evidence}}
            safety.validate_task(TASK, value)
        self.assertNotIn("flowEvidence", safety.PUBLIC_FACT_FIELDS)
        self.assertNotIn("flowEvidence", safety.OPTIONAL_RECORD_FIELDS)

    def test_task_get_adds_only_optional_validated_top_level_evidence(self):
        for has_flow in (False, True):
            integration = NAMESPACE["AppleMailboxIntegration"]()
            store = integration.store = MemoryStore()
            if has_flow:
                store.record_flow_evidence(TASK, "signup", flow.observation(FakeResponse(), "signup"))
            db = Mock()
            db.query.return_value.filter_by.return_value.first.return_value = SimpleNamespace(status="failed", logs=None)
            db.get.return_value = store.row
            @contextmanager
            def read():
                yield db
            integration.sessions = SimpleNamespace(get_db=read)
            integration.models = SimpleNamespace(RegistrationTask=object(), Setting=object())
            store.read = Mock(return_value={"activeTaskUuid": None, "firstFailure": None})
            integration.public_record = lambda value: value
            integration.live, integration.redact = lambda _task: False, lambda value: value
            result = integration.task(TASK)
            self.assertEqual("flowEvidence" in result, has_flow)
            self.assertNotIn("flowEvidence", result["record"])
            if has_flow:
                self.assertEqual(result["flowEvidence"], store.data["flowEvidence"])
                corrupt = store.data
                corrupt["flowEvidence"]["rawPayload"] = "fixture-secret"
                store.row.value = json.dumps(corrupt)
                with self.assertRaises(ValueError):
                    integration.task(TASK)

    def test_release_module_absolute_import_needs_no_worker_path_or_database(self):
        source = """import importlib.util,json,sqlite3,socket,sys
from unittest.mock import patch
before=list(sys.path)
with patch.object(sqlite3,'connect',side_effect=AssertionError('database disabled')), patch.object(socket.socket,'connect',side_effect=AssertionError('network disabled')):
 spec=importlib.util.spec_from_file_location('standalone_safety',__PATH__)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 module.validate_task(__TASK__,{'email':'fixture@example.invalid','aliasId':'fixture','resultKind':None})
 assert callable(module.logical_summary) and sys.path==before
print('standalone stdlib load PASS')
""".replace("__PATH__", repr(str(HERE / "release_safety.py"))).replace("__TASK__", repr(TASK))
        result = subprocess.run([sys.executable, "-B", "-c", source], capture_output=True, text=True,
                                cwd=HERE.parents[5], check=True)
        self.assertEqual(result.stdout.strip(), "standalone stdlib load PASS")
        self.assertEqual(result.stderr, "")

    def test_unknown_or_secret_fields_invalid_enums_and_oversize_arrays_are_rejected(self):
        good = {"version": 3, "signup": flow.observation(FakeResponse(), "signup")}
        mutations = [lambda x: x.update(version=True), lambda x: x.update(cookie="fixture-secret"),
            lambda x: x["signup"].update(payload="fixture-secret"), lambda x: x["signup"].update(pageKind="raw page"),
            lambda x: x["signup"].update(pageKind=[]), lambda x: x["signup"].update(httpStatus=True),
            lambda x: x["signup"].update(officialOrigin=1), lambda x: x["signup"].update(contentType={}),
            lambda x: x["signup"].update(redirectHosts=["auth_openai"] * 6),
            lambda x: x["signup"].update(requestIdSha256="raw-secret"),
            lambda x: x["signup"].update(decision="observed"), lambda x: x["signup"].update(reason=[])]
        for mutation in mutations:
            bad = copy.deepcopy(good)
            mutation(bad)
            with self.subTest(value=bad), self.assertRaises(safety.SafetyError):
                safety.validate_task(TASK, {"email": "fixture@example.invalid", "aliasId": "fixture-alias",
                                           "resultKind": None, "flowEvidence": bad})


if __name__ == "__main__":
    unittest.main()
