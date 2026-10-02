"""Resolve one task's configured proxy without logging extraction URLs or credentials."""
from __future__ import annotations

import ipaddress
import json
import re
import socket
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler

from checkout_core import Stop


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
        return endpoint(parsed.hostname, parsed.port, scheme, parsed.username or "", parsed.password or "")
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


async def observe_exit(context):
    """Check the browser's real egress through its configured proxy before login."""
    page = await context.new_page()
    try:
        # 只重试只读出口探测，沿用同一代理和 Context，不重建登录或付款任务。
        for attempt in range(2):
            try:
                response = await page.goto("https://chatgpt.com/cdn-cgi/trace",
                                           wait_until="commit", timeout=15000)
                if (response is None or response.status != 200 or
                        urlsplit(response.url).scheme != "https" or
                        urlsplit(response.url).hostname != "chatgpt.com" or
                        urlsplit(response.url).path != "/cdn-cgi/trace"):
                    raise Stop("proxy_network_unconfirmed")
                raw = await response.text()
                if len(raw) > 4096:
                    raise Stop("proxy_network_unconfirmed")
                values = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
                address = ipaddress.ip_address(values.get("ip", ""))
                country = values.get("loc", "")
                if not address.is_global or not re.fullmatch(r"[A-Z]{2}", country):
                    raise Stop("proxy_network_unconfirmed")
                return {"ip": str(address), "country": country}
            except Exception:
                if attempt == 1:
                    raise Stop("proxy_network_unconfirmed") from None
    finally:
        await page.close()
