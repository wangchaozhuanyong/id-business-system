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



class FollowupControls(unittest.TestCase):
    def setUp(self):
        p.select_recipe(p.FOLLOWUP)
        self.c = json.loads((HERE / 'bitbrowser-followup-contract.json').read_bytes())
        if self.c.get('status') != 'FROZEN':
            self.c.update(status='FROZEN', sourceReviewCommit='b' * 40, sourceReviewTree='d' * 40,
                sources={n: 'a' * 64 for n in p.APPLICATION}, apiModules=sorted(p.MODULES),
                updatedServices=list(p.UPDATED), reboundServices=['online-recharge'], preservedServices=list(p.PRESERVED),
                controlPins={n: 'c' * 64 for n in p.CONTROLS}, ciControlPins={n: 'd' * 64 for n in p.CI_CONTROLS},
                mysqlTestSources={n: 'e' * 64 for n in p.MYSQL_FILES}, workflowSha256='f' * 64,
                qualityWorkflowSha256='f' * 64, sqlFenceHelperSha256='c' * 64, engineHealth=p.ENGINE)
            self.c['controlPins']['bitbrowser-recovery-contract.json'] = p.PREDECESSOR_CONTRACT
            self.c['controlPins']['bitbrowser-history-contract.json'] = p.LEGACY_CONTRACT_SHA

    def tearDown(self):
        p.select_recipe('history-20261019')

    def test_followup_recipe_is_exactly_two_api_and_three_admin_modules(self):
        p.validate_contract(self.c)
        self.assertEqual(len(p.API_SOURCES), 2)
        self.assertEqual(len(p.MODULES), 6)
        self.assertEqual(len(p.FOLLOWUP_ADMIN), 3)
        self.assertEqual(len(p.APPLICATION), 9)
        self.assertEqual(p.UPDATED, ('api', 'admin'))
        self.assertEqual(p.CURRENT, p.FOLLOWUP_CURRENT)
        self.assertEqual(p.sha((HERE / 'bitbrowser-history-contract.json').read_bytes()), p.LEGACY_CONTRACT_SHA)
        self.assertEqual(p.sha((HERE / 'bitbrowser-recovery-contract.json').read_bytes()), p.PREDECESSOR_CONTRACT)

    def test_draft_old_recipe_old_proof_old_image_and_repository_edits_are_rejected(self):
        for update in ({'status': 'DRAFT_SOURCE_REVIEW_PENDING'}, {'recipe': 'history-20261019'},
            {'predecessorProofSha256': p.ADMIN_PROOF}, {'expectedCurrent': p.ADMIN_BUILD},
            {'updatedServices': ['api']}, {'adminBuildCommit': p.CURRENT}):
            with self.subTest(update=update), self.assertRaises(RuntimeError):
                p.validate_contract({**self.c, **update})
        for name in ('apps/api/src/id-business-v2/auto-recharge/persistence/recharge.repository.ts',
            'packages/shared/src/index.ts', 'apps/api/prisma-mysql/schema.prisma'):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                p.validate_contract({**self.c, 'sources': {**self.c['sources'], name: 'a' * 64}})
        for role in ('api', 'admin'):
            bad = copy.deepcopy(self.c)
            bad['baseline']['services'][role]['image'] = 'sha256:' + 'a' * 64
            with self.assertRaisesRegex(RuntimeError, 'FOLLOWUP_PROVENANCE'):
                p.validate_contract(bad)

    def test_api_delta_keeps_previously_published_repository_and_all_shared(self):
        before = self.c['publishedApiModules']
        shared = self.c['publishedSharedFiles']
        after = {**before, next(n for n in p.MODULES if n.endswith('.js')): 'f' * 64}
        b.verify_delta(before, after, shared, shared, self.c, p)
        repository = 'id-business-v2/auto-recharge/persistence/recharge.repository.js'
        with self.assertRaisesRegex(RuntimeError, 'UNSELECTED_API_OUTPUT'):
            b.verify_delta(before, {**after, repository: 'f' * 64}, shared, shared, self.c, p)
        with self.assertRaisesRegex(RuntimeError, 'SHARED_OUTPUT'):
            b.verify_delta(before, after, shared, {}, self.c, p)

    def test_admin_input_must_reproduce_published_fe_not_current_main(self):
        expected = self.c['publishedAdminFiles']
        b.verify_followup_admin(expected, {'x': 'a'}, {'x': 'a'}, self.c, p)
        with self.assertRaisesRegex(RuntimeError, 'BASE_ADMIN_NOT_REPRODUCED'):
            b.verify_followup_admin({**expected, 'unrelated.js': 'f' * 64}, {}, {}, self.c, p)
        with self.assertRaisesRegex(RuntimeError, 'SHARED_OUTPUT'):
            b.verify_followup_admin(expected, {'x': 'a'}, {'x': 'b'}, self.c, p)

    def test_admin_overlay_retains_all_historical_files_and_rejects_extras(self):
        before = {'index.html': 'a' * 64, 'assets/old.js': 'b' * 64}
        candidate = {'index.html': 'c' * 64, 'assets/new.js': 'd' * 64}
        baseline = {'count': len(before), 'sha256': p.sha(p.canonical(before))}
        union = {**before, **candidate}
        self.assertEqual(p.verify_admin_merge(before, candidate, union, baseline)['count'], 3)
        for bad in (candidate, {**union, 'unreviewed.js': 'a' * 64}, {**union, 'assets/old.js': 'a' * 64}):
            with self.assertRaisesRegex(RuntimeError, 'ADMIN_HISTORY_CHANGED'):
                p.verify_admin_merge(before, candidate, bad, baseline)

    def test_source_quality_requires_guards_api_admin_or_full_success(self):
        rows = [{'name': 'recharge (' + n + ')', 'conclusion': 'success'} for n in ('guards', 'api', 'admin')]
        b.require_quality_jobs(rows, p)
        for bad in (rows[:2], [*rows[:2], {'name': 'recharge (admin)', 'conclusion': 'skipped'}]):
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_API_QUALITY'):
                b.require_quality_jobs(bad, p)

    def test_followup_proof_rejects_missing_admin_baseline_extra_source_and_foreign_payload(self):
        identity = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '12', 'workflowRunAttempt': '1', 'contractSha256': 'e' * 64}
        mysql = {**identity, 'scope': 'OWNED_EMPTY_DATABASE', 'runtime': 'github-actions-mysql-service',
            'testFiles': self.c['mysqlTestSources'], 'testsTotal': 18, 'testsPassed': 18, 'testsSkipped': 0,
            'testsTodo': 0, 'productionActions': 0, 'reportSha256': 'd' * 64}
        proof = {**identity, 'version': 1, 'recipe': p.FOLLOWUP, 'scope': p.SCOPE,
            'sources': self.c['sources'], 'controlSources': self.c['controlPins'],
            'baselineModulesReproduced': self.c['baseline']['apiModules'], 'predecessorProofSha256': p.FOLLOWUP_PROOF,
            'baselineSharedUnchanged': True, 'baselineAdminReproduced': True,
            'baselineAdminFiles': self.c['publishedAdminFiles'], 'adminFiles': self.c['publishedAdminFiles'],
            'migrationPerformed': False, 'businessActions': 0, 'updatedServices': list(p.UPDATED),
            'qualityVerification': {}, 'isolatedMysqlVerification': mysql,
            'apiModules': {n: 'a' * 64 for n in p.MODULES}}
        files = {**{'source/' + n: v for n, v in self.c['sources'].items()},
            **{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
            **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()}}
        proof['files'] = files
        class Helper:
            @staticmethod
            def file_inventory(_path):
                return files.copy()
        p.verify_proof(proof, proof, self.c, HERE, Helper)
        for key, value in (('baselineAdminReproduced', False), ('baselineAdminFiles', {}),
            ('adminFiles', {'index.html': 'a' * 64}), ('recipe', 'history-20261019')):
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'ADMIN_BUILD_PROOF'):
                p.verify_proof({**proof, key: value}, proof, self.c, HERE, Helper)
        for name in ('shared/other.js', 'api/modules/id-business-v2/auto-recharge/persistence/recharge.repository.js',
            'source/apps/api/src/id-business-v2/online-recharge/other.ts'):
            files[name] = 'f' * 64
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'PAYLOAD_CHANGED'):
                p.verify_proof(proof, proof, self.c, HERE, Helper)
            files.pop(name)

    def test_recipe_selector_is_closed_and_restores_legacy_identity(self):
        for name in ('followup', '../bitbrowser-followup-contract.json', 'other', ''):
            with self.assertRaisesRegex(RuntimeError, 'RECIPE_INVALID'):
                p.select_recipe(name)
        p.select_recipe('history-20261019')
        self.assertEqual(p.CURRENT, p.ADMIN_BUILD)
        self.assertEqual(len(p.MODULES), 9)
        self.assertEqual(p.UPDATED, ('api',))



class EntryStartControls(unittest.TestCase):
    def setUp(self):
        p.select_recipe(p.ENTRY)
        self.c = json.loads((HERE / 'bitbrowser-entry-start-contract.json').read_bytes())
        if self.c.get('status') != 'FROZEN':
            self.c.update(status='FROZEN', sourceReviewCommit='b' * 40, sourceReviewTree='d' * 40,
                sources={n: 'a' * 64 for n in p.APPLICATION}, apiModules=sorted(p.MODULES),
                updatedServices=['api'], reboundServices=['online-recharge'], preservedServices=list(p.PRESERVED),
                controlPins={n: 'c' * 64 for n in p.CONTROLS}, ciControlPins={n: 'd' * 64 for n in p.CI_CONTROLS},
                mysqlTestSources={n: 'e' * 64 for n in p.MYSQL_FILES}, workflowSha256='f' * 64,
                qualityWorkflowSha256='f' * 64, sqlFenceHelperSha256='c' * 64, engineHealth=p.ENGINE)
            for name, value in (('bitbrowser-recovery-contract.json', p.PREDECESSOR_CONTRACT),
                ('bitbrowser-history-contract.json', p.LEGACY_CONTRACT_SHA), ('bitbrowser-followup-contract.json', p.FOLLOWUP_CONTRACT_SHA)):
                self.c['controlPins'][name] = value

    def tearDown(self):
        p.select_recipe('history-20261019')

    def parent(self):
        old = json.loads((HERE / 'bitbrowser-followup-contract.json').read_bytes())
        parent_modules = {n: v for n, v in self.c['publishedApiModules'].items()
            if any('/' + module + '.' in n for module in ('recharge-account-restore', 'recharge-unidentified-checkout'))}
        proof = {'commit': p.ENTRY_CURRENT, 'tree': p.ENTRY_TREE, 'scope': 'BITBROWSER_FOLLOWUP_ACCEPTANCE_20261019',
            'recipe': p.FOLLOWUP, 'contractSha256': p.FOLLOWUP_CONTRACT_SHA, 'workflowRunId': '39199575083',
            'sources': old['sources'], 'controlSources': old['controlPins'], 'updatedServices': ['api', 'admin'],
            'migrationPerformed': False, 'businessActions': 0, 'baselineAdminReproduced': True,
            'apiModules': parent_modules, 'adminFiles': {'index.html': 'a' * 64,
                **{'assets/fixture-' + str(n) + '.js': 'b' * 64 for n in range(260)}}}
        # Fixture-only parent metadata: the real controller first checks both immutable file digests.
        admin_before = {'index.html': 'a' * 64, 'assets/old.js': 'b' * 64}
        old['baseline']['adminInventory'] = {'count': 2, 'sha256': p.sha(p.canonical(admin_before))}
        before = copy.deepcopy(old['baseline']['services'])
        after = copy.deepcopy(before)
        images = {}
        for role in ('api', 'admin'):
            image = p.ENTRY_API_IMAGE if role == 'api' else 'sha256:' + 'a' * 64
            reference = 'id-business-v2-history:' + p.ENTRY_CURRENT + '-39199575083-' + role
            after[role].update(image=image, containerId=role + '-new', reference=reference)
            images[role] = {'imageId': image, 'reference': reference}
        after['online-recharge']['containerId'] = 'sidecar-new'
        preservation = {'status': 'BITBROWSER_HISTORY_DEPLOYED', 'commit': p.ENTRY_CURRENT, 'tree': p.ENTRY_TREE,
            'workflowRunId': '39199575083', 'businessActions': 0, 'migrationPerformed': False,
            'before': before, 'after': after, 'images': images, 'image': images['api'], 'beforeAdminFiles': admin_before}
        old_manifest = {'roleSourceProjections': {'api': {'parent': 'api'}, 'admin': {'parent': 'admin'}}}
        projections = {role: {'commit': p.ENTRY_CURRENT, 'kind': 'BITBROWSER_FOLLOWUP_ACCEPTANCE_20261019',
            'buildProofSha256': p.ENTRY_PROOF, 'sources': {n: v for n, v in old['sources'].items() if n.startswith('apps/' + role + '/')},
            'parentProjection': old_manifest['roleSourceProjections'][role]} for role in ('api', 'admin')}
        manifest = {'commit': p.ENTRY_CURRENT, 'sourceTree': p.ENTRY_TREE, 'status': 'DEPLOYED',
            'scope': 'BITBROWSER_FOLLOWUP_ACCEPTANCE_20261019', 'bitbrowserHistoryPublication': preservation,
            'previousCommit': old['expectedCurrent'], 'previousRelease': old['baseline']['current'],
            'previousManifestSha256': old['baseline']['manifestSha256'], 'roleSourceProjections': projections,
            'adminSourceProjection': projections['admin'], 'images': {role: {'digest': image['imageId'], 'reference': image['reference'],
                'sourceCommit': p.ENTRY_CURRENT} for role, image in images.items()}}
        return old, manifest, proof, preservation, old_manifest

    def test_entry_start_is_one_api_module_and_never_an_admin_recipe(self):
        p.validate_contract(self.c)
        self.assertEqual(len(p.APPLICATION), 2)
        self.assertEqual(len(p.MODULES), 3)
        self.assertEqual(p.UPDATED, ('api',))
        self.assertIn('admin', p.PRESERVED)
        self.assertEqual(p.CURRENT, p.ENTRY_CURRENT)
        self.assertEqual(p.sha((HERE / 'bitbrowser-followup-contract.json').read_bytes()), p.FOLLOWUP_CONTRACT_SHA)
        for changes in ({'updatedServices': ['api', 'admin']}, {'status': 'DRAFT_SOURCE_REVIEW_PENDING'},
            {'expectedCurrent': p.FOLLOWUP_CURRENT}, {'recipe': p.FOLLOWUP}):
            with self.assertRaises(RuntimeError):
                p.validate_contract({**self.c, **changes})
        for name in ('apps/api/src/id-business-v2/auto-recharge/recharge-account-restore.ts',
            'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-payment.ts'):
            with self.assertRaises(RuntimeError):
                p.validate_contract({**self.c, 'sources': {**self.c['sources'], name: 'a' * 64}})

    def test_parent_native_identity_services_projections_and_admin_history_are_authenticated(self):
        old, manifest, proof, preservation, previous = self.parent()
        merged = p.verify_entry_parent(self.c, manifest, proof, preservation, old, previous)
        self.assertEqual(merged, {**preservation['beforeAdminFiles'], **proof['adminFiles']})
        mutations = [lambda m, pr, ps: m.update(commit=p.FOLLOWUP_CURRENT),
            lambda m, pr, ps: pr.update(contractSha256='0' * 64),
            lambda m, pr, ps: ps['after']['api'].update(image='sha256:' + 'b' * 64),
            lambda m, pr, ps: ps['after']['mysql'].update(containerId='changed'),
            lambda m, pr, ps: ps['after']['admin'].update(image=ps['before']['admin']['image']),
            lambda m, pr, ps: ps['beforeAdminFiles'].update(extra='f' * 64),
            lambda m, pr, ps: m['roleSourceProjections']['admin'].update(buildProofSha256='f' * 64),
            lambda m, pr, ps: m['roleSourceProjections']['api'].update(parentProjection={})]
        for mutate in mutations:
            o, m, pr, ps, prev = self.parent()
            mutate(m, pr, ps)
            with self.assertRaises(RuntimeError):
                p.verify_entry_parent(self.c, m, pr, ps, o, prev)

    def test_parent_api_uses_old_six_module_partition_before_capturing_new_three(self):
        old, manifest, proof, preservation, previous = self.parent()
        admin = p.verify_entry_parent(self.c, manifest, proof, preservation, old, previous)
        actual = {**{n: old['baseline'][n] for n in ('apiPreservedInventory', 'sharedInventory', 'clientInventory', 'nginxSha256')},
            'apiModules': proof['apiModules'], 'adminInventory': {'count': len(admin), 'sha256': p.sha(p.canonical(admin))}}
        p.verify_entry_inventory(old, proof, admin, actual)
        for key in ('apiPreservedInventory', 'sharedInventory', 'clientInventory', 'adminInventory', 'apiModules'):
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'ENTRY_PARENT_CONTENT'):
                p.verify_entry_inventory(old, proof, admin, {**actual, key: {}})

    def test_seal_binds_all_runtime_inventory_and_one_native_attempt(self):
        plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '12', 'workflowRunAttempt': '1'}
        baseline = {'current': '/opt/id-business-v2/releases/parent', 'apiPreservedInventory': {'count': 10, 'sha256': 'c' * 64}}
        raw = p.canonical(p.entry_seal_record(plan, baseline))
        p.verify_entry_seal(plan, baseline, raw)
        for changed in ({**plan, 'workflowRunId': '13'}, {**plan, 'workflowRunAttempt': '2'}):
            with self.assertRaisesRegex(RuntimeError, 'ENTRY_PARENT_SEAL'):
                p.verify_entry_seal(changed, baseline, raw)
        with self.assertRaisesRegex(RuntimeError, 'ENTRY_PARENT_SEAL'):
            p.verify_entry_seal(plan, {**baseline, 'apiPreservedInventory': {}}, raw)

    def test_api_delta_rejects_every_parent_module_and_all_shared(self):
        before, shared = self.c['publishedApiModules'], self.c['publishedSharedFiles']
        after = {**before, next(n for n in p.MODULES if n.endswith('.js')): 'f' * 64}
        b.verify_delta(before, after, shared, shared, self.c, p)
        for name in ('id-business-v2/auto-recharge/recharge-account-restore.js',
            'id-business-v2/auto-recharge/recharge-unidentified-checkout.js',
            'id-business-v2/auto-recharge/persistence/recharge.repository.js'):
            with self.assertRaisesRegex(RuntimeError, 'UNSELECTED_API_OUTPUT'):
                b.verify_delta(before, {**after, name: 'f' * 64}, shared, shared, self.c, p)
        with self.assertRaisesRegex(RuntimeError, 'SHARED_OUTPUT'):
            b.verify_delta(before, after, shared, {}, self.c, p)

    def test_source_quality_and_entry_build_do_not_require_or_build_admin(self):
        b.require_quality_jobs([{'name': 'recharge (guards)', 'conclusion': 'success'},
            {'name': 'recharge (api)', 'conclusion': 'success'}], p)
        import inspect
        code = inspect.getsource(b.entry_main)
        self.assertNotIn('@apple-business/admin', code)
        self.assertNotIn('admin/html', code)
        self.assertIn('reconstruct_entry', code)
        self.assertIn('verify_delta', code)
        restore = inspect.getsource(b.reconstruct_entry)
        self.assertIn("old['sourceReviewCommit']", restore)
        self.assertNotIn("git('archive'", restore)



class ExistingAddressControls(unittest.TestCase):
    def setUp(self):
        p.select_recipe(p.ADDRESS)
        self.c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())

    def tearDown(self):
        p.select_recipe('history-20261019')

    def parent(self):
        old_entry = json.loads((HERE / 'bitbrowser-entry-start-contract.json').read_bytes())
        before = self.c['parentVerifiedBaseline']
        old_manifest = {'roleSourceProjections': {'api': {'old': 'api'}, 'admin': {'old': 'admin'}},
            'adminSourceProjection': {'old': 'admin'}, 'images': {n: {'digest': v['image']} for n, v in before['services'].items()}}
        after = copy.deepcopy(before['services'])
        after['api'].update(image=p.ADDRESS_API_IMAGE, containerId='api-new')
        after['online-recharge']['containerId'] = 'sidecar-new'
        image = {'imageId': p.ADDRESS_API_IMAGE, 'reference': 'new-api'}
        preservation = {'commit': p.ADDRESS_CURRENT, 'tree': p.ADDRESS_TREE, 'workflowRunId': '39202298576',
            'businessActions': 0, 'migrationPerformed': False, 'verifiedParentBaseline': copy.deepcopy(before),
            'entryParentSealSha256': self.c['parentVerifiedSealSha256'], 'before': copy.deepcopy(before['services']),
            'after': after, 'images': {'api': image}, 'image': image}
        proof = {'commit': p.ADDRESS_CURRENT, 'tree': p.ADDRESS_TREE, 'scope': 'BITBROWSER_ENTRY_START_20261019',
            'recipe': p.ENTRY, 'contractSha256': p.ENTRY_CONTRACT_SHA, 'workflowRunId': '39202298576',
            'isolatedMysqlVerification': self.c['mysqlInheritance']['evidence'], 'sources': old_entry['sources'], 'controlSources': old_entry['controlPins'], 'updatedServices': ['api'],
            'migrationPerformed': False, 'businessActions': 0}
        manifest = {'commit': p.ADDRESS_CURRENT, 'sourceTree': p.ADDRESS_TREE, 'status': 'DEPLOYED',
            'scope': proof['scope'], 'bitbrowserHistoryPublication': preservation, 'previousCommit': p.ENTRY_CURRENT,
            'previousRelease': before['current'], 'previousManifestSha256': before['manifestSha256'],
            'roleSourceProjections': {'api': {'commit': p.ADDRESS_CURRENT, 'kind': proof['scope'],
                'buildProofSha256': p.ADDRESS_PROOF, 'sources': old_entry['sources'],
                'parentProjection': old_manifest['roleSourceProjections']['api']},
                'admin': copy.deepcopy(old_manifest['roleSourceProjections']['admin'])},
            'adminSourceProjection': copy.deepcopy(old_manifest['adminSourceProjection']),
            'images': {**old_manifest['images'], 'api': {'digest': p.ADDRESS_API_IMAGE, 'reference': 'new-api', 'sourceCommit': p.ADDRESS_CURRENT}}}
        return manifest, proof, preservation, old_entry, old_manifest

    def test_admin_only_scope_has_no_api_modules_and_preserves_all_other_services(self):
        p.validate_contract(self.c)
        self.assertEqual(p.UPDATED, ('admin',))
        self.assertEqual(p.REBOUND, ())
        self.assertEqual(p.MODULES, frozenset())
        self.assertEqual(len(p.APPLICATION), 2)
        self.assertEqual(set(p.PRESERVED), set(p.SERVICES) - {'admin'})
        for value in ({'updatedServices': ['api', 'admin']}, {'apiModules': ['unowned.js']},
            {'reboundServices': ['online-recharge']}, {'expectedCurrent': p.ENTRY_CURRENT},
            {'adminNativeProofSha256': p.ADMIN_PROOF}):
            with self.assertRaises(RuntimeError):
                p.validate_contract({**self.c, **value})

    def test_parent_entry_identity_api_projection_and_actual_admin_image_are_bound(self):
        p.verify_address_parent(self.c, *self.parent())
        mutations = [lambda m, pr, ps: m.update(commit=p.ENTRY_CURRENT),
            lambda m, pr, ps: pr.update(contractSha256='0' * 64),
            lambda m, pr, ps: ps['after']['api'].update(image=p.ENTRY_API_IMAGE),
            lambda m, pr, ps: ps['after']['admin'].update(image='sha256:' + '0' * 64),
            lambda m, pr, ps: ps['after']['mysql'].update(containerId='changed'),
            lambda m, pr, ps: ps['after']['online-recharge'].update(environmentSha256='0' * 64),
            lambda m, pr, ps: ps['verifiedParentBaseline'].update(apiPreservedInventory={}),
            lambda m, pr, ps: m['roleSourceProjections']['api'].update(parentProjection={}),
            lambda m, pr, ps: m['roleSourceProjections']['admin'].update(old='changed')]
        for mutate in mutations:
            m, pr, ps, entry, old = copy.deepcopy(self.parent())
            mutate(m, pr, ps)
            with self.assertRaises(RuntimeError):
                p.verify_address_parent(self.c, m, pr, ps, entry, old)

    def test_activation_only_replaces_admin_without_api_stop_or_sidecar_rebind(self):
        calls = []
        class Driver:
            def compose(self, *args, **kwargs): calls.append(('compose', args, kwargs))
            def wait_healthy(self, *args): calls.append(('healthy', args))
        class Fence:
            def stop(self, *args, **kwargs): raise AssertionError('must preserve API and sidecar')
            def close(self): calls.append(('fence-close',))
        p.activate_services(Driver(), HERE, {}, Fence())
        self.assertEqual(calls, [('compose', (HERE, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'admin'), {'timeout': 180}),
            ('healthy', (HERE, 'admin')), ('fence-close',)])

    def test_mysql_evidence_is_exact_parent_native_evidence_never_a_new_test_claim(self):
        value = self.c['mysqlInheritance']['evidence']
        p.verify_mysql(value, {'commit': 'a' * 40}, self.c)
        self.assertEqual(value['workflowRunId'], '39202298576')
        self.assertEqual(value['testsPassed'], 18)
        for changed in ({**value, 'workflowRunId': '12'}, {**value, 'testsPassed': 17}, {**value, 'reportSha256': '0' * 64}):
            with self.assertRaisesRegex(RuntimeError, 'MYSQL_INHERITANCE'):
                p.verify_mysql(changed, {}, self.c)
        self.assertEqual(set(self.c['mysqlInheritance']['inputs']) & p.MYSQL_FILES, p.MYSQL_FILES)
        self.assertTrue(any(n.startswith('apps/api/prisma-mysql/migrations/') for n in self.c['mysqlInheritance']['inputs']))
        self.assertIn('apps/api/src/id-business-v2/auto-recharge/recharge-direct-payment.ts', self.c['mysqlInheritance']['inputs'])

    def test_source_quality_requires_only_guards_and_admin_and_build_omits_api_database(self):
        b.require_quality_jobs([{'name': 'recharge (guards)', 'conclusion': 'success'},
            {'name': 'recharge (admin)', 'conclusion': 'success'}], p)
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_API_QUALITY'):
            b.require_quality_jobs([{'name': 'recharge (guards)', 'conclusion': 'success'},
                {'name': 'recharge (api)', 'conclusion': 'success'}], p)
        import inspect
        code = inspect.getsource(b.address_main)
        self.assertNotIn('@apple-business/api', code)
        self.assertNotIn('prisma:mysql', code)
        self.assertNotIn('api/modules', code)
        self.assertIn('inherited_mysql', code)
        self.assertIn('p.ENTRY_CURRENT', code)
        reconstruction = inspect.getsource(b.reconstruct_address)
        self.assertIn('reconstruct_followup', reconstruction)
        self.assertIn("old['sourceReviewCommit']", reconstruction)
        self.assertNotIn("git('archive'", reconstruction)

    def test_admin_proof_and_payload_reject_any_api_or_shared_output(self):
        identity = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '12', 'workflowRunAttempt': '1', 'contractSha256': 'e' * 64}
        proof = {**identity, 'version': 1, 'recipe': p.ADDRESS, 'scope': p.SCOPE,
            'sources': self.c['sources'], 'controlSources': self.c['controlPins'],
            'baselineModulesReproduced': {}, 'predecessorProofSha256': p.ADDRESS_PROOF,
            'baselineSharedUnchanged': True, 'baselineAdminReproduced': True,
            'baselineAdminFiles': self.c['publishedAdminFiles'], 'adminFiles': self.c['publishedAdminFiles'],
            'migrationPerformed': False, 'businessActions': 0, 'updatedServices': ['admin'],
            'qualityVerification': {}, 'isolatedMysqlVerification': self.c['mysqlInheritance']['evidence'], 'apiModules': {}}
        files = {**{'source/' + n: v for n, v in self.c['sources'].items()}, **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()}}
        proof['files'] = files
        class Helper:
            @staticmethod
            def file_inventory(_path): return files.copy()
        p.verify_proof(proof, proof, self.c, HERE, Helper)
        for name in ('api/modules/id-business-v2/auto-recharge/recharge-local.service.js', 'shared/index.js'):
            files[name] = 'a' * 64
            with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_CHANGED'):
                p.verify_proof(proof, proof, self.c, HERE, Helper)
            files.pop(name)
        with self.assertRaisesRegex(RuntimeError, 'ADMIN_BUILD_PROOF'):
            p.verify_proof({**proof, 'baselineAdminFiles': {}}, proof, self.c, HERE, Helper)

    def test_no_database_workflow_branch_and_publication_job_are_recipe_specific(self):
        workflow = (ROOT / p.WORKFLOW).read_text()
        admin = workflow.split('  validate-admin:', 1)[1].split('  publish:', 1)[0]
        self.assertNotIn('services:', admin)
        self.assertNotIn('migrate', admin)
        self.assertNotIn('MYSQL_ROOT_PASSWORD', admin)
        self.assertIn('inherit exact parent MySQL evidence', admin)
        self.assertIn('needs: [validate, validate-admin]', workflow)
        self.assertIn("needs.validate-admin.result == 'success'", workflow)



class BoundedBuildControls(unittest.TestCase):
    def test_full_parent_inventory_is_authenticated_before_selecting_known_and_absent_outputs(self):
        files = {'old.js': 'a' * 64, 'old.d.ts': 'b' * 64, 'preserved.js': 'c' * 64}
        expected = {'count': len(files), 'sha256': p.sha(p.canonical(files))}
        value = p.bounded_api_selection(files, ['old.js', 'old.d.ts', 'new.js'], ['new.js'], expected)
        self.assertEqual(value['apiModules'], {n: files[n] for n in ('old.js', 'old.d.ts')})
        self.assertEqual(value['absentApiModules'], ['new.js'])
        with self.assertRaisesRegex(RuntimeError, 'FULL_INVENTORY_CHANGED'):
            p.bounded_api_selection({**files, 'preserved.js': 'd' * 64}, ['old.js'], [], expected)
        for selected, absent in ((['missing.js'], []), (['old.js'], ['old.js']), (['old.js'], ['new.js']), ([], [])):
            with self.assertRaisesRegex(RuntimeError, 'SELECTED_OUTPUT_CHANGED'):
                p.bounded_api_selection(files, selected, absent, expected)

    def test_existing_and_explicitly_absent_api_outputs_stay_closed(self):
        before = {'old.js': 'a' * 64, 'old.d.ts': 'b' * 64, 'preserved.js': 'c' * 64}
        after = {**before, 'old.js': 'd' * 64, 'new.js': 'e' * 64, 'new.d.ts': 'f' * 64}
        shared = {'index.js': 'a' * 64}
        c = {'apiModules': ['old.js', 'new.js', 'new.d.ts'],
            'absentApiModules': ['new.js', 'new.d.ts'], 'baseline': {'apiModules': {'old.js': before['old.js']}},
            'publishedApiModules': before, 'publishedSharedFiles': shared}
        self.assertEqual(b.verify_bounded_delta(before, after, shared, shared, c, p),
            {n: after[n] for n in c['apiModules']})
        unchanged_declaration = copy.deepcopy(c)
        unchanged_declaration['apiModules'].append('old.d.ts')
        unchanged_declaration['baseline']['apiModules']['old.d.ts'] = before['old.d.ts']
        with self.assertRaisesRegex(RuntimeError, 'COMPILED_SELECTION_CHANGED'):
            b.verify_bounded_delta(before, after, shared, shared, unchanged_declaration, p)
        for changed_before, changed_after, changed_shared in (
            ({**before, 'new.js': 'e' * 64}, after, shared),
            ({**before, 'old.js': 'f' * 64}, after, shared),
            (before, {**after, 'preserved.js': 'f' * 64}, shared),
            (before, {**after, 'other.d.ts': 'f' * 64}, shared),
            (before, after, {})):
            with self.assertRaises(RuntimeError):
                b.verify_bounded_delta(changed_before, changed_after, shared, changed_shared, c, p)

    def test_root_before_source_drift_cannot_enter_a_finite_overlay(self):
        name = 'apps/api/src/id-business-v2/bank-card-pool/persistence/shared-bank-card.repository.ts'
        with tempfile.TemporaryDirectory() as directory:
            context = Path(directory)
            target = context / name
            target.parent.mkdir(parents=True)
            target.write_bytes(b'projected-native-source')
            def fake_git(*args):
                if args[0] == 'ls-tree': return (name + '\n').encode()
                if args[0] == 'show': return b'projected-native-source'
                raise AssertionError(args)
            with patch.object(b, 'git', side_effect=fake_git), patch.object(b, 'overlay') as apply:
                b.bounded_overlay(context, {name: 'a' * 64}, 'b' * 40, p)
                apply.assert_called_once()
                target.write_bytes(b'unpublished-root-drift')
                with self.assertRaisesRegex(RuntimeError, 'SOURCE_PREDECESSOR_CHANGED'):
                    b.bounded_overlay(context, {name: 'a' * 64}, 'b' * 40, p)
                self.assertEqual(apply.call_count, 1)

    def test_new_helpers_must_be_absent_and_closed_recipe_is_frozen(self):
        name = 'apps/api/src/id-business-v2/auto-recharge/recharge-payment-hold.ts'
        with tempfile.TemporaryDirectory() as directory:
            context = Path(directory)
            with patch.object(b, 'git', return_value=b''), patch.object(b, 'overlay') as apply:
                b.bounded_overlay(context, {name: 'a' * 64}, 'b' * 40, p)
                target = context / name
                target.parent.mkdir(parents=True)
                target.write_bytes(b'preexisting')
                with self.assertRaisesRegex(RuntimeError, 'NEW_SOURCE_ALREADY_PRESENT'):
                    b.bounded_overlay(context, {name: 'a' * 64}, 'b' * 40, p)
                self.assertEqual(apply.call_count, 1)
        p.select_recipe(p.BOUNDED)
        c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())
        p.validate_contract(c)
        self.assertEqual(len(p.API_SOURCES), 20)
        self.assertEqual(len(p.BOUNDED_PRODUCTION), 25)
        self.assertEqual(len(p.TEST_SOURCES), 14)
        p.select_recipe('history-20261019')


class BoundedFrozenControls(unittest.TestCase):
    def setUp(self):
        p.select_recipe(p.BOUNDED)
        b.RECIPE = p.BOUNDED
        self.c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())

    def tearDown(self):
        p.select_recipe('history-20261019')
        b.RECIPE = 'history-20261019'

    def native_fixture(self, mismatch=False):
        c=copy.deepcopy(self.c)
        files={**c['baseline']['apiModules'],**{n:p.sha(('native:'+n).encode()) for n in p.BOUNDED_ORDER_ONLY}}
        for i in range(1761-len(files)):files[f'preserved/native-{i}.js']=p.sha(str(i).encode())
        if mismatch:
            for name,digest in c['baseline']['apiModules'].items():files[name]=p.sha(('actual:'+digest).encode())
        authenticated={'count':len(files),'sha256':p.sha(p.canonical(files))}
        c['parentApiInventory']=authenticated
        return c,files,authenticated

    def test_frozen_scope_separates_source_review_production_and_compiled_output(self):
        p.validate_contract(self.c)
        self.assertEqual(set(self.c['sourceReviewControls']), p.CI_CONTROLS)
        self.assertEqual(len(self.c['sources']), 39)
        self.assertEqual(len(p.production_sources(self.c)), 25)
        self.assertFalse(any(n.endswith('.spec.ts') for n in p.production_sources(self.c)))
        self.assertEqual(len(p.MODULES), 57)
        self.assertEqual(set(self.c['absentApiModules']), p.MODULES - set(self.c['baseline']['apiModules']))
        self.assertFalse(p.MODULES & p.BOUNDED_ORDER_ONLY)
        self.assertFalse(any(n.endswith('worker.repository.d.ts') for n in p.MODULES))
        self.assertEqual(p.BOUNDED_PROPAGATED, {n for n in p.MODULES if n.endswith(('recharge-name.service.d.ts','shared-bank-card.controller.d.ts'))})
        for key, value in (('status','DRAFT'), ('sourceReviewCommit','a'*40), ('sourceReviewTree','b'*40),
            ('productionSources',self.c['sources']), ('absentApiModules',[]), ('mysqlExpectedCounts',[10,8]),
            ('parentApiInventory',{'count':1765,'sha256':'a'*64})):
            changed = copy.deepcopy(self.c); changed[key] = value
            with self.assertRaises(RuntimeError): p.validate_contract(changed)

    def test_mysql_test_repair_preserves_original_review_and_all_production_inputs(self):
        self.assertEqual(self.c['mysqlTestInputRepair'],p.mysql_test_input_repair())
        self.assertEqual(p.sha(b.git('show',p.MYSQL_REPAIR_BASE+':'+p.MYSQL_REPAIR_PATH)),p.MYSQL_REPAIR_BASE_SHA)
        self.assertEqual(p.sha(b.git('show',self.c['sourceReviewCommit']+':'+p.MYSQL_REPAIR_PATH)),p.MYSQL_REPAIR_OLD_SHA)
        self.assertEqual(p.sha((ROOT/p.MYSQL_REPAIR_PATH).read_bytes()),p.MYSQL_REPAIR_NEW_SHA)
        self.assertNotEqual(p.MYSQL_REPAIR_OLD_SHA,p.MYSQL_REPAIR_BASE_SHA)
        self.assertEqual(self.c['sources'][p.MYSQL_REPAIR_PATH],p.MYSQL_REPAIR_OLD_SHA)
        self.assertEqual(self.c['mysqlTestSources'][p.MYSQL_REPAIR_PATH],p.MYSQL_REPAIR_NEW_SHA)
        self.assertEqual(p.reviewed_current_digest(self.c,p.MYSQL_REPAIR_PATH,p.MYSQL_REPAIR_OLD_SHA),p.MYSQL_REPAIR_NEW_SHA)
        for name,digest in self.c['sources'].items():
            if name != p.MYSQL_REPAIR_PATH:self.assertEqual(p.reviewed_current_digest(self.c,name,digest),digest)
        original=json.loads(b.git('show',p.MYSQL_REPAIR_BASE+':scripts/production-release/bitbrowser-bounded-hold-contract.json'))
        for key in ('sources','productionSources','apiModules','baseline','absentApiModules','sourceReviewCommit','sourceReviewTree'):
            self.assertEqual(self.c[key],original[key])
        for key,val in (('path','apps/api/src/id-business-v2/auto-recharge/recharge-availability.mysql.integration.spec.ts'),
            ('oldSha256','a'*64),('reviewBaseSha256','b'*64),('newSha256','b'*64),('reviewBase','c'*40),('reviewBaseTree','d'*40)):
            changed=copy.deepcopy(self.c);changed['mysqlTestInputRepair'][key]=val
            with self.assertRaisesRegex(RuntimeError,'MYSQL_TEST_INPUT_REPAIR_INVALID'):p.validate_contract(changed)
        for key,val in (('sources',{**self.c['sources'],p.MYSQL_REPAIR_PATH:p.MYSQL_REPAIR_NEW_SHA}),
            ('mysqlTestSources',{**self.c['mysqlTestSources'],p.MYSQL_REPAIR_PATH:p.MYSQL_REPAIR_OLD_SHA}),
            ('mysqlTestInputRepair',None)):
            changed=copy.deepcopy(self.c);changed[key]=val
            with self.assertRaisesRegex(RuntimeError,'MYSQL_TEST_INPUT_REPAIR_INVALID'):p.validate_contract(changed)
        with self.assertRaisesRegex(RuntimeError,'MYSQL_TEST_INPUT_REPAIR_INVALID'):
            p.reviewed_current_digest(self.c,p.MYSQL_REPAIR_PATH,'e'*64)

    def test_source_quality_exempts_only_exact_old_to_new_mysql_fixture_hashes(self):
        commit=self.c['sourceReviewCommit'];tree=self.c['sourceReviewTree']
        old={name:b.git('show',commit+':'+name)for name in self.c['sources']}
        current={**old,p.MYSQL_REPAIR_PATH:(ROOT/p.MYSQL_REPAIR_PATH).read_bytes()}
        rows={'workflow_runs':[{'head_sha':commit,'event':'pull_request','path':'.github/workflows/quality.yml',
            'conclusion':'success','id':39211892224,'run_attempt':1}]}
        jobs={'jobs':[{'name':'recharge ('+part+')','conclusion':'success'}for part in ('guards','api','admin')]}
        def github(args,**kwargs):return json.dumps(jobs if '/attempts/'in args[-1]else rows).encode()
        def git(*args):
            if args==('rev-parse',commit+'^{tree}'):return(tree+'\n').encode()
            if args[0]=='show':
                selected,name=args[1].split(':',1)
                return(current if selected=='HEAD'else old)[name]
            raise AssertionError(args)
        with patch.object(b,'git',side_effect=git),patch.object(b.subprocess,'check_output',side_effect=github):
            evidence=b.quality(commit,self.c,source=True)
            self.assertEqual(evidence['commit'],commit)
            current[p.MYSQL_REPAIR_PATH]=b'unapproved fixture bytes'
            with self.assertRaisesRegex(RuntimeError,'SOURCE_PROJECTION_CHANGED'):b.quality(commit,self.c,source=True)
            current[p.MYSQL_REPAIR_PATH]=(ROOT/p.MYSQL_REPAIR_PATH).read_bytes()
            other=next(n for n in old if n!=p.MYSQL_REPAIR_PATH);current[other]=b'unreviewed source bytes'
            with self.assertRaisesRegex(RuntimeError,'SOURCE_PROJECTION_CHANGED'):b.quality(commit,self.c,source=True)
            current[other]=old[other];old[p.MYSQL_REPAIR_PATH]=b'unreviewed original fixture bytes'
            with self.assertRaisesRegex(RuntimeError,'SOURCE_PROJECTION_CHANGED'):b.quality(commit,self.c,source=True)

    def test_mysql_requires_31_real_tests_and_all_three_exact_specs_in_same_run(self):
        identity = {'commit':'a'*40,'tree':'b'*40,'workflowRunId':'123','workflowRunAttempt':'1'}
        value = {**identity,'scope':'OWNED_EMPTY_DATABASE','runtime':'github-actions-mysql-service',
            'testFiles':self.c['mysqlTestSources'],'testsTotal':31,'testsPassed':31,'testsSkipped':0,
            'testsTodo':0,'productionActions':0,'reportSha256':'c'*64}
        p.verify_mysql(value,identity,self.c)
        for key,val in (('testsTotal',18),('testsPassed',30),('testsSkipped',1),('workflowRunAttempt','2'),
            ('testFiles',{n:v for n,v in value['testFiles'].items() if '/bank-card-pool/' not in n})):
            changed={**value,key:val}
            with self.assertRaisesRegex(RuntimeError,'MYSQL_EVIDENCE_INVALID'):p.verify_mysql(changed,identity,self.c)
        text=(ROOT/p.WORKFLOW).read_text()
        for required in ('id_business_v2_shared_bank_fixture','export SHARED_BANK_CARD_MYSQL_TEST=1',
            '[10,8,13]','(31 if bounded else 18)',"inputs.recipe == 'bounded-hold-20261019'",'id-token: write',
            'bitbrowser-history-parent-${{ github.run_id }}-${{ github.run_attempt }}'):
            self.assertIn(required,text)

    def test_parent_capture_binds_native_full_inventory_before_absence_and_declaration_bytes(self):
        identity={'commit':'a'*40,'tree':'b'*40,'workflowRunId':'123','workflowRunAttempt':'1'}
        value={**identity,'status':'BITBROWSER_BOUNDED_PARENT_CAPTURED','parentNative':self.c['parentNative'],
            'apiInventory':p.BOUNDED_API_INVENTORY,'apiModules':self.c['baseline']['apiModules'],
            'nativeDeclarationBefore':{n:'d'*64 for n in p.BOUNDED_ORDER_ONLY},
            'absentApiModules':self.c['absentApiModules'],'sealSha256':'c'*64,'databaseWrites':0,'businessActions':0}
        p.verify_bounded_capture(value,identity,self.c)
        for key,val in (('workflowRunId','124'),('apiInventory',{'count':1765,'sha256':'a'*64}),
            ('apiModules',{}),('nativeDeclarationBefore',{}),('absentApiModules',[]),('sealSha256',''),('databaseWrites',1)):
            with self.assertRaisesRegex(RuntimeError,'NATIVE_CAPTURE_INVALID'):
                p.verify_bounded_capture({**value,key:val},identity,self.c)
        c,files,authenticated=self.native_fixture()
        with patch.object(p,'BOUNDED_API_INVENTORY',authenticated):
            native=p.verify_bounded_declarations_native(files,c)
            self.assertEqual(native,{n:files[n]for n in p.BOUNDED_ORDER_ONLY})
            self.assertTrue(all(native[n]!=c['declarationOrderOnly'][n]['before']for n in native))
            for wrong in ({}, {**files,next(iter(files)):'f'*64}, {n:v for n,v in files.items() if n!=next(iter(native))}):
                with self.assertRaisesRegex(RuntimeError,'FULL_INVENTORY_CHANGED'):
                    p.verify_bounded_declarations_native(wrong,c)
        c['baseline']['nativeDeclarationBefore']={n:'e'*64 for n in p.BOUNDED_ORDER_ONLY}
        with self.assertRaisesRegex(RuntimeError,'NATIVE_CAPTURE_INVALID'):p.verify_bounded_capture(value,identity,c)
        with patch.object(p,'HERE',Path('/nonexistent')):
            with self.assertRaises(FileNotFoundError):p.bounded_runtime_contract(None,None,self.c,{**identity,'mode':'preflight','nativeParentCapture':value})

    def test_native_declaration_projection_is_bound_to_seal_capture_and_readback(self):
        c,files,authenticated=self.native_fixture()
        plan={'commit':'a'*40,'tree':'b'*40,'workflowRunId':'123','workflowRunAttempt':'1','mode':'readback','recipe':p.BOUNDED}
        native={n:files[n]for n in p.BOUNDED_ORDER_ONLY}
        baseline={**c['baseline'],'nativeDeclarationBefore':native}
        (ROOT/'.runtime').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT/'.runtime',prefix='native-declaration-seal-')as directory:
            here=Path(directory);seal=p.canonical(p.entry_seal_record(plan,baseline))
            with patch.object(p,'HERE',here),patch.object(p,'BOUNDED_API_INVENTORY',authenticated),\
                patch.object(p,'bounded_parent',return_value=(baseline,files)):
                capture=p.bounded_capture(None,None,c,plan)
                self.assertEqual(capture['nativeDeclarationBefore'],native)
                self.assertEqual((here/'entry-parent-baseline.json').read_bytes(),seal)
                with self.assertRaisesRegex(RuntimeError,'ALREADY_CAPTURED'):p.bounded_capture(None,None,c,plan)
            plan['nativeParentCapture']=capture
            plan['runtimeBaseline']={'verifiedBaseline':baseline,'entryParentSealSha256':p.sha(seal)}
            with patch.object(p,'HERE',here),patch.object(p,'BOUNDED_API_INVENTORY',authenticated):
                hydrated=p.bounded_runtime_contract(None,None,c,plan)
                self.assertEqual(hydrated['baseline']['nativeDeclarationBefore'],native)
                for target in ('capture','seal','inventory','receipt'):
                    changed=copy.deepcopy(plan);wrong=copy.deepcopy(baseline)
                    if target=='capture':changed['nativeParentCapture']['nativeDeclarationBefore'][next(iter(native))]='f'*64
                    if target=='seal':
                        wrong['nativeDeclarationBefore'][next(iter(native))]='f'*64
                        raw=p.canonical(p.entry_seal_record(plan,wrong));(here/'entry-parent-baseline.json').write_bytes(raw)
                        changed['nativeParentCapture']['sealSha256']=p.sha(raw)
                    if target=='inventory':(here/'bounded-parent-inventory.json').write_bytes(p.canonical({**files,next(iter(native)):'f'*64}))
                    if target=='receipt':changed['runtimeBaseline']['verifiedBaseline']['nativeDeclarationBefore'][next(iter(native))]='f'*64
                    with self.assertRaises(RuntimeError):p.bounded_runtime_contract(None,None,c,changed)
                    (here/'entry-parent-baseline.json').write_bytes(seal)
                    (here/'bounded-parent-inventory.json').write_bytes(p.canonical(files))

    def test_authenticated_parent_mismatch_diagnostic_is_bounded_and_cannot_accept_selected_drift(self):
        c,files,authenticated=self.native_fixture(mismatch=True)
        plan={'recipe':p.BOUNDED,'mode':'parent'}
        with patch.object(p,'BOUNDED_API_INVENTORY',authenticated):
            with self.assertRaises(p.BoundedParentMismatch)as failure:p.verify_bounded_parent_selection(files,c)
            error=failure.exception;encoded=p.bounded_parent_failure_json(error,plan,c);report=json.loads(encoded)
            self.assertLess(len((encoded+'\n').encode()),20000)
            self.assertNotIn('\n',encoded)
            self.assertEqual(set(report['selectedBefore']),set(c['baseline']['apiModules']))
            self.assertEqual(len(report['selectedBefore']),42)
            self.assertTrue(all(pair['expected']!=pair['actual']for pair in report['selectedBefore'].values()))
            self.assertEqual(report['nativeDeclarationBefore'],{n:files[n]for n in p.BOUNDED_ORDER_ONLY})
            self.assertFalse(any(n.startswith('preserved/')for n in report['selectedBefore']))
            for changed in ({**plan,'mode':'release'},{**plan,'recipe':'history-20261019'}):
                with self.assertRaisesRegex(RuntimeError,'DIAGNOSTIC_INVALID'):p.bounded_parent_failure_json(error,changed,c)
            for field,value in (('selected_before',{'private':'secret'}),('native_declaration_before',{}),
                ('selected_before',{**error.selected_before,'foreign.js':{'expected':'a'*64,'actual':'b'*64}})):
                previous=getattr(error,field);setattr(error,field,value)
                with self.assertRaisesRegex(RuntimeError,'DIAGNOSTIC_INVALID'):p.bounded_parent_failure_json(error,plan,c)
                setattr(error,field,previous)
            with self.assertRaisesRegex(RuntimeError,'FULL_INVENTORY_CHANGED'):
                p.verify_bounded_parent_selection({**files,next(iter(files)):'f'*64},c)

    def test_dispatch_executes_typed_parent_failure_once_and_transport_rejects_it(self):
        import contextlib
        import io
        from types import SimpleNamespace
        d=load('bitbrowser-history-dispatch.py');c,files,authenticated=self.native_fixture(mismatch=True)
        plan={'recipe':p.BOUNDED,'commit':'a'*40,'tree':'b'*40,'workflowRunId':'123','workflowRunAttempt':'1','controlSources':{}}
        with patch.object(p,'BOUNDED_API_INVENTORY',authenticated):
            with self.assertRaises(p.BoundedParentMismatch)as failure:p.verify_bounded_parent_selection(files,c)
            (ROOT/'.runtime').mkdir(exist_ok=True)
            with tempfile.TemporaryDirectory(dir=ROOT/'.runtime',prefix='native-parent-failure-')as directory:
                here=Path(directory);remote=here/'stage';output=here/'receipts';output.mkdir()
                stage=Path(str(remote)+'-'+plan['commit']+'-'+plan['workflowRunId']);stage.mkdir()
                (stage/p.CONTRACT_FILE).write_text(json.dumps(c))
                stdout=io.StringIO()
                def send(args,**kwargs):
                    parameters=json.loads(args[args.index('--parameters')+1]);command=parameters['commands'][0]
                    source=command.split("python3 - <<'HISTORY_RELEASE'\n",1)[1].rsplit('\nHISTORY_RELEASE',1)[0]
                    source=source.replace('/opt/id-business-v2/.staging/bitbrowser-history-entry',str(remote))
                    module=SimpleNamespace(**p.__dict__)
                    def reject(*unused):raise failure.exception
                    module.release=reject
                    spec=SimpleNamespace(loader=SimpleNamespace(exec_module=lambda unused:None))
                    with patch('importlib.util.spec_from_file_location',return_value=spec),\
                        patch('importlib.util.module_from_spec',return_value=module),contextlib.redirect_stdout(stdout):
                        with self.assertRaises(SystemExit)as stopped:exec(compile(source,'tested-parent-dispatch','exec'),{})
                        self.assertEqual(stopped.exception.code,1)
                    return json.dumps({'Command':{'CommandId':'one-parent-command'}}).encode()
                def invocation(*unused,**kwargs):
                    return SimpleNamespace(returncode=0,stdout=json.dumps({'Status':'Failed','ResponseCode':1,
                        'StandardErrorContent':'','StandardOutputContent':stdout.getvalue()}).encode())
                with patch.object(d,'OUT',output),patch.object(d.subprocess,'check_output',side_effect=send)as sent,\
                    patch.object(d.subprocess,'run',side_effect=invocation):
                    with self.assertRaisesRegex(RuntimeError,'NATIVE_OPERATION_FAILED'):d.transport(plan,'parent')
                    sent.assert_called_once()
                    with self.assertRaisesRegex(RuntimeError,'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN'):d.transport(plan,'parent')
                    sent.assert_called_once()
                report=json.loads(stdout.getvalue())
                self.assertEqual(report['status'],'FAILED');self.assertEqual(len(report['selectedBefore']),42)
                self.assertLess(len(stdout.getvalue().encode()),20000)
                self.assertTrue((output/'parent-invocation.json').is_file())
                self.assertFalse((output/'parent-result.json').exists())
                self.assertFalse((stage/'entry-parent-baseline.json').exists())

    def test_ast_allows_only_same_property_in_same_type_literal_and_no_other_bytes(self):
        before=b'declare function x(): {\n    checkoutIdentifier: string | null;\n    other: number;\n};\n'
        after=b'declare function x(): {\n    other: number;\n    checkoutIdentifier: string | null;\n};\n'
        b.checkout_property_move(before,after,ROOT/'node_modules',p)
        for invalid in (after.replace(b'other: number',b'other: string'),
            b'declare function x(): {\n    other: number;\n};\ndeclare function y(): {\n    checkoutIdentifier: string | null;\n};\n',
            after.replace(b'checkoutIdentifier: string | null',b'checkoutIdentifier: string'),
            after+b'declare function y(p: [string, number]): void;\n'):
            with self.assertRaisesRegex(RuntimeError,'DECLARATION_PROPERTY_MOVE_INVALID'):
                b.checkout_property_move(before,invalid,ROOT/'node_modules',p)
        params=b'declare function x(a: string, b: number): void;\n'
        with self.assertRaisesRegex(RuntimeError,'DECLARATION_PROPERTY_MOVE_INVALID'):
            b.checkout_property_move(params,params.replace(b'a: string, b: number',b'b: number, a: string'),ROOT/'node_modules',p)
        cross_before=b'declare const x: {\n    checkoutIdentifier: string | null;\n    a: number;\n};\ndeclare const y: {\n    b: number;\n};\n'
        cross_after=b'declare const x: {\n    a: number;\n};\ndeclare const y: {\n    checkoutIdentifier: string | null;\n    b: number;\n};\n'
        with self.assertRaisesRegex(RuntimeError,'DECLARATION_PROPERTY_MOVE_INVALID'):
            b.checkout_property_move(cross_before,cross_after,ROOT/'node_modules',p)

    def test_only_exact_frozen_declaration_file_hashes_can_be_preserved(self):
        name=next(iter(self.c['declarationOrderOnly']))
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); before=root/'before';after=root/'after'
            for context in (before,after):
                target=context/'apps/api/dist'/name;target.parent.mkdir(parents=True);target.write_bytes(b'unapproved')
            with self.assertRaisesRegex(RuntimeError,'DECLARATION_HASH_CHANGED'):
                b.preserve_order_only(before,after,self.c,p)
        self.assertEqual(set(self.c['declarationOrderOnly']),p.BOUNDED_ORDER_ONLY)
        for name in ('bitbrowser-recovery-contract.json','bitbrowser-history-contract.json','bitbrowser-followup-contract.json',
            'bitbrowser-entry-start-contract.json','bitbrowser-existing-address-contract.json'):
            self.assertEqual(p.sha((HERE/name).read_bytes()),self.c['controlPins'][name])

    def test_exact_before_declaration_hash_is_noop_and_third_hash_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);before=root/'before';after=root/'after';c=copy.deepcopy(self.c)
            for name in p.BOUNDED_ORDER_ONLY:
                for context in (before,after):
                    path=context/'apps/api/dist'/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'exact-before')
                c['declarationOrderOnly'][name]={'before':p.sha(b'exact-before'),'after':p.sha(b'exact-after')}
            with patch.object(b,'checkout_property_move') as move:
                b.preserve_order_only(before,after,c,p);move.assert_not_called()
            (after/'apps/api/dist'/next(iter(c['declarationOrderOnly']))).write_bytes(b'unapproved-third-hash')
            with self.assertRaisesRegex(RuntimeError,'DECLARATION_HASH_CHANGED'):b.preserve_order_only(before,after,c,p)

    def test_frozen_bounded_payload_cannot_contain_spec_ci_or_unchanged_declaration(self):
        helper=load('recharge-record-release.py');identity={'commit':'a'*40,'tree':'b'*40,'workflowRunId':'123','workflowRunAttempt':'1'}
        mysql={**identity,'scope':'OWNED_EMPTY_DATABASE','runtime':'github-actions-mysql-service','testFiles':self.c['mysqlTestSources'],
            'testsTotal':31,'testsPassed':31,'testsSkipped':0,'testsTodo':0,'productionActions':0,'reportSha256':'c'*64}
        capture={**identity,'status':'BITBROWSER_BOUNDED_PARENT_CAPTURED','parentNative':self.c['parentNative'],
            'apiInventory':p.BOUNDED_API_INVENTORY,'apiModules':self.c['baseline']['apiModules'],
            'nativeDeclarationBefore':{n:'d'*64 for n in p.BOUNDED_ORDER_ONLY},
            'absentApiModules':self.c['absentApiModules'],'sealSha256':'c'*64,'databaseWrites':0,'businessActions':0}
        with tempfile.TemporaryDirectory() as directory:
            payload=Path(directory)
            for name in self.c['productionSources']:
                path=payload/'source'/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((ROOT/name).read_bytes())
            for name in p.MODULES:
                path=payload/'api/modules'/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'synthetic-output')
            for name in ['index.html']+[f'assets/test-{i}.js'for i in range(250)]:
                path=payload/'admin/html'/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'synthetic-admin')
            proof={**identity,'version':1,'recipe':p.BOUNDED,'scope':p.SCOPE,'contractSha256':'d'*64,
                'sources':self.c['sources'],'productionSources':self.c['productionSources'],'controlSources':self.c['controlPins'],
                'baselineModulesReproduced':self.c['baseline']['apiModules'],'predecessorProofSha256':p.BOUNDED_PROOF,
                'baselineSharedUnchanged':True,'migrationPerformed':False,'businessActions':0,'updatedServices':list(p.UPDATED),
                'qualityVerification':{},'isolatedMysqlVerification':mysql,'nativeParentCapture':capture,
                'apiModules':helper.file_inventory(payload/'api/modules'),'adminFiles':helper.file_inventory(payload/'admin/html'),
                'baselineAdminReproduced':True,'baselineAdminFiles':self.c['publishedAdminFiles'],'files':helper.file_inventory(payload)}
            if self.c.get('mysqlTestInputRepair'):
                proof['mysqlTestInputRepair'] = self.c['mysqlTestInputRepair']
            p.verify_proof(proof,proof,self.c,payload,helper)
            for extra in ('source/scripts/ci-recharge-scope.mjs','source/'+next(iter(p.TEST_SOURCES)),
                'api/modules/id-business-v2/online-recharge/persistence/worker.repository.d.ts'):
                path=payload/extra;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'foreign-output')
                with self.assertRaisesRegex(RuntimeError,'PAYLOAD_CHANGED'):p.verify_proof(proof,proof,self.c,payload,helper)
                path.unlink()

    def test_bounded_release_execution_captures_admin_before_backup_and_any_activation(self):
        from types import SimpleNamespace
        from unittest.mock import MagicMock
        events=[]
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); controls=root/'controls';controls.mkdir();base=root/'production';base.mkdir();(base/'.staging').mkdir()
            current=base/'releases'/'parent';current.mkdir(parents=True)
            c=copy.deepcopy(self.c);c['controlPins']={};c['baseline']={**c['baseline'],'backupNormalizerPath':str(current/'normalizer')}
            raw=p.canonical(c);(controls/p.CONTRACT_FILE).write_bytes(raw)
            plan={'commit':'a'*40,'tree':'b'*40,'workflowRunId':'123','workflowRunAttempt':'1','mode':'release',
                'recipe':p.BOUNDED,'contractSha256':p.sha(raw),'controlSources':{p.CONTRACT_FILE:p.sha(raw)},
                'runtimeBaseline':{'sealed':True},'artifactSha256':p.sha(b'bundle'),'buildProofSha256':p.sha(b'{}'),
                'artifactUrl':'https://github.com/wangchaozhuanyong/id-business-system/releases/download/bitbrowser-history-'+'a'*40+'/bitbrowser-history-artifact.tar.gz'}
            before={'api':{'containerId':'api','image':'old-api'},'admin':{'containerId':'admin','image':'old-admin'}}
            def archive(raw,path):
                path.mkdir();(path/'api').mkdir();(path/'admin').mkdir();(path/'build-proof.json').write_bytes(b'{}');return path
            def capture(*args):events.append('capture-admin');return {'old.js':'a'*64}
            def backup(*args,**kwargs):
                events.append('backup');self.assertIn('capture-admin',events)
                raise RuntimeError('SYNTHETIC_STOP_BEFORE_SWITCH')
            driver=SimpleNamespace(run=lambda *args,**kwargs:json.dumps([{'Id':'synthetic-image'}]))
            helper=SimpleNamespace(safe_archive=archive,base_image_reference=lambda *args:'synthetic-parent',
                build_image=lambda *args:events.append('build-'+args[3]),fresh_scoped_backup=backup)
            availability=SimpleNamespace(acquire_release_lock=lambda lock:None,normalize_image_context=lambda context:None)
            overlay=SimpleNamespace(verify_overlay_image=lambda *args:None)
            checkout=SimpleNamespace(admin_inventory=capture)
            def modules(name):
                return {'recharge-availability-release.py':availability,'proxy-result-identity-release.py':overlay,
                    'recharge-checkout-release.py':checkout}[name]
            response=MagicMock();response.__enter__.return_value.read.return_value=b'bundle'
            with patch.object(p,'HERE',controls),patch.object(p,'BASE',base),patch.object(p,'validate_contract'), \
                patch.object(p,'helpers',return_value=(helper,driver,None)),patch.object(p,'load',side_effect=modules), \
                patch.object(p,'bounded_runtime_contract',return_value=c), \
                patch.object(p,'baseline',return_value=(current,b'{}',before,plan['runtimeBaseline'])), \
                patch.object(p.urllib.request,'urlopen',return_value=response), \
                patch.object(p,'verify_proof',return_value={'apiModules':{},'adminFiles':{}}), \
                patch.object(p,'activate_services') as activate:
                with self.assertRaisesRegex(RuntimeError,'SYNTHETIC_STOP_BEFORE_SWITCH'):p.release(plan,c)
                activate.assert_not_called()
            self.assertEqual(events,['build-api','build-admin','capture-admin','backup'])

    def test_quality_requires_guards_api_admin_and_payload_never_has_test_or_ci_sources(self):
        for names in (['recharge (guards)','recharge (api)','recharge (admin)'],['full-quality']):
            b.require_quality_jobs([{'name':n,'conclusion':'success'} for n in names],p)
        for names in (['recharge (guards)','recharge (api)'],['recharge (guards)','recharge (admin)']):
            with self.assertRaises(RuntimeError):b.require_quality_jobs([{'name':n,'conclusion':'success'} for n in names],p)
        from inspect import getsource
        source=getsource(b.bounded_main)
        self.assertIn("for name in c['productionSources']:",source)
        self.assertNotIn("for name in c['sources']:",source)
        self.assertLess(source.index('bounded_native_capture('),source.index('reconstruct_bounded_parent('))
        self.assertIn('verify_bounded_delta(',source)
        self.assertIn('preserve_order_only(before, context, c, p)',source)
        release=getsource(p.release)
        self.assertIn("return bounded_capture(d, h, c, plan)",release)
        self.assertLess(release.index("return bounded_capture(d, h, c, plan)"),release.index('h.fresh_scoped_backup('))
        self.assertIn('for name in production_sources(c):',release)
        self.assertIn("'preflight', 'release', 'readback'",release)


if __name__ == '__main__':
    unittest.main()
