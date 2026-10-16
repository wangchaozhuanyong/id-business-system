"""Pure release controls. Never open SQLite, connect a database, or call a platform."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(suffix):
    path = HERE / ('registration-protocol-restore-' + suffix + '.py')
    spec = importlib.util.spec_from_file_location('restore_test_' + suffix, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r, b, d = load('release'), load('build'), load('dispatch')


def contract():
    return json.loads((HERE / 'registration-protocol-restore-contract.json').read_bytes())


def structural_fixture():
    c = contract()
    c['frozen'] = True
    c['runtimeEvidence'] = {'status': 'VERIFIED', 'commit': r.CURRENT}
    c['predecessorReceipts'] = copy.deepcopy(r.PREDECESSOR_RECEIPTS)
    c['reviewedFileHashes'] = {n: r.digest((ROOT / n).read_bytes()) for n in c['expectedGitChanges']
        if n not in c['withdrawal']['sourceRemovals']
        and n != 'scripts/production-release/registration-protocol-restore-contract.json'}
    return c


class RestoreControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / '.runtime').mkdir(mode=0o700, exist_ok=True)

    def test_inventory_excludes_only_incremental_build_metadata(self):
        with tempfile.TemporaryDirectory(prefix='restore-inventory-', dir=ROOT / '.runtime') as directory:
            context = Path(directory)
            for name in ['a.js', 'a.js.map', 'a.d.ts', 'tsconfig.tsbuildinfo', 'tsconfig.build.tsbuildinfo',
                         'other.tsbuildinfo']:
                (context / name).write_text(name)
            self.assertEqual(set(b.inventory(context)), {'a.js', 'a.js.map', 'a.d.ts', 'other.tsbuildinfo'})

    def test_unfrozen_contract_never_admits_publication(self):
        c = contract()
        c['frozen'] = False
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_FROZEN'):
            r.verify_contract(c)

    def test_exact_ancestor_tree(self):
        result = subprocess.check_output(['git', 'rev-parse', r.SOURCE_BASE + '^{tree}'], cwd=ROOT)
        self.assertEqual(result.decode().strip(), r.SOURCE_TREE)

    def test_frozen_structural_contract_refuses_boundary_and_schema_drift(self):
        r.verify_contract(structural_fixture())
        for key in ['schemaSha256', 'scope', 'sourceBaseline', 'expectedCurrent']:
            c = structural_fixture()
            c[key] = '0' * 64
            with self.assertRaises(RuntimeError):
                r.verify_contract(c)
        c = structural_fixture()
        c['withdrawal']['allowHistoricalBrowserResume'] = True
        with self.assertRaisesRegex(RuntimeError, 'WITHDRAWAL_BOUNDARY_CHANGED'):
            r.verify_contract(c)
        c = structural_fixture()
        c['retainedSharedCard']['sources'].pop('apps/api/prisma-mysql/schema.prisma')
        with self.assertRaisesRegex(RuntimeError, 'SHARED_CARD_INHERITANCE_CHANGED'):
            r.verify_contract(c)
        c = structural_fixture()
        c['protectedMigrations'].pop('20261016150000_shared_bank_card_pool')
        with self.assertRaisesRegex(RuntimeError, 'SHARED_CARD_MIGRATION_NOT_PROTECTED'):
            r.verify_contract(c)
        for key in ['retainedMailboxVersion', 'mailboxVersionReceipts']:
            c = structural_fixture()
            c[key] = {}
            with self.assertRaises(RuntimeError):
                r.verify_contract(c)

    def test_historical_publishers_are_byte_exact(self):
        r.history(contract())
        for name, expected in r.HISTORICAL_CONTROLS.items():
            raw = subprocess.check_output(['git', 'show', r.SOURCE_BASE + ':scripts/production-release/' + name], cwd=ROOT)
            self.assertEqual(r.digest(raw), expected)

    def test_six_api_and_three_worker_paths_are_the_only_image_deletions(self):
        c = contract()
        command = r.deletion_command(c)
        self.assertEqual(command.count('RUN '), 1)
        self.assertEqual(command.count('sha256sum -c -'), 1)
        self.assertEqual(command.count(' && rm -- '), 1)
        self.assertEqual(len(command.splitlines()), 1)
        for name, digest in c['withdrawal']['apiRemovals'].items():
            self.assertIn(digest + '  /app/apps/api/dist/' + name, command)
        for name in c['withdrawal']['workerRemovals']:
            self.assertIn('/app/' + r.WORKER + name, command)
        self.assertNotIn('prisma', command)
        self.assertNotIn('upstream', command)

    def test_image_delete_has_no_shell_or_parent_path_expansion(self):
        for bad in ['../../secret.py', 'x;curl_bad.py', "x'bad.py"]:
            c = contract()
            c['withdrawal']['workerRemovals'][bad] = c['withdrawal']['workerRemovals'].pop('apple_browser_registration.py')
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_DELETE_SCOPE_INVALID'):
                r.deletion_command(c)

    def test_new_host_only_deletion_checks_all_hashes_before_mutating(self):
        base = ROOT / '.runtime'
        base.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='restore-controls-', dir=base) as directory:
            target = Path(directory)
            for name in ['a.py', 'b.py']:
                (target / name).write_text(name)
            c = {'withdrawal': {'sourceRemovals': {'a.py': r.digest(b'a.py'), 'b.py': '0' * 64}}}
            with self.assertRaisesRegex(RuntimeError, 'HOST_DELETE_SOURCE_CHANGED'):
                r.remove_host_sources(target, c)
            self.assertTrue((target / 'a.py').exists())
            self.assertTrue((target / 'b.py').exists())
            c['withdrawal']['sourceRemovals']['b.py'] = r.digest(b'b.py')
            r.remove_host_sources(target, c)
            self.assertEqual(list(target.iterdir()), [])

    def test_publisher_patches_only_two_known_boundaries(self):
        namespace = r.release_namespace(contract())
        code = namespace['release'].__code__
        self.assertIn('remove_host_sources', code.co_names)
        strings = [v for v in code.co_consts if isinstance(v, str)]
        self.assertTrue(any(v.startswith('RUN printf') for v in strings))
        self.assertIn('registration-protocol-restore-', ''.join(strings))
        self.assertNotIn('registration-parity-diagnostics-', ''.join(strings))

    def test_shared_schema_and_sources_do_not_overlap_removed_browser_paths(self):
        c = contract()
        self.assertEqual(set(c['retainedSharedCard']['sources']) & set(c['withdrawal']['sourceRemovals']), set())
        self.assertEqual(c['schemaSha256'], c['retainedSharedCard']['sources']['apps/api/prisma-mysql/schema.prisma'])
        self.assertEqual(c['baselineEngineFiles'], c['retainedSharedCard']['afterEngineFiles'])
        self.assertEqual(len(c['baselinePrismaClientFiles']), 18)
        self.assertEqual(len(c['runtimePrismaClientFiles']), 27)

    def test_retained_mailbox_host_and_all_three_modules_are_required(self):
        class Checker:
            calls = []

            @classmethod
            def verify_modules(cls, *args):
                cls.calls.append(args)

        with tempfile.TemporaryDirectory(prefix='restore-mailbox-', dir=ROOT / '.runtime') as directory:
            target = Path(directory)
            name, expected = next(iter(r.MAILBOX_VERSION_SOURCES.items()))
            source = target / name
            source.parent.mkdir(parents=True)
            raw = subprocess.check_output(['git', 'show', r.CURRENT + ':' + name], cwd=ROOT)
            self.assertEqual(r.digest(raw), expected)
            source.write_bytes(raw)
            r.retained_mailbox('driver', target, Checker)
            self.assertEqual(Checker.calls, [('driver', target, r.MAILBOX_VERSION_MODULES)])
            source.write_text('unexpected')
            with self.assertRaisesRegex(RuntimeError, 'RETAINED_MAILBOX_HOST_SOURCE_CHANGED'):
                r.retained_mailbox('driver', target, Checker)
            self.assertEqual(len(Checker.calls), 1)

    def test_published_validation_restores_installed_bytes_even_when_a_test_fails(self):
        with tempfile.TemporaryDirectory(prefix='restore-validation-', dir=ROOT / '.runtime') as directory:
            context = Path(directory)
            c = contract()
            old, expected = {}, {}
            for filename in ['test_workspace.py', 'test_apple_mailboxes.py', 'test_release_safety.py']:
                name = r.WORKER + filename
                path = context / name
                path.parent.mkdir(parents=True, exist_ok=True)
                old[name] = subprocess.check_output(['git', 'show', 'e90f02a65cdf63b656e82eed6e25fd8a68a21b7b:' + name], cwd=ROOT)
                expected[name] = subprocess.check_output(['git', 'show', '59b36f3aadef28a59f47a55ed1e66686fcc2c42c:' + name], cwd=ROOT)
                path.write_bytes(old[name])
            for fail in (False, True):
                try:
                    with b.published_worker_validation(context, c):
                        self.assertTrue(all((context / n).read_bytes() == raw for n, raw in expected.items()))
                        if fail:
                            raise ValueError('synthetic-test-failure')
                except ValueError:
                    self.assertTrue(fail)
                self.assertTrue(all((context / n).read_bytes() == raw for n, raw in old.items()))

    def test_generator_child_matches_published_ci_metadata_without_changing_parent(self):
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}, clear=True), patch.object(b, 'run') as run:
            b.generate_client(Path('/synthetic/context'))
            self.assertEqual(os.environ['GITHUB_ACTIONS'], 'false')
            self.assertEqual(run.call_args.kwargs['env']['GITHUB_ACTIONS'], 'true')
            self.assertEqual(run.call_args.args, ('npm', 'run', 'prisma:mysql:generate'))
            self.assertEqual(run.call_args.kwargs['cwd'], Path('/synthetic/context'))

    def test_api_ci_prepares_fixture_runtime_but_local_guard_precedes_all_writes(self):
        class Prepared(Exception):
            pass
        with tempfile.TemporaryDirectory(prefix='restore-ci-', dir=ROOT / '.runtime') as directory:
            output = Path(directory) / 'isolated'
            with patch.object(b, 'OUTPUT', output), patch.object(b, 'prepare') as prepare:
                with patch.dict(os.environ, {}, clear=True):
                    with self.assertRaisesRegex(RuntimeError, 'CHECKS_REQUIRE_ISOLATED_CI'):
                        b.check('check-api')
                prepare.assert_not_called()
                self.assertFalse(output.exists())
                with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'CHECK_MODE': 'recharge'}, clear=True), \
                     patch.object(b, 'run', side_effect=Prepared):
                    with self.assertRaises(Prepared):
                        b.check('check-api')
                prepare.assert_called_once_with()
                self.assertTrue((output / 'candidate/.runtime').is_dir())
                self.assertEqual((output / 'candidate/.runtime').stat().st_mode & 0o777, 0o700)

    def test_generated_client_only_normalizes_two_exact_known_fields(self):
        with tempfile.TemporaryDirectory(prefix='restore-client-', dir=ROOT / '.runtime') as directory:
            context = Path(directory)
            client = context / 'node_modules/.prisma/client'
            client.mkdir(parents=True)
            c = {'prismaPathMetadata': contract()['prismaPathMetadata'], 'baselinePrismaClientFiles': {}}
            published = c['prismaPathMetadata']['publishedContext']
            for name in ['index.js', 'edge.js', 'wasm.js']:
                raw = '"output": {\n      "value": ' + json.dumps(str(context / 'node_modules/@prisma/client')) + '\n' \
                    + '"sourceFilePath": ' + json.dumps(str(context / 'apps/api/prisma-mysql/schema.prisma')) \
                    + '\n"ciName": "GitHub Actions"\n'
                (client / name).write_text(raw)
                normalized = raw
                for suffix in ['node_modules/@prisma/client', 'apps/api/prisma-mysql/schema.prisma']:
                    normalized = normalized.replace(json.dumps(str(context / suffix)),
                                                    json.dumps(published + '/' + suffix))
                c['baselinePrismaClientFiles'][name] = r.digest(normalized.encode())
            self.assertEqual(b.unchanged_client(context, c), c['baselinePrismaClientFiles'])
            (client / 'unexpected.js').write_text('unexpected')
            with patch('builtins.print'), self.assertRaisesRegex(RuntimeError, 'UNCHANGED_CLIENT_NOT_REPRODUCED'):
                b.unchanged_client(context, c)

    def test_api_delta_requires_exact_six_known_before_hashes(self):
        c = contract()
        approved = c['apiModules']
        before = {**approved, **c['withdrawal']['apiRemovals'], **r.MAILBOX_VERSION_MODULES,
                  r.TYPE_DECLARATION: 'b' * 64}
        after = {**{n: 'a' * 64 for n in approved}, **r.MAILBOX_VERSION_MODULES}
        type_js = r.TYPE_DECLARATION.removesuffix('.d.ts') + '.js'
        after[type_js] = before[type_js]
        after[r.TYPE_DECLARATION] = r.TYPE_DECLARATION_SHA
        self.assertEqual(set(b.api_delta(before, after, approved)), set(approved) - {type_js} | {r.TYPE_DECLARATION})
        for name in c['withdrawal']['apiRemovals']:
            changed = dict(before)
            changed[name] = 'b' * 64
            with self.assertRaisesRegex(RuntimeError, 'COMPILED_REMOVAL_SCOPE_CHANGED'):
                b.api_delta(changed, after, approved)
        with self.assertRaisesRegex(RuntimeError, 'COMPILED_REMOVAL_SCOPE_CHANGED'):
            b.api_delta({**before, 'unrelated.js': 'c' * 64}, after, approved)
        for name in r.MAILBOX_VERSION_MODULES:
            changed = {**after, name: 'f' * 64}
            with self.assertRaisesRegex(RuntimeError, 'RETAINED_MAILBOX_MODULE_CHANGED'):
                b.api_delta(before, changed, approved)

    def test_archive_path_traversal_and_duplicate_proof_are_refused(self):
        for names in [['payload/../unsafe'], ['payload/build-proof.json', 'payload/build-proof.json']]:
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w:gz') as archive:
                for name in names:
                    raw = b'{}'
                    info = tarfile.TarInfo(name)
                    info.size = len(raw)
                    archive.addfile(info, io.BytesIO(raw))
            with self.assertRaisesRegex(RuntimeError, 'PUBLISHED_PAYLOAD_INVALID'):
                b.verify_bundle(output.getvalue(), {})

    def test_large_member_exception_is_only_the_exact_published_shared_declaration(self):
        binding = r.PUBLISHED_BUILDS['sharedCard']
        name = 'payload/api/prisma-client/index.d.ts'
        self.assertEqual(b.historical_member_limit(binding, name), 13060611)
        self.assertEqual(b.SHARED_DECLARATION_SHA, contract()['baselinePrismaClientFiles']['index.d.ts'])
        for other_name in ['payload/api/prisma-client/other.d.ts', 'payload/api/prisma-client/index.js',
                           'payload/source/index.d.ts']:
            self.assertEqual(b.historical_member_limit(binding, other_name), 8 * 1024**2)
        for key in ['commit', 'proofSha256', 'bundleSha256', 'artifactDigest']:
            changed = {**binding, key: '0' * 64}
            self.assertEqual(b.historical_member_limit(changed, name), 8 * 1024**2)

    def test_readonly_native_receipt_identity_and_whole_result_are_pinned(self):
        result = {'status': 'SHARED_BANK_CARD_FORWARD_FINALIZED', 'commit': r.CURRENT, 'businessActions': 0}
        row = {'CommandId': 'known', 'InstanceId': r.INSTANCE, 'DocumentName': 'AWS-RunShellScript', 'Status': 'Success', 'ResponseCode': 0,
               'StandardErrorContent': '', 'StandardOutputContent': json.dumps(result)}
        raw = json.dumps(row).encode()
        binding = {'commandId': 'known', 'sha256': r.digest(raw), 'canonicalSha256': r.digest(r.canonical(row)), 'result': result}
        d.verify_native_receipt(raw, binding)
        d.verify_native_receipt(json.dumps(row, sort_keys=True, indent=2).encode(), binding)
        for key, value in [('canonicalSha256', '0' * 64), ('commandId', 'other'), ('result', {**result, 'businessActions': 1})]:
            with self.assertRaises(RuntimeError):
                d.verify_native_receipt(raw, {**binding, key: value})

    def test_cli_entrypoints_actually_reject_invalid_modes_without_network(self):
        for suffix, args, code in [('build', ['invalid'], 'BUILD_MODE_INVALID'),
                                   ('dispatch', ['invalid'], 'DISPATCH_ARGUMENTS_INVALID')]:
            result = subprocess.run([sys.executable, '-B', str(HERE / ('registration-protocol-restore-' + suffix + '.py')),
                                     *args], capture_output=True, cwd=ROOT)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(code.encode(), result.stderr)


if __name__ == '__main__':
    unittest.main()
