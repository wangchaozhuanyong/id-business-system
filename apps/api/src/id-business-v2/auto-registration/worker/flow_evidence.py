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

SLOTS = {"authorize", "signup", "password"}
CONTENT_TYPES = {"json", "html", "other", "missing"}
JSON_KINDS = {"object", "other", "invalid", "not_checked"}
PAGE_KINDS = {"new_account", "existing_account", "missing", "unknown", "not_checked"}
HOST_KINDS = {"auth_openai", "sentinel_openai", "chatgpt", "other"}
REASONS = {None, "http_status", "untrusted_origin", "invalid_json", "unexpected_page"}
FIELDS = {"observedAt", "httpStatus", "contentType", "jsonKind", "pageKind", "officialOrigin",
          "redirectHosts", "redirectsTruncated", "requestIdPresent", "requestIdSha256", "decision", "reason"}


def official_origin(value: Any) -> bool:
    if not isinstance(value, str) or len(value) > 16384:
        return False
    try:
        parsed = urlsplit(value)
        return (parsed.scheme == "https" and parsed.hostname == "auth.openai.com"
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


def decision(slot: str, value: dict[str, Any]) -> tuple[str, str | None]:
    if slot == "password":
        return "observed", None
    status = value["httpStatus"]
    if status is None or (not 200 <= status < 300 if slot == "authorize" else status != 200):
        return "rejected", "http_status"
    if not value["officialOrigin"]:
        return "rejected", "untrusted_origin"
    if slot == "signup":
        if value["jsonKind"] != "object":
            return "rejected", "invalid_json"
        if value["pageKind"] not in {"new_account", "existing_account"}:
            return "rejected", "unexpected_page"
    return "accepted", None


def observation(response: Any, slot: str) -> dict[str, Any]:
    if slot not in SLOTS:
        raise ValueError("注册响应阶段无效")
    status = getattr(response, "status_code", None)
    media = header(response, "content-type")
    media = media.split(";", 1)[0].strip().lower() if media else ""
    kind = "missing" if not media else ("json" if media == "application/json" or media.endswith("+json")
                                        else "html" if media == "text/html" else "other")
    json_kind, page_kind = "not_checked", "not_checked"
    if slot == "signup":
        try:
            body = response.json()
            if not isinstance(body, dict):
                json_kind = "other"
            else:
                json_kind = "object"
                page = body.get("page")
                raw_kind = page.get("type") if isinstance(page, dict) else None
                if body.get("error") or body.get("errors"):
                    page_kind = "unknown"
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
             "officialOrigin": official_origin(getattr(response, "url", None)),
             "redirectHosts": [host_kind(getattr(item, "url", None)) for item in history[:5]],
             "redirectsTruncated": len(history) > 5, "requestIdPresent": present, "requestIdSha256": request_hash}
    value["decision"], value["reason"] = decision(slot, value)
    validate_observation(slot, value)
    return value


def validate_observation(slot: str, value: Any) -> None:
    if slot not in SLOTS or not isinstance(value, dict) or set(value) != FIELDS:
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
    if (not valid_stamp or (status is not None and (type(status) is not int or not 100 <= status <= 599))
            or not member(value["contentType"], CONTENT_TYPES) or not member(value["jsonKind"], JSON_KINDS)
            or not member(value["pageKind"], PAGE_KINDS) or type(value["officialOrigin"]) is not bool
            or type(value["redirectsTruncated"]) is not bool or type(value["requestIdPresent"]) is not bool
            or not isinstance(value["redirectHosts"], list) or len(value["redirectHosts"]) > 5
            or any(not isinstance(item, str) or item not in HOST_KINDS for item in value["redirectHosts"])
            or (digest is not None and (not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)))
            or (not value["requestIdPresent"] and digest is not None)
            or (value["redirectsTruncated"] and len(value["redirectHosts"]) != 5)
            or (slot != "signup" and (value["jsonKind"] != "not_checked" or value["pageKind"] != "not_checked"))
            or (slot == "signup" and value["jsonKind"] != "object" and value["pageKind"] != "not_checked")
            or (value["reason"] is not None and not member(value["reason"], REASONS))
            or (value["decision"], value["reason"]) != decision(slot, value)):
        raise ValueError("注册响应证据格式无效")


def validate_flow_evidence(value: Any) -> None:
    if (not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1
            or not set(value) <= {"version"} | SLOTS):
        raise ValueError("注册响应证据格式无效")
    for slot in SLOTS & set(value):
        validate_observation(slot, value[slot])
