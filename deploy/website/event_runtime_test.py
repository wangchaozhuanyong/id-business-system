import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import build_event_runtime
import event_gateway
import event_prerequisites
import remote

ROOT = Path(__file__).resolve().parents[2]


class EventReleaseTests(unittest.TestCase):
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
