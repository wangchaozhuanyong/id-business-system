import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import subprocess
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('record_release', HERE / 'recharge-record-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
build_spec = importlib.util.spec_from_file_location('record_build', HERE / 'recharge-record-build.py')
build = importlib.util.module_from_spec(build_spec)
build_spec.loader.exec_module(build)


class RepairPublicationTests(unittest.TestCase):
    def test_main_sync_admits_only_exact_published_source_and_keeps_repair_hashes(self):
        runtime = HERE.parents[1] / '.runtime'
        runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='record-source-gate-', dir=runtime) as root:
            root = Path(root)
            def command(*args):
                return subprocess.check_output(['git', *args], cwd=root, stderr=subprocess.DEVNULL, text=True).strip()
            def commit(message):
                command('add', 'apps')
                command('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
                        'commit', '-qm', message)
                return command('rev-parse', 'HEAD')
            command('init', '-q')
            directory = root / 'apps/api'
            directory.mkdir(parents=True)
            repair, synced = directory / 'repair.ts', directory / 'synced.ts'
            repair.write_text('original repair\n')
            synced.write_text('old source\n')
            main_base = commit('original main')
            synced.write_text('already published\n')
            published = commit('published source')
            published_tree = command('rev-parse', 'HEAD^{tree}')
            repair.write_text('diagnostic repair\n')
            commit('repair plus published sync')
            contract = {'mainBase': main_base, 'sourceBaseline': published,
                        'sourceBaselineTree': published_tree,
                        'changedSources': {'apps/api/repair.ts': hashlib.sha256(repair.read_bytes()).hexdigest()}}
            with patch.object(build, 'ROOT', root):
                build.verify_scope(contract)
                synced.write_text('unpublished change\n')
                commit('unpublished source')
                with self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE_CHANGED'):
                    build.verify_scope(contract)
                synced.write_text('already published\n')
                repair.write_text('different repair\n')
                commit('repair hash drift')
                with self.assertRaisesRegex(RuntimeError, 'REPAIR_SOURCE_CHANGED'):
                    build.verify_scope(contract)

    def test_named_base_requires_exact_observed_image_id(self):
        state = {'reference': 'id-business-v2-direct:f8a1612d-online-api', 'image': 'sha256:' + '1' * 64}
        d = Mock()
        d.run.return_value = json.dumps([{'Id': state['image']}])
        self.assertEqual(release.base_image_reference(d, state), state['reference'])
        d.run.assert_called_once_with('docker', 'image', 'inspect', state['reference'])
        d.run.return_value = json.dumps([{'Id': 'sha256:' + '2' * 64}])
        with self.assertRaisesRegex(RuntimeError, 'BASE_REFERENCE_CHANGED'):
            release.base_image_reference(d, state)
        with self.assertRaisesRegex(RuntimeError, 'BASE_REFERENCE_INVALID'):
            release.base_image_reference(d, {**state, 'reference': state['reference'] + '\nRUN false'})
        with self.assertRaisesRegex(RuntimeError, 'BASE_REFERENCE_INVALID'):
            release.base_image_reference(d, {**state, 'reference': state['image']})

    def test_actual_build_prefers_verified_local_base_and_preserves_safe_failure_receipt(self):
        state = {'reference': 'id-business-v2-direct:f8a1612d-online-api', 'image': 'sha256:' + '1' * 64}
        d = Mock()
        with tempfile.TemporaryDirectory() as root:
            stage = Path(root)
            release.build_image(d, stage / 'api', 'candidate:1', 'api', state, stage)
            d.run.assert_called_once_with('docker', 'build', '--pull=false', '--network', 'none',
                                          '--tag', 'candidate:1', str(stage / 'api'), timeout=300)
            self.assertEqual(json.loads((stage / 'api-image-build.json').read_text())['status'], 'BUILT')
            d.run.side_effect = RuntimeError('pull access denied, insufficient_scope synthetic-private-registry-response')
            with self.assertRaisesRegex(RuntimeError, 'API_IMAGE_BUILD_SOURCE_UNAVAILABLE'):
                release.build_image(d, stage / 'api', 'candidate:1', 'api', state, stage)
            raw = (stage / 'api-image-build.json').read_text()
            receipt = json.loads(raw)
            self.assertEqual(receipt['status'], 'FAILED')
            self.assertEqual(receipt['failureKind'], 'SOURCE_UNAVAILABLE')
            self.assertNotIn('synthetic-private-registry-response', raw)
            for error, expected in ((subprocess.TimeoutExpired(['docker', 'build'], 300), 'TIMEOUT'),
                                    (RuntimeError('synthetic-private-unknown-response'), 'COMMAND_FAILED')):
                d.run.side_effect = error
                with self.subTest(expected=expected), self.assertRaisesRegex(RuntimeError, 'IMAGE_BUILD_' + expected):
                    release.build_image(d, stage / 'api', 'candidate:1', 'api', state, stage)
                self.assertEqual(json.loads((stage / 'api-image-build.json').read_text())['failureKind'], expected)

    def test_actual_contract_preserves_latest_online_and_form_baseline(self):
        value = json.loads((HERE / 'recharge-record-contract.json').read_bytes())
        self.assertEqual(value['sourceBaseline'], 'f8a1612d9b465dc5cfb1534c9cc3c5640583cc80')
        actual_tree = subprocess.check_output(['git', 'rev-parse', value['sourceBaseline'] + '^{tree}'],
                                              cwd=HERE.parents[1], text=True).strip()
        self.assertEqual(value['sourceBaselineTree'], actual_tree)
        self.assertEqual(value['declaredBaselineTree'], '2c634fd53a6bb393bb37e4459579c266a93e4f4f')
        self.assertEqual(set(value['services']), set(release.SERVICES))
        self.assertEqual(len(value['changedSources']), 12)
        self.assertFalse(any('online-recharge/' in name or 'schema.prisma' in name
                             for name in value['changedSources']))
        self.assertEqual(release.PRESERVED, ('mysql', 'caddy', 'media-resolver',
                                            'auto-recharge', 'auto-registration'))

    def test_archive_rejects_escape_duplicate_links_and_oversize(self):
        for names, kind in [(['payload/../../secret'], tarfile.REGTYPE),
                            (['payload/a', 'payload/a'], tarfile.REGTYPE),
                            (['payload/link'], tarfile.SYMTYPE)]:
            with self.subTest(names=names, kind=kind), tempfile.TemporaryDirectory() as root:
                stream = io.BytesIO()
                with tarfile.open(fileobj=stream, mode='w') as archive:
                    for name in names:
                        item = tarfile.TarInfo(name)
                        item.type = kind
                        item.size = 0
                        archive.addfile(item, io.BytesIO())
                with self.assertRaisesRegex(RuntimeError, 'ARTIFACT_PATH_INVALID'):
                    release.safe_archive(stream.getvalue(), Path(root) / 'output')

    def test_native_build_proof_requires_identity_reproduction_and_closed_payload(self):
        contract = json.loads((HERE / 'recharge-record-contract.json').read_bytes())
        plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123',
                'workflowRunAttempt': '1', 'contractSha256': 'c' * 64,
                'controllerSha256': 'd' * 64, 'releaseUtilitySha256': 'e' * 64}
        with tempfile.TemporaryDirectory() as root:
            payload = Path(root)
            (payload / 'api').mkdir()
            (payload / 'api/recharge-validation.js').write_text('export const safe = true;')
            (payload / 'admin/html').mkdir(parents=True)
            (payload / 'admin/html/index.html').write_text('<html></html>')
            for name in contract['changedSources']:
                path = payload / 'source' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((HERE.parents[1] / name).read_bytes())
            proof = {'version': 1, 'scope': release.SCOPE, **plan,
                     'sourceBaseline': contract['sourceBaseline'],
                     'liveManifestSha256': contract['manifestSha256'],
                     'baselineApiReproduced': True, 'baselineAdminReproduced': True,
                     'updatedServices': ['api', 'admin'], 'dependentServiceRebound': 'online-recharge',
                     'migrationPerformed': False, 'businessActions': 0,
                     'files': release.file_inventory(payload)}
            self.assertEqual(release.validate_proof(proof, plan, contract, payload), proof)
            for field, value in [('commit', 'd' * 40), ('tree', 'e' * 40), ('workflowRunId', '999'),
                                 ('workflowRunAttempt', '2'), ('baselineApiReproduced', False),
                                 ('baselineAdminReproduced', False), ('migrationPerformed', True),
                                 ('businessActions', 1), ('businessActions', False), ('version', True),
                                 ('updatedServices', ['api', 'admin', 'mysql'])]:
                with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'BUILD_PROOF_INVALID'):
                    release.validate_proof({**proof, field: value}, plan, contract, payload)
            (payload / 'api/payment-executor.js').write_text('extra')
            with self.assertRaisesRegex(RuntimeError, 'BUILD_CONTENT_CHANGED'):
                release.validate_proof(proof, plan, contract, payload)
            (payload / 'api/payment-executor.js').unlink()
            name = next(iter(contract['changedSources']))
            path = payload / 'source' / name
            path.write_bytes(path.read_bytes() + b' ')
            proof['files'] = release.file_inventory(payload)
            with self.assertRaisesRegex(RuntimeError, 'BUILD_CONTENT_CHANGED'):
                release.validate_proof(proof, plan, contract, payload)

    def test_changed_predecessor_stops_before_any_business_or_release_action(self):
        contract = json.loads((HERE / 'recharge-record-contract.json').read_bytes())
        with patch.object(release.Path, 'resolve', return_value=Path('/opt/id-business-v2/releases/new')):
            with self.assertRaisesRegex(RuntimeError, 'CURRENT_CHANGED'):
                release.baseline(None, contract)

    def test_actual_failure_paths_never_restore_cancel_clean_or_migrate(self):
        source = (HERE / 'recharge-record-release.py').read_text()
        self.assertNotIn("'rollback'", source)
        self.assertNotIn("'prune'", source)
        self.assertNotIn("'migrate'", source)
        self.assertIn("'stop', 'online-recharge'", source)
        self.assertIn("'IMAGE_MISMATCH'", source)
        self.assertIn("'ONLINE_BINDING_INVALID'", source)
        self.assertIn('d.fresh_backup(previous)', source)


if __name__ == '__main__':
    unittest.main()
