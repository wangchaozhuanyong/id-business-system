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


def audio_option(remote_url: str, extract_audio: bool = False) -> dict[str, Any]:
    return {
        "formatId": "audio",
        "mediaType": "audio",
        "label": "视频原声（下载时检测音轨）" if extract_audio else "作品配乐",
        "extension": "mp3",
        "estimatedBytes": None,
        "width": None,
        "height": None,
        "remoteUrl": remote_url,
        "extractAudio": extract_audio,
    }


async def fetch(url: str) -> dict[str, Any]:
    from f2.apps.douyin.utils import AwemeIdFetcher

    aweme_id = await AwemeIdFetcher.get_aweme_id(url)
    try:
        # The public share page includes album images even when a short link
        # redirects to /share/video/. Do not infer the media type from the URL.
        return await fetch_public_share(aweme_id)
    except Exception:
        pass
    if "/note/" in url:
        return await fetch_with_f2(aweme_id)
    try:
        return await fetch_jingxuan(aweme_id)
    except Exception:
        # The public official page does not expose every work type; F2 remains the compatibility path.
        return await fetch_with_f2(aweme_id)


async def fetch_public_share(aweme_id: str) -> dict[str, Any]:
    import httpx

    page_url = f"https://www.iesdouyin.com/share/video/{aweme_id}"
    headers = {"User-Agent": JINGXUAN_USER_AGENT}
    async with httpx.AsyncClient(headers=headers, follow_redirects=False, timeout=8, trust_env=False) as client:
        # The public page sometimes returns only its client-rendered shell.
        # Allow one retry; never retry an explicit denied response.
        for _attempt in range(2):
            response = await client.get(page_url)
            if response.status_code != 200 or len(response.content) > 2 * 1024 * 1024:
                raise ValueError("upstream")
            marker_index = response.text.find("window._ROUTER_DATA")
            if marker_index < 0:
                raise ValueError("upstream")
            object_index = response.text.find("{", marker_index)
            if object_index < 0:
                raise ValueError("upstream")
            data, _end = json.JSONDecoder().raw_decode(response.text[object_index:])
            routes = data.get("loaderData") or {}
            items = []
            for route in routes.values():
                if isinstance(route, dict):
                    items.extend((route.get("videoInfoRes") or {}).get("item_list") or [])
            item = next((item for item in items if isinstance(item, dict) and str(item.get("aweme_id")) == aweme_id), None)
            if item:
                return public_share_media(item, {**headers, "Referer": page_url})
    raise ValueError("platform_limited")


def public_share_media(item: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    def first_url(address: Any) -> str | None:
        urls = (address.get("url_list") or []) if isinstance(address, dict) else []
        return next((url for url in urls if isinstance(url, str) and url.startswith("https://")), None)

    video = item.get("video") or {}
    images = item.get("images") or []
    options = []
    for index, image in enumerate(images):
        remote_url = first_url(image)
        if not remote_url:
            # Never silently return a partial album.
            raise ValueError("unsupported")
        options.append({
            "formatId": f"image:{index}", "mediaType": "image", "label": f"图片 {index + 1}",
            "extension": "jpg", "estimatedBytes": None,
            "width": positive_integer(image.get("width")), "height": positive_integer(image.get("height")),
            "remoteUrl": remote_url,
            "remoteUrls": [url for url in image.get("url_list") or [] if isinstance(url, str) and url.startswith("https://")][:4],
        })
    if not images:
        variants = sorted(
            [entry for entry in video.get("bit_rate") or [] if media_url_from_bit_rate(entry)],
            key=lambda entry: positive_integer(entry.get("bit_rate")) or 0, reverse=True,
        )
        remote_url = media_url_from_bit_rate(variants[0]) if variants else first_url(video.get("play_addr"))
        if not remote_url:
            raise ValueError("unsupported")
        options.append({
            "formatId": "original", "mediaType": "video", "label": "原始视频",
            "extension": "mp4", "estimatedBytes": None,
            "width": positive_integer(video.get("width")), "height": positive_integer(video.get("height")),
            "remoteUrl": remote_url,
        })
    music_url = first_url((item.get("music") or {}).get("play_url"))
    if music_url:
        options.append(audio_option(music_url))
    elif not images:
        options.append(audio_option(options[0]["remoteUrl"], extract_audio=True))
    duration = positive_integer(video.get("duration"))
    return {
        "title": clean_text(item.get("desc")) or f"抖音作品 {item['aweme_id']}",
        "author": clean_text((item.get("author") or {}).get("nickname")) or None,
        "durationSeconds": round(duration / 1000) if duration else None,
        "mediaType": "image" if images else "video", "options": options, "headers": headers,
    }


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
                "mediaType": "video",
                "label": "原始视频",
                "extension": "mp4",
                "estimatedBytes": positive_integer(metadata.get("size")),
                "width": positive_integer(metadata.get("vwidth")),
                "height": positive_integer(metadata.get("vheight")),
                "remoteUrl": best["main_url"],
            },
            audio_option(best["main_url"], extract_audio=True),
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
        # Empty platform responses are not proof that a public work was deleted.
        raise ValueError("platform_limited")

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
    # Albums may also expose a generated video; keep the original images first.
    if images:
        options = [
            {
                "formatId": f"image:{index}",
                "mediaType": "image",
                "label": f"图片 {index + 1}",
                "extension": "jpg",
                "estimatedBytes": None,
                "width": None,
                "height": None,
                "remoteUrl": image,
            }
            for index, image in enumerate(images)
        ]
        media_type = "image"
    elif bit_rates:
        options.append(
            {
                "formatId": "original",
                "mediaType": "video",
                "label": "原始视频",
                "extension": "mp4",
                "estimatedBytes": None,
                "width": positive_integer(video.get("width")),
                "height": positive_integer(video.get("height")),
                "remoteUrl": media_url_from_bit_rate(bit_rates[0]),
            }
        )
        media_type = "video"
    else:
        raise ValueError("unsupported")

    music = raw.get("music") or {}
    music_urls = (music.get("play_url") or {}).get("url_list") or []
    music_url = next(
        (url for url in music_urls if isinstance(url, str) and url.startswith("http")), None
    )
    if music_url:
        options.append(audio_option(music_url))
    elif media_type == "video":
        options.append(audio_option(options[0]["remoteUrl"], extract_audio=True))

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
        code = str(error) if str(error) in ("private_or_missing", "unsupported", "platform_limited") else "upstream"
        print(json.dumps({"ok": False, "code": code}, separators=(",", ":")))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
