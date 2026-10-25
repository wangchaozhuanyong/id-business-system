"""Offline finite paired-release and preservation tests. No production access."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('proxy_failure_release', HERE / 'online-proxy-failure-evidence-release.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ProxyFailureReleaseTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())
        source = {'head': p.SOURCE, 'tree': p.SOURCE_TREE, 'pullRequest': 710, 'runId': '123', 'sourceReceiptSha256': 'd' * 64}
        control = {'head': 'c' * 40, 'tree': 'b' * 40, 'pullRequest': 711, 'runId': '124', 'sourceReceiptSha256': 'e' * 64}
        qa = {'source': source, 'control': control, 'main': {'head': 'a' * 40, 'runId': '125'}, 'commit': 'a' * 40, 'tree': 'b' * 40}
        self.plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '126', 'workflowRunAttempt': '1',
            'contractSha256': p.sha((HERE / p.CONTRACT_FILE).read_bytes()),
            'controlSources': {**self.c['controlPins'], p.CONTRACT_FILE: p.sha((HERE / p.CONTRACT_FILE).read_bytes())},
            'qualitySourceEvidence': qa,
            'nativeParentCapture': {'baseline': {}, 'status': 'ONLINE_CHECKOUT_RESUME_PARENT_VERIFIED', 'businessActions': 0}}
        self.c['baselineAdminFilesSha256'] = p.core().load('recharge-record-release.py').fingerprint({'index.html': 'd' * 64})
        modules = {n.removesuffix('.js') + ext: 'e' * 64 for n in self.c['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
        self.proof = {**self.plan, 'version': 1, 'scope': p.SCOPE, 'sources': self.c['sources'],
            'afterEngineFiles': self.c['afterEngineFiles'], 'baselineApiReproduced': True,
            'baselineAdminSourceReproduced': True, 'baselineAdminFiles': {'index.html': 'd' * 64},
            'adminFiles': {'index.html': 'd' * 64}, 'apiModules': modules, 'migrationPerformed': False, 'businessActions': 0}
        self.files = {**{'source/' + n: v for n, v in self.c['sources'].items()},
            **{'api/modules/' + n: v for n, v in modules.items()},
            **{'admin/html/' + n: v for n, v in self.proof['adminFiles'].items()},
            **{'engine/' + n: v for n, v in self.c['afterEngineFiles'].items() if self.c['beforeEngineFiles'].get(n) != v}}
        self.proof['files'] = self.files

    def test_valid_exact_triple_and_current_parent(self):
        p.validate_contract(self.c)
        p.verify_proof(self.proof, self.plan, self.c, self.files)
        self.assertEqual(p.UPDATED, ('api', 'admin', 'online-recharge'))
        self.assertEqual(self.c['parentArtifact']['commit'], p.CURRENT)
        self.assertEqual(self.c['parentPlan']['commit'], p.CURRENT)
        self.assertEqual(self.c['apiModules'], p.API)

    def test_common_switch_and_original_preservation_are_reused(self):
        original = p.load('online-checkout-resume-release.py')
        core = p.core()
        self.assertEqual(core.publish_pair.__code__.co_code, original.publish_pair.__code__.co_code)
        self.assertEqual(core.smoke.__code__.co_code, original.smoke.__code__.co_code)
        self.assertEqual(core.capture_parent, p.capture_parent)

    def test_parent_source_or_target_change_is_rejected(self):
        for key in ('expectedCurrent', 'sourceReviewCommit', 'awsTargetAccount', 'awsTargetInstance'):
            changed = copy.deepcopy(self.c); changed[key] = 'f' * 40
            with self.assertRaises(RuntimeError): p.validate_contract(changed)

    def test_admin_or_extra_api_module_is_rejected(self):
        for key, value in [('updatedServices', ['api', 'online-recharge']), ('apiModules', [*p.API, 'id-business-v2/orders.js'])]:
            changed = copy.deepcopy(self.c); changed[key] = value
            with self.assertRaises(RuntimeError): p.validate_contract(changed)

    def test_unreviewed_engine_or_source_change_is_rejected(self):
        for key in ('afterEngineFiles', 'sources'):
            changed = copy.deepcopy(self.c); changed[key]['extra.js'] = 'f' * 64
            with self.assertRaises(RuntimeError): p.validate_contract(changed)

    def test_extra_payload_and_private_browser_files_are_rejected(self):
        for name in ('api/modules/auth/session.js', 'engine/runtime/browser-profiles/cookie', 'admin/html/index.html'):
            with self.assertRaises(RuntimeError): p.verify_proof(self.proof, self.plan, self.c, {**self.files, name: 'f' * 64})

    def test_unreproduced_api_or_migration_is_rejected(self):
        for key, value in [('baselineApiReproduced', False), ('baselineAdminSourceReproduced', False), ('migrationPerformed', True), ('businessActions', 1)]:
            changed = {**self.proof, key: value}
            with self.assertRaises(RuntimeError): p.verify_proof(changed, self.plan, self.c, self.files)

    def test_source_quality_or_control_tree_cannot_be_substituted(self):
        for node, field in [('source', 'head'), ('source', 'tree'), ('control', 'tree'), ('main', 'head')]:
            changed = copy.deepcopy(self.proof); changed['qualitySourceEvidence'][node][field] = 'f' * 40
            with self.assertRaises(RuntimeError): p.verify_proof(changed, self.plan, self.c, self.files)

    def test_admin_inventory_and_sql_fence_are_bound(self):
        self.assertEqual(self.c['sqlFenceHelperSha256'], self.c['controlPins']['api-admin-scope.py'])
        changed = {**self.proof, 'adminFiles': {'index.html': 'f' * 64}}
        with self.assertRaises(RuntimeError): p.verify_proof(changed, self.plan, self.c, self.files)

    def test_both_jobs_receive_expected_current_and_one_release_lane(self):
        workflow = (HERE.parents[1] / '.github/workflows/online-proxy-failure-evidence-publication.yml').read_text()
        for job in ('validate', 'publish'):
            body = workflow.split('  ' + job + ':\n', 1)[1].split('\n  publish:', 1)[0]
            self.assertIn('      EXPECTED_CURRENT: ${{ inputs.expected_current }}', body)
        self.assertIn('group: id-business-v2-production-release', workflow)
        self.assertIn('cancel-in-progress: false', workflow)

    def test_failure_report_does_not_expose_raw_exception(self):
        report = p.failure_report(RuntimeError('Authorization: private'), {'mode': 'parent', 'controlSources': {}})
        self.assertNotIn('private', json.dumps(report))


    def test_parent_reproduction_and_triple_build_are_required(self):
        build = (HERE / 'online-proxy-failure-evidence-build.py').read_text()
        self.assertIn("PUBLISHED_API_NOT_REPRODUCED", build)
        self.assertIn("PUBLISHED_ADMIN_NOT_REPRODUCED", build)
        self.assertIn("admin / 'apps/admin/dist'", build)
        self.assertIn("card_read['sourceReviewCommit']", build)
        publication = (HERE / 'online-proxy-failure-evidence-publication.py').read_text()
        self.assertIn("'recharge (admin)'", publication)
        self.assertIn("pr_number == 710", publication)
        self.assertIn("COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN", publication)

    def test_control_payload_or_source_runtime_hashes_cannot_be_changed(self):
        for name in ('sources', 'expectedApiFiles'):
            changed = copy.deepcopy(self.c)
            changed[name][next(iter(changed[name]))] = '0' * 64
            with self.assertRaises(RuntimeError): p.validate_contract(changed)


if __name__ == '__main__': unittest.main()
