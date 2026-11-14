import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('capsule', HERE / 'recovery_capsule.py')
capsule = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capsule)


class PortableRecovery(unittest.TestCase):
    def setUp(self):
        base = HERE.parents[1] / 'backups'
        base.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=base, prefix='.recovery-capsule-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in capsule.REQUIRED:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'synthetic-only')
        for name in capsule.TREES:
            (self.root / name).mkdir(parents=True, exist_ok=True)
        for folder, names in {
            'google-drive-backup': ['settings.json', 'run-drive-backup.py', 'recipient.pem', 'outbox/checkpoint.json'],
            'google-sheets-sync': ['settings.json', 'run-sheets-sync.py']
        }.items():
            for name in names:
                path = self.root / 'formal' / folder / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'synthetic-only')
        (self.root / 'formal/private/synthetic-key.cred').write_bytes(b'opaque-host-bound-fixture')
        (self.root / 'formal/data/local-business.sqlite').write_bytes(b'synthetic-only')
        for sha in ('a' * 40, 'b' * 40):
            (self.root / 'releases' / sha / 'operations').mkdir(parents=True)

    def collect(self, snapshot=lambda _path, _image: b'synthetic-committed-sqlite'):
        read_file = capsule.read_file
        def private_read(path):
            if str(path).startswith('/run/id-business-independent-'):
                return b'synthetic-runtime-config', (0, 0, 0, 0, 0)
            return read_file(path)
        original_stamp = capsule.stamp
        def private_stamp(path):
            return (0, 0, 0, 0, 0) if str(path).startswith('/run/id-business-independent-') else original_stamp(path)
        def fake_run(command, **_kwargs):
            if command[:2] == ['systemctl', 'list-unit-files']:
                return type('Result', (), {'returncode': 0,
                    'stdout': 'id-business-independent-app.service enabled\n'
                              'id-business-independent-google-drive-backup.service enabled\n'})()
            self.assertEqual(command[:2], ['systemctl', 'cat'])
            return type('Result', (), {'returncode': 0, 'stdout': b'[Service]\n'})()
        with patch.object(capsule, 'sqlite_snapshot', side_effect=snapshot), \
             patch.object(capsule, 'sealed_credential', return_value=b'synthetic-portable-value'), \
             patch.object(capsule, 'read_file', side_effect=private_read), \
             patch.object(capsule, 'stamp', side_effect=private_stamp), \
             patch.object(capsule.subprocess, 'run', side_effect=fake_run):
            return capsule.collect(self.root, 'a' * 40, 'b' * 40)

    def test_state_is_collected_in_memory_without_sessions_or_new_plaintext_files(self):
        sessions = self.root / 'formal/data/local-auth.json.sessions'
        sessions.mkdir()
        (sessions / 'synthetic.json').write_bytes(b'synthetic-session')
        lock = self.root / 'formal/vendure-state/vendure/vendure-task-service.lock'
        lock.mkdir(parents=True)
        (lock / 'owner.json').write_bytes(b'synthetic-runtime-owner')
        before = sorted(str(path) for path in self.root.rglob('*'))
        state = self.collect()
        self.assertEqual(before, sorted(str(path) for path in self.root.rglob('*')))
        by_name = {entry['path']: entry for entry in state['entries']}
        self.assertEqual(base64.b64decode(by_name['credentials/synthetic-key']['data']), b'synthetic-portable-value')
        self.assertNotIn('formal/private/synthetic-key.cred', by_name)
        self.assertFalse(any('.sessions/' in name for name in by_name))
        self.assertFalse(any('.lock' in row['path'] for row in state['entries'] + state['directories']))
        self.assertEqual(state['sessionPolicy'], 'revoke')

    def test_checkpoint_precedes_sqlite_and_later_advancement_does_not_skip_work(self):
        checkpoint = self.root / 'formal/data/recharge-events.checkpoint.json'
        def snapshot(_path, _image):
            checkpoint.write_bytes(b'synthetic-later-checkpoint')
            return b'synthetic-committed-sqlite'
        state = self.collect(snapshot)
        original = next(entry for entry in state['entries'] if entry['path'].endswith('checkpoint.json')
                        and '/data/' in entry['path'])
        self.assertEqual(base64.b64decode(original['data']), b'synthetic-only')

    def test_auth_change_during_capture_fails_without_a_recovery_receipt(self):
        def snapshot(_path, _image):
            (self.root / 'formal/data/local-auth.json').write_bytes(b'synthetic-changed-account')
            return b'synthetic-committed-sqlite'
        with self.assertRaisesRegex(capsule.RecoveryError, 'source_changed'):
            self.collect(snapshot)

    def test_symlink_and_missing_required_file_are_not_silently_omitted(self):
        path = self.root / 'formal/private/synthetic-other'
        path.symlink_to(self.root / 'formal/data/local-auth.json')
        with self.assertRaisesRegex(capsule.RecoveryError, 'symlink_forbidden'):
            self.collect()
        path.unlink()
        (self.root / capsule.REQUIRED[0]).unlink()
        with self.assertRaises(FileNotFoundError):
            self.collect()


if __name__ == '__main__':
    unittest.main()
