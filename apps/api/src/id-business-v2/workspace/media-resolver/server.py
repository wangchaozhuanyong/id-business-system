#!/usr/bin/env python3
"""Internal, single-item media resolver used by the authenticated V2 workspace API."""

from __future__ import annotations

import ipaddress
import json
import mimetypes
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


MAX_REQUEST_BYTES = 8192
MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024
MAX_REDIRECTS = 5
PORT = int(os.environ.get("MEDIA_RESOLVER_PORT", "8787"))
F2_PYTHON = os.environ.get("F2_PYTHON", "/opt/f2/bin/python")
F2_BRIDGE = "/app/f2_bridge.py"
TASK_SLOTS = threading.BoundedSemaphore(2)
WORKER_TICKET_LOCK = threading.Lock()
WORKER_TICKET_TTL_SECONDS = 10 * 60
MAX_WORKER_TICKETS = 128
MAX_WORKER_TICKET_BYTES = 2 * 1024 * 1024
WORKER_TICKETS: dict[str, dict[str, Any]] = {}

SUPPORTED_HOSTS = {
    "douyin": ("f2", ("douyin.com",)),
    "tiktok": ("yt-dlp", ("tiktok.com",)),
    "youtube": ("yt-dlp", ("youtube.com", "youtu.be")),
    "instagram": ("yt-dlp", ("instagram.com",)),
    "x": ("yt-dlp", ("x.com", "twitter.com")),
    "bilibili": ("yt-dlp", ("bilibili.com", "b23.tv")),
    "facebook": ("yt-dlp", ("facebook.com", "fb.watch")),
    "vimeo": ("yt-dlp", ("vimeo.com",)),
    "reddit": ("yt-dlp", ("reddit.com", "redd.it")),
    "soundcloud": ("yt-dlp", ("soundcloud.com",)),
    "twitch": ("yt-dlp", ("twitch.tv",)),
    "pinterest": ("yt-dlp", ("pinterest.com", "pin.it")),
    "dailymotion": ("yt-dlp", ("dailymotion.com", "dai.ly")),
    "weibo": ("yt-dlp", ("weibo.com", "weibo.cn")),
}

YTDLP_FORMATS = {
    "best": "bestvideo*+bestaudio/best",
    "hd1080": "bestvideo*[height<=1080]+bestaudio/best[height<=1080]/best",
    "hd720": "bestvideo*[height<=720]+bestaudio/best[height<=720]/best",
    "audio": "bestaudio/best",
}

DOUYIN_MEDIA_HOSTS = (
    "byteimg.com",
    "bytevcloud.com",
    "douyinpic.com",
    "douyinvod.com",
    "iesdouyin.com",
    "ibytedtos.com",
)


class WorkerError(Exception):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


class SilentYtdlpLogger:
    def debug(self, _message: str) -> None:
        return

    def info(self, _message: str) -> None:
        return

    def warning(self, _message: str) -> None:
        return

    def error(self, _message: str) -> None:
        return


def prune_worker_tickets_locked(now: float) -> None:
    expired_tokens = [
        token for token, ticket in WORKER_TICKETS.items() if ticket["expiresAt"] <= now
    ]
    for token in expired_tokens:
        WORKER_TICKETS.pop(token, None)


def is_worker_token(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 43
        and all(
            character.isascii() and (character.isalnum() or character in "_-")
            for character in value
        )
    )


def create_worker_ticket(
    url: str,
    platform: str,
    engine: str,
    media: dict[str, Any],
) -> str:
    try:
        serialized = json.dumps(media, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise WorkerError("upstream", 502) from error
    if not serialized or len(serialized) > MAX_WORKER_TICKET_BYTES:
        raise WorkerError("upstream", 502)

    now = time.monotonic()
    with WORKER_TICKET_LOCK:
        prune_worker_tickets_locked(now)
        if len(WORKER_TICKETS) >= MAX_WORKER_TICKETS:
            raise WorkerError("busy", 429)
        token = secrets.token_urlsafe(32)
        while token in WORKER_TICKETS:
            token = secrets.token_urlsafe(32)
        WORKER_TICKETS[token] = {
            "engine": engine,
            "expiresAt": now + WORKER_TICKET_TTL_SECONDS,
            "media": serialized,
            "platform": platform,
            "url": url,
        }
    return token


def read_worker_ticket(
    token: str,
    url: str,
    platform: str,
    engine: str,
) -> dict[str, Any]:
    now = time.monotonic()
    with WORKER_TICKET_LOCK:
        prune_worker_tickets_locked(now)
        ticket = WORKER_TICKETS.get(token)
        if (
            not ticket
            or ticket["url"] != url
            or ticket["platform"] != platform
            or ticket["engine"] != engine
        ):
            raise WorkerError("ticket_expired", 410)
        serialized = ticket["media"]
    try:
        media = json.loads(serialized)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WorkerError("upstream", 502) from error
    if not isinstance(media, dict):
        raise WorkerError("upstream", 502)
    return media


def require_media_input(payload: dict[str, Any]) -> tuple[str, str, str]:
    url = payload.get("url")
    platform = payload.get("platform")
    engine = payload.get("engine")
    if not isinstance(url, str) or not isinstance(platform, str) or not isinstance(engine, str):
        raise WorkerError("invalid_input")
    if platform not in SUPPORTED_HOSTS:
        raise WorkerError("unsupported")
    expected_engine, allowed_hosts = SUPPORTED_HOSTS[platform]
    if engine != expected_engine:
        raise WorkerError("unsupported")
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if (
        parsed.scheme not in ("http", "https")
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 80, 443)
        or not any(hostname == host or hostname.endswith(f".{host}") for host in allowed_hosts)
    ):
        raise WorkerError("unsupported")
    return url, platform, engine


def assert_public_remote_url(url: str) -> None:
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if (
        parsed.scheme not in ("http", "https")
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 80, 443)
        or not hostname
    ):
        raise WorkerError("upstream", 502)
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(hostname, parsed.port or 443, type=socket.SOCK_STREAM)
        }
    except OSError as error:
        raise WorkerError("upstream", 502) from error
    if not addresses:
        raise WorkerError("upstream", 502)
    for address in addresses:
        try:
            if not ipaddress.ip_address(address).is_global:
                raise WorkerError("upstream", 502)
        except ValueError as error:
            raise WorkerError("upstream", 502) from error


def resolve_media(payload: dict[str, Any]) -> dict[str, Any]:
    url, platform, engine = require_media_input(payload)
    if engine == "f2":
        return resolve_douyin(url, platform)
    return resolve_with_ytdlp(url, platform)


def resolve_douyin(url: str, platform: str) -> dict[str, Any]:
    media = fetch_douyin_media(url)
    worker_token = create_worker_ticket(url, platform, "f2", media)
    return {
        "title": media["title"],
        "author": media.get("author"),
        "durationSeconds": media.get("durationSeconds"),
        "mediaType": media["mediaType"],
        "options": [
            {
                **{key: value for key, value in option.items() if key != "remoteUrl"},
                "workerToken": worker_token,
            }
            for option in media["options"]
        ],
    }


def fetch_douyin_media(url: str) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            [F2_PYTHON, F2_BRIDGE],
            input=json.dumps({"url": url}),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            cwd="/tmp",
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise WorkerError("upstream", 502) from error
    try:
        output_lines = [line for line in completed.stdout.splitlines() if line.strip()]
        result = json.loads(output_lines[-1])
    except (IndexError, json.JSONDecodeError) as error:
        raise WorkerError("upstream", 502) from error
    if completed.returncode != 0 or not isinstance(result, dict) or not result.get("ok"):
        code = result.get("code") if isinstance(result, dict) else None
        status = 400 if code in ("private_or_missing", "unsupported") else 502
        raise WorkerError(code if status == 400 else "upstream", status)
    media = result.get("media")
    if not isinstance(media, dict):
        raise WorkerError("upstream", 502)
    return media


def resolve_with_ytdlp(url: str, platform: str) -> dict[str, Any]:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError

    try:
        with YoutubeDL(ytdlp_options(download=False)) as ydl:
            info = ydl.extract_info(url, download=False)
    except DownloadError as error:
        raise classify_ytdlp_error(error) from error
    if not isinstance(info, dict) or info.get("_type") in ("playlist", "multi_video"):
        raise WorkerError("unsupported")

    formats = [item for item in info.get("formats") or [] if isinstance(item, dict)]
    has_video = any(item.get("vcodec") not in (None, "none") for item in formats)
    has_audio = any(item.get("acodec") not in (None, "none") for item in formats)
    if not has_video and not has_audio:
        raise WorkerError("unsupported")
    worker_token = create_worker_ticket(
        url,
        platform,
        "yt-dlp",
        YoutubeDL.sanitize_info(info, remove_private_keys=False),
    )

    if has_video:
        heights = [positive_integer(item.get("height")) for item in formats]
        widths = [positive_integer(item.get("width")) for item in formats]
        max_height = max((item for item in heights if item), default=None)
        max_width = max((item for item in widths if item), default=None)
        options = [
            download_option(
                "best", "最佳画质（自动合并）", "mp4", info, max_width, max_height, worker_token
            )
        ]
        if max_height and max_height > 1080:
            options.append(
                download_option("hd1080", "1080P", "mp4", info, None, 1080, worker_token)
            )
        if max_height and max_height > 720:
            options.append(
                download_option("hd720", "720P", "mp4", info, None, 720, worker_token)
            )
        media_type = "video"
    else:
        options = [
            download_option("audio", "最高音质", "mp3", info, None, None, worker_token)
        ]
        media_type = "audio"

    return {
        "title": clean_text(info.get("title")) or "未命名作品",
        "author": clean_text(info.get("uploader") or info.get("channel") or info.get("creator")) or None,
        "durationSeconds": positive_number(info.get("duration")),
        "mediaType": media_type,
        "options": options,
    }


def download_option(
    format_id: str,
    label: str,
    extension: str,
    info: dict[str, Any],
    width: int | None,
    height: int | None,
    worker_token: str,
) -> dict[str, Any]:
    return {
        "formatId": format_id,
        "label": label,
        "extension": extension,
        "estimatedBytes": positive_integer(info.get("filesize") or info.get("filesize_approx")),
        "width": width,
        "height": height,
        "workerToken": worker_token,
    }


def download_media(payload: dict[str, Any], directory: Path) -> tuple[Path, str]:
    url, platform, engine = require_media_input(payload)
    format_id = payload.get("formatId")
    worker_token = payload.get("workerToken")
    if not isinstance(format_id, str) or not is_worker_token(worker_token):
        raise WorkerError("invalid_input")
    cached = read_worker_ticket(worker_token, url, platform, engine)
    if engine == "f2":
        return download_douyin(cached, format_id, directory)
    return download_with_ytdlp(cached, format_id, directory)


def download_douyin(media: dict[str, Any], format_id: str, directory: Path) -> tuple[Path, str]:
    option = next(
        (item for item in media.get("options") or [] if item.get("formatId") == format_id),
        None,
    )
    if not isinstance(option, dict):
        raise WorkerError("unsupported")
    remote_url = option.get("remoteUrl")
    default_extension = option.get("extension")
    headers = media.get("headers")
    if not remote_url:
        raise WorkerError("unsupported")
    if not isinstance(default_extension, str) or not isinstance(headers, dict):
        raise WorkerError("upstream", 502)
    return fetch_remote_file(remote_url, headers, directory, default_extension)


def assert_allowed_douyin_media_url(url: str) -> None:
    hostname = (urlparse(url).hostname or "").lower().rstrip(".")
    if not any(hostname == host or hostname.endswith(f".{host}") for host in DOUYIN_MEDIA_HOSTS):
        raise WorkerError("upstream", 502)


def fetch_remote_file(
    remote_url: str,
    headers: dict[str, str],
    directory: Path,
    default_extension: str,
) -> tuple[Path, str]:
    current_url = remote_url
    opener = build_opener(ProxyHandler({}), NoRedirectHandler())
    for _redirect in range(MAX_REDIRECTS + 1):
        assert_allowed_douyin_media_url(current_url)
        assert_public_remote_url(current_url)
        request = Request(current_url, headers=headers, method="GET")
        try:
            response = opener.open(request, timeout=30)
        except HTTPError as error:
            if error.code in (301, 302, 303, 307, 308):
                location = error.headers.get("location")
                error.close()
                if not location:
                    raise WorkerError("upstream", 502)
                current_url = urljoin(current_url, location)
                continue
            error.close()
            if error.code in (401, 403, 404, 410):
                raise WorkerError("private_or_missing") from error
            raise WorkerError("upstream", 502) from error
        except (OSError, URLError) as error:
            raise WorkerError("upstream", 502) from error
        with response:
            if response.status < 200 or response.status >= 300:
                raise WorkerError("upstream", 502)
            declared_size = positive_integer(response.headers.get("content-length"))
            if declared_size and declared_size > MAX_DOWNLOAD_BYTES:
                raise WorkerError("too_large")
            content_type = response.headers.get("content-type")
            normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
            if not normalized_content_type.startswith(("video/", "image/")):
                raise WorkerError("upstream", 502)
            extension = extension_from_content_type(content_type, default_extension)
            target = directory / f"media.{extension}"
            written = 0
            with target.open("wb") as output:
                while chunk := response.read(64 * 1024):
                    written += len(chunk)
                    if written > MAX_DOWNLOAD_BYTES:
                        raise WorkerError("too_large")
                    output.write(chunk)
            if written <= 0:
                raise WorkerError("upstream", 502)
            return (
                target,
                content_type or mimetypes.guess_type(target)[0] or "application/octet-stream",
            )
    raise WorkerError("upstream", 502)


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any):
        return None


def download_with_ytdlp(info: dict[str, Any], format_id: str, directory: Path) -> tuple[Path, str]:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError

    if format_id not in YTDLP_FORMATS:
        raise WorkerError("unsupported")

    def enforce_size(progress: dict[str, Any]) -> None:
        downloaded = positive_integer(progress.get("downloaded_bytes")) or 0
        estimated = positive_integer(progress.get("total_bytes") or progress.get("total_bytes_estimate")) or 0
        if downloaded > MAX_DOWNLOAD_BYTES or estimated > MAX_DOWNLOAD_BYTES:
            raise WorkerError("too_large")

    options = ytdlp_options(download=True)
    options.update(
        {
            "format": YTDLP_FORMATS[format_id],
            "outtmpl": str(directory / "media.%(ext)s"),
            "max_filesize": MAX_DOWNLOAD_BYTES,
            "progress_hooks": [enforce_size],
            "merge_output_format": "mp4",
        }
    )
    if format_id == "audio":
        options["postprocessors"] = [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"}
        ]
    else:
        options["postprocessors"] = [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}]
    try:
        with YoutubeDL(options) as ydl:
            result = ydl.process_ie_result(info, download=True)
    except WorkerError:
        raise
    except DownloadError as error:
        raise classify_ytdlp_error(error) from error

    candidates = [
        path
        for path in directory.iterdir()
        if path.is_file() and path.suffix not in (".part", ".ytdl")
    ]
    if not candidates:
        requested = result.get("requested_downloads") if isinstance(result, dict) else None
        if requested:
            candidate = requested[0].get("filepath")
            if candidate and Path(candidate).is_file():
                candidates.append(Path(candidate))
    if not candidates:
        raise WorkerError("upstream", 502)
    target = max(candidates, key=lambda path: path.stat().st_size)
    size = target.stat().st_size
    if size <= 0:
        raise WorkerError("upstream", 502)
    if size > MAX_DOWNLOAD_BYTES:
        raise WorkerError("too_large")
    return target, mimetypes.guess_type(target)[0] or "application/octet-stream"


def ytdlp_options(download: bool) -> dict[str, Any]:
    return {
        "logger": SilentYtdlpLogger(),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "playlist_items": "1",
        "skip_download": not download,
        "socket_timeout": 20,
        "retries": 1,
        "extractor_retries": 1,
        "fragment_retries": 1,
        "concurrent_fragment_downloads": 2,
        "proxy": "",
        "cachedir": False,
        "format_sort": ["ext:mp4:m4a", "res", "br"],
        "js_runtimes": {"deno": {}},
    }


def classify_ytdlp_error(error: Exception) -> WorkerError:
    message = str(error).lower()
    if "larger than max-filesize" in message or "file is larger" in message:
        return WorkerError("too_large")
    if any(
        phrase in message
        for phrase in (
            "fresh cookies",
            "login required",
            "login to confirm",
            "requires authentication",
            "sign in",
            "use --cookies",
        )
    ):
        return WorkerError("login_required")
    if any(
        phrase in message
        for phrase in (
            "geo restricted",
            "georestricted",
            "not available from your location",
            "not available in your country",
        )
    ):
        return WorkerError("region_restricted")
    if any(
        phrase in message
        for phrase in (
            "account is private",
            "has been deleted",
            "private video",
            "this video is unavailable",
            "video is unavailable",
            "404 not found",
        )
    ):
        return WorkerError("private_or_missing")
    if "unsupported url" in message:
        return WorkerError("unsupported")
    return WorkerError("platform_limited", 502)


def clean_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.replace("\x00", " ").split())[:200]


def positive_number(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None


def positive_integer(value: Any) -> int | None:
    try:
        parsed = int(float(value))
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None


def extension_from_content_type(content_type: str | None, fallback: str) -> str:
    normalized = (content_type or "").split(";", 1)[0].strip().lower()
    mapping = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "video/mp4": "mp4",
        "video/webm": "webm",
    }
    return mapping.get(normalized, fallback)


class MediaResolverHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "V2MediaResolver/1"

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_json(404, {"code": "not_found"})
            return
        self.send_json(200, {"ok": True})

    def do_POST(self) -> None:
        if self.path not in ("/resolve", "/download"):
            self.send_json(404, {"code": "not_found"})
            return
        if not TASK_SLOTS.acquire(blocking=False):
            self.send_json(429, {"code": "busy"})
            return
        try:
            payload = self.read_payload()
            if self.path == "/resolve":
                self.send_json(200, resolve_media(payload))
                return
            with tempfile.TemporaryDirectory(prefix="v2-media-", dir="/tmp") as temporary:
                path, content_type = download_media(payload, Path(temporary))
                self.send_file(path, content_type)
        except WorkerError as error:
            self.send_json(error.status, {"code": error.code})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            self.send_json(502, {"code": "upstream"})
        finally:
            TASK_SLOTS.release()

    def read_payload(self) -> dict[str, Any]:
        content_length = positive_integer(self.headers.get("content-length"))
        if not content_length or content_length > MAX_REQUEST_BYTES:
            raise WorkerError("invalid_input")
        try:
            payload = json.loads(self.rfile.read(content_length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise WorkerError("invalid_input") from error
        if not isinstance(payload, dict):
            raise WorkerError("invalid_input")
        return payload

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        content = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def send_file(self, path: Path, content_type: str) -> None:
        size = path.stat().st_size
        if size <= 0 or size > MAX_DOWNLOAD_BYTES:
            raise WorkerError("too_large")
        extension = path.suffix.lower().lstrip(".") or "bin"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("X-Media-Extension", extension)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with path.open("rb") as source:
            shutil.copyfileobj(source, self.wfile, length=64 * 1024)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


class MediaResolverServer(ThreadingHTTPServer):
    daemon_threads = True


def self_test() -> None:
    assert require_media_input(
        {"url": "https://v.douyin.com/example/", "platform": "douyin", "engine": "f2"}
    )[2] == "f2"
    assert require_media_input(
        {"url": "https://youtu.be/example", "platform": "youtube", "engine": "yt-dlp"}
    )[2] == "yt-dlp"
    try:
        require_media_input(
            {
                "url": "https://youtube.com.attacker.invalid/watch?v=1",
                "platform": "youtube",
                "engine": "yt-dlp",
            }
        )
    except WorkerError:
        pass
    else:
        raise AssertionError("host suffix boundary was not enforced")
    assert classify_ytdlp_error(Exception("Fresh cookies are needed")).code == "login_required"
    assert classify_ytdlp_error(Exception("not available in your country")).code == "region_restricted"
    assert classify_ytdlp_error(Exception("unexpected challenge response")).code == "platform_limited"
    worker_token = create_worker_ticket(
        "https://youtu.be/example", "youtube", "yt-dlp", {"title": "example"}
    )
    assert is_worker_token(worker_token)
    assert not is_worker_token("é" * 43)
    assert read_worker_ticket(
        worker_token, "https://youtu.be/example", "youtube", "yt-dlp"
    ) == {"title": "example"}
    try:
        read_worker_ticket(worker_token, "https://youtu.be/other", "youtube", "yt-dlp")
    except WorkerError as error:
        assert error.code == "ticket_expired"
    else:
        raise AssertionError("worker ticket was not bound to the source URL")
    with WORKER_TICKET_LOCK:
        WORKER_TICKETS[worker_token]["expiresAt"] = time.monotonic() - 1
    try:
        read_worker_ticket(worker_token, "https://youtu.be/example", "youtube", "yt-dlp")
    except WorkerError as error:
        assert error.code == "ticket_expired"
    else:
        raise AssertionError("expired worker ticket was accepted")


if __name__ == "__main__":
    if "--self-test" in os.sys.argv:
        self_test()
    else:
        MediaResolverServer(("0.0.0.0", PORT), MediaResolverHandler).serve_forever()
