"""Contract and mocked Admin-only deployment invariants; no business requests."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('session_preflight_tests', HERE / 'online-session-preflight-release.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
H = 'a' * 64
COMMIT = 'b' * 40
TREE = 'c' * 40


def contract():
    public = {'index.html': H, 'assets/index-test.js': H,
        **{'assets/file-' + str(n) + '.js': H for n in range(260)}}
    state = {role: {'containerId': role + '-container', 'image': 'sha256:' + H,
        'reference': 'test:' + role, 'environmentSha256': H} for role in p.SERVICES}
    state['admin']['image'] = p.PREDECESSOR_ADMIN_IMAGE
    return {'version': 1, 'scope': p.SCOPE, 'reviewBase': p.SOURCE_BASE,
        'expectedCurrent': p.SOURCE_BASE, 'sourceReviewCommit': 'd' * 40,
        'sourceReviewTag': 'online-session-preflight-source-review-' + 'd' * 12,
        'reviewedControlSources': {name: H for name in p.SCOPE_CONTROLS},
        'requiredQualityParts': list(p.QUALITY_PARTS), 'updatedServices': list(p.UPDATED),
        'preservedServices': list(p.PRESERVED), 'migrationPerformed': False, 'businessActions': 0,
        'sources': {name: H for name in p.APPLICATION}, 'controlPins': {name: H for name in p.CONTROLS},
        'workflowSha256': H, 'reconstruction': {'publishedAdminCommit': p.SOURCE_BASE,
            'reviewCommit': p.PREDECESSOR_REVIEW, 'predecessorProofSha256': p.PREDECESSOR_PROOF_SHA256,
            'pins': {name: H for name in p.RECONSTRUCTION_FILES},
            'publishedAdminSources': {p.RUNTIME_SOURCE: H}, 'publishedAdminFiles': public},
        'baseline': {'commit': p.SOURCE_BASE,
            'current': '/opt/id-business-v2/releases/current-test', 'manifestSha256': H,
            'services': state, 'runtimeConfigurationSha256': {role: H for role in p.SERVICES},
            'configurationSha256': {name: H for name in ('.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml')},
            'adminFiles': public, 'apiOnlineFiles': {'module.js': H}, 'engineFiles': {'worker.cjs': H},
            'engineHealth': p.HEALTH, 'nginxSha256': H,
            'backupNormalizerPath': '/opt/id-business-v2/releases/current-test/scripts/mysql-dump-restore-normalizer.sed',
            'backupNormalizerSha256': 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202'}}


def proof(c):
    quality = {'kind': 'EXACT_MAIN_SUCCESS', 'runId': '99', 'runAttempt': 1, 'testedTree': TREE, 'commit': COMMIT}
    files = {**{'source/' + name: value for name, value in c['sources'].items()},
             'admin/html/index.html': H, 'admin/html/assets/index-new.js': H}
    return {'version': 1, 'scope': p.SCOPE, 'commit': COMMIT, 'tree': TREE,
        'workflowRunId': '100', 'workflowRunAttempt': '1', 'contractSha256': H,
        'controlSources': c['controlPins'], 'qualitySourceEvidence': quality,
        'qualityPartEvidence': {'runId': '99', 'runAttempt': 1, 'testedTree': TREE,
            'parts': list(p.QUALITY_PARTS), 'jobs': {'guards': 10, 'admin': 11}},
        'workflow': p.WORKFLOW, 'workflowSha256': H, 'sources': c['sources'],
        'baselineAdminSourceReproduced': True, 'baselineAdminFiles': c['reconstruction']['publishedAdminFiles'],
        'adminFiles': {'index.html': H, 'assets/index-new.js': H}, 'files': files,
        'updatedServices': list(p.UPDATED), 'preservedServices': list(p.PRESERVED),
        'migrationPerformed': False, 'businessActions': 0}


class ContractTests(unittest.TestCase):
    def test_accept_exact_admin_only_contract(self):
        p.validate_contract(contract())

    def test_reject_extra_api_source(self):
        c = contract()
        c['sources']['apps/api/src/id-business-v2/online-recharge/worker.ts'] = H
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE_CHANGED'):
            p.validate_contract(c)

    def test_reject_api_restart_scope(self):
        c = contract()
        c['updatedServices'].append('api')
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_IDENTITY_INVALID'):
            p.validate_contract(c)

    def test_reject_missing_preserved_worker(self):
        c = contract()
        c['preservedServices'].remove('online-recharge')
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_IDENTITY_INVALID'):
            p.validate_contract(c)

    def test_reject_changed_published_image(self):
        c = contract()
        c['baseline']['services']['admin']['image'] = 'sha256:' + H
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_CHANGED'):
            p.validate_contract(c)

    def test_reject_changed_reconstruction_source(self):
        c = contract()
        c['reconstruction']['pins']['new-helper.py'] = H
        with self.assertRaisesRegex(RuntimeError, 'PUBLISHED_RECONSTRUCTION_CHANGED'):
            p.validate_contract(c)

    def test_reject_missing_old_static_asset(self):
        c = contract()
        c['baseline']['adminFiles'] = dict(c['baseline']['adminFiles'])
        del c['baseline']['adminFiles']['index.html']
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_CHANGED'):
            p.validate_contract(c)

    def test_reject_path_traversal(self):
        c = contract()
        c['baseline']['adminFiles'] = {**c['baseline']['adminFiles'], '../outside': H}
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_CHANGED'):
            p.validate_contract(c)

    def test_proof_contains_only_admin_and_reviewed_sources(self):
        c = contract()
        value = proof(c)
        p.verify_proof(value, value, c, value['files'])

    def test_reject_extra_engine_artifact_even_when_self_declared(self):
        c = contract()
        value = proof(c)
        value['files']['engine/credentials.cjs'] = H
        with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
            p.verify_proof(value, value, c, value['files'])

    def test_reject_extra_api_artifact(self):
        c = contract()
        value = proof(c)
        value['files']['api/modules/surprise.js'] = H
        with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
            p.verify_proof(value, value, c, value['files'])

    def test_reject_unreproduced_baseline(self):
        c = contract()
        value = proof(c)
        value['baselineAdminFiles'] = {'index.html': H}
        with self.assertRaisesRegex(RuntimeError, 'PROOF_CHANGED'):
            p.verify_proof(value, value, c, value['files'])

    def test_reject_quality_without_admin_job(self):
        c = contract()
        value = proof(c)
        del value['qualityPartEvidence']['jobs']['admin']
        with self.assertRaisesRegex(RuntimeError, 'QUALITY_PARTS_MISSING'):
            p.verify_proof(value, value, c, value['files'])

    def test_reject_false_zero_boolean(self):
        c = contract()
        value = proof(c)
        value['businessActions'] = False
        with self.assertRaisesRegex(RuntimeError, 'PROOF_CHANGED'):
            p.verify_proof(value, value, c, value['files'])

    def test_reject_switched_quality_tree(self):
        c = contract()
        value = proof(c)
        value['qualitySourceEvidence']['testedTree'] = 'e' * 40
        with self.assertRaisesRegex(RuntimeError, 'QUALITY_SOURCE_INVALID'):
            p.verify_proof(value, value, c, value['files'])

    def test_smoke_rejects_restarted_api_before_any_content_read(self):
        c = contract()
        states = copy.deepcopy(c['baseline']['services'])
        states['api']['containerId'] = 'new-api-container'
        with self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICE_CHANGED'):
            p.smoke(None, None, states, proof(c), c, None)

    def test_smoke_rejects_changed_admin_environment(self):
        c = contract()
        states = copy.deepcopy(c['baseline']['services'])
        states['admin']['environmentSha256'] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_CONFIGURATION_CHANGED'):
            p.smoke(None, None, states, proof(c), c, None)

    def test_safe_archive_rejects_symlink(self):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w:gz') as archive:
            item = tarfile.TarInfo('payload/admin/html/index.html')
            item.type, item.linkname = tarfile.SYMTYPE, '/etc/passwd'
            archive.addfile(item)
        with tempfile.TemporaryDirectory() as path:
            with self.assertRaisesRegex(RuntimeError, 'ARTIFACT_PATH_INVALID'):
                p.load('recharge-record-release.py').safe_archive(raw.getvalue(), Path(path) / 'out')



    def run_readback(self, *, unexpected_migration=False):
        c = contract()
        c['controlPins'] = {name: p.sha((HERE / name).read_bytes()) for name in p.CONTROLS}
        value = proof(c)
        value['migrationPerformed'] = unexpected_migration
        actions = []
        original_load = p.load
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            target = root / 'releases/current'
            target.mkdir(parents=True)
            (root / 'current').symlink_to(target, target_is_directory=True)
            (target / 'release-manifest.json').write_text(json.dumps({'commit': COMMIT, 'sourceTree': TREE, 'scope': p.SCOPE}))
            states = copy.deepcopy(c['baseline']['services'])
            (target / 'online-session-preflight-preservation.json').write_text(json.dumps({
                'after': states, 'images': {'admin': {'imageId': states['admin']['image']}}}))
            raw = json.dumps(value).encode()
            (target / 'online-session-preflight-build-proof.json').write_bytes(raw)
            plan = {**value, 'mode': 'readback', 'buildProofSha256': p.sha(raw)}
            class D:
                def compose(self, *args, **kwargs):
                    raise AssertionError('readback must never invoke compose')
                def run(self, *args, **kwargs):
                    raise AssertionError('readback mock must not perform external actions')
            helpers = types.SimpleNamespace(load_utilities=lambda *args: D(), snapshot=lambda *args: states)
            release_helpers = types.SimpleNamespace(acquire_release_lock=lambda lock: None)
            def fake_load(name):
                return {'recharge-record-release.py': helpers,
                    'recharge-availability-release.py': release_helpers}.get(name) or original_load(name)
            with patch.object(p, 'BASE', root), patch.object(p, 'load', fake_load), \
                    patch.object(p, 'validate_plan'), patch.object(p, 'smoke', side_effect=lambda *args: actions.append('smoke')):
                result = p.release(plan, c)
            self.assertEqual(actions, ['smoke'])
            return result

    def test_independent_readback_declares_no_migration_and_updates_only_admin(self):
        result = self.run_readback()
        self.assertEqual(result['status'], 'ONLINE_SESSION_PREFLIGHT_INDEPENDENT_READBACK_VERIFIED')
        self.assertIs(result['migrationPerformed'], False)
        self.assertEqual(result['updatedServices'], ['admin'])
        self.assertEqual(result['businessActions'], 0)

    def test_independent_readback_rejects_migration_evidence(self):
        with self.assertRaisesRegex(RuntimeError, 'PROOF_CHANGED'):
            self.run_readback(unexpected_migration=True)

    def review_check(self, *, wrong_tag=False, extra_scope=False, altered_source=False):
        builder = p.load('online-session-preflight-build.py')
        c = contract()
        for group in ('sources', 'reviewedControlSources'):
            c[group] = {name: p.sha((HERE.parents[1] / name).read_bytes()) for name in c[group]}
        def fake_git(*args):
            if args[:2] == ('cat-file', '-t'):
                return b'tag\n'
            if args[0] == 'rev-parse':
                return (('e' * 40 if wrong_tag else c['sourceReviewCommit']) + '\n').encode()
            if args[0] == 'diff':
                names = sorted(p.APPLICATION | p.SCOPE_CONTROLS) + (['unreviewed.ts'] if extra_scope else [])
                return ('\n'.join(names) + '\n').encode()
            if args[0] == 'show':
                name = args[1].split(':', 1)[1]
                return b'changed' if altered_source and name == p.RUNTIME_SOURCE else (HERE.parents[1] / name).read_bytes()
            raise AssertionError('squash review must not require ancestor relation: ' + repr(args))
        with patch.object(builder, 'git', fake_git):
            builder.check_reviewed_source(c)

    def test_tagged_review_survives_squash_without_ancestor_relation(self):
        self.review_check()

    def test_review_rejects_retargeted_tag(self):
        with self.assertRaisesRegex(RuntimeError, 'REVIEW_TAG_CHANGED'):
            self.review_check(wrong_tag=True)

    def test_review_rejects_unrelated_file(self):
        with self.assertRaisesRegex(RuntimeError, 'REVIEW_SCOPE_CHANGED'):
            self.review_check(extra_scope=True)

    def test_review_rejects_changed_runtime_bytes(self):
        with self.assertRaisesRegex(RuntimeError, 'REVIEWED_SOURCE_CHANGED'):
            self.review_check(altered_source=True)

    def test_deployment_updates_only_admin_and_preserves_other_image_manifest(self):
        original_load = p.load
        h_original = original_load('recharge-record-release.py')
        c = contract()
        actions = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / '.staging').mkdir()
            previous = root / 'releases/previous'
            previous.mkdir(parents=True)
            (previous / 'scripts/production-release').mkdir(parents=True)
            old_images = {role: {'digest': c['baseline']['services'][role]['image'], 'reference': 'old-' + role}
                          for role in p.SERVICES}
            raw_manifest = json.dumps({'commit': p.SOURCE_BASE, 'images': old_images}).encode()
            (previous / 'release-manifest.json').write_bytes(raw_manifest)
            (previous / 'compose.release.json').write_text(json.dumps({'services': {role: {'image': 'old-' + role} for role in p.SERVICES}}))
            payload = root / 'payload-source'
            for name in p.APPLICATION:
                target = payload / 'source' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b'synthetic source')
                c['sources'][name] = p.sha(target.read_bytes())
            for name in ('index.html', 'assets/index-new.js'):
                target = payload / 'admin/html' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b'synthetic admin')
            value = proof(c)
            value['adminFiles'] = h_original.file_inventory(payload / 'admin/html')
            value['files'] = h_original.file_inventory(payload)
            (payload / 'build-proof.json').write_text(json.dumps(value))
            plan = {**value, 'mode': 'release', 'buildProofSha256': p.sha((payload / 'build-proof.json').read_bytes()),
                'artifactSha256': H}
            after = copy.deepcopy(c['baseline']['services'])
            after['admin'].update(image='sha256:' + 'b' * 64, reference='new-admin')
            class D:
                @staticmethod
                def run(*args, **kwargs):
                    actions.append(args)
                    if args[:3] == ('docker', 'image', 'inspect'):
                        return json.dumps([{'Id': after['admin']['image']}])
                    raise AssertionError(args)
                @staticmethod
                def compose(target, *args, **kwargs):
                    actions.append(('compose', *args))
                @staticmethod
                def wait_healthy(target, role):
                    actions.append(('healthy', role))
                @staticmethod
                def point_current(target, marker):
                    actions.append(('point_current', str(target)))
            helpers = types.SimpleNamespace(load_utilities=lambda *args: D(),
                safe_archive=lambda raw, dest: payload, file_inventory=h_original.file_inventory,
                base_image_reference=lambda *args: 'old-admin', build_image=lambda *args: actions.append(('build', 'admin')),
                fresh_scoped_backup=lambda *args, **kwargs: {'s3Verified': True}, snapshot=lambda *args: after)
            release_helpers = types.SimpleNamespace(acquire_release_lock=lambda lock: None,
                normalize_image_context=lambda directory: None)
            checkout_helpers = types.SimpleNamespace(verify_image=lambda *args: None)
            def fake_load(name):
                return {'recharge-record-release.py': helpers, 'recharge-availability-release.py': release_helpers,
                    'online-checkout-release.py': checkout_helpers}.get(name) or original_load(name)
            with patch.object(p, 'BASE', root), patch.object(p, 'load', fake_load), \
                    patch.object(p, 'validate_plan'), patch.object(p, 'download_artifact', return_value=b'synthetic artifact'), \
                    patch.object(p, 'baseline', return_value=(previous, raw_manifest, c['baseline']['services'])), \
                    patch.object(p, 'smoke'):
                # Pinned local controls are checked even in the simulator.
                c['controlPins'] = {name: p.sha((HERE / name).read_bytes()) for name in p.CONTROLS}
                value['controlSources'] = plan['controlSources'] = c['controlPins']
                (payload / 'build-proof.json').write_text(json.dumps(value))
                plan['buildProofSha256'] = p.sha((payload / 'build-proof.json').read_bytes())
                self.assertTrue((HERE / p.CONTRACT_FILE).is_file())
                result = p.release(plan, c)
            self.assertEqual(result['updatedServices'], ['admin'])
            self.assertEqual([row for row in actions if row[0] == 'compose'],
                [('compose', 'up', '-d', '--no-deps', 'admin')])
            self.assertFalse(any('stop' in row or '--force-recreate' in row for row in actions))
            target = Path([row[1] for row in actions if row[0] == 'point_current'][0])
            actual = json.loads((target / 'release-manifest.json').read_bytes())
            self.assertEqual({role: actual['images'][role] for role in p.PRESERVED},
                             {role: old_images[role] for role in p.PRESERVED})
            self.assertEqual(actual['paymentActions'], 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
