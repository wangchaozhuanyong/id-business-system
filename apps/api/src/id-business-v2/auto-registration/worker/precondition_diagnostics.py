"""Bounded, no-email diagnosis using the frozen engine's real initialization.

The release operator must verify the deployment and read settings without
initializing the application before supplying private stdin. This module never
imports the app, opens a database, creates a task, or runs RegistrationEngine.run.
Only closed classifications leave the process; request/response values do not.
"""
from __future__ import annotations

import ast
import __future__
import base64
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
import hashlib
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import re
import secrets
import signal
import sys
import time
from types import SimpleNamespace
from typing import Any, Callable, Dict, Optional, Tuple, Union
import urllib.parse

sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent.parent
SOURCE_NAMES = {
    "upstream/src/config/constants.py", "upstream/src/core/openai/oauth.py",
    "upstream/src/core/http_client.py", "upstream/src/core/register.py", "worker/flow_evidence.py",
}
TRACE_URL = "https://cloudflare.com/cdn-cgi/trace"
SETTING_NAMES = {"clientId", "authUrl", "tokenUrl", "redirectUri", "scope"}
BUSINESS_STEPS = ("signup", "password", "sendOtp", "validateOtp", "createAccount", "tokenExchange")


class DiagnosticStop(BaseException):
    """Escape the upstream Exception retry handlers at the first refusal."""

    def __init__(self, reason, incomplete=False):
        self.reason, self.incomplete = reason, incomplete


def stop(reason, incomplete=False):
    raise DiagnosticStop(reason, incomplete)


def audit_guard(event, args):
    if event in {"sqlite3.connect", "sqlite3.connect/handle"}:
        stop("database_boundary", True)
    if event in {"socket.connect", "socket.connect_ex", "socket.bind", "socket.getaddrinfo"}:
        stop("python_network_boundary", True)
    if event in {"subprocess.Popen", "os.system", "os.exec", "os.fork", "os.forkpty",
                 "os.posix_spawn", "os.posix_spawnp"}:
        stop("process_boundary", True)
    if event == "import":
        name = args[0]
        if name == "src" or name.startswith(("src.", "sqlalchemy")) or name in {"workspace", "apple_mailboxes"}:
            stop("application_import_boundary", True)
    if event == "open":
        mode, flags = args[1:3]
        if (isinstance(mode, str) and any(c in mode for c in "wax+")
                or isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)):
            stop("file_write_boundary", True)
    if event in {"os.mkdir", "os.chmod", "os.chown", "os.remove", "os.rmdir", "os.rename",
                 "os.link", "os.symlink", "os.truncate", "os.utime", "os.setxattr", "os.removexattr"}:
        stop("file_write_boundary", True)


def verify_configuration(config, base):
    fields = {"permitNetwork", "sourceHashes", "settings", "proxyUrl", "proxySource"}
    if not isinstance(config, dict) or set(config) != fields or config["permitNetwork"] is not True:
        stop("configuration_invalid", True)
    settings = config["settings"]
    if (not isinstance(settings, dict) or set(settings) != SETTING_NAMES
            or any(not isinstance(v, str) or not 0 < len(v) <= 8192 for v in settings.values())
            or config["proxySource"] not in {"default", "system", "explicit", "not_recorded"}
            or config["proxyUrl"] is not None and (not isinstance(config["proxyUrl"], str)
                                                  or not 0 < len(config["proxyUrl"]) <= 8192)):
        stop("configuration_invalid", True)
    pins = config["sourceHashes"]
    if not isinstance(pins, dict) or set(pins) != SOURCE_NAMES:
        stop("source_contract_changed", True)
    for name, expected in pins.items():
        path = base / name
        if (not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected)
                or not path.is_file() or path.is_symlink()
                or not path.resolve().is_relative_to(base.resolve())
                or hashlib.sha256(path.read_bytes()).hexdigest() != expected):
            stop("source_changed", True)
    # The real Worker also receives a restricted environment. Never inherit a
    # hidden proxy into a diagnostic that claims a particular resolved proxy.
    if {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} & os.environ.keys():
        stop("environment_proxy_not_verified", True)


def extract(path, namespace, *, functions=(), classes=None):
    """Execute exact selected AST bodies; preserve bases and default arguments."""
    classes, selected, found = classes or {}, [], set()
    for node in ast.parse(path.read_text()).body:
        if isinstance(node, ast.FunctionDef) and node.name in functions:
            selected.append(node)
            found.add(node.name)
        elif isinstance(node, ast.ClassDef) and node.name in classes:
            wanted = classes[node.name]
            if wanted is not None:
                methods = [n for n in node.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
                if {n.name for n in methods} != set(wanted):
                    stop("source_contract_changed", True)
                node.body = methods
            selected.append(node)
            found.add(node.name)
    if found != set(functions) | set(classes):
        stop("source_contract_changed", True)
    module = ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[]))
    exec(compile(module, str(path), "exec", flags=__future__.annotations.compiler_flag, dont_inherit=True), namespace)


def load_sources(base, curl, settings):
    constants = {}
    names = {"OAUTH_CLIENT_ID", "OAUTH_AUTH_URL", "OAUTH_TOKEN_URL", "OAUTH_REDIRECT_URI",
             "OAUTH_SCOPE", "OPENAI_API_ENDPOINTS", "ERROR_MESSAGES"}
    for node in ast.parse((base / "upstream/src/config/constants.py").read_text()).body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in names:
                    constants[target.id] = ast.literal_eval(node.value)
    if set(constants) != names:
        stop("source_contract_changed", True)
    safe_logger = logging.getLogger("id_no_email_precondition")
    safe_logger.addHandler(logging.NullHandler())
    values = SimpleNamespace(openai_client_id=settings["clientId"], openai_auth_url=settings["authUrl"],
                             openai_token_url=settings["tokenUrl"], openai_redirect_uri=settings["redirectUri"],
                             openai_scope=settings["scope"])
    namespace = {"__name__": __name__, "Any": Any, "Dict": Dict, "Optional": Optional,
                 "Tuple": Tuple, "Union": Union, "Callable": Callable, "dataclass": dataclass,
                 "base64": base64, "hashlib": hashlib, "secrets": secrets, "urllib": urllib,
                 "json": json, "time": time, "Session": curl.requests.Session, "Response": Any,
                 "cffi_requests": curl.requests, "logger": safe_logger, "get_settings": lambda: values,
                 **constants}
    extract(base / "upstream/src/core/openai/oauth.py", namespace,
            functions={"_b64url_no_pad", "_sha256_b64url_no_pad", "_random_state", "_pkce_verifier", "generate_oauth_url"},
            classes={"OAuthStart": None, "OAuthManager": {"__init__", "start_oauth"}})
    extract(base / "upstream/src/core/http_client.py", namespace,
            classes={"RequestConfig": None, "HTTPClientError": None, "HTTPClient": None, "OpenAIHTTPClient": None})
    extract(base / "upstream/src/core/register.py", namespace,
            classes={"RegistrationEngine": {"__init__", "_check_ip_location", "_init_session", "_start_oauth",
                                             "_get_device_id", "_check_sentinel"}})
    spec = importlib.util.spec_from_file_location("id_precondition_flow", base / "worker/flow_evidence.py")
    flow = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(flow)
    return namespace, flow


class Boundary:
    def __init__(self, curl, flow):
        self.curl, self.flow = curl, flow
        self.phase, self.session, self.engine = "ip_check", None, None
        self.counts = {"ipCheck": 0, "authorize": 0, "sentinel": 0}
        self.redirects = {"ipCheck": None, "authorize": None, "sentinel": None}
        self.attempts, self.perform_allowed, self.perform_remaining = [], False, 0
        self.ip_response = None
        self.original_request = curl.requests.Session.request
        self.original_perform = curl.Curl.perform

    def install(self):
        boundary = self

        def request(session, method, url, *args, **kwargs):
            return boundary.request(session, method, url, args, kwargs)

        def perform(curl, *args, **kwargs):
            if not boundary.perform_allowed or boundary.perform_remaining != 1:
                stop("transport_bypass_boundary", True)
            boundary.perform_remaining = 0
            return boundary.original_perform(curl, *args, **kwargs)

        self.curl.requests.Session.request = request
        self.curl.Curl.perform = perform

    def restore(self):
        self.curl.requests.Session.request = self.original_request
        self.curl.Curl.perform = self.original_perform

    def request(self, session, method, url, args, kwargs):
        engine = self.engine
        if engine is None or session is not engine.http_client._session:
            stop("session_boundary", True)
        if self.session is None:
            self.session = session
        if session is not self.session:
            stop("session_boundary", True)
        if not isinstance(method, str):
            stop("method_boundary", True)
        method = method.upper()
        phase = self.phase
        key = {"ip_check": "ipCheck", "authorize": "authorize", "sentinel": "sentinel"}.get(phase)
        if key is None or self.counts[key]:
            stop("request_budget", True)
        expected = (TRACE_URL if phase == "ip_check" else engine.oauth_start.auth_url if phase == "authorize"
                    else self.endpoints["sentinel"])
        if method != ("POST" if phase == "sentinel" else "GET") or url != expected:
            stop("forbidden_business_request", True)
        parsed = urllib.parse.urlsplit(url)
        host = "cloudflare.com" if phase == "ip_check" else "sentinel.openai.com" if phase == "sentinel" else "auth.openai.com"
        if parsed.scheme != "https" or parsed.hostname != host or parsed.username or parsed.password or parsed.port not in {None, 443}:
            stop("origin_boundary", True)
        if phase == "sentinel":
            try:
                body = json.loads(kwargs.get("data") or "{}")
            except (TypeError, ValueError):
                stop("sentinel_body_boundary", True)
            if body != {"p": "", "id": self.device_id, "flow": "authorize_continue"}:
                stop("sentinel_body_boundary", True)
        self.counts[key] += 1
        before = self.flow.device_cookie_presence(session)
        # Keep native automatic authorization redirects. Only local diagnostic
        # limits differ: one trace, one authorization (five hops), one Sentinel.
        # A limit hit is INCOMPLETE, never proof of a broken registration flow.
        options = {**kwargs, "allow_redirects": phase == "authorize", "max_redirects": 5 if phase == "authorize" else 0}
        self.perform_allowed, self.perform_remaining = True, 1
        try:
            response = self.original_request(session, method, url, *args, **options)
        except DiagnosticStop:
            raise
        except Exception:
            if phase != "ip_check":
                event = self.flow.attempt_evidence(phase, None, outcome="network_error", response_class="not_applicable",
                                                   device_cookie_before=before,
                                                   device_cookie_after=self.flow.device_cookie_presence(session))
                event["sequence"] = len(self.attempts) + 1
                self.attempts.append(event)
            stop("transport_or_budget_incomplete", True)
        finally:
            self.perform_allowed, self.perform_remaining = False, 0
        redirects = getattr(response, "redirect_count", None)
        if type(redirects) is int and not 0 <= redirects <= (5 if phase == "authorize" else 0):
            stop("redirect_budget", True)
        self.redirects[key] = redirects if type(redirects) is int and 0 <= redirects <= 5 else None
        status = getattr(response, "status_code", None)
        if phase == "ip_check":
            self.ip_response = {"httpStatus": status if type(status) is int else None,
                                "officialOrigin": self.flow.official_origin(getattr(response, "url", None), "cloudflare.com")}
            if not self.ip_response["officialOrigin"]:
                stop("ip_precheck_origin", True)
            if status != 200:
                stop("ip_precheck_redirect_budget" if type(status) is int and 300 <= status < 400 else "ip_precheck_rejected",
                     type(status) is int and 300 <= status < 400)
            return response
        evidence = self.flow.observation(response, phase)
        self.flow.validate_observation(phase, evidence, 3)
        classification = self.flow.response_classification(response, phase, evidence)
        event = self.flow.attempt_evidence(phase, evidence, response_class=classification, device_cookie_before=before,
                                           device_cookie_after=self.flow.device_cookie_presence(session))
        event["sequence"] = len(self.attempts) + 1
        self.attempts.append(event)
        if phase == "sentinel" and type(status) is int and 300 <= status < 400:
            stop("sentinel_redirect_budget", True)
        if not self.flow.response_admitted(response, phase, evidence):
            reason = evidence["reason"] or {"structured_rejection": "upstream_error",
                                          "verification_required": "challenge_required",
                                          "rate_limited": "http_status"}.get(classification, "http_status")
            stop(phase + "_" + reason)
        if phase == "authorize":
            presence = self.flow.device_cookie_presence(session)
            if presence != "present":
                stop("device_cookie_missing" if presence == "absent" else "device_cookie_unavailable",
                     presence == "not_observed")
        return response


def run_precondition(config, *, base=BASE, curl=None):
    result = {"version": 1, "status": "INCOMPLETE", "reason": "configuration_invalid",
              "mode": "frozen_engine_initialization_actual_settings", "diagnosticLimitsApplied": True,
              "fullTransportEquivalenceClaimed": False, "deploymentIdentityVerified": False,
              "historicalTaskConfigurationVerified": False, "sourceHashesVerified": False,
              "configurationSummary": None, "requestCounts": {"ipCheck": 0, "authorize": 0, "sentinel": 0},
              "nativeRedirectCounts": {"ipCheck": None, "authorize": None, "sentinel": None},
              "ipCheck": None, "attempts": [], "businessRequestCounts": dict.fromkeys(BUSINESS_STEPS, 0),
              "databaseConnections": 0, "businessWrites": 0, "registrationStarts": 0,
              "emailProvided": False, "passwordProvided": False, "accountCreationTested": False}
    boundary, engine, previous_logging = None, None, logging.root.manager.disable
    try:
        verify_configuration(config, base)
        result["sourceHashesVerified"] = True
        if curl is None:
            curl = importlib.import_module("curl_cffi")
            if not hasattr(curl, "requests"):
                importlib.import_module("curl_cffi.requests")
        logging.disable(logging.CRITICAL)
        namespace, flow = load_sources(base, curl, config["settings"])
        # Exact original constructor creates OpenAIHTTPClient and OAuthManager.
        # This inert provider cannot create/query mail; run() is not extracted.
        engine = namespace["RegistrationEngine"](object(), proxy_url=config["proxyUrl"], callback_logger=lambda *_: None)
        engine._log = lambda *_args, **_kwargs: None
        result["configurationSummary"] = flow.configuration_summary(engine, config["proxySource"])
        boundary = Boundary(curl, flow)
        boundary.engine, boundary.endpoints = engine, namespace["OPENAI_API_ENDPOINTS"]
        boundary.install()
        ok, country = engine._check_ip_location()
        if not ok:
            stop("ip_location_unavailable")
        if not isinstance(country, str) or not re.fullmatch(r"[A-Z]{2}", country):
            stop("ip_location_unavailable", True)
        boundary.phase = "authorize"
        if not engine._init_session() or engine.session is not boundary.session or not engine._start_oauth():
            stop("session_initialization_failed", True)
        did = engine._get_device_id()
        if not isinstance(did, str) or not did:
            stop("device_cookie_missing")
        boundary.device_id, boundary.phase = did, "sentinel"
        token = engine._check_sentinel(did)
        if not isinstance(token, str) or not token.strip():
            stop("sentinel_token_missing")
        if engine.session is not boundary.session or engine.http_client._session is not boundary.session:
            stop("session_boundary", True)
        result.update(status="PRECONDITION_ACCEPTED", reason=None)
    except DiagnosticStop as error:
        result.update(status="INCOMPLETE" if error.incomplete else "BLOCKED", reason=error.reason)
    except BaseException:
        result.update(status="INCOMPLETE", reason="unexpected_failure")
    finally:
        if boundary is not None:
            boundary.restore()
            result.update(requestCounts=dict(boundary.counts), nativeRedirectCounts=dict(boundary.redirects),
                          ipCheck=boundary.ip_response, attempts=boundary.attempts)
        if engine is not None:
            try:
                engine.http_client.close()
            except BaseException:
                result.update(status="INCOMPLETE", reason="cleanup_failed")
        logging.disable(previous_logging)
    return result


def main():
    # Host execution also sets a kernel deadline. This audit hook is installed
    # only in the isolated CLI process, never in a running application or tests.
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.alarm(90)
    sys.addaudithook(audit_guard)
    raw = sys.stdin.read(65537)
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        try:
            value = run_precondition(json.loads(raw)) if len(raw) <= 65536 else {"status": "INCOMPLETE", "reason": "configuration_invalid"}
        except BaseException:
            value = {"status": "INCOMPLETE", "reason": "configuration_invalid"}
    print(json.dumps(value, sort_keys=True))


if __name__ == "__main__":
    main()
