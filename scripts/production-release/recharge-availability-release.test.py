import copy
import importlib.util
import io
import zipfile
import json
from pathlib import Path
import tempfile
import tarfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load('availability_test_release', 'recharge-availability-release.py')
build = load('availability_test_build', 'recharge-availability-build.py')


class AvailabilityPublicationTests(unittest.TestCase):
    def test_database_reuse_requires_native_success_and_identical_source_commands_environment_and_artifact(self):
        name='apps/api/src/id-business-v2/auto-recharge/recharge-availability.ts'
        content=(build.ROOT/name).read_bytes()
        old={'sourceBaseline':'b'*40,'sources':{name:build.digest(content)},'apiModules':{'fixture.js':None}}
        old_raw=json.dumps(old).encode()
        path='.github/workflows/recharge-availability-validation.yml'
        workflow=(build.ROOT/path).read_bytes()
        proof={'commit':'c'*40,'tree':'e'*40,'workflowRunId':'9','workflowRunAttempt':'1','contractSha256':build.digest(old_raw)}
        def bundle(source=content):
            tar=io.BytesIO()
            with tarfile.open(fileobj=tar,mode='w:gz') as archive:
                for n,raw in [('payload/build-proof.json',json.dumps(proof).encode()),('payload/source/'+name,source)]:
                    item=tarfile.TarInfo(n);item.size=len(raw);archive.addfile(item,io.BytesIO(raw))
            data=tar.getvalue();zipped=io.BytesIO()
            with zipfile.ZipFile(zipped,'w') as archive:
                archive.writestr('recharge-availability-artifact.tar.gz',data)
                archive.writestr('artifact-sha256.txt',build.digest(data))
            return zipped.getvalue()
        raw=bundle()
        binding={'sourceCommit':'c'*40,'runId':9,'workflowSha256':build.digest(workflow),'artifactId':7,
                 'artifactName':'original-validated-source','artifactDigest':'sha256:'+build.digest(raw)}
        contract={**old,'databaseValidationNative':binding}
        native={'head_sha':'c'*40,'head_branch':'main','status':'completed','event':'workflow_dispatch','path':path,'run_attempt':1}
        jobs={'jobs':[{'name':'validate','id':8,'conclusion':'success','steps':[
            {'name':'Migrate only the disposable runner database','conclusion':'success'},
            {'name':'Verify availability queries, locking, idempotency and audit rollback in isolated MySQL','conclusion':'success'}]}]}
        artifact={'artifacts':[{'id':7,'name':binding['artifactName'],'expired':False,'digest':binding['artifactDigest']}]}
        def git(*args):
            if args[0]=='rev-parse':return ('e'*40).encode()
            suffix=args[1].split(':',1)[1]
            if suffix.endswith('contract.json'):return old_raw
            if suffix==path:return workflow
            return (build.ROOT/suffix).read_bytes()
        def verify(c=contract,n=native,j=jobs,a=artifact,z=raw,log=b'7 passed\n25 passed',g=git):
            with patch.object(build,'git',side_effect=g),patch.object(build,'platform_json',side_effect=[n,j,a]),patch.object(build,'platform_bytes',side_effect=[z,log]):
                return build.verify_database_evidence(c)
        self.assertEqual(verify()['testsPassed'],32)
        for changed in [{**contract,'sourceBaseline':'f'*40},{**contract,'sources':{name:'0'*64}}]:
            with self.assertRaisesRegex(RuntimeError,'DATABASE_INPUTS_CHANGED'):verify(c=changed)
        with self.assertRaisesRegex(RuntimeError,'DATABASE_COMMANDS_CHANGED'):
            verify(c={**contract,'databaseValidationNative':{**binding,'workflowSha256':'0'*64}})
        for previous in [workflow.replace(b'MYSQL_ROOT_HOST: \'%\'',b'MYSQL_ROOT_HOST: localhost'),
                         workflow.replace(b'run: npm run prisma:mysql:migrate:deploy',b'run: npm run different-migration')]:
            self.assertNotEqual(previous,workflow)
            def previous_workflow(*args):
                return previous if args[0]=='show' and args[1].endswith(':'+path) else git(*args)
            with self.assertRaisesRegex(RuntimeError,'DATABASE_COMMANDS_CHANGED'):
                verify(c={**contract,'databaseValidationNative':{**binding,'workflowSha256':build.digest(previous)}},g=previous_workflow)
        def changed_preparation(*args):
            value=git(*args)
            if args[0]=='show' and args[1].endswith(':scripts/production-release/recharge-availability-build.py'):
                value=value.replace(b"run('npm', 'ci', '--no-audit'",b"run('npm', 'install', '--no-audit'")
            return value
        with self.assertRaisesRegex(RuntimeError,'DATABASE_PREPARATION_CHANGED'):verify(g=changed_preparation)
        with self.assertRaisesRegex(RuntimeError,'DATABASE_RUN_CHANGED'):verify(n={**native,'head_sha':'f'*40})
        failed=copy.deepcopy(jobs);failed['jobs'][0]['conclusion']='failure'
        with self.assertRaisesRegex(RuntimeError,'DATABASE_VALIDATION_NOT_SUCCESSFUL'):verify(j=failed)
        skipped=copy.deepcopy(jobs);skipped['jobs'][0]['steps'][1]['conclusion']='skipped'
        with self.assertRaisesRegex(RuntimeError,'DATABASE_VALIDATION_NOT_SUCCESSFUL'):verify(j=skipped)
        with self.assertRaisesRegex(RuntimeError,'DATABASE_ARTIFACT_DIGEST_CHANGED'):verify(z=raw+b'changed')
        changed_raw=bundle(b'changed-source'); changed_binding={**binding,'artifactDigest':'sha256:'+build.digest(changed_raw)}
        changed_artifact=copy.deepcopy(artifact);changed_artifact['artifacts'][0]['digest']=changed_binding['artifactDigest']
        with self.assertRaisesRegex(RuntimeError,'DATABASE_TESTED_SOURCE_CHANGED'):
            verify(c={**contract,'databaseValidationNative':changed_binding},a=changed_artifact,z=changed_raw)
        with self.assertRaisesRegex(RuntimeError,'DATABASE_TEST_COUNTS_CHANGED'):verify(log=b'7 skipped\n25 passed')

    def test_original_native_admin_evidence_requires_exact_run_commands_artifact_and_live_bytes(self):
        workflow=b'synthetic-reviewed-workflow'
        content=b'synthetic-published-index'
        buf=io.BytesIO()
        with zipfile.ZipFile(buf,'w') as z:z.writestr('apps/admin/dist/index.html',content)
        raw=buf.getvalue()
        binding={'runId':9,'sourceCommit':'c'*40,'artifactId':7,'artifactName':'reviewed-admin',
                 'artifactDigest':'sha256:'+build.digest(raw),'workflowPath':'.github/workflows/reviewed.yml','workflowSha256':build.digest(workflow)}
        contract={'sourceBaseline':'c'*40,'publishedAdminNative':binding,'publicFiles':{'index.html':build.digest(content)}}
        run={'head_sha':'c'*40,'status':'completed','conclusion':'success','path':binding['workflowPath'],'event':'push','run_attempt':1}
        jobs={'jobs':[{'name':'validate','conclusion':'success','steps':[{'name':'Build Admin with Vue TypeScript checking','conclusion':'success'}]}]}
        artifacts={'artifacts':[{'id':7,'name':'reviewed-admin','expired':False,'digest':binding['artifactDigest']}]}
        def verify(run_value=run,job_value=jobs,artifact_value=artifacts,bytes_value=raw,contract_value=contract):
            with patch.object(build,'platform_json',side_effect=[run_value,job_value,artifact_value]),patch.object(build,'platform_bytes',return_value=bytes_value),patch.object(build,'git',return_value=workflow):
                return build.verify_published_admin(contract_value)
        self.assertEqual(verify()[0],raw)
        for value in [{**run,'head_sha':'d'*40},{**run,'conclusion':'failure'},{**run,'run_attempt':2}]:
            with self.assertRaisesRegex(RuntimeError,'PUBLISHED_ADMIN_RUN_CHANGED'):verify(run_value=value)
        with self.assertRaisesRegex(RuntimeError,'PUBLISHED_ADMIN_BUILD_NOT_SUCCESSFUL'):verify(job_value={'jobs':[]})
        with self.assertRaisesRegex(RuntimeError,'PUBLISHED_ADMIN_ARTIFACT_CHANGED'):verify(artifact_value={'artifacts':[]})
        with self.assertRaisesRegex(RuntimeError,'PUBLISHED_ADMIN_DIGEST_CHANGED'):verify(bytes_value=raw+b'changed')
        with self.assertRaisesRegex(RuntimeError,'PUBLISHED_ADMIN_CONTENT_CHANGED'):verify(contract_value={**contract,'publicFiles':{'index.html':'0'*64}})

        # Preserve the exact already-published Admin artifact when its native
        # run failed only a separately recorded pricing test after that build.
        recorded = {**binding, 'runConclusion': 'failure', 'validationConclusion': 'failure',
                    'failedValidationSteps': ['Verify exact pricing tier selection']}
        published_run = {**run, 'conclusion': 'failure'}
        published_jobs = copy.deepcopy(jobs)
        published_jobs['jobs'][0]['conclusion'] = 'failure'
        published_jobs['jobs'][0]['steps'].append({'name': 'Verify exact pricing tier selection', 'conclusion': 'failure'})
        published_contract = {**contract, 'publishedAdminNative': recorded}
        self.assertEqual(verify(published_run, published_jobs, contract_value=published_contract)[0], raw)
        published_jobs['jobs'][0]['steps'][0]['conclusion'] = 'failure'
        with self.assertRaisesRegex(RuntimeError, 'PUBLISHED_ADMIN_BUILD_NOT_SUCCESSFUL'):
            verify(published_run, published_jobs, contract_value=published_contract)

    def test_new_release_override_never_writes_through_shared_configuration_symlink(self):
        temporary = build.ROOT / '.runtime/recharge-payment-availability-20261015'
        temporary.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary) as directory:
            root = Path(directory)
            shared = root / 'shared-compose.json'
            original = b'{"services":{"api":{"image":"existing"}}}\n'
            shared.write_bytes(original)
            target = root / 'release'
            target.mkdir()
            link = target / 'compose.release.json'
            link.symlink_to(shared)
            value = {'services': {'api': {'image': 'approved-candidate'}}}
            release.write_release_override(link, value)
            self.assertFalse(link.is_symlink())
            self.assertEqual(json.loads(link.read_bytes()), value)
            self.assertEqual(shared.read_bytes(), original)
            self.assertEqual(link.stat().st_mode & 0o777, 0o600)

    def test_published_baseline_bytes_can_be_merged_but_other_application_drift_cannot(self):
        name='apps/api/src/id-business-v2/auto-recharge/recharge-availability.ts'
        extra='apps/api/src/id-business-v2/online-recharge/already-published.ts'
        contract={'reviewBase':'a'*40,'sourceBaseline':'b'*40,'sources':{name:build.digest((build.ROOT/name).read_bytes())}}
        def git_result(*args):
            if args[0]=='status':return b''
            if args[0]=='diff':return (name+'\n'+extra+'\n').encode()
            if args[0]=='show':return (build.ROOT/'package-lock.json').read_bytes()
            if args[0]=='ls-tree':return b'100644 blob fixed-published-bytes\tpath'
            raise AssertionError(args)
        with patch.object(build,'git',side_effect=git_result):
            build.verify_sources(contract)
        def drift(*args):
            if args[0]=='ls-tree' and args[1]=='HEAD':return b'100644 blob unreviewed-bytes\tpath'
            return git_result(*args)
        with patch.object(build,'git',side_effect=drift), self.assertRaisesRegex(RuntimeError,'SOURCE_SCOPE_CHANGED'):
            build.verify_sources(contract)

    def test_image_context_is_readable_by_existing_nonroot_runtime_without_changing_content(self):
        temporary = build.ROOT / '.runtime/recharge-payment-availability-20261015'
        temporary.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary) as directory:
            root=Path(directory)
            module=root/'modules/id-business-v2/auto-recharge/classifier.js'
            module.parent.mkdir(parents=True,mode=0o700)
            module.write_bytes(b'synthetic-content')
            module.chmod(0o600)
            before=build.inventory(root)
            release.normalize_image_context(root)
            self.assertEqual(build.inventory(root),before)
            self.assertEqual(module.stat().st_mode & 0o777,0o644)
            self.assertEqual(module.parent.stat().st_mode & 0o777,0o755)
            (root/'link').symlink_to(module)
            with self.assertRaisesRegex(RuntimeError,'IMAGE_CONTEXT_PATH_INVALID'):
                release.normalize_image_context(root)

    def test_build_excludes_incremental_cache_but_never_unrelated_executable_changes(self):
        name = 'id-business-v2/auto-recharge/fixture'
        modules = {name + '.js': None}
        before = {'tsconfig.build.tsbuildinfo': 'old-cache', 'other.js': 'same', 'other.d.ts': 'old-type'}
        after = {'tsconfig.build.tsbuildinfo': 'new-cache', 'other.js': 'same', 'other.d.ts': 'new-type',
                 **{name + ext: 'new-module' for ext in ('.js', '.js.map', '.d.ts')}}
        self.assertEqual(build.verify_api_outputs(before, after, modules), {name + ext for ext in ('.js', '.js.map', '.d.ts')})
        with self.assertRaisesRegex(RuntimeError, 'API_OUTPUT_SCOPE_CHANGED'):
            build.verify_api_outputs(before, {**after, 'other.js': 'changed'}, modules)
        with self.assertRaisesRegex(RuntimeError, 'API_OUTPUT_MISSING'):
            build.verify_api_outputs(before, {k:v for k,v in after.items() if k != name+'.d.ts'}, modules)

    def test_contract_only_replaces_reviewed_recharge_modules_and_no_schema(self):
        contract = json.loads((HERE / 'recharge-availability-contract.json').read_bytes())
        self.assertEqual(contract['scope'], 'RECHARGE_PAYMENT_AVAILABILITY_ONLY')
        self.assertEqual(contract['expectedCurrent'], '04aa234505adccfe295776245b88fc56feac0588')
        for name in contract['sources']:
            self.assertTrue(name.startswith(('apps/admin/src/v2/features/auto-recharge/',
                'apps/api/src/id-business-v2/auto-recharge/', 'packages/shared/src/v2/auto-recharge.ts', 'docs/')))
            self.assertEqual(build.digest((build.ROOT / name).read_bytes()), contract['sources'][name])
        self.assertFalse(any('prisma' in name or name.endswith('package-lock.json') for name in contract['sources']))
        self.assertTrue(all(name.startswith('id-business-v2/auto-recharge/') and name.endswith('.js') for name in contract['apiModules']))
        self.assertEqual(set(release.PRESERVED), {'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'})

    def fixture(self, root):
        api = 'id-business-v2/auto-recharge/fixture.js'
        source = 'apps/api/src/id-business-v2/auto-recharge/fixture.ts'
        paths = ['api/modules/' + api.removesuffix('.js') + ext for ext in ('.js', '.js.map', '.d.ts')]
        paths += ['source/' + source, 'admin/html/index.html','baseline-admin-native.zip']
        paths += ['admin/html/assets/fixture-' + str(i) + '.css' for i in range(250)]
        for name in paths:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'synthetic-content')
        files = build.inventory(root)
        contract = {'scope': 'RECHARGE_PAYMENT_AVAILABILITY_ONLY', 'apiModules': {api: None},
                    'sources': {source: files['source/' + source]},
                    'publicFiles':{n.removeprefix('admin/html/'):v for n,v in files.items() if n.startswith('admin/html/')},
                    'publishedAdminNative':{'artifactDigest':'sha256:'+files['baseline-admin-native.zip']},
                    'databaseValidationNative':{'runId':9,'sourceCommit':'c'*40}}
        plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '1', 'workflowRunAttempt': '1', 'contractSha256': 'c' * 64}
        proof = {'version': 1, 'scope': contract['scope'], **plan, 'baselineApiReproduced': True,
                 'baselineAdminArtifactVerified': True,
                 'databaseVerification':{**contract['databaseValidationNative'],'verified':True,'reused':True,'testsPassed':32},
                 'baselineAdminVerification':{**contract['publishedAdminNative'],'verified':True,'publicInventorySha256':build.digest(json.dumps(contract['publicFiles'],sort_keys=True,separators=(',',':')).encode())}, 'updatedServices': ['api', 'admin'], 'migrationPerformed': False,
                 'businessActions': 0, 'files': files,
                 'apiModules': {n.removeprefix('api/modules/'): v for n, v in files.items() if n.startswith('api/modules/')},
                 'adminFiles': {n.removeprefix('admin/html/'): v for n, v in files.items() if n.startswith('admin/html/')}}
        return contract, plan, proof

    def test_proof_rejects_changed_identity_failed_reproduction_or_business_actions(self):
        temporary = build.ROOT / '.runtime/recharge-payment-availability-20261015'
        temporary.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary) as directory:
            root = Path(directory)
            contract, plan, proof = self.fixture(root)
            helper = Mock(file_inventory=build.inventory)
            self.assertEqual(release.validate_proof(proof, plan, contract, root, helper), proof)
            for field, value in [('commit', 'd' * 40), ('tree', 'e' * 40), ('workflowRunId', '2'),
                                 ('baselineApiReproduced', False), ('baselineAdminArtifactVerified', False), ('databaseVerification', {}),
                                 ('businessActions', 1), ('migrationPerformed', True), ('updatedServices', ['api', 'online-recharge'])]:
                with self.subTest(field=field):
                    changed = {**proof, field: value}
                    with self.assertRaisesRegex(RuntimeError, 'PROOF_INVALID'):
                        release.validate_proof(changed, plan, contract, root, helper)

    def test_payload_rejects_content_mutation_and_unsigned_extra_api_module(self):
        temporary = build.ROOT / '.runtime/recharge-payment-availability-20261015'
        temporary.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary) as directory:
            root = Path(directory)
            contract, plan, proof = self.fixture(root)
            helper = Mock(file_inventory=build.inventory)
            path = root / 'api/modules/id-business-v2/auto-recharge/fixture.js'
            path.write_bytes(b'changed-content')
            with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_CHANGED'):
                release.validate_proof(proof, plan, contract, root, helper)
            path.write_bytes(b'synthetic-content')
            extra = root / 'api/modules/id-business-v2/unrelated.js'
            extra.write_bytes(b'unsigned-content')
            with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_CHANGED'):
                release.validate_proof(proof, plan, contract, root, helper)
            changed = copy.deepcopy(proof)
            changed['files'] = build.inventory(root)
            changed['apiModules']['id-business-v2/unrelated.js'] = build.digest(extra.read_bytes())
            with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_INVALID'):
                release.validate_proof(changed, plan, contract, root, helper)

    def test_module_probe_rejects_any_predecessor_drift_with_read_only_command(self):
        d = Mock()
        modules = {'id-business-v2/auto-recharge/fixture.js': 'a' * 64}
        d.compose.return_value = json.dumps(modules)
        release.verify_modules(d, Path('/fixture'), modules)
        d.compose.return_value = json.dumps({**modules, 'unexpected': 'b' * 64})
        with self.assertRaisesRegex(RuntimeError, 'API_CONTENT_CHANGED'):
            release.verify_modules(d, Path('/fixture'), modules)
        self.assertEqual(d.compose.call_args.args[1:5], ('exec', '-T', 'api', 'node'))
        self.assertIn('readFileSync', d.compose.call_args.args[-1])
        self.assertNotIn('writeFile', d.compose.call_args.args[-1])


if __name__ == '__main__':
    unittest.main()
