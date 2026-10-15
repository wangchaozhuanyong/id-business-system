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
dispatch = load('availability_test_dispatch', 'recharge-availability-dispatch.py')


class AvailabilityPublicationTests(unittest.TestCase):
    def test_forward_main_sources_are_fixed_to_their_exact_commit_and_never_join_the_payload(self):
        approved={'apps/api/approved.ts'};foreign='apps/api/excluded.ts';commit='f'*40
        contract={'sourceBaseline':'original','mainOnlySourceBaseline':commit,
                  'mainOnlySources':{foreign:build.digest(b'main-only-source')}}
        def git(*args):
            if args[0]=='show':return b'main-only-source'
            ref,name=args[1],args[-1]
            return b'' if ref=='original' else b'tree-'+name.encode()
        with patch.object(build,'git',side_effect=git),patch.object(build.subprocess,'run',return_value=Mock(returncode=0)):
            build.verify_source_boundary(contract,approved|{foreign},approved)
            with self.assertRaisesRegex(RuntimeError,'SOURCE_SCOPE_CHANGED'):
                build.verify_source_boundary(contract,approved|{foreign,'apps/api/unreviewed.ts'},approved)
            changed=copy.deepcopy(contract);changed['mainOnlySources'][foreign]='unverified'
            with self.assertRaisesRegex(RuntimeError,'MAIN_ONLY_SOURCE_CHANGED'):
                build.verify_source_boundary(changed,approved|{foreign},approved)
            with self.assertRaisesRegex(RuntimeError,'SOURCE_SCOPE_CHANGED'):
                build.verify_source_boundary(contract,{foreign},approved)
        with patch.object(build,'git',side_effect=git),patch.object(build.subprocess,'run',return_value=Mock(returncode=1)):
            with self.assertRaisesRegex(RuntimeError,'MAIN_ONLY_BASE_CHANGED'):
                build.verify_source_boundary(contract,approved|{foreign},approved)

    def test_lock_waits_for_an_existing_publication_and_returns_a_closed_busy_code(self):
        lock=Mock()
        with patch.object(release.fcntl,'flock',side_effect=[BlockingIOError,None]) as flock, \
             patch.object(release.time,'monotonic',side_effect=[0,1]),patch.object(release.time,'sleep') as sleep:
            release.acquire_release_lock(lock)
            self.assertEqual(flock.call_count,2);sleep.assert_called_once_with(1)
        with patch.object(release.fcntl,'flock',side_effect=BlockingIOError), \
             patch.object(release.time,'monotonic',side_effect=[0,61]),patch.object(release.time,'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError,'PUBLICATION_BUSY'):release.acquire_release_lock(lock)
            sleep.assert_not_called()

    def test_published_admin_inventory_keeps_both_generations_of_assets_and_the_actual_index(self):
        c={'publicFiles':{'index.html':'old-index','assets/old.js':'old-asset'},
           'publishedAdminSuccessor':{'publicFiles':{'index.html':'current-index','assets/new.js':'new-asset'}}}
        self.assertEqual(release.published_admin_files(c),{
            'index.html':'current-index','assets/old.js':'old-asset','assets/new.js':'new-asset'})

    def test_successor_archive_rejects_wrong_origin_extra_files_and_changed_static_content(self):
        binding={'sourceCommit':'a'*40,'archiveBytes':0,'archiveSha256':'',
                 'publicFiles':{'index.html':build.digest(b'published-index')},'roleProjection':{'role':'admin'}}
        binding['publicInventorySha256']=build.digest(json.dumps(binding['publicFiles'],sort_keys=True,separators=(',',':')).encode())
        metadata={'commit':binding['sourceCommit'],'roleProjection':binding['roleProjection'],
                  'newStaticFiles':binding['publicFiles'],'newStaticSha256':binding['publicInventorySha256']}
        def bundle(meta,content=b'published-index',extra=False):
            data={'compiled-manifest.json':json.dumps(meta).encode(),'admin/Dockerfile':b'FROM published-base',
                  'admin/dist/index.html':content}
            if extra:data['source/unapproved.ts']=b'unapproved'
            out=io.BytesIO()
            with tarfile.open(fileobj=out,mode='w:gz') as archive:
                for name,raw in data.items():
                    item=tarfile.TarInfo(name);item.size=len(raw);archive.addfile(item,io.BytesIO(raw))
            return out.getvalue()
        raw=bundle(metadata);reviewed={**binding,'archiveBytes':len(raw),'archiveSha256':build.digest(raw)}
        build.verify_successor_archive(raw,reviewed)
        with self.assertRaisesRegex(RuntimeError,'SUCCESSOR_ARCHIVE_CHANGED'):
            build.verify_successor_archive(raw+b'changed',reviewed)
        for value,code in [(bundle({**metadata,'commit':'b'*40}),'SUCCESSOR_MANIFEST_CHANGED'),
                           (bundle(metadata,extra=True),'SUCCESSOR_ARCHIVE_SCOPE_INVALID'),
                           (bundle(metadata,content=b'changed-index'),'SUCCESSOR_STATIC_CHANGED')]:
            changed={**reviewed,'archiveBytes':len(value),'archiveSha256':build.digest(value)}
            with self.assertRaisesRegex(RuntimeError,code):build.verify_successor_archive(value,changed)

    def test_database_reuse_pins_all_api_and_shared_inputs_while_admin_is_validated_separately(self):
        c={'sourceBaseline':'reviewed-base','apiModules':{'api.js':'compiled'},'sources':{
            'apps/api/src/test.ts':'api-source','packages/shared/src/type.ts':'shared-source',
            'apps/admin/src/page.vue':'admin-source'}}
        expected=build.database_inputs(c)
        changed=copy.deepcopy(c);changed['sources']['apps/admin/src/page.vue']='published-admin-repair'
        self.assertEqual(build.database_inputs(changed),expected)
        for path in ('apps/api/src/test.ts','packages/shared/src/type.ts'):
            changed=copy.deepcopy(c);changed['sources'][path]='unverified'
            self.assertNotEqual(build.database_inputs(changed),expected)
        for field in ('sourceBaseline','apiModules'):
            changed=copy.deepcopy(c);changed[field]='unverified'
            self.assertNotEqual(build.database_inputs(changed),expected)

    def test_download_accepts_only_this_exact_compiled_asset_and_never_changes_the_legacy_helper(self):
        commit='a'*40
        url='https://github.com/wangchaozhuanyong/id-business-system/releases/download/recharge-availability-'+commit+'/recharge-availability-artifact.tar.gz'
        response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        response.read.return_value=b'compiled-asset'
        with patch.object(release.urllib.request,'urlopen',return_value=response) as request:
            self.assertEqual(release.download_payload(url,commit),b'compiled-asset')
            request.assert_called_once_with(url,timeout=60)
        for changed in [url+'?other=1',url.replace('recharge-availability-','recharge-record-'),url.replace('id-business-system','another-repository')]:
            with patch.object(release.urllib.request,'urlopen') as request:
                with self.assertRaisesRegex(RuntimeError,'ARTIFACT_LOCATION_INVALID'):release.download_payload(changed,commit)
                request.assert_not_called()
        response.read.return_value=b''
        with patch.object(release.urllib.request,'urlopen',return_value=response),self.assertRaisesRegex(RuntimeError,'ARTIFACT_TOO_LARGE'):
            release.download_payload(url,commit)

    def test_engine_successor_must_extend_the_original_image_without_runtime_changes(self):
        original={'image':'old-image','environmentSha256':'same-env','status':'running','health':'healthy'}
        current={**original,'image':'new-image'}
        before={'RootFS':{'Layers':['reviewed-layer']},'Config':{'Cmd':['node'],'Env':['synthetic-env'],'Labels':{'revision':'old'}}}
        after=copy.deepcopy(before);after['RootFS']['Layers'].append('engine-fix');after['Config']['Labels']['revision']='new'
        d=Mock();d.run.side_effect=[json.dumps([before]),json.dumps([after])]
        release.verify_engine_successor(d,original,current)
        for changed in [dict(after,RootFS={'Layers':['unrelated-layer']}),dict(after,Config={'Cmd':['different-command']})]:
            d.run.side_effect=[json.dumps([before]),json.dumps([changed])]
            with self.assertRaisesRegex(RuntimeError,'ENGINE_BASE_CHANGED'):release.verify_engine_successor(d,original,current)
        d.reset_mock()
        with self.assertRaisesRegex(RuntimeError,'ENGINE_RUNTIME_CHANGED'):
            release.verify_engine_successor(d,original,{**current,'environmentSha256':'changed'})
        d.run.assert_not_called()

    def test_api_admin_and_other_services_cannot_borrow_engine_successor_admission(self):
        engine={'image':'engine','environmentSha256':'same-env','status':'running','health':'healthy'}
        original={n:{'containerId':n} for n in ('api','admin',*release.PRESERVED)}
        original['online-recharge']=engine
        release.verify_service_successor(Mock(),original,copy.deepcopy(original))
        for name in original:
            if name=='online-recharge':continue
            changed=copy.deepcopy(original);changed[name]['containerId']='different-container'
            with self.assertRaisesRegex(RuntimeError,'SERVICES_CHANGED'):
                release.verify_service_successor(Mock(),original,changed)

    def test_override_allows_only_the_actual_engine_image_reference(self):
        original={'services':{'api':{'image':'reviewed-api'},'admin':{'image':'reviewed-admin'},
                             'online-recharge':{'image':'reviewed-engine','network_mode':'service:api'}}}
        current=copy.deepcopy(original);current['services']['online-recharge']['image']='preserved-engine'
        release.verify_override_successor(json.dumps(original),json.dumps(current),'preserved-engine')
        for name,field,value in [('api','image','unreviewed-api'),('admin','ports',['8080:80']),('online-recharge','network_mode','host')]:
            changed=copy.deepcopy(current);changed['services'][name][field]=value
            with self.assertRaisesRegex(RuntimeError,'CONFIGURATION_CHANGED'):
                release.verify_override_successor(json.dumps(original),json.dumps(changed),'preserved-engine')
        with self.assertRaisesRegex(RuntimeError,'ENGINE_REFERENCE_CHANGED'):
            release.verify_override_successor(json.dumps(original),json.dumps(current),'other-image')

    def test_preflight_runtime_receipt_stops_every_later_identity_or_configuration_change(self):
        actual={'current':'/release/current','manifestSha256':'manifest','services':{'online-recharge':{'containerId':'engine'}},'configurationSha256':{'compose.release.json':'config'}}
        release.verify_runtime_receipt(actual,copy.deepcopy(actual))
        for field in actual:
            changed=copy.deepcopy(actual);changed[field]='changed'
            with self.assertRaisesRegex(RuntimeError,'PREFLIGHT_RUNTIME_MOVED'):
                release.verify_runtime_receipt(actual,changed)
        with self.assertRaisesRegex(RuntimeError,'PREFLIGHT_RUNTIME_MOVED'):release.verify_runtime_receipt(actual,None)

    def test_dispatch_freezes_the_original_native_preflight_before_any_switch(self):
        temporary=build.ROOT/'.runtime/recharge-payment-availability-20261015';temporary.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary) as directory:
            output=Path(directory);(output/'preflight-accepted-command.json').write_text(json.dumps({'CommandId':'native-preflight'}))
            frozen={'current':'/release/current','manifestSha256':'reviewed','services':{}}
            observed=[]
            def transport(plan,contract,mode):
                observed.append((copy.deepcopy(plan),mode))
                return {'status':'RECHARGE_AVAILABILITY_PREFLIGHT_VERIFIED','runtimeBaseline':frozen}
            with patch.object(dispatch,'OUTPUT',output),patch.object(dispatch,'prepare_plan',return_value=({'commit':'a'*40},{})),patch.object(dispatch,'transport',side_effect=transport):
                dispatch.publish()
            self.assertEqual([mode for _,mode in observed],['preflight','release','readback'])
            self.assertNotIn('runtimeBaseline',observed[0][0])
            self.assertEqual(observed[1][0]['runtimeBaseline'],frozen)
            self.assertEqual(observed[1][0]['runtimeObservationCommandId'],'native-preflight')
            self.assertEqual(json.loads((output/'publication-plan.json').read_bytes()),observed[1][0])
            with patch.object(dispatch,'OUTPUT',output),patch.object(dispatch,'prepare_plan',return_value=({'commit':'a'*40},{})),patch.object(dispatch,'transport',return_value={'status':'failed'}) as request:
                with self.assertRaisesRegex(RuntimeError,'PREFLIGHT_RECEIPT_INVALID'):dispatch.publish()
                self.assertEqual(request.call_count,1)

    def test_native_logs_are_captured_without_echo_and_only_old_cli_flags_allow_fallback(self):
        raw=b'\x1b[32m7 passed\x1b[0m\n25 passed'
        success=Mock(returncode=0,stdout=raw,stderr=b'')
        unsupported=Mock(returncode=1,stdout=b'',stderr=b'unknown flag: --allow-escape-sequences')
        with patch.object(build.subprocess,'run',return_value=success) as request:
            self.assertEqual(build.platform_log_bytes('actions/jobs/8/logs'),raw)
            self.assertTrue(request.call_args.kwargs['capture_output'])
            self.assertIn('--allow-escape-sequences',request.call_args.args[0])
        with patch.object(build.subprocess,'run',side_effect=[unsupported,success]) as request:
            self.assertEqual(build.platform_log_bytes('actions/jobs/8/logs'),raw)
            self.assertEqual(request.call_count,2)
            self.assertNotIn('--allow-escape-sequences',request.call_args.args[0])
        with patch.object(build.subprocess,'run',return_value=Mock(returncode=1,stdout=b'',stderr=b'permission denied')) as request:
            with self.assertRaisesRegex(RuntimeError,'DATABASE_LOG_REQUEST_FAILED'):build.platform_log_bytes('actions/jobs/8/logs')
            self.assertEqual(request.call_count,1)
        with patch.object(build.subprocess,'run') as request:
            with self.assertRaisesRegex(RuntimeError,'DATABASE_LOG_PATH_INVALID'):build.platform_log_bytes('actions/artifacts/8/zip')
            request.assert_not_called()

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
        def verify(c=contract,n=native,j=jobs,a=artifact,z=raw,log=b'7 passed\n25 passed',g=git,source_error=None):
            with patch.object(build,'git',side_effect=g),patch.object(build,'platform_json',side_effect=[n,j,a]),patch.object(build,'platform_bytes',return_value=z),patch.object(build,'platform_log_bytes',return_value=log),patch.object(build,'verify_sources',side_effect=source_error) as source_gate:
                value=build.verify_database_evidence(c)
                source_gate.assert_called_once_with(c)
                return value
        self.assertEqual(verify()['testsPassed'],32)
        with self.assertRaisesRegex(RuntimeError,'SOURCE_SCOPE_CHANGED'):
            verify(source_error=RuntimeError('RECHARGE_AVAILABILITY_SOURCE_SCOPE_CHANGED'))
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
        self.assertEqual(contract['expectedCurrent'], '4aa49436239ab57e9deb3b5890e645ceeef25149')
        self.assertEqual(contract['sourceBaseline'], '04aa234505adccfe295776245b88fc56feac0588')
        self.assertEqual(contract['publishedAdminSuccessor']['sourceCommit'],contract['expectedCurrent'])
        self.assertEqual(len(contract['publishedAdminSuccessor']['repairSources']),1)
        self.assertEqual(len(contract['publishedAdminAncestor']['repairSources']),9)
        self.assertEqual(contract['publishedAdminAncestor']['sourceCommit'], '7f419903e9335c00524f5065f46920e8f24f2722')
        self.assertEqual(contract['mainOnlySourceBaseline'],'970e0a05f2ca340a3b62f7083f6866e3c0c0fcdf')
        self.assertEqual(len(contract['mainOnlySources']),56)
        self.assertFalse(set(contract['mainOnlySources']) & set(contract['sources']))
        self.assertIn('apps/api/prisma-mysql/schema.prisma',contract['mainOnlySources'])
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

    def test_successor_native_proof_and_both_original_archives_are_required(self):
        temporary=build.ROOT/'.runtime/recharge-payment-availability-20261015'
        with tempfile.TemporaryDirectory(dir=temporary) as directory:
            root=Path(directory);contract,plan,proof=self.fixture(root)
            for name,raw in [('baseline-admin-successor-native.tar.gz',b'compiled-predecessor'),
                             ('baseline-admin-successor-quality-native.zip',b'native-quality-evidence')]:
                (root/name).write_bytes(raw)
            files=build.inventory(root)
            contract['publishedAdminSuccessor']={'sourceCommit':'a'*40,'sourceTree':'b'*40,
                'archiveSha256':files['baseline-admin-successor-native.tar.gz'],'publicInventorySha256':'c'*64,
                'roleProjection':{'inputSha256':'d'*64},'quality':{'runId':1,
                    'artifactDigest':'sha256:'+files['baseline-admin-successor-quality-native.zip']}}
            proof['files']=files
            proof['baselineAdminSuccessorVerification']=build.successor_receipt(contract)
            self.assertEqual(proof['baselineAdminSuccessorVerification'],release.successor_receipt(contract))
            helper=Mock(file_inventory=build.inventory)
            release.validate_proof(proof,plan,contract,root,helper)
            changed=copy.deepcopy(proof);changed['baselineAdminSuccessorVerification']['verified']=False
            with self.assertRaisesRegex(RuntimeError,'SUCCESSOR_PROOF_INVALID'):
                release.validate_proof(changed,plan,contract,root,helper)
            (root/'baseline-admin-successor-native.tar.gz').write_bytes(b'changed-predecessor')
            proof['files']=build.inventory(root)
            with self.assertRaisesRegex(RuntimeError,'SUCCESSOR_PAYLOAD_CHANGED'):
                release.validate_proof(proof,plan,contract,root,helper)

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
