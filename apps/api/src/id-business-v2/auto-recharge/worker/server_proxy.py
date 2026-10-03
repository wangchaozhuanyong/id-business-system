"""Resolve one task's configured proxy without logging extraction URLs or credentials."""
from __future__ import annotations

import ipaddress
import asyncio
import json
import re
import socket
from urllib.parse import unquote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler

from checkout_core import Stop
from browser_session import SessionBudget

EXIT_TIMEOUT_SECONDS = 35
RESOLVE_TIMEOUT_SECONDS = 20
CLEANUP_TIMEOUT_SECONDS = 5
PREPARE_TIMEOUT_SECONDS = 20
MAX_PROXY_ATTEMPTS = 10


async def finish_cleanup(operation):
    """清理失败不能无限拖住结果回传，也不能覆盖已确认的付款证据。"""
    try:
        await asyncio.wait_for(operation(), timeout=CLEANUP_TIMEOUT_SECONDS)
        return True
    except Exception:
        return False


async def close_resource(resource):
    return await finish_cleanup(resource.close)


async def resolve(config, *, cancelled=lambda: False):
    """一次提取共用总预算；超时或取消绝不再次提取、更换代理。"""
    budget = SessionBudget(RESOLVE_TIMEOUT_SECONDS, cancelled=cancelled)
    try:
        return await budget.run(lambda: asyncio.to_thread(resolve_proxy, config), "proxy_resolving")
    except Stop as error:
        if error.report.get("reason") == "session_load_timeout":
            raise Stop("server_proxy_unavailable", error_type="TimeoutError") from None
        raise


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def public_host(host):
    if not isinstance(host, str) or not host or len(host) > 253:
        raise Stop("server_proxy_invalid")
    try:
        addresses = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        raise Stop("server_proxy_unavailable") from None
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise Stop("server_proxy_invalid")
    return host


def endpoint(host, port, scheme, username="", password=""):
    if scheme not in {"http", "https", "socks5"} or type(port) is not int or not 1 <= port <= 65535:
        raise Stop("server_proxy_invalid")
    public_host(host)
    if (not isinstance(username, str) or not isinstance(password, str) or
            len(username) > 256 or len(password) > 256 or
            any(ord(c) < 32 or ord(c) == 127 for c in username + password)):
        raise Stop("server_proxy_invalid")
    address = f"[{host}]" if ":" in host else host
    return {"server": f"{scheme}://{address}:{port}", "username": username, "password": password}


def parse_extracted(raw, scheme):
    raw = raw.strip()
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        value = raw
    if isinstance(value, dict):
        if "data" in value and isinstance(value["data"], dict):
            value = value["data"]
        host = value.get("host") or value.get("ip")
        port = value.get("port")
        try:
            port = int(port)
        except (TypeError, ValueError):
            raise Stop("server_proxy_invalid") from None
        return endpoint(host, port, scheme, value.get("username") or value.get("user") or "",
                        value.get("password") or value.get("pass") or "")
    if not isinstance(value, str) or len(value) > 1024 or "\n" in value:
        raise Stop("server_proxy_invalid")
    if "://" not in value and value.count(":") == 3 and "[" not in value:
        host, port, username, password = value.split(":", 3)
        try:
            return endpoint(host, int(port), scheme, username, password)
        except ValueError:
            raise Stop("server_proxy_invalid") from None
    candidate = value if "://" in value else f"{scheme}://{value}"
    try:
        parsed = urlsplit(candidate)
        if parsed.scheme != scheme or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError()
        if re.search(r"%(?![0-9a-fA-F]{2})", (parsed.username or "") + (parsed.password or "")):
            raise ValueError()
        return endpoint(parsed.hostname, parsed.port, scheme,
                        unquote(parsed.username or "", errors="strict"),
                        unquote(parsed.password or "", errors="strict"))
    except ValueError:
        raise Stop("server_proxy_invalid") from None


def resolve_proxy(config):
    if not isinstance(config, dict) or config.get("type") not in {"http", "https", "socks5"}:
        raise Stop("server_proxy_invalid")
    if config.get("mode") == "static":
        return endpoint(config.get("host"), config.get("port"), config["type"],
                        config.get("username", ""), config.get("password", ""))
    if config.get("mode") != "dynamic":
        raise Stop("server_proxy_invalid")
    url = config.get("extractionUrl")
    try:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.fragment:
            raise ValueError()
        public_host(parsed.hostname)
        request = Request(url, headers={"Accept": "application/json, text/plain"})
        with build_opener(ProxyHandler({}), NoRedirect).open(request, timeout=12) as response:
            if response.status != 200:
                raise Stop("server_proxy_unavailable")
            raw = response.read(2049)
        if len(raw) > 2048:
            raise Stop("server_proxy_invalid")
        return parse_extracted(raw.decode("utf-8"), config["type"])
    except (TypeError, ValueError, OSError, UnicodeError):
        raise Stop("server_proxy_unavailable") from None


async def observe_exit(context, *, cancelled=lambda: False, budget=None, attempts=2):
    """Check the browser's real egress through its configured proxy before login."""
    budget = budget or SessionBudget(EXIT_TIMEOUT_SECONDS, cancelled=cancelled)
    page, network = None, None
    try:
        page = await budget.run(context.new_page, "proxy_page_create")
        # 只重试只读出口探测，沿用同一代理和 Context，不重建登录或付款任务。
        for attempt in range(attempts):
            try:
                response = await budget.run(lambda: page.goto(
                    "https://chatgpt.com/cdn-cgi/trace", wait_until="commit",
                    timeout=min(15000, budget.remaining_ms())), "proxy_navigation")
                if attempts == 1 and response is not None and response.status == 403:
                    raise Stop("verification_required", user_action_required=True)
                if (response is None or response.status != 200 or
                        urlsplit(response.url).scheme != "https" or
                        urlsplit(response.url).hostname != "chatgpt.com" or
                        urlsplit(response.url).path != "/cdn-cgi/trace"):
                    raise Stop("proxy_network_unconfirmed")
                raw = await budget.run(response.text, "proxy_response_read")
                if len(raw) > 4096:
                    raise Stop("proxy_network_unconfirmed")
                values = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
                address = ipaddress.ip_address(values.get("ip", ""))
                country = values.get("loc", "")
                if not address.is_global or not re.fullmatch(r"[A-Z]{2}", country):
                    raise Stop("proxy_network_unconfirmed")
                network = {"ip": str(address), "country": country}
                return network
            except Stop as error:
                if error.report.get("reason") in {"operation_cancelled", "session_load_timeout", "verification_required"}:
                    raise
                if attempt == attempts - 1:
                    raise Stop("proxy_network_unconfirmed") from None
            except Exception:
                if attempt == attempts - 1:
                    raise Stop("proxy_network_unconfirmed") from None
    except Stop as error:
        if error.report.get("reason") == "session_load_timeout":
            raise Stop("proxy_network_unconfirmed", error_type="TimeoutError") from None
        raise
    except Exception:
        raise Stop("proxy_network_unconfirmed") from None
    finally:
        if page is not None:
            closed = await close_resource(page)
            if network is not None and not closed:
                raise Stop("proxy_network_unconfirmed") from None


async def prepare_browser(config, launch_browser, *, expected_country, target_url,
                          cancelled=lambda: False, progress=lambda stage, **details: None,
                          previous_ip=None, allow_retry=True):
    """只读准备成功后交还唯一窗口；绝不重放登录、注册或付款。

    每次提取最多20秒，内核启动沿用自身上限；Context、出口探测与官网
    初始导航共用20秒。动态代理最多10次（含首次），静态/原单复查仅一次。
    """
    from browser_password_login import official_login_page, login_payment_write

    limit = MAX_PROXY_ATTEMPTS if allow_retry and isinstance(config, dict) and config.get("mode") == "dynamic" else 1
    seen_ips = set()
    retryable = {"server_proxy_unavailable", "proxy_network_unconfirmed",
                 "proxy_country_mismatch", "proxy_ip_not_rotated"}

    async def prepare_guard(route):
        request = route.request
        parsed = urlsplit(request.url)
        business_write = request.method not in {"GET", "HEAD", "OPTIONS"} and (
            parsed.hostname == 'pay.openai.com' or (parsed.hostname == 'chatgpt.com' and
            re.search(r'/(payments?|billing|checkout|subscriptions?|subscribe|purchase)(?:/|$)', parsed.path)))
        account_write = request.method not in {"GET", "HEAD", "OPTIONS"} and (
            request.is_navigation_request() or (official_login_page(request.url) and
            re.search(r'/(login|sign-in|signin|signup|sign-up|register|registration|authenticate|authorize)(?:/|$)', parsed.path, re.I)))
        # 空白Context不注入账号Cookie、不输入账号资料；允许官网匿名页面初始化。
        if account_write or login_payment_write(request.method, request.url) or business_write:
            await route.abort("blockedbyclient")
        else:
            await route.fallback()

    for attempt in range(1, limit + 1):
        if cancelled():
            raise Stop("operation_cancelled")
        details = {"proxy_attempt": attempt, "proxy_attempt_limit": limit,
                   "proxy_wait_seconds": PREPARE_TIMEOUT_SECONDS}
        browser, proxy, phase = None, None, "extract"
        try:
            progress("proxy_resolving", **details)
            proxy = await resolve(config, cancelled=cancelled)
            if cancelled():
                raise Stop("operation_cancelled")
            phase = "launch"
            browser = await launch_browser(proxy)
            phase = "probe"
            progress("proxy_verifying", **details)
            budget = SessionBudget(PREPARE_TIMEOUT_SECONDS, cancelled=cancelled)
            context = await budget.run(lambda: browser.new_context(
                proxy=proxy, service_workers="block", accept_downloads=False), "proxy_context_create")
            await budget.run(lambda: context.route("**/*", prepare_guard), "proxy_readonly_guard")
            network = await observe_exit(context, cancelled=cancelled, budget=budget, attempts=1)
            if network["country"] != expected_country:
                raise Stop("proxy_country_mismatch")
            if network["ip"] == previous_ip or network["ip"] in seen_ips:
                raise Stop("proxy_ip_not_rotated")
            seen_ips.add(network["ip"])
            page = await budget.run(context.new_page, "proxy_page_create")
            response = await budget.run(lambda: page.goto(
                target_url, wait_until="domcontentloaded", timeout=0), "proxy_page_load")
            if response is None or not official_login_page(page.url):
                raise Stop("proxy_network_unconfirmed")
            if response.status >= 500:
                raise Stop("proxy_network_unconfirmed")
            if response.status >= 400 and response.status != 403:
                raise Stop("http_error", http_status=response.status)
            # 403/本人验证不是连接超时，不通过换IP重试验证挑战。
            if not await finish_cleanup(lambda: context.unroute("**/*", prepare_guard)):
                raise Stop("proxy_cleanup_failed")
            budget.check_cancelled()
            return {"browser": browser, "context": context, "page": page,
                    "proxy": proxy, "network": network}
        except asyncio.CancelledError:
            if browser is not None:
                await close_resource(browser)
            if proxy is not None:
                proxy.clear()
            raise
        except Exception as error:
            cleaned = browser is None or await close_resource(browser)
            if proxy is not None:
                proxy.clear()
            if cancelled():
                raise Stop("operation_cancelled") from None
            if not cleaned:
                raise Stop("proxy_cleanup_failed") from None
            if isinstance(error, Stop):
                reason = error.report.get("reason")
                if reason == "session_load_timeout":
                    reason = "proxy_network_unconfirmed"
            elif phase == "probe":
                reason = "proxy_network_unconfirmed"
            else:
                raise
            if reason not in retryable or limit == 1:
                if isinstance(error, Stop) and error.report.get("reason") == reason:
                    raise
                raise Stop(reason) from None
            if attempt == limit:
                raise Stop("proxy_retry_exhausted", **details) from None
            progress("proxy_retrying", **details)
