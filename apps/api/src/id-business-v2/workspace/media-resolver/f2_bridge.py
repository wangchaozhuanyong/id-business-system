#!/usr/bin/env python3
"""Douyin subprocess bridge, isolated from yt-dlp's incompatible dependencies."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Any


JINGXUAN_USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 Mobile/15E148"
)

for logger_name in ("f2", "f2-trace"):
    dependency_logger = logging.getLogger(logger_name)
    dependency_logger.handlers.clear()
    dependency_logger.addHandler(logging.NullHandler())
    dependency_logger.propagate = False


def clean_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.replace("\x00", " ").split())[:200]


def positive_integer(value: Any) -> int | None:
    try:
        parsed = int(float(value))
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None


def media_url_from_bit_rate(item: Any) -> str | None:
    if not isinstance(item, dict):
        return None
    urls = (item.get("play_addr") or {}).get("url_list") or []
    return next((url for url in urls if isinstance(url, str) and url.startswith("http")), None)


async def fetch(url: str) -> dict[str, Any]:
    from f2.apps.douyin.utils import AwemeIdFetcher

    aweme_id = await AwemeIdFetcher.get_aweme_id(url)
    try:
        return await fetch_jingxuan(aweme_id)
    except Exception:
        # The public official page does not expose every work type; F2 remains the compatibility path.
        return await fetch_with_f2(aweme_id)


async def fetch_jingxuan(aweme_id: str) -> dict[str, Any]:
    import httpx

    page_url = f"https://jingxuan.douyin.com/m/video/{aweme_id}"
    headers = {
        "User-Agent": JINGXUAN_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    async with httpx.AsyncClient(
        headers=headers,
        follow_redirects=False,
        timeout=20,
        trust_env=False,
    ) as client:
        response = await client.get(page_url)
    if response.status_code != 200:
        raise ValueError("private_or_missing")

    marker = "window._SSR_DATA"
    marker_index = response.text.find(marker)
    if marker_index < 0:
        raise ValueError("private_or_missing")
    object_index = response.text.find("{", marker_index + len(marker))
    if object_index < 0:
        raise ValueError("private_or_missing")
    try:
        server_data, _end = json.JSONDecoder().raw_decode(response.text[object_index:])
        result = server_data["data"]["storeState"]["detail"]["videoData"]["result"]
        if str(result.get("gid")) != aweme_id:
            raise ValueError("private_or_missing")
        video_model = json.loads(result["video_model"])
        variants = [
            item
            for item in video_model.get("video_list") or []
            if isinstance(item, dict)
            and isinstance(item.get("main_url"), str)
            and item["main_url"].startswith("https://")
        ]
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("private_or_missing") from error
    if not variants:
        raise ValueError("unsupported")
    best = max(
        variants,
        key=lambda item: positive_integer((item.get("video_meta") or {}).get("bitrate")) or 0,
    )
    metadata = best.get("video_meta") or {}
    author = result.get("media_user") or {}
    return {
        "title": clean_text(result.get("abstract") or result.get("title"))
        or f"抖音作品 {aweme_id}",
        "author": clean_text(author.get("screen_name")) or None,
        "durationSeconds": positive_number(video_model.get("video_duration")),
        "mediaType": "video",
        "options": [
            {
                "formatId": "original",
                "label": "原始视频",
                "extension": "mp4",
                "estimatedBytes": positive_integer(metadata.get("size")),
                "width": positive_integer(metadata.get("vwidth")),
                "height": positive_integer(metadata.get("vheight")),
                "remoteUrl": best["main_url"],
            }
        ],
        "headers": {**headers, "Referer": page_url},
    }


async def fetch_with_f2(aweme_id: str) -> dict[str, Any]:
    from f2.apps.douyin.crawler import DouyinCrawler
    from f2.apps.douyin.filter import PostDetailFilter
    from f2.apps.douyin.model import PostDetail
    from f2.apps.douyin.utils import ClientConfManager, TokenManager, VerifyFpManager

    synthetic_cookie = (
        f"ttwid={TokenManager.gen_ttwid()}; "
        f"s_v_web_id={VerifyFpManager.gen_s_v_web_id()}"
    )
    headers = dict(ClientConfManager.headers())
    kwargs = {
        "cookie": synthetic_cookie,
        "headers": headers,
        "proxies": {"http://": None, "https://": None},
    }
    async with DouyinCrawler(kwargs) as crawler:
        response = await crawler.fetch_post_detail(PostDetail(aweme_id=aweme_id))
    media = PostDetailFilter(response)
    if media.nickname_raw is None:
        raise ValueError("private_or_missing")

    raw = media._to_raw().get("aweme_detail") or {}
    video = raw.get("video") or {}
    bit_rates = sorted(
        [item for item in video.get("bit_rate") or [] if media_url_from_bit_rate(item)],
        key=lambda item: int(item.get("bit_rate") or 0),
        reverse=True,
    )
    images = [
        item for item in media.images or [] if isinstance(item, str) and item.startswith("http")
    ]
    options: list[dict[str, Any]] = []
    if bit_rates:
        options.append(
            {
                "formatId": "original",
                "label": "原始视频",
                "extension": "mp4",
                "estimatedBytes": None,
                "width": positive_integer(video.get("width")),
                "height": positive_integer(video.get("height")),
                "remoteUrl": media_url_from_bit_rate(bit_rates[0]),
            }
        )
        media_type = "video"
    elif images:
        options = [
            {
                "formatId": f"image:{index}",
                "label": f"图片 {index + 1}",
                "extension": "jpg",
                "estimatedBytes": None,
                "width": None,
                "height": None,
                "remoteUrl": image,
            }
            for index, image in enumerate(images[:6])
        ]
        media_type = "image"
    else:
        raise ValueError("unsupported")

    headers["Cookie"] = synthetic_cookie
    duration = positive_integer(media.duration)
    return {
        "title": clean_text(media.desc_raw) or f"抖音作品 {media.aweme_id}",
        "author": clean_text(media.nickname_raw) or None,
        "durationSeconds": round(duration / 1000) if duration else None,
        "mediaType": media_type,
        "options": options,
        "headers": headers,
    }


def positive_number(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        url = payload.get("url") if isinstance(payload, dict) else None
        if not isinstance(url, str):
            raise ValueError("unsupported")
        media = asyncio.run(fetch(url))
        print(
            json.dumps(
                {"ok": True, "media": media},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
    except Exception as error:
        code = str(error) if str(error) in ("private_or_missing", "unsupported") else "upstream"
        print(json.dumps({"ok": False, "code": code}, separators=(",", ":")))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
