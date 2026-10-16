"""Finite source, immutable baseline and payload rejection checks; no platform access."""
import ast
import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import subprocess
import shutil
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('mail_test_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('mailbox-realtime-release.py')
b = load('mailbox-realtime-build.py')
i = load('mailbox-realtime-inspect.py')


class MailboxRelease(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / 'mailbox-realtime-contract.json').read_bytes())

    def test_scope_keeps_exact_published_database_configuration_and_service_protections(self):
        p = r.verify_contract(self.c)
        self.assertEqual(self.c['workerFiles'], {})
        self.assertEqual(self.c['schemaSha256'], p['schemaSha256'])
        self.assertEqual(self.c['services'], p['services'])
        self.assertEqual(len(self.c['apiModules']), 4)

    def test_unreviewed_sources_and_baseline_drift_are_rejected(self):
        for mutate in [lambda c: c.update(frozen=False), lambda c: c.update(migration='new'),
                       lambda c: c['sources'].update({'apps/api/prisma-mysql/schema.prisma': 'a'*64}),
                       lambda c: c['configurationSha256'].update({'extra': 'a'*64}),
                       lambda c: c['runtimeEvidence'].update(status='UNKNOWN')]:
            c = copy.deepcopy(self.c)
            mutate(c)
            with self.assertRaisesRegex(RuntimeError, 'MAILBOX_REALTIME_'):
                r.verify_contract(c)

    def test_prisma_client_worker_and_shared_javascript_cannot_enter_compiled_delta(self):
        p = load('registration-parity-diagnostics-build.py')
        before = {'safe.js': 'a'}
        for name in ['node_modules/.prisma/client/index.js', 'worker/flow.py', 'packages/shared/dist/index.js']:
            with self.assertRaisesRegex(RuntimeError, 'API_OUTPUT_SCOPE_CHANGED'):
                p.api_delta(before, {**before, name: 'b'}, {'safe.js': 'a'})

    def test_payload_path_traversal_is_rejected(self):
        output = ROOT / '.runtime/mailbox-release/control-tests'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as temporary:
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw, mode='w:gz') as archive:
                entry = tarfile.TarInfo('payload/../../outside')
                entry.size = 1
                archive.addfile(entry, io.BytesIO(b'x'))
            with self.assertRaises(RuntimeError):
                r.archive(raw.getvalue(), Path(temporary) / 'target')

    def test_switch_backup_fence_and_independent_readback_match_the_existing_executor(self):
        original = (HERE / 'registration-parity-diagnostics-release.py').read_text()
        original = original[original.index('def release(plan, contract, d, h):'):]
        original = original.replace('registration-parity-diagnostics', 'mailbox-realtime')
        original = original.replace("'COPY modules/ /app/apps/api/dist/\\nCOPY worker/ /app/' + WORKER + '\\n', 2",
                                    "'COPY modules/ /app/apps/api/dist/\\n', 1")
        current = (HERE / 'mailbox-realtime-release.py').read_text()
        current = current[current.index('def release(plan, contract, d, h):'):]
        self.assertEqual(ast.dump(ast.parse(current)), ast.dump(ast.parse(original)))

    def test_check_only_preparation_cannot_be_packaged_for_production(self):
        output = ROOT / '.runtime/mailbox-release/control-tests'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as temporary, \
                patch.object(b, 'OUTPUT', Path(temporary)), patch.object(b, 'verify_sources', return_value={}), \
                patch.object(b, 'run') as execute:
            with self.assertRaisesRegex(RuntimeError, 'NATIVE_PREDECESSORS_MISSING'):
                b.build()
            execute.assert_not_called()

    def test_squash_safe_source_binding_rejects_changed_bytes(self):
        output = ROOT / '.runtime/mailbox-release/control-tests'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as temporary, patch.object(b, 'ROOT', Path(temporary)):
            source = Path(temporary) / 'reviewed.ts'
            source.write_bytes(b'approved')
            expected = b.digest(source.read_bytes())
            self.assertEqual(b.reviewed_source('reviewed.ts', expected), b'approved')
            source.write_bytes(b'unreviewed')
            with self.assertRaisesRegex(RuntimeError, 'REVIEWED_APPLICATION_CHANGED'):
                b.reviewed_source('reviewed.ts', expected)

    def test_transported_payload_contains_the_entire_verified_helper_closure(self):
        output = ROOT / '.runtime/mailbox-release/control-tests'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as temporary:
            entry = Path(temporary)
            for name in self.c['controlFiles']:
                shutil.copyfile(HERE / name, entry / name)
            spec = importlib.util.spec_from_file_location('isolated_mailbox_entry', entry / 'mailbox-realtime-release.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.verify_contract(self.c)
            (entry / 'account-login-contract.json').unlink()
            with self.assertRaises(FileNotFoundError):
                module.verify_contract(self.c)

    def test_unfrozen_release_stops_before_helpers_or_platform_calls(self):
        with patch.object(r, 'helper') as helper:
            helper.return_value.verify_contract = Mock()
            with self.assertRaisesRegex(RuntimeError, 'CONTRACT_SCOPE_CHANGED'):
                r.release({'mode': 'release'}, {**self.c, 'frozen': False}, Mock(), Mock())

    def test_inspection_waits_for_accepted_command_without_resubmitting(self):
        output = ROOT / '.runtime/mailbox-release/control-tests'
        output.mkdir(parents=True, exist_ok=True)
        pending = subprocess.CompletedProcess([], 254, b'', b'InvocationDoesNotExist')
        success = subprocess.CompletedProcess([], 0, json.dumps({'Status': 'Success',
            'StandardOutputContent': json.dumps({'status': 'MAILBOX_RUNTIME_CAPTURED'})}).encode(), b'')
        with tempfile.TemporaryDirectory(dir=output) as temporary, \
                patch.object(i, 'OUTPUT', Path(temporary)), \
                patch.object(i.subprocess, 'run', side_effect=[pending, success]) as execute, \
                patch.object(i.time, 'sleep'):
            self.assertEqual(i.await_invocation('accepted')['status'], 'MAILBOX_RUNTIME_CAPTURED')
            self.assertEqual(execute.call_count, 2)
            self.assertTrue(all('get-command-invocation' in call.args[0] for call in execute.call_args_list))
            self.assertTrue((Path(temporary) / 'runtime.json').is_file())

    def test_inspection_program_compiles_and_has_no_write_or_business_command(self):
        source = i.capture_source()
        ast.parse(source)
        for command in ('docker restart', 'docker compose', 'send-command', 'INSERT INTO', 'UPDATE ', 'DELETE FROM'):
            self.assertNotIn(command, source)
        self.assertIn("fcntl.LOCK_SH|fcntl.LOCK_NB", source)


if __name__ == '__main__':
    unittest.main()
