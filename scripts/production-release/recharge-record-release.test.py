import copy
import base64
import gzip
import hashlib
import importlib.util
import io
import json
import os
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
    def test_scoped_backup_streams_normalizes_and_verifies_without_retention_or_secret_arguments(self):
        runtime = HERE.parents[1] / '.runtime'
        runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='record-backup-', dir=runtime) as temporary:
            root = Path(temporary)
            (root / 'backups').mkdir()
            previous = root / "previous 'quoted' $literal"
            (previous / 'scripts').mkdir(parents=True)
            (previous / 'scripts/mysql-dump-restore-normalizer.sed').write_bytes(
                (HERE.parents[1] / 'scripts/mysql-dump-restore-normalizer.sed').read_bytes())
            binary = root / 'bin'
            binary.mkdir()
            docker = binary / 'docker'
            docker.write_text("#!/usr/bin/env python3\nimport sys\nprint('ROUTINES-DATA' if '--routines' in sys.argv[-1] else 'TABLES-DATA')\n")
            docker.chmod(0o755)
            d = Mock()
            d.environment_values.return_value = {'MYSQL_DATABASE': 'fixture_database',
                'DATABASE_URL': 'mysql://fixture:synthetic-private-password@mysql/fixture_database',
                'MYSQL_BACKUP_S3_BUCKET': 'fixture-backups', 'MYSQL_BACKUP_S3_REGION': 'ap-northeast-1'}
            uploaded = None
            wrong_checksum = False
            def run(*args, **kwargs):
                nonlocal uploaded
                if args[0] in ('bash', 'gzip'):
                    return subprocess.check_output(args, env={**os.environ, 'PATH': str(binary) + os.pathsep + os.environ['PATH']},
                                                   timeout=kwargs['timeout']).decode()
                if args[:3] == ('aws', 's3api', 'put-object'):
                    uploaded = Path(args[args.index('--body') + 1])
                    return '{}'
                self.assertEqual(args[:3], ('aws', 's3api', 'head-object'))
                raw = uploaded.read_bytes()
                return json.dumps({'ContentLength': len(raw), 'ServerSideEncryption': 'AES256',
                                   'ChecksumSHA256': 'wrong' if wrong_checksum else base64.b64encode(hashlib.sha256(raw).digest()).decode()})
            d.run.side_effect = run
            plan = {'commit': 'a' * 40, 'workflowRunId': '1'}
            with patch.object(release, 'BASE', root):
                result = release.fresh_scoped_backup(d, previous, plan)
                self.assertTrue(result['s3Verified'])
                self.assertEqual(result['retentionActions'], 0)
                self.assertEqual(gzip.decompress(Path(result['path']).read_bytes()), b'TABLES-DATA\nROUTINES-DATA\n')
                self.assertEqual(Path(result['path']).stat().st_mode & 0o777, 0o600)
                wrong_checksum = True
                with self.assertRaisesRegex(RuntimeError, 'BACKUP_S3_UNVERIFIED'):
                    release.fresh_scoped_backup(d, previous, {**plan, 'workflowRunId': '2'})
                failed = json.loads((root / 'backups' / ('recharge-record-' + plan['commit'] + '-2') / 'backup-operation.json').read_bytes())
                self.assertEqual((failed['status'], failed['phase'], failed['retentionActions']), ('FAILED', 'S3_VERIFICATION', 0))
            commands = repr(d.run.call_args_list)
            for forbidden in ('synthetic-private-password', 'systemctl', '--apply', 'prune', 'retention-protection'):
                self.assertNotIn(forbidden, commands)

    def test_native_application_reuse_requires_exact_sources_commands_and_validate_job(self):
        contract = json.loads((HERE / 'recharge-record-contract.json').read_bytes())
        prior = contract['priorApplicationValidation']
        native = {'head_sha': prior['commit'], 'head_branch': 'main', 'event': 'workflow_dispatch',
                  'run_attempt': 1, 'path': '.github/workflows/recharge-record-validation.yml'}
        job = {'name': 'validate', 'status': 'completed', 'conclusion': 'success'}
        with patch.object(build, 'platform_json', side_effect=[native, {'jobs': [job]}]):
            result = build.verify_prior_application_validation(contract)
            self.assertTrue(result['candidateSourceUnchanged'])
            self.assertFalse(result['publicationReused'])
        for bad in ({**native, 'head_sha': '0' * 40}, {**native, 'run_attempt': 2}):
            with patch.object(build, 'platform_json', return_value=bad), self.assertRaisesRegex(
                    RuntimeError, 'PRIOR_VALIDATION_IDENTITY_CHANGED'):
                build.verify_prior_application_validation(contract)
        with patch.object(build, 'platform_json', side_effect=[native, {'jobs': [{**job, 'conclusion': 'failure'}]}]), self.assertRaisesRegex(
                RuntimeError, 'PRIOR_APPLICATION_CHECKS_NOT_SUCCESSFUL'):
            build.verify_prior_application_validation(contract)
        for field in ('changedSources', 'validationOnlySources'):
            changed = copy.deepcopy(contract)
            changed[field]['unpublished'] = '0' * 64
            with self.assertRaisesRegex(RuntimeError, 'PRIOR_VALIDATION_SOURCE_CHANGED'):
                build.verify_prior_application_validation(changed)
        changed = copy.deepcopy(contract)
        changed['priorApplicationValidation']['workflowSha256'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'PRIOR_VALIDATION_COMMANDS_CHANGED'):
            build.verify_prior_application_validation(changed)

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
        self.assertEqual(release.PRESERVED, ('admin', 'mysql', 'caddy', 'media-resolver',
                                            'auto-recharge', 'auto-registration'))
        self.assertEqual(value['preservedAdminCommit'], '6b4237006e8cc083d31f8ab146ee7186e13c6737')
        self.assertEqual(value['engineHealth'], {'ready': True, 'mode': 'enabled', 'activeTasks': 0,
                                               'stopping': False, 'rpcConnected': True})

    def test_existing_enabled_engine_must_remain_idle_connected_and_exact(self):
        contract = json.loads((HERE / 'recharge-record-contract.json').read_bytes())
        expected = contract['engineHealth']
        d = Mock()
        d.run.side_effect = [json.dumps(expected), json.dumps({'readOnlyRpcReady': True})]
        self.assertEqual(release.engine_idle(d, {'containerId': 'engine'}, contract), expected)
        for changed in ({**expected, 'activeTasks': 1}, {**expected, 'mode': 'credentials-only'},
                        {**expected, 'rpcConnected': False}):
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, 'ONLINE_NOT_IDLE'):
                d.run.side_effect = [json.dumps(changed)]
                release.engine_idle(d, {'containerId': 'engine'}, contract)
        self.assertTrue(all(call.args[:2] == ('docker', 'exec') for call in d.run.call_args_list))
        d.run.side_effect = [json.dumps({**expected, 'rpcConnected': False}), json.dumps(expected),
                             json.dumps({'readOnlyRpcReady': True})]
        with patch.object(release.time, 'sleep') as sleep:
            self.assertEqual(release.engine_idle(d, {'containerId': 'engine'}, contract,
                                                 wait_connected=True), expected)
            sleep.assert_called_once_with(2)
        d.run.side_effect = [json.dumps({**expected, 'activeTasks': 1})]
        with self.assertRaisesRegex(RuntimeError, 'ONLINE_NOT_IDLE'):
            release.engine_idle(d, {'containerId': 'engine'}, contract, wait_connected=True)

    def test_current_admin_baseline_content_is_exact(self):
        contract = json.loads((HERE / 'recharge-record-contract.json').read_bytes())
        d = Mock()
        rows = [sha + '  /usr/share/nginx/html/' + name for name, sha in contract['publicFiles'].items()]
        d.run.return_value = '\n'.join(rows)
        release.verify_admin_content(d, {'containerId': 'admin'}, contract)
        d.run.return_value = '\n'.join(rows[:-1])
        with self.assertRaisesRegex(RuntimeError, 'PRESERVED_ADMIN_CONTENT_CHANGED'):
            release.verify_admin_content(d, {'containerId': 'admin'}, contract)
        self.assertEqual(d.run.call_args.args[:4], ('docker', 'exec', 'admin', 'sha256sum'))

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
            for name in {**contract['changedSources'], **contract['publishedAdminSources']}:
                path = payload / 'source' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(subprocess.check_output(['git', 'show', contract['preservedAdminCommit'] + ':' + name], cwd=HERE.parents[1])
                                 if name in contract['publishedAdminSources'] else (HERE.parents[1] / name).read_bytes())
            proof = {'version': 4, 'scope': release.SCOPE, **plan,
                     'sourceBaseline': contract['sourceBaseline'],
                     'liveManifestSha256': contract['manifestSha256'],
                     'baselineApiReproduced': True, 'baselineAdminReproduced': True,
                     'publishedAdminPatchCommit': contract['preservedAdminCommit'],
                     'publishedAdminSources': contract['publishedAdminSources'],
                     'updatedServices': ['api'], 'dependentServiceRebound': 'online-recharge',
                     'migrationPerformed': False, 'businessActions': 0,
                     'files': release.file_inventory(payload)}
            self.assertEqual(release.validate_proof(proof, plan, contract, payload), proof)
            (payload / 'admin/html').mkdir(parents=True)
            (payload / 'admin/html/index.html').write_text('<html>must not deploy</html>')
            with self.assertRaisesRegex(RuntimeError, 'BUILD_CONTENT_CHANGED'):
                release.validate_proof({**proof, 'files': release.file_inventory(payload)}, plan, contract, payload)
            (payload / 'admin/html/index.html').unlink()
            for field, value in [('commit', 'd' * 40), ('tree', 'e' * 40), ('workflowRunId', '999'),
                                 ('workflowRunAttempt', '2'), ('baselineApiReproduced', False),
                                 ('baselineAdminReproduced', False), ('migrationPerformed', True),
                                 ('businessActions', 1), ('businessActions', False), ('version', True), ('version', 1),
                                 ('publishedAdminPatchCommit', '0' * 40), ('publishedAdminSources', {}), ('version', 2), ('version', 3),
                                 ('updatedServices', ['api', 'admin'])]:
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
        self.assertIn('fresh_scoped_backup(d, previous, plan)', source)


if __name__ == '__main__':
    unittest.main()
