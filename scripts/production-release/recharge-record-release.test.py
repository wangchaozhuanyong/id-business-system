import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import subprocess
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('record_release', HERE / 'recharge-record-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class RepairPublicationTests(unittest.TestCase):
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
