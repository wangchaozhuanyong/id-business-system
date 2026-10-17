"""Pure release admission regressions. No Docker, database or production calls."""
import ast
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('test_' + name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


r = load('recharge-checkout-release.py')
b = load('recharge-checkout-build.py')
h = load('recharge-record-release.py')
d = load('recharge-checkout-dispatch.py')
MYSQL_TEST = 'apps/api/src/id-business-v2/auto-recharge/recharge-direct-payment.mysql.integration.spec.ts'


def mysql_proof(plan, contract):
    return {**{key: plan[key] for key in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt')},
            'version': 1, 'scope': 'OWNED_EMPTY_DATABASE', 'runtime': 'github-actions-mysql-service',
            'database': contract['isolatedMysqlTest']['database'], 'testFile': MYSQL_TEST,
            'testFileSha256': contract['sources'][MYSQL_TEST], 'reportSha256': 'a' * 64,
            'testsTotal': 8, 'testsPassed': 8, 'testsSkipped': 0, 'testsTodo': 0,
            'productionActions': 0, 'browserRequests': 0}


class CheckoutPublicationTests(unittest.TestCase):
    def test_proof_rejects_wrong_source_quality_database_or_extra_modules(self):
        output = ROOT / '.runtime/checkout-publication-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as name:
            root = Path(name)
            source = 'apps/api/src/id-business-v2/auto-recharge/recharge-unidentified-checkout.ts'
            module = 'id-business-v2/auto-recharge/recharge-unidentified-checkout.js'
            api = {module.removesuffix('.js') + ext: 'fixture' for ext in ('.js', '.js.map', '.d.ts')}
            files = {'source/' + source: b'source', 'source/' + MYSQL_TEST: b'test'}
            files.update({'api/modules/' + n: v.encode() for n, v in api.items()})
            files.update({'admin/html/' + ('index.html' if n == 0 else 'assets/' + str(n) + '.js'): str(n).encode() for n in range(250)})
            for path, raw in files.items():
                p = root / path
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(raw)
            inv = h.file_inventory(root)
            database = {'schemaChanged': False, 'sqlChanged': False, 'databaseStarted': False}
            contract = {'scope': 'checkout', 'sources': {source: r.digest(b'source'), MYSQL_TEST: r.digest(b'test')},
                        'apiModules': {module: None}, 'apiSourceBaseline': 'api-before',
                        'adminSourceBaseline': 'admin-before', 'databaseVerification': database,
                        'isolatedMysqlTest': {'testFile': MYSQL_TEST, 'tests': 8, 'database': 'id_business_v2_recharge_direct_fixture'}}
            plan = {n: 'exact-' + n for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controllerSha256', 'releaseUtilitySha256', 'helperSha256')}
            plan['qualityVerification'] = {'runId': '123', 'commit': plan['commit'], 'sourceTree': plan['tree'],
                                            'path': '.github/workflows/quality.yml', 'conclusion': 'success'}
            plan['isolatedMysqlVerification'] = mysql_proof(plan, contract)
            proof = {**plan, 'version': 1, 'scope': 'checkout', 'baselineApiReproduced': True, 'baselineAdminReproduced': True,
                     'baselinePublishedVerified': {'apiSource': 'api-before', 'adminSource': 'admin-before', 'verified': True},
                     'databaseVerification': database, 'updatedServices': ['api', 'admin'], 'migrationPerformed': False,
                     'businessActions': 0, 'files': inv, 'apiModules': {n: inv['api/modules/' + n] for n in api},
                     'adminFiles': {n.removeprefix('admin/html/'): v for n, v in inv.items() if n.startswith('admin/html/')}}
            r.validate_proof(proof, plan, contract, root, h)
            for field in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'baselineApiReproduced',
                          'baselineAdminReproduced', 'baselinePublishedVerified', 'databaseVerification', 'qualityVerification',
                          'migrationPerformed', 'businessActions', 'isolatedMysqlVerification'):
                bad = copy.deepcopy(proof)
                bad[field] = 'changed'
                with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'PROOF_INVALID'):
                    r.validate_proof(bad, plan, contract, root, h)
            (root / 'api/modules/unreviewed.js').write_text('unreviewed')
            with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
                r.validate_proof(proof, plan, contract, root, h)

    def test_runtime_successor_prevents_even_preflight(self):
        c = json.loads(b.CONTRACT.read_bytes())
        output = ROOT / '.runtime/checkout-publication-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as name:
            base = Path(name)
            (base / 'current').mkdir()
            with patch.object(r, 'BASE', base), self.assertRaisesRegex(RuntimeError, 'CURRENT_CHANGED'):
                r.baseline(Mock(), c, Mock())

    def test_artifact_input_contract_has_no_schema_or_cross_module_source(self):
        c = json.loads(b.CONTRACT.read_bytes())
        self.assertEqual(c['databaseVerification'], {'schemaChanged': False, 'sqlChanged': False, 'databaseStarted': False})
        runtime = {n.removeprefix('apps/api/src/').removesuffix('.ts') + '.js' for n in c['sources']
                   if n.startswith('apps/api/src/') and n.endswith('.ts') and not n.endswith('.spec.ts')}
        self.assertEqual(set(c['apiModules']), runtime)
        self.assertEqual(set(c['apiBaselineFiles']), {n.removesuffix('.js') + ext for n in runtime for ext in ('.js', '.js.map', '.d.ts')})
        self.assertGreaterEqual(len(c['publicFiles']), 250)
        self.assertGreater(c['preservedAdminInventory']['count'], len(c['publicFiles']))
        self.assertEqual(len(c['preservedAdminInventory']['sha256']), 64)
        self.assertEqual(c['publishedAdminRecipe']['commit'], c['adminSourceBaseline'])
        self.assertEqual(c['isolatedMysqlTest'], {'testFile': MYSQL_TEST, 'tests': 8,
                                                'database': 'id_business_v2_recharge_direct_fixture'})
        self.assertNotEqual(c['apiSourceBaseline'], c['adminSourceBaseline'])
        for name, sha in c['sources'].items():
            self.assertEqual(r.digest((ROOT / name).read_bytes()), sha, name)
            self.assertNotIn('/online-recharge/', name)
            self.assertNotIn('/prisma', name)
        functions = [node.name for node in ast.parse((HERE / 'recharge-checkout-release.py').read_text()).body if isinstance(node, ast.FunctionDef)]
        self.assertNotIn('apply_migration', functions)

    def test_isolated_mysql_proof_rejects_skips_identity_changes_and_wrong_database(self):
        c = json.loads(b.CONTRACT.read_bytes())
        plan = {key: 'fixture-' + key for key in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt')}
        proof = mysql_proof(plan, c)
        self.assertEqual(r.verify_mysql_verification(proof, plan, c), proof)
        changes = {'testsTotal': 7, 'testsPassed': 7, 'testsSkipped': 1, 'testsTodo': 1,
                   'productionActions': 1, 'browserRequests': 1, 'database': 'production', 'scope': 'PRODUCTION',
                   'runtime': 'local', 'testFile': 'other.spec.ts', 'testFileSha256': 'b' * 64,
                   'reportSha256': 'missing', 'commit': 'other', 'tree': 'other', 'workflowRunId': 'other',
                   'workflowRunAttempt': 'other'}
        for key, value in changes.items():
            with self.subTest(field=key), self.assertRaisesRegex(RuntimeError, 'ISOLATED_MYSQL_PROOF_INVALID'):
                r.verify_mysql_verification({**proof, key: value}, plan, c)
        for key in ('testsTotal', 'testsSkipped', 'testsTodo', 'productionActions', 'browserRequests'):
            with self.subTest(boolean=key), self.assertRaises(RuntimeError):
                r.verify_mysql_verification({**proof, key: False}, plan, c)

    def test_mysql_report_requires_exact_eight_passed_cases_and_native_ci(self):
        c = json.loads(b.CONTRACT.read_bytes())
        output = ROOT / '.runtime/checkout-publication-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        report = {'success': True, 'numTotalTests': 8, 'numPassedTests': 8, 'numFailedTests': 0,
                  'numPendingTests': 0, 'numTodoTests': 0, 'numFailedTestSuites': 0, 'numPendingTestSuites': 0,
                  'testResults': [{'name': str(ROOT / MYSQL_TEST), 'status': 'passed',
                                   'assertionResults': [{'status': 'passed'} for _ in range(8)]}]}
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_SHA': 'fixture', 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}
        with tempfile.TemporaryDirectory(dir=output) as name:
            path = Path(name) / 'report.json'
            def verify(value):
                path.write_text(json.dumps(value))
                return b.mysql_verification(c)
            with patch.object(b, 'MYSQL_REPORT', path), patch.object(b, 'git', return_value=b'fixture-tree\n'), patch.dict(os.environ, env):
                result = verify(report)
                self.assertEqual((result['testsTotal'], result['testsPassed'], result['testsSkipped']), (8, 8, 0))
                for key, value in (('success', False), ('numTotalTests', 7), ('numPassedTests', 7), ('numPendingTests', 1), ('numTodoTests', 1)):
                    with self.subTest(field=key), self.assertRaisesRegex(RuntimeError, 'ISOLATED_MYSQL_TESTS_NOT_PASSED'):
                        verify({**report, key: value})
                wrong_file = copy.deepcopy(report)
                wrong_file['testResults'][0]['name'] = str(ROOT / 'other.spec.ts')
                with self.assertRaises(RuntimeError):
                    verify(wrong_file)
                skipped = copy.deepcopy(report)
                skipped['testResults'][0]['assertionResults'][0]['status'] = 'pending'
                with self.assertRaises(RuntimeError):
                    verify(skipped)
                path.write_text(json.dumps(report))
                with patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}), self.assertRaisesRegex(RuntimeError, 'ISOLATED_MYSQL_REPORT_MISSING'):
                    b.mysql_verification(c)

    def test_workflow_builds_shared_before_mysql_and_keeps_unique_fixture(self):
        workflow = (ROOT / '.github/workflows/recharge-checkout-validation.yml').read_text()
        section = workflow.split('name: Verify real payment gates in a dedicated isolated MySQL fixture', 1)[1].split('      - name:', 1)[0]
        self.assertLess(section.index('npm run build --workspace @apple-business/shared'), section.index('npm run prisma:mysql:generate'))
        self.assertLess(section.index('npm run prisma:mysql:migrate:deploy'), section.index('npm run test --workspace @apple-business/api'))
        self.assertIn(MYSQL_TEST.removeprefix('apps/api/'), section)
        self.assertIn('id_business_v2_recharge_direct_fixture', section)
        self.assertIn('RECHARGE_DIRECT_MYSQL_TEST:', section)
        self.assertIn('cancel-in-progress: false', workflow)

    def test_workflow_preserves_mysql_diagnostics_without_bypassing_failure(self):
        workflow = (ROOT / '.github/workflows/recharge-checkout-validation.yml').read_text()
        mysql = workflow.split('name: Verify real payment gates in a dedicated isolated MySQL fixture', 1)[1].split('      - name:', 1)[0]
        self.assertIn('--reporter=default --reporter=json', mysql)
        self.assertNotIn('continue-on-error', mysql)
        self.assertNotIn('|| true', mysql)
        diagnostic = workflow.split('name: Preserve isolated MySQL diagnostics', 1)[1].split('      - name:', 1)[0]
        self.assertIn('if: always()', diagnostic)
        self.assertIn('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02', diagnostic)
        self.assertIn('name: recharge-checkout-mysql-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}', diagnostic)
        self.assertIn('path: .runtime/recharge-web-direct-release/mysql-vitest.json', diagnostic)
        self.assertIn('include-hidden-files: true', diagnostic)
        self.assertIn('if-no-files-found: warn', diagnostic)
        self.assertLess(workflow.index('name: Preserve isolated MySQL diagnostics'),
                        workflow.index('name: Verify successful quality gate and reproduce exact published API and Admin inputs'))
        self.assertIn('needs: validate', workflow)

    def test_complete_admin_history_fingerprint_rejects_any_loss_or_mutation(self):
        actual = {'index.html': 'a' * 64, 'assets/old.js': 'b' * 64}
        expected = {'count': len(actual), 'sha256': r.digest(json.dumps(actual, sort_keys=True, separators=(',', ':')).encode())}
        r.verify_admin_inventory(actual, expected)
        for changed in ({'index.html': actual['index.html']}, {**actual, 'assets/old.js': 'c' * 64}, {**actual, 'assets/new.js': 'c' * 64}):
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, 'ADMIN_HISTORY_CHANGED'):
                r.verify_admin_inventory(changed, expected)

    def test_admin_inventory_only_accepts_unique_safe_paths(self):
        driver = Mock()
        driver.run.return_value = 'a' * 64 + '  ./index.html\n' + 'b' * 64 + '  ./assets/old.js\n'
        self.assertEqual(len(r.admin_inventory(driver, {'containerId': 'synthetic'})), 2)
        self.assertIn('test -z "$(find . -type l -print -quit)"', driver.run.call_args.args[5])
        for rows in ('a' * 64 + '  ./../other\n', 'a' * 64 + '  /etc/other\n', 'a' * 64 + '  ./index.html\n' + 'b' * 64 + '  ./index.html\n'):
            driver.run.return_value = rows
            with self.subTest(rows=rows), self.assertRaisesRegex(RuntimeError, 'ADMIN_INVENTORY_INVALID'):
                r.admin_inventory(driver, {'containerId': 'synthetic'})

    def test_source_projections_advance_both_changed_roles_only(self):
        c = json.loads(b.CONTRACT.read_bytes())
        before = {'api': {'commit': 'old-api'}, 'admin': {'commit': 'old-admin'}, 'auto-registration': {'commit': 'retained'}}
        plan = {'commit': 'new', 'tree': 'new-tree', 'buildProofSha256': 'proof'}
        proof = {'apiModules': {'module.js': 'synthetic'}}
        result = r.source_projections(before, plan, c, proof)
        for role in ('api', 'admin'):
            self.assertEqual(result[role]['commit'], plan['commit'])
            self.assertEqual(result[role]['sourceTree'], plan['tree'])
            self.assertEqual(result[role]['buildProofSha256'], plan['buildProofSha256'])
            self.assertEqual(result[role]['sourceBaseline'], c[role + 'SourceBaseline'])
        self.assertEqual(result['api']['apiModules'], proof['apiModules'])
        self.assertEqual(result['admin']['publishedAdminRecipe'], c['publishedAdminRecipe'])
        self.assertEqual(result['auto-registration'], before['auto-registration'])
        self.assertEqual(before['api']['commit'], 'old-api')

    def test_accepted_send_with_lost_ack_is_never_sent_again(self):
        output = ROOT / '.runtime/checkout-publication-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        plan = {'commit': 'a' * 40, 'workflowRunId': '123'}
        with tempfile.TemporaryDirectory(dir=output) as name:
            with patch.object(d, 'OUTPUT', Path(name)), patch.object(d, 'execute', side_effect=RuntimeError('synthetic_ack_lost')) as send:
                for mode in ('preflight', 'release', 'readback'):
                    with self.subTest(mode=mode), self.assertRaisesRegex(RuntimeError, 'synthetic_ack_lost'):
                        d.transport(plan, {}, mode)
                    self.assertTrue((Path(name) / (mode + '-command-intent.json')).is_file())
                    self.assertFalse((Path(name) / (mode + '-accepted-command.json')).exists())
                    self.assertEqual(send.call_args.kwargs['env']['AWS_MAX_ATTEMPTS'], '1')
                    count = send.call_count
                    with self.assertRaisesRegex(RuntimeError, 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                        d.transport(plan, {}, mode)
                    self.assertEqual(send.call_count, count)
                self.assertEqual(send.call_count, 3)

    def test_image_configuration_accepts_only_deprecated_parent_marker_difference(self):
        original = {'Image': 'sha256:' + 'a' * 64, 'Env': ['fixture=value'], 'User': '1000', 'Labels': {'x': '1'}}
        built = {**original, 'Image': '', 'Labels': {'x': '1', 'revision': '2'}}
        r.verify_image_configuration(original, built)
        for changed in ({**built, 'User': 'root'}, {**built, 'Env': ['different']}, {**built, 'Image': 'untrusted'}):
            with self.assertRaises(RuntimeError):
                r.verify_image_configuration(original, changed)


if __name__ == '__main__':
    unittest.main()
