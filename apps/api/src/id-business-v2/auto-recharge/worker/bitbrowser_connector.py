"""本机比特浏览器连接器。

只监听 127.0.0.1；JSON 登录凭据和银行卡资料只在当前进程内存中使用，不写文件、日志或 API 数据库。
"""
from __future__ import annotations

import argparse
import asyncio
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile
import threading
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

import attempt_ledger
import browser_checkout
import pay
import payment_network
import payment_recovery
import payment_state
from checkout_core import Stop, parse_browser_credential, unique_object, write_json
from payment_form import PaymentDetails, validate_details
from plans import PLANS

MAX_BODY = 180_000
JOB_ID_TEXT = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
JOB_ID = re.compile(r"^" + JOB_ID_TEXT + r"$")
PROFILE_ID = re.compile(r"^[A-Za-z0-9_-]{8,100}$")
CALLBACK_PATH = re.compile(r"/api/id-business-v2/auto-recharge/local/" + JOB_ID_TEXT + r"$")
SUPPORTED_CURRENCIES = set(
    "USD MYR PHP EUR GBP AUD CAD JPY KRW SGD INR IDR THB VND TWD HKD BRL MXN "
    "AED SAR ZAR NZD CHF SEK NOK DKK PLN TRY".split())
ZERO_DECIMAL_CURRENCIES = {"JPY", "KRW", "VND"}
SAFE_PUBLIC_KEYS = set(
    "status reason stage session_status account_matched current_plan current_tier target_plan "
    "checkout_status checkout_identifier subscription_status payment_status payment_outcome "
    "payment_attempted payment_evidence confirmation_requests_sent checkout_requests_sent "
    "payment_requests_sent payment_requests_blocked repeated_payment http_status browser_error_code "
    "card_last4 checkout_outcome payment_record_write_failed network quote initial_quote "
    "quote_authority browser_profile_id locked_currency max_amount user_action_required "
    "recheck_only".split()
)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def local_origin(value, label):
    parsed = urlsplit(str(value))
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}
            or not parsed.port or parsed.username or parsed.password
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise Stop("invalid_local_connector_configuration", stage=label)
    return f"http://{parsed.hostname}:{parsed.port}"


def callback_url(value, job_id):
    parsed = urlsplit(str(value))
    local_http = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}
    if ((parsed.scheme != "https" and not local_http) or parsed.username or parsed.password
            or parsed.query or parsed.fragment or not CALLBACK_PATH.fullmatch(parsed.path)
            or not parsed.path.endswith("/" + job_id)):
        raise Stop("invalid_callback_url")
    return value


def public_result(value):
    return {key: item for key, item in value.items() if key in SAFE_PUBLIC_KEYS}


class CallbackClient:
    def __init__(self, url, token, job_id):
        self.url = callback_url(url, job_id)
        self.token = token

    def send(self, body):
        request = Request(
            self.url,
            data=json.dumps(body, separators=(",", ":")).encode(),
            headers={"Content-Type": "application/json", "X-Recharge-Local": self.token},
            method="POST",
        )
        try:
            with build_opener(NoRedirect).open(request, timeout=10) as response:
                result = json.loads(response.read(MAX_BODY), object_pairs_hook=unique_object)
            if result.get("success") is not True or not isinstance(result.get("data"), dict):
                raise ValueError()
            return result["data"]
        except Exception:
            raise Stop("durable_state_unavailable") from None


class BitBrowserClient:
    def __init__(self, base_url, token):
        self.base_url = local_origin(base_url, "bitbrowser_local_api")
        if not isinstance(token, str) or len(token) < 16 or "\n" in token or "\r" in token:
            raise Stop("bitbrowser_api_token_invalid")
        self.token = token

    def post(self, path, body):
        request = Request(
            self.base_url + path,
            data=json.dumps(body, separators=(",", ":")).encode(),
            headers={"Content-Type": "application/json", "x-api-key": self.token},
            method="POST",
        )
        try:
            with build_opener(NoRedirect).open(request, timeout=30) as response:
                result = json.loads(response.read(MAX_BODY), object_pairs_hook=unique_object)
        except Exception:
            raise Stop("bitbrowser_local_api_unavailable", stage=path.strip("/").replace("/", "_")) from None
        if result.get("success") is not True or not isinstance(result.get("data", {}), (dict, list)):
            raise Stop("bitbrowser_local_api_rejected", stage=path.strip("/").replace("/", "_"))
        return result.get("data") or {}

    def ensure_group(self, name):
        data = self.post("/group/list", {"page": 0, "pageSize": 100, "all": True})
        rows = data if isinstance(data, list) else data.get("list", [])
        matches = [row for row in rows if isinstance(row, dict) and row.get("groupName") == name]
        if len(matches) > 1:
            raise Stop("bitbrowser_group_ambiguous")
        if matches:
            group_id = matches[0].get("id")
        else:
            created = self.post("/group/add", {"groupName": name, "sortNum": 0})
            group_id = created.get("id") if isinstance(created, dict) else None
        if not isinstance(group_id, str) or not PROFILE_ID.fullmatch(group_id):
            raise Stop("bitbrowser_group_unverified")
        return group_id

    def create_profile(self, settings, window_name):
        group_id = self.ensure_group(settings["groupName"])
        data = self.post("/browser/update", {
            "groupId": group_id,
            "platform": "https://chatgpt.com",
            "platformIcon": "chatgpt.com",
            "url": "https://chatgpt.com",
            "name": window_name,
            "remark": settings["tagName"],
            "userName": "",
            "password": "",
            "cookie": "",
            "proxyMethod": 3,
            "proxyType": settings["proxyType"],
            "dynamicIpUrl": settings["dynamicProxyUrl"],
            "dynamicIpChannel": "common",
            "isDynamicIpChangeIp": True,
            "ipCheckService": "ip-api",
            "isValidUsername": False,
            "syncTabs": True,
            "syncCookies": True,
            "syncLocalStorage": True,
            "credentialsEnableService": False,
            "browserFingerPrint": {
                "ostype": "PC",
                "os": "MacIntel",
                "isIpCreateTimeZone": True,
                "isIpCreatePosition": True,
                "isIpCreateLanguage": False,
                "languages": "zh-CN",
                "isIpCreateDisplayLanguage": False,
                "displayLanguages": "zh-CN",
            },
        })
        profile_id = data.get("id") if isinstance(data, dict) else None
        if not isinstance(profile_id, str) or not PROFILE_ID.fullmatch(profile_id):
            raise Stop("bitbrowser_profile_unverified")
        return profile_id

    def open_profile(self, profile_id):
        data = self.post("/browser/open", {"id": profile_id, "queue": True})
        endpoint = (data.get("ws") or data.get("http")) if isinstance(data, dict) else None
        if not isinstance(endpoint, str) or not endpoint.startswith(("ws://", "http://")):
            raise Stop("bitbrowser_debug_endpoint_missing")
        return endpoint


def validate_payload(value):
    if not isinstance(value, dict):
        raise Stop("invalid_connector_payload")
    mode = value.get("mode")
    common = {"id", "mode", "plan", "windowName", "sessionJson", "bitBrowser",
              "callbackUrl", "agentToken"}
    allowed = (common | {"details", "address", "safety", "authorizeSinglePayment"}
               if mode == "payment" else common if mode == "recheck" else set())
    if set(value) != allowed:
        raise Stop("invalid_connector_payload")
    job_id = value.get("id")
    if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
        raise Stop("invalid_connector_job")
    if value.get("plan") not in PLANS:
        raise Stop("invalid_connector_payload")
    window_name = value.get("windowName")
    if (not isinstance(window_name, str) or not window_name.strip() or len(window_name.strip()) > 80
            or re.search(r"[\x00-\x1f\x7f]", window_name)):
        raise Stop("invalid_browser_window_name")
    for key in ("sessionJson", "callbackUrl", "agentToken"):
        if not isinstance(value.get(key), str) or not value[key]:
            raise Stop("invalid_connector_payload")
    if len(value["sessionJson"].encode()) > 65_000 or len(value["agentToken"]) != 64:
        raise Stop("invalid_connector_payload")
    bit_browser = value.get("bitBrowser")
    if not isinstance(bit_browser, dict):
        raise Stop("invalid_connector_payload")
    if set(bit_browser) != {
            "localApiUrl", "localApiToken", "groupName", "tagName", "proxyType",
            "dynamicProxyUrl"}:
        raise Stop("invalid_bitbrowser_configuration")
    required_bit = ("localApiUrl", "localApiToken", "groupName", "tagName", "proxyType", "dynamicProxyUrl")
    if any(not isinstance(bit_browser.get(key), str) or not bit_browser[key] for key in required_bit):
        raise Stop("invalid_bitbrowser_configuration")
    if bit_browser["proxyType"] not in {"http", "https", "socks5"}:
        raise Stop("invalid_bitbrowser_configuration")
    if mode == "recheck":
        return value

    if value.get("authorizeSinglePayment") is not True:
        raise Stop("invalid_payment_authorization")
    details, address, safety = value.get("details"), value.get("address"), value.get("safety")
    if not all(isinstance(item, dict) for item in (details, address, safety)):
        raise Stop("invalid_connector_payload")
    if set(details) != {"number", "expiry", "cvc", "name", "email"}:
        raise Stop("invalid_payment_details")
    if set(address) != {"id", "line1", "country", "city", "state", "postalCode"}:
        raise Stop("invalid_connector_payload")
    if set(safety) != {
            "lockedCurrency", "maxAmount", "maxAmountMinor", "authorizeSinglePayment"}:
        raise Stop("invalid_payment_authorization")
    if address.get("country") != "US" or address.get("city") != "Portland" \
            or address.get("state") != "OR" or address.get("postalCode") != "97204":
        raise Stop("billing_address_location_mismatch")
    if safety.get("authorizeSinglePayment") is not True:
        raise Stop("invalid_payment_authorization")
    if not isinstance(safety.get("maxAmountMinor"), int) or safety["maxAmountMinor"] <= 0:
        raise Stop("invalid_payment_limit")
    currency = safety.get("lockedCurrency")
    if not isinstance(currency, str) or currency not in SUPPORTED_CURRENCIES:
        raise Stop("invalid_locked_currency")
    places = 0 if currency in ZERO_DECIMAL_CURRENCIES else 2
    maximum = safety.get("maxAmount")
    pattern = r"\d{1,9}" if places == 0 else r"\d{1,9}\.\d{2}"
    if not isinstance(maximum, str) or not re.fullmatch(pattern, maximum):
        raise Stop("invalid_payment_limit")
    if int(Decimal(maximum) * (10 ** places)) != safety["maxAmountMinor"]:
        raise Stop("invalid_payment_limit")
    candidate = {
        **details,
        "country": address["country"],
        "line1": address["line1"],
        "line2": "",
        "city": address["city"],
        "state": address["state"],
        "postal_code": address["postalCode"],
    }
    try:
        validate_details(PaymentDetails(**candidate))
    except (TypeError, ValueError):
        raise Stop("invalid_payment_details") from None
    finally:
        for key in candidate:
            candidate[key] = ""
    return value


class LocalJob:
    def __init__(self, payload):
        self.payload = validate_payload(payload)
        self.id = self.payload["id"]
        self.callback = CallbackClient(
            self.payload["callbackUrl"], self.payload["agentToken"], self.id)
        self.resume_event = threading.Event()
        self.cancelled = False
        self.done = False
        self.account_key = None
        self.root = None
        self.revisions = {}
        self.context = None
        self.profile_id = None
        self.payment_request_sent = False
        self.waiting_for_user = False

    def signal_resume(self):
        self.resume_event.set()

    def signal_cancel(self):
        self.cancelled = True
        self.resume_event.set()

    def progress(self, stage, **details):
        if self.cancelled:
            raise Stop("operation_cancelled")
        if stage == "payment_request_sending":
            self.payment_request_sent = True
        self.callback.send({"type": "progress", "result": public_result({
            "status": "running",
            "stage": stage,
            "browser_profile_id": self.profile_id,
            "payment_attempted": self.payment_request_sent,
            "payment_requests_sent": 1 if self.payment_request_sent else 0,
            **details,
        })})

    async def wait_for_user(self, reason, seconds):
        if self.context and self.context.pages:
            await self.context.pages[-1].bring_to_front()
        self.resume_event.clear()
        self.waiting_for_user = True
        try:
            self.callback.send({"type": "progress", "result": {
                "status": "awaiting_human_verification",
                "stage": reason,
                "reason": reason,
                "browser_profile_id": self.profile_id,
                "user_action_required": True,
                "payment_attempted": self.payment_request_sent,
                "payment_requests_sent": 1 if self.payment_request_sent else 0,
            }})
            completed = await asyncio.to_thread(
                self.resume_event.wait, min(max(seconds, 1), 1800))
        finally:
            self.waiting_for_user = False
        if self.cancelled:
            raise Stop("operation_cancelled")
        if not completed:
            raise Stop(reason, user_action_required=True, wait_expired=True)

    def persist(self, path, document):
        name = str(path.relative_to(self.root))
        if not re.fullmatch(r"(?:payments/)?[a-f0-9]{64}(?:-pro-(?:5x|20x))?\.json", name):
            raise Stop("unsupported_state_record")
        result = self.callback.send({
            "type": "ledger", "accountKey": self.account_key, "fileKey": name,
            "revision": self.revisions.get(name, 0), "document": document,
        })
        self.revisions[name] = result["revision"]

    def details(self, _initial_quote):
        data = self.payload.get("details", {})
        address = self.payload["address"]
        merged = {
            **data,
            "country": address["country"],
            "line1": address["line1"],
            "line2": "",
            "city": address["city"],
            "state": address["state"],
            "postal_code": address["postalCode"],
        }
        try:
            return validate_details(PaymentDetails(**merged))
        except (TypeError, ValueError):
            raise Stop("invalid_payment_details") from None
        finally:
            for key in merged:
                merged[key] = ""

    def confirm(self, quote, _last4):
        safety = self.payload["safety"]
        try:
            payment_state.quote_digest(quote)
        except Stop:
            raise Stop("payment_quote_incomplete") from None
        today, tax, renewal = quote.get("today"), quote.get("tax"), quote.get("renewal")
        if quote.get("plan") != self.payload["plan"] or not all(
                isinstance(item, dict) for item in (today, tax, renewal)):
            raise Stop("payment_quote_incomplete")
        currencies = {today.get("currency"), tax.get("currency"), renewal.get("currency")}
        if currencies != {safety["lockedCurrency"]}:
            raise Stop("payment_currency_mismatch", locked_currency=safety["lockedCurrency"])
        if not isinstance(today.get("amount_minor"), int) or today["amount_minor"] <= 0:
            raise Stop("payment_quote_incomplete")
        if today["amount_minor"] > safety["maxAmountMinor"]:
            raise Stop("payment_amount_over_limit", locked_currency=safety["lockedCurrency"],
                       max_amount=safety["maxAmount"])
        try:
            if Decimal(today["amount"]) <= 0 or Decimal(tax["amount"]) < 0 \
                    or Decimal(renewal["amount"]) <= 0:
                raise InvalidOperation()
        except (InvalidOperation, KeyError, TypeError):
            raise Stop("payment_quote_incomplete") from None
        self.progress("payment_guard_passed", quote=quote, quote_authority="official_checkout_response")
        return True

    async def execute(self):
        raw = self.payload.pop("sessionJson")
        try:
            target = parse_browser_credential(raw.encode())
        finally:
            raw = None
        import hashlib
        self.account_key = hashlib.sha256(target.account_id.encode()).hexdigest()
        initial = self.callback.send({"type": "restore", "accountKey": self.account_key})
        for record in initial["records"]:
            path = self.root / record["fileKey"]
            path.parent.mkdir(parents=True, exist_ok=True)
            write_json(path, record["document"], exclusive=True)
            self.revisions[record["fileKey"]] = record["revision"]

        bit = self.payload["bitBrowser"]
        client = BitBrowserClient(bit["localApiUrl"], bit["localApiToken"])
        self.progress("bitbrowser_group")
        self.profile_id = await asyncio.to_thread(
            client.create_profile, bit, self.payload["windowName"].strip())
        self.progress("bitbrowser_profile_created", browser_profile_id=self.profile_id)
        endpoint = await asyncio.to_thread(client.open_profile, self.profile_id)
        self.progress("bitbrowser_profile_opened", browser_profile_id=self.profile_id)

        from playwright.async_api import async_playwright
        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(endpoint)
            if not browser.contexts:
                raise Stop("bitbrowser_context_missing")
            self.context = browser.contexts[0]
            if self.payload["mode"] == "recheck":
                with payment_state.PaymentLedger(
                        self.root, target.account_id, target_plan=self.payload["plan"]) as ledger:
                    result = await payment_recovery.recheck_in_context(
                        self.context, target, ledger, timeout=25, poll_count=6, poll_interval=20)
                    return pay.include_payment_record(result, ledger)
            return await pay.run_flow(
                target, self.root, self.payload["plan"], details_reader=self.details,
                confirmer=self.confirm, wait_seconds=1800, poll_count=6, poll_interval=20,
                browser_context=self.context)

    def run(self):
        original_atomic = attempt_ledger.atomic_json
        original_progress = browser_checkout.progress
        original_recovery_progress = payment_recovery.progress
        original_wait = browser_checkout.wait_for_user
        original_callback_url = os.environ.get("AUTO_RECHARGE_CALLBACK_URL")
        try:
            # 启用原有 Worker 的严格出口检测与网络白名单；不向该值发送请求。
            os.environ["AUTO_RECHARGE_CALLBACK_URL"] = "local-bitbrowser"
            with tempfile.TemporaryDirectory(prefix="bitbrowser-recharge-") as folder:
                self.root = Path(folder)

                def durable(path, document):
                    self.persist(path, document)
                    original_atomic(path, document)

                attempt_ledger.atomic_json = payment_state.atomic_json = durable
                browser_checkout.progress = pay.progress = payment_network.progress = self.progress
                payment_recovery.progress = self.progress
                browser_checkout.wait_for_user = self.wait_for_user
                result = asyncio.run(self.execute())
        except Stop as exc:
            result = exc.report
        except Exception as exc:
            result = {"status": "blocked", "reason": "local_browser_operation_failed",
                      "error_type": type(exc).__name__,
                      "payment_attempted": self.payment_request_sent,
                      "payment_status": "unknown" if self.payment_request_sent else "not_attempted",
                      "payment_requests_sent": 1 if self.payment_request_sent else 0}
        finally:
            attempt_ledger.atomic_json = payment_state.atomic_json = original_atomic
            browser_checkout.progress = pay.progress = payment_network.progress = original_progress
            payment_recovery.progress = original_recovery_progress
            browser_checkout.wait_for_user = original_wait
            if original_callback_url is None:
                os.environ.pop("AUTO_RECHARGE_CALLBACK_URL", None)
            else:
                os.environ["AUTO_RECHARGE_CALLBACK_URL"] = original_callback_url
            details = self.payload.get("details")
            if isinstance(details, dict):
                details.clear()
            for key in ("agentToken", "callbackUrl"):
                self.payload.pop(key, None)
            bit = self.payload.get("bitBrowser")
            if isinstance(bit, dict):
                bit.pop("localApiToken", None)
                bit.pop("dynamicProxyUrl", None)
            self.done = True
        result.setdefault("payment_attempted", self.payment_request_sent)
        result.setdefault("payment_requests_sent", 1 if self.payment_request_sent else 0)
        if self.payment_request_sent:
            result.setdefault("payment_status", "unknown")
        result = {
            **result,
            "browser_profile_id": self.profile_id,
            "locked_currency": self.payload.get("safety", {}).get("lockedCurrency"),
            "max_amount": self.payload.get("safety", {}).get("maxAmount"),
        }
        try:
            self.callback.send({"type": "finished", "result": public_result(result)})
        except Stop:
            pass
        finally:
            self.callback.token = ""


class Registry:
    def __init__(self):
        self.lock = threading.Lock()
        self.jobs = {}

    def start(self, payload):
        with self.lock:
            job_id = payload.get("id") if isinstance(payload, dict) else None
            if job_id in self.jobs:
                return self.jobs[job_id]
            if any(not job.done for job in self.jobs.values()):
                raise Stop("another_local_job_is_running")
            job = LocalJob(payload)
            self.jobs[job.id] = job
            threading.Thread(target=job.run, name=f"bitbrowser-{job.id[:8]}", daemon=True).start()
            return job

    def get(self, job_id):
        with self.lock:
            return self.jobs.get(job_id)


REGISTRY = Registry()


class Handler(BaseHTTPRequestHandler):
    allowed_origins = set()
    connector_token = ""

    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def allowed_origin(self):
        origin = self.headers.get("Origin")
        return origin if origin in self.allowed_origins else None

    def authorized(self):
        token = self.headers.get("X-Auto-Recharge-Connector", "")
        return len(token) == len(self.connector_token) and secrets.compare_digest(token, self.connector_token)

    def reply(self, status, value):
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        origin = self.allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        if not self.allowed_origin():
            return self.reply(403, {"ok": False})
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.allowed_origin())
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Auto-Recharge-Connector")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True, "version": 1,
                                    "busy": any(not job.done for job in REGISTRY.jobs.values())})
        match = re.fullmatch(r"/jobs/(" + JOB_ID_TEXT + r")", self.path)
        if not match or not self.authorized():
            return self.reply(404, {"ok": False})
        job = REGISTRY.get(match.group(1))
        return self.reply(200 if job else 404, {
            "ok": bool(job),
            "done": job.done if job else None,
            "waitingForUser": job.waiting_for_user if job else None,
        })

    def do_POST(self):
        if not self.allowed_origin() or not self.authorized():
            return self.reply(403, {"ok": False})
        length = self.headers.get("Content-Length", "")
        if not length.isdigit() or int(length) > MAX_BODY:
            return self.reply(413, {"ok": False})
        try:
            body = json.loads(self.rfile.read(int(length)), object_pairs_hook=unique_object)
            if self.path == "/jobs":
                job = REGISTRY.start(body)
                return self.reply(202, {"ok": True, "id": job.id, "accepted": True})
            match = re.fullmatch(r"/jobs/(" + JOB_ID_TEXT + r")/(resume|cancel)", self.path)
            if not match:
                return self.reply(404, {"ok": False})
            job = REGISTRY.get(match.group(1))
            if not job:
                return self.reply(404, {"ok": False})
            job.signal_resume() if match.group(2) == "resume" else job.signal_cancel()
            return self.reply(200, {"ok": True})
        except Stop as exc:
            return self.reply(409, {"ok": False, "reason": exc.report.get("reason")})
        except Exception:
            return self.reply(400, {"ok": False})


def load_connector_token(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists():
        if stat.S_IMODE(path.stat().st_mode) & 0o077:
            path.chmod(0o600)
        value = path.read_text(encoding="utf-8").strip()
        if len(value) >= 32:
            return value
    value = secrets.token_urlsafe(32)
    path.write_text(value, encoding="utf-8")
    path.chmod(0o600)
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description="ID 业务管理系统本机比特浏览器连接器")
    parser.add_argument("--port", type=int, default=55321)
    parser.add_argument("--allowed-origin", action="append", required=True)
    parser.add_argument("--token-file", default=".runtime/auto-recharge-connector/connector.token")
    args = parser.parse_args(argv)
    if args.port < 1024 or args.port > 65535:
        parser.error("端口必须介于 1024 与 65535")
    origins = set()
    for value in args.allowed_origin:
        parsed = urlsplit(value)
        if (parsed.scheme not in {"http", "https"} or not parsed.netloc
                or parsed.username or parsed.password or parsed.path not in {"", "/"}
                or parsed.query or parsed.fragment):
            parser.error("允许来源必须是网站 origin")
        origins.add(f"{parsed.scheme}://{parsed.netloc}")
    Handler.allowed_origins = origins
    Handler.connector_token = load_connector_token(Path(args.token_file).resolve())
    print("本机连接器已启动：http://127.0.0.1:%d" % args.port, flush=True)
    print("本机连接密钥（仅在网站设置中保存）：" + Handler.connector_token, flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
