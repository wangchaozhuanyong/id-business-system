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


if __name__ == '__main__':
    unittest.main()
