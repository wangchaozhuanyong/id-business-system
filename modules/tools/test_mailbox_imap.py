import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mailbox_imap', pathlib.Path(__file__).with_name('mailbox-imap.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class MailboxHtmlTest(unittest.TestCase):
    def test_html_only_and_alternative_links_are_preserved_without_network(self):
        messages = [
            b'Content-Type: text/html; charset=utf-8\r\nSubject: Test\r\n\r\n<a href="https://example.test/verify">Verify</a>',
            b'MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nOpen the button\r\n--x\r\nContent-Type: text/html\r\n\r\n<a href="https://example.test/verify">Verify</a>\r\n--x--'
        ]
        for raw in messages:
            with self.subTest(multipart=b'multipart' in raw):
                with patch.object(worker.imaplib, 'IMAP4_SSL') as imap:
                    client = imap.return_value.__enter__.return_value
                    client.select.return_value = ('OK', [])
                    client.uid.side_effect = [('OK', [b'1']), ('OK', [(b'', raw)])]
                    rows = worker.read_recent({'provider': 'google', 'email': 'fixture@example.test', 'appPassword': 'synthetic'})
                    self.assertIn('href="https://example.test/verify"', rows[0]['body'])
                    self.assertIn('BODY.PEEK', client.uid.call_args.args[2])
                    client.select.assert_called_with('INBOX', readonly=True)


if __name__ == '__main__':
    unittest.main()
