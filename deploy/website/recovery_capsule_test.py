import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
from types import SimpleNamespace
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
                              'id-business-independent-recharge-native.service enabled\n'
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

    def test_native_only_release_captures_its_verified_host_launcher(self):
        revision = 'b' * 40
        operations = self.root / 'releases' / revision / 'operations'
        operations.rmdir()
        launcher = self.root / 'releases' / revision / 'source/deploy/recharge-core/run-recharge.py'
        launcher.parent.mkdir(parents=True)
        content = b'synthetic-public-launcher'
        launcher.write_bytes(content)
        digest = hashlib.sha256(content).hexdigest()
        with patch.object(capsule, 'native_source_launcher', return_value=(launcher, digest)) as verify:
            state = self.collect()
        verify.assert_called_once()
        entry = next(row for row in state['entries'] if row['path'] == launcher.relative_to(self.root).as_posix())
        self.assertEqual(base64.b64decode(entry['data']), content)
        self.assertTrue(any(row['path'] == 'services/' + capsule.NATIVE_UNIT for row in state['entries']))
        self.assertFalse(operations.exists())
        script = """
import { generateKeyPairSync } from 'node:crypto';
const { sealRecoveryState, openRecoveryState } = await import(process.argv[1]);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const state = JSON.parse(input);
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const { archive } = sealRecoveryState(state, publicKey);
const restored = openRecoveryState(archive, privateKey);
console.log(JSON.stringify({ matched: JSON.stringify(state) === JSON.stringify(restored.state) }));
"""
        module = HERE.parents[1] / 'server/backup/recovery-archive.mjs'
        roundtrip = subprocess.run(['node', '--input-type=module', '-e', script, module.as_uri()],
            input=json.dumps(state).encode(), capture_output=True, timeout=20)
        self.assertEqual(roundtrip.returncode, 0)
        self.assertTrue(json.loads(roundtrip.stdout)['matched'])
        with patch.object(capsule, 'native_source_launcher', return_value=(launcher, '0' * 64)):
            with self.assertRaisesRegex(capsule.RecoveryError, 'native_source_mismatch'):
                self.collect()

    def test_missing_website_operations_and_operation_symlinks_still_fail(self):
        app_operations = self.root / 'releases' / ('a' * 40) / 'operations'
        app_operations.rmdir()
        with self.assertRaisesRegex(capsule.RecoveryError, 'active_operations_missing'):
            self.collect()
        app_operations.mkdir()
        (app_operations / 'linked-directory').symlink_to(self.root / 'formal/private', target_is_directory=True)
        with self.assertRaisesRegex(capsule.RecoveryError, 'symlink_forbidden'):
            self.collect()

    def test_native_launcher_requires_captured_service_image_source_and_stable_runtime(self):
        revision = 'b' * 40
        identity = 'a' * 64 + ' sha256:' + 'c' * 64 + ' true 123 ' + revision + '\n'
        content = b'synthetic-public-launcher'
        def result(value):
            return SimpleNamespace(returncode=0, stdout=value)
        paths = (self.root / 'releases' / revision / 'source/deploy/recharge-core/run-recharge.py',
                 self.root / 'formal/ops/recharge-core/run-recharge.py')
        for path in paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            definition = ('[Service]\nExecStart=/obsolete\nExecStart=\nExecStart=/usr/bin/python3 ' + str(path) +
                          ' native ' + revision + '\n').encode()
            responses = [result(identity), result(revision + ' ' + capsule.UPSTREAM_REVISION), result(identity)]
            with patch.object(capsule.subprocess, 'run', side_effect=responses), \
                    patch.object(Path, 'read_bytes', autospec=True, return_value=content) as read:
                actual, digest = capsule.native_source_launcher(self.root, revision, definition)
            self.assertEqual(actual, path)
            self.assertEqual(digest, hashlib.sha256(content).hexdigest())
            read.assert_called_once_with(Path('/proc/123/root/candidate/deploy/recharge-core/run-recharge.py'))
        definition = ('ExecStart=/usr/bin/python3 ' + str(paths[0]) + ' native ' + revision).encode()
        with patch.object(capsule.subprocess, 'run') as run:
            with self.assertRaisesRegex(capsule.RecoveryError, 'native_launcher_unavailable'):
                capsule.native_source_launcher(self.root, revision, b'ExecStart=/unmanaged')
            run.assert_not_called()
        with patch.object(capsule.subprocess, 'run', side_effect=[result(identity), result('unreviewed image')]):
            with self.assertRaisesRegex(capsule.RecoveryError, 'native_source_mismatch'):
                capsule.native_source_launcher(self.root, revision, definition)
        with patch.object(capsule.subprocess, 'run', side_effect=[result(identity),
                result(revision + ' ' + capsule.UPSTREAM_REVISION), result(identity.replace(' 123 ', ' 456 '))]), \
                patch.object(Path, 'read_bytes', return_value=content):
            with self.assertRaisesRegex(capsule.RecoveryError, 'native_runtime_changed'):
                capsule.native_source_launcher(self.root, revision, definition)

    def test_capsule_timeout_stops_only_its_named_temporary_container(self):
        recipient = b'synthetic-public-recipient'
        failure = subprocess.TimeoutExpired('synthetic docker capture', 90)
        with patch.object(capsule, 'read_file', return_value=(recipient, ())), \
                patch.object(capsule, 'collect', return_value={'synthetic': True}), \
                patch.object(capsule.subprocess, 'run', side_effect=[failure, SimpleNamespace(returncode=0)]) as run:
            with self.assertRaisesRegex(capsule.RecoveryError, 'capsule_encryption_failed'):
                capsule.capture(self.root, self.root, 'a' * 40, 'b' * 40, self.root / 'encrypted-output',
                                hashlib.sha256(recipient).hexdigest(), 'sha256:' + 'c' * 64)
        command = run.call_args_list[0].args[0]
        name = command[command.index('--name') + 1]
        self.assertRegex(name, r'^id-recovery-capsule-[a-f0-9]{16}$')
        self.assertIn(capsule.BACKUP_CONTAINER_LABEL, command)
        self.assertEqual(run.call_args_list[1].args[0], ['docker', 'stop', '--time', '1', name])


if __name__ == '__main__':
    unittest.main()
