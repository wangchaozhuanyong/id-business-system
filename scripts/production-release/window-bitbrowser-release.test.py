"""Pure control regressions. No AWS, database, browser or production command runs."""
import importlib.util
import inspect
import json
from pathlib import Path
import tempfile
import io
import tarfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('window_controls', HERE / 'window-bitbrowser-release.py')
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)


class Controls(unittest.TestCase):
    def test_existing_locked_recipe_gains_only_the_selected_engine_image(self):
        fn = R.configured_release({})
        text = repr(fn.__code__.co_consts)
        self.assertIn('COPY engine/ /workspace/engine/', text)
        self.assertIn('online-recharge', text)
        self.assertIn('latest_main', fn.__code__.co_names)
        self.assertIn('migrate', fn.__code__.co_names)
        self.assertIn('smoke', fn.__code__.co_names)

    def test_inherited_recipe_change_stops_before_native_execution(self):
        with patch.object(R.inspect, 'getsource', return_value='def release(plan):\n    pass\n'):
            with self.assertRaisesRegex(RuntimeError, 'INHERITED_RECIPE_CHANGED'):
                R.configured_release({})

    def test_parent_compilation_uses_verified_current_files_while_old_assets_remain_protected(self):
        files = {'index.html': 'a' * 64, 'assets/current.js': 'b' * 64}
        raw = json.dumps({'commit': 'parent', 'businessActions': 0, 'adminFiles': files}).encode()
        pin = {'file': 'permission-loading-build-proof.json', 'sha256': R.sha(raw),
            'fileCount': 2, 'filesSha256': R.sha(R.canonical(files))}
        c = {'expectedCurrent': 'parent', 'baselineAdminProof': pin}
        manifest = {'roleSourceProjections': {'admin': {'buildProofSha256': R.sha(raw)}}}
        self.assertEqual(R.parent_admin_files(raw, manifest, c), files)
        for broken in [raw + b' ', raw.replace(b'current.js', b'old.js')]:
            with self.assertRaisesRegex(RuntimeError, 'ADMIN_PARENT_PROOF_CHANGED'):
                R.parent_admin_files(broken, manifest, c)
        with self.assertRaisesRegex(RuntimeError, 'ADMIN_PARENT_INVENTORY_CHANGED'):
            R.parent_admin_files(raw, manifest, {**c, 'baselineAdminProof': {**pin, 'fileCount': 3}})
        with self.assertRaisesRegex(RuntimeError, 'ADMIN_PARENT_PROOF_CHANGED'):
            R.parent_admin_files(raw, {'roleSourceProjections': {'admin': {'buildProofSha256': 'c' * 64}}}, c)
        source = inspect.getsource(R.capture)
        self.assertIn("'runtime': runtime", source)
        self.assertIn("read_hashes(d, states['admin']['containerId']", source)

    def test_parent_client_normalizes_only_generation_paths_and_rejects_binary_or_file_changes(self):
        publication = R.load('window-bitbrowser-publication.py')
        runtime = HERE.parents[1] / '.runtime'
        runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='window-parent-client-test-', dir=runtime) as folder:
            context = Path(folder)
            client = context / 'node_modules/.prisma/client'
            client.mkdir(parents=True)
            (client / 'index.js').write_text('root=' + str(context.resolve()))
            (client / 'engine.node').write_bytes(b'unchanged-engine')
            parent_root = '/verified-parent-context'
            files = {'index.js': R.sha(('root=' + parent_root).encode()), 'engine.node': R.sha(b'unchanged-engine')}
            baseline = {'clientGenerationRoot': parent_root, 'clientFiles': files,
                'runtime': {'clientInventory': {'count': 2, 'sha256': R.sha(R.canonical(files))}}}
            output = context / 'comparison.json'
            publication.reproduce_parent_client(context, baseline, output)
            self.assertEqual(json.loads(output.read_text())['differingFiles'], [])
            legacy = {'runtime/library.js': R.sha(b'legacy-runtime')}
            complete = {**files, **legacy}
            retained = {**baseline, 'clientFiles': complete, 'preservedClientFiles': legacy,
                'runtime': {'clientInventory': {'count': 3, 'sha256': R.sha(R.canonical(complete))}}}
            publication.reproduce_parent_client(context, retained, output)
            self.assertEqual(json.loads(output.read_text())['preservedCount'], 1)
            with self.assertRaisesRegex(RuntimeError, 'PRISMA_PARENT_NOT_REPRODUCED'):
                publication.reproduce_parent_client(context, {**retained, 'preservedClientFiles': {}}, output)
            (client / 'engine.node').write_bytes(b'changed-engine')
            with self.assertRaisesRegex(RuntimeError, 'PRISMA_PARENT_NOT_REPRODUCED'):
                publication.reproduce_parent_client(context, baseline, output)
            self.assertEqual(json.loads(output.read_text())['differingFiles'], ['engine.node'])
            with self.assertRaisesRegex(RuntimeError, 'CLIENT_GENERATION_PATH'):
                publication.reproduce_parent_client(context, {**baseline, 'clientGenerationRoot': '../unsafe'}, output)

    def test_candidate_image_requires_all_new_and_preserved_client_hashes_before_migration(self):
        proof = {'prismaClientFiles': {'index.js': 'a' * 64}, 'preservedClientFiles': {'runtime/library.js': 'b' * 64}}
        expected = {**proof['prismaClientFiles'], **proof['preservedClientFiles']}
        d = Mock(); d.run.return_value = json.dumps(expected)
        R.verify_client_image(d, 'candidate-api', proof)
        self.assertIn('--read-only', d.run.call_args.args)
        self.assertIn('--network', d.run.call_args.args)
        d.run.return_value = json.dumps({'index.js': 'a' * 64})
        with self.assertRaisesRegex(RuntimeError, 'PRISMA_IMAGE_CONTENT_CHANGED'):
            R.verify_client_image(d, 'candidate-api', proof)
        self.assertIn('verify_client_image', R.configured_release({}).__code__.co_names)

    def test_migration_archive_identity_uses_verified_configuration_not_a_daemon_identifier(self):
        publication = R.load('window-bitbrowser-publication.py')
        runtime = HERE.parents[1] / '.runtime'; runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='window-migration-identity-test-', dir=runtime) as folder:
            path = Path(folder) / 'image.tar.gz'
            config = json.dumps({'os': 'linux', 'architecture': 'amd64', 'config': {}}).encode()
            digest = R.sha(config); name = 'blobs/sha256/' + digest; ref = 'fixture:exact'
            manifest = json.dumps([{'Config': name, 'RepoTags': [ref], 'Layers': []}]).encode()
            def write(body):
                with tarfile.open(path, 'w:gz') as archive:
                    for filename, data in [('manifest.json', manifest), (name, body)]:
                        member = tarfile.TarInfo(filename); member.size = len(data); archive.addfile(member, io.BytesIO(data))
            write(config)
            self.assertEqual(publication.migration_archive_image_id(path, ref), 'sha256:' + digest)
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_ARCHIVE_REFERENCE'):
                publication.migration_archive_image_id(path, 'fixture:other')
            write(config + b' ')
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_CONFIG_HASH'):
                publication.migration_archive_image_id(path, ref)

    def test_failed_publication_diagnostic_binds_original_proof_and_never_stops_services(self):
        runtime = HERE.parents[1] / '.runtime'; runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='window-native-diagnostic-test-', dir=runtime) as folder:
            base = Path(folder); commit = 'a' * 40; run = '123'
            stage = base / '.staging' / (R.PREFIX + '-' + commit + '-' + run)
            content = stage / 'content/payload'; content.mkdir(parents=True)
            proof = {'commit': commit, 'workflowRunId': run, 'scope': R.SCOPE, 'sources': {}, 'businessActions': 0,
                'prismaClientFiles': {}, 'preservedClientFiles': {}, 'migrationTransport': {'file': R.PREFIX+'-migration.tar.gz', 'sha256':'b'*64,'bytes':1,'imageId':'sha256:'+'c'*64,'reference':'098208446664.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:'+commit+'-'+run+'-window-bitbrowser-migrate'}}
            raw = json.dumps(proof).encode(); (content / 'build-proof.json').write_bytes(raw)
            current = base / 'releases/parent'; current.mkdir(parents=True); (current/'release-manifest.json').write_text(json.dumps({'commit':'parent'})); (base/'current').symlink_to(current)
            c = {'scope':R.SCOPE,'sources':{},'failedPublicationDiagnostic':{'commit':commit,'workflowRunId':run,'buildProofSha256':R.sha(raw),'acceptedCommandId':'original'}}
            d = Mock(); d.run.side_effect=lambda *args: json.dumps([{'Id':'sha256:'+'c'*64,'Config':{}}]) if args[1:3]==('image','inspect') else json.dumps({'files':{},'bare':{'ok':False,'code':'MODULE_NOT_FOUND'}})
            with patch.object(R,'BASE',base),patch.object(R,'utilities',return_value=(Mock(),d)),patch.object(R,'db_state',return_value={'applied':0}):
                result=R.diagnose(c)
                self.assertEqual(result['migration'],{'applied':0});self.assertFalse(result['maintenancePresent'])
                self.assertTrue(result['clientProbe']['filesMatch']);self.assertTrue(result['migrationImage']['identityMatches'])
                self.assertTrue(all(call.args[0]=='docker' and call.args[1] in ('image','run') for call in d.run.call_args_list))
                d.run.side_effect=RuntimeError('image read suppressed')
                partial=R.diagnose(c)
                self.assertEqual(partial['migration'],{'applied':0})
                self.assertEqual(partial['apiImage']['diagnosticError']['exceptionType'],'RuntimeError')
                self.assertEqual(partial['journals'],{'switch-state.json':{},'migration-operation.json':{}})
                with patch.object(R,'db_state',side_effect=KeyError('private detail')):
                    failed=R.diagnose(c)
                    self.assertEqual(failed['diagnosticError'],{'stage':'migration-state','exceptionType':'KeyError','code':'DETAIL_SUPPRESSED'})
                    self.assertFalse(failed['complete'])
                (content/'build-proof.json').write_bytes(raw+b' ')
                with self.assertRaisesRegex(RuntimeError,'DIAGNOSTIC_PROOF_CHANGED'):R.diagnose(c)

    def test_only_the_exact_incremental_migration_state_is_accepted(self):
        c = {'migration': {'sha256': 'a' * 64}}
        R.verify_db({'pending': 0, 'applied': 0, 'checksum': None, 'tables': 0}, c)
        R.verify_db({'pending': 0, 'applied': 1, 'checksum': 'a' * 64, 'tables': 2}, c, True)
        for state in [{'pending': 1, 'applied': 0, 'checksum': None, 'tables': 0},
                {'pending': 0, 'applied': 1, 'checksum': 'b' * 64, 'tables': 2},
                {'pending': 0, 'applied': 0, 'checksum': None, 'tables': 1}]:
            with self.assertRaises(RuntimeError):
                R.verify_db(state, c)

    def test_migration_archive_belongs_to_this_exact_native_run(self):
        proof = {'commit': 'a' * 40, 'workflowRunId': '123', 'migrationTransport': {
            'file': 'window-bitbrowser-migration.tar.gz', 'sha256': 'b' * 64, 'bytes': 1,
            'imageId': 'sha256:' + 'c' * 64,
            'reference': '098208446664.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:' + 'a' * 40 + '-123-window-bitbrowser-migrate'}}
        self.assertEqual(R.verify_migration_transport(proof), proof['migrationTransport'])
        for key, value in [('file', 'recharge-plan-billing-migration.tar.gz'), ('reference', 'unrelated-image'), ('bytes', 0)]:
            with self.assertRaises(RuntimeError):
                R.verify_migration_transport({**proof, 'migrationTransport': {**proof['migrationTransport'], key: value}})

    def test_missing_engine_source_manifest_is_rejected_before_migration(self):
        commit = 'a' * 40
        sources = {'apps/api/src/id-business-v2/online-recharge/engine/' + n: 'b' * 64
            for n in ('credentials.cjs', 'SOURCE_MANIFEST.json')}
        plan = {'commit': commit, 'tree': 'c' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1',
            'contractSha256': R.sha((HERE / R.CONTRACT_FILE).read_bytes()), 'nativeParentCapture': {}}
        files = {**{'source/' + n: v for n, v in sources.items()},
            **{'online-recharge/engine/' + n: 'b' * 64 for n in ('credentials.cjs', 'SOURCE_MANIFEST.json')}}
        proof = {**plan, 'scope': R.SCOPE, 'sources': sources, 'businessActions': 0,
            'baselineApiGroups': {}, 'baselineAdminFiles': {}, 'apiModules': {}, 'prismaClientFiles': {},
            'adminFiles': {}, 'controlSources': {}, 'preservedClientFiles': {}, 'files': files, 'migrationTransport': {
                'file': R.PREFIX + '-migration.tar.gz', 'sha256': 'b' * 64, 'bytes': 1,
                'imageId': 'sha256:' + 'c' * 64,
                'reference': '098208446664.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:' + commit + '-123-window-bitbrowser-migrate'}}
        c = {'sources': sources, 'baseline': {'apiGroups': {'groups': {}}, 'adminFilesSha256': R.sha(R.canonical({})), 'clientFiles': {}, 'preservedClientFiles': {}}}
        self.assertEqual(R.verify_proof(proof, plan, c, files), proof)
        missing = {n: v for n, v in files.items() if n != 'online-recharge/engine/SOURCE_MANIFEST.json'}
        with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE'):
            R.verify_proof({**proof, 'files': missing}, plan, c, missing)

    def test_latest_retired_registration_guard_is_preserved(self):
        fn = R.configured_release({})
        helper = fn.__globals__['load']('recharge-record-release.py')
        self.assertIn('retired_guards', helper.guards.__code__.co_names)
        self.assertIs(fn.__globals__['verify_migration_transport'], R.verify_migration_transport)

    def test_grants_are_confined_to_two_new_tables_and_never_copy_passwords(self):
        d = Mock()
        d.compose.side_effect = lambda *args, **kwargs: json.dumps({'services': {'api': {'environment': {
            'DATABASE_URL': 'mysql://fixture_api:synthetic-private@mysql:3306/fixture_test'}}}}) if args[1:] == ('config', '--format', 'json') else ''
        driver = Mock()
        with patch.object(R, 'load', return_value=driver):
            R.migrate(d, Path('/synthetic'), {}, Path('/synthetic-journal'), 'fixture_test')
        sql = d.compose.call_args.kwargs['input_data']
        self.assertEqual(sql.count('GRANT SELECT, INSERT, UPDATE ON'), 2)
        self.assertIn('online_recharge_bitbrowser_devices', sql)
        self.assertIn('online_recharge_bitbrowser_states', sql)
        self.assertNotIn('DELETE', sql)
        self.assertNotIn('synthetic-private', repr(d.compose.call_args_list))
        driver.migrate.assert_called_once()

    def test_publication_uses_shared_single_release_lock_and_exact_main(self):
        source = (HERE / 'window-bitbrowser-publication.py').read_text()
        workflow = (HERE.parents[1] / '.github/workflows/window-bitbrowser-publication.yml').read_text()
        self.assertIn('group: id-business-v2-production-release', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('github.ref == \'refs/heads/main\'', workflow)
        self.assertGreaterEqual(source.count("refs/heads/main"), 2)
        self.assertIn('ISOLATED_DATABASE_VALIDATION_REQUIRED', source)
        self.assertIn("transport(plan, 'readback')", source)


if __name__ == '__main__':
    unittest.main()
