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
published = load('mailbox-realtime-baseline.py')


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

    def test_current_inventory_contract_fits_the_bounded_remote_download(self):
        raw = (HERE / 'mailbox-realtime-contract.json').read_bytes()
        self.assertLess(len(raw), 512 * 1024)
        dispatcher = (HERE / 'mailbox-realtime-dispatch.py').read_text()
        self.assertIn('response.read(512*1024+1)', dispatcher)
        self.assertIn('len(raw)>512*1024', dispatcher)

    def test_unfrozen_release_stops_before_helpers_or_platform_calls(self):
        with patch.object(r, 'baseline') as baseline:
            with self.assertRaisesRegex(RuntimeError, 'CONTRACT_SCOPE_CHANGED'):
                r.release({'mode': 'release'}, {**self.c, 'frozen': False}, Mock(), Mock())
            baseline.assert_not_called()

    def test_failed_run_needs_the_exact_forward_finalization_and_independent_readback(self):
        record = json.loads((HERE / 'mailbox-realtime-predecessor.json').read_bytes())
        native = record['forwardNative']
        binding = self.c['predecessorNative']
        published.verify_forward_native(native, binding)
        for key, value in [('Status', 'Failed'), ('ResponseCode', 1), ('CommandId', 'other'),
                           ('InstanceId', 'other'), ('StandardErrorContent', 'error')]:
            with self.assertRaisesRegex(RuntimeError, 'FORWARD_RECEIPT_CHANGED'):
                published.verify_forward_native({**native, key: value}, binding)
        result = json.loads(native['StandardOutputContent'])
        result['maintenanceReleased'] = False
        with self.assertRaisesRegex(RuntimeError, 'FORWARD_RECEIPT_CHANGED'):
            published.verify_forward_native({**native, 'StandardOutputContent': json.dumps(result)}, binding)

    def test_mount_order_is_equivalent_but_sources_modes_and_destinations_are_not(self):
        row = {'HostConfig': {'Binds': ['/one:/app/.runtime/online-recharge:rw',
                                      '/two:/app/.runtime/auto-registration:rw']}}
        reverse = copy.deepcopy(row)
        reverse['HostConfig']['Binds'].reverse()
        canonical = published.canonical_bindings(row)
        self.assertEqual(canonical, published.canonical_bindings(reverse))
        for declaration in ['/changed:/app/.runtime/online-recharge:rw',
                            '/one:/app/.runtime/online-recharge:ro']:
            changed = copy.deepcopy(row)
            changed['HostConfig']['Binds'][0] = declaration
            self.assertNotEqual(canonical, published.canonical_bindings(changed))
        for binds in [row['HostConfig']['Binds'][:1], [*row['HostConfig']['Binds'], '/extra:/other:rw'],
                      ['/one:/same:rw', '/two:/same:rw']]:
            with self.assertRaisesRegex(RuntimeError, 'API_BIND_SCOPE_CHANGED'):
                published.canonical_bindings({'HostConfig': {'Binds': binds}})
        self.assertEqual(row['HostConfig']['Binds'][0], '/one:/app/.runtime/online-recharge:rw')

    def test_current_sqlite_policy_keeps_all_four_tasks_and_the_existing_review_lease(self):
        policy = self.c['sqliteReviewPolicy']
        receipt = {'version': 1, 'status': 'PASS', **policy['summary'],
            'activeAppleLeaseCount': 1, 'executingTaskCount': 0, 'retainedReviewLeaseCount': 1,
            'corruptEncryptedValueCount': 0, 'leaseFacts': policy['leaseFacts'],
            'protectedTaskFacts': policy['protectedTaskFacts'],
            'dependencies': self.c['runtimePythonDependencies'], 'businessActions': 0}
        self.assertEqual(len(receipt['protectedTaskFacts']), 4)
        published.validate_sqlite_receipt(receipt, self.c)
        for field in ('leaseFacts', 'protectedTaskFacts'):
            changed = copy.deepcopy(receipt)
            changed[field].pop()
            with self.assertRaisesRegex(RuntimeError, 'SQLITE_PRESERVATION_CHANGED'):
                published.validate_sqlite_receipt(changed, self.c)

    def test_inspection_namespace_rebinds_guards_without_changing_the_historical_publisher(self):
        namespace = published.runtime_namespace()
        self.assertEqual(namespace['CURRENT'], self.c['expectedCurrent'])
        self.assertIs(namespace['sqlite_receipt'], published.sqlite_receipt)
        self.assertIs(namespace['baseline'].__globals__, namespace)
        self.assertIs(namespace['backup_sqlite'].__globals__, namespace)

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
