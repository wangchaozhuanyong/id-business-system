"""Offline differential tests of frozen methods and the real worker adapter.

Both sides execute AST-extracted methods from the same frozen upstream source;
the integrated side additionally executes the real observe_engine/guard_session
and diagnostics. Only transport, mailbox, clock and in-memory storage are fakes.
No application initializer, SQLite connection or network socket is permitted.
These tests prove request/branch parity for synthetic responses, not that the
current official signup service accepts those responses or creates an account.
"""
import ast
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from datetime import datetime
import copy
import json
from pathlib import Path
import socket
import sqlite3
import sys
import threading
from types import SimpleNamespace
from typing import Any, Callable, Dict, Optional, Tuple
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import apple_registration_diagnostics as diagnostics
import flow_evidence

TASK = "82b25c6d-404f-47e9-a624-e106bd1a22cb"
EMAIL = "differential@example.invalid"
AUTHORIZE = "https://auth.openai.com/oauth/authorize?state=fixture%2Bstate&scope=openid+email&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"
STAMP = "2026-10-16T05:00:00Z"


def source_definitions(path, classes, functions, namespace):
    """Compile original AST nodes; never copy an algorithm into a fixture."""
    selected = []
    for item in ast.parse(path.read_text()).body:
        if isinstance(item, ast.FunctionDef) and item.name in functions:
            selected.append(item)
        elif isinstance(item, ast.ClassDef) and item.name in classes:
            names = classes[item.name]
            if names is None:
                selected.append(item)
            else:
                selected.append(ast.ClassDef(name=item.name, bases=[], keywords=[],
                    body=[method for method in item.body if isinstance(method, ast.FunctionDef) and method.name in names],
                    decorator_list=[]))
    module = ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[]))
    exec(compile(module, str(path), "exec"), namespace)


def literal_constants(*names):
    wanted = set(names)
    result = {}
    for item in ast.parse((HERE.parent / "upstream/src/config/constants.py").read_text()).body:
        if isinstance(item, ast.Assign):
            for target in item.targets:
                if isinstance(target, ast.Name) and target.id in wanted:
                    result[target.id] = ast.literal_eval(item.value)
    if set(result) != wanted:
        raise AssertionError("frozen constant missing")
    return result


CONSTANTS = literal_constants("OPENAI_API_ENDPOINTS", "OPENAI_PAGE_TYPES", "PASSWORD_CHARSET", "DEFAULT_PASSWORD_LENGTH", "OTP_CODE_PATTERN")
ENDPOINTS = CONSTANTS["OPENAI_API_ENDPOINTS"]
NAMESPACE = {"__name__": __name__, "Any": Any, "Callable": Callable, "Dict": Dict, "Optional": Optional,
    "Tuple": Tuple, "Response": Any, "dataclass": dataclass, "datetime": datetime, "json": json, "urlsplit": urlsplit,
    "time": SimpleNamespace(sleep=lambda _seconds: None, time=lambda: 1770000000.0),
    "importlib": SimpleNamespace(import_module=lambda _name: SimpleNamespace(OPENAI_API_ENDPOINTS=ENDPOINTS)),
    "observation": flow_evidence.observation, "observation_for_version": flow_evidence.observation_for_version,
    "validate_flow_evidence": flow_evidence.validate_flow_evidence,
    "validate_observation": flow_evidence.validate_observation, "RegistrationDiagnostics": diagnostics.RegistrationDiagnostics,
    "STAGES": diagnostics.STAGES, "ERROR_KINDS": diagnostics.ERROR_KINDS,
    "now": lambda: STAMP, "now_iso": lambda: STAMP, "PUBLIC_FIELDS": {"stage", "firstFailure", "lastHttpStatus"},
    "generate_random_user_info": lambda: {"name": "Differential Fixture", "birthdate": "1990-01-01"},
    "logger": SimpleNamespace(warning=Mock()), "HTTPClientError": RuntimeError,
    "cffi_requests": SimpleNamespace(RequestsError=type("FixtureRequestsError", (Exception,), {})),
    **CONSTANTS}
source_definitions(HERE / "apple_closed_loop.py", {"ClosedLoopFacts": {"update_task", "password_checkpoint"}}, set(), NAMESPACE)
source_definitions(HERE / "apple_mailboxes.py", {"RegistrationFacts": {"record_failure", "record_flow_evidence"},
    "AppleMailboxIntegration": {"observe_engine", "guard_session"}},
    {"context_authorization_only", "confirms_account_creation"}, NAMESPACE)
source_definitions(HERE.parent / "upstream/src/core/register.py", {"SignupFormResult": None, "RegistrationResult": None,
    "RegistrationEngine": {"run", "_init_session", "_get_device_id", "_check_sentinel", "_submit_signup_form",
        "_generate_password", "_register_password", "_send_verification_code", "_get_verification_code",
        "_validate_verification_code", "_create_user_account"}}, set(), NAMESPACE)
source_definitions(HERE.parent / "upstream/src/core/http_client.py", {"HTTPClient": {"request", "get", "post"}}, set(), NAMESPACE)


class Response:
    def __init__(self, status=200, body=None, *, url="https://auth.openai.com/create-account", invalid=False):
        self.status_code, self.url, self.invalid = status, url, invalid
        self.body = {"page": {"type": "password"}} if body is None else body
        self.headers = {"content-type": "application/json", "x-request-id": "fixture-private-request-id"}
        self.history = []
        self.text = "fixture response, never a real provider response"
        self.json_calls = 0

    def json(self):
        self.json_calls += 1
        if self.invalid:
            raise ValueError("synthetic invalid json")
        return copy.deepcopy(self.body)


class MemoryFacts(NAMESPACE["RegistrationFacts"], NAMESPACE["ClosedLoopFacts"]):
    def __init__(self, events, *, checkpoint=None, fail_password_commit=False, flow_version=None):
        data = {"email": EMAIL, "syncStatus": "not_started", "firstFailure": None}
        if flow_version is not None:
            data["flowEvidence"] = {"version": flow_version}
        if checkpoint is not None:
            data["passwordCheckpoint"] = checkpoint
        self.row = SimpleNamespace(value=json.dumps(data))
        self.record = {"activeTaskUuid": TASK}
        self.events, self.fail_password_commit = events, fail_password_commit
        self.committed_password = checkpoint

    @property
    def data(self):
        return json.loads(self.row.value)

    @contextmanager
    def transaction(self):
        before = self.row.value
        try:
            yield None
            after = self.data
            if after.get("passwordCheckpoint") != json.loads(before).get("passwordCheckpoint"):
                if self.fail_password_commit:
                    raise ValueError("synthetic durable commit failure")
                self.committed_password = after["passwordCheckpoint"]
                self.events.append(("password_committed", self.committed_password))
        except Exception:
            self.row.value = before
            raise

    def task_data(self, _db, task):
        if task != TASK:
            raise AssertionError("unexpected task")
        return self.row, self.data

    def current(self, _db, _task, _data):
        return self.record if self.record["activeTaskUuid"] == TASK else None

    def write(self, _db, record):
        self.record = record

    def registered(self, _email, _task, *, existing, identity=None):
        self.events.append(("registered", existing))


class Transport:
    def __init__(self, scenario, requests, events, index):
        self.scenario, self.requests, self.events, self.index = scenario, requests, events, index
        self.cookies = {"oai-did": "fixture-device"} if index >= scenario.get("cookie_at", 0) else {}

    def request(self, method, url, *args, **kwargs):
        self.requests.append((method, url, copy.deepcopy(args), copy.deepcopy(kwargs), self.index))
        self.events.append(("request", method, url))
        if url == AUTHORIZE:
            return copy.deepcopy(self.scenario.get("authorize", Response()))
        if url == ENDPOINTS["sentinel"]:
            return copy.deepcopy(self.scenario.get("sentinel", Response(body={"token": "synthetic-sentinel-only"}, url=url)))
        if url == ENDPOINTS["signup"]:
            return copy.deepcopy(self.scenario.get("signup", Response()))
        if url == ENDPOINTS["register"]:
            self.events.append(("password_sent", json.loads(kwargs["data"])["password"]))
            return copy.deepcopy(self.scenario.get("password", Response(body={}, url=url)))
        if url in {ENDPOINTS["send_otp"], ENDPOINTS["validate_otp"], ENDPOINTS["create_account"]}:
            return Response(body={"continue_url": "https://auth.openai.com/fixture-next"}, url=url)
        raise AssertionError("no synthetic transport for request")

    def get(self, url, *args, **kwargs):
        return self.request("GET", url, *args, **kwargs)

    def post(self, url, *args, **kwargs):
        return self.request("POST", url, *args, **kwargs)


class Client(NAMESPACE["HTTPClient"]):
    def __init__(self, scenario, requests, events):
        self.scenario, self.requests, self.events = scenario, requests, events
        self.index, self.sessions = 0, []
        self._session = None
        self.config = SimpleNamespace(timeout=30, follow_redirects=True, max_retries=3, retry_delay=1)
        self.proxies = {"http": "socks5://fixture.invalid:1080", "https": "socks5://fixture.invalid:1080"}

    @property
    def session(self):
        if self._session is None:
            self._session = Transport(self.scenario, self.requests, self.events, self.index)
            self.sessions.append(self._session)
        return self._session

    def close(self):
        self.events.append(("close", self.index))
        self.index += 1
        self._session = None

def execute(integrated, scenario=None, *, checkpoint=None, fail_password_commit=False, flow_version=None):
    scenario = scenario or {}
    requests, events, logs = [], [], []
    client = Client(scenario, requests, events)
    facts = MemoryFacts(events, checkpoint=checkpoint, fail_password_commit=fail_password_commit, flow_version=flow_version)
    engine = NAMESPACE["RegistrationEngine"]()
    engine.email, engine.password, engine.email_info = EMAIL, None, {"service_id": "fixture-mailbox"}
    engine.logs, engine._is_existing_account, engine.session, engine._otp_sent_at = logs, False, None, None
    engine.oauth_start = SimpleNamespace(auth_url=AUTHORIZE)
    engine.http_client, engine.proxy_url = client, "socks5://fixture.invalid:1080"
    engine._log = lambda message, *_args: logs.append(message)
    engine._check_ip_location, engine._create_email, engine._start_oauth = lambda: (True, "PH"), lambda: True, lambda: True
    engine._mark_email_as_registered = Mock()
    engine._get_workspace_id = lambda: None  # Stop before OAuth; no official identity is fabricated.
    engine.email_service = SimpleNamespace(service_type=SimpleNamespace(value="fixture"),
        get_verification_code=lambda **_kwargs: "123456")
    counter = iter(CONSTANTS["PASSWORD_CHARSET"])
    generate_character = Mock(side_effect=lambda _charset: next(counter))
    integration = None
    if integrated:
        integration = NAMESPACE["AppleMailboxIntegration"]()
        integration.store, integration.lock = facts, threading.RLock()
        integration.contexts = {TASK: {"taskUuid": TASK, "email": EMAIL}}
        integration.sessions = SimpleNamespace(get_db=facts.transaction)
        integration.persist_created_account = lambda _task, _engine: events.append(("persist_created",))
        integration.observe_engine(engine, SimpleNamespace(context=integration.contexts[TASK]))
    with patch.dict(NAMESPACE, secrets=SimpleNamespace(choice=generate_character)):
        result = engine.run()
    return SimpleNamespace(result=result, requests=requests, events=events, facts=facts, engine=engine,
        client=client, generated=generate_character, integration=integration)


class RegistrationParityTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        for module, name in ((sqlite3, "connect"), (socket, "socket"), (socket, "create_connection"), (socket, "getaddrinfo")):
            self.stack.enter_context(patch.object(module, name, side_effect=AssertionError("offline parity: IO prohibited")))
        self.addCleanup(self.stack.close)

    def pair(self, scenario=None):
        return execute(False, scenario), execute(True, scenario)

    def test_harness_reads_real_methods_and_blocks_external_io(self):
        self.assertTrue(NAMESPACE["RegistrationEngine"].run.__code__.co_filename.endswith("upstream/src/core/register.py"))
        self.assertTrue(NAMESPACE["AppleMailboxIntegration"].observe_engine.__code__.co_filename.endswith("worker/apple_mailboxes.py"))
        self.assertTrue(MemoryFacts.password_checkpoint.__code__.co_filename.endswith("worker/apple_closed_loop.py"))
        self.assertTrue(Client.post.__code__.co_filename.endswith("upstream/src/core/http_client.py"))
        self.assertTrue(Client.request.__code__.co_filename.endswith("upstream/src/core/http_client.py"))
        for operation in (lambda: socket.socket(), lambda: socket.create_connection(("example.invalid", 443)),
                          lambda: socket.getaddrinfo("example.invalid", 443), lambda: sqlite3.connect(":memory:")):
            with self.assertRaises(AssertionError):
                operation()

    def test_normal_new_account_has_identical_transport_until_original_workspace_stop(self):
        bare, integrated = self.pair()
        self.assertEqual(bare.requests, integrated.requests)
        self.assertEqual([item[1] for item in integrated.requests], [AUTHORIZE, ENDPOINTS["sentinel"],
            ENDPOINTS["signup"], ENDPOINTS["register"], ENDPOINTS["send_otp"], ENDPOINTS["validate_otp"], ENDPOINTS["create_account"]])
        self.assertFalse(bare.result.success)
        self.assertEqual(bare.result.error_message, integrated.result.error_message)
        self.assertFalse(integrated.engine._is_existing_account)
        self.assertIn(("registered", False), integrated.events)
        self.assertIn(("persist_created",), integrated.events)

    def test_normal_existing_account_skips_password_send_and_create_on_both_sides(self):
        bare, integrated = self.pair({"signup": Response(body={"page": {"type": "email_otp_verification"}})})
        self.assertEqual(bare.requests, integrated.requests)
        self.assertEqual([item[1] for item in integrated.requests], [AUTHORIZE, ENDPOINTS["sentinel"], ENDPOINTS["signup"], ENDPOINTS["validate_otp"]])
        self.assertTrue(integrated.engine._is_existing_account)
        self.assertEqual(integrated.generated.call_count, 0)
        self.assertNotIn("passwordCheckpoint", integrated.facts.data)
        self.assertNotIn(("persist_created",), integrated.events)
        self.assertNotIn("creationConfirmed", integrated.facts.data)

    def test_request_query_sentinel_headers_and_body_are_byte_identical(self):
        bare, integrated = self.pair()
        self.assertEqual(bare.requests, integrated.requests)
        self.assertEqual(integrated.requests[0][1], AUTHORIZE)
        signup = next(item for item in integrated.requests if item[1] == ENDPOINTS["signup"])
        self.assertEqual(signup[3]["data"], '{"username":{"value":"differential@example.invalid","kind":"email"},"screen_hint":"signup"}')
        self.assertEqual(signup[3]["headers"], next(item for item in bare.requests if item[1] == ENDPOINTS["signup"])[3]["headers"])
        self.assertIn("openai-sentinel-token", signup[3]["headers"])

    def test_real_generated_password_is_committed_before_same_value_is_sent_once(self):
        bare, integrated = self.pair()
        self.assertEqual(bare.engine.password, integrated.engine.password)
        self.assertEqual(integrated.engine.password, integrated.facts.committed_password)
        self.assertEqual(integrated.generated.call_count, CONSTANTS["DEFAULT_PASSWORD_LENGTH"])
        password = integrated.engine.password
        self.assertLess(integrated.events.index(("password_committed", password)), integrated.events.index(("password_sent", password)))
        self.assertEqual(sum(item[1] == ENDPOINTS["register"] for item in integrated.requests), 1)

    def test_commit_failure_stops_password_post_without_changing_original_signup_request(self):
        bare = execute(False)
        integrated = execute(True, fail_password_commit=True)
        self.assertEqual(integrated.requests, bare.requests[:3])
        self.assertNotIn("passwordCheckpoint", integrated.facts.data)
        self.assertIsNone(integrated.facts.committed_password)
        self.assertFalse(integrated.result.success)

    def test_saved_checkpoint_is_reused_and_generator_not_called(self):
        integrated = execute(True, checkpoint="synthetic-previously-committed")
        self.assertEqual(integrated.generated.call_count, 0)
        sent = next(item for item in integrated.requests if item[1] == ENDPOINTS["register"])
        self.assertEqual(json.loads(sent[3]["data"])["password"], integrated.facts.committed_password)

    def test_cookie_retry_replaces_session_without_request_or_branch_drift(self):
        for cookie_at in (1, 2):
            with self.subTest(cookie_at=cookie_at):
                bare, integrated = self.pair({"cookie_at": cookie_at})
                self.assertEqual(bare.requests, integrated.requests)
                self.assertEqual(sum(item[1] == AUTHORIZE for item in integrated.requests), cookie_at + 1)
                self.assertEqual(len(bare.client.sessions), len(integrated.client.sessions))
                self.assertTrue(all(getattr(session, "_id_apple_post", False) for session in integrated.client.sessions))
                self.assertTrue(all(getattr(session, "_id_apple_get", False) for session in integrated.client.sessions))
                self.assertEqual(integrated.requests[-1][4], cookie_at)

    def test_no_device_cookie_uses_same_three_gets_and_no_post(self):
        bare, integrated = self.pair({"cookie_at": 3})
        self.assertEqual(bare.requests, integrated.requests)
        self.assertEqual([item[1] for item in integrated.requests], [AUTHORIZE] * 3)
        self.assertEqual(integrated.generated.call_count, 0)

    def test_http_signup_rejection_has_identical_requests_and_no_password(self):
        for status in (400, 403, 500):
            with self.subTest(status=status):
                bare, integrated = self.pair({"signup": Response(status, {"error": {"code": "account_creation_failed"}})})
                self.assertEqual(bare.requests, integrated.requests)
                self.assertEqual(len(integrated.requests), 3)
                self.assertEqual(integrated.generated.call_count, 0)

    def test_password_400_has_identical_post_once_and_never_creates_account(self):
        bare, integrated = self.pair({"password": Response(400, {"error": {"code": "account_creation_failed"}})})
        self.assertEqual(bare.requests, integrated.requests)
        self.assertEqual([item[1] for item in integrated.requests][-1], ENDPOINTS["register"])
        self.assertEqual(integrated.facts.data["firstFailure"]["errorKind"], "account_creation_failed")
        self.assertNotIn("creationConfirmed", integrated.facts.data)

    def test_invalid_and_unknown_200_are_intentional_guard_difference_before_password(self):
        cases = [Response(invalid=True), Response(body={}), Response(body=[]),
            Response(body={"page": {"type": "new_upstream_page"}}),
            Response(body={"page": {"type": "password"}, "error": {"code": "synthetic_error"}})]
        for response in cases:
            with self.subTest(body=response.body, invalid=response.invalid):
                bare, integrated = self.pair({"signup": response})
                self.assertEqual(integrated.requests, bare.requests[:3])
                self.assertEqual(integrated.generated.call_count, 0)
                self.assertTrue(any(item[1] == ENDPOINTS["register"] for item in bare.requests))
                self.assertEqual(integrated.facts.data["flowEvidence"]["signup"]["decision"], "rejected")

    def test_initialization_bad_status_with_stale_cookie_is_intentional_guard_difference(self):
        for status in (403, 500):
            with self.subTest(status=status):
                bare, integrated = self.pair({"authorize": Response(status)})
                self.assertTrue(any(item[1] == ENDPOINTS["register"] for item in bare.requests))
                self.assertEqual([item[1] for item in integrated.requests], [AUTHORIZE] * 3)
                self.assertEqual(integrated.facts.data["flowEvidence"]["authorize"]["reason"], "http_status")

    def test_initialization_untrusted_origin_is_intentional_guard_difference(self):
        bare, integrated = self.pair({"authorize": Response(url="https://other.invalid/fixture")})
        self.assertTrue(any(item[1] == ENDPOINTS["register"] for item in bare.requests))
        self.assertEqual([item[1] for item in integrated.requests], [AUTHORIZE] * 3)
        self.assertEqual(integrated.facts.data["flowEvidence"]["authorize"]["reason"], "untrusted_origin")

    def test_required_challenges_stop_before_signup_even_with_a_token(self):
        for name in ("proofofwork", "turnstile"):
            with self.subTest(challenge=name):
                response = Response(body={"token": "synthetic-sentinel-only", name: {"required": True}},
                                    url=ENDPOINTS["sentinel"])
                bare, integrated = self.pair({"sentinel": response})
                self.assertEqual(integrated.requests, bare.requests[:2])
                self.assertEqual(integrated.generated.call_count, 0)
                self.assertNotIn("sideEffectPossible", integrated.facts.data)
                self.assertNotIn("creationConfirmed", integrated.facts.data)
                self.assertEqual(integrated.facts.data["firstFailure"]["stage"], "sentinel")
                self.assertEqual(integrated.facts.data["flowEvidence"]["sentinel"]["reason"], "challenge_required")

    def test_bad_sentinel_cannot_be_swallowed_by_the_original_catch(self):
        cases = [(Response(503, {}, url=ENDPOINTS["sentinel"]), "http_status"),
                 (Response(invalid=True, url=ENDPOINTS["sentinel"]), "invalid_json"),
                 (Response(body={}, url=ENDPOINTS["sentinel"]), "missing_token"),
                 (Response(body={"token": True}, url=ENDPOINTS["sentinel"]), "missing_token"),
                 (Response(body={"token": "synthetic-sentinel-only"}, url="https://other.invalid/"), "untrusted_origin"),
                 (Response(body={"token": "synthetic-sentinel-only", "turnstile": {"required": "false"}},
                           url=ENDPOINTS["sentinel"]), "challenge_invalid")]
        for response, reason in cases:
            with self.subTest(reason=reason, body=response.body):
                integrated = execute(True, {"sentinel": response})
                self.assertEqual([item[1] for item in integrated.requests],
                                 [AUTHORIZE] + [ENDPOINTS["sentinel"]] * (3 if response.status_code >= 500 else 1))
                self.assertEqual(integrated.generated.call_count, 0)
                self.assertFalse(integrated.result.success)
                self.assertEqual(integrated.facts.data["flowEvidence"]["sentinel"]["reason"], reason)

    def test_sentinel_observation_must_be_saved_before_signup(self):
        original = MemoryFacts.record_flow_evidence
        def record(store, task, slot, evidence):
            return False if slot == "sentinel" else original(store, task, slot, evidence)
        with patch.object(MemoryFacts, "record_flow_evidence", record):
            integrated = execute(True)
        self.assertEqual([item[1] for item in integrated.requests], [AUTHORIZE, ENDPOINTS["sentinel"]])
        self.assertEqual(integrated.generated.call_count, 0)
        self.assertFalse(integrated.result.success)

    def test_discarded_session_evidence_cannot_allow_another_signup(self):
        integrated = execute(True)
        count = len(integrated.requests)
        integrated.client.close()
        integrated.engine.session = integrated.client.session
        with self.assertRaises(ValueError):
            integrated.engine._submit_signup_form("fixture-device", "synthetic-sentinel-only")
        self.assertEqual(len(integrated.requests), count)

    def test_password_200_errors_and_untrusted_responses_stop_all_later_requests(self):
        cases = [(Response(body={"error": {"code": "account_creation_failed"}}), "upstream_error"),
                 (Response(body={"errors": ["synthetic-error"]}), "upstream_error"),
                 (Response(invalid=True), "invalid_json"),
                 (Response(body=[]), "invalid_json"),
                 (Response(body={}, url="https://other.invalid/"), "untrusted_origin")]
        for response, reason in cases:
            with self.subTest(reason=reason, body=response.body):
                bare, integrated = self.pair({"password": response})
                self.assertEqual(integrated.requests, bare.requests[:4])
                self.assertFalse(integrated.result.success)
                self.assertNotIn("creationConfirmed", integrated.facts.data)
                self.assertEqual(integrated.facts.data["flowEvidence"]["password"]["reason"], reason)
                self.assertEqual(integrated.facts.data["firstFailure"]["stage"], "password")
                if isinstance(response.body, dict) and response.body.get("error", {}).get("code") == "account_creation_failed":
                    self.assertEqual(integrated.facts.data["firstFailure"]["errorKind"], "account_creation_failed")

    def test_valid_password_objects_do_not_need_an_invented_page_whitelist(self):
        for body in ({}, {"success": True}, {"continue_url": "https://auth.openai.com/fixture-next"}):
            with self.subTest(body=body):
                bare, integrated = self.pair({"password": Response(body=body)})
                self.assertEqual(bare.requests, integrated.requests)
                self.assertTrue(integrated.facts.data["creationConfirmed"])

    def test_historical_evidence_projection_does_not_weaken_live_guards(self):
        for version in (1, 2):
            for slot, response in (("sentinel", Response(body={"token": "synthetic-sentinel-only",
                                           "turnstile": {"required": True}}, url=ENDPOINTS["sentinel"])),
                                   ("password", Response(body={"error": {"code": "account_creation_failed"}}))):
                with self.subTest(version=version, slot=slot):
                    integrated = execute(True, {slot: response}, flow_version=version)
                    flow = integrated.facts.data["flowEvidence"]
                    self.assertEqual(flow["version"], version)
                    self.assertNotIn("sentinel", flow)
                    self.assertEqual(len(integrated.requests), 2 if slot == "sentinel" else 4)
                    self.assertNotIn("creationConfirmed", integrated.facts.data)
                    flow_evidence.validate_flow_evidence(flow)

    def test_diagnostic_only_state_does_not_capture_queries_headers_or_response_body(self):
        integrated = execute(True)
        value = json.dumps({"flowEvidence": integrated.facts.data["flowEvidence"], "firstFailure": integrated.facts.data["firstFailure"]})
        for secret in (AUTHORIZE, "fixture%2Bstate", "synthetic-sentinel-only", "fixture-private-request-id", integrated.engine.password):
            self.assertNotIn(secret, value)
        self.assertNotIn("continue_url", value)
        self.assertNotIn("passwordCheckpoint", value)


if __name__ == "__main__":
    unittest.main()
