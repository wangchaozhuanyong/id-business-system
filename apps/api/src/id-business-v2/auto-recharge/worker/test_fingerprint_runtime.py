import tempfile
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
import fingerprint_runtime as runtime


class FingerprintRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_browser_created_at_deadline_is_still_owned_and_closed(self):
        from checkout_core import Stop
        async def expires_after_creation(_budget, operation, _step):
            await operation()
            raise Stop('session_load_timeout')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'camoufox'; path.touch()
            browser = MagicMock(close=AsyncMock())
            with (patch.object(runtime.SessionBudget, 'run', expires_after_creation),
                  patch('camoufox.async_api.AsyncNewBrowser', AsyncMock(return_value=browser))):
                with self.assertRaises(Stop) as stopped:
                    await runtime.launch_fingerprint_browser(MagicMock(), executable_path=path)
            self.assertEqual(stopped.exception.report['reason'], 'fingerprint_start_timeout')
            browser.close.assert_awaited_once()

    async def test_probe_hang_is_bounded_by_total_startup_budget_and_closes_browser(self):
        import asyncio
        from checkout_core import Stop
        async def never(*_, **__): await asyncio.Event().wait()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'camoufox'; path.touch()
            browser = MagicMock(new_context=AsyncMock(return_value=MagicMock(close=AsyncMock())), close=AsyncMock())
            with (patch.object(runtime, 'STARTUP_TIMEOUT_SECONDS', 0.02),
                  patch('camoufox.async_api.AsyncNewBrowser', AsyncMock(return_value=browser)),
                  patch.object(runtime, 'fingerprint_signature', AsyncMock(side_effect=never))):
                with self.assertRaises(Stop) as stopped:
                    await asyncio.wait_for(runtime.launch_fingerprint_browser(MagicMock(), executable_path=path), timeout=0.5)
            self.assertEqual(stopped.exception.report['reason'], 'fingerprint_start_timeout')
            browser.close.assert_awaited_once()

    async def test_failed_duplicate_browser_cleanup_never_launches_a_second_environment(self):
        from checkout_core import Stop
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'camoufox'; path.touch()
            browser = MagicMock(new_context=AsyncMock(return_value=MagicMock(close=AsyncMock())),
                                close=AsyncMock(side_effect=RuntimeError('private')))
            runtime._observed_profiles.add('duplicate-cleanup-profile')
            with (patch('camoufox.async_api.AsyncNewBrowser', AsyncMock(return_value=browser)) as launch,
                  patch.object(runtime, 'fingerprint_signature', AsyncMock(return_value='duplicate-cleanup-profile'))):
                with self.assertRaises(Stop) as stopped:
                    await runtime.launch_fingerprint_browser(MagicMock(), executable_path=path)
            self.assertEqual(stopped.exception.report['reason'], 'fingerprint_cleanup_failed')
            launch.assert_awaited_once()

    async def test_launch_uses_fixed_binary_without_geoip_or_addon_downloads(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'camoufox'; path.touch()
            driver = MagicMock(); browser = MagicMock(new_context=AsyncMock(return_value=MagicMock(close=AsyncMock())))
            with (patch('camoufox.async_api.AsyncNewBrowser', AsyncMock(return_value=browser)) as launch,
                  patch.object(runtime, 'fingerprint_signature', AsyncMock(return_value='unit-test-profile'))):
                runtime._observed_profiles.discard('unit-test-profile')
                self.assertIs(await runtime.launch_fingerprint_browser(driver, executable_path=path), browser)
                options = launch.await_args.kwargs
                self.assertEqual(options['executable_path'], str(path))
                self.assertFalse(options['geoip'])
                self.assertTrue(options['exclude_addons'])
                self.assertTrue(options['block_webrtc'])
                self.assertFalse(options['headless'])
                driver.chromium.launch.assert_not_called()

    async def test_browser_close_failure_does_not_overwrite_business_result(self):
        resource = MagicMock(close=AsyncMock(side_effect=RuntimeError('already closed')))
        await runtime.close_fingerprint_resource(resource)
        resource.close.assert_awaited_once()

    async def test_duplicate_environment_is_closed_before_fresh_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'camoufox'; path.touch()
            old, fresh = [MagicMock(new_context=AsyncMock(return_value=MagicMock(close=AsyncMock())), close=AsyncMock()) for _ in range(2)]
            runtime._observed_profiles.add('duplicate-test-profile')
            runtime._observed_profiles.discard('fresh-test-profile')
            with (patch('camoufox.async_api.AsyncNewBrowser', AsyncMock(side_effect=[old, fresh])) as launch,
                  patch.object(runtime, 'fingerprint_signature', AsyncMock(side_effect=['duplicate-test-profile', 'fresh-test-profile']))):
                self.assertIs(await runtime.launch_fingerprint_browser(MagicMock(), executable_path=path), fresh)
                self.assertEqual(launch.await_count, 2)
                old.close.assert_awaited_once()
                fresh.close.assert_not_awaited()

    async def test_duplicate_retry_budget_stops_without_returning_reused_browser(self):
        from checkout_core import Stop
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'camoufox'; path.touch()
            browser = MagicMock(new_context=AsyncMock(return_value=MagicMock(close=AsyncMock())), close=AsyncMock())
            runtime._observed_profiles.add('duplicate-budget-profile')
            with (patch('camoufox.async_api.AsyncNewBrowser', AsyncMock(return_value=browser)) as launch,
                  patch.object(runtime, 'fingerprint_signature', AsyncMock(return_value='duplicate-budget-profile'))):
                with self.assertRaises(Stop) as stopped:
                    await runtime.launch_fingerprint_browser(MagicMock(), executable_path=path)
                self.assertEqual(stopped.exception.report['reason'], 'fingerprint_environment_duplicated')
                self.assertEqual(launch.await_count, 3)
                self.assertEqual(browser.close.await_count, 3)


if __name__ == '__main__': unittest.main()
