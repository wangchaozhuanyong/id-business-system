"""Closed, non-secret HTTP evidence for an existing registration task.

No request data, cookie, raw URL or response payload is retained. The caller
owns the transport; these helpers neither send nor retry a request.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import re
from typing import Any
from urllib.parse import urlsplit

LEGACY_SLOTS = {"authorize", "signup", "password"}
SLOTS = LEGACY_SLOTS | {"sentinel"}
CURRENT_VERSION = 3
CURRENT_FLOW_VERSION = 4
MAX_ATTEMPTS = 32
MAX_SEQUENCE = 9007199254740991
COOKIE_PRESENCE = {"present", "absent", "not_observed"}
ATTEMPT_OUTCOMES = {"response", "network_error", "evidence_storage_error"}
RESPONSE_CLASSES = {"verification_required", "structured_rejection", "rate_limited", "unclassified", "not_applicable"}
ATTEMPT_FIELDS = {"sequence", "stage", "outcome", "observedAt", "observation", "responseClass",
                  "deviceCookieBefore", "deviceCookieAfter"}
CONFIGURATION_FIELDS = {"clientIdMatchesFrozenDefault", "authUrlMatchesFrozenDefault", "tokenUrlMatchesFrozenDefault",
                        "redirectUriMatchesFrozenDefault", "scopeMatchesFrozenDefault", "proxyPresent", "proxySource"}
PROXY_SOURCES = {"default", "system", "explicit", "not_recorded"}
# Public constants from the frozen upstream, checked against its AST in tests.
# Only equality booleans leave configuration_summary; never the configured values.
OAUTH_DEFAULTS = {"client_id": "app_EMoamEEZ73f0CkXaXp7hrann", "auth_url": "https://auth.openai.com/oauth/authorize",
                  "token_url": "https://auth.openai.com/oauth/token", "redirect_uri": "http://localhost:1455/auth/callback",
                  "scope": "openid email profile offline_access"}
CONTENT_TYPES = {"json", "html", "other", "missing"}
JSON_KINDS = {"object", "other", "invalid", "not_checked"}
PAGE_KINDS = {"new_account", "existing_account", "missing", "unknown", "not_checked"}
HOST_KINDS = {"auth_openai", "sentinel_openai", "chatgpt", "other"}
REASONS = {None, "http_status", "untrusted_origin", "invalid_json", "unexpected_page"}
DETAIL_FIELDS = {"errorSignal", "errorShape", "errorsShape", "errorKind", "pageShape"}
ERROR_SIGNALS = {"none", "error", "errors", "both"}
VALUE_SHAPES = {"missing", "null", "object", "string", "list", "boolean", "number", "other"}
ERROR_KINDS = {"none", "account_creation_failed", "user_exists", "other"}
PAGE_SHAPES = {"missing", "non_object", "type_missing", "type_non_string", "type_known", "type_unknown"}
OFFICIAL_ERROR_KINDS = {"account_creation_failed", "user_exists"}
REQUIREMENT_STATES = {"required", "not_required", "missing", "invalid"}
SENTINEL_FIELDS = {"tokenPresent", "proofOfWorkRequired", "turnstileRequired"}
V3_REASONS = {"upstream_error", "challenge_required", "challenge_invalid", "missing_token"}
FIELDS = {"observedAt", "httpStatus", "contentType", "jsonKind", "pageKind", "officialOrigin",
          "redirectHosts", "redirectsTruncated", "requestIdPresent", "requestIdSha256", "decision", "reason"}


def official_origin(value: Any, expected_host: str = "auth.openai.com") -> bool:
    if not isinstance(value, str) or len(value) > 16384:
        return False
    try:
        parsed = urlsplit(value)
        return (parsed.scheme == "https" and parsed.hostname == expected_host
                and parsed.username is None and parsed.password is None and parsed.port in {None, 443})
    except ValueError:
        return False


def host_kind(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 16384:
        return "other"
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != "https" or parsed.username is not None or parsed.password is not None
                or parsed.port not in {None, 443}):
            return "other"
        return {"auth.openai.com": "auth_openai", "sentinel.openai.com": "sentinel_openai",
                "chatgpt.com": "chatgpt"}.get(parsed.hostname, "other")
    except ValueError:
        return "other"


def header(response: Any, name: str) -> str | None:
    headers = getattr(response, "headers", None)
    if not hasattr(headers, "get"):
        return None
    for key in (name, name.title()):
        value = headers.get(key)
        if isinstance(value, str):
            return value
    return None


def device_cookie_presence(session: Any) -> str:
    """Observe existence only; do not retain a cookie value or its digest."""
    try:
        cookies = getattr(session, "cookies", None)
        if not callable(getattr(cookies, "get", None)):
            return "not_observed"
        value = cookies.get("oai-did")
        return "present" if isinstance(value, str) and bool(value) else "absent"
    except Exception:
        return "not_observed"


def configuration_summary(engine: Any, proxy_source: str = "not_recorded") -> dict[str, Any]:
    manager = getattr(engine, "oauth_manager", None)
    summary = {}
    for attribute, field in (("client_id", "clientId"), ("auth_url", "authUrl"), ("token_url", "tokenUrl"),
                             ("redirect_uri", "redirectUri"), ("scope", "scope")):
        value = getattr(manager, attribute, None)
        summary[field + "MatchesFrozenDefault"] = value == OAUTH_DEFAULTS[attribute] if isinstance(value, str) else None
    proxy = getattr(engine, "proxy_url", ...)
    summary["proxyPresent"] = bool(proxy) if isinstance(proxy, str) or proxy is None else None
    summary["proxySource"] = proxy_source if isinstance(proxy_source, str) and proxy_source in PROXY_SOURCES else "not_recorded"
    validate_configuration_summary(summary)
    return summary


def validate_configuration_summary(value: Any) -> None:
    if (not isinstance(value, dict) or set(value) != CONFIGURATION_FIELDS
            or any(value[key] is not None and type(value[key]) is not bool for key in CONFIGURATION_FIELDS - {"proxySource"})
            or not isinstance(value["proxySource"], str) or value["proxySource"] not in PROXY_SOURCES):
        raise ValueError("注册配置证据格式无效")


def response_classification(response: Any, slot: str, evidence: dict[str, Any] | None = None) -> str:
    """Classify only explicit safe signals; an unexplained 403 stays unknown."""
    if response is None:
        return "not_applicable"
    value = observation(response, slot) if evidence is None else evidence
    validate_observation(slot, value, 3)
    if value["httpStatus"] == 429:
        return "rate_limited"
    mitigated = header(response, "cf-mitigated") or ""
    if (value["officialOrigin"] and ((len(mitigated) <= 64 and mitigated.lower().strip() == "challenge")
            or slot == "sentinel" and value.get("reason") == "challenge_required")):
        return "verification_required"
    if value.get("responseDetails", {}).get("errorSignal", "none") != "none":
        return "structured_rejection"
    if (slot == "sentinel" and value["jsonKind"] == "object"
            or slot == "authorize" and value["httpStatus"] is not None and value["httpStatus"] >= 400 and value["contentType"] == "json"):
        try:
            body = response.json()
            if isinstance(body, dict) and (body.get("error") or body.get("errors")):
                return "structured_rejection"
        except Exception:
            pass
    return "unclassified"


def response_admitted(response: Any, slot: str, evidence: dict[str, Any] | None = None, *, response_class: str | None = None) -> bool:
    """Live admission includes v4 classes without changing historical v3 data."""
    value = observation(response, slot) if evidence is None else evidence
    validate_observation(slot, value, 3)
    classification = response_classification(response, slot, value) if response_class is None else response_class
    if not isinstance(classification, str) or classification not in RESPONSE_CLASSES:
        raise ValueError("注册响应分类无效")
    return value["decision"] == "accepted" and classification not in {"verification_required", "structured_rejection", "rate_limited", "not_applicable"}


def new_flow_evidence() -> dict[str, Any]:
    return {"version": 4, "attempts": [], "attemptsTruncated": False, "configurationSummary": None}


def attempt_evidence(slot: str, evidence: dict[str, Any] | None, *, outcome: str = "response",
                     response_class: str = "unclassified", device_cookie_before: str = "not_observed",
                     device_cookie_after: str = "not_observed") -> dict[str, Any]:
    value = {"sequence": 1, "stage": slot, "outcome": outcome,
             "observedAt": evidence["observedAt"] if evidence is not None else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
             "observation": evidence, "responseClass": response_class,
             "deviceCookieBefore": device_cookie_before, "deviceCookieAfter": device_cookie_after}
    validate_attempt(value)
    return value


def validate_attempt(value: Any) -> None:
    if (not isinstance(value, dict) or set(value) != ATTEMPT_FIELDS
            or type(value["sequence"]) is not int or not 1 <= value["sequence"] <= MAX_SEQUENCE
            or not isinstance(value["stage"], str) or value["stage"] not in SLOTS
            or not isinstance(value["outcome"], str) or value["outcome"] not in ATTEMPT_OUTCOMES
            or not isinstance(value["responseClass"], str) or value["responseClass"] not in RESPONSE_CLASSES
            or any(not isinstance(value[key], str) or value[key] not in COOKIE_PRESENCE
                   for key in ("deviceCookieBefore", "deviceCookieAfter"))):
        raise ValueError("注册逐次证据格式无效")
    stamp = value["observedAt"]
    try:
        valid = (isinstance(stamp, str) and len(stamp) <= 32
                 and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", stamp)
                 and datetime.fromisoformat(stamp.replace("Z", "+00:00")))
    except ValueError:
        valid = False
    evidence = value["observation"]
    if not valid or (value["outcome"] == "response" and evidence is None) or (value["outcome"] == "network_error" and evidence is not None):
        raise ValueError("注册逐次证据格式无效")
    if evidence is not None:
        validate_observation(value["stage"], evidence, 3)
        if (value["responseClass"] == "not_applicable"
                or value["responseClass"] == "rate_limited" and evidence["httpStatus"] != 429
                or value["responseClass"] == "structured_rejection" and value["stage"] not in {"authorize", "sentinel"}
                   and evidence.get("responseDetails", {}).get("errorSignal", "none") == "none"):
            raise ValueError("注册逐次证据格式无效")
    elif value["responseClass"] != "not_applicable":
        raise ValueError("注册逐次证据格式无效")


def append_attempt(flow: dict[str, Any], attempt: dict[str, Any]) -> dict[str, Any]:
    validate_flow_evidence(flow)
    validate_attempt(attempt)
    if flow["version"] != 4:
        return flow
    previous = flow["attempts"][-1] if flow["attempts"] else None
    replace = (previous is not None and attempt["outcome"] == "evidence_storage_error"
               and attempt["observation"] is not None and previous["stage"] == attempt["stage"]
               and previous["observedAt"] == attempt["observedAt"] and previous["observation"] == attempt["observation"])
    sequence = previous["sequence"] if replace else previous["sequence"] + 1 if previous else 1
    if sequence > MAX_SEQUENCE:
        raise ValueError("注册逐次证据数量超出范围")
    rows = [*(flow["attempts"][:-1] if replace else flow["attempts"]), {**attempt, "sequence": sequence}]
    updated = {**flow, "attempts": rows[-MAX_ATTEMPTS:],
               "attemptsTruncated": flow["attemptsTruncated"] or len(rows) > MAX_ATTEMPTS}
    slot, evidence = attempt["stage"], attempt["observation"]
    if evidence is None:
        updated.pop(slot, None)
    else:
        updated[slot] = evidence
    validate_flow_evidence(updated)
    return updated


def decision(slot: str, value: dict[str, Any], version: int = CURRENT_VERSION) -> tuple[str, str | None]:
    # Historical password evidence was observational. Keep its reader contract,
    # while the caller always enforces the current decision before projection.
    if slot == "password" and version < 3:
        return "observed", None
    status = value["httpStatus"]
    if status is None or (not 200 <= status < 300 if slot == "authorize" else status != 200):
        return "rejected", "http_status"
    if not value["officialOrigin"]:
        return "rejected", "untrusted_origin"
    if slot != "authorize":
        if value["jsonKind"] != "object":
            return "rejected", "invalid_json"
    if slot == "sentinel":
        details = value.get("sentinelDetails", {})
        requirements = (details.get("proofOfWorkRequired"), details.get("turnstileRequired"))
        if "invalid" in requirements:
            return "rejected", "challenge_invalid"
        if "required" in requirements:
            return "rejected", "challenge_required"
        if not details.get("tokenPresent"):
            return "rejected", "missing_token"
    elif slot in {"signup", "password"}:
        if version >= 2 and value.get("responseDetails", {}).get("errorSignal", "none") != "none":
            return "rejected", "upstream_error"
        if slot == "signup" and value["pageKind"] not in {"new_account", "existing_account"}:
            return "rejected", "unexpected_page"
    return "accepted", None


def value_shape(body: dict[str, Any], key: str) -> str:
    if key not in body:
        return "missing"
    value = body[key]
    if value is None:
        return "null"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "list"
    if type(value) is bool:
        return "boolean"
    if type(value) in {int, float}:
        return "number"
    return "other"


def response_details(body: dict[str, Any], version: int = CURRENT_VERSION) -> dict[str, Any]:
    """Classify JSON structure without copying a response value into evidence."""
    error, errors = bool(body.get("error")), bool(body.get("errors"))
    signal = "both" if error and errors else "error" if error else "errors" if errors else "none"
    raw_error = body.get("error")
    code = raw_error.get("code") if isinstance(raw_error, dict) else None
    error_kind = (code if isinstance(code, str) and code in OFFICIAL_ERROR_KINDS else "other") if error or errors else "none"
    page = body.get("page")
    if "page" not in body:
        page_shape = "missing"
    elif not isinstance(page, dict):
        page_shape = "non_object"
    elif "type" not in page:
        page_shape = "type_missing"
    elif not isinstance(page["type"], str):
        page_shape = "type_non_string"
    else:
        page_shape = "type_known" if page["type"] in {"password", "email_otp_verification"} else "type_unknown"
    details = {"errorSignal": signal, "errorShape": value_shape(body, "error"),
               "errorsShape": value_shape(body, "errors"), "errorKind": error_kind, "pageShape": page_shape}
    if version >= 3:
        # Unknown page values never leave the response. A digest only permits
        # correlating a bounded identifier; it does not recover an old value.
        raw_type = page.get("type") if isinstance(page, dict) else None
        identifier = (page_shape == "type_unknown" and isinstance(raw_type, str)
                      and re.fullmatch(r"[a-z][a-z0-9_]{0,127}", raw_type))
        details["pageTypeSha256"] = hashlib.sha256(raw_type.encode()).hexdigest() if identifier else None
    return details


def sentinel_details(body: dict[str, Any]) -> dict[str, Any]:
    def requirement(key):
        if key not in body:
            return "missing"
        value = body[key]
        if not isinstance(value, dict):
            return "invalid"
        if "required" not in value:
            return "missing"
        required = value["required"]
        return ("required" if required else "not_required") if type(required) is bool else "invalid"
    token = body.get("token")
    return {"tokenPresent": isinstance(token, str) and 0 < len(token) <= 16384 and bool(token.strip()),
            "proofOfWorkRequired": requirement("proofofwork"), "turnstileRequired": requirement("turnstile")}



def observation(response: Any, slot: str) -> dict[str, Any]:
    if slot not in SLOTS:
        raise ValueError("注册响应阶段无效")
    status = getattr(response, "status_code", None)
    media = header(response, "content-type")
    media = media.split(";", 1)[0].strip().lower() if media else ""
    kind = "missing" if not media else ("json" if media == "application/json" or media.endswith("+json")
                                        else "html" if media == "text/html" else "other")
    json_kind, page_kind, details, challenge = "not_checked", "not_checked", None, None
    if slot != "authorize":
        try:
            body = response.json()
            if not isinstance(body, dict):
                json_kind = "other"
            else:
                json_kind = "object"
                if slot == "sentinel":
                    challenge = sentinel_details(body)
                else:
                    details = response_details(body)
                page = body.get("page")
                raw_kind = page.get("type") if isinstance(page, dict) else None
                if slot == "sentinel":
                    page_kind = "not_checked"
                elif raw_kind is None or raw_kind == "":
                    page_kind = "missing"
                else:
                    page_kind = {"password": "new_account", "email_otp_verification": "existing_account"}.get(
                        raw_kind, "unknown") if isinstance(raw_kind, str) else "unknown"
        except Exception:
            json_kind = "invalid"
    history = getattr(response, "history", None)
    history = history if isinstance(history, (list, tuple)) else []
    request_id = header(response, "x-request-id")
    present = isinstance(request_id, str) and bool(request_id)
    # Only a digest of a bounded header can leave the response object.
    request_hash = hashlib.sha256(request_id.encode("utf-8")).hexdigest() if present and len(request_id) <= 4096 else None
    value = {"observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
             "httpStatus": status if type(status) is int and 100 <= status <= 599 else None,
             "contentType": kind, "jsonKind": json_kind, "pageKind": page_kind,
             "officialOrigin": official_origin(getattr(response, "url", None),
                                               "sentinel.openai.com" if slot == "sentinel" else "auth.openai.com"),
             "redirectHosts": [host_kind(getattr(item, "url", None)) for item in history[:5]],
             "redirectsTruncated": len(history) > 5, "requestIdPresent": present, "requestIdSha256": request_hash}
    if details is not None:
        value["responseDetails"] = details
    if challenge is not None:
        value["sentinelDetails"] = challenge
    value["decision"], value["reason"] = decision(slot, value)
    validate_observation(slot, value)
    return value


def validate_observation(slot: str, value: Any, version: int = CURRENT_VERSION) -> None:
    if type(version) is not int or version not in {1, 2, 3} or slot not in (SLOTS if version == 3 else LEGACY_SLOTS):
        raise ValueError("注册响应证据格式无效")
    detail_slot = slot == "signup" and version >= 2 or slot == "password" and version == 3
    allowed = FIELDS | ({"responseDetails"} if detail_slot else set()) | ({"sentinelDetails"} if slot == "sentinel" else set())
    if not isinstance(value, dict) or not FIELDS <= set(value) <= allowed:
        raise ValueError("注册响应证据格式无效")
    if detail_slot and value["jsonKind"] == "object" and "responseDetails" not in value:
        raise ValueError("注册响应证据格式无效")
    details = value.get("responseDetails")
    if "responseDetails" in value:
        def member(item, choices):
            return isinstance(item, str) and item in choices
        expected = DETAIL_FIELDS | ({"pageTypeSha256"} if version == 3 else set())
        if (not isinstance(details, dict) or set(details) != expected
                or not member(details["errorSignal"], ERROR_SIGNALS)
                or not member(details["errorShape"], VALUE_SHAPES)
                or not member(details["errorsShape"], VALUE_SHAPES)
                or not member(details["errorKind"], ERROR_KINDS)
                or not member(details["pageShape"], PAGE_SHAPES)
                or not isinstance(value["pageKind"], str)
                or value["jsonKind"] != "object"
                or ((details["errorSignal"] == "none") != (details["errorKind"] == "none"))
                or (details["errorSignal"] in {"error", "both"} and details["errorShape"] in {"missing", "null"})
                or (details["errorSignal"] in {"errors", "both"} and details["errorsShape"] in {"missing", "null"})
                or (details["errorKind"] in OFFICIAL_ERROR_KINDS
                    and (details["errorShape"] != "object" or details["errorSignal"] not in {"error", "both"}))
                or ((details["pageShape"] == "type_known") != (value["pageKind"] in {"new_account", "existing_account"}))
                or (details["pageShape"] in {"missing", "non_object", "type_missing"} and value["pageKind"] != "missing")
                or (details["pageShape"] in {"type_non_string", "type_unknown"} and value["pageKind"] not in {"missing", "unknown"})):
            raise ValueError("注册响应证据格式无效")
        if version == 3:
            digest = details["pageTypeSha256"]
            if (digest is not None and (not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
                    or details["pageShape"] != "type_unknown" or value["pageKind"] != "unknown")):
                raise ValueError("注册响应证据格式无效")
    if slot == "sentinel":
        challenge = value.get("sentinelDetails")
        if value["jsonKind"] == "object":
            if (not isinstance(challenge, dict) or set(challenge) != SENTINEL_FIELDS
                    or type(challenge["tokenPresent"]) is not bool
                    or any(not isinstance(challenge[key], str) or challenge[key] not in REQUIREMENT_STATES
                           for key in ("proofOfWorkRequired", "turnstileRequired"))):
                raise ValueError("注册响应证据格式无效")
        elif "sentinelDetails" in value:
            raise ValueError("注册响应证据格式无效")
    stamp = value["observedAt"]
    try:
        valid_stamp = (isinstance(stamp, str) and len(stamp) <= 32
                       and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", stamp)
                       and datetime.fromisoformat(stamp.replace("Z", "+00:00")))
    except ValueError:
        valid_stamp = False
    status, digest = value["httpStatus"], value["requestIdSha256"]
    def member(item, choices):
        return isinstance(item, str) and item in choices
    json_slot = slot in {"signup", "password"} if version == 3 else slot == "signup"
    reasons = REASONS | (V3_REASONS if version == 3 else {"upstream_error"} if version == 2 else set())
    if (not valid_stamp or (status is not None and (type(status) is not int or not 100 <= status <= 599))
            or not member(value["contentType"], CONTENT_TYPES) or not member(value["jsonKind"], JSON_KINDS)
            or not member(value["pageKind"], PAGE_KINDS) or type(value["officialOrigin"]) is not bool
            or type(value["redirectsTruncated"]) is not bool or type(value["requestIdPresent"]) is not bool
            or not isinstance(value["redirectHosts"], list) or len(value["redirectHosts"]) > 5
            or any(not isinstance(item, str) or item not in HOST_KINDS for item in value["redirectHosts"])
            or (digest is not None and (not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)))
            or (not value["requestIdPresent"] and digest is not None)
            or (value["redirectsTruncated"] and len(value["redirectHosts"]) != 5)
            or (slot == "authorize" or version < 3 and slot == "password")
                and (value["jsonKind"] != "not_checked" or value["pageKind"] != "not_checked")
            or (slot == "sentinel" and (value["jsonKind"] == "not_checked" or value["pageKind"] != "not_checked"))
            or (json_slot and value["jsonKind"] != "object" and value["pageKind"] != "not_checked")
            or (value["reason"] is not None and not member(value["reason"], reasons))
            or (value["decision"], value["reason"]) != decision(slot, value, version)):
        raise ValueError("注册响应证据格式无效")


def observation_for_version(slot: str, value: dict[str, Any], version: int) -> dict[str, Any] | None:
    """Project current evidence for storage only; enforce v3 before calling.

    Old tasks retain their historical reader schema and password decision. The
    projection must never be used to decide whether a live flow may continue.
    """
    validate_observation(slot, value)
    if type(version) is not int or version not in {1, 2, 3, 4}:
        raise ValueError("注册响应证据格式无效")
    if version in {3, 4}:
        return {**value, "redirectHosts": list(value["redirectHosts"]),
                **({"responseDetails": dict(value["responseDetails"])} if "responseDetails" in value else {}),
                **({"sentinelDetails": dict(value["sentinelDetails"])} if "sentinelDetails" in value else {})}
    if slot == "sentinel":
        return None
    projected = {key: item for key, item in value.items() if key in FIELDS}
    projected["redirectHosts"] = list(value["redirectHosts"])
    if slot == "password":
        projected.update(jsonKind="not_checked", pageKind="not_checked")
    elif slot == "signup":
        if version == 2 and "responseDetails" in value:
            projected["responseDetails"] = {key: item for key, item in value["responseDetails"].items() if key in DETAIL_FIELDS}
        elif version == 1 and value.get("responseDetails", {}).get("errorSignal", "none") != "none":
            projected["pageKind"] = "unknown"
    projected["decision"], projected["reason"] = decision(slot, projected, version)
    validate_observation(slot, projected, version)
    return projected


def observation_v1(slot: str, value: dict[str, Any]) -> dict[str, Any]:
    projected = observation_for_version(slot, value, 1)
    if projected is None:
        raise ValueError("旧任务不记录新增响应阶段")
    return projected


def validate_flow_evidence(value: Any) -> None:
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] not in {1, 2, 3, 4}:
        raise ValueError("注册响应证据格式无效")
    version = value["version"]
    if version == 4:
        required = {"version", "attempts", "attemptsTruncated", "configurationSummary"}
        if (not required <= set(value) <= required | SLOTS or not isinstance(value["attempts"], list)
                or len(value["attempts"]) > MAX_ATTEMPTS or type(value["attemptsTruncated"]) is not bool):
            raise ValueError("注册响应证据格式无效")
        if value["configurationSummary"] is not None:
            validate_configuration_summary(value["configurationSummary"])
        rows = value["attempts"]
        for index, row in enumerate(rows):
            validate_attempt(row)
            if index and row["sequence"] != rows[index - 1]["sequence"] + 1:
                raise ValueError("注册逐次证据顺序无效")
        if (value["attemptsTruncated"] != bool(rows and rows[0]["sequence"] > 1)
                or value["attemptsTruncated"] and len(rows) != MAX_ATTEMPTS):
            raise ValueError("注册逐次证据截断标记无效")
        for slot in SLOTS:
            latest = next((row for row in reversed(rows) if row["stage"] == slot), None)
            if latest is not None and ((latest["observation"] is None and slot in value)
                    or latest["observation"] is not None and value.get(slot) != latest["observation"]):
                raise ValueError("注册阶段摘要与逐次证据不一致")
    elif not set(value) <= {"version"} | (SLOTS if version == 3 else LEGACY_SLOTS):
        raise ValueError("注册响应证据格式无效")
    for slot in SLOTS & set(value):
        validate_observation(slot, value[slot], min(version, 3))
