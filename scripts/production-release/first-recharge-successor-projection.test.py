"""Offline exact-source projection regressions using genuine Git archives only."""

from contextlib import contextmanager
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
BUSINESS_COMMIT = '3b7fea251508f7ffb32cc98553bdc56790cb6e1b'
BUSINESS_TREE = '1da5cd9e60311a45698493bf131927019d9851e8'
CONTRACT_SHA256 = 'fbf1c5709ef9d4036f67bd2be97abdb121594bb1807d037ead0d28ce0a7faad5'
API_COMMIT = '43c31870c9497d900491cdb19c5f61c766f3b344'
ADMIN_COMMIT = '568e9390a304a36edba86823d5d5b31e5506763b'
API_COLD_SEAL = '973305a109c0044194e86413a8cebfbd1dac8a7ddb741d9ffca6cfee9052e1c8'
ADMIN_COLD_SEAL = '5765c1932777da4b36b157523551b4c7fd551c23a4709d086a71487ccba34bd0'


def load(filename):
    path = HERE / filename
    spec = importlib.util.spec_from_file_location('first_projection_test_' + filename.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


class FirstRechargeProjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = load('first-recharge-successor-projection.py')
        cls.reader = staticmethod(load('remote-deploy.py').registration_archive)
        cls.archive_cache = {}
        cls.spec = cls.p.contract()
        cls.candidate = cls.reader(cls.git_archive(BUSINESS_COMMIT), BUSINESS_COMMIT)
        cls.d = cls.controller()
        cls.before, cls.origins = cls.p.published_sources(cls.d, {})
        cls.output, cls.record = cls.p.project_sources(cls.d, cls.candidate, BUSINESS_COMMIT, BUSINESS_TREE)

    @classmethod
    def git_archive(cls, commit):
        if commit not in cls.archive_cache:
            cls.archive_cache[commit] = subprocess.check_output([
                'git', 'archive', '--format=tar', '--prefix=id-business-system-' + commit + '/', commit], cwd=ROOT)
        return cls.archive_cache[commit]

    @classmethod
    def controller(cls):
        # Never call the remote reader, a production CLI, or a database helper.
        return SimpleNamespace(registration_download=cls.git_archive, registration_archive=cls.reader)

    def project(self, candidate, *, tree=None, controller=None):
        return self.p.project_sources(controller or self.controller(), candidate, BUSINESS_COMMIT,
                                      self.p.source_tree(candidate) if tree is None else tree)

    def changed(self, path, *, mode=None, remove=False):
        candidate = dict(self.candidate)
        if remove:
            del candidate[path]
        else:
            raw, previous_mode = candidate[path]
            candidate[path] = (raw if mode else raw + b'\n', mode or previous_mode)
        return candidate

    def reseal(self, record):
        record['projectionSha256'] = self.p.fingerprint({k: v for k, v in record.items() if k != 'projectionSha256'})
        return record

    def contract_bytes(self, value):
        value['contractSha256'] = self.p.fingerprint({k: v for k, v in value.items() if k != 'contractSha256'})
        return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

    @contextmanager
    def build_context(self):
        # The context contract uses cwd; the isolated cwd and every controlled
        # output remain within this project's existing runtime directory.
        runtime = ROOT / '.runtime/first-recharge-release-20261014'
        previous = Path.cwd()
        with tempfile.TemporaryDirectory(prefix='projection-context-', dir=runtime) as directory:
            try:
                os.chdir(directory)
                context = Path(directory) / self.p.CONTEXT
                context.mkdir(parents=True)
                yield context
            finally:
                os.chdir(previous)

    def test_exact_business_archive_and_independent_contract_identity(self):
        self.assertEqual(self.p.BUSINESS_COMMIT, BUSINESS_COMMIT)
        self.assertEqual(self.p.source_tree(self.candidate), BUSINESS_TREE)
        self.assertEqual(self.spec['businessTree'], BUSINESS_TREE)
        self.assertEqual(self.p.APPROVED_CONTRACT_SHA256, CONTRACT_SHA256)
        self.assertEqual(self.spec['contractSha256'], CONTRACT_SHA256)
        self.assertEqual(len(self.spec['businessFiles']), 37)
        self.assertEqual(len(self.p.application_rows(self.candidate)), 2192)
        self.assertEqual(self.p.fingerprint(self.p.application_rows(self.candidate)),
                         self.spec['applicationInputSha256'])
        for path, row in self.spec['businessFiles'].items():
            with self.subTest(path=path):
                self.assertEqual(self.p.inventory({path: self.candidate[path]})[path], row)

    def test_real_api_and_admin_history_remains_distinct(self):
        self.assertEqual(self.p.API_COMMIT, API_COMMIT)
        self.assertEqual(self.p.ADMIN_COMMIT, ADMIN_COMMIT)
        # The API cold seal hashes its complete original record. It is not the
        # inner projectionSha256, and no missing historical evidence is filled.
        self.assertEqual(self.p.fingerprint(self.origins['api']), API_COLD_SEAL)
        self.assertNotEqual(self.origins['api']['projectionSha256'], API_COLD_SEAL)
        self.assertEqual(self.origins['api']['outputTree'], 'd106de236dfa914833c8fe84067f9ecfd26e3579')
        self.assertEqual(self.origins['admin']['projectionSha256'], ADMIN_COLD_SEAL)
        self.assertEqual(self.origins['admin']['outputTree'], '6208e3e23dd2f158ddefad0f146021ee7ff6312f')
        self.assertEqual(self.origins['admin']['profile'], 'ADMIN_CONFIRM_EXPIRY_20261014')
        self.assertEqual(self.origins['admin']['overlaySha256'],
                         'a3ea38d3f31dce7f438d067e6bfbafe4108636ed50c75621beb44a8948b2b8b7')
        for role, commit, seal in (('api', API_COMMIT, API_COLD_SEAL), ('admin', ADMIN_COMMIT, ADMIN_COLD_SEAL)):
            self.assertEqual(self.record['contexts'][role]['baseCommit'], commit)
            self.assertEqual(self.record['contexts'][role]['baselineProjectionSha256'], seal)

    def test_only_31_role_owned_inputs_change_and_all_other_bytes_survive(self):
        self.p.verify_output(self.output, self.record)
        self.assertEqual(self.record['contexts'], self.spec['outputSeals']['contexts'])
        self.assertEqual(self.record['outputTree'], self.spec['outputSeals']['outputTree'])
        self.assertEqual(self.record['outputFilesSha256'], self.spec['outputSeals']['outputFilesSha256'])
        for role, count in (('api', 16), ('admin', 15)):
            allowed = {n for n in self.spec['businessFiles'] if n.startswith('apps/' + role + '/')}
            context = {n[len(role) + 1:]: row for n, row in self.output.items() if n.startswith(role + '/')}
            actual = {n for n in set(context) | set(self.before[role])
                      if context.get(n) != self.before[role].get(n)}
            self.assertEqual(len(actual), count)
            self.assertEqual(actual, set(self.record['contexts'][role]['changedFiles']))
            self.assertLessEqual(actual, allowed)
            self.assertEqual(set(context) - set(self.before[role]), actual - set(self.before[role]))
            for path, row in self.before[role].items():
                if path not in actual:
                    self.assertEqual(context[path], row, role + '/' + path)

    def test_billing_table_preserves_new_name_and_original_online_inverse(self):
        table = 'apps/admin/src/v2/features/tableSchemas.ts'
        self.assertIn(b'onlineTablesByFeature', self.candidate[table][0])
        table_output = self.output['admin/' + table][0]
        self.assertNotIn(b'onlineTablesByFeature', table_output)
        self.assertNotIn(b'online-recharge', table_output)
        self.assertIn("{ key: 'billingName', label: '账单姓名'".encode(), table_output)
        for role in ('api', 'admin'):
            context = {n[len(role) + 1:]: row for n, row in self.output.items() if n.startswith(role + '/')}
            self.assertFalse(any(n.startswith(self.p.history.ONLINE_PREFIXES) for n in context))
            for path in ('apps/admin/src/v2-router.ts', 'apps/admin/src/v2/features/registry.ts',
                         'apps/admin/src/v2/layouts/V2AdminLayout.vue',
                         'apps/api/src/id-business-v2/id-business-v2.module.ts'):
                self.assertNotIn(b'online-recharge', context[path][0], role + '/' + path)
            for path in self.p.history.ADMIN_OVERLAY_FILES:
                self.assertEqual(context[path], self.before[role][path])

    def test_schema_every_migration_runtime_and_grant_sources_are_unchanged(self):
        self.assertEqual(self.spec['newMigrations'], [])
        self.assertIs(self.spec['migrationPerformed'], False)
        self.assertEqual(self.spec['updatedServices'], ['api', 'admin'])
        self.assertIs(self.spec['onlinePublished'], False)
        self.assertEqual(self.spec['businessActions'], 0)
        for role in ('api', 'admin'):
            protected = {n: row for n, row in self.before[role].items()
                         if n.startswith(('apps/api/prisma-mysql/', 'deploy/mysql/'))
                         or 'grant' in n.lower() or n in self.p.RUNTIME_FILES}
            actual = {n[len(role) + 1:]: row for n, row in self.output.items()
                      if n.startswith(role + '/') and (n[len(role) + 1:].startswith(
                          ('apps/api/prisma-mysql/', 'deploy/mysql/'))
                          or 'grant' in n[len(role) + 1:].lower() or n[len(role) + 1:] in self.p.RUNTIME_FILES)}
            self.assertTrue(any('/migrations/' in n for n in protected))
            self.assertEqual(actual, protected)
        runtime = self.p.runtime_config_files(self.controller(), self.candidate, self.record)
        self.assertEqual(set(runtime), set(self.p.RUNTIME_FILES))
        self.assertEqual(runtime, {n: self.before['api'][n] for n in self.p.RUNTIME_FILES})

    def test_extra_application_wip_missing_file_or_unrelated_edit_is_rejected(self):
        extra = dict(self.candidate)
        extra['apps/admin/src/v2/features/unreviewed.ts'] = (b'export {};\n', '100644')
        for files in (extra, self.changed('apps/api/src/main.ts'), self.changed('apps/api/src/main.ts', remove=True)):
            with self.subTest(paths=len(files)), self.assertRaisesRegex(RuntimeError, 'UNRELATED_APPLICATION_SOURCE_CHANGED'):
                self.project(files)

    def test_frozen_business_file_bytes_and_modes_are_not_wildcards(self):
        for path in ('apps/api/src/id-business-v2/auto-recharge/worker/pay.py',
                     'apps/admin/src/v2/features/auto-recharge/recharge-presentation.ts',
                     'docs/AUTO_RECHARGE_FIRST_SUBSCRIPTION_FIXES_20261014.md'):
            for files in (self.changed(path), self.changed(path, mode='100755'), self.changed(path, remove=True)):
                with self.subTest(path=path), self.assertRaisesRegex(
                        RuntimeError, 'UNRELATED_APPLICATION_SOURCE_CHANGED|BUSINESS_SOURCE_CHANGED'):
                    self.project(files)

    def test_extra_or_changed_schema_and_migrations_are_rejected(self):
        extra = dict(self.candidate)
        extra['apps/api/prisma-mysql/migrations/20990101000000_unreviewed/migration.sql'] = (b'SELECT 1;\n', '100644')
        schema = 'apps/api/prisma-mysql/schema.prisma'
        old_migration = 'apps/api/prisma-mysql/migrations/20261012143000_recharge_connection_profiles/migration.sql'
        for files in (extra, self.changed(schema), self.changed(schema, mode='100755'), self.changed(old_migration)):
            with self.subTest(paths=len(files)), self.assertRaisesRegex(RuntimeError, 'UNRELATED_APPLICATION_SOURCE_CHANGED'):
                self.project(files)

    def test_false_candidate_tree_is_rejected_before_projection(self):
        with self.assertRaisesRegex(RuntimeError, 'CANDIDATE_TREE_CHANGED'):
            self.project(self.candidate, tree='0' * 40)

    def test_real_baseline_archive_blob_or_mode_drift_is_rejected(self):
        for commit in (API_COMMIT, ADMIN_COMMIT):
            original = self.reader(self.git_archive(commit), commit)
            for mode in (None, '100755'):
                changed = dict(original)
                raw, old_mode = changed['apps/api/src/main.ts']
                changed['apps/api/src/main.ts'] = (raw if mode else raw + b'\n', mode or old_mode)
                controller = self.controller()
                controller.registration_archive = lambda raw, sha, fault=changed, target=commit: (
                    fault if sha == target else self.reader(raw, sha))
                with self.subTest(commit=commit, mode=mode), self.assertRaisesRegex(RuntimeError, 'BASELINE_SOURCE_CHANGED'):
                    self.p.published_sources(controller, {})

    def test_changed_business_archive_is_rejected_even_with_unchanged_candidate(self):
        changed = self.changed('apps/api/src/id-business-v2/auto-recharge/worker/pay.py')
        controller = self.controller()
        controller.registration_archive = lambda raw, commit: (
            changed if commit == BUSINESS_COMMIT else self.reader(raw, commit))
        with self.assertRaisesRegex(RuntimeError, 'BUSINESS_SOURCE_CHANGED'):
            self.project(self.candidate, controller=controller)

    def test_cold_helper_actual_byte_drift_is_rejected_without_editing_it(self):
        target = HERE / 'remote-deploy.py'
        original = Path.read_bytes
        def read(path):
            raw = original(path)
            return raw + b'\n# altered cold helper\n' if path == target else raw
        with patch.object(Path, 'read_bytes', read), self.assertRaisesRegex(RuntimeError, 'COLD_HELPER_CHANGED'):
            self.p.contract()

    def test_initial_import_rejects_changed_cold_helpers_before_payload_execution(self):
        payload = b'__import__("builtins").first_recharge_cold_sentinel()\n'
        original = Path.read_bytes
        for filename in ('online-recharge-component-consumer.py', 'api-admin-pending-projection.py'):
            target = HERE / filename
            with self.subTest(helper=filename), patch.object(Path, 'read_bytes',
                    lambda path: payload if path == target else original(path)), patch(
                        'builtins.first_recharge_cold_sentinel', create=True) as sentinel:
                with self.assertRaisesRegex(RuntimeError, '^FIRST_RECHARGE_COLD_HELPER_CHANGED$'):
                    load('first-recharge-successor-projection.py')
                sentinel.assert_not_called()

    def test_initial_import_rejects_resealed_contract_and_payload_before_execution(self):
        payload = b'__import__("builtins").first_recharge_cold_sentinel()\n'
        contract_path = HERE / 'first-recharge-successor-contract.json'
        original = Path.read_bytes
        for filename in ('online-recharge-component-consumer.py', 'api-admin-pending-projection.py'):
            target = HERE / filename
            contract = copy.deepcopy(self.spec)
            contract['coldHelpers'][filename] = self.p.digest(payload)
            raw = self.contract_bytes(contract)
            self.assertNotEqual(contract['contractSha256'], CONTRACT_SHA256)
            def read(path):
                if path == target:
                    return payload
                return raw if path == contract_path else original(path)
            with self.subTest(helper=filename), patch.object(Path, 'read_bytes', read), patch(
                    'builtins.first_recharge_cold_sentinel', create=True) as sentinel:
                with self.assertRaisesRegex(RuntimeError, '^FIRST_RECHARGE_COLD_HELPER_CHANGED$'):
                    load('first-recharge-successor-projection.py')
                sentinel.assert_not_called()

    def test_contract_extra_field_scope_or_cold_seal_cannot_be_self_reauthorized(self):
        variants = []
        extra = copy.deepcopy(self.spec); extra['unreviewed'] = True; variants.append(extra)
        cold = copy.deepcopy(self.spec); cold['coldHelpers']['remote-deploy.py'] = '0' * 64; variants.append(cold)
        scope = copy.deepcopy(self.spec); scope['businessFiles']['apps/api/src/main.ts'] = self.p.inventory(
            {'apps/api/src/main.ts': self.candidate['apps/api/src/main.ts']})['apps/api/src/main.ts']; variants.append(scope)
        output = copy.deepcopy(self.spec); output['outputSeals']['contexts']['api']['outputTree'] = '0' * 40; variants.append(output)
        target = HERE / 'first-recharge-successor-contract.json'
        original = Path.read_bytes
        for value in variants:
            raw = self.contract_bytes(value)
            with self.subTest(changed=list(value)), patch.object(Path, 'read_bytes',
                    lambda path, fault=raw: fault if path == target else original(path)), self.assertRaisesRegex(
                        RuntimeError, 'CONTRACT_CHANGED'):
                self.p.contract()

    def test_resealed_baseline_or_role_output_record_is_rejected(self):
        variants = []
        for role in ('api', 'admin'):
            for field, value in (('baseCommit', BUSINESS_COMMIT), ('baselineProjectionSha256', '0' * 64),
                                 ('outputTree', '0' * 40), ('outputFilesSha256', '0' * 64)):
                record = copy.deepcopy(self.record); record['contexts'][role][field] = value; variants.append(record)
        swapped = copy.deepcopy(self.record)
        swapped['contexts'] = {'api': swapped['contexts']['admin'], 'admin': swapped['contexts']['api']}
        variants.append(swapped)
        for record in variants:
            with self.subTest(contexts=record['contexts']), self.assertRaisesRegex(RuntimeError, 'PROJECTION_CHANGED'):
                self.p.validate_record(self.reseal(record))

    def test_output_blob_mode_extra_file_and_resealed_changed_output_are_rejected(self):
        path = 'api/apps/api/src/id-business-v2/auto-recharge/worker/pay.py'
        raw, mode = self.output[path]
        variants = []
        for row in ((raw + b'\n', mode), (raw, '100755')):
            output = dict(self.output); output[path] = row; variants.append(output)
        extra = dict(self.output); extra['admin/apps/admin/src/v2/features/unreviewed.ts'] = (b'export {};\n', '100644')
        variants.append(extra)
        for output in variants:
            with self.subTest(paths=len(output)), self.assertRaisesRegex(RuntimeError, 'OUTPUT_CHANGED'):
                self.p.verify_output(output, self.record)
            record = copy.deepcopy(self.record)
            record['outputTree'] = self.p.source_tree(output)
            record['outputFilesSha256'] = self.p.fingerprint(self.p.inventory(output))
            with self.assertRaisesRegex(RuntimeError, 'PROJECTION_CHANGED'):
                self.p.verify_output(output, self.reseal(record))

    def test_build_context_accepts_only_canonical_regular_file_modes(self):
        for mode, git_mode in ((0o644, '100644'), (0o755, '100755')):
            with self.subTest(mode=oct(mode)), self.build_context() as context:
                leaf = context / 'source.py'
                leaf.write_bytes(b'print("offline")\n')
                leaf.chmod(mode)
                self.assertEqual(stat.S_IMODE(leaf.stat().st_mode), mode)
                with patch.object(self.p, 'verify_output', return_value=self.record) as verify:
                    self.assertIs(self.p.verify_build_context(self.controller(), context, self.record), self.record)
                verify.assert_called_once_with({'source.py': (leaf.read_bytes(), git_mode)}, self.record)

    def test_build_context_rejects_private_group_only_and_special_modes_before_read(self):
        for mode in (0o600, 0o640, 0o700, 0o1644, 0o2644, 0o4644, 0o4755):
            with self.subTest(mode=oct(mode)), self.build_context() as context:
                leaf = context / 'source.py'
                leaf.write_bytes(b'print("offline")\n')
                leaf.chmod(mode)
                self.assertEqual(stat.S_IMODE(leaf.stat().st_mode), mode)
                original = Path.read_bytes
                reads = []
                def observe(path):
                    reads.append(path)
                    return original(path)
                with patch.object(Path, 'read_bytes', observe), patch.object(self.p, 'verify_output') as verify:
                    with self.assertRaisesRegex(RuntimeError, 'BUILD_CONTEXT_CHANGED'):
                        self.p.verify_build_context(self.controller(), context, self.record)
                self.assertEqual(reads, [])
                verify.assert_not_called()

    def test_build_context_rejects_over_8_mib_before_leaf_content_read(self):
        with self.build_context() as context:
            # The traversal leaf is deliberately fake so no large artifact is
            # allocated. Assert that the real traversal gate never reads it.
            metadata = SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_size=8 * 1024 * 1024 + 1)
            leaf = SimpleNamespace(is_symlink=Mock(return_value=False), is_file=Mock(return_value=True),
                stat=Mock(return_value=metadata), relative_to=Mock(return_value=Path('large.bin')),
                read_bytes=Mock(side_effect=AssertionError('oversized leaf must not be read')))
            with patch.object(Path, 'rglob', return_value=iter((leaf,))), patch.object(self.p, 'verify_output') as verify:
                with self.assertRaisesRegex(RuntimeError, 'BUILD_CONTEXT_CHANGED'):
                    self.p.verify_build_context(self.controller(), context, self.record)
            leaf.stat.assert_called_once_with()
            leaf.read_bytes.assert_not_called()
            leaf.relative_to.assert_not_called()
            verify.assert_not_called()


if __name__ == '__main__':
    unittest.main()
