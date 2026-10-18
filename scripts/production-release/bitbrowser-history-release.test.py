"""Finite history successor controls; synthetic checks never submit a business action."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('test_history_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


p = load('bitbrowser-history-release.py')
b = load('bitbrowser-history-build.py')


def fixture():
    old = json.loads((HERE / 'bitbrowser-recovery-contract.json').read_bytes())
    api = {n: 'a' * 64 for n in old['apiModules']}
    c = {'version': 1, 'status': 'FROZEN', 'scope': p.SCOPE, 'expectedCurrent': p.CURRENT,
        'reviewBase': p.CURRENT, 'sourceReviewCommit': 'b' * 40,
        'sources': {n: 'a' * 64 for n in p.APPLICATION}, 'apiModules': sorted(p.MODULES),
        'publishedApiModules': api, 'publishedSharedFiles': {n: 'b' * 64 for n in p.SHARED},
        'updatedServices': ['api'], 'reboundServices': ['online-recharge'], 'preservedServices': list(p.PRESERVED),
        'controlPins': {n: 'c' * 64 for n in p.CONTROLS}, 'ciControlPins': {n: 'd' * 64 for n in p.CI_CONTROLS},
        'mysqlTestSources': {n: 'e' * 64 for n in p.MYSQL_FILES},
        'workflowSha256': 'f' * 64, 'qualityWorkflowSha256': 'f' * 64,
        'predecessorProofSha256': p.PREDECESSOR_PROOF, 'sqlFenceHelperSha256': 'c' * 64,
        'engineHealth': copy.deepcopy(p.ENGINE), 'migrationPerformed': False, 'businessActions': 0}
    c['controlPins']['bitbrowser-recovery-contract.json'] = p.PREDECESSOR_CONTRACT
    bline = {'status': 'BITBROWSER_HISTORY_READONLY_BASELINE', 'commit': p.CURRENT,
        'current': '/opt/id-business-v2/releases/history-synthetic-current', 'manifestSha256': 'a' * 64,
        'services': {n: {'status': 'running', 'health': 'healthy'} for n in p.SERVICES},
        'runtimeConfigurationSha256': {n: 'b' * 64 for n in p.SERVICES},
        'configurationSha256': {n: 'c' * 64 for n in p.CONFIGURATION},
        'proofs': {'recharge-checkout-build-proof.json': p.PREDECESSOR_PROOF},
        'apiModules': {n: api[n] for n in p.MODULES}, 'database': {'pending': 0, 'ledger': 'd' * 64, 'columns': 'e' * 64},
        'nginxSha256': 'f' * 64, 'backupNormalizerSha256': 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202',
        'businessActions': 0, 'databaseWrites': 0}
    bline.update({n: {'count': 10, 'sha256': 'a' * 64}
        for n in ('apiPreservedInventory', 'sharedInventory', 'clientInventory', 'adminInventory')})
    c['baseline'] = bline
    return c


class HistoryControls(unittest.TestCase):
    def setUp(self):
        path = HERE / p.CONTRACT_FILE
        actual = json.loads(path.read_bytes())
        self.c = actual if actual.get('status') == 'FROZEN' else fixture()

    def test_frozen_scope_is_three_api_modules_and_three_tests(self):
        p.validate_contract(self.c)
        self.assertEqual(len(p.APPLICATION), 6)
        self.assertEqual(len(p.API_SOURCES), 3)
        self.assertEqual(len(p.MODULES), 9)
        self.assertEqual(self.c['expectedCurrent'], 'fe27681e1ef06b14616276dff33c3febeea47579')
        self.assertIn('admin', p.PRESERVED)
        self.assertNotIn('online-recharge', p.PRESERVED)

    def test_draft_is_not_publishable(self):
        changed = copy.deepcopy(self.c)
        changed['status'] = 'DRAFT_SOURCE_AND_BASELINE_PENDING'
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_IDENTITY'):
            p.validate_contract(changed)

    def test_old_source_and_predecessor_proof_are_fixed(self):
        self.assertEqual(p.sha((HERE / 'bitbrowser-recovery-contract.json').read_bytes()), p.PREDECESSOR_CONTRACT)
        for field in ('expectedCurrent', 'reviewBase', 'predecessorProofSha256'):
            changed = copy.deepcopy(self.c)
            changed[field] = 'a' * (40 if field != 'predecessorProofSha256' else 64)
            with self.assertRaises(RuntimeError):
                p.validate_contract(changed)

    def test_schema_ui_shared_and_extra_output_are_rejected(self):
        for name in ('apps/api/prisma-mysql/schema.prisma', 'apps/admin/src/v2/views/other.vue',
            'packages/shared/src/index.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-direct-payment.ts'):
            changed = copy.deepcopy(self.c)
            changed['sources'][name] = 'a' * 64
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE'):
                p.validate_contract(changed)
        changed = copy.deepcopy(self.c)
        changed['apiModules'].append('unrelated.js')
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE'):
            p.validate_contract(changed)

    def test_only_api_can_be_updated(self):
        for field, value in (('updatedServices', ['api', 'admin']), ('reboundServices', ['auto-recharge']),
            ('preservedServices', ['mysql'])):
            changed = copy.deepcopy(self.c)
            changed[field] = value
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE'):
                p.validate_contract(changed)

    def test_controls_and_ci_sets_are_closed(self):
        for field in ('controlPins', 'ciControlPins', 'mysqlTestSources'):
            changed = copy.deepcopy(self.c)
            changed[field].pop(next(iter(changed[field])))
            with self.assertRaisesRegex(RuntimeError, 'CONTROL_SCOPE'):
                p.validate_contract(changed)
        changed = copy.deepcopy(self.c)
        changed['controlPins']['bitbrowser-recovery-contract.json'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'CONTROL_SCOPE'):
            p.validate_contract(changed)

    def test_missing_or_wrong_native_runtime_module_rejected(self):
        for action in ('missing', 'extra', 'changed'):
            changed = copy.deepcopy(self.c)
            modules = changed['baseline']['apiModules']
            if action == 'missing':
                modules.pop(next(iter(modules)))
            elif action == 'extra':
                modules['other.js'] = 'a' * 64
            else:
                modules[next(iter(modules))] = 'f' * 64
            with self.assertRaisesRegex(RuntimeError, 'BASELINE'):
                p.validate_contract(changed)

    def test_migrations_writes_unhealthy_service_and_missing_inventory_rejected(self):
        for mutate in (lambda c: c.update(migrationPerformed=True),
            lambda c: c.update(businessActions=1), lambda c: c['baseline'].update(databaseWrites=1),
            lambda c: c['baseline']['services']['api'].update(health='starting'),
            lambda c: c['baseline'].pop('sharedInventory')):
            changed = copy.deepcopy(self.c)
            mutate(changed)
            with self.assertRaises(RuntimeError):
                p.validate_contract(changed)

    def test_mysql_evidence_requires_18_real_tests_in_same_native_run(self):
        identity = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '12', 'workflowRunAttempt': '1'}
        value = {**identity, 'scope': 'OWNED_EMPTY_DATABASE', 'runtime': 'github-actions-mysql-service',
            'testFiles': self.c['mysqlTestSources'], 'testsTotal': 18, 'testsPassed': 18, 'testsSkipped': 0,
            'testsTodo': 0, 'productionActions': 0, 'reportSha256': 'd' * 64}
        p.verify_mysql(value, identity, self.c)
        for name, replacement in (('testsPassed', 17), ('testsSkipped', 1), ('testsSkipped', False),
            ('testFiles', {}), ('workflowRunAttempt', '2'), ('productionActions', 1)):
            with self.assertRaisesRegex(RuntimeError, 'MYSQL_EVIDENCE'):
                p.verify_mysql({**value, name: replacement}, identity, self.c)

    def test_source_quality_accepts_affected_guards_api_and_rejects_skips(self):
        b.require_quality_jobs([{'name': 'recharge (guards)', 'conclusion': 'success'},
            {'name': 'recharge (api)', 'conclusion': 'success'}], p)
        for rows in ([{'name': 'recharge (guards)', 'conclusion': 'success'}],
            [{'name': 'recharge (guards)', 'conclusion': 'success'}, {'name': 'recharge (api)', 'conclusion': 'skipped'}]):
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_API_QUALITY'):
                b.require_quality_jobs(rows, p)

    def test_build_rejects_unselected_api_and_any_shared_delta(self):
        before = self.c['publishedApiModules']
        after = {**before, next(n for n in p.MODULES if n.endswith('.js')): 'f' * 64}
        shared = self.c['publishedSharedFiles']
        b.verify_delta(before, after, shared, shared, self.c, p)
        for extra in ('unreviewed.js', 'unreviewed.d.ts', 'unreviewed.js.map'):
            with self.assertRaisesRegex(RuntimeError, 'UNSELECTED_API_OUTPUT'):
                b.verify_delta(before, {**after, extra: 'a' * 64}, shared, shared, self.c, p)
        with self.assertRaisesRegex(RuntimeError, 'SHARED_OUTPUT'):
            b.verify_delta(before, after, shared, {**shared, 'other.js': 'a' * 64}, self.c, p)

    def test_non_reproduced_baseline_and_noop_are_rejected(self):
        before = self.c['publishedApiModules']
        shared = self.c['publishedSharedFiles']
        with self.assertRaisesRegex(RuntimeError, 'BASE_API_NOT_REPRODUCED'):
            b.verify_delta({}, before, shared, shared, self.c, p)
        with self.assertRaisesRegex(RuntimeError, 'EXPECTED_API_DELTA'):
            b.verify_delta(before, before, shared, shared, self.c, p)

    def test_payload_cannot_include_ui_or_shared(self):
        identity = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '12', 'workflowRunAttempt': '1',
            'contractSha256': 'e' * 64}
        mysql = {**identity, 'scope': 'OWNED_EMPTY_DATABASE', 'runtime': 'github-actions-mysql-service',
            'testFiles': self.c['mysqlTestSources'], 'testsTotal': 18, 'testsPassed': 18, 'testsSkipped': 0,
            'testsTodo': 0, 'productionActions': 0, 'reportSha256': 'd' * 64}
        proof = {**identity, 'version': 1, 'scope': p.SCOPE, 'sources': self.c['sources'],
            'controlSources': self.c['controlPins'], 'baselineModulesReproduced': self.c['baseline']['apiModules'],
            'predecessorProofSha256': p.PREDECESSOR_PROOF, 'baselineSharedUnchanged': True,
            'migrationPerformed': False, 'businessActions': 0, 'updatedServices': ['api'],
            'qualityVerification': {}, 'isolatedMysqlVerification': mysql,
            'apiModules': {n: 'a' * 64 for n in p.MODULES}}
        files = {**{'source/' + n: v for n, v in self.c['sources'].items()},
            **{'api/modules/' + n: v for n, v in proof['apiModules'].items()}}
        proof['files'] = files
        class Helper:
            @staticmethod
            def file_inventory(_path):
                return {**files, 'admin/html/index.html': 'a' * 64}
        with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_CHANGED'):
            p.verify_proof(proof, proof, self.c, HERE, Helper)

    def test_accepted_or_uncertain_ssm_intent_is_never_repeated(self):
        d = load('bitbrowser-history-dispatch.py')
        parent = ROOT / '.runtime'
        parent.mkdir(exist_ok=True)
        for suffix in ('accepted', 'intent'):
            with tempfile.TemporaryDirectory(dir=parent, prefix='history-controls-') as output:
                path = Path(output)
                (path / ('preflight-' + suffix + '.json')).write_text('{}')
                with patch.object(d, 'OUT', path), patch.object(d.subprocess, 'check_output') as send:
                    with self.assertRaisesRegex(RuntimeError, 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                        d.transport({'commit': 'a' * 40, 'workflowRunId': '12', 'controlSources': {}}, 'preflight')
                    send.assert_not_called()

    def test_readonly_observer_does_not_publish_or_write_business_data(self):
        import inspect
        code = inspect.getsource(p.observe)
        self.assertNotIn('write_text', code)
        self.assertNotIn('write_bytes', code)
        self.assertNotIn('compose(target', code)
        self.assertIn('PREDECESSOR_PROOF', code)
        self.assertIn('h.guards', code)

    def test_switch_retains_fence_backup_and_independent_readback(self):
        import inspect
        text = inspect.getsource(p.release)
        for term in ('fresh_scoped_backup', 'sql_fence_class', 'claim_retired_markers', 'runtimeBaseline',
            'NEEDS_FORWARD_DIAGNOSIS', 'readback', 'SOURCE_INHERITANCE_CHANGED'):
            self.assertIn(term, text)
        self.assertNotIn('migrate deploy', text)
        self.assertNotIn('prune', text)


if __name__ == '__main__':
    unittest.main()
