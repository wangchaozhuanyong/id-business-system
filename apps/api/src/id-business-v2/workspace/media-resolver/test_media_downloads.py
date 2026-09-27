"""Offline regressions for typed video, audio and album downloads."""

import asyncio
import json
from io import BytesIO
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import f2_bridge
import server


class MediaDownloadsTests(unittest.TestCase):
    def tearDown(self):
        server.WORKER_TICKETS.clear()

    def test_public_share_preserves_all_album_images_and_music(self):
        item = {
            "aweme_id": "123", "desc": "图集", "author": {"nickname": "作者"},
            "images": [{"url_list": [f"https://image.douyinpic.com/{index}.jpg"], "width": 100, "height": 200} for index in range(48)],
            "video": {"play_addr": {"url_list": ["https://media.douyinvod.com/generated.mp4"]}},
            "music": {"play_url": {"url_list": ["https://music.pstatp.com/music.mp3"]}},
        }
        media = f2_bridge.public_share_media(item, {})
        self.assertEqual(media["mediaType"], "image")
        self.assertEqual(len(media["options"]), 49)
        self.assertEqual(media["options"][47]["formatId"], "image:47")
        self.assertEqual(media["options"][48]["mediaType"], "audio")
        self.assertFalse(any(option["mediaType"] == "video" for option in media["options"]))

    def test_public_share_rejects_a_partial_album(self):
        with self.assertRaisesRegex(ValueError, "unsupported"):
            f2_bridge.public_share_media({"images": [{"url_list": ["https://image.douyinpic.com/1.jpg"]}, {}]}, {})

    def test_short_link_uses_actual_content_type_from_public_share(self):
        expected = {"mediaType": "image", "options": []}
        modules = {"f2.apps.douyin.utils": SimpleNamespace(AwemeIdFetcher=SimpleNamespace(get_aweme_id=AsyncMock(return_value="123")))}
        with patch.dict(sys.modules, modules), patch.object(f2_bridge, "fetch_public_share", return_value=expected), patch.object(f2_bridge, "fetch_jingxuan") as video:
            self.assertEqual(asyncio.run(f2_bridge.fetch("https://v.douyin.com/public-album/")), expected)
        video.assert_not_called()

    def test_public_share_requires_matching_id_and_can_parse_trailing_scripts(self):
        client = AsyncMock()
        context = AsyncMock()
        context.__aenter__.return_value = client
        item = {"aweme_id": "123", "images": [{"url_list": ["https://image.douyinpic.com/1.jpg"]}]}
        page = "window._ROUTER_DATA = " + json.dumps({"loaderData": {"video_(id)/page": {"videoInfoRes": {"item_list": [item]}}}}) + "; unrelated();"
        client.get.return_value = SimpleNamespace(status_code=200, text=page, content=page.encode())
        with patch.dict(sys.modules, {"httpx": SimpleNamespace(AsyncClient=MagicMock(return_value=context))}):
            self.assertEqual(asyncio.run(f2_bridge.fetch_public_share("123"))["mediaType"], "image")
            with self.assertRaises(ValueError):
                asyncio.run(f2_bridge.fetch_public_share("456"))

    def test_empty_public_page_is_retried_once_but_denied_page_is_not(self):
        for status, expected_calls in [(200, 2), (403, 1)]:
            with self.subTest(status=status):
                client = AsyncMock()
                context = AsyncMock()
                context.__aenter__.return_value = client
                page = 'window._ROUTER_DATA = {"loaderData":{}}'
                client.get.return_value = SimpleNamespace(status_code=status, text=page, content=page.encode())
                with patch.dict(sys.modules, {"httpx": SimpleNamespace(AsyncClient=MagicMock(return_value=context))}):
                    with self.assertRaises(ValueError):
                        asyncio.run(f2_bridge.fetch_public_share("123"))
                self.assertEqual(client.get.call_count, expected_calls)

    def test_bridge_platform_limit_keeps_its_retryable_error_code(self):
        with patch.object(server.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout='{"ok":false,"code":"platform_limited"}')):
            with self.assertRaises(server.WorkerError) as caught:
                server.fetch_douyin_media("https://www.douyin.com/video/123")
        self.assertEqual(caught.exception.code, "platform_limited")
        self.assertEqual(caught.exception.status, 502)

    def test_jingxuan_exposes_video_and_extracted_soundtrack(self):
        result = {
            "gid": "123", "title": "公开作品",
            "video_model": json.dumps({"video_list": [{
                "main_url": "https://media.douyinvod.com/video.mp4",
                "video_meta": {"bitrate": 1024},
            }]}),
        }
        page = "window._SSR_DATA = " + json.dumps({
            "data": {"storeState": {"detail": {"videoData": {"result": result}}}}
        })
        client = AsyncMock()
        client.get.return_value = SimpleNamespace(status_code=200, text=page)
        context = AsyncMock()
        context.__aenter__.return_value = client
        httpx = SimpleNamespace(AsyncClient=MagicMock(return_value=context))
        with patch.dict(sys.modules, {"httpx": httpx}):
            media = asyncio.run(f2_bridge.fetch_jingxuan("123"))
        self.assertEqual([item["mediaType"] for item in media["options"]], ["video", "audio"])
        self.assertTrue(media["options"][1]["extractAudio"])

    def test_f2_preserves_album_images_even_when_a_video_variant_exists(self):
        raw = {
            "video": {"bit_rate": [{"play_addr": {"url_list": ["https://media.douyinvod.com/video.mp4"]}}]},
            "music": {"play_url": {"url_list": ["https://music.pstatp.com/track.mp3"]}},
        }
        media = SimpleNamespace(
            nickname_raw="作者", desc_raw="图集", aweme_id="123", duration=1000,
            images=[f"https://image.douyinpic.com/{index}.jpg" for index in range(35)],
            _to_raw=lambda: {"aweme_detail": raw},
        )
        crawler = AsyncMock()
        context = AsyncMock()
        context.__aenter__.return_value = crawler
        modules = {
            "f2.apps.douyin.crawler": SimpleNamespace(DouyinCrawler=lambda _: context),
            "f2.apps.douyin.filter": SimpleNamespace(PostDetailFilter=lambda _: media),
            "f2.apps.douyin.model": SimpleNamespace(PostDetail=lambda **kwargs: kwargs),
            "f2.apps.douyin.utils": SimpleNamespace(
                ClientConfManager=SimpleNamespace(headers=lambda: {}),
                TokenManager=SimpleNamespace(gen_ttwid=lambda: "fixture"),
                VerifyFpManager=SimpleNamespace(gen_s_v_web_id=lambda: "fixture"),
            ),
        }
        with patch.dict(sys.modules, modules):
            result = asyncio.run(f2_bridge.fetch_with_f2("123"))
        self.assertEqual(result["mediaType"], "image")
        self.assertEqual(len(result["options"]), 36)
        self.assertEqual(result["options"][34]["formatId"], "image:34")
        self.assertEqual(result["options"][35]["mediaType"], "audio")
        self.assertFalse(result["options"][35]["extractAudio"])

    def test_ytdlp_video_exposes_audio_only_when_present(self):
        for has_video, has_audio in [(True, True), (True, False), (False, True)]:
            with self.subTest(has_video=has_video, has_audio=has_audio):
                ydl = MagicMock()
                ydl.__enter__.return_value.extract_info.return_value = {
                    "title": "作品", "formats": [{
                        "vcodec": "h264" if has_video else "none",
                        "acodec": "aac" if has_audio else "none",
                        "height": 1080 if has_video else None,
                    }],
                }
                factory = MagicMock(return_value=ydl)
                factory.sanitize_info.side_effect = lambda info, **_: info
                with patch.dict(sys.modules, {
                    "yt_dlp": SimpleNamespace(YoutubeDL=factory),
                    "yt_dlp.utils": SimpleNamespace(DownloadError=type("DownloadError", (Exception,), {})),
                }):
                    result = server.resolve_with_ytdlp("https://www.youtube.com/watch?v=fixture", "youtube")
                types = {item["mediaType"] for item in result["options"]}
                self.assertEqual("video" in types, has_video)
                self.assertEqual("audio" in types, has_audio)

    def test_douyin_downloads_use_snapshot_without_exposing_source_details(self):
        media = {"title": "作品", "mediaType": "video", "headers": {}, "options": [
            f2_bridge.audio_option("https://media.douyinvod.com/video.mp4", extract_audio=True)
        ]}
        media["options"][0]["remoteUrls"] = ["https://media.douyinvod.com/backup.mp4"]
        with patch.object(server, "fetch_douyin_media", return_value=media) as fetch:
            result = server.resolve_douyin("https://www.douyin.com/video/123", "douyin")
            option = result["options"][0]
            self.assertNotIn("remoteUrl", option)
            self.assertNotIn("remoteUrls", option)
            self.assertNotIn("extractAudio", option)
            with patch.object(server, "download_douyin", return_value=(Path("fixture.mp3"), "audio/mpeg")) as download:
                server.download_media({
                    "url": "https://www.douyin.com/video/123", "platform": "douyin", "engine": "f2",
                    "formatId": "audio", "workerToken": option["workerToken"],
                }, Path("."))
            fetch.assert_called_once()
            self.assertEqual(download.call_args.args[1], "audio")

    def test_audio_mime_is_accepted_and_keeps_actual_extension(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.headers = {"content-type": "audio/mp4", "content-length": "4"}
        response.read.side_effect = [b"test", b""]
        opener = MagicMock()
        opener.open.return_value = response
        # Test files stay within the invoking project's output directory.
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary:
            with patch.object(server, "build_opener", return_value=opener), patch.object(server, "assert_public_remote_url"):
                target, mime = server.fetch_remote_file(
                    "https://music.pstatp.com/track", {}, Path(temporary), "mp3"
                )
            self.assertEqual(target.suffix, ".m4a")
            self.assertEqual(mime, "audio/mp4")
            self.assertEqual(target.read_bytes(), b"test")

    def test_album_uses_provided_backup_after_transient_cdn_failure(self):
        primary = "https://p26-sign.douyinpic.com/first.webp"
        backup = "https://p9-sign.douyinpic.com/backup.webp"
        media = {"headers": {}, "options": [{"formatId": "image:0", "extension": "jpg", "remoteUrl": primary, "remoteUrls": [primary, backup]}]}
        with patch.object(server, "fetch_remote_file", side_effect=[server.WorkerError("upstream", 502), (Path("fixture.webp"), "image/webp")]) as fetch:
            self.assertEqual(server.download_douyin(media, "image:0", Path("."))[1], "image/webp")
        self.assertEqual([call.args[0] for call in fetch.call_args_list], [primary, backup])
        with patch.object(server, "fetch_remote_file", side_effect=server.WorkerError("private_or_missing")) as fetch:
            with self.assertRaises(server.WorkerError):
                server.download_douyin(media, "image:0", Path("."))
        fetch.assert_called_once()

    def test_truncated_media_is_not_reported_as_success(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.headers = {"content-type": "image/webp", "content-length": "100"}
        response.read.side_effect = [b"partial", b""]
        opener = MagicMock()
        opener.open.return_value = response
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary:
            with patch.object(server, "build_opener", return_value=opener), patch.object(server, "assert_public_remote_url"):
                with self.assertRaises(server.WorkerError) as caught:
                    server.fetch_remote_file("https://image.douyinpic.com/photo.webp", {}, Path(temporary), "jpg")
        self.assertEqual(caught.exception.code, "upstream")

    def test_public_share_playback_host_is_allowed_without_allowing_arbitrary_hosts(self):
        server.assert_allowed_douyin_media_url("https://aweme.snssdk.com/aweme/v1/play/?fixture=1")
        server.assert_allowed_douyin_media_url("https://v5-dy-ov-experiment.zjcdn.com/media.mp4")
        server.assert_allowed_douyin_media_url("https://v5-hl-mly-ov.zjcdn.com/media.mp4")
        for url in ["https://snssdk.com.attacker.invalid/media", "https://other.snssdk.com/media", "https://other.zjcdn.com/media", "https://v5-hl-mly-ov.zjcdn.com.attacker.invalid/media"]:
            with self.assertRaises(server.WorkerError):
                server.assert_allowed_douyin_media_url(url)

    def test_official_playback_redirect_to_regional_cdn_checks_both_public_addresses(self):
        source = "https://aweme.snssdk.com/aweme/v1/play/?fixture=1"
        target = "https://v5-hl-mly-ov.zjcdn.com/media.mp4"
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.headers = {"content-type": "video/mp4", "content-length": "5"}
        response.read.side_effect = [b"video", b""]
        opener = MagicMock()
        opener.open.side_effect = [server.HTTPError(source, 302, "redirect", {"location": target}, BytesIO()), response]
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary:
            with patch.object(server, "build_opener", return_value=opener), patch.object(server, "assert_public_remote_url") as public:
                file, mime = server.fetch_remote_file(source, {}, Path(temporary), "mp4")
                self.assertEqual(file.read_bytes(), b"video")
                self.assertEqual(mime, "video/mp4")
                self.assertEqual([item.args[0] for item in public.call_args_list], [source, target])

    def test_extracted_audio_returns_an_mp3_and_suppresses_ffmpeg_logs(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary:
            directory = Path(temporary)
            source = directory / "media.mp4"
            source.write_bytes(b"video")
            def convert(command, **kwargs):
                self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
                self.assertIn("file,pipe", command)
                if command[0] == "ffprobe":
                    return SimpleNamespace(returncode=0, stdout='{"streams":[{"index":1}]}')
                Path(command[-1]).write_bytes(b"audio")
                return SimpleNamespace(returncode=0)
            with patch.object(server, "fetch_remote_file", return_value=(source, "video/mp4")), patch.object(server.subprocess, "run", side_effect=convert):
                target, mime = server.download_douyin({
                    "headers": {}, "options": [f2_bridge.audio_option("https://media.douyinvod.com/video.mp4", True)]
                }, "audio", directory)
            self.assertEqual(target.suffix, ".mp3")
            self.assertEqual(mime, "audio/mpeg")
            self.assertEqual(target.read_bytes(), b"audio")

    def test_silent_video_is_distinguished_from_probe_failures(self):
        for returncode, stdout, expected in [
            (0, '{"streams":[]}', "audio_missing"),
            (1, '', "upstream"),
            (0, 'invalid', "upstream"),
            (0, '{}', "upstream"),
        ]:
            with self.subTest(expected=expected, stdout=stdout):
                with patch.object(server.subprocess, "run", return_value=SimpleNamespace(returncode=returncode, stdout=stdout)):
                    with self.assertRaises(server.WorkerError) as caught:
                        server.require_audio_stream(Path("local.mp4"))
                self.assertEqual(caught.exception.code, expected)

    def test_silent_video_does_not_start_conversion(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary:
            directory = Path(temporary)
            with patch.object(server, "fetch_remote_file", return_value=(directory / "source.mp4", "video/mp4")), patch.object(server.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout='{"streams":[]}')) as run:
                with self.assertRaises(server.WorkerError) as caught:
                    server.download_douyin({"headers": {}, "options": [f2_bridge.audio_option("https://media.douyinvod.com/video.mp4", True)]}, "audio", directory)
            self.assertEqual(caught.exception.code, "audio_missing")
            self.assertEqual(run.call_count, 1)

    def test_probe_timeout_is_retryable_upstream_failure(self):
        with patch.object(server.subprocess, "run", side_effect=subprocess.TimeoutExpired("ffprobe", 15)):
            with self.assertRaises(server.WorkerError) as caught:
                server.require_audio_stream(Path("local.mp4"))
        self.assertEqual(caught.exception.code, "upstream")
        self.assertEqual(caught.exception.status, 502)


if __name__ == "__main__":
    unittest.main()
