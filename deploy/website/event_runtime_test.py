import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import urllib.error
from types import SimpleNamespace
from unittest.mock import patch

import build_event_runtime
import event_gateway
import event_prerequisites
import remote

ROOT = Path(__file__).resolve().parents[2]


class EventReleaseTests(unittest.TestCase):
    def test_stage_accepts_the_exact_event_bundle_and_rejects_missing_or_foreign_artifacts(self):
        sha, base = 'b' * 40, 'a' * 40
        names = {f'independent-source-{sha}.tar.gz', f'independent-assets-{sha}.json',
                 f'independent-event-runtime-{sha}.tar.gz'}
        before = {'components': {'app': {'revision': base}}, 'assetsSha256': 'c' * 64}
        runtime = ROOT / '.runtime'; runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as directory:
            root = Path(directory)
            dropin = root / 'website.conf'
            dropin.write_text(f'[Service]\nExecStart={root}/releases/{base}/operations/run-app live\n')
            for index, artifacts in enumerate([names, names - {f'independent-event-runtime-{sha}.tar.gz'},
                                               names | {'unreviewed.tar.gz'},
                                               (names - {f'independent-event-runtime-{sha}.tar.gz'}) |
                                               {f'independent-event-runtime-{base}.tar.gz'}]):
                plan = {'sha': sha, 'before': before, 'externalEvents': True,
                        'artifacts': {name: {'sha256': 'c' * 64, 'bytes': 1} for name in artifacts}}
                target = root / ('candidate-' + str(index))
                with self.subTest(index=index), patch.object(remote, 'ROOT', root), \
                        patch.object(remote, 'DROP', dropin), \
                        patch.object(remote, 'run', side_effect=RuntimeError('synthetic_download_boundary')) as download:
                    if index == 0:
                        with self.assertRaisesRegex(RuntimeError, 'synthetic_download_boundary'):
                            remote.stage(plan, target)
                        download.assert_called_once()
                    else:
                        with self.assertRaisesRegex(remote.ReleaseError, 'invalid_artifact_names'):
                            remote.stage(plan, target)
                        download.assert_not_called()
                        self.assertFalse(target.exists())

    def test_gateway_changes_only_the_existing_private_post_matcher(self):
        before = '# untouched prefix\n' + event_gateway.ORIGINAL + '\n# untouched suffix'
        after = event_gateway.transform(before)
        self.assertEqual(after, before.replace('path /shop-api', 'path /shop-api /storefront-realtime/mail-events'))
        self.assertEqual(event_gateway.transform(after), after)
        with self.assertRaisesRegex(RuntimeError, 'baseline_changed'):
            event_gateway.transform(before.replace('bind 127.0.0.1', 'bind 0.0.0.0'))

    def test_reader_grants_have_only_six_table_reads_and_replication_metadata(self):
        grants = event_prerequisites.grant_statements()
        self.assertEqual(len(grants), 7)
        self.assertEqual(sum('GRANT SELECT ON' in grant for grant in grants), 6)
        self.assertTrue(all("'id_recharge_events'@'172.17.0.1'" in grant for grant in grants))
        self.assertFalse(any(word in ' '.join(grants) for word in ['INSERT', 'UPDATE', 'DELETE', 'ALL PRIVILEGES', 'GRANT OPTION']))

    def test_gateway_recovers_written_but_inactive_config_without_rewriting_it(self):
        runtime = ROOT / '.runtime'; runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as directory:
            root = Path(directory); gateway = root / 'Caddyfile'
            (root / '.application-release.lock').touch()
            gateway.write_text(event_gateway.UPDATED)
            inode = gateway.stat().st_ino
            with patch.object(event_gateway, 'ROOT', root), patch.object(event_gateway, 'GATEWAY', gateway), \
                    patch.object(event_gateway, 'caddy'), patch.object(event_gateway, 'probe', side_effect=[False, True]), \
                    patch.object(event_gateway, 'activate', return_value='gateway-restart') as activate:
                result = event_gateway.prepare(True)
                activate.assert_called_once_with(event_gateway.UPDATED)
                self.assertFalse(result['changed']); self.assertTrue(result['applied'])
                self.assertEqual(gateway.stat().st_ino, inode)
            with patch.object(event_gateway, 'ROOT', root), patch.object(event_gateway, 'GATEWAY', gateway), \
                    patch.object(event_gateway, 'caddy'), patch.object(event_gateway, 'probe', return_value=True), \
                    patch.object(event_gateway, 'activate') as activate:
                self.assertEqual(event_gateway.prepare(True)['activation'], 'already-active')
                activate.assert_not_called()

    def test_disabled_admin_activation_preserves_image_and_rejects_unexpected_startup(self):
        command = json.dumps(['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
        for version, operation in [('v2.10.2 hash', 'restart'), ('v2.11.0 hash', 'kill')]:
            with self.subTest(version=version), \
                    patch.object(event_gateway.subprocess, 'check_output', side_effect=[command, version]), \
                    patch.object(event_gateway.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
                event_gateway.activate('{\n  admin off\n}\n' + event_gateway.UPDATED)
                args = run.call_args.args[0]
                self.assertEqual(args[1], operation)
                self.assertEqual(args[-1], 'id-business-independent-caddy')
                if operation == 'kill': self.assertIn('--signal=USR1', args)
        with patch.object(event_gateway.subprocess, 'check_output', return_value='["caddy", "run", "--resume"]'), \
                patch.object(event_gateway.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'start_command_changed'):
                event_gateway.activate('{\n  admin off\n}\n')
            run.assert_not_called()

    def test_gateway_probe_matches_application_headers_and_requires_exact_rejection(self):
        for status, body, expected in [(400, b'{"error":"invalid_request"}', True),
                                       (403, b'blocked', False), (400, b'other', False)]:
            with patch.object(event_gateway.urllib.request, 'urlopen', side_effect=urllib.error.HTTPError(
                    'http://127.0.0.1', status, '', {}, io.BytesIO(body))) as request:
                self.assertEqual(event_gateway.probe(), expected)
                req = request.call_args.args[0]
                self.assertEqual(req.get_header('User-agent'), 'node')
                self.assertEqual(req.data, b'{}')

    def test_launcher_frames_credentials_and_does_not_need_reader_secret_in_canary(self):
        runtime = ROOT / '.runtime'
        runtime.mkdir(exist_ok=True)
        before = '''state+=(-e "ID_VENDURE_ADMISSION_DIRECTORY=/state/vendure-admission")
{
  cat "$CREDENTIALS_DIRECTORY/independent-recharge-bridge"
  cat "$CREDENTIALS_DIRECTORY/independent-online-tools"
  printf '\\n'
  cat "$CREDENTIALS_DIRECTORY/independent-vendure-integrations"
}'''
        # Match the managed launcher's indentation exactly.
        before = '  ' + before
        after = remote.wire_event_launcher(remote.normalize_tools_credential_stream(before))
        self.assertEqual(remote.wire_event_launcher(after), after)
        with tempfile.TemporaryDirectory(dir=runtime) as directory:
            path = Path(directory)
            (path / 'independent-recharge-bridge').write_text('b' * 64 + '\n')
            (path / 'independent-online-tools').write_text(json.dumps({'synthetic': 'tools'}, indent=2) + '\n')
            (path / 'independent-vendure-integrations').write_text(json.dumps({'mailboxApiKey': 'synthetic'}, indent=2) + '\n')
            env = os.environ | {'CREDENTIALS_DIRECTORY': directory, 'root': '/synthetic', 'sha': 'a' * 40}
            output = subprocess.check_output(['bash', '-euo', 'pipefail', '-c', after], env=env | {'mode': 'canary'}, text=True)
            self.assertEqual(output.splitlines()[-1], 'disabled')
            (path / 'independent-recharge-events').write_text('e' * 64)
            output = subprocess.check_output(['bash', '-euo', 'pipefail', '-c', after], env=env | {'mode': 'live'}, text=True)
            self.assertEqual(len(output.splitlines()), 4)
            self.assertEqual(output.splitlines()[-1], 'e' * 64)
            self.assertEqual(json.loads(output.splitlines()[2]), {'mailboxApiKey': 'synthetic'})

    def test_entry_only_enables_cdc_for_live_and_rejects_partial_wiring(self):
        before = "const [toolConfig, vendureConfig] = input.split('\\n');\nconst service = await startPreview(44572, {\n  relayConfig,\n});\n"
        after = remote.wire_event_entry(before)
        self.assertEqual(remote.wire_event_entry(after), after)
        self.assertIn("rechargeEventsConfig: mode === 'live'", after)
        self.assertIn("checkpointPath: '/state/recharge-events.checkpoint.json'", after)
        subprocess.run(['node', '--check', '--input-type=module'], input=after, text=True, check=True, capture_output=True)
        with self.assertRaisesRegex(remote.ReleaseError, 'unexpected_event_entry'):
            remote.wire_event_entry(after.replace('serverId: 3511012', 'serverId: 1'))

    def test_locked_runtime_archive_is_reproducible_and_contains_a_hash_manifest(self):
        runtime = ROOT / '.runtime'; runtime.mkdir(exist_ok=True)
        digests = []
        def install(args, **kwargs):
            self.assertIn('--require-hashes', args); self.assertIn('--no-compile', args)
            target = Path(args[args.index('--target') + 1])
            (target / 'synthetic.py').write_text('# synthetic dependency\n')
        for _ in range(2):
            with tempfile.TemporaryDirectory(dir=runtime) as directory:
                with patch.object(build_event_runtime, 'ROOT', Path(directory)), patch.object(build_event_runtime.subprocess, 'run', install):
                    build_event_runtime.build('a' * 40)
                artifact = Path(directory) / '.runtime/website-release' / ('independent-event-runtime-' + 'a' * 40 + '.tar.gz')
                digests.append(hashlib.sha256(artifact.read_bytes()).hexdigest())
        self.assertEqual(digests[0], digests[1])


if __name__ == '__main__':
    unittest.main()
