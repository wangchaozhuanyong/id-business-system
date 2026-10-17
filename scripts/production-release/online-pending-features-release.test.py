"""Offline source, artifact, Quality coverage and inherited switch boundaries."""
import copy
import ast
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('pending_release_tests', HERE / 'online-pending-features-release.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
spec = importlib.util.spec_from_file_location('pending_build_tests', HERE / 'online-pending-features-build.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


def fixture():
    c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())
    c['baseline'] = {
        'commit': p.SOURCE_BASE, 'current': '/opt/id-business-v2/releases/synthetic-only', 'manifestSha256': 'a' * 64,
        'services': {role: {'containerId': 'synthetic-' + role} for role in p.SERVICES},
        'runtimeConfigurationSha256': {role: 'b' * 64 for role in p.SERVICES},
        'configurationSha256': {name: 'c' * 64 for name in ('.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml')},
        'engineFiles': c['beforeEngineFiles'], 'engineHealth': p.HEALTH,
        'apiOnlineFiles': {'persistence/admin.repository.js': 'd' * 64},
        'adminBuiltFiles': {'index.html': 'e' * 64}, 'adminFiles': {'index.html': 'e' * 64, 'assets/retained.js': 'f' * 64},
        'adminIndexSha256': 'e' * 64, 'nginxSha256': '1' * 64,
        'adminBuildProofSha256': '62ed7d268d395aefc34aebf53fa1131f89bf32f5b5511d2a0bdbcaa7bf3e4814',
        'backupNormalizerPath': '/opt/id-business-v2/releases/synthetic/scripts/normalizer.sed',
        'backupNormalizerSha256': 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202',
        'freeBytes': 12 * 1024**3, 'engineNetworkMode': 'container:synthetic-api'}
    return c


def proof_fixture(c):
    quality = {'kind': 'EXACT_MAIN_SUCCESS', 'runId': '123', 'runAttempt': 1, 'testedTree': 'b' * 40, 'commit': 'a' * 40}
    modules = {**{name.removesuffix('.js') + suffix: 'a' * 64 for name in c['apiModules'] for suffix in ('.js', '.js.map', '.d.ts')},
               **c['apiDeclarationOnly']}
    files = {**{'source/' + name: digest for name, digest in c['sources'].items()},
        **{'api/modules/' + name: digest for name, digest in modules.items()},
        **{'engine/' + name: c['afterEngineFiles'][name] for name in p.FILES}, 'admin/html/index.html': 'b' * 64}
    return {'version': 1, 'scope': p.SCOPE, 'commit': 'a' * 40, 'tree': 'b' * 40,
        'workflowRunId': '456', 'workflowRunAttempt': '1', 'contractSha256': 'c' * 64,
        'controlSources': c['controlPins'], 'sources': c['sources'], 'afterEngineFiles': c['afterEngineFiles'],
        'qualitySourceEvidence': quality,
        'baselineReproduction': {'api': {}, 'admin': {}, 'adminArtifact': None, 'candidateDeclarations': {}},
        'qualityPartEvidence': {'runId': '123', 'runAttempt': 1, 'testedTree': 'b' * 40,
            'parts': list(p.QUALITY_PARTS), 'jobs': {part: index + 1 for index, part in enumerate(p.QUALITY_PARTS)}},
        'baselineAdminFiles': c['baseline']['adminBuiltFiles'], 'adminFiles': {'index.html': 'b' * 64},
        'beforeApiOnlineFiles': c['baseline']['apiOnlineFiles'], 'apiModules': modules,
        'baselineApiReproduced': True, 'baselineAdminSourceReproduced': True,
        'updatedServices': list(p.UPDATED), 'preservedServices': list(p.PRESERVED),
        'workflow': p.WORKFLOW, 'workflowSha256': c['workflowSha256'],
        'migrationPerformed': False, 'businessActions': 0, 'files': files}


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.c = fixture()

    def test_exact_four_features_and_three_roles(self):
        p.validate_contract(self.c)
        self.assertEqual(len(p.APPLICATION), 26)
        self.assertEqual(set(p.UPDATED), {'api', 'admin', 'online-recharge'})
        self.assertEqual(set(p.PRESERVED), {'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'})
        self.assertEqual(len(p.FILES), 4)
        self.assertEqual(len(self.c['afterEngineFiles']), 102)
        self.assertEqual(len(set(self.c['beforeEngineFiles']) - p.FILES), 98)

    def test_unbound_baseline_is_local_only(self):
        self.c['baseline'] = None
        p.validate_contract(self.c, require_baseline=False)
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_NOT_BOUND'):
            p.validate_contract(self.c)

    def test_source_review_is_actual_and_cannot_be_substituted(self):
        self.c['sourceReviewCommit'] = 'a' * 40
        with self.assertRaisesRegex(RuntimeError, 'REVIEW_COMMIT_CHANGED'):
            p.validate_contract(self.c)

    def test_missing_or_extra_business_source_rejected(self):
        for kind in ('missing', 'extra'):
            c = copy.deepcopy(self.c)
            if kind == 'missing':
                c['sources'].pop(next(iter(c['sources'])))
            else:
                c['sources']['apps/admin/src/v2/unrelated.vue'] = 'a' * 64
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE_CHANGED'):
                p.validate_contract(c)

    def test_undeclared_engine_change_or_removal_rejected(self):
        for kind in ('change', 'remove', 'add'):
            c = copy.deepcopy(self.c)
            if kind == 'change':
                c['afterEngineFiles']['worker.cjs'] = 'a' * 64
            elif kind == 'remove':
                del c['afterEngineFiles']['worker.cjs']
            else:
                c['afterEngineFiles']['unknown.cjs'] = 'a' * 64
            with self.assertRaisesRegex(RuntimeError, 'ENGINE_SCOPE_CHANGED'):
                p.validate_contract(c)

    def test_arbitrary_api_javascript_is_not_admitted(self):
        self.c['apiModules'].append('auth/credentials.js')
        with self.assertRaisesRegex(RuntimeError, 'API_SCOPE_CHANGED'):
            p.validate_contract(self.c)

    def test_network_namespace_must_match_current_api(self):
        self.c['baseline']['engineNetworkMode'] = 'container:other-api'
        with self.assertRaisesRegex(RuntimeError, 'API_NAMESPACE_CHANGED'):
            p.validate_contract(self.c)

    def test_old_admin_assets_are_retained_but_new_build_is_exact(self):
        p.validate_contract(self.c)
        self.assertNotEqual(self.c['baseline']['adminFiles'], self.c['baseline']['adminBuiltFiles'])
        self.c['baseline']['adminBuiltFiles']['assets/unpublished.js'] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_INVENTORY_CHANGED'):
            p.validate_contract(self.c)

    def test_payload_binds_all_sources_api_modules_and_both_role_inventories(self):
        proof = proof_fixture(self.c)
        p.verify_proof(proof, proof, self.c, proof['files'])
        for name in ('source/apps/api/unrelated.ts', 'api/modules/auth/credentials.js', 'engine/worker.cjs'):
            files = {**proof['files'], name: 'a' * 64}
            with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
                p.verify_proof(proof, proof, self.c, files)

    def test_payment_or_migration_proof_cannot_pass(self):
        for key, value in (('migrationPerformed', True), ('businessActions', 1)):
            proof = proof_fixture(self.c)
            proof[key] = value
            with self.assertRaisesRegex(RuntimeError, 'PROOF_CHANGED'):
                p.verify_proof(proof, proof, self.c, proof['files'])

    def test_quality_parts_cannot_be_missing_or_wrong_tree(self):
        for kind in ('missing', 'wrong-tree', 'wrong-run'):
            proof = proof_fixture(self.c)
            if kind == 'missing':
                proof['qualityPartEvidence']['parts'].pop()
            elif kind == 'wrong-tree':
                proof['qualityPartEvidence']['testedTree'] = 'c' * 40
            else:
                proof['qualityPartEvidence']['runId'] = '999'
            with self.assertRaisesRegex(RuntimeError, 'FINITE_PROOF_CHANGED'):
                p.verify_proof(proof, proof, self.c, proof['files'])

    def test_inherited_switch_keeps_api_namespace_order_and_idle_fences(self):
        # Pin the accepted switch body rather than duplicating deployment logic.
        source = (HERE / 'online-checkout-release.py').read_text()
        calls = ["d.compose(previous, 'stop', 'online-recharge'", "d.compose(previous, 'stop', 'api'",
            "d.compose(target, 'up', '-d', '--no-deps', 'api', 'admin'",
            "d.compose(target, 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge'"]
        offsets = [source.index(value) for value in calls]
        self.assertEqual(offsets, sorted(offsets))
        self.assertIn("with (BASE / '.deploy.lock').open('a') as lock:", source)
        self.assertIn('a.acquire_release_lock(lock)', source)
        self.assertIn('fence.check_idle()', source)
        self.assertNotIn('migrate:deploy', source)


class QualityCoverage(unittest.TestCase):
    def run_case(self, *, main_jobs=True, missing=None):
        quality = {'kind': 'EXACT_MAIN_SUCCESS', 'runId': '10', 'runAttempt': 1, 'testedTree': 'b' * 40, 'commit': 'a' * 40}
        pr = {**quality, 'kind': 'IDENTICAL_PR_TESTED_TREE', 'runId': '20', 'pullRequest': 1,
            'artifactDigest': 'sha256:' + 'a' * 64, 'proof': {'repository': 'wangchaozhuanyong/id-business-system',
                'runId': 20, 'runAttempt': 1, 'pullRequest': 1, 'testedTree': 'b' * 40, 'headSha': 'c' * 40, 'baseSha': 'd' * 40}}
        def github(path):
            is_main = '/runs/10/' in path
            jobs = [] if is_main and not main_jobs else [
                {'name': 'recharge (' + part + ')', 'id': index + 1, 'status': 'completed', 'conclusion': 'success'}
                for index, part in enumerate(p.QUALITY_PARTS) if part != missing]
            return {'total_count': len(jobs), 'jobs': jobs}
        helper = SimpleNamespace(REPOSITORY='wangchaozhuanyong/id-business-system', github=github)
        count = []
        def evidence(*_):
            count.append(1)
            return quality if len(count) == 1 else pr
        helper.quality_source_evidence = evidence
        original = p.load
        with patch.object(b, 'publisher', return_value=p), patch.object(p, 'load', side_effect=lambda name: helper if name == 'registration-closure-dispatch.py' else original(name)):
            return b.quality_evidence('a' * 40, 'b' * 40)

    def test_real_four_part_main_success(self):
        quality, parts = self.run_case()
        self.assertEqual(quality['kind'], 'EXACT_MAIN_SUCCESS')
        self.assertEqual(parts['parts'], list(p.QUALITY_PARTS))

    def test_main_summary_falls_back_to_authenticated_same_tree_pr(self):
        quality, parts = self.run_case(main_jobs=False)
        self.assertEqual(quality['kind'], 'IDENTICAL_PR_TESTED_TREE')
        self.assertEqual(parts['runId'], '20')

    def test_successful_summary_with_missing_matrix_part_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'QUALITY_PARTS_MISSING'):
            self.run_case(main_jobs=False, missing='online-engine')


class InheritedSwitch(unittest.TestCase):
    def run_switch(self, fail_at=None):
        source = ast.parse((HERE / 'online-checkout-release.py').read_text())
        body = next(node for node in ast.walk(source) if isinstance(node, ast.Try)
            and node.body and ast.unparse(node.body[0]) == 'fence.acquire()')
        events = []
        def record(name, *args):
            events.append((name, *args))
            if name == fail_at:
                raise RuntimeError('synthetic fence busy')
        driver = SimpleNamespace(compose=lambda target, *args, **kwargs: record('compose', target, *args),
            wait_healthy=lambda target, role: record('healthy', target, role))
        fence = SimpleNamespace(acquire=lambda: record('acquire'), check_idle=lambda: record('idle'),
            close=lambda: record('close'))
        states = {role: {'image': role} for role in p.UPDATED}
        namespace = {'fence': fence, 'd': driver, 'previous': 'old', 'target': 'new',
            'h': SimpleNamespace(snapshot=lambda *_: states), 'UPDATED': p.UPDATED,
            'images': {role: {'imageId': role} for role in p.UPDATED}, 'need': p.need,
            'smoke': lambda *_: record('smoke'), 'proof': {}, 'contract': {}, 'json': json,
            'journal': SimpleNamespace(write_text=lambda *_: record('journal'))}
        try:
            exec(compile(ast.Module(body=[body], type_ignores=[]), '<accepted-three-role-switch>', 'exec'), namespace)
        except RuntimeError:
            if fail_at is None:
                raise
        return events

    def test_actual_inherited_switch_starts_api_before_rebinding_engine(self):
        events = self.run_switch()
        composes = [event for event in events if event[0] == 'compose']
        self.assertEqual(composes, [
            ('compose', 'old', 'stop', 'online-recharge'), ('compose', 'old', 'stop', 'api'),
            ('compose', 'new', 'up', '-d', '--no-deps', 'api', 'admin'),
            ('compose', 'new', 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge')])
        self.assertEqual(events.count(('idle',)), 2)
        self.assertEqual(events[-1], ('close',))

    def test_actual_inherited_busy_fence_never_starts_candidate(self):
        for phase in ('acquire', 'idle'):
            events = self.run_switch(fail_at=phase)
            self.assertFalse(any(event[0] == 'compose' and event[1] == 'new' for event in events))
            self.assertEqual(events[-1], ('close',))


class ReproductionNormalization(unittest.TestCase):
    def setUp(self):
        self.source = b'const d=(m.f=["assets/a.js","assets/b.js","assets/a.css","assets/b.css"]);__vite__mapDeps([0,1,2,3]);const business=1;'

    def test_js_preload_permutation_keeps_resolved_mapping_and_css_order(self):
        changed = self.source.replace(b'"assets/a.js","assets/b.js"', b'"assets/b.js","assets/a.js"')
        self.assertEqual(b.canonical_preloads(self.source), b.canonical_preloads(changed))
        self.assertEqual(b.canonical_preloads(self.source), b.canonical_preloads(self.source.replace(b'[0,1,2,3]', b'[1,0,2,3]')))

    def test_business_code_mapping_membership_and_css_order_remain_exact(self):
        for changed in (self.source.replace(b'business=1', b'business=2'),
                        self.source.replace(b'assets/a.js', b'assets/unpublished.js'),
                        self.source.replace(b'[0,1,2,3]', b'[0,1,3,2]'),
                        self.source.replace(b'[0,1,2,3]', b'[0,2,3]')):
            self.assertNotEqual(b.canonical_preloads(self.source), b.canonical_preloads(changed))

    def test_duplicate_mapping_and_invalid_indices_cannot_be_normalized(self):
        for changed in (self.source.replace(b'assets/b.js', b'assets/a.js'),
                        self.source.replace(b'[0,1,2,3]', b'[0,0,2,3]'),
                        self.source.replace(b'[0,1,2,3]', b'[0,8,2,3]')):
            with self.assertRaises(RuntimeError):
                b.canonical_preloads(changed)

    def test_declaration_normalization_is_only_the_accepted_union_order(self):
        raw = b'type State = "needs_review" | "not_applicable";'
        expected = raw.replace(b'"needs_review" | "not_applicable"', b'"not_applicable" | "needs_review"')
        self.assertEqual(b.declaration_bytes(raw, p.sha(expected)), expected)
        with self.assertRaisesRegex(RuntimeError, 'DECLARATION_ORDER_CONTENT_CHANGED'):
            b.declaration_bytes(raw + b'//extra', p.sha(expected))

    def test_reproduction_receipt_cannot_add_an_unrelated_file(self):
        c = fixture()
        proof = proof_fixture(c)
        proof['baselineReproduction']['admin']['assets/unpublished.js'] = {'rebuiltSha256': 'a' * 64, 'publishedSha256': 'b' * 64}
        with self.assertRaisesRegex(RuntimeError, 'REPRODUCTION_SCOPE_CHANGED'):
            p.verify_proof(proof, proof, c, proof['files'])

    def test_predecessor_download_requires_exact_authenticated_artifact_bytes(self):
        with patch.object(b.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'untrusted artifact')):
            with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_ARTIFACT_CHANGED'):
                b.published_admin_assets()


if __name__ == '__main__':
    unittest.main()
