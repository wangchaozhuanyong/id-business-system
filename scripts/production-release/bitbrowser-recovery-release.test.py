"""Negative controls for the independent, finite payment recovery successor."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('recovery_release_test', HERE / 'bitbrowser-recovery-release.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def fixture_contract():
    """Synthetic control fixture; no production evidence is generated here."""
    old = json.loads((HERE / 'bitbrowser-billing-contract.json').read_bytes())
    candidates = [name for name in old['sources'] if name.startswith(
        'apps/admin/src/v2/features/auto-recharge/')]
    sources = {name: 'a' * 64 for name in sorted(p.API_SOURCES)}
    sources.update({name: 'a' * 64 for name in (
        'packages/shared/src/v2/auto-recharge.ts',
        'packages/shared/src/v2/checkout-diagnostic.ts', 'docs/V2_TASKS.md',
        'apps/api/src/id-business-v2/auto-recharge/recharge-availability.mysql.integration.spec.ts')})
    for name in candidates:
        if len(sources) == 45:
            break
        sources[name] = 'a' * 64
    c = {**old, 'scope': p.SCOPE, 'expectedCurrent': p.CURRENT, 'reviewBase': p.SOURCE_BASE,
        'sourceReviewCommit': 'b' * 40, 'sources': sources,
        'apiModules': sorted(name.removeprefix('apps/api/src/').removesuffix('.ts') + suffix
            for name in p.API_SOURCES for suffix in ('.js', '.d.ts', '.js.map')) + sorted(p.DECLARATIONS),
        'declarationOutputs': copy.deepcopy(p.DECLARATIONS),
        'sharedFiles': sorted(p.SHARED), 'controlPins': {name: 'c' * 64 for name in p.CONTROLS},
        'predecessorProofSha256': p.PREDECESSOR_PROOF,
        'mysqlTestSources': {name: sources.get(name, 'd' * 64) for name in p.MYSQL_FILES}}
    c['controlPins']['bitbrowser-billing-contract.json'] = p.PREDECESSOR_CONTRACT
    c['baseline'] = {**old['baseline'], 'commit': p.CURRENT,
        'current': '/opt/id-business-v2/releases/20261018T125500Z-' + p.CURRENT[:12] + '-recharge-checkout',
        'proofs': {'recharge-checkout-build-proof.json': p.PREDECESSOR_PROOF},
        'apiBaselineFiles': {**{'apps/api/dist/' + name: 'e' * 64 for name in c['apiModules']},
            **{'packages/shared/dist/' + name: 'e' * 64 for name in p.SHARED}}}
    c['baseline']['apiBaselineFiles'].update({'apps/api/dist/' + n: pin['runtimeBefore']
        for n, pin in p.DECLARATIONS.items()})
    return c


class FiniteRecoveryControls(unittest.TestCase):
    def setUp(self):
        path = HERE / p.CONTRACT_FILE
        self.c = json.loads(path.read_bytes()) if path.is_file() else fixture_contract()

    def mysql(self, identity):
        return {**identity, 'scope': 'OWNED_EMPTY_DATABASE', 'runtime': 'github-actions-mysql-service',
            'testFiles': self.c['mysqlTestSources'], 'testsTotal': 18, 'testsPassed': 18,
            'testsSkipped': 0, 'testsTodo': 0, 'productionActions': 0, 'reportSha256': 'd' * 64}

    def test_frozen_scope_and_component_boundaries(self):
        p.validate_contract(self.c)
        self.assertEqual(p.CURRENT, '5b51148154339b9695fea846eb59ce1ee45fbfff')
        self.assertEqual(p.CURRENT, p.SOURCE_BASE)
        self.assertEqual(p.CURRENT, p.PUBLISHED_BUILD)
        self.assertEqual(len(p.API_SOURCES), 13)
        self.assertEqual(len(self.c['sources']), 45)
        self.assertEqual(len(self.c['apiModules']), 40)
        self.assertEqual(len(self.c['baseline']['apiBaselineFiles']), 46)
        self.assertEqual(p.PRESERVED, ('mysql', 'caddy', 'media-resolver', 'auto-recharge'))
        self.assertNotIn('online-recharge', p.PRESERVED)
        self.assertNotIn('auto-registration', p.SERVICES)

    def test_old_contract_is_an_immutable_dependency(self):
        self.assertEqual(p.sha((HERE / 'bitbrowser-billing-contract.json').read_bytes()),
            p.PREDECESSOR_CONTRACT)
        changed = copy.deepcopy(self.c)
        changed['controlPins']['bitbrowser-billing-contract.json'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'CONTROL_SCOPE'):
            p.validate_contract(changed)

    def test_wrong_predecessor_or_original_proof_rejected(self):
        for mutate in (
            lambda c: c.update(expectedCurrent='a' * 40),
            lambda c: c.update(reviewBase='a' * 40),
            lambda c: c.update(predecessorProofSha256='a' * 64),
            lambda c: c['baseline']['proofs'].update({'recharge-checkout-build-proof.json': 'a' * 64})):
            changed = copy.deepcopy(self.c)
            mutate(changed)
            with self.assertRaises(RuntimeError):
                p.validate_contract(changed)

    def test_unreviewed_source_schema_dependency_and_engine_rejected(self):
        for name in ('apps/api/prisma-mysql/schema.prisma', 'package-lock.json',
            'apps/api/src/id-business-v2/online-recharge/tasks.service.ts',
            'apps/admin/src/v2/features/registry.ts', '../escape'):
            changed = copy.deepcopy(self.c)
            changed['sources'][name] = 'a' * 64
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE'):
                p.validate_contract(changed)

    def test_production_api_and_shared_output_sets_are_closed(self):
        for field, value in (('apiModules', 'id-business-v2/accounts/accounts.service.js'),
            ('sharedFiles', 'v2/accounts.js')):
            changed = copy.deepcopy(self.c)
            changed[field].append(value)
            with self.assertRaisesRegex(RuntimeError, 'OUTPUT_SCOPE'):
                p.validate_contract(changed)
        changed = copy.deepcopy(self.c)
        changed['apiModules'].pop()
        with self.assertRaisesRegex(RuntimeError, 'OUTPUT_SCOPE'):
            p.validate_contract(changed)

    def test_baseline_must_pin_39_api_one_derived_declaration_and_six_shared_outputs(self):
        for action in ('missing', 'extra', 'invalid'):
            changed = copy.deepcopy(self.c)
            if action == 'missing':
                changed['baseline']['apiBaselineFiles'].pop(next(iter(changed['baseline']['apiBaselineFiles'])))
            elif action == 'extra':
                changed['baseline']['apiBaselineFiles']['apps/api/dist/unrelated.js'] = 'a' * 64
            else:
                changed['baseline']['apiBaselineFiles'][next(iter(changed['baseline']['apiBaselineFiles']))] = 'wrong'
            with self.assertRaisesRegex(RuntimeError, 'BASELINE'):
                p.validate_contract(changed)

    def test_derived_declaration_hashes_cannot_be_widened_or_changed(self):
        for update in ({'id-business-v2/other.d.ts': {'before': 'a' * 64, 'after': 'b' * 64}},
            {name: {**pin, 'after': 'f' * 64} for name, pin in p.DECLARATIONS.items()}):
            changed = copy.deepcopy(self.c)
            changed['declarationOutputs'] = update
            with self.assertRaisesRegex(RuntimeError, 'OUTPUT_SCOPE'):
                p.validate_contract(changed)
        changed = copy.deepcopy(self.c)
        name = next(iter(p.DECLARATIONS))
        changed['baseline']['apiBaselineFiles']['apps/api/dist/' + name] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'BASELINE'):
            p.validate_contract(changed)

    def test_compiled_delta_accepts_only_the_exact_derived_declaration(self):
        spec = importlib.util.spec_from_file_location('recovery_delta_build', HERE / 'bitbrowser-recovery-build.py')
        build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build)
        before = {n: pin['before'] for n, pin in p.DECLARATIONS.items()}
        after = {n: pin['after'] for n, pin in p.DECLARATIONS.items()}
        build.verify_api_delta(before, after, self.c)
        for name in ('unreviewed.d.ts', 'unreviewed.js'):
            with self.assertRaisesRegex(RuntimeError, 'UNSELECTED_API_OUTPUT_CHANGED'):
                build.verify_api_delta(before, {**after, name: 'a' * 64}, self.c)
        for side in ('before', 'after'):
            changed_before, changed_after = copy.deepcopy(before), copy.deepcopy(after)
            (changed_before if side == 'before' else changed_after)[next(iter(p.DECLARATIONS))] = 'f' * 64
            with self.assertRaisesRegex(RuntimeError, 'DECLARATION_PROJECTION_CHANGED'):
                build.verify_api_delta(changed_before, changed_after, self.c)

    def test_control_and_ci_file_sets_are_closed(self):
        for field in ('controlPins', 'ciControlPins'):
            for action in ('missing', 'extra'):
                changed = copy.deepcopy(self.c)
                if action == 'missing':
                    changed[field].pop(next(iter(changed[field])))
                else:
                    changed[field]['unknown.py'] = 'a' * 64
                with self.assertRaisesRegex(RuntimeError, 'CONTROL_SCOPE'):
                    p.validate_contract(changed)

    def test_mysql_sources_are_separate_from_reviewed_business_diff(self):
        direct = 'apps/api/src/id-business-v2/auto-recharge/recharge-direct-payment.mysql.integration.spec.ts'
        self.assertIn(direct, self.c['mysqlTestSources'])
        self.assertNotIn(direct, self.c['sources'])
        p.validate_contract(self.c)
        for action in ('missing', 'extra', 'changed_shared_source'):
            changed = copy.deepcopy(self.c)
            if action == 'missing':
                changed['mysqlTestSources'].pop(direct)
            elif action == 'extra':
                changed['mysqlTestSources']['apps/api/src/unknown.spec.ts'] = 'a' * 64
            else:
                available = 'apps/api/src/id-business-v2/auto-recharge/recharge-availability.mysql.integration.spec.ts'
                changed['mysqlTestSources'][available] = '0' * 64
            with self.assertRaisesRegex(RuntimeError, 'MYSQL_SOURCE_SCOPE'):
                p.validate_contract(changed)

    def test_service_retirement_health_and_write_guards(self):
        for action in ('missing', 'unhealthy', 'retired', 'writes', 'migration', 'business'):
            changed = copy.deepcopy(self.c)
            if action == 'missing':
                changed['baseline']['services'].pop('mysql')
            elif action == 'unhealthy':
                changed['baseline']['services']['api']['health'] = 'starting'
            elif action == 'retired':
                changed['baseline']['services']['auto-registration'] = {}
            elif action == 'writes':
                changed['baseline']['databaseWrites'] = 1
            elif action == 'migration':
                changed['migrationPerformed'] = True
            else:
                changed['businessActions'] = 1
            with self.assertRaises(RuntimeError):
                p.validate_contract(changed)

    def test_mysql_proof_requires_18_real_tests_same_native_identity(self):
        identity = {'commit': 'b' * 40, 'tree': 'c' * 40, 'workflowRunId': '12', 'workflowRunAttempt': '1'}
        value = self.mysql(identity)
        p.verify_mysql(value, identity, self.c)
        for name, replacement in (('testsSkipped', 1), ('testsPassed', 17), ('testsTotal', 13),
            ('productionActions', 1), ('commit', 'e' * 40), ('testFiles', {}), ('testsSkipped', False)):
            with self.assertRaisesRegex(RuntimeError, 'MYSQL_EVIDENCE'):
                p.verify_mysql({**value, name: replacement}, identity, self.c)

    def test_payload_cannot_add_unreviewed_modules_or_source(self):
        identity = {'commit': 'b' * 40, 'tree': 'c' * 40, 'workflowRunId': '12', 'workflowRunAttempt': '1'}
        proof = {**identity, 'scope': p.SCOPE, 'contractSha256': 'e' * 64,
            'sources': self.c['sources'], 'controlSources': self.c['controlPins'],
            'migrationPerformed': False, 'businessActions': 0,
            'baselineRuntimeReproduced': True, 'baselineAdminReproduced': True,
            'predecessorProofSha256': self.c['predecessorProofSha256'], 'qualityVerification': {},
            'isolatedMysqlVerification': self.mysql(identity),
            'apiModules': {name: 'a' * 64 for name in self.c['apiModules']},
            'sharedFiles': {name: 'b' * 64 for name in p.SHARED},
            'adminFiles': {'index.html': 'c' * 64}, 'files': {}}
        proof['apiModules'].update({n: pin['after'] for n, pin in p.DECLARATIONS.items()})
        class Helper:
            @staticmethod
            def file_inventory(_path):
                return {'api/modules/other.js': 'a' * 64}
        with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_CHANGED'):
            p.verify_proof(proof, proof, self.c, HERE, Helper)

    def test_release_retains_existing_switch_guard_and_readback_path(self):
        text = (HERE / 'bitbrowser-recovery-release.py').read_text()
        self.assertNotIn('migrate deploy', text)
        self.assertNotIn('docker prune', text)
        self.assertIn('retired.retired_guards', text)
        self.assertIn('runtime_receipt', text)
        self.assertIn('check_hashes', text)
        self.assertIn("p.release(plan, legacy, d, h)", text)


if __name__ == '__main__':
    unittest.main()
