"""普通可见 Chromium：恢复授权会话、通过官网建单，始终阻止付款。"""
from __future__ import annotations

import asyncio
import ipaddress
from contextlib import contextmanager, nullcontext
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
from browser_session import (NETWORK_CODE_PATTERN, SessionBudget,
                             retryable_page_load_error, session_failure)
from checkout_core import (ACCOUNT_PATH, CHECKOUT_PATH, MAX_BYTES, ROOT, BrowserCredential,
                           Stop, account_plan, checkout_result, parse_credential, response_json,
                           safe_text, session_cookies, verify_official_session)
from plans import PLANS, PRO_GROUP, checkout_option_plan, checkout_text_plan, plan_spec, text_tiers, official_subscription, subscription_transition

ORIGIN = "https://chatgpt.com"


async def install_session_cookies(context, target, *, budget=None):
    """Replace only official session-token fragments; preserve every other cookie."""
    async def install():
        await context.clear_cookies(
            name=re.compile(r"^__Secure-next-auth\.session-token(?:\.\d+)?$"),
            domain=re.compile(r"^\.?chatgpt\.com$"))
        if budget:
            budget.check_cancelled()
        await context.add_cookies(session_cookies(target))
    if budget:
        await budget.run(install, "session_cookie")
    else:
        await install()


SESSION_REFRESH_PATH = ("/api/auth/session?refresh=true&reason=token_expired&method=GET"
                        "&path=%2Fapi%2Fauth%2Fsession")
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CURRENCIES = {"USD": 2, "MYR": 2, "PHP": 2, "CLP": 0, "EUR": 2, "GBP": 2, "AUD": 2, "CAD": 2,
              "JPY": 0, "KRW": 0, "SGD": 2, "INR": 2, "IDR": 2, "THB": 2, "VND": 0,
              "TWD": 2, "HKD": 2, "BRL": 2, "MXN": 2, "AED": 2, "SAR": 2, "ZAR": 2,
              "NZD": 2, "CHF": 2, "SEK": 2, "NOK": 2, "DKK": 2, "PLN": 2, "TRY": 2}
VISIBLE_MONEY_LINE = re.compile(
    r"(?:(?:[A-Z]{3}|RM|₱|\$|€|£|¥|￥)\s*)?[0-9,.]+(?:\s*[A-Z]{3})?"
)
EXPIRED_CHECKOUT_ERROR = re.compile(
    r"there was an error processing your payment|付款处理(?:发生|出现)?错误|处理(?:你的|您的)?付款时(?:(?:发生|出现)?错误|出错)",
    re.I,
)
PAGE_NETWORK_ERROR = re.compile(
    r"(?:net::)?ERR_(?:TIMED_OUT|CONNECTION_TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|"
    r"PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|NETWORK_CHANGED|"
    r"EMPTY_RESPONSE|CONNECTION_REFUSED|INTERNET_DISCONNECTED)",
    re.I,
)
def progress(stage, **details):
    print(json.dumps({"event": stage, **details}, ensure_ascii=False), file=sys.stderr, flush=True)


def is_unavailable_existing_checkout(text: str) -> bool:
    """识别官网保留旧 URL、但正文已变为付款错误页的失效结算。"""
    # 官网按钮可能由独立前端根节点渲染，body.innerText 不一定能读取；错误标题本身已足够明确。
    return bool(EXPIRED_CHECKOUT_ERROR.search(text))


def checkout_page_matches(url, checkout_id):
    parts = urlsplit(url)
    # 返回页的查询参数也带订单编号，不能把它当成结算页面。
    return (parts.hostname in {"chatgpt.com", "checkout.stripe.com"}
            and parts.path.rstrip("/").split("/")[-1] == checkout_id)


def checkout_page_state(url, text, quote, checkout_id):
    """只输出受控页面状态，不保存官网正文。"""
    if PAGE_NETWORK_ERROR.search(text):
        return "network_error"
    if is_unavailable_existing_checkout(text):
        return "official_error"
    if quote and quote.get("plan"):
        return "checkout" if quote.get("today") else "quote_incomplete"
    if checkout_page_matches(url, checkout_id):
        return "blank" if not text.strip() else "loading"
    return "loading"


async def quote_with_page_recovery(page, guard, target_plan, plan_family, quote_handler,
                                   existing, session_budget, quote_timeout):
    """报价阶段独立等待；过半仍无有效内容时在当前窗口刷新一次。"""
    wait_seconds = session_budget.seconds if session_budget else quote_timeout
    quote_budget = session_budget.restart(report=lambda **_: None) if session_budget else None
    started = time.monotonic()
    elapsed = lambda: quote_budget.elapsed if quote_budget else max(0, time.monotonic() - started)
    cancelled = quote_budget.check_cancelled if quote_budget else lambda: None
    refresh_at = wait_seconds / 2
    refresh_count = 0
    last_report = float("-inf")
    quote = None
    quote_text = ""
    page_state = "loading"
    partial_quote_since = None
    expected_url = None
    entity = guard.result.get("processor_entity")
    if isinstance(entity, str) and guard.checkout_id:
        expected_url = f"{ORIGIN}/checkout/{entity}/{guard.checkout_id}"

    async def read_quote_operation(operation, step):
        try:
            if quote_budget:
                return await quote_budget.run(operation, step)
            remaining = wait_seconds - elapsed()
            if remaining <= 0:
                raise asyncio.TimeoutError()
            value = await asyncio.wait_for(operation(), timeout=remaining)
            if elapsed() >= wait_seconds:
                raise asyncio.TimeoutError()
            return value
        except (asyncio.TimeoutError, Stop) as exc:
            if isinstance(exc, Stop) and exc.report.get("reason") != "session_load_timeout":
                raise
            raise Stop("checkout_page_load_timeout",
                       quote_elapsed_seconds=min(int(elapsed()), int(wait_seconds)),
                       quote_wait_seconds=int(wait_seconds), quote_refresh_count=refresh_count,
                       page_state="loading") from None

    async def refresh_page(reason):
        nonlocal refresh_count
        progress("quote_page_refreshing", quote_elapsed_seconds=int(elapsed()),
                 quote_wait_seconds=wait_seconds, quote_refresh_count=1,
                 page_state=page_state, last_reason=reason)
        refresh_count = 1
        operation = (lambda: page.reload(wait_until="domcontentloaded", timeout=0))
        if expected_url and not checkout_page_matches(page.url, guard.checkout_id):
            operation = lambda: page.goto(expected_url, wait_until="domcontentloaded", timeout=0)
        try:
            if quote_budget:
                await quote_budget.run(operation, "quote_refresh")
            else:
                await asyncio.wait_for(operation(), timeout=max(1, wait_seconds - elapsed()))
        except Stop as exc:
            if exc.report.get("reason") == "operation_cancelled":
                raise
            reason = ("checkout_page_load_timeout" if exc.report.get("reason") == "session_load_timeout"
                      else "checkout_page_network_error")
            raise Stop(reason, quote_elapsed_seconds=min(int(elapsed()), int(wait_seconds)),
                       quote_wait_seconds=int(wait_seconds), quote_refresh_count=refresh_count,
                       page_state="loading" if reason == "checkout_page_load_timeout"
                       else "network_error") from None
        except Exception as exc:
            code = PAGE_NETWORK_ERROR.search(str(exc))
            raise Stop("checkout_page_network_error", browser_error_code=(code.group(0).upper()
                       if code else None), quote_elapsed_seconds=int(elapsed()),
                       quote_wait_seconds=wait_seconds, quote_refresh_count=refresh_count,
                       page_state="network_error") from None

    if existing and expected_url and not checkout_page_matches(page.url, guard.checkout_id):
        try:
            operation = lambda: page.goto(expected_url, wait_until="domcontentloaded",
                                          timeout=max(1, int(refresh_at * 1000)))
            if quote_budget:
                await quote_budget.run(operation, "quote_navigation")
            else:
                await asyncio.wait_for(operation(), timeout=max(1, refresh_at))
        except (asyncio.TimeoutError, Stop) as exc:
            if isinstance(exc, Stop) and exc.report.get("reason") == "operation_cancelled":
                raise
            page_state = "loading"
            await refresh_page("official_checkout_navigation_not_observed")
        except Exception as exc:
            code = PAGE_NETWORK_ERROR.search(str(exc))
            if code or retryable_page_load_error(exc):
                page_state = "network_error"
                await refresh_page("checkout_page_network_error")
            else:
                raise

    while elapsed() < wait_seconds:
        cancelled()
        try:
            quote_text = await read_quote_operation(
                lambda: page.locator("body").inner_text(), "quote_text")
            title = await read_quote_operation(page.title, "quote_title")
        except Exception as exc:
            code = PAGE_NETWORK_ERROR.search(str(exc))
            if refresh_count == 0 and (code or retryable_page_load_error(exc)):
                page_state = "network_error"
                await refresh_page("checkout_page_network_error")
                continue
            if code:
                raise Stop("checkout_page_network_error", browser_error_code=code.group(0).upper(),
                           quote_elapsed_seconds=int(elapsed()), quote_wait_seconds=wait_seconds,
                           quote_refresh_count=refresh_count, page_state="network_error") from None
            raise
        observed_text = title + "\n" + quote_text
        quote = await read_quote_operation(
            lambda: quote_from_page(page, guard.result.get("returned_currency")), "quote_read")
        page_state = checkout_page_state(page.url, observed_text, quote, guard.checkout_id)
        now = elapsed()
        if now - last_report >= 10:
            progress("quote_waiting", quote_elapsed_seconds=int(now),
                     quote_wait_seconds=wait_seconds, quote_refresh_count=refresh_count,
                     page_state=page_state)
            last_report = now
        if quote["today"] and quote["plan"] in (target_plan, plan_family):
            break
        if quote_handler and quote["plan"] == target_plan:
            partial_quote_since = partial_quote_since or time.monotonic()
            if time.monotonic() - partial_quote_since >= 2:
                break
        else:
            partial_quote_since = None
        if page_state in {"network_error", "official_error"}:
            if refresh_count == 0:
                await refresh_page("existing_checkout_unavailable" if page_state == "official_error"
                                   else "checkout_page_network_error")
                continue
            if page_state == "official_error":
                raise Stop("existing_checkout_unavailable", quote=quote,
                           quote_elapsed_seconds=int(elapsed()), quote_wait_seconds=wait_seconds,
                           quote_refresh_count=refresh_count, page_state=page_state)
            raise Stop("checkout_page_network_error", quote=quote,
                       quote_elapsed_seconds=int(elapsed()), quote_wait_seconds=wait_seconds,
                       quote_refresh_count=refresh_count, page_state=page_state)
        if refresh_count == 0 and now >= refresh_at:
            await refresh_page("checkout_page_incomplete")
            continue
        try:
            await read_quote_operation(
                lambda: asyncio.sleep(min(.3, max(.001, wait_seconds - elapsed()))), "quote_wait")
        except Stop as exc:
            if exc.report.get("reason") != "checkout_page_load_timeout":
                raise
            break
    return quote, quote_text, {
        "quote_elapsed_seconds": min(int(elapsed()), int(wait_seconds)),
        "quote_wait_seconds": int(wait_seconds),
        "quote_refresh_count": refresh_count,
        "page_state": page_state,
    }


async def restore_session_with_refresh(page, target, wait_seconds, budget):
    """Load once, then refresh the same page once while the window budget remains."""
    for load_attempt in range(2):
        try:
            budget.refresh_count = load_attempt
            if load_attempt == 0:
                operation = lambda: page.goto(
                    ORIGIN + "/", wait_until="commit", timeout=0
                )
                step = "page_load"
            elif page.url == "about:blank":
                operation = lambda: page.goto(
                    ORIGIN + "/", wait_until="commit", timeout=0
                )
                step = "page_refresh"
            else:
                operation = lambda: page.reload(wait_until="commit", timeout=0)
                step = "page_refresh"
            response = await budget.run(operation, step)
            status = getattr(response, "status", None)
            if type(status) is int and status >= 400:
                raise Stop("verification_required" if status == 403 else "http_error",
                           http_status=status, user_action_required=status == 403)
            return await check_session(page, target, wait_seconds, budget, initial_restore=True)
        except Exception as exc:
            if load_attempt or not retryable_page_load_error(exc):
                raise
            try:
                budget.remaining_ms()
            except Stop:
                raise exc
            reason = (
                exc.report.get("reason")
                if isinstance(exc, Stop)
                else "browser_operation_failed"
            )
            progress(
                "session_page_refreshing",
                session_step="page_refresh",
                session_refresh_count=1,
                last_reason=reason,
            )
    raise Stop("session_network_error")


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
    fields, renewal_intervals = {}, []
    monthly = r"/\s*(?:month|月)(?!\w)|per\s+month\b|\bmonthly\b|每月|每个月|每個月|按月|月付"
    yearly = r"/\s*(?:year|年)(?!\w)|per\s+year\b|\b(?:annual(?:ly)?|yearly)\b|每年|按年|年付|年度|年缴|年繳"
    standalone_interval = re.compile(
        r"(?:/\s*(?:month|year|月|年)|per\s+(?:month|year)|monthly|yearly|annually|每月|每个月|每個月|每年)", re.I)
    def interval(value, expected=None):
        periods = {name for name, pattern in (("monthly", monthly), ("yearly", yearly))
                   if re.search(pattern, value, re.I)}
        if expected:
            periods.add(expected)
        return next(iter(periods)) if len(periods) == 1 else None
    for kind, pattern in labels.items():
        matches = []
        # 同一报价字段存在多种值时拒绝自动判定。
        for i, line in enumerate(lines):
            if re.search(pattern, line, re.I):
                found = money(line, currency_hint)
                amount_line, clause = i, line
                if found is None and i + 1 < len(lines):
                    # 不跨越“未知/小计/税费”等下一字段，把别的金额误作今日应付。
                    value_line = lines[i + 1]
                    amount_text = (re.sub(rf"(?:{monthly}|{yearly})", "", value_line,
                                          flags=re.I).strip() if kind == "renewal" else value_line)
                    if VISIBLE_MONEY_LINE.fullmatch(amount_text):
                        found = money(value_line, currency_hint)
                        amount_line, clause = i + 1, value_line
                if found:
                    matches.append(found)
                    if kind == "renewal":
                        period = interval(clause)
                        # 分行续费字段只接受紧邻金额的独立周期，不从其他价格/说明猜测。
                        if (period is None and not re.search(rf"(?:{monthly}|{yearly})", clause, re.I)
                                and amount_line + 1 < len(lines)
                                and standalone_interval.fullmatch(lines[amount_line + 1])):
                            period = interval(lines[amount_line + 1])
                        renewal_intervals.append(period)
        if kind == "renewal":
            # 官网中文结算条款：将按 MYR 92.50/月 收费。只取明确的续费句，
            # 不把产品列表价或今日金额复制为续费金额。
            for matched in re.finditer(r"将按\s+([^。\n]+?)/\s*(月|年)\s*收费", text):
                found = money(matched[1], currency_hint)
                if found:
                    matches.append(found)
                    # 账期修饰可能跟在“收费”后；核对同一句，不能丢掉括号内的年付说明。
                    start = max(text.rfind("。", 0, matched.start()),
                                text.rfind("\n", 0, matched.start())) + 1
                    boundary = re.search(r"[。\n]", text[matched.end():])
                    end = matched.end() + boundary.start() if boundary else len(text)
                    renewal_intervals.append(interval(
                        text[start:end], "monthly" if matched[2] == "月" else "yearly"))
        unique = {json.dumps(item, sort_keys=True) for item in matches}
        fields[kind] = json.loads(unique.pop()) if len(unique) == 1 else None
    fields["plan"] = checkout_text_plan(text)
    fields["renewal_interval"] = ("monthly" if renewal_intervals
                                  and set(renewal_intervals) == {"monthly"} else None)
    fields["tax_status"] = ("estimated" if fields["tax"] and re.search(r"预估税费|預估稅費|Estimated tax", text, re.I)
                            else "displayed" if fields["tax"] else "unknown")
    fields["source"] = "official_checkout_visible_text"
    return fields


async def quote_from_page(page, currency_hint=None):
    quote = quote_from_text(await page.locator("body").inner_text(), currency_hint)
    if quote["plan"] in ("pro", "pro-5x", "pro-20x", "pro-500"):
        # 官网同时展示多个 Pro 档位；只读取唯一选中控件，不按全文或金额推断。
        groups = page.get_by_role('radiogroup', name=PRO_GROUP).or_(
            page.get_by_role('group', name=PRO_GROUP)).filter(visible=True)
        count = await groups.count()
        if count > 1:
            quote['plan'] = 'pro'
            return quote
        scope = groups if count == 1 else page
        radios = await scope.locator('[role="radio"]').filter(visible=True).evaluate_all("""nodes => nodes.map(n => ({
            label:n.getAttribute('aria-label') || n.innerText || '',
            checked:n.getAttribute('aria-checked'), state:n.getAttribute('data-state')}))""")
        if count == 1 and radios:
            selected = [row for row in radios if row['checked'] == 'true'
                        and row['state'] in (None, 'checked')]
            quote['plan'] = (checkout_option_plan(selected[0]['label'])
                             if len(selected) == 1 else None) or 'pro'
            quote['plan_source'] = 'official_checkout_selected_radio'
        else:
            tier_options = [(row, text_tiers(row["label"])) for row in radios if text_tiers(row["label"])]
            if not tier_options:
                return quote
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
        self.operation_cancelled = lambda: False
        self.hcaptcha_enabled = False
        self.target_plan = getattr(ledger, "target_plan", "plus")
        self.armed = False
        self.sent = 0
        self.blocked_duplicates = 0
        self.blocked_payment_requests = 0
        self.blocked_unknown_writes = 0
        self.auth_session_writes_blocked = 0
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

    async def route_hcaptcha(self, route):
        from payment_handoff import hcaptcha_resource_allowed
        decision = await hcaptcha_resource_allowed(route.request, self.target,
            enabled=self.hcaptcha_enabled and self.account_verified and not getattr(self, 'read_only', False))
        if decision is None:
            return False
        if decision and not self.operation_cancelled():
            await route.fallback()
        else:
            await route.abort('blockedbyclient')
        return True

    async def route(self, route):
        if self.operation_cancelled():
            await route.abort('blockedbyclient')
            return
        if await self.route_hcaptcha(route):
            return
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
            if parts.hostname == "chatgpt.com" and parts.path == "/api/auth/session":
                self.auth_session_writes_blocked += 1
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
                "auth_session_writes_blocked": self.auth_session_writes_blocked,
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


@contextmanager
def observe_critical_read_failure(page, path):
    """Only failures of this main-frame official identity read can prove proxy trouble."""
    observation, pending, attached = {}, set(), []
    expected = urlsplit(path)
    active = True
    def matches(request):
        try:
            location = urlsplit(request.url)
            return bool(active and request.method == "GET"
                        and location.scheme == "https" and location.netloc == "chatgpt.com"
                        and location.path == expected.path and location.query == expected.query
                        and request.frame is page.main_frame)
        except Exception:
            return False
    def requested(request):
        if matches(request):
            pending.add(id(request))
    def failed(request):
        if id(request) not in pending or not matches(request):
            return
        try:
            failure = request.failure
            code = NETWORK_CODE_PATTERN.search(failure) if isinstance(failure, str) else None
            if code:
                observation["browser_error_code"] = code.group(0)
        except Exception:
            pass
    try:
        if (expected.path in {"/api/auth/session", ACCOUNT_PATH}
                and callable(getattr(page, "on", None))
                and callable(getattr(page, "remove_listener", None))):
            for name, handler in (("request", requested), ("requestfailed", failed)):
                page.on(name, handler)
                attached.append((name, handler))
        yield observation
    finally:
        active = False
        for name, handler in attached:
            try:
                page.remove_listener(name, handler)
            except Exception:
                pass


async def browser_read(page, path, credential=None, budget=None, *, timeout_ms=None):
    if urlsplit(page.url).hostname != "chatgpt.com":
        raise Stop("json_session_not_restored", session_status="new_authorized_json_required")
    headers = {"Accept": "application/json"}
    if credential:
        headers.update({"Authorization": "Bearer " + credential.token, "chatgpt-account-id": credential.account_id})
    read_timeout_ms = budget.remaining_ms() if budget else 25000
    if timeout_ms is not None:
        read_timeout_ms = min(read_timeout_ms, timeout_ms)
    # 页面同源请求；不跳转到会显示 Token 的 session JSON 页面。
    with observe_critical_read_failure(page, path) as observed:
        result = await page.evaluate("""async ({path, headers, limit, timeoutMs, boundedSession}) => {
        const control = new AbortController();
        const timer = setTimeout(() => control.abort(), timeoutMs);
        try {
            const r = await fetch(path, {headers, credentials: 'include', cache: 'no-store',
                                        redirect: 'error', signal: control.signal});
            const text = await r.text();
            // 指纹内核的 Headers 迭代器可能不可迭代，只读取错误核验实际使用的响应头。
            return {status: r.status, headers: {
                        'cf-mitigated': r.headers.get('cf-mitigated'),
                        'x-request-id': r.headers.get('x-request-id'),
                        'request-id': r.headers.get('request-id'),
                        'cf-ray': r.headers.get('cf-ray')},
                    raw: text.length > limit ? null : text};
        } catch (error) {
            if (!boundedSession) throw error;
            return {read_error: error.name === "AbortError" ? "timeout" : "network"};
        } finally { clearTimeout(timer); }
        }""", {"path": path, "headers": headers, "limit": MAX_BYTES,
                 "timeoutMs": read_timeout_ms, "boundedSession": bool(budget)})
    if result.get("read_error"):
        code = observed.get("browser_error_code")
        reason = ("session_network_error" if code or result["read_error"] != "timeout"
                  else "session_load_timeout")
        raise Stop(reason, **({"browser_error_code": code} if code else {}))
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


async def wait_for_refreshed_session(page, target, budget, expired):
    """Use the official refresh GET once, then observe within the original deadline."""
    deadline = budget.clock() + 15
    refresh_sent = False
    while budget.clock() < deadline:
        session = {}
        try:
            await budget.run(lambda: asyncio.sleep(min(1, deadline - budget.clock())), "session_read")
            remaining = deadline - budget.clock()
            if remaining <= 0:
                break
            path = "/api/auth/session" if refresh_sent else SESSION_REFRESH_PATH
            refresh_sent = True
            session = await budget.run(lambda: asyncio.wait_for(
                browser_read(page, path, budget=budget, timeout_ms=max(1, int(remaining * 1000))),
                timeout=remaining), "session_read")
            if budget.clock() > deadline:
                break
            return verify_official_session(session, target)
        except Stop as exc:
            if exc.report.get("reason") == "access_token_expired" and not session.get("error"):
                expired = exc
                continue
            if exc.report.get("reason") == "session_load_timeout":
                break
            raise
        except asyncio.TimeoutError:
            break
    # An expired session never becomes a network-retry trigger or a verified login.
    raise expired


async def check_session(page, target, wait_seconds=0, budget=None, *, initial_restore=False):
    async def read(operation, step):
        return await budget.run(operation, step) if budget else await operation()
    refresh_waiting = False
    for attempt in range(2):
        try:
            title = await read(page.title, "page_title")
            if re.search(r"Just a moment|Verify.*human|安全验证|请稍候", title, re.I):
                raise Stop("verification_required", challenge_observed=True)
            session = await read(lambda: browser_read(page, "/api/auth/session", budget=budget), "session_read")
            try:
                refreshed = verify_official_session(session, target)
            except Stop as exc:
                if (exc.report.get("reason") != "access_token_expired" or not initial_restore
                        or session.get("error") or not budget
                        or not getattr(target, "session_token", None) or refresh_waiting):
                    raise
                refresh_waiting = True
                refreshed = await wait_for_refreshed_session(page, target, budget, exc)
            account = await read(lambda: browser_read(page, ACCOUNT_PATH, refreshed, budget), "account_read")
            subscription = official_subscription(account, target.account_id)
            return refreshed, {"session_status": "restored", "account_matched": True, **subscription,
                               "credential_refreshed": refreshed.token != target.old_token}
        except Stop as exc:
            if exc.report["reason"] == "verification_required" and attempt == 0 and not refresh_waiting:
                if budget:
                    await budget.human_wait(lambda: wait_for_user("verification_required", wait_seconds))
                else:
                    await wait_for_user("verification_required", wait_seconds)
                continue
            raise
    raise Stop("verification_required")


async def observe_page_network(page, budget=None):
    """读取当前官网窗口出口；取消和网络错误不能伪装成已核实。"""
    async def read_trace():
        return await page.evaluate("""async timeoutMs => {
            const control = new AbortController();
            const timer = setTimeout(() => control.abort(), timeoutMs);
            try {
                const r = await fetch('/cdn-cgi/trace', {cache:'no-store', signal:control.signal});
                if (!r.ok) return '';
                return (await r.text()).slice(0,4096);
            } finally { clearTimeout(timer); }
        }""", min(10000, budget.remaining_ms()) if budget else 10000)
    try:
        trace = await budget.run(read_trace, "account_read") if budget else await read_trace()
        values = dict(line.split("=", 1) for line in trace.splitlines() if "=" in line)
        ip = str(ipaddress.ip_address(values.get("ip", "")))
        country = values.get("loc", "")
        if not re.fullmatch(r"[A-Z]{2}", country):
            raise ValueError()
        return {"ip": ip, "country": country,
                "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    except Stop:
        raise
    except Exception as exc:
        from browser_session import session_failure
        failure = session_failure(exc)
        raise Stop("proxy_network_unconfirmed", error_type=failure["error_type"],
                   browser_error_code=failure.get("browser_error_code")) from None


async def prepare_proxy_in_context(context, expected_country=None, *, budget):
    """原窗口内的只读连通性检测，出口与首页共用二十秒预算。"""
    probe = SessionBudget(20, cancelled=budget.cancelled, report=budget.report, parent=budget)
    guard = NetworkGuard(None)
    guard.operation_cancelled = budget.cancelled
    await probe.run(lambda: context.route("**/*", guard.route), "proxy_probe")
    try:
        page = next((item for item in context.pages if item.url == "about:blank"
                     or urlsplit(item.url).hostname == "chatgpt.com"), None)
        page = page or await probe.run(context.new_page, "proxy_probe")
        response = await probe.run(lambda: page.goto(
            ORIGIN + "/cdn-cgi/trace", wait_until="commit", timeout=0), "proxy_probe")
        status = getattr(response, "status", None)
        if status == 403:
            raise Stop("verification_required", http_status=403, user_action_required=True)
        if type(status) is int and status >= 400:
            raise Stop("http_error", http_status=status)
        network = await observe_page_network(page, probe)
        if not ipaddress.ip_address(network["ip"]).is_global:
            raise Stop("proxy_network_unconfirmed")
        if expected_country and network["country"] != expected_country:
            raise Stop("proxy_country_mismatch", network=network)
        response = await probe.run(lambda: page.goto(
            ORIGIN + "/", wait_until="commit", timeout=0), "proxy_home")
        status = getattr(response, "status", None)
        if status == 403:
            raise Stop("verification_required", http_status=403, user_action_required=True)
        if type(status) is int and status >= 400:
            raise Stop("http_error", http_status=status)
        title = await probe.run(page.title, "proxy_home")
        if re.search(r"Just a moment|Verify.*human|安全验证|请稍候", title, re.I):
            raise Stop("verification_required", user_action_required=True)
        return network
    except Stop as exc:
        if exc.report.get("reason") == "session_load_timeout":
            raise Stop("proxy_prepare_timeout", error_type="TimeoutError") from None
        raise
    except Exception as exc:
        failure = session_failure(exc)
        reason = ("proxy_prepare_timeout" if failure["reason"] == "session_load_timeout"
                  else "proxy_network_error" if failure.get("browser_error_code")
                  else "proxy_network_unconfirmed")
        raise Stop(reason, **{key: failure[key] for key in ("error_type", "browser_error_code")
                             if key in failure}) from None
    finally:
        # Route removal cannot extend an exhausted preparation phase indefinitely.
        try:
            await asyncio.wait_for(context.unroute("**/*", guard.route), timeout=5)
        except Exception:
            raise Stop("bitbrowser_guard_cleanup_unverified") from None


async def synchronize_login_page(page, target, identity, *, budget):
    """身份核对和官网应用呈现分别验收；同一标签页最多同步刷新一次。"""
    ui_started = budget.clock()
    refreshed_once = False
    while True:
        try:
            budget.remaining_ms()
            refreshed, identity = await check_session(page, target, budget=budget)
            ready = await budget.run(lambda: page.evaluate("""() => {
                if (location.protocol !== 'https:' || location.hostname !== 'chatgpt.com') return false;
                return Array.from(document.querySelectorAll(
                    '[data-testid="accounts-profile-button"][role="button"][aria-haspopup="menu"]'
                )).some(node => node.getClientRects().length &&
                    getComputedStyle(node).visibility !== 'hidden' &&
                    getComputedStyle(node).display !== 'none' &&
                    !node.matches(':disabled,[aria-disabled="true"]'));
            }"""), "page_ui_sync")
            if ready:
                return BrowserCredential("", target.account_id, target.user_id, refreshed.token), identity
            if not refreshed_once and budget.clock() - ui_started >= 10:
                refreshed_once = True
                budget.refresh_count += 1
                progress("session_page_refreshing", session_step="page_ui_sync", account_matched=True)
                response = await budget.run(lambda: page.reload(
                    wait_until="commit", timeout=0), "page_ui_sync")
                status = getattr(response, "status", None)
                if status == 403:
                    raise Stop("verification_required", http_status=403, user_action_required=True)
                if type(status) is int and status >= 400:
                    raise Stop("http_error", http_status=status)
                continue
            await budget.run(lambda: asyncio.sleep(0.5), "page_ui_sync")
        except Stop as exc:
            if (exc.report.get("reason") == "session_load_timeout"
                    and (budget.step == "page_ui_sync" or budget.elapsed >= budget.seconds)):
                raise Stop("official_login_page_not_ready", account_matched=True,
                           **budget.snapshot()) from None
            raise


async def select_plan(page, target_plan):
    from plan_selection import select_plan as select_official_plan
    return await select_official_plan(page, target_plan, progress)


async def verify_selected_plan(page, target_plan):
    from plan_selection import verify_selected_plan as verify_official_plan
    return await verify_official_plan(page, target_plan)


async def workflow(context, target, *, ledger=None, existing=None, wait_seconds=0, review_seconds=0, quote_timeout=25,
                   quote_handler=None, guard_factory=NetworkGuard, target_plan="plus", session_budget=None,
                   session_handler=None):
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
        guard.result = {
            "returned_currency": existing.get("returned_currency"),
            "processor_entity": existing.get("processor_entity"),
        }
    await context.route("**/*", guard.route)
    await context.route_web_socket("**/*", lambda ws: ws.close())
    tasks = set()
    def response_callback(response):
        task = asyncio.create_task(guard.response(response))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    context.on("response", response_callback)
    # 本机比特已打开首页；复用并在注入 Cookie 后加载，避免留下游客标签页。
    page = next((p for p in context.pages if p.url == "about:blank" or
                 (urlsplit(p.url).hostname == "chatgpt.com"
                  and (urlsplit(p.url).path in ("", "/")
                       or urlsplit(p.url).path.startswith("/checkout/")))), None)
    page = page or await context.new_page()
    page.set_default_timeout(20000)
    identity = {"session_status": "not_verified", "account_matched": False}
    stage = "session_restore"
    quote = None
    quote_text = ""
    result = None
    try:
        if getattr(target, "session_token", None):
            await install_session_cookies(context, target, budget=session_budget)
        progress(stage, account_matched=False, session_status="not_verified",
                 **(session_budget.snapshot() if session_budget else {}))
        if session_budget:
            _, identity = await restore_session_with_refresh(
                page, target, wait_seconds, session_budget
            )
        else:
            await page.goto(ORIGIN + "/", wait_until="domcontentloaded", timeout=45000)
            _, identity = await check_session(page, target, wait_seconds, session_budget)
        guard.account_verified = True
        if os.environ.get("AUTO_RECHARGE_CALLBACK_URL"):
            identity["network"] = await observe_page_network(page, session_budget)
        progress("session_verified", **identity)
        if session_handler is not None:
            return await session_handler(page, guard, identity)
        if ledger is None and existing is None:
            return {"status": "session_verified", **identity, "checkout_status": "not_attempted", **guard.summary()}
        if identity["current_plan"] != "free":
            raise Stop("incompatible_existing_subscription", current_plan=identity["current_plan"])
        if existing is None:
            stage = "plan_selection"
            progress(stage)
            button = await select_plan(page, target_plan)
            # 验证完成后/点击 Plus 前再次核对官网身份，防止切换账号。
            previous_network = identity.get("network")
            recheck_budget = session_budget.restart() if session_budget else None
            _, identity = await check_session(page, target, wait_seconds, recheck_budget)
            if identity["current_plan"] != "free":
                raise Stop("incompatible_existing_subscription")
            if os.environ.get("AUTO_RECHARGE_CALLBACK_URL"):
                identity["network"] = await observe_page_network(page, recheck_budget)
                if (not previous_network or any(identity["network"][key] != previous_network[key]
                                                for key in ("ip", "country"))):
                    raise Stop("proxy_ip_changed_during_login")
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
        stage = "quote_read"
        progress(stage)
        quote, quote_text, quote_meta = await quote_with_page_recovery(
            page, guard, target_plan, spec["family"], quote_handler, existing,
            session_budget, quote_timeout,
        )
        if urlsplit(page.url).hostname not in ("chatgpt.com", "checkout.stripe.com"):
            raise Stop("unexpected_checkout_origin", **quote_meta)
        if (not quote or not quote["today"] or quote["plan"] not in (target_plan, spec["family"])) and not quote_handler:
            if existing and not checkout_page_matches(page.url, guard.checkout_id):
                raise Stop("existing_checkout_unavailable", **quote_meta)
            await wait_for_user("quote_needs_review_or_billing", wait_seconds)
            # 验证可能带来账户变化；另开同一上下文页面，只做官方身份核对。
            check_page = await context.new_page()
            await check_page.goto(ORIGIN + "/", wait_until="domcontentloaded")
            _, identity = await check_session(check_page, target, 0)
            await check_page.close()
            quote_text = await page.locator("body").inner_text()
            quote = await quote_from_page(page, guard.result.get("returned_currency"))
        if not quote or quote["plan"] not in (target_plan, spec["family"]):
            raise Stop("actual_quote_unknown", quote=quote, **quote_meta)
        if quote["plan"] != target_plan:
            raise Stop("checkout_tier_not_verified", quote=quote, **quote_meta)
        # 报价验收必须绑定本次编号；不能只凭页面出现 Plus/金额认定成功。
        if not checkout_page_matches(page.url, guard.checkout_id):
            raise Stop("checkout_page_identifier_unverified", quote=quote, **quote_meta)
        initial_status = "checkout_quote_verified" if quote.get("today") else "checkout_ready_for_billing"
        result = {"status": initial_status, **identity, **guard.summary(),
                  "checkout_status": "created", "checkout_identifier": guard.checkout_id,
                  "quote": quote, "initial_quote": quote,
                  "subscription_status": "not_verified",
                  "stage": "quote_ready" if quote.get("today") else "details_required",
                  **quote_meta}
        if existing:
            result["inspection_only"] = True
        if ledger:
            ledger.finish(result)
        progress("quote_ready" if quote.get("today") else "details_required", initial_quote=quote)
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
        if stage == "session_restore" and session_budget:
            result.update(session_budget.snapshot())
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
        failure = session_failure(exc)
        if stage != "session_restore":
            failure["reason"] = "browser_operation_failed"
        result = {**failure, "stage": stage, **identity, **guard.summary(),
                  "checkout_status": guard.checkout_status()}
        if stage == "session_restore" and session_budget:
            result.update(session_budget.snapshot())
        if guard.checkout_id:
            result["checkout_identifier"] = guard.checkout_id
        if ledger:
            ledger.finish(result)
        return result
    finally:
        guard.armed = False
        context.remove_listener("response", response_callback)
        if tasks:
            if asyncio.current_task().cancelling():
                for task in tasks:
                    task.cancel()
            await asyncio.gather(*list(tasks), return_exceptions=True)
        if result is not None and quote_handler:
            # 迟到的官方付款回包在清理阶段仍可能确认成功；返回快照必须包含这些证据。
            result.update(guard.summary())
        # 同一窗口更换失效旧结算时，不能叠加上一轮的建单/付款拦截器。
        await context.unroute("**/*", guard.route)


async def run_browser(target, *, create=False, inspect_existing=False, retry_rejected=False,
                      replace_unpaid_checkout=False, state_dir=ROOT / ".state", wait_seconds=0, review_seconds=0,
                      quote_handler=None, guard_factory=NetworkGuard, target_plan="plus", browser=None,
                      browser_context=None, session_budget=None, session_handler=None):
    # 固定项目自己的浏览器，不依赖开源参考目录或全局浏览器缓存。
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(ROOT / ".browsers"))
    # 不允许环境变量意外启动协议调试日志，避免凭据进入终端/文件。
    for key in ("DEBUG", "PWDEBUG", "PW_TRACE_DIR", "PLAYWRIGHT_TRACE_DIR"):
        os.environ.pop(key, None)
    from playwright.async_api import async_playwright
    if inspect_existing and (create or retry_rejected or replace_unpaid_checkout):
        raise Stop("invalid_operation_combination")
    plan_spec(target_plan)
    existing = existing_checkout(state_dir, target.account_id, target_plan) if inspect_existing else None
    manager = AttemptLedger(state_dir, target.account_id, retry_rejected=retry_rejected,
                            replace_unpaid_checkout=replace_unpaid_checkout,
                            target_plan=target_plan) if create else nullcontext()

    async def execute(active_browser=None, active_context=None):
        context = active_context or await active_browser.new_context(
            service_workers="block", accept_downloads=False)
        try:
            return await workflow(context, target, ledger=ledger, existing=existing,
                                  wait_seconds=wait_seconds, review_seconds=review_seconds,
                                  quote_handler=quote_handler, guard_factory=guard_factory, target_plan=target_plan,
                                  session_budget=session_budget, session_handler=session_handler)
        finally:
            # 服务器 Worker 关闭隔离 Context；本机比特浏览器保留原窗口与登录状态。
            if active_context is None:
                await context.close()

    with manager as ledger:
        if browser_context is not None:
            return await execute(active_context=browser_context)
        if browser is not None:
            return await execute(browser)
        async with async_playwright() as p:
            owned_browser = await p.chromium.launch(headless=False)
            try:
                return await execute(owned_browser)
            finally:
                await owned_browser.close()
