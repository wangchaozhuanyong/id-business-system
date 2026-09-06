"""凭据解析、脱敏与只读 HTTP 诊断。浏览器购买逻辑不使用此 HTTP 传输。"""
from __future__ import annotations

import base64
import http.client
import json
import os
from pathlib import Path
import re
import socket
import ssl
import time
from dataclasses import dataclass, field

HOST = "chatgpt.com"
ACCOUNT_PATH = "/backend-api/accounts/check/v4-2023-04-27"
CHECKOUT_PATH = "/backend-api/payments/checkout"
MAX_BYTES = 512 * 1024
ROOT = Path(__file__).resolve().parent


class Stop(Exception):
    def __init__(self, code: str, **details):
        super().__init__(code)
        self.report = {"status": "blocked", "reason": code, **details}


@dataclass(frozen=True)
class Credential:
    token: str = field(repr=False)
    account_id: str = field(repr=False)
    expires_at: int


def unique_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate field")
        out[key] = value
    return out


def parse_credential(raw: bytes, *, allow_expired=False) -> Credential:
    if len(raw) > MAX_BYTES:
        raise Stop("json_too_large")
    try:
        data = json.loads(raw, object_pairs_hook=unique_object)
        if not isinstance(data, dict):
            raise ValueError()
        tokens = [data[k] for k in ("accessToken", "access_token") if k in data]
        if not tokens or any(not isinstance(t, str) or not t for t in tokens) or len(set(tokens)) != 1:
            raise ValueError()
        token = tokens[0].strip()
        if len(token) > 65536 or not re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", token):
            raise ValueError()
        def decode(segment):
            return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)), object_pairs_hook=unique_object)
        header, claims = map(decode, token.split(".")[:2])
        if not isinstance(header, dict) or not isinstance(claims, dict) or header.get("enc"):
            raise ValueError()
        if not isinstance(header.get("alg"), str) or header["alg"].lower() in ("none", ""):
            raise ValueError()
        exp = claims.get("exp")
        auth = claims.get("https://api.openai.com/auth")
        aid = auth.get("chatgpt_account_id") if isinstance(auth, dict) else None
        if type(exp) is not int or not 0 < exp < 253402300800:
            raise ValueError()
        if not isinstance(aid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", aid):
            raise Stop("missing_target_account_id")
        account = data.get("account")
        if isinstance(account, dict) and account.get("id") and account["id"] != aid:
            raise Stop("json_account_mismatch")
        profile, user = claims.get("https://api.openai.com/profile"), data.get("user")
        if isinstance(profile, dict) and isinstance(user, dict) and profile.get("email") and user.get("email"):
            if profile["email"] != user["email"]:
                raise Stop("json_email_mismatch")
    except (ValueError, TypeError, KeyError, RecursionError):
        raise Stop("invalid_json_or_access_token") from None
    if not allow_expired and exp <= time.time() + 30:
        raise Stop("access_token_expired")
    # 只解码声明；由接下来的 ChatGPT 账户接口验证凭据和目标账户。
    return Credential(token, aid, exp)


def safe_text(value, token: str = "") -> str | None:
    """错误文本脱敏；原始响应、响应头及请求正文不写盘。"""
    if not isinstance(value, str):
        return None
    if token:
        value = value.replace(token, "[credential]")
    value = re.sub(r"(?i)Bearer\s+\S+", "Bearer [credential]", value)
    value = re.sub(r"https?://\S+", "[url]", value)
    value = re.sub(r"[\w.+-]+@[\w.-]+", "[email]", value)
    value = re.sub(r"[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+)+", "[credential]", value)
    value = re.sub(r"[A-Za-z0-9_-]{28,}", "[identifier]", value)
    value = re.sub(r"(?i)(token|password|cookie|secret|authorization)\s*[=:]\s*[^\s,;]+", r"\1=[redacted]", value)
    value = re.sub(r"[\x00-\x1f\x7f]", " ", value)
    return value[:400]


def response_json(status: int, headers: dict, raw: bytes, token: str) -> dict:
    try:
        data = json.loads(raw, object_pairs_hook=unique_object)
    except (ValueError, RecursionError):
        data = None
    if not 200 <= status < 300:
        # 只记录确实观察到的 challenge 标记，不把所有 403 都解释为风控。
        challenge = (headers.get("cf-mitigated") == "challenge"
                     or b"/cdn-cgi/challenge-platform/" in raw)
        error = data.get("error", data.get("detail", data)) if isinstance(data, dict) else None
        details = {"http_status": status, "response_format": "json" if isinstance(data, dict) else "non_json",
                   "challenge_observed": challenge}
        for name in ("x-request-id", "request-id", "cf-ray"):
            value = headers.get(name)
            if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{6,100}", value):
                details[name.replace("-", "_")] = value
        if isinstance(error, dict):
            for key in ("code", "type", "param", "message"):
                value = safe_text(error.get(key), token)
                if value:
                    details["server_" + key] = value
        elif isinstance(error, str):
            details["server_message"] = safe_text(error, token)
        raise Stop("verification_required" if challenge else "http_error", **details)
    if not isinstance(data, dict):
        raise Stop("unexpected_response", http_status=status)
    return data


def request(method: str, path: str, credential: Credential, body=None) -> dict:
    if (method, path) != ("GET", ACCOUNT_PATH) or body is not None:
        raise Stop("unexpected_request_target")
    connection = http.client.HTTPSConnection(HOST, timeout=25, context=ssl.create_default_context())
    headers = {"Authorization": "Bearer " + credential.token, "chatgpt-account-id": credential.account_id,
               "Accept": "application/json", "User-Agent": "subscription-checkout-test/0.1",
               "Origin": "https://chatgpt.com", "Referer": "https://chatgpt.com/"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    try:
        # 无代理轮换、Cookie 注入、浏览器指纹伪装、重定向或自动重试。
        connection.request(method, path, json.dumps(body).encode() if body is not None else None, headers)
        response = connection.getresponse()
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise Stop("response_too_large")
        return response_json(response.status, {k.lower(): v for k, v in response.getheaders()}, raw, credential.token)
    except (socket.timeout, TimeoutError):
        raise Stop("network_timeout") from None
    except (OSError, http.client.HTTPException):
        raise Stop("network_error") from None
    finally:
        connection.close()


def check_account(credential: Credential) -> str:
    data = request("GET", ACCOUNT_PATH, credential)
    return account_plan(data, credential.account_id)


def account_plan(data: dict, account_id: str) -> str:
    accounts = data.get("accounts")
    node = accounts.get(account_id) if isinstance(accounts, dict) else None
    if not isinstance(node, dict):
        raise Stop("official_account_mismatch")
    account = node.get("account")
    if not isinstance(account, dict):
        raise Stop("unknown_account_shape")
    if account.get("account_id") and account["account_id"] != account_id:
        raise Stop("official_account_mismatch")
    plan = account.get("plan_type") or node.get("plan_type")
    if plan not in ("free", "plus", "pro", "team", "business", "enterprise", "edu", "go"):
        raise Stop("unknown_current_plan")
    entitlement = node.get("entitlement")
    if plan == "free" and isinstance(entitlement, dict) and entitlement.get("has_active_subscription") is True:
        raise Stop("existing_subscription_conflict")
    return plan


def checkout_result(data: dict) -> tuple[dict, str | None]:
    sid = data.get("checkout_session_id") or data.get("session_id")
    entity = data.get("processor_entity")
    if not isinstance(sid, str) or not re.fullmatch(r"(?:oaics|cs)_[A-Za-z0-9_]{1,200}", sid):
        raise Stop("missing_checkout_identifier")
    url = (f"https://chatgpt.com/checkout/{entity}/{sid}"
           if isinstance(entity, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,40}", entity) else None)
    bill = data.get("billing_details")
    bill = bill if isinstance(bill, dict) else {}
    currency, country = bill.get("currency"), bill.get("country")
    currency = currency.upper() if isinstance(currency, str) and re.fullmatch(r"[A-Za-z]{3}", currency) else None
    country = country.upper() if isinstance(country, str) and re.fullmatch(r"[A-Za-z]{2}", country) else None
    amount = data.get("amount_total")
    amount = amount if type(amount) is int and 0 <= amount <= 10**12 else None
    return {"status": "checkout_created", "checkout_identifier": sid, "checkout_link_available": bool(url),
            "processor_entity": entity if url else None,
            "returned_country": country, "returned_currency": currency, "returned_amount_minor": amount,
            "payment_status": "not_attempted", "subscription_status": "not_verified"}, url


def write_json(path: Path, data: dict, *, exclusive=False) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_EXCL if exclusive else os.O_TRUNC)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())


@dataclass(frozen=True)
class BrowserCredential:
    session_token: str = field(repr=False)
    account_id: str = field(repr=False)
    user_id: str = field(repr=False)
    old_token: str = field(default="", repr=False)


def parse_browser_credential(raw: bytes) -> BrowserCredential:
    if len(raw) > MAX_BYTES:
        raise Stop("json_too_large")
    try:
        data = json.loads(raw, object_pairs_hook=unique_object)
        if not isinstance(data, dict):
            raise ValueError()
        tokens = [data[k] for k in ("sessionToken", "session_token") if k in data]
        if not tokens:
            raise Stop("missing_session_token", session_status="new_authorized_json_required")
        if any(not isinstance(t, str) for t in tokens) or len(set(tokens)) != 1:
            raise ValueError()
        session = tokens[0]
        # 仅接受 Cookie 值，拒绝整段 Cookie 头、属性和换行注入。
        if not re.fullmatch(r"[!#$%&'()*+\-./0-9:<=>?@A-Z\[\]^_`a-z{|}~]{1,16384}", session):
            raise ValueError()
        user = data.get("user")
        uid = user.get("id") if isinstance(user, dict) else None
        if not isinstance(uid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", uid):
            raise Stop("missing_target_user_id")
        old = parse_credential(raw, allow_expired=True) if any(k in data for k in ("accessToken", "access_token")) else None
        account = data.get("account")
        aid = old.account_id if old else (account.get("id") if isinstance(account, dict) else None)
        if not isinstance(aid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", aid):
            raise Stop("missing_target_account_id")
        return BrowserCredential(session, aid, uid, old.token if old else "")
    except (ValueError, TypeError, RecursionError):
        raise Stop("invalid_session_json") from None


def session_cookies(credential: BrowserCredential) -> list[dict]:
    name = "__Secure-next-auth.session-token"
    value = credential.session_token
    # Auth.js 的 4096 字节上限减去 160 字节属性预算。
    # 能放入单个 Cookie 的值保留原名称，不能提前改成 .0/.1。
    chunk_size = 4096 - 160
    chunks = [value[i:i + chunk_size] for i in range(0, len(value), chunk_size)]
    return [{"name": name if len(chunks) == 1 else f"{name}.{i}", "value": chunk,
             "url": "https://chatgpt.com/", "httpOnly": True, "secure": True, "sameSite": "Lax"}
            for i, chunk in enumerate(chunks)]


def verify_official_session(data: dict, target: BrowserCredential) -> Credential:
    user = data.get("user")
    if not isinstance(user, dict) or not user.get("id") or not data.get("accessToken"):
        raise Stop("json_session_not_restored", session_status="new_authorized_json_required",
                   official_session_user_present=bool(isinstance(user, dict) and user.get("id")),
                   official_session_access_token_present=bool(data.get("accessToken")))
    if user["id"] != target.user_id:
        raise Stop("official_user_mismatch", account_matched=False)
    refreshed = parse_credential(json.dumps(data).encode())
    if refreshed.account_id != target.account_id:
        raise Stop("official_account_mismatch", account_matched=False)
    return refreshed
