"""普通可见 Chromium：恢复授权会话、通过官网建单，始终阻止付款。"""
from __future__ import annotations

import asyncio
from contextlib import nullcontext
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import re
import select
import sys
import time
from urllib.parse import urlsplit

from attempt_ledger import AttemptLedger, existing_checkout
from checkout_core import (ACCOUNT_PATH, CHECKOUT_PATH, MAX_BYTES, ROOT, BrowserCredential,
                           Stop, account_plan, checkout_result, parse_credential, response_json,
                           safe_text, session_cookies, verify_official_session)
from plans import PLANS, checkout_text_plan, plan_spec, text_tiers

ORIGIN = "https://chatgpt.com"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CURRENCIES = {"USD": 2, "MYR": 2, "PHP": 2, "EUR": 2, "GBP": 2, "AUD": 2, "CAD": 2,
              "JPY": 0, "KRW": 0, "SGD": 2, "INR": 2, "IDR": 2, "THB": 2, "VND": 0,
              "TWD": 2, "HKD": 2, "BRL": 2, "MXN": 2, "AED": 2, "SAR": 2, "ZAR": 2,
              "NZD": 2, "CHF": 2, "SEK": 2, "NOK": 2, "DKK": 2, "PLN": 2, "TRY": 2}


def progress(stage, **details):
    print(json.dumps({"event": stage, **details}, ensure_ascii=False), file=sys.stderr, flush=True)


def money(text: str, currency_hint=None):
    """仅识别明确币种和无歧义小数格式；不把 $ 或参考价当实际报价。"""
    if re.search(r"[-−]\s*\d", text):
        return None
    codes = set(re.findall(r"\b(" + "|".join(CURRENCIES) + r")\b", text.upper()))
    if "₱" in text:
        codes.add("PHP")
    if re.search(r"\bRM\s*\d", text):
        codes.add("MYR")
    if currency_hint:
        codes.add(currency_hint)
    if len(codes) != 1 or not codes.issubset(CURRENCIES):
        return None
    currency = codes.pop()
    numbers = re.findall(r"(?<![\w.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w.])", text)
    if len(numbers) != 1:
        return None
    value = numbers[0]
    # 小数逗号、混合币种、百分比和日期均不猜测。
    if re.search(r"\d,\d{1,2}(?!\d)", text) or "%" in text:
        return None
    try:
        amount = Decimal(value.replace(",", ""))
        if not amount.is_finite() or amount < 0 or amount > Decimal("1000000000"):
            return None
        places = CURRENCIES[currency]
        if amount.as_tuple().exponent < -places:
            return None
        return {"currency": currency, "amount": f"{amount:.{places}f}",
                "amount_minor": int(amount * (10 ** places))}
    except InvalidOperation:
        return None


def quote_from_text(text: str, currency_hint=None):
    lines = [x.strip() for x in text.splitlines() if x.strip()]
    labels = {"today": r"^(?:Total due today|Due today|Total today|Amount due today|今日应付(?:金额)?|今日應付(?:金額)?|今天应付|今日總計|今日总计|今天支付|今天應付)(?:\s|$|:|：)",
              "tax": r"^(?:Tax|Taxes|Estimated tax|预估税费|預估稅費|税费|税金|稅金)(?:\s|$|:|：)",
              "renewal": r"^(?:Then|Renews|Renewal|续费|續費)(?:\s|$|:|：)"}
    fields = {}
    for kind, pattern in labels.items():
        matches = []
        # 同一报价字段存在多种值时拒绝自动判定。
        for i, line in enumerate(lines):
            if re.search(pattern, line, re.I):
                found = money(line, currency_hint)
                if found is None and i + 1 < len(lines):
                    # 不跨越“未知/小计/税费”等下一字段，把别的金额误作今日应付。
                    value_line = lines[i + 1]
                    if re.fullmatch(r"(?:[A-Z]{3}|RM|₱|\$|€|£)?\s*[0-9,.]+(?:\s*[A-Z]{3})?", value_line):
                        found = money(value_line, currency_hint)
                if found:
                    matches.append(found)
        if kind == "renewal":
            # 官网中文结算条款：将按 MYR 92.50/月 收费。只取明确的续费句，
            # 不把产品列表价或今日金额复制为续费金额。
            for value in re.findall(r"将按\s+([^。\n]+?)/\s*(?:月|年)\s*收费", text):
                found = money(value, currency_hint)
                if found:
                    matches.append(found)
        unique = {json.dumps(item, sort_keys=True) for item in matches}
        fields[kind] = json.loads(unique.pop()) if len(unique) == 1 else None
    fields["plan"] = checkout_text_plan(text)
    fields["renewal_interval"] = "monthly" if re.search(r"/\s*month|per month|每月|每个月|每個月", text, re.I) else None
    fields["tax_status"] = ("estimated" if fields["tax"] and re.search(r"预估税费|預估稅費|Estimated tax", text, re.I)
                            else "displayed" if fields["tax"] else "unknown")
    fields["source"] = "official_checkout_visible_text"
    return fields


async def quote_from_page(page, currency_hint=None):
    quote = quote_from_text(await page.locator("body").inner_text(), currency_hint)
    if quote["plan"] in ("pro", "pro-5x", "pro-20x"):
        # 官网 Pro 结算页同时展示两档；必须读当前 radio 的 aria-checked，
        # 不能从全文出现的 5/20 或金额猜测选中哪档。
        radios = await page.locator('[role="radio"]').filter(visible=True).evaluate_all("""nodes => nodes.map(n => ({
            label:n.getAttribute('aria-label') || n.innerText || '',
            checked:n.getAttribute('aria-checked'), state:n.getAttribute('data-state')}))""")
        tier_options = [(row, text_tiers(row["label"])) for row in radios if text_tiers(row["label"])]
        if tier_options:
            selected = [values for row, values in tier_options if row["checked"] == "true"
                        and row["state"] in (None, "checked")]
            quote["plan"] = ("pro-" + str(next(iter(selected[0]))) + "x"
                             if len(selected) == 1 and len(selected[0]) == 1 else "pro")
            quote["plan_source"] = "official_checkout_selected_radio"
    return quote


def is_payment_endpoint(url: str) -> bool:
    p = urlsplit(url)
    path = p.path.lower()
    return bool(re.search(r"/(?:confirm|pay|purchase|complete|capture|authorize|submit)(?:/|$)", path)
                or re.search(r"/(?:payment_intents|setup_intents)/[^/]+/confirm", path))


class NetworkGuard:
    """只允许已核对账户、已选套餐的一次官网建单；付款相关写入默认拒绝。"""
    def __init__(self, target: BrowserCredential, ledger=None):
        self.target, self.ledger = target, ledger
        self.target_plan = getattr(ledger, "target_plan", "plus")
        self.armed = False
        self.sent = 0
        self.blocked_duplicates = 0
        self.blocked_payment_requests = 0
        self.blocked_unknown_writes = 0
        self.request_object = None
        self.result = None
        self.error = None
        self.checkout_id = None
        self.private_url = None
        self.response_done = asyncio.Event()
        self.session_observation = {}
        self.blocked_official_paths = {}
        self.blocked_payment_paths = {}
        self.account_verified = False
        self.checkout_initializations_allowed = 0

    def classify(self, method, url, data=None, headers=None):
        p = urlsplit(url)
        if is_payment_endpoint(url):
            return "payment"
        # 已观察到官网 Stripe 组件使用此路径读取原结算初始化数据。
        # 仅允许已核对账户、本次/原记录的同一结算编号；confirm 等仍在上方拦截。
        if (method == "POST" and self.account_verified and self.checkout_id
                and p.scheme == "https" and p.hostname == "api.stripe.com"
                and p.path == f"/v1/payment_pages/{self.checkout_id}/init"):
            return "checkout_init"
        if method in SAFE_METHODS:
            return "read"
        if p.hostname == "chatgpt.com" and p.scheme == "https" and p.path == CHECKOUT_PATH:
            if not isinstance(data, dict):
                return "unknown_write"
            # 某些页面用同一端点加载既有结算；仅接受本次已观察到的编号。
            if set(data) == {"checkout_session_id"} and self.checkout_id and data["checkout_session_id"] == self.checkout_id:
                return "read"
            if data.get("plan_name") != plan_spec(self.target_plan)["official_name"]:
                return "plan_mismatch" if data.get("plan_name") in {p["official_name"] for p in PLANS.values()} else "unknown_write"
            if self.sent:
                return "duplicate"
            if not self.armed or self.ledger is None:
                return "unarmed"
            authorization = (headers or {}).get("authorization", "")
            if not authorization.startswith("Bearer "):
                return "account_mismatch"
            try:
                cred = parse_credential(json.dumps({"accessToken": authorization[7:]}).encode())
            except Stop:
                return "account_mismatch"
            aid = (headers or {}).get("chatgpt-account-id", cred.account_id)
            if aid != self.target.account_id or cred.account_id != self.target.account_id:
                return "account_mismatch"
            return "create"
        # 官网正常鉴权/验证码交换；不改写其正文或浏览器特征。
        if p.hostname == "chatgpt.com" and (p.path.startswith("/cdn-cgi/") or p.path.startswith("/backend-api/sentinel/")):
            return "read"
        if p.hostname == "challenges.cloudflare.com" and p.scheme == "https":
            return "read"
        # 本轮不发送 Stripe 卡片/确认/绑卡等写操作，也不向第三方发会话。
        if p.hostname and (p.hostname == "stripe.com" or p.hostname.endswith(".stripe.com")):
            return "payment"
        return "unknown_write"

    async def route(self, route):
        request = route.request
        if os.environ.get("AUTO_RECHARGE_CALLBACK_URL"):
            parts = urlsplit(request.url)
            host = parts.hostname or ""
            trusted = host in {"chatgpt.com", "challenges.cloudflare.com", "js.stripe.com", "api.stripe.com", "checkout.stripe.com", "m.stripe.network"} or any(
                host.endswith("." + domain) for domain in ("oaistatic.com", "oaiusercontent.com", "stripe.com", "stripe.network"))
            if parts.scheme != "https" or not trusted:
                await route.abort("blockedbyclient")
                return
        try:
            data = request.post_data_json if request.post_data else None
        except Exception:
            data = None
        decision = self.classify(request.method, request.url, data, request.headers)
        if decision in ("read", "checkout_init"):
            if decision == "checkout_init":
                self.checkout_initializations_allowed += 1
            await route.fallback()
            return
        if decision == "create":
            try:
                self.ledger.begin()  # fsync 成功之后才让浏览器发送原始请求。
            except (OSError, ValueError, Stop):
                self.error = Stop("checkout_marker_write_failed", stage="checkout_create")
                self.response_done.set()
                await route.abort("blockedbyclient")
                return
            self.sent = 1
            self.armed = False
            self.request_object = request
            progress("checkout_request_sending", attempt=1)
            await route.fallback()
            return
        if decision == "duplicate":
            self.blocked_duplicates += 1
        elif decision == "payment":
            self.blocked_payment_requests += 1
            parts = urlsplit(request.url)
            if parts.hostname and (parts.hostname == "chatgpt.com" or parts.hostname.endswith(".stripe.com")):
                path = safe_text(re.sub(r"/[A-Za-z0-9_-]{20,}", "/[id]", parts.path))
                key = parts.hostname + " " + request.method + " " + path if path else None
                if key and (key in self.blocked_payment_paths or len(self.blocked_payment_paths) < 12):
                    self.blocked_payment_paths[key] = self.blocked_payment_paths.get(key, 0) + 1
        else:
            self.blocked_unknown_writes += 1
            parts = urlsplit(request.url)
            if parts.hostname == "chatgpt.com" and parts.path.startswith(("/api/", "/backend-api/")):
                path = re.sub(r"/[A-Za-z0-9_-]{20,}", "/[id]", parts.path)
                path = safe_text(path)
                if path and (path in self.blocked_official_paths or len(self.blocked_official_paths) < 12):
                    self.blocked_official_paths[path] = self.blocked_official_paths.get(path, 0) + 1
            if decision in ("account_mismatch", "unarmed", "plan_mismatch"):
                self.error = Stop("checkout_" + decision, stage="checkout_create")
                self.response_done.set()
        await route.abort("blockedbyclient")

    async def response(self, response):
        parts = urlsplit(response.url)
        if parts.hostname == "chatgpt.com" and parts.path == "/api/auth/session":
            # 只报告会话请求是否携带 Cookie 和响应状态，不输出 Cookie 值/响应全文。
            headers = await response.request.all_headers()
            cookie_header = headers.get("cookie", "")
            cookie_format = ("single" if "__Secure-next-auth.session-token=" in cookie_header else
                             "chunked" if "__Secure-next-auth.session-token." in cookie_header else "absent")
            self.session_observation = {"official_session_http_status": response.status,
                "session_cookie_sent": cookie_format != "absent", "session_cookie_format": cookie_format}
        if response.request is not self.request_object:
            return
        try:
            raw = await response.body()
            if len(raw) > MAX_BYTES:
                raise Stop("response_too_large")
            data = response_json(response.status, await response.all_headers(), raw, self.target.old_token)
            result, url = checkout_result(data)
            self.result, self.private_url = result, url
            self.checkout_id = result["checkout_identifier"]
            self.ledger.finish({**result, "checkout_outcome": "created"})
        except Stop as exc:
            exc.report.update(stage="checkout_create", checkout_attempted=True)
            self.error = exc
            self.ledger.finish({**exc.report, "checkout_outcome": "rejected" if exc.report.get("http_status") in (400, 401, 403, 422) else "unknown"})
        except Exception:
            self.error = Stop("checkout_response_unreadable", stage="checkout_create", checkout_attempted=True)
            self.ledger.finish(self.error.report)
        finally:
            self.response_done.set()

    def summary(self):
        return {"target_plan": self.target_plan, "checkout_requests_sent": self.sent, "duplicate_requests_blocked": self.blocked_duplicates,
                "payment_requests_sent": 0, "payment_requests_blocked": self.blocked_payment_requests,
                "other_writes_blocked": self.blocked_unknown_writes, "payment_status": "not_attempted",
                "blocked_official_write_paths": dict(self.blocked_official_paths),
                "blocked_payment_related_paths": dict(self.blocked_payment_paths),
                "checkout_initializations_allowed": self.checkout_initializations_allowed,
                **self.session_observation}

    def checkout_status(self):
        if self.checkout_id:
            return "created"
        if self.error and self.error.report.get("http_status") in (400, 401, 403, 422):
            return "rejected"
        return "unknown" if self.sent else "not_attempted"


async def browser_read(page, path, credential=None):
    if urlsplit(page.url).hostname != "chatgpt.com":
        raise Stop("json_session_not_restored", session_status="new_authorized_json_required")
    headers = {"Accept": "application/json"}
    if credential:
        headers.update({"Authorization": "Bearer " + credential.token, "chatgpt-account-id": credential.account_id})
    # 页面同源请求；不跳转到会显示 Token 的 session JSON 页面。
    result = await page.evaluate("""async ({path, headers, limit}) => {
        const control = new AbortController();
        const timer = setTimeout(() => control.abort(), 25000);
        try {
            const r = await fetch(path, {headers, credentials: 'include', cache: 'no-store',
                                        redirect: 'error', signal: control.signal});
            const text = await r.text();
            return {status: r.status, headers: Object.fromEntries(r.headers.entries()),
                    raw: text.length > limit ? null : text};
        } finally { clearTimeout(timer); }
    }""", {"path": path, "headers": headers, "limit": MAX_BYTES})
    if result["raw"] is None:
        raise Stop("response_too_large")
    return response_json(result["status"], result["headers"], result["raw"].encode(), credential.token if credential else "")


async def wait_for_user(reason, seconds):
    if seconds <= 0 or not sys.stdin.isatty():
        raise Stop(reason, user_action_required=True)
    progress(reason, instruction="请在当前官网窗口完成网页验证或真实账单资料，然后在终端按 Enter；不要输入银行卡或点击付款。", wait_seconds=seconds)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([sys.stdin], [], [], 0)[0]:
            if sys.stdin.readline():
                return
            break
        await asyncio.sleep(0.2)
    raise Stop(reason, user_action_required=True, wait_expired=True)


async def check_session(page, target, wait_seconds=0):
    for attempt in range(2):
        try:
            title = await page.title()
            if re.search(r"Just a moment|Verify.*human|安全验证|请稍候", title, re.I):
                raise Stop("verification_required", challenge_observed=True)
            session = await browser_read(page, "/api/auth/session")
            refreshed = verify_official_session(session, target)
            plan = account_plan(await browser_read(page, ACCOUNT_PATH, refreshed), target.account_id)
            return refreshed, {"session_status": "restored", "account_matched": True, "current_plan": plan,
                               "credential_refreshed": refreshed.token != target.old_token}
        except Stop as exc:
            if exc.report["reason"] == "verification_required" and attempt == 0:
                await wait_for_user("verification_required", wait_seconds)
                continue
            raise
    raise Stop("verification_required")


async def select_plan(page, target_plan):
    from plan_selection import select_plan as select_official_plan
    return await select_official_plan(page, target_plan, progress)


async def verify_selected_plan(page, target_plan):
    from plan_selection import verify_selected_plan as verify_official_plan
    return await verify_official_plan(page, target_plan)


async def workflow(context, target, *, ledger=None, existing=None, wait_seconds=0, review_seconds=0, quote_timeout=25,
                   quote_handler=None, guard_factory=NetworkGuard, target_plan="plus"):
    """同一临时 BrowserContext 贯穿校验、选套餐和报价。便于本地路由夹具验收。"""
    guard = guard_factory(target, ledger)
    spec = plan_spec(target_plan)
    guard.target_plan = target_plan
    if ledger and ledger.target_plan != target_plan:
        raise Stop("checkout_ledger_plan_mismatch")
    if existing and existing.get("target_plan", "plus") != target_plan:
        raise Stop("checkout_record_plan_mismatch")
    if existing:
        guard.checkout_id = existing["checkout_identifier"]
        guard.result = {"returned_currency": existing.get("returned_currency")}
    await context.route("**/*", guard.route)
    await context.route_web_socket("**/*", lambda ws: ws.close())
    tasks = set()
    def response_callback(response):
        task = asyncio.create_task(guard.response(response))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    context.on("response", response_callback)
    page = await context.new_page()
    page.set_default_timeout(20000)
    identity = {"session_status": "not_verified", "account_matched": False}
    stage = "session_restore"
    quote = None
    quote_text = ""
    try:
        await context.add_cookies(session_cookies(target))
        progress(stage)
        await page.goto(ORIGIN + "/", wait_until="domcontentloaded", timeout=45000)
        _, identity = await check_session(page, target, wait_seconds)
        guard.account_verified = True
        if os.environ.get("AUTO_RECHARGE_CALLBACK_URL"):
            try:
                trace = await page.evaluate("""async () => {
                    const r = await fetch('/cdn-cgi/trace', {cache:'no-store'});
                    if (!r.ok) return '';
                    return (await r.text()).slice(0,4096);
                }""")
                import ipaddress
                values = dict(line.split("=", 1) for line in trace.splitlines() if "=" in line)
                ip = str(ipaddress.ip_address(values.get("ip", "")))
                country = values.get("loc", "")
                if not re.fullmatch(r"[A-Z]{2}", country):
                    raise ValueError()
                identity["network"] = {"ip": ip, "country": country, "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            except Exception:
                identity["network"] = {"ip": None, "country": None, "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        progress("session_verified", **identity)
        if ledger is None and existing is None:
            return {"status": "session_verified", **identity, "checkout_status": "not_attempted", **guard.summary()}
        if identity["current_plan"] != "free":
            raise Stop("incompatible_existing_subscription", current_plan=identity["current_plan"])
        if existing is None:
            stage = "plan_selection"
            progress(stage)
            button = await select_plan(page, target_plan)
            # 验证完成后/点击 Plus 前再次核对官网身份，防止切换账号。
            _, identity = await check_session(page, target, wait_seconds)
            if identity["current_plan"] != "free":
                raise Stop("incompatible_existing_subscription")
            await verify_selected_plan(page, target_plan)
            stage = "checkout_create"
            progress(stage)
            guard.armed = True
            await button.click()
            progress("checkout_wait")
            try:
                await asyncio.wait_for(guard.response_done.wait(), timeout=45)
            except asyncio.TimeoutError:
                raise Stop("checkout_result_unknown" if guard.sent else "checkout_request_not_observed", checkout_attempted=bool(guard.sent)) from None
            if guard.error:
                raise guard.error
            if not guard.checkout_id:
                raise Stop("missing_checkout_identifier")
        else:
            stage = "existing_checkout_read"
            progress("existing_checkout_read", new_checkout_allowed=False)
            await page.goto(ORIGIN + "/checkout/" + existing["processor_entity"] + "/" + guard.checkout_id,
                            wait_until="domcontentloaded", timeout=45000)
        stage = "quote_read"
        progress(stage)
        # 等待官网自己的跳转，避免主动 goto 与网页导航竞争或伪装成入口已打通。
        try:
            await page.wait_for_url(re.compile(r"^https://(?:chatgpt\.com/checkout/|checkout\.stripe\.com/).+"),
                                    wait_until="domcontentloaded", timeout=25000)
        except Exception:
            raise Stop("official_checkout_navigation_not_observed") from None
        if urlsplit(page.url).hostname not in ("chatgpt.com", "checkout.stripe.com"):
            raise Stop("unexpected_checkout_origin")
        deadline = time.monotonic() + quote_timeout
        while time.monotonic() < deadline:
            quote_text = await page.locator("body").inner_text()
            quote = await quote_from_page(page, guard.result.get("returned_currency"))
            if quote["today"] and quote["plan"] in (target_plan, spec["family"]):
                break
            await asyncio.sleep(0.3)
        if not quote or not quote["today"] or quote["plan"] not in (target_plan, spec["family"]):
            await wait_for_user("quote_needs_review_or_billing", wait_seconds)
            # 验证可能带来账户变化；另开同一上下文页面，只做官方身份核对。
            check_page = await context.new_page()
            await check_page.goto(ORIGIN + "/", wait_until="domcontentloaded")
            _, identity = await check_session(check_page, target, 0)
            await check_page.close()
            quote_text = await page.locator("body").inner_text()
            quote = await quote_from_page(page, guard.result.get("returned_currency"))
        if not quote["today"] or quote["plan"] not in (target_plan, spec["family"]):
            raise Stop("actual_quote_unknown", quote=quote)
        if quote["plan"] != target_plan:
            raise Stop("checkout_tier_not_verified", quote=quote)
        # 报价验收必须绑定本次编号；不能只凭页面出现 Plus/金额认定成功。
        if guard.checkout_id not in page.url:
            raise Stop("checkout_page_identifier_unverified", quote=quote)
        result = {"status": "checkout_quote_verified", **identity, **guard.summary(),
                  "checkout_status": "created", "checkout_identifier": guard.checkout_id,
                  "quote": quote, "subscription_status": "not_verified", "stage": "quote_ready"}
        if existing:
            result["inspection_only"] = True
        if ledger:
            ledger.finish(result)
        progress("quote_ready", quote=quote)
        if quote_handler:
            stage = "payment_preparation"
            result.update(await quote_handler(page, guard, identity, quote))
            result.update(guard.summary())
        if review_seconds:
            progress("review_window_open", seconds=review_seconds, payment="blocked")
            await asyncio.sleep(review_seconds)
            # 查看窗口仍受保护；最终计数包含这段时间，避免计数与路径明细不同步。
            result.update(guard.summary())
            if ledger:
                ledger.finish(result)
        return result
    except Stop as exc:
        result = {**identity, **exc.report, "stage": exc.report.get("stage", stage), **guard.summary(),
                  "checkout_status": guard.checkout_status()}
        if quote is not None:
            result["quote"] = quote
            lines = [line.strip() for line in quote_text.splitlines() if line.strip()]
            result["visible_quote_lines"] = [safe_text(" / ".join(lines[i:i + 2])) for i, line in enumerate(lines)
                if re.search(r"total|due|tax|renew|今天|今日|应付|合计|总计|税|MYR|PHP|₱|\bRM\b", line, re.I)][:12]
        if guard.checkout_id:
            result["checkout_identifier"] = guard.checkout_id
        if existing:
            result["inspection_only"] = True
        if ledger:
            ledger.finish(result)
        return result
    except Exception as exc:
        # Playwright 错误可能含 URL/脚本参数，不输出异常字符串或 traceback。
        result = {"status": "blocked", "reason": "browser_operation_failed", "stage": stage,
                  "error_type": type(exc).__name__, **identity, **guard.summary(),
                  "checkout_status": guard.checkout_status()}
        network_code = re.search(r"net::ERR_[A-Z_]+", str(exc))
        if network_code:
            result["browser_error_code"] = network_code.group(0)
        if guard.checkout_id:
            result["checkout_identifier"] = guard.checkout_id
        if ledger:
            ledger.finish(result)
        return result
    finally:
        guard.armed = False
        if tasks:
            await asyncio.gather(*list(tasks), return_exceptions=True)


async def run_browser(target, *, create=False, inspect_existing=False, retry_rejected=False, state_dir=ROOT / ".state", wait_seconds=0, review_seconds=0,
                      quote_handler=None, guard_factory=NetworkGuard, target_plan="plus"):
    # 固定项目自己的浏览器，不依赖开源参考目录或全局浏览器缓存。
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(ROOT / ".browsers"))
    # 不允许环境变量意外启动协议调试日志，避免凭据进入终端/文件。
    for key in ("DEBUG", "PWDEBUG", "PW_TRACE_DIR", "PLAYWRIGHT_TRACE_DIR"):
        os.environ.pop(key, None)
    from playwright.async_api import async_playwright
    if inspect_existing and (create or retry_rejected):
        raise Stop("invalid_operation_combination")
    plan_spec(target_plan)
    existing = existing_checkout(state_dir, target.account_id, target_plan) if inspect_existing else None
    manager = AttemptLedger(state_dir, target.account_id, retry_rejected=retry_rejected, target_plan=target_plan) if create else nullcontext()
    with manager as ledger:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=False)
            try:
                context = await browser.new_context(service_workers="block", accept_downloads=False)
                try:
                    return await workflow(context, target, ledger=ledger, existing=existing,
                                          wait_seconds=wait_seconds, review_seconds=review_seconds,
                                          quote_handler=quote_handler, guard_factory=guard_factory, target_plan=target_plan)
                finally:
                    await context.close()
            finally:
                await browser.close()
