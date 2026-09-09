"""私网单笔执行器。业务标记先由 API 提交 MySQL，再允许官网写请求。"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from urllib.request import Request, build_opener, HTTPRedirectHandler

import attempt_ledger
import browser_checkout
import pay
import payment_state
import payment_network
from checkout_core import Stop, parse_browser_credential, unique_object, write_json
from payment_form import PaymentDetails, validate_details
from payment_recovery import recheck_payment
from plans import PLANS
from plan_selection import safe_diagnostics

MAX_BODY = 96000
TOKEN = os.environ.get("AUTO_RECHARGE_WORKER_TOKEN", "")
API = os.environ.get("AUTO_RECHARGE_CALLBACK_URL", "http://api:3000/api/id-business-v2/auto-recharge/internal")
JOB_ID = re.compile(r"^[a-f0-9-]{36}$")
RECORD_PATH = re.compile(r"^(?:payments/)?[a-f0-9]{64}(?:-pro-(?:5x|20x))?\.json$")
CGROUP_MEMORY_EVENTS = Path("/sys/fs/cgroup/memory.events")
PUBLIC_KEYS = set("status reason stage session_status account_matched current_plan current_tier target_plan checkout_status checkout_identifier quote initial_quote quote_authority subscription_status inspection_only recheck_only payment_status payment_outcome payment_attempted payment_evidence confirmation_requests_sent checkout_requests_sent payment_requests_sent payment_requests_blocked repeated_payment http_status server_code server_param browser_error_code nonce card_last4 checkout_outcome payment_record_write_failed network".split())


class PersistentBrowserRuntime:
    """让 Playwright/Chromium 固定在同一事件循环，只跨任务复用浏览器进程。"""
    def __init__(self, browser_factory=None):
        self.browser_factory = browser_factory
        self.loop = None
        self.thread = None
        self.playwright = None
        self.browser = None
        self.ready = threading.Event()
        self.guard = threading.Lock()
        self.startup_error = None

    @property
    def started(self):
        return bool(self.ready.is_set() and self.startup_error is None
                    and self.thread and self.thread.is_alive() and self.loop)

    async def _new_browser(self):
        if self.browser_factory:
            return await self.browser_factory()
        os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(Path(__file__).parent / ".browsers"))
        for key in ("DEBUG", "PWDEBUG", "PW_TRACE_DIR", "PLAYWRIGHT_TRACE_DIR"):
            os.environ.pop(key, None)
        if self.playwright is None:
            from playwright.async_api import async_playwright
            self.playwright = await async_playwright().start()
        return await self.playwright.chromium.launch(headless=False)

    async def _ensure_browser(self):
        if self.browser is None or not self.browser.is_connected():
            self.browser = await self._new_browser()
        return self.browser

    async def _execute(self, operation):
        browser = await self._ensure_browser()
        try:
            return await operation(browser)
        finally:
            if not browser.is_connected():
                self.browser = None

    async def _discard(self):
        browser, self.browser = self.browser, None
        if browser is not None:
            try:
                await browser.close()
            except Exception:
                pass

    async def _shutdown(self):
        await self._discard()
        playwright, self.playwright = self.playwright, None
        if playwright is not None:
            try:
                await playwright.stop()
            except Exception:
                pass

    def _thread_main(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self.loop = loop
        try:
            loop.run_until_complete(self._ensure_browser())
        except BaseException as exc:
            self.startup_error = exc
            self.ready.set()
            loop.run_until_complete(self._shutdown())
            loop.close()
            return
        self.ready.set()
        try:
            loop.run_forever()
        finally:
            loop.run_until_complete(self._shutdown())
            loop.close()

    def start(self, timeout=60):
        with self.guard:
            if self.started:
                return
            self.ready.clear()
            self.startup_error = None
            self.thread = threading.Thread(target=self._thread_main, name="recharge-browser", daemon=True)
            self.thread.start()
        if not self.ready.wait(timeout) or not self.started:
            raise RuntimeError("persistent_browser_startup_failed") from self.startup_error

    def run(self, operation):
        if not self.started:
            raise RuntimeError("persistent_browser_not_started")
        future = asyncio.run_coroutine_threadsafe(self._execute(operation), self.loop)
        return future.result()

    def discard(self, timeout=30):
        if self.started:
            asyncio.run_coroutine_threadsafe(self._discard(), self.loop).result(timeout)

    def stop(self, timeout=30):
        with self.guard:
            thread, loop = self.thread, self.loop
            if not thread or not loop or not thread.is_alive():
                return
            asyncio.run_coroutine_threadsafe(self._shutdown(), loop).result(timeout)
            loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout)
        self.ready.clear()
        self.thread = None
        self.loop = None


BROWSER_RUNTIME = PersistentBrowserRuntime()


async def quote_checkout(target, plan, root, browser=None):
    """优先读取原单；仅当官网已丢失原编号时，为未付款原单创建一次新报价。"""
    path = attempt_ledger.checkout_record_path(root, target.account_id, plan)
    if not path.exists():
        return await browser_checkout.run_browser(target, create=True, state_dir=root,
                                                  target_plan=plan, browser=browser)
    result = await browser_checkout.run_browser(
        target, inspect_existing=True, state_dir=root, target_plan=plan, browser=browser)
    if (result.get("reason") != "existing_checkout_unavailable"
            or result.get("checkout_requests_sent", 0) != 0
            or result.get("payment_requests_sent", 0) != 0):
        return result
    return await browser_checkout.run_browser(
        target, create=True, replace_unpaid_checkout=True, state_dir=root,
        target_plan=plan, browser=browser)


def public_result(value):
    result = {k: v for k, v in value.items() if k in PUBLIC_KEYS}
    if isinstance(value.get("diagnostics"), dict):
        result["diagnostics"] = safe_diagnostics(value["diagnostics"])
    return result


def read_cgroup_oom_kill(path=CGROUP_MEMORY_EVENTS):
    """读取 cgroup v2 中容器累计 OOM 杀进程次数；不支持时不影响任务。"""
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            name, value = line.split()
            if name == "oom_kill":
                return int(value)
    except (OSError, UnicodeError, ValueError):
        return None
    return None


def apply_browser_memory_result(result, before, after):
    """本任务 OOM 计数增加时优先回传可操作的受控失败。"""
    if before is None or after is None or after <= before:
        return result
    return {
        **result,
        "status": "blocked",
        "reason": "browser_memory_exhausted",
        "checkout_requests_sent": result.get("checkout_requests_sent", 0),
        "payment_requests_sent": result.get("payment_requests_sent", 0),
    }


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def callback(job_id, body):
    request = Request(API + "/" + job_id, data=json.dumps(body).encode(),
                      headers={"Content-Type": "application/json", "X-Recharge-Worker": TOKEN}, method="POST")
    try:
        with build_opener(NoRedirect).open(request, timeout=8) as response:
            result = json.loads(response.read(MAX_BODY), object_pairs_hook=unique_object)
        if result.get("success") is not True:
            raise ValueError()
        return result["data"]
    except Exception:
        # 不打印携带业务数据的 HTTP 异常正文。
        raise Stop("durable_state_unavailable") from None


class Job:
    def __init__(self, job_id, payload):
        self.id, self.payload = job_id, payload
        self.root = None
        self.account_key = None
        self.revisions = {}
        self.nonce = None
        self.confirmed = False
        self.confirm_event = threading.Event()
        self.details_event = threading.Event()
        self.pending_details = None
        self.waiting_details = False
        self.waiting_confirmation = False
        self.details_received = False
        self.cancelled = False
        self.done = False

    def persist(self, path, document):
        name = str(path.relative_to(self.root))
        if not RECORD_PATH.fullmatch(name):
            raise Stop("unsupported_state_record")
        result = callback(self.id, {"type": "ledger", "accountKey": self.account_key,
                                   "fileKey": name, "revision": self.revisions.get(name, 0),
                                   "document": document})
        self.revisions[name] = result["revision"]

    def progress(self, stage, **details):
        if self.cancelled:
            raise Stop("operation_cancelled")
        callback(self.id, {"type": "progress", "result": public_result({"stage": stage, **details})})

    def confirm(self, quote, last4):
        material = "|".join((
            "auto-recharge-confirm-v1", self.id, quote["plan"],
            self._money_material(quote.get("today")), self._money_material(quote.get("tax")),
            self._money_material(quote.get("renewal")), quote.get("renewal_interval") or "-"))
        self.nonce = hmac.new(TOKEN.encode(), material.encode(), hashlib.sha256).hexdigest()
        self.waiting_confirmation = True
        callback(self.id, {"type": "confirmation", "result": {
            "status": "awaiting_confirmation", "stage": "payment_ready", "quote": quote,
            "quote_authority": "official_checkout_response",
            "nonce": self.nonce, "card_last4": last4}})
        self.confirm_event.wait(300)
        self.waiting_confirmation = False
        return self.confirmed and not self.cancelled

    @staticmethod
    def _money_material(value):
        return (f"{value['currency']}:{value['amount_minor']}:{value['amount']}"
                if isinstance(value, dict) else "-")

    def signal(self, nonce=None, cancel=False):
        if cancel:
            self.cancelled = True
            self.details_event.set()
            self.confirm_event.set()
            return
        if self.nonce is None or not isinstance(nonce, str) or not hmac.compare_digest(self.nonce, nonce):
            raise Stop("confirmation_mismatch")
        if self.confirm_event.is_set():
            raise Stop("confirmation_already_consumed")
        self.confirmed = True
        self.confirm_event.set()

    def submit_details(self, value):
        if self.details_received or self.details_event.is_set() or not self.waiting_details:
            raise Stop("payment_details_already_consumed")
        self.pending_details = value
        self.details_received = True
        self.details_event.set()

    def details(self, initial_quote):
        self.waiting_details = True
        callback(self.id, {"type": "details_required", "result": {
            "status": "awaiting_details", "stage": "details_required",
            "initial_quote": initial_quote, "payment_requests_sent": 0}})
        self.details_event.wait(600)
        self.waiting_details = False
        if self.cancelled:
            raise Stop("operation_cancelled")
        if not self.details_received or not isinstance(self.pending_details, dict):
            raise Stop("payment_details_expired")
        value = self.pending_details.pop("details", {})
        try:
            if not isinstance(value, dict):
                raise Stop("invalid_payment_details")
            return validate_details(PaymentDetails(**value))
        except (TypeError, ValueError):
            raise Stop("invalid_payment_details") from None
        finally:
            if isinstance(value, dict):
                value.clear()
            self.pending_details.clear()
            self.pending_details = None

    async def execute(self, browser=None):
        raw = self.payload.pop("sessionJson", "")
        try:
            target = parse_browser_credential(raw.encode())
        finally:
            raw = None
        self.account_key = hashlib.sha256(target.account_id.encode()).hexdigest()
        initial = callback(self.id, {"type": "restore", "accountKey": self.account_key})
        for record in initial["records"]:
            name = record["fileKey"]
            if not RECORD_PATH.fullmatch(name):
                raise Stop("invalid_checkout_record")
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            write_json(path, record["document"], exclusive=True)
            self.revisions[name] = record["revision"]
        plan, action = self.payload["plan"], self.payload["action"]
        if action == "check":
            return await browser_checkout.run_browser(target, state_dir=self.root,
                                                      target_plan=plan, browser=browser)
        if action == "quote":
            return await quote_checkout(target, plan, self.root, browser=browser)
        if action == "flow":
            return await pay.run_flow(target, self.root, plan, details_reader=self.details,
                                      confirmer=self.confirm, wait_seconds=120, browser=browser)
        with payment_state.PaymentLedger(self.root, target.account_id, target_plan=plan) as ledger:
            if action == "recheck":
                if not ledger.record:
                    raise Stop("no_original_payment_attempt")
                result = await recheck_payment(target, ledger, browser=browser)
            else:
                result = await pay.run_payment(target, ledger, pay=True, details_reader=self.details,
                                               confirmer=self.confirm, wait_seconds=120, browser=browser)
            return pay.include_payment_record(result, ledger)

    def run(self):
        # 硬超时终止本执行器，MySQL 的原单标记保留；不会重发任务。
        oom_kills_before = read_cgroup_oom_kill()
        watchdog = threading.Timer(900, lambda: os._exit(70))
        watchdog.daemon = True
        watchdog.start()
        original_atomic = attempt_ledger.atomic_json
        original_progress = browser_checkout.progress
        def durable(path, document):
            try:
                self.persist(path, document)
            except Stop:
                raise OSError("durable_state_unavailable") from None
            original_atomic(path, document)
        try:
            with tempfile.TemporaryDirectory(prefix="recharge-") as folder:
                self.root = Path(folder)
                attempt_ledger.atomic_json = payment_state.atomic_json = durable
                browser_checkout.progress = pay.progress = payment_network.progress = self.progress
                if BROWSER_RUNTIME.started:
                    result = BROWSER_RUNTIME.run(lambda browser: self.execute(browser=browser))
                else:
                    # 独立单测与本地导入保留原调用方式；生产入口会预热常驻运行时。
                    result = asyncio.run(self.execute())
        except Stop as exc:
            result = exc.report
        except Exception:
            result = {"status": "blocked", "reason": "worker_operation_failed"}
        finally:
            attempt_ledger.atomic_json = payment_state.atomic_json = original_atomic
            browser_checkout.progress = pay.progress = payment_network.progress = original_progress
            self.payload.clear()
            if self.pending_details:
                details = self.pending_details.get("details")
                if isinstance(details, dict):
                    details.clear()
                self.pending_details.clear()
                self.pending_details = None
            self.nonce = None
            self.done = True
            watchdog.cancel()
        oom_kills_after = read_cgroup_oom_kill()
        if (BROWSER_RUNTIME.started and oom_kills_before is not None and oom_kills_after is not None
                and oom_kills_after > oom_kills_before):
            BROWSER_RUNTIME.discard()
        result = apply_browser_memory_result(result, oom_kills_before, oom_kills_after)
        try:
            callback(self.id, {"type": "finished", "result": public_result(result)})
        except Stop:
            pass  # API 保留未核验任务；绝不因回传失败重复执行。


class Handler(BaseHTTPRequestHandler):
    job = None
    lock = threading.Lock()

    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(8)

    def reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True, "busy": bool(self.job and not self.job.done)})
            return
        if not TOKEN or not hmac.compare_digest(self.headers.get("X-Recharge-Worker", ""), TOKEN):
            self.reply(403, {"ok": False})
            return
        parts = self.path.strip("/").split("/")
        if (len(parts) != 3 or parts[0] != "jobs" or parts[2] != "status"
                or not JOB_ID.fullmatch(parts[1]) or not self.job or self.job.id != parts[1]):
            self.reply(404, {"ok": False})
            return
        self.reply(200, {"ok": True, "accepted": True, "details_received": self.job.details_received,
                         "confirmation_received": self.job.confirmed,
                         "cancelled": self.job.cancelled, "done": self.job.done})

    def do_POST(self):
        if not TOKEN or not hmac.compare_digest(self.headers.get("X-Recharge-Worker", ""), TOKEN):
            self.reply(403, {"ok": False})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                raise ValueError()
            body = json.loads(self.rfile.read(length), object_pairs_hook=unique_object)
            parts = self.path.strip("/").split("/")
            if len(parts) < 2 or parts[0] != "jobs" or not JOB_ID.fullmatch(parts[1]):
                raise ValueError()
            with self.lock:
                if len(parts) == 2:
                    if self.job and not self.job.done:
                        self.reply(409, {"ok": False})
                        return
                    if body.get("plan") not in PLANS or body.get("action") not in {"check", "quote", "prepare", "recheck", "flow"}:
                        raise ValueError()
                    Handler.job = Job(parts[1], body)
                    threading.Thread(target=Handler.job.run, daemon=True).start()
                elif len(parts) == 3 and parts[2] in {"details", "confirm", "cancel"}:
                    if not self.job or self.job.id != parts[1] or self.job.done:
                        raise ValueError()
                    if parts[2] == "details":
                        self.job.submit_details(body)
                    else:
                        self.job.signal(nonce=body.get("nonce"), cancel=parts[2] == "cancel")
                else:
                    raise ValueError()
            self.reply(202, {"ok": True})
        except Exception:
            self.reply(400, {"ok": False})


if __name__ == "__main__":
    if len(TOKEN) < 32:
        raise SystemExit("执行器凭据未配置")
    try:
        BROWSER_RUNTIME.start()
        ThreadingHTTPServer(("0.0.0.0", 8051), Handler).serve_forever()
    finally:
        BROWSER_RUNTIME.stop()
