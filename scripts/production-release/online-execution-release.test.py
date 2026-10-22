"""Finite-source, sealed-parent, payload and publication-boundary counterexamples."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('execution_test', HERE / 'online-execution-release.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class ExecutionRelease(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
        (P.ROOT / '.runtime').mkdir(exist_ok=True)

    def rejected(self, mutate):
        c = copy.deepcopy(self.c)
        mutate(c)
        with self.assertRaises(RuntimeError):
            P.validate_contract(c)

    def test_finite_contract(self):
        P.validate_contract(self.c)
        self.assertEqual(len(P.SOURCES), 18)
        self.assertEqual(len(P.MODULES), 3)
        self.assertEqual(self.c['updatedServices'], ['api', 'online-recharge'])

    def test_extra_application(self):
        self.rejected(lambda c: c['productionSources'].update({'apps/admin/src/v2/other.ts': 'a' * 64}))

    def test_missing_source(self):
        self.rejected(lambda c: c['productionSources'].pop(P.WORKER))

    def test_wrong_predecessor(self):
        self.rejected(lambda c: c.update(expectedCurrent='a' * 40))

    def test_wrong_parent_proof(self):
        self.rejected(lambda c: c['parentPlan'].update(buildProofSha256='a' * 64))

    def test_migration_rejected(self):
        self.rejected(lambda c: c.update(migrationPerformed=True))

    def test_payment_rejected(self):
        self.rejected(lambda c: c.update(businessActions=1))

    def test_sql_fence_preserved(self):
        self.rejected(lambda c: c.update(sqlFenceHelperSha256='a' * 64))

    def test_engine_parent_preserved(self):
        self.rejected(lambda c: c['beforeEngineFiles'].update({'unexpected.cjs': 'a' * 64}))

    def test_services_preserved(self):
        self.rejected(lambda c: c['updatedServices'].append('admin'))

    def test_only_pinned_declaration_difference_is_allowed(self):
        P.verify_parent_modules(self.c, self.c['buildParentApiModules'], self.c['nativeParentApiModules'])
        for name in P.MODULES:
            local = {**self.c['buildParentApiModules'], name: 'f' * 64}
            with self.assertRaises(RuntimeError):
                P.verify_parent_modules(self.c, local, self.c['nativeParentApiModules'])
        self.rejected(lambda c: c['nativeParentApiModules'].update({P.DECLARATION: 'a' * 64}))

    def test_quality_required(self):
        with self.assertRaises(RuntimeError):
            P.verify_quality({}, 'b' * 40)

    def test_reused_source_checks_are_pinned_and_controls_are_independent(self):
        quality = {'sources': {'commit': P.SOURCE_HEAD, 'runId': P.SOURCE_RUN,
                    'pullRequest': 673, 'sourceReceiptSha256': 'c' * 64},
                   'controls': {'commit': 'a' * 40, 'runId': '4',
                    'pullRequest': 674, 'sourceReceiptSha256': 'd' * 64},
                   'release': {'commit': 'b' * 40, 'runId': '5'}}
        P.verify_quality(quality, 'b' * 40)
        for mutate in (lambda q: q.pop('controls'),
                       lambda q: q['sources'].update(commit='f' * 40),
                       lambda q: q['sources'].update(runId='1'),
                       lambda q: q['controls'].pop('sourceReceiptSha256')):
            bad = copy.deepcopy(quality)
            mutate(bad)
            with self.assertRaises(RuntimeError):
                P.verify_quality(bad, 'b' * 40)
        self.assertEqual(len(P.CONTROL_PATHS), 8)
        self.assertFalse(any(n.startswith('apps/') for n in P.CONTROL_PATHS))

    def test_remote_failure_only_exports_controlled_codes_and_trusted_frames(self):
        plan = {'mode': 'parent', 'controlSources': {'online-execution-release.py': 'a' * 64}}
        secret = 'synthetic credential and arbitrary private exception message'
        try:
            raise RuntimeError(secret)
        except RuntimeError as error:
            report = P.failure_report(error, plan)
        self.assertEqual(report['code'], 'ONLINE_EXECUTION_REMOTE_FAILED')
        self.assertNotIn(secret, json.dumps(report))
        self.assertNotIn(str(P.ROOT), json.dumps(report))
        self.assertEqual(report['frames'], [])
        try:
            P.need(False, 'SYNTHETIC_CONTROL_FAILURE')
        except RuntimeError as error:
            report = P.failure_report(error, plan)
        self.assertEqual(report['code'], 'ONLINE_EXECUTION_SYNTHETIC_CONTROL_FAILURE')
        self.assertEqual(report['frames'][-1]['file'], 'online-execution-release.py')
        self.assertEqual(report['frames'][-1]['function'], 'need')
        self.assertEqual(report['businessActions'], 0)

    def test_payload_rejects_extra_or_modified_file(self):
        h = P.load('recharge-record-release.py')
        with tempfile.TemporaryDirectory(dir=HERE.parents[1] / '.runtime') as folder:
            payload = Path(folder)
            sources = self.c['productionSources']
            for name in sources:
                target = payload / 'source' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((P.ROOT / name).read_bytes())
                if name.startswith(P.ENGINE):
                    target = payload / 'online-recharge/source' / name.removeprefix(P.ENGINE)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes((P.ROOT / name).read_bytes())
            api = {}
            for name in P.MODULES:
                target = payload / 'api/modules' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('synthetic fixture ' + name)
                api[name] = P.sha(target.read_bytes())
            parent = {'status': 'ONLINE_EXECUTION_PARENT_VERIFIED', 'commit': P.CURRENT,
                      'baseline': {'apiModules': self.c['nativeParentApiModules']}, 'businessActions': 0}
            quality = {'sources': {'commit': P.SOURCE_HEAD, 'runId': P.SOURCE_RUN,
                                  'pullRequest': 673, 'sourceReceiptSha256': 'c' * 64},
                       'controls': {'commit': 'a' * 40, 'runId': '4',
                                    'pullRequest': 674, 'sourceReceiptSha256': 'd' * 64},
                       'release': {'commit': 'b' * 40, 'runId': '2'}}
            proof = {'commit': 'b' * 40, 'tree': 'd' * 40, 'workflowRunId': '3', 'workflowRunAttempt': '1',
                'contractSha256': P.sha((HERE / P.CONTRACT_FILE).read_bytes()), 'scope': P.SCOPE, 'recipe': P.RECIPE,
                'qualityVerification': quality, 'nativeParentCapture': parent, 'apiModules': api,
                'parentModulesReproduced': self.c['buildParentApiModules'],
                'parentNativeModules': self.c['nativeParentApiModules'], 'productionSources': sources, 'controlSources': self.c['controlPins'],
                'businessActions': 0, 'migrationPerformed': False,
                'baselineSharedUnchanged': True, 'baselineClientUnchanged': True, 'files': h.file_inventory(payload)}
            P.verify_proof(proof, proof, self.c, payload, h)
            (payload / 'extra').write_text('unexpected')
            with self.assertRaises(RuntimeError):
                P.verify_proof(proof, proof, self.c, payload, h)

    def test_engine_image_copy_is_separate_and_admin_is_rejected(self):
        p = P.engine(self.c, {})
        h, _driver, _retired = p.helpers()
        class Driver:
            def __init__(self):
                self.calls = []
            def run(self, *args, **kwargs):
                self.calls.append(args)
                return ''
        with tempfile.TemporaryDirectory(dir=P.ROOT / '.runtime') as folder:
            stage = Path(folder)
            context = stage / 'engine'
            context.mkdir()
            (context / 'Dockerfile').write_text('FROM synthetic-parent\nCOPY html/ /usr/share/nginx/html/\n')
            driver = Driver()
            h.build_image(driver, context, 'synthetic-reference', 'online-recharge',
                          {'image': 'synthetic-image', 'reference': 'synthetic-parent'}, stage)
            self.assertEqual((context / 'Dockerfile').read_text(),
                             'FROM synthetic-parent\nCOPY source/ /workspace/engine/\n')
            self.assertEqual(len(driver.calls), 1)
            self.assertEqual(driver.calls[0][:2], ('docker', 'build'))
            with self.assertRaises(RuntimeError):
                h.build_image(driver, context, 'synthetic-reference', 'admin', {}, stage)

    def test_role_projections_are_written_before_the_atomic_pointer_switch(self):
        commit = 'b' * 40
        p = P.engine(self.c, {'commit': commit})
        _helper, driver, _retired = p.helpers()
        with tempfile.TemporaryDirectory(dir=P.ROOT / '.runtime') as folder:
            base = Path(folder)
            target = base / 'release'
            target.mkdir()
            driver.BASE = base
            manifest = {'scope': P.SCOPE,
                'roleSourceProjections': {
                    'api': {'sources': self.c['productionSources']},
                    'online-recharge': {'commit': commit, 'sources': {}}},
                'bitbrowserHistoryPublication': {'status': 'synthetic'},
                'apiCompiledArtifact': {'sha256': 'a' * 64}}
            (target / 'release-manifest.json').write_text(json.dumps(manifest))
            driver.point_current(target, 'synthetic-fixture')
            actual = json.loads((target / 'release-manifest.json').read_bytes())
            self.assertEqual((base / 'current').resolve(), target)
            self.assertEqual(actual['roleSourceProjections']['api']['sources'],
                             {P.WORKER: self.c['productionSources'][P.WORKER]})
            self.assertEqual(actual['roleSourceProjections']['online-recharge']['sources'],
                             {n: v for n, v in self.c['productionSources'].items() if n.startswith(P.ENGINE)})
            self.assertEqual(actual['onlineExecutionPublication'], {'status': 'synthetic'})

    def test_existing_protection_engine_is_retained(self):
        p = P.engine(self.c, {})
        source = (HERE / 'bitbrowser-history-release.py').read_text()
        for token in ('acquire_release_lock', 'fresh_scoped_backup', 'sql_fence_class',
                      'NEEDS_FORWARD_DIAGNOSIS', 'BASE_LAYERS_CHANGED'):
            self.assertIn(token, source + (HERE / 'proxy-result-identity-release.py').read_text())
        self.assertEqual(p.UPDATED, ('api', 'online-recharge'))
        self.assertEqual(set(p.PRESERVED), {'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge'})

    def test_workflow_is_main_only_and_serial(self):
        workflow = (P.ROOT / '.github/workflows/online-execution-publication.yml').read_text()
        self.assertIn('group: id-business-v2-production-release', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertEqual(workflow.count("github.ref == 'refs/heads/main' && inputs.commit == github.sha"), 2)
        self.assertIn('online_recharge_test_execution', workflow)
        self.assertIn('ONLINE_RECHARGE_MYSQL_TEST', workflow)
        self.assertIn('needs: validate', workflow)


if __name__ == '__main__':
    unittest.main()
