import io
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import MagicMock, patch

import server


class NativeStartupTests(unittest.TestCase):
    def test_native_loopback_and_bridge_reach_existing_server(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Path(directory) / 'f2_bridge.py'
            bridge.write_text('# synthetic bridge\n')
            listener = MagicMock()
            listener.__enter__.return_value = listener
            with (patch.object(server, 'F2_BRIDGE', '/app/f2_bridge.py'),
                  patch.object(server, 'MediaResolverServer', return_value=listener) as factory):
                self.assertEqual(server.main(['--host=127.0.0.1', '--port=18787',
                                              '--f2-bridge', str(bridge)]), 0)
                self.assertEqual(server.F2_BRIDGE, str(bridge.resolve()))
            factory.assert_called_once_with(('127.0.0.1', 18787), server.MediaResolverHandler)
            listener.serve_forever.assert_called_once_with()
            listener.__exit__.assert_called_once()

    def test_default_docker_address_port_and_bridge_are_retained(self):
        listener = MagicMock()
        listener.__enter__.return_value = listener
        with (patch.object(server, 'F2_BRIDGE', '/app/f2_bridge.py'),
              patch.object(Path, 'is_file', return_value=True),
              patch.object(server, 'MediaResolverServer', return_value=listener) as factory):
            self.assertEqual(server.main([]), 0)
            self.assertEqual(server.F2_BRIDGE, '/app/f2_bridge.py')
        factory.assert_called_once_with(('0.0.0.0', server.PORT), server.MediaResolverHandler)

    def test_check_requires_bridge_without_starting_listener_or_downloader(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Path(directory) / 'f2_bridge.py'
            with (patch.object(server, 'MediaResolverServer') as listener,
                  patch.object(server.subprocess, 'run') as run):
                with self.assertRaisesRegex(SystemExit, '桥接文件不存在'):
                    server.main(['--check', '--f2-bridge', str(bridge)])
                bridge.write_text('# synthetic bridge\n')
                with patch.object(server, 'F2_BRIDGE', '/app/f2_bridge.py'):
                    self.assertEqual(server.main(['--check', '--f2-bridge', str(bridge)]), 0)
                listener.assert_not_called()
                run.assert_not_called()

    def test_invalid_arguments_fail_before_binding(self):
        for argv in (['--host=localhost'], ['--host=::1'], ['--host=https://127.0.0.1'],
                     ['--port=0'], ['--port=65536'], ['--port=oops'], ['--unknown']):
            with (self.subTest(argv=argv), redirect_stderr(io.StringIO()),
                  patch.object(server, 'MediaResolverServer') as listener):
                with self.assertRaises(SystemExit) as stopped:
                    server.main(argv)
                self.assertEqual(stopped.exception.code, 2)
                listener.assert_not_called()

    def test_self_test_does_not_require_container_bridge_or_start_server(self):
        with (patch.object(server, 'self_test') as check,
              patch.object(server, 'MediaResolverServer') as listener):
            self.assertEqual(server.main(['--self-test']), 0)
        check.assert_called_once_with()
        listener.assert_not_called()


if __name__ == '__main__':
    unittest.main()
