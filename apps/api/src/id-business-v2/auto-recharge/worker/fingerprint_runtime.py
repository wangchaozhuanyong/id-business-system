"""共享内置指纹内核；运行时离线启动固定安装，不回退普通浏览器。"""
import asyncio
import hashlib
import json
from pathlib import Path

from checkout_core import Stop
from browser_session import SessionBudget

ENGINE_VERSION = '152.0.4-beta.30'
ENGINE_PATH = Path('/opt/camoufox/camoufox')
_observed_profiles = set()
STARTUP_TIMEOUT_SECONDS = 30


def fingerprint_ready(path=None):
    return Path(path or ENGINE_PATH).is_file()


async def launch_fingerprint_browser(playwright, *, proxy=None, headless=False, executable_path=None):
    path = Path(executable_path or ENGINE_PATH)
    if not fingerprint_ready(path):
        raise Stop('fingerprint_engine_unavailable')
    from camoufox.async_api import AsyncNewBrowser
    from camoufox.addons import DefaultAddons
    budget = SessionBudget(STARTUP_TIMEOUT_SECONDS)
    # ff_version 固定对应已下载内核；不触发包管理器、GeoIP 或默认扩展下载。
    for _ in range(3):
        browser = None
        try:
            async def create_browser():
                nonlocal browser
                browser = await AsyncNewBrowser(
                    playwright, executable_path=str(path), ff_version=152,
                    headless=headless, proxy=proxy, geoip=False,
                    exclude_addons=list(DefaultAddons), block_webrtc=True,
                    i_know_what_im_doing=True, timeout=budget.remaining_ms())
                return browser
            await budget.run(create_browser, 'fingerprint_launch')
            context = await budget.run(lambda: browser.new_context(
                service_workers='block', accept_downloads=False), 'fingerprint_context')
            try:
                signature = await budget.run(lambda: fingerprint_signature(context), 'fingerprint_probe')
            finally:
                if not await close_fingerprint_resource(context):
                    raise Stop('fingerprint_cleanup_failed')
            budget.remaining_ms()
            if signature not in _observed_profiles:
                _observed_profiles.add(signature)
                return browser
        except BaseException as error:
            if browser is not None and not await close_fingerprint_resource(browser):
                raise Stop('fingerprint_cleanup_failed') from None
            if isinstance(error, Stop) and error.report.get('reason') == 'session_load_timeout':
                raise Stop('fingerprint_start_timeout') from None
            raise
        if not await close_fingerprint_resource(browser):
            raise Stop('fingerprint_cleanup_failed')
    raise Stop('fingerprint_environment_duplicated')


async def close_fingerprint_resource(resource):
    if resource is None:
        return True
    try:
        await asyncio.wait_for(resource.close(), timeout=5)
        return True
    except Exception:
        return False


async def fingerprint_signature(context):
    """读取网站能观察的参数，无账号、网络出口或授权信息。"""
    page = await asyncio.wait_for(context.new_page(), timeout=10)
    try:
        value = await asyncio.wait_for(page.evaluate('''() => {
            const canvas = document.createElement('canvas'); canvas.width=240; canvas.height=80;
            const draw=canvas.getContext('2d'); draw.fillStyle='#14a'; draw.fillRect(2,2,200,60);
            draw.font='18px Arial'; draw.fillStyle='#ffc'; draw.fillText('Browser environment 123',8,35);
            const gl=document.createElement('canvas').getContext('webgl');
            const debug=gl && gl.getExtension('WEBGL_debug_renderer_info');
            return {ua:navigator.userAgent, platform:navigator.platform,
                cores:navigator.hardwareConcurrency, languages:navigator.languages,
                screen:[screen.width,screen.height,screen.colorDepth,devicePixelRatio],
                canvas:canvas.toDataURL(),
                gpu:debug ? [gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)] : null};
        }'''), timeout=10)
        return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    finally:
        await close_fingerprint_resource(page)
