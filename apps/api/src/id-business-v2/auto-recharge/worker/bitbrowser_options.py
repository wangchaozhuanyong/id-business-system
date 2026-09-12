"""Validated browser settings and the corresponding BitBrowser API fields."""
from datetime import datetime
import ipaddress
import math
import re
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from checkout_core import Stop

DEFAULTS = {
    "proxyMode": "dynamic", "staticHost": "", "staticPort": 8080,
    "dynamicProvider": "common", "refreshIp": True, "ipCheckService": "ip-api",
    "os": "MacIntel", "languageFromIp": False, "language": "zh-CN",
    "displayLanguageFromIp": False, "displayLanguage": "zh-CN",
    "timezoneFromIp": True, "timezone": "Asia/Kuala_Lumpur",
    "positionFromIp": True, "latitude": 0, "longitude": 0, "accuracy": 100,
    "syncTabs": True, "syncCookies": True, "syncLocalStorage": True,
}
ENUMS = {
    "proxyMode": {"dynamic", "static"},
    "dynamicProvider": {"common", "rola", "doveip", "cloudam"},
    "ipCheckService": {"ip-api", "ip123in", "luminati"},
    "os": {"MacIntel", "Win32", "Linux x86_64"},
}


def invalid():
    raise Stop("invalid_bitbrowser_configuration")


def validate_options(value):
    options = dict(DEFAULTS) if value is None else value
    if not isinstance(options, dict) or set(options) != set(DEFAULTS):
        invalid()
    for key, choices in ENUMS.items():
        if not isinstance(options[key], str) or options[key] not in choices:
            invalid()
    for key, default in DEFAULTS.items():
        if isinstance(default, bool) and not isinstance(options[key], bool):
            invalid()
    for key, low, high in (("staticPort", 1, 65535), ("latitude", -90, 90),
                           ("longitude", -180, 180), ("accuracy", 1, 100000)):
        v = options[key]
        if (isinstance(v, bool) or not isinstance(v, (int, float)) or
                not math.isfinite(v) or not low <= v <= high):
            invalid()
    if options["staticPort"] != int(options["staticPort"]):
        invalid()
    host = options["staticHost"]
    if not isinstance(host, str) or len(host) > 253:
        invalid()
    if host:
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?"
                                r"(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*", host):
                invalid()
    elif options["proxyMode"] == "static":
        invalid()
    for key in ("language", "displayLanguage"):
        if not isinstance(options[key], str) or not re.fullmatch(
                r"[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}", options[key]):
            invalid()
    zone = options["timezone"]
    if not isinstance(zone, str) or len(zone) > 80:
        invalid()
    try:
        ZoneInfo(zone)
    except (ValueError, ZoneInfoNotFoundError):
        invalid()
    return dict(options)


def validate_browser_settings(settings):
    options = validate_options(settings.get("browserOptions"))
    if options["proxyMode"] == "dynamic":
        url = settings.get("dynamicProxyUrl")
        if not isinstance(url, str) or len(url) > 2000 or re.search(r"[\x00-\x1f\x7f]", url):
            invalid()
        try:
            parsed = urlparse(url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
                invalid()
        except ValueError:
            invalid()
    credentials = settings.get("staticProxyCredentials")
    if credentials is not None:
        if not isinstance(credentials, dict) or set(credentials) != {"username", "password"}:
            invalid()
        for v in credentials.values():
            if not isinstance(v, str) or not v.strip() or len(v) > 256 or re.search(r"[\x00-\x1f\x7f]", v):
                invalid()
    return options


def profile_options(settings):
    options = validate_browser_settings(settings)
    fingerprint = {
        "ostype": "PC", "os": options["os"],
        "isIpCreateTimeZone": options["timezoneFromIp"],
        "isIpCreatePosition": options["positionFromIp"],
        "isIpCreateLanguage": options["languageFromIp"], "languages": options["language"],
        "isIpCreateDisplayLanguage": options["displayLanguageFromIp"],
        "displayLanguages": options["displayLanguage"],
    }
    if not options["timezoneFromIp"]:
        fingerprint.update(timeZone=options["timezone"], timeZoneOffset=int(
            datetime.now(ZoneInfo(options["timezone"])).utcoffset().total_seconds()))
    if not options["positionFromIp"]:
        fingerprint.update(position="1", lat=str(options["latitude"]),
                           lng=str(options["longitude"]), precisionData=str(options["accuracy"]))
    result = {
        "proxyMethod": 3 if options["proxyMode"] == "dynamic" else 2,
        "proxyType": settings["proxyType"], "ipCheckService": options["ipCheckService"],
        "syncTabs": options["syncTabs"], "syncCookies": options["syncCookies"],
        "syncLocalStorage": options["syncLocalStorage"], "browserFingerPrint": fingerprint,
    }
    if options["proxyMode"] == "dynamic":
        result.update(dynamicIpUrl=settings["dynamicProxyUrl"],
                      dynamicIpChannel=options["dynamicProvider"],
                      isDynamicIpChangeIp=options["refreshIp"])
    else:
        credentials = settings.get("staticProxyCredentials") or {}
        result.update(host=options["staticHost"], port=int(options["staticPort"]),
                      proxyUserName=credentials.get("username", ""),
                      proxyPassword=credentials.get("password", ""))
    return result
