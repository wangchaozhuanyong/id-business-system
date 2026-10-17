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
    if type(version) is not int or version not in {1, 2, 3}:
        raise ValueError("注册响应证据格式无效")
    if version == 3:
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
    if (not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] not in {1, 2, 3}
            or not set(value) <= {"version"} | (SLOTS if value["version"] == 3 else LEGACY_SLOTS)):
        raise ValueError("注册响应证据格式无效")
    for slot in SLOTS & set(value):
        validate_observation(slot, value[slot], value["version"])
