"""Offline counterexamples for provenance, finite overlays and one accepted command."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import types

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location('test_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('financial-closure-release.py')
B = load('financial-closure-publication.py')


class FinancialPublicationTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())

    def test_frozen_business_and_control_inputs(self):
        B.check(self.c)
        self.assertEqual(len(self.c['productionSources']), 8)
        self.assertEqual(len(self.c['parentApiModules']), 5)
        self.assertEqual(len(self.c['apiModules']), 8)

    def test_native_predecessor_projection_is_exact_and_separate_from_billing(self):
        published = json.loads((HERE / P.PARENT_FILE).read_bytes())
        parent = json.loads((HERE / 'bitbrowser-manual-contract.json').read_bytes())
        self.assertEqual(published['commit'], P.CURRENT)
        self.assertEqual(len(published['productionSources']), 43)
        self.assertEqual(published['productionSources'], parent['productionSources'])
        self.assertFalse(set(published['productionSources']) & P.SOURCES)
        self.assertFalse(set(published['apiModules']) & P.MODULES)
        self.assertEqual(published['adminFiles']['index.html'], self.c['parentAdminIndexSha256'])

    def test_extra_sources_modules_roles_and_database_writes_are_rejected(self):
        cases = [
            lambda c: c['productionSources'].update({'apps/api/src/auth/changed.ts': 'a' * 64}),
            lambda c: c['productionSources'].pop(next(iter(c['productionSources']))),
            lambda c: c['apiModules'].append('id-business-v2/auto-recharge/executor.js'),
            lambda c: c['parentApiModules'].update({'unrelated.js': 'a' * 64}),
            lambda c: c.update(updatedServices=['api', 'admin', 'mysql']),
            lambda c: c.update(reboundServices=['online-recharge', 'auto-recharge']),
            lambda c: c.update(migrationPerformed=True),
            lambda c: c.update(businessActions=1),
            lambda c: c.update(expectedCurrent='a' * 40),
            lambda c: c.update(sourceReviewCommit='b' * 40),
            lambda c: c.update(sqlFenceHelperSha256='c' * 64)
        ]
        for mutate in cases:
            with self.subTest(mutate=mutate):
                c = copy.deepcopy(self.c)
                mutate(c)
                with self.assertRaises(RuntimeError):
                    P.validate_contract(c)

    def test_existing_engine_retains_activation_and_smoke_implementations(self):
        p = P.engine(self.c)
        self.assertEqual(p.UPDATED, ('api', 'admin'))
        self.assertEqual(p.REBOUND, ('online-recharge',))
        self.assertEqual(p.PRESERVED, ('mysql', 'caddy', 'media-resolver', 'auto-recharge'))
        self.assertTrue(p.release.__code__.co_filename.endswith('bitbrowser-history-release.py'))
        self.assertTrue(p.activate_services.__code__.co_filename.endswith('bitbrowser-history-release.py'))
        self.assertTrue(p.smoke.__code__.co_filename.endswith('bitbrowser-history-release.py'))
        self.assertEqual(p.MODULES, P.MODULES)

    def test_native_capture_required_and_bound_to_parent(self):
        p = P.engine(self.c)
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_PARENT_REQUIRED'):
            p.bounded_runtime_contract(None, None, self.c, {})
        baseline = {'commit': P.CURRENT, 'manifestSha256': self.c['parentManifestSha256'],
                    'apiModules': self.c['parentApiModules'], 'database': self.c['parentDatabase']}
        capture = {'status': 'FINANCIAL_NATIVE_PARENT_VERIFIED', 'businessActions': 0,
                   'databaseWrites': 0, 'baseline': baseline}
        self.assertEqual(p.bounded_runtime_contract(None, None, self.c,
                         {'nativeParentCapture': capture})['baseline'], baseline)
        capture['baseline']['manifestSha256'] = 'a' * 64
        with self.assertRaisesRegex(RuntimeError, 'PARENT_CAPTURE_CHANGED'):
            p.bounded_runtime_contract(None, None, self.c, {'nativeParentCapture': capture})

    def test_parent_and_preflight_do_not_activate_services(self):
        p = P.engine(self.c)
        (P.ROOT / '.runtime').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=P.ROOT / '.runtime') as temporary:
            root = Path(temporary)
            current = root / 'published'
            current.mkdir()
            for name in ('release-manifest.json', '.env.aws.production', 'compose.release.json',
                         'docker-compose.aws-mysql.yml'):
                (current / name).write_text('{}\n')
            baseline = {'commit': P.CURRENT, 'current': str(current),
                'manifestSha256': self.c['parentManifestSha256'], 'apiModules': self.c['parentApiModules'],
                'database': self.c['parentDatabase'], 'services': {}}
            capture = {'status': 'FINANCIAL_NATIVE_PARENT_VERIFIED', 'businessActions': 0,
                       'databaseWrites': 0, 'baseline': baseline}
            plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1',
                'recipe': P.RECIPE, 'contractSha256': P.sha((HERE / P.CONTRACT_FILE).read_bytes()),
                'controlSources': {**self.c['controlPins'], P.CONTRACT_FILE: P.sha((HERE / P.CONTRACT_FILE).read_bytes())}}
            p.BASE = root
            with patch.object(P, 'observe', return_value=capture), \
                 patch.object(p, 'activate_services') as activate, \
                 patch.object(p, 'helpers', return_value=(None, None, None)):
                self.assertEqual(p.release({**plan, 'mode': 'parent'}, self.c), capture)
                result = p.release({**plan, 'mode': 'preflight', 'nativeParentCapture': capture}, self.c)
                self.assertEqual(result['status'], 'BITBROWSER_HISTORY_PREFLIGHT_VERIFIED')
                self.assertEqual(result['runtimeBaseline']['verifiedBaseline'], baseline)
                self.assertEqual(result['runtimeBaseline']['entryParentSealSha256'], P.sha(P.canonical(baseline)))
                activate.assert_not_called()

    def proof(self):
        c = self.c
        modules = {n: '1' * 64 for n in P.MODULES}
        admin = {'index.html': '2' * 64, **{'assets/fixture' + str(i) + '.js': '3' * 64 for i in range(249)}}
        mysql = {'testedCommit': c['validation']['commit'], 'runId': c['validation']['runId'],
            'testsPassed': 53, 'testsSkipped': 0, 'testsFailed': 0, 'interfaceCasesPassed': 112,
            'mysqlReportSha256': '4' * 64, 'interfaceReportSha256': '5' * 64}
        files = {**{'api/modules/' + n: v for n, v in modules.items()},
            **{'admin/html/' + n: v for n, v in admin.items()},
            **{'source/' + n: v for n, v in c['productionSources'].items()}}
        return {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1',
            'contractSha256': '6' * 64, 'qualityVerification': {}, 'isolatedMysqlVerification': mysql,
            'nativeParentCapture': {}, 'scope': P.SCOPE, 'recipe': P.RECIPE,
            'productionIntegrityBefore': self.integrity(),
            'productionSources': c['productionSources'], 'controlSources': c['controlPins'],
            'businessActions': 0, 'migrationPerformed': False, 'apiModules': modules,
            'parentModulesReproduced': c['parentApiModules'], 'baselineSharedUnchanged': True,
            'baselineClientUnchanged': True, 'baselineAdminIndexSha256': c['parentAdminIndexSha256'],
            'projectedInterfaceCasesPassed': 112, 'adminFiles': admin, 'files': files}

    def integrity(self):
        c = self.c
        report = {'status': 'FINANCIAL_READONLY_OBSERVED', 'productionWrites': 0,
            'identity': {'commit': P.CURRENT, 'manifestSha256': c['parentManifestSha256'],
                'apiBillingSha256': c['parentApiModules']['id-business-v2/online-recharge/persistence/admin.repository.js'],
                'adminIndexSha256': c['parentAdminIndexSha256'],
                'services': {n: {'image': v, 'status': 'running', 'health': 'healthy'}
                    for n, v in c['parentImages'].items()}},
            'audit': {'status': 'AUDITED', 'verifiedReadOnlyAccount': True, 'databaseWrites': 0,
                'checks': [{**rule, 'count': 0} for rule in c['productionAuditRules']]}}
        return {'report': report, 'reportSha256': P.sha(P.canonical(report)),
                'commandId': '12345678-1234-1234-1234-123456789abc', 'invocationSha256': '1' * 64}

    def test_production_findings_and_unavailable_audit_block_before_publication(self):
        P.verify_production_integrity(self.integrity(), self.c)
        cases = [
            lambda r: r['audit'].update(status='AUDIT_UNAVAILABLE'),
            lambda r: r['audit'].update(verifiedReadOnlyAccount=False),
            lambda r: r['audit'].update(databaseWrites=1),
            lambda r: r['audit']['checks'].pop(),
            lambda r: r['audit']['checks'][0].update(count=1),
            lambda r: r['audit']['checks'][0].update(count='0'),
            lambda r: r['audit']['checks'][0].update(code='unknown'),
            lambda r: r['identity'].update(commit='b' * 40)
        ]
        for mutate in cases:
            with self.subTest(mutate=mutate):
                value = self.integrity()
                mutate(value['report'])
                value['reportSha256'] = P.sha(P.canonical(value['report']))
                with self.assertRaises(RuntimeError):
                    P.verify_production_integrity(value, self.c)

    def test_nonzero_warning_is_preserved_for_explicit_review(self):
        value = self.integrity()
        warnings = [r for r in value['report']['audit']['checks'] if r['severity'] == 'warning']
        self.assertTrue(warnings)
        warnings[0]['count'] = 2
        value['reportSha256'] = P.sha(P.canonical(value['report']))
        P.verify_production_integrity(value, self.c)
        self.assertEqual(warnings[0]['count'], 2)

    def test_payload_is_exact_finite_file_set(self):
        proof = self.proof()
        helper = types.SimpleNamespace(file_inventory=lambda _: dict(proof['files']))
        self.assertEqual(P.verify_proof(proof, proof, self.c, None, helper), proof)
        for name in ('api/modules/auth.js', 'source/package-lock.json', 'admin/html/unknown.js'):
            with self.subTest(name=name):
                helper = types.SimpleNamespace(file_inventory=lambda _: {**proof['files'], name: 'a' * 64})
                with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_CHANGED'):
                    P.verify_proof(proof, proof, self.c, None, helper)

    def test_mysql_skips_wrong_commit_or_reduced_interface_are_not_accepted(self):
        for field, value in (('testsSkipped', 1), ('testsFailed', 1), ('testsPassed', 52),
                             ('interfaceCasesPassed', 111), ('testedCommit', 'a' * 40)):
            with self.subTest(field=field):
                proof = self.proof()
                proof['isolatedMysqlVerification'][field] = value
                with self.assertRaisesRegex(RuntimeError, 'ISOLATED_ACCEPTANCE_CHANGED'):
                    P.verify_mysql(proof['isolatedMysqlVerification'], proof, self.c)

    def test_local_or_non_main_execution_stops_before_aws(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(B, 'execute') as execute:
            with self.assertRaisesRegex(RuntimeError, 'MAIN_ONLY'):
                B.native_identity()
            execute.assert_not_called()

    def test_quality_receipt_requires_exact_repository_source_event_and_success(self):
        run = {'head_sha': 'a' * 40, 'path': '.github/workflows/quality.yml',
               'repository': {'full_name': B.REPO}, 'status': 'completed',
               'conclusion': 'success', 'event': 'pull_request'}
        B.require_run(run, 'a' * 40, run['path'], 'pull_request')
        for field, value in (('head_sha', 'b' * 40), ('conclusion', 'failure'),
                             ('status', 'in_progress'), ('event', 'workflow_dispatch'),
                             ('path', '.github/workflows/other.yml'),
                             ('repository', {'full_name': 'different/repository'})):
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'QUALITY_REQUIRED'):
                B.require_run({**run, field: value}, 'a' * 40, run['path'], 'pull_request')

    def test_build_lock_patch_reproduces_the_reviewed_security_patch_only(self):
        (P.ROOT / '.runtime').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=P.ROOT / '.runtime') as temporary:
            context = Path(temporary)
            target = context / 'package-lock.json'
            parent = B.git('show', self.c['buildDependencyPatch']['parentCommit'] + ':package-lock.json')
            target.write_bytes(parent)
            B.patch_build_lock(context, self.c)
            self.assertEqual(target.read_bytes(), (P.ROOT / 'package-lock.json').read_bytes())
            target.write_bytes(parent + b' ')
            with self.assertRaisesRegex(RuntimeError, 'BUILD_LOCK_PARENT_CHANGED'):
                B.patch_build_lock(context, self.c)

    def test_uncertain_acceptance_is_persisted_and_never_resent(self):
        (P.ROOT / '.runtime').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=P.ROOT / '.runtime') as temporary:
            out = Path(temporary)
            response = types.SimpleNamespace(returncode=1, stdout=b'')
            with patch.object(B.subprocess, 'run', return_value=response) as run:
                with self.assertRaisesRegex(RuntimeError, 'COMMAND_ACCEPTANCE_UNCERTAIN'):
                    B.transport({'commit': 'a' * 40, 'workflowRunId': '123'}, 'release', out)
                self.assertTrue((out / 'release-intent.json').is_file())
                with self.assertRaisesRegex(RuntimeError, 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                    B.transport({'commit': 'a' * 40, 'workflowRunId': '123'}, 'release', out)
                self.assertEqual(run.call_count, 1)

    def test_workflow_retains_main_identity_single_release_and_original_receipts(self):
        source = (P.ROOT / B.WORKFLOW).read_text()
        for expected in ("github.ref == 'refs/heads/main'", 'inputs.commit == github.sha',
                         'group: id-business-v2-production-release', 'cancel-in-progress: false',
                         'needs: validate', 'financial-closure-publication.py publish',
                         'financial-closure-publication.py build', 'id-token: write'):
            self.assertIn(expected, source)
        self.assertNotIn('continue-on-error', source)
        self.assertNotIn('prisma:mysql:migrate:deploy', source)


if __name__ == '__main__':
    unittest.main()
