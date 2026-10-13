"""Exact source projection and offline Admin publication; no production traffic."""
import copy
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('admin_adapter', Path(__file__).with_name('admin-pending-online-release.py'))
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
d = a.controller_module()
RUNTIME = ROOT / '.runtime/bitbrowser-confirm-expiry-20261014/release/admin-tests'
RUNTIME.mkdir(parents=True, exist_ok=True)


def git_files(commit):
    raw = subprocess.check_output(['git', 'archive', '--prefix=id-business-system-' + commit + '/', commit], cwd=ROOT)
    return d.registration_archive(raw, commit)


class ProjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.commit = 'f36bea8f914e0a56e18ab5a44adcdee308024690'
        cls.files = git_files(cls.commit)
        p = a.projection_module(); cls.p = p
        cls.baseline, cls.online = git_files(p.BASELINE_COMMIT), git_files(p.ONLINE_COMMIT)
        cls.tree = p.source_tree(cls.files)

    def test_exact_partial_projection_retains_all_other_bytes_and_source_identity(self):
        output, record, runtime = a.project_admin(self.files, self.baseline, self.online, self.commit, self.tree)
        self.assertEqual(record['candidateCommit'], self.commit)
        self.assertEqual(record['candidateTree'], self.tree)
        self.assertEqual(set(record['generatedFiles']), set(a.ADMIN_FILES))
        self.assertEqual(set(runtime), set(self.p.RUNTIME_FILES))
        for name, value in self.files.items():
            if name not in a.ADMIN_FILES and not name.startswith(a.ADMIN_DIRECTORY):
                self.assertEqual(output[name], value, name)
        self.assertFalse(any(n.startswith(a.ADMIN_DIRECTORY) for n in output))
        for name in ('apps/admin/src/v2-router.ts', 'apps/admin/src/v2/features/registry.ts'):
            self.assertNotIn(b'online-recharge', output[name][0])
        for name in self.p.RUNTIME_FILES:
            self.assertEqual(output[name], self.files[name])
            self.assertEqual(runtime[name], self.baseline[name])
        self.assertEqual(record['projectionSha256'], a.fingerprint({k:v for k,v in record.items() if k!='projectionSha256'}))

    def test_control_and_connector_carry_allowed_but_unreviewed_frontend_and_build_inputs_rejected(self):
        files = dict(self.files); files['scripts/production-release/new-reviewed-control.py'] = (b'# fixture\n', '100644')
        files['apps/api/src/id-business-v2/auto-recharge/worker/fixture.py'] = (b'# fixture\n', '100644')
        a.project_admin(files, self.baseline, self.online, 'a'*40, self.p.source_tree(files))
        for name in ('apps/admin/src/v2/features/registry.ts', 'packages/shared/src/v2/data-scopes.ts', 'tsconfig.base.json', 'package-lock.json'):
            files = dict(self.files); raw,mode = files[name]; files[name] = (raw+b'\n',mode)
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'UNREVIEWED_ADMIN_SOURCE'):
                a.project_admin(files,self.baseline,self.online,'a'*40,self.p.source_tree(files))

    def test_wrong_candidate_or_immutable_reference_is_rejected(self):
        with self.assertRaises(RuntimeError):
            a.project_admin(self.files,self.baseline,self.online,'a'*40,'b'*40)
        bad = dict(self.online); name = a.ADMIN_FILES[0]; raw,mode = bad[name]; bad[name] = (raw+b'\n',mode)
        with self.assertRaises(RuntimeError):
            a.project_admin(self.files,self.baseline,bad,self.commit,self.tree)


class PrivateReadTests(unittest.TestCase):
    def test_first_read_updates_access_time_without_false_failure(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as root:
            p = Path(root)/'record'; p.write_bytes(b'{"fixture":true}'); p.chmod(0o600)
            os.utime(p,(1,1)); self.assertEqual(a.private_bytes(p),b'{"fixture":true}')
            self.assertEqual(a.read_json(p),{'fixture':True})

    def test_links_public_modes_oversize_duplicates_and_changed_identity_rejected(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as root:
            p = Path(root)/'record'; p.write_bytes(b'{"x":1,"x":2}'); p.chmod(0o600)
            with self.assertRaises(RuntimeError): a.read_json(p)
            p.chmod(0o644)
            with self.assertRaises(RuntimeError): a.private_bytes(p)
            p.chmod(0o600)
            with self.assertRaises(RuntimeError): a.private_bytes(p,cap=1)
            link = Path(root)/'link'; link.symlink_to(p)
            with self.assertRaises(RuntimeError): a.read_json(link)
            original = a.os.fstat
            count=[0]
            def changed(fd):
                row=original(fd); count[0]+=1
                if count[0]==2:
                    return SimpleNamespace(**{name:getattr(row,name)+(1 if name=='st_mtime_ns' else 0) for name in (
                        'st_dev','st_ino','st_mode','st_nlink','st_uid','st_gid','st_size','st_mtime_ns','st_ctime_ns')})
                return row
            with patch.object(a.os,'fstat',side_effect=changed),self.assertRaises(RuntimeError): a.private_bytes(p)


class PublicationTests(unittest.TestCase):
    def fixture(self, root, *, fault=None):
        base=Path(root).resolve(); previous=base/'releases'/'B'; previous.mkdir(parents=True)
        (base/'current').symlink_to(previous)
        args=SimpleNamespace(commit='a'*40,source_tree='b'*40,run_id='123',run_attempt='1',ci_run_id='111',expected_current=a.BASELINE,repository=a.REPOSITORY)
        runtime={name:(('projected:'+name).encode(),'100644')for name in a.projection_module().RUNTIME_FILES}
        candidate={name:(('raw:'+name).encode(),'100644')for name in runtime}
        candidate['deploy/caddy/Caddyfile.aws']=(b'unchanged Caddy\n','100644')
        for name,(raw,_mode)in runtime.items():
            p=previous/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
            p=previous/'.deploy/production-release/pending-original-source'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(candidate[name][0]);p.chmod(0o600)
        p=previous/'deploy/caddy/Caddyfile.aws';p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(candidate['deploy/caddy/Caddyfile.aws'][0])
        env=previous/'.env.aws.production';env.write_bytes(b'APP_PUBLIC_URL=https://fixture.invalid\n');env.chmod(0o600)
        states={name:{'image':'sha256:'+a.digest(name.encode()),'reference':'fixture:'+name,'status':'running','health':None if name=='caddy'else'healthy','containerId':a.digest(('container:'+name).encode()),'startedAtSha256':'1'*64,'environmentSha256':'2'*64}for name in d.ALL_SERVICES}
        original=copy.deepcopy(states)
        manifest={'commit':a.BASELINE,'sourceTree':'c'*40,'images':{n:{'digest':s['image'],'reference':s['reference']}for n,s in states.items()},'apiWorkspacePublication':{'version':4,'onlinePublished':False,'migrationPerformed':False,'volume':{'name':'fixture_sqlite'}},'pendingOnlineMigration':{'fixture':'B original pending'},'preservedMigrationOrigin':{'fixture':'A original'}}
        a.write_json(previous/'release-manifest.json',manifest)
        a.write_json(previous/'compose.release.json',{'services':{n:{'image':s['reference'],'pull_policy':'never'}for n,s in states.items()}})
        expected={'version':1,'scope':'ADMIN_PENDING_ONLINE_BUILD_PROJECTION','candidateCommit':args.commit,'candidateTree':args.source_tree,'runtimeFiles':{n:{'sha256':a.digest(row[0]),'mode':row[1]}for n,row in runtime.items()}}
        expected['projectionSha256']=a.fingerprint(expected)
        image={'reference':f'{a.REPOSITORY}:{args.commit}-123-1-admin','imageId':'sha256:'+'f'*64}
        proof={'version':1,'scope':'ADMIN_PENDING_ONLINE_BUILD','commit':args.commit,'sourceTree':args.source_tree,'runId':'123','runAttempt':'1','qualityRunId':'111','projection':expected,'image':image}
        actions=[]; rollback=[]; audit_calls=[]
        def compose(directory,*parts,**kw):
            actions.append(('compose',parts))
            if parts==('ps','-q','api'):return states['api']['containerId']
            if parts==('config','--format','json'):
                return json.dumps({'services':{'caddy':{'image':original['caddy']['reference']}}})
            if parts[:2]==('up','-d'):
                self.assertEqual(parts[-1],'admin');states['admin'].update(image=image['imageId'],reference=image['reference'],containerId='3'*64)
                if fault=='preserved_env':states['api']['environmentSha256']='4'*64
                if fault=='edge':(directory/'deploy/caddy/Caddyfile.aws').write_bytes(b'changed edge')
                if fault=='env':(directory/'.env.aws.production').write_bytes(b'APP_PUBLIC_URL=https://changed.invalid\n')
                return ''
            raise AssertionError(parts)
        def run(*parts,**kw):
            actions.append(parts)
            if parts[:3]==('docker','volume','inspect'):return json.dumps([{'Name':'fixture_sqlite','Mountpoint':'/fixture-volume','Driver':'local'}])
            if parts[:2]==('docker','inspect'):
                return json.dumps([{'Id':states['api']['containerId'],'Mounts':[{'Type':'volume','Name':'wrong'if fault=='mount'else'fixture_sqlite','Destination':'/app/.runtime/auto-registration','Source':'/fixture-volume','RW':True}]}])
            if parts[:3]==('aws','ecr','get-login-password'):return 'synthetic-only'
            if parts[:2]==('docker','pull'):return ''
            if parts[:3]==('docker','image','inspect'):
                if parts[3]==original['caddy']['reference']:
                    return json.dumps([{'Id':original['caddy']['image'],'RepoDigests':['caddy@'+original['caddy']['reference'].split('@',1)[1]]}])
                return json.dumps([{'Id':image['imageId'],'Architecture':'amd64','Config':{'Labels':{'org.opencontainers.image.revision':args.commit,'id-business-v2.source-tree':args.source_tree,'id-business-v2.admin-pending-projection-sha256':expected['projectionSha256']}}}])
            raise AssertionError(parts)
        def audit(directory,receipt,**kw):
            self.assertEqual(kw,{'api_admin_only':True});audit_calls.append(str(receipt))
            if fault in ('audit','restore')and len(audit_calls)==2:raise RuntimeError('ADMIN_PENDING_AUDIT_FAILED')
            a.write_json(receipt,{'ok':True,'violationCount':0});return {'checkCount':49,'violationCount':0}
        def restore(previous,target,name,before):
            self.assertEqual(name,'admin');rollback.append(name)
            if fault=='restore':raise RuntimeError('synthetic restore unavailable')
            states['admin']=copy.deepcopy(original['admin'])
        def point(directory,suffix):
            link=base/('new-'+suffix);link.symlink_to(directory);os.replace(link,base/'current')
        def fetch(url,**kw):
            body=(f'<head><meta name="v2-build-id" content="v2-{args.commit}"/></head>').encode()
            response=io.BytesIO(body if url.endswith('/')else b'ready');response.status=200;return response
        controller=SimpleNamespace(BASE=base,ALL_SERVICES=d.ALL_SERVICES,production_services=lambda path:d.ALL_SERVICES,
            service_state=lambda path,name,**kw:copy.deepcopy(states[name]),run=run,compose=compose,
            write_registration_files=d.write_registration_files,migration_plan=d.migration_plan,
            subprocess=SimpleNamespace(run=lambda *x,**kw:SimpleNamespace(returncode=0)),
            shutil=SimpleNamespace(disk_usage=lambda path:SimpleNamespace(free=8*1024**3)),
            audit=audit,fresh_backup=lambda prev:{'name':'synthetic.sql.gz','s3Verified':True},
            assert_release_jobs_idle=lambda path,names:self.assertEqual(names,('admin',)),wait_healthy=lambda *x:None,
            rollback_service=restore,point_current=point,environment_values=d.environment_values,
            urllib=SimpleNamespace(request=SimpleNamespace(urlopen=fetch)))
        return SimpleNamespace(base=base,previous=previous,args=args,controller=controller,proof=proof,expected=expected,
            runtime=runtime,candidate=candidate,manifest=manifest,states=states,original=original,actions=actions,rollback=rollback)

    def execute(self,f):
        with patch.object(a,'BASELINE_MANIFEST_SHA256',a.digest((f.previous/'release-manifest.json').read_bytes())), \
             patch.object(a,'source_projection',return_value=(f.candidate,{},f.expected,f.runtime,'9'*64)):
            return a.publish(f.controller,f.args,f.proof)

    def test_publish_updates_only_admin_and_keeps_old_origin_config_env_volume_and_six_services(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME)as root:
            f=self.fixture(root);result=self.execute(f);self.assertEqual(result['status'],'ADMIN_ONLY_PUBLISHED')
            current=(f.base/'current').resolve();m=a.read_json(current/'release-manifest.json')
            self.assertEqual(m['commit'],f.args.commit);self.assertEqual(m['servicesUpdated'],['admin'])
            self.assertEqual(m['sourceArchiveSha256'],'9'*64)
            for name in a.ORIGIN_MARKERS:self.assertEqual(m[name],f.manifest[name])
            self.assertEqual(m['adminPublication']['componentBaselines'],{'api':a.BASELINE})
            for name in f.states:
                if name!='admin':self.assertEqual(f.states[name],f.original[name]);self.assertEqual(m['images'][name],f.manifest['images'][name])
            self.assertEqual(a.read_json(current/'admin-build-proof.json'),f.proof)
            self.assertEqual(f.rollback,[])
            with patch.object(a,'BASELINE_MANIFEST_SHA256',a.digest((f.previous/'release-manifest.json').read_bytes())):
                self.assertEqual(a.readback(f.controller,f.args.commit)['status'],'ADMIN_ONLY_READBACK_VERIFIED')
                f.states['api']['environmentSha256']='5'*64
                with self.assertRaisesRegex(RuntimeError,'PRESERVED_SERVICE_CHANGED'):a.readback(f.controller,f.args.commit)
            self.assertEqual([row for row in f.actions if row[:2]==('docker','pull')],[('docker','pull',f.proof['image']['reference'])])
            self.assertFalse(any('migrate' in str(row) or 'online-recharge' in str(row) or 'GRANT' in str(row)for row in f.actions))

    def test_readback_rejects_changed_source_tree_runtime_and_origin_markers(self):
        for fault in ('tree','runtime','marker'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory(dir=RUNTIME)as root:
                f=self.fixture(root);self.execute(f);current=(f.base/'current').resolve()
                if fault=='runtime':
                    (current/next(iter(f.runtime))).write_bytes(b'changed runtime')
                else:
                    m=a.read_json(current/'release-manifest.json')
                    if fault=='tree':m['sourceTree']='f'*40
                    else:m['pendingOnlineMigration']['fixture']='unreviewed successor'
                    (current/'release-manifest.json').write_text(json.dumps(m))
                with patch.object(a,'BASELINE_MANIFEST_SHA256',a.digest((f.previous/'release-manifest.json').read_bytes())),self.assertRaises(RuntimeError):
                    a.readback(f.controller,f.args.commit)

    def test_post_switch_faults_restore_only_admin_and_record_original_failure_with_observed_result(self):
        for fault in ('audit','preserved_env','env','edge','restore'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory(dir=RUNTIME)as root:
                f=self.fixture(root,fault=fault)
                with self.assertRaises(RuntimeError):self.execute(f)
                self.assertEqual(f.rollback,['admin'])
                targets=[p for p in (f.base/'releases').iterdir()if p!=f.previous]
                receipt=a.read_json(targets[0]/'admin-release-failure.json')
                self.assertTrue(receipt['receiptPersisted']);self.assertTrue(receipt['adminRecovery']['attempted'])
                self.assertEqual(receipt['adminRecovery']['status'],'FAILED'if fault=='restore'else'RESTORED')
                self.assertEqual((f.base/'current').resolve(),f.previous)
                self.assertEqual(receipt['observed']['preservedServicesUnchanged'],fault!='preserved_env')

    def test_wrong_manifest_image_volume_and_build_proof_stop_before_service_switch(self):
        for fault in ('mount','image','proof'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory(dir=RUNTIME)as root:
                f=self.fixture(root,fault=fault)
                if fault=='image':f.states['api']['image']='sha256:'+'a'*64
                if fault=='proof':f.proof['commit']='f'*40
                with self.assertRaises(RuntimeError):self.execute(f)
                self.assertEqual(f.rollback,[])
                self.assertFalse(any(row[0]=='compose'and row[1][:2]==('up','-d')for row in f.actions))

    def test_original_runtime_schema_at_real_source_size_publishes_without_relaxing_other_private_reads(self):
        name='apps/api/prisma-mysql/schema.prisma'
        raw=subprocess.check_output(['git','show','e98eb0b1cab5102204e6b51950e2572ac2fc028f:'+name],cwd=ROOT)
        self.assertEqual(len(raw),182527)
        with tempfile.TemporaryDirectory(dir=RUNTIME)as root:
            f=self.fixture(root);f.candidate[name]=(raw,'100644')
            source=f.previous/'.deploy/production-release/pending-original-source'/name
            source.write_bytes(raw)
            with self.assertRaisesRegex(RuntimeError,'PRIVATE_FILE_CHANGED'):
                a.private_bytes(source)
            self.assertEqual(self.execute(f)['status'],'ADMIN_ONLY_PUBLISHED')
            current=(f.base/'current').resolve()
            self.assertEqual((current/'.deploy/production-release/pending-original-source'/name).read_bytes(),raw)
            with patch.object(a,'BASELINE_MANIFEST_SHA256',a.digest((f.previous/'release-manifest.json').read_bytes())):
                self.assertEqual(a.readback(f.controller,f.args.commit)['status'],'ADMIN_ONLY_READBACK_VERIFIED')

    def test_original_runtime_source_bounds_and_identity_fail_before_release_files_or_service_changes(self):
        name='apps/api/prisma-mysql/schema.prisma'
        for fault in ('shorter','longer','bytes','mode','link','hardlink','oversize','empty','extra','missing'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory(dir=RUNTIME)as root:
                f=self.fixture(root);raw=b's' * 182527
                if fault=='oversize':raw=b's' * (a.ORIGINAL_RUNTIME_SOURCE_LIMIT+1)
                if fault=='empty':raw=b''
                f.candidate[name]=(raw,'100644')
                source=f.previous/'.deploy/production-release/pending-original-source'/name
                source.write_bytes(raw)
                expected='ORIGINAL_RUNTIME_SOURCE_CHANGED'
                if fault=='shorter':source.write_bytes(raw[:-1])
                if fault=='longer':source.write_bytes(raw+b'x');expected='PRIVATE_FILE_CHANGED'
                if fault=='bytes':source.write_bytes(b'x'+raw[1:])
                if fault=='mode':source.chmod(0o644);expected='PRIVATE_FILE_CHANGED'
                if fault=='link':
                    target=f.base/'linked-source';target.write_bytes(raw);target.chmod(0o600)
                    source.unlink();source.symlink_to(target);expected='PRIVATE_PATH_CHANGED'
                if fault=='hardlink':os.link(source,f.base/'linked-source');expected='PRIVATE_FILE_CHANGED'
                if fault in ('oversize','empty'):expected='ORIGINAL_RUNTIME_SOURCE_SIZE_INVALID'
                if fault=='extra':f.runtime['unreviewed-source']=(b'extra','100644')
                if fault=='missing':del f.runtime[name]
                if fault in ('extra','missing'):expected='ORIGINAL_RUNTIME_SOURCE_SET_CHANGED'
                with self.assertRaisesRegex(RuntimeError,expected):self.execute(f)
                self.assertEqual(f.rollback,[])
                self.assertEqual(list((f.base/'releases').iterdir()),[f.previous])
                self.assertEqual((f.base/'current').resolve(),f.previous)
                self.assertFalse(any(row[0]=='compose'and row[1][:2]==('up','-d')for row in f.actions))
                self.assertFalse(any(row[:2]==('docker','pull')for row in f.actions))

    def test_historical_digest_only_caddy_row_publishes_and_reads_back(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME)as root:
            f=self.fixture(root)
            reference='caddy:2.10-alpine@sha256:'+'4'*64
            f.states['caddy']['reference']=f.original['caddy']['reference']=reference
            f.manifest['images']['caddy']={'digest':f.original['caddy']['image']}
            (f.previous/'release-manifest.json').write_text(json.dumps(f.manifest))
            result=self.execute(f)
            self.assertEqual(result['status'],'ADMIN_ONLY_PUBLISHED')
            current=(f.base/'current').resolve()
            self.assertEqual(a.read_json(current/'release-manifest.json')['images']['caddy'],f.manifest['images']['caddy'])
            with patch.object(a,'BASELINE_MANIFEST_SHA256',a.digest((f.previous/'release-manifest.json').read_bytes())):
                self.assertEqual(a.readback(f.controller,f.args.commit)['status'],'ADMIN_ONLY_READBACK_VERIFIED')

    def test_digest_only_compatibility_rejects_managed_services_and_caddy_drift_before_effects(self):
        for fault in ('managed','digest','reference','compose','metadata','repo_digest','extra'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory(dir=RUNTIME)as root:
                f=self.fixture(root)
                reference='caddy:2.10-alpine@sha256:'+'4'*64
                f.states['caddy']['reference']=f.original['caddy']['reference']=reference
                f.manifest['images']['caddy']={'digest':f.original['caddy']['image']}
                if fault=='managed':del f.manifest['images']['api']['reference']
                if fault=='digest':f.states['caddy']['image']='sha256:'+'d'*64
                if fault=='reference':f.states['caddy']['reference']='caddy:changed'
                if fault=='extra':f.manifest['images']['caddy']['unexpected']=True
                (f.previous/'release-manifest.json').write_text(json.dumps(f.manifest))
                compose=f.controller.compose
                def config_changed(directory,*parts,**kw):
                    if parts==('config','--format','json')and fault=='compose':
                        return json.dumps({'services':{'caddy':{'image':'caddy:changed'}}})
                    return compose(directory,*parts,**kw)
                f.controller.compose=config_changed
                run=f.controller.run
                def changed(*parts,**kw):
                    if parts==('docker','image','inspect',reference)and fault in ('metadata','repo_digest'):
                        return json.dumps([{'Id':'sha256:'+'d'*64 if fault=='metadata'else f.original['caddy']['image'],
                            'RepoDigests':[]if fault=='repo_digest'else['caddy@'+reference.split('@',1)[1]]}])
                    return run(*parts,**kw)
                f.controller.run=changed
                with self.assertRaisesRegex(RuntimeError,'BASELINE_IMAGE_CHANGED'):self.execute(f)
                self.assertEqual(f.rollback,[])
                self.assertEqual([p for p in (f.base/'releases').iterdir()],[f.previous])
                self.assertFalse(any(row[0]=='compose'and row[1][:2]==('up','-d')for row in f.actions))


class WorkspaceProjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.commit = 'a2819b3ef7ecbba44678e060ef0ef1ef620e09c0'
        cls.p = a.projection_module()
        cls.files = git_files(cls.commit)
        cls.predecessor, cls.review = git_files(a.WORKSPACE_BASELINE), git_files(a.WORKSPACE_REVIEW_BASE)
        cls.baseline, cls.online = git_files(cls.p.BASELINE_COMMIT), git_files(cls.p.ONLINE_COMMIT)
        cls.tree = cls.p.source_tree(cls.files)

    def project(self, files=None, predecessor=None, review=None):
        files = self.files if files is None else files
        return a.project_workspace(files, self.predecessor if predecessor is None else predecessor,
            self.review if review is None else review, self.baseline, self.online,
            self.commit, self.p.source_tree(files))

    def test_exact_fourteen_file_projection_excludes_pending_admin_backend_and_migrations(self):
        source, output, record, runtime = self.project()
        self.assertEqual(record['candidateTree'], self.tree)
        self.assertEqual(record['apiComponentBaseline'], a.BASELINE)
        self.assertEqual(record['outputTree'], '059f7fbfb292ae94de8d327ea59c797646dd11cb')
        self.assertEqual(record['compositeSourceTree'], '8c4d958f6d406b07aa2d33ed6ed4d0c9a0ae26e0')
        self.assertEqual(record['deploymentSourceTree'], self.p.source_tree({**output, **runtime}))
        self.assertEqual(set(record['overlayFiles']), set(a.WORKSPACE_FILES))
        for name, row in self.predecessor.items():
            if name not in a.WORKSPACE_FILES:
                self.assertEqual(source[name], row, name)
        pending_admin = [n for n in self.files if n.startswith('apps/admin/')
                         and n not in a.WORKSPACE_FILES and self.files[n] != self.predecessor.get(n)]
        self.assertTrue(pending_admin)
        for name in pending_admin:
            self.assertEqual(output.get(name), self.predecessor.get(name), name)
        allocator = 'apps/admin/src/v2/composables/useV2TableContentWidths.ts'
        self.assertIn(allocator, self.files)
        self.assertNotIn(allocator, self.predecessor)
        self.assertNotIn(allocator, source)
        self.assertNotIn(allocator, output)
        self.assertNotIn('apps/api/prisma-mysql/migrations/20261012143000_recharge_connection_profiles/migration.sql', output)
        self.assertNotIn(b'IdBusinessV2RechargeConnectionProfile', runtime['apps/api/prisma-mysql/schema.prisma'][0])
        self.assertFalse(any(n.startswith(a.ADMIN_DIRECTORY) for n in output))
        for name in ('apps/admin/src/v2-router.ts', 'apps/admin/src/v2/features/registry.ts',
                     'apps/admin/src/v2/features/tableSchemas.ts', 'apps/admin/src/v2/layouts/V2AdminLayout.vue'):
            self.assertNotIn(b'online-recharge', output[name][0], name)
            self.assertNotIn(b'onlineRecharge', output[name][0], name)
        self.assertIn(b'V2WorkspaceDock', output['apps/admin/src/v2/layouts/V2AdminLayout.vue'][0])
        self.assertLess(len(json.dumps(record).encode()) + 2048, 32768)

    def test_unknown_admin_input_overlay_modes_and_changed_before_bytes_are_rejected(self):
        for name in (a.WORKSPACE_FILES[0], 'apps/admin/src/v2/components/unreviewed.vue', 'package-lock.json'):
            files = dict(self.files)
            raw, mode = files.get(name, (b'', '100644'))
            files[name] = (raw + b'\n', mode)
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'UNREVIEWED_WORKSPACE_SOURCE'):
                self.project(files=files)
        files = dict(self.files); name = a.WORKSPACE_FILES[0]
        files[name] = (files[name][0], '100755')
        with self.assertRaises(RuntimeError): self.project(files=files)
        before = dict(self.review); before[name] = (b'changed before', '100644')
        with self.assertRaisesRegex(RuntimeError, 'WORKSPACE_BEFORE_CHANGED'): self.project(review=before)
        predecessor = dict(self.predecessor); predecessor['docs/unreviewed.md'] = (b'changed', '100644')
        with self.assertRaisesRegex(RuntimeError, 'WORKSPACE_PREDECESSOR_CHANGED'): self.project(predecessor=predecessor)

    def test_transport_only_backend_and_control_changes_cannot_enter_output(self):
        files = dict(self.files)
        for name in ('apps/api/src/id-business-v2/unreviewed.ts', 'scripts/production-release/unreviewed.py'):
            files[name] = (b'not published\n', '100644')
        source, output, record, _ = self.project(files=files)
        for name in ('apps/api/src/id-business-v2/unreviewed.ts', 'scripts/production-release/unreviewed.py'):
            self.assertNotIn(name, source); self.assertNotIn(name, output)
        self.assertEqual(record['outputTree'], '059f7fbfb292ae94de8d327ea59c797646dd11cb')
        with self.assertRaisesRegex(RuntimeError, 'CANDIDATE_TREE_CHANGED'):
            a.project_workspace(files, self.predecessor, self.review, self.baseline, self.online,
                                self.commit, self.tree)

    def test_selection_allows_only_sealed_sixty_profile_and_preserves_old_schema_guard(self):
        selection = ROOT / 'scripts/production-release/validate-release-selection.sh'
        env = {**os.environ, 'RELEASE_OPERATION': 'release_admin', 'RELEASE_ADMIN_ONLY': 'true',
            'EXPECTED_CURRENT': a.WORKSPACE_BASELINE, 'RELEASE_COMMIT': self.commit,
            'SOURCE_TREE': self.tree, 'GITHUB_REF': 'refs/heads/main', 'HISTORICAL_EXCEPTION': 'none'}
        command = ['bash', '-c', 'source "$1"; validate_release_selection', '--', str(selection)]
        result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn('ADMIN_WORKSPACE_SOURCE_VERIFIED', result.stdout)
        for values in ({'EXPECTED_CURRENT': a.BASELINE}, {'SOURCE_TREE': 'f' * 40},
                       {'RELEASE_COMMIT': a.WORKSPACE_REVIEW_BASE}, {'EXPECTED_CURRENT': 'd' * 40}):
            with self.subTest(values=values):
                result = subprocess.run(command, cwd=ROOT, env={**env, **values}, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)


class WorkspacePublicationTests(unittest.TestCase):
    def fixture(self, root):
        f = PublicationTests.fixture(self, root)
        f.args.expected_current = a.WORKSPACE_BASELINE
        f.configurations = {n: {'Config': {'fixture': n}, 'HostConfig': {'Memory': 0}, 'Mounts': []}
                            for n in f.states}
        f.configurations['api']['Mounts'] = [{'Type': 'volume', 'Name': 'fixture_sqlite',
            'Destination': '/app/.runtime/auto-registration', 'Source': '/fixture-volume', 'RW': True}]
        run = f.controller.run
        def inspect(*parts, **kw):
            if parts[:2] == ('docker', 'inspect'):
                name = next(n for n, state in f.states.items() if state['containerId'] == parts[2])
                return json.dumps([{'Id': parts[2], **f.configurations[name]}])
            return run(*parts, **kw)
        f.controller.run = inspect
        ancestor = f.base / 'releases' / 'admin-sixty'; ancestor.mkdir()
        old_projection = {'projectionSha256': a.WORKSPACE_OLD_PROJECTION_SHA256}
        old_proof = {'projection': old_projection, 'image': {'imageId': f.original['admin']['image']}}
        old_ledger = {'projection': old_projection, 'componentBaselines': {'api': a.BASELINE}}
        old = {**copy.deepcopy(f.manifest), 'commit': a.WORKSPACE_BASELINE, 'adminPublication': old_ledger}
        a.write_json(ancestor / 'release-manifest.json', old)
        a.write_json(ancestor / 'admin-build-proof.json', old_proof)
        ancestor_sha = a.digest((ancestor / 'release-manifest.json').read_bytes())
        f.manifest.update(commit=a.WORKSPACE_BASELINE, adminPublication=old_ledger,
            previousRelease=str(ancestor), previousManifestSha256=ancestor_sha,
            apiHotfixPublication={'fixture': 'immutable existing hotfix; no new restore authority'})
        (f.previous / 'release-manifest.json').write_text(json.dumps(f.manifest))
        f.contract = {**a.WORKSPACE_BASELINE_CONTRACT,
            'manifestSha256': a.digest((f.previous / 'release-manifest.json').read_bytes()),
            'adminRelease': str(ancestor), 'adminManifestSha256': ancestor_sha,
            'adminProofSha256': a.digest((ancestor / 'admin-build-proof.json').read_bytes()),
            'adminPublicationSha256': a.fingerprint(old_ledger),
            'originMarkersSha256': a.fingerprint({n: f.manifest[n] for n in a.ORIGIN_MARKERS}),
            'hotfixPublicationSha256': a.fingerprint(f.manifest['apiHotfixPublication']),
            'apiImageId': f.original['api']['image'], 'adminImageId': f.original['admin']['image']}
        f.expected.update(profile=a.WORKSPACE_PROFILE, apiComponentBaseline=a.BASELINE,
            sourceBasisCommit=a.WORKSPACE_BASELINE, overlaySha256=a.WORKSPACE_OVERLAY_SHA256,
            approvedAdminInputSha256=a.WORKSPACE_INPUT_SHA256,
            originalAdminProjectionSha256=a.WORKSPACE_OLD_PROJECTION_SHA256)
        f.expected['projectionSha256'] = a.fingerprint({k:v for k,v in f.expected.items() if k != 'projectionSha256'})
        return f

    def execute(self, f):
        with patch.object(a, 'WORKSPACE_BASELINE_CONTRACT', f.contract), \
             patch.object(a, 'source_projection', return_value=(f.candidate,f.candidate,f.expected,f.runtime,'9'*64)):
            result = a.publish(f.controller, f.args, f.proof)
            readback = a.readback(f.controller, f.args.commit)
            self.assertEqual(readback['apiComponentBaseline'], a.BASELINE)
            return result

    def test_sixty_successor_only_replaces_admin_and_inherits_api31_and_hotfix(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as root:
            f = self.fixture(root); self.assertEqual(self.execute(f)['status'], 'ADMIN_ONLY_PUBLISHED')
            manifest = a.read_json((f.base / 'current').resolve() / 'release-manifest.json')
            self.assertEqual(manifest['previousCommit'], a.WORKSPACE_BASELINE)
            self.assertEqual(manifest['adminPublication']['componentBaselines'], {'api': a.BASELINE})
            self.assertEqual(manifest['apiHotfixPublication'], f.manifest['apiHotfixPublication'])
            self.assertEqual(manifest['images']['api'], f.manifest['images']['api'])
            self.assertEqual(f.states['api'], f.original['api'])
            self.assertEqual([r for r in f.actions if r[0] == 'compose' and r[1][:2] == ('up','-d')],
                [('compose', ('up','-d','--no-deps','--no-build','--pull','never','--force-recreate','admin'))])
            self.assertEqual(f.rollback, [])

    def test_inherited_proof_marker_and_current_image_drift_stop_before_switch(self):
        for fault in ('proof', 'hotfix', 'origin', 'api', 'admin'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory(dir=RUNTIME) as root:
                f = self.fixture(root)
                if fault == 'proof':
                    (Path(f.contract['adminRelease']) / 'admin-build-proof.json').write_bytes(b'{}')
                elif fault in ('hotfix', 'origin'):
                    key = 'apiHotfixPublication' if fault == 'hotfix' else 'pendingOnlineMigration'
                    f.manifest[key] = {'changed': True}
                    (f.previous / 'release-manifest.json').write_text(json.dumps(f.manifest))
                else:
                    f.states[fault]['image'] = 'sha256:' + 'd' * 64
                with self.assertRaises(RuntimeError): self.execute(f)
                self.assertFalse(any(r[0] == 'compose' and r[1][:2] == ('up','-d') for r in f.actions))
                self.assertEqual(f.rollback, [])

    def test_readback_cannot_relabel_api_origin_to_current_admin(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as root:
            f = self.fixture(root); self.execute(f)
            current = (f.base / 'current').resolve()
            manifest = a.read_json(current / 'release-manifest.json')
            manifest['adminPublication']['componentBaselines']['api'] = a.WORKSPACE_BASELINE
            (current / 'release-manifest.json').write_text(json.dumps(manifest))
            with patch.object(a, 'WORKSPACE_BASELINE_CONTRACT', f.contract), self.assertRaisesRegex(RuntimeError, 'READBACK_CHANGED'):
                a.readback(f.controller, f.args.commit)

    def test_in_place_host_configuration_drift_is_preserved_failure_without_api_restart(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as root:
            f = self.fixture(root)
            compose = f.controller.compose
            def drift(directory, *parts, **kw):
                result = compose(directory, *parts, **kw)
                if parts[:2] == ('up', '-d'):
                    f.configurations['api']['HostConfig']['Memory'] = 1024
                return result
            f.controller.compose = drift
            with self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICE_CHANGED'): self.execute(f)
            self.assertEqual(f.rollback, ['admin'])
            self.assertEqual(f.states['api'], f.original['api'])
            receipt = next(p for p in (f.base / 'releases').glob('*/admin-release-failure.json'))
            self.assertFalse(a.read_json(receipt)['observed']['preservedServicesUnchanged'])

    def test_readback_rejects_in_place_mount_drift(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as root:
            f = self.fixture(root); self.execute(f)
            f.configurations['mysql']['Mounts'].append({'Destination': '/fixture', 'Source': '/changed'})
            with patch.object(a, 'WORKSPACE_BASELINE_CONTRACT', f.contract), \
                 patch.object(a, 'source_projection', return_value=(f.candidate,f.candidate,f.expected,f.runtime,'9'*64)), \
                 self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICE_CHANGED'):
                a.readback(f.controller, f.args.commit)

    def test_mount_order_is_stable_and_duplicate_destinations_are_rejected(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as root:
            f = self.fixture(root)
            mounts = [{'Destination': '/one', 'Source': '/first'}, {'Destination': '/two', 'Source': '/second'}]
            f.configurations['mysql']['Mounts'] = mounts
            before = a.snapshot(f.controller, f.previous, configuration=True)
            f.configurations['mysql']['Mounts'] = list(reversed(mounts))
            self.assertEqual(before, a.snapshot(f.controller, f.previous, configuration=True))
            f.configurations['mysql']['Mounts'].append(mounts[0])
            with self.assertRaisesRegex(RuntimeError, 'SERVICE_CONFIGURATION_UNAVAILABLE'):
                a.snapshot(f.controller, f.previous, configuration=True)


class ConfirmProjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.predecessor = git_files(a.CONFIRM_BASELINE)
        cls.control_source = git_files(a.CONFIRM_CONTROL_SOURCE)
        p = a.projection_module(); cls.p = p
        cls.baseline, cls.online = git_files(p.BASELINE_COMMIT), git_files(p.ONLINE_COMMIT)
        cls.candidate = dict(cls.control_source)
        for name in (*a.CONFIRM_FILES, *a.CONFIRM_CONTROLS, *a.CONFIRM_DOCS):
            cls.candidate[name] = ((ROOT / name).read_bytes(), '100644')

    def project(self, candidate=None, predecessor=None, control_source=None):
        files = self.candidate if candidate is None else candidate
        return a.project_confirm(files, self.predecessor if predecessor is None else predecessor,
            self.baseline, self.online, 'a' * 40, self.p.source_tree(files),
            self.control_source if control_source is None else control_source)

    def test_only_frozen_two_file_overlay_enters_published_projection_and_online_stays_absent(self):
        output, record, runtime = self.project()
        self.assertEqual(record['profile'], a.CONFIRM_PROFILE)
        self.assertEqual(record['apiComponentBaseline'], a.CONFIRM_BASELINE)
        self.assertEqual(record['controlSourceCommit'], a.CONFIRM_CONTROL_SOURCE)
        self.assertEqual(record['controlSourceTree'], a.CONFIRM_CONTROL_TREE)
        self.assertEqual(record['inheritedControlFiles'], {})
        self.assertEqual(self.control_source, self.predecessor)
        for name in (
            'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-api.ts',
            'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct.spec.ts',
            'apps/admin/src/v2/features/auto-recharge/useBitBrowserDirectOpen.spec.ts',
            'apps/admin/src/v2/features/auto-recharge/useBitBrowserDirectOpen.ts',
            'apps/api/src/id-business-v2/auto-recharge/recharge-owned-profile.spec.ts',
            'apps/api/src/id-business-v2/auto-recharge/worker/bitbrowser_connector.py',
            'apps/api/src/id-business-v2/auto-recharge/worker/test_bitbrowser_connector.py'):
            self.assertEqual(output[name], self.control_source[name], name)
        self.assertEqual(record['overlaySha256'], a.CONFIRM_OVERLAY_SHA256)
        self.assertEqual(set(record['overlayFiles']), set(a.CONFIRM_FILES))
        self.assertFalse(any('/online-recharge/' in name for name in output))
        self.assertEqual(runtime['apps/api/prisma-mysql/schema.prisma'][1], '100644')
        self.assertEqual(a.digest(runtime['apps/api/prisma-mysql/schema.prisma'][0]),
            '2d63ec64a4d9aa40cbacfc127857124b296919142ea96318ab196aa2e4ee07f2')
        for name in a.CONFIRM_FILES:
            self.assertEqual(output[name], self.candidate[name])
        self.assertEqual(record['projectionSha256'], a.fingerprint({k: v for k, v in record.items()
            if k != 'projectionSha256'}))

    def test_other_ui_api_auth_online_migration_dependency_and_unknown_control_changes_rejected(self):
        paths = ('apps/admin/src/v2/features/registry.ts',
            'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts',
            'apps/api/src/auth/auth.service.ts',
            'apps/admin/src/v2/features/online-recharge/fixture.vue',
            'apps/api/prisma-mysql/schema.prisma',
            'apps/api/prisma-mysql/migrations/unreviewed/migration.sql', 'package-lock.json',
            'scripts/production-release/extra.py', '.github/workflows/quality.yml',
            'docs/another-release.md', 'scripts/production-release/disk-retention.py',
            'deploy/aws/disk-retention-policy-20261014.json', '.github/workflows/disk-retention-maintenance.yml',
            'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-api.ts',
            'apps/admin/src/v2/features/auto-recharge/useBitBrowserDirectOpen.ts',
            'apps/api/src/id-business-v2/auto-recharge/worker/bitbrowser_connector.py')
        for name in paths:
            files = dict(self.candidate); raw, mode = files.get(name, (b'', '100644'))
            files[name] = (raw + b'\n# changed\n', mode)
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'CONFIRM_SOURCE_SCOPE_CHANGED'):
                self.project(files)

    def test_wrong_baseline_overlay_mode_and_deleted_controls_rejected(self):
        old = dict(self.predecessor); name = a.CONFIRM_FILES[0]; raw, mode = old[name]
        old[name] = (raw + b'\n', mode)
        with self.assertRaisesRegex(RuntimeError, 'CONFIRM_SOURCE_TREE_CHANGED'):
            self.project(predecessor=old)
        with self.assertRaisesRegex(RuntimeError, 'CONFIRM_SOURCE_TREE_CHANGED'):
            self.project(predecessor=git_files('f193f34ea09a2c37485c1582a81b33ee3acec865'))
        for fault in ('bytes', 'mode', 'delete'):
            files = dict(self.candidate)
            if fault == 'bytes':
                raw, mode = files[name]; files[name] = (raw + b'\n', mode)
            elif fault == 'mode':
                raw, _ = files[name]; files[name] = (raw, '100755')
            else:
                del files['scripts/production-release/dispatch.sh']
            with self.subTest(fault=fault), self.assertRaises(RuntimeError):
                self.project(files)

    def test_native_predecessor_projection_cannot_be_resealed_from_mutable_input(self):
        with patch.object(a, 'CONFIRM_CONTRACT', {**a.CONFIRM_CONTRACT, 'projectionSha256': '0' * 64}), \
             self.assertRaisesRegex(RuntimeError, 'CONFIRM_PREDECESSOR_CHANGED'):
            self.project()

    def test_control_basis_cannot_drift_or_introduce_unapproved_runtime_even_when_tree_is_resealed(self):
        source = dict(self.control_source)
        name = 'scripts/production-release/disk-retention.py'
        raw, mode = source[name]; source[name] = (raw + b'\n# drift\n', mode)
        with self.assertRaisesRegex(RuntimeError, 'CONFIRM_CONTROL_SOURCE_CHANGED'):
            self.project(control_source=source)
        for name in ('apps/api/src/auth/auth.service.ts',
                     'apps/admin/src/v2/features/auto-recharge/useRechargeLocalConfirmation.ts',
                     'package-lock.json', 'apps/api/prisma-mysql/schema.prisma'):
            source = dict(self.control_source); raw, mode = source[name]
            source[name] = (raw + b'\n# runtime change\n', mode)
            with self.subTest(name=name), patch.object(a, 'CONFIRM_CONTROL_TREE', self.p.source_tree(source)), \
                 self.assertRaisesRegex(RuntimeError, 'CONFIRM_CONTROL_SCOPE_CHANGED'):
                self.project(control_source=source)

    def test_inherited_storage_registration_accepts_only_this_complete_admin_role(self):
        storage = a.load_module('confirm_inherited_storage', 'release-storage.py')
        producer = {'commit': 'a' * 40, 'sourceTree': 'b' * 40,
            'workflowRunId': '123', 'workflowRunAttempt': '1'}
        selected = {'operation': 'release_admin', 'producer': producer,
            'qualityRunId': '111', 'batch': producer['commit'] + '-123-1'}
        proof = {'version': 1, 'scope': 'ADMIN_PENDING_ONLINE_BUILD',
            'commit': producer['commit'], 'sourceTree': producer['sourceTree'],
            'runId': '123', 'runAttempt': '1', 'qualityRunId': '111',
            'image': {'reference': a.REPOSITORY + ':' + selected['batch'] + '-admin',
                'imageId': 'sha256:' + 'c' * 64, 'fileCount': 225, 'sha256': 'd' * 64}}
        module, images = storage.proof_images(selected, proof)
        self.assertEqual(module, 'admin')
        self.assertEqual(set(images), {'admin'})
        for fault in ('role', 'run', 'scope'):
            changed = copy.deepcopy(proof)
            if fault == 'role': changed['image']['reference'] = changed['image']['reference'].replace('-admin', '-api')
            elif fault == 'run': changed['runId'] = '124'
            else: changed['scope'] = 'UNPUBLISHED_COMPONENT_BUILD'
            with self.subTest(fault=fault), self.assertRaises(storage.StorageRejected):
                storage.proof_images(selected, changed)


class ConfirmPublicationTests(unittest.TestCase):
    def fixture(self, root):
        f = WorkspacePublicationTests.fixture(self, root)
        f.args.expected_current = a.CONFIRM_BASELINE
        f.manifest.update(commit=a.CONFIRM_BASELINE, sourceTree=a.CONFIRM_BASELINE_TREE)
        original_projection = {'outputTree': a.CONFIRM_CONTRACT['outputTree']}
        f.rows = {name: {'reference': f.original[name]['reference'], 'imageId': f.original[name]['image'],
            'fileCount': 2, 'sha256': a.digest((name + ':content').encode())} for name in ('api', 'admin')}
        original_proof = {'scope': 'UNPUBLISHED_COMPONENT_BUILD', 'commit': a.CONFIRM_BASELINE,
            'sourceTree': a.CONFIRM_BASELINE_TREE, 'runId': a.CONFIRM_CONTRACT['runId'],
            'runAttempt': a.CONFIRM_CONTRACT['runAttempt'], 'qualityRunId': a.CONFIRM_CONTRACT['qualityRunId'],
            'projection': original_projection, 'images': f.rows}
        state = {'after': a.snapshot(f.controller, f.previous, configuration=True),
            'proofSha256': a.fingerprint(original_proof), 'projectionSha256': a.fingerprint(original_projection),
            'onlinePublished': False, 'businessActions': 0}
        a.write_json(f.previous / 'unpublished-component-successor-build-proof.json', original_proof)
        a.write_json(f.previous / 'unpublished-component-successor-preservation.json', state)
        f.contract = {**a.CONFIRM_CONTRACT,
            'buildProofSha256': a.digest((f.previous / 'unpublished-component-successor-build-proof.json').read_bytes()),
            'preservationSha256': a.digest((f.previous / 'unpublished-component-successor-preservation.json').read_bytes()),
            'projectionSha256': a.fingerprint(original_projection)}
        ledger = {'componentAfter': {'api': a.CONFIRM_BASELINE, 'admin': a.CONFIRM_BASELINE},
            'onlinePublished': False, 'businessActions': 0, 'buildProofBytesSha256': f.contract['buildProofSha256'],
            'preservationRecordBytesSha256': f.contract['preservationSha256'],
            'projectionSha256': f.contract['projectionSha256']}
        f.manifest['apiComponentPublication'] = ledger
        (f.previous / 'release-manifest.json').write_text(json.dumps(f.manifest))
        f.contract.update(manifestSha256=a.digest((f.previous / 'release-manifest.json').read_bytes()),
            publicationSha256=a.fingerprint(ledger))
        f.expected = {'version': 1, 'scope': 'ADMIN_PENDING_ONLINE_BUILD_PROJECTION',
            'profile': a.CONFIRM_PROFILE, 'apiComponentBaseline': a.CONFIRM_BASELINE,
            'candidateCommit': f.args.commit, 'candidateTree': f.args.source_tree,
            'sourceBasisCommit': a.CONFIRM_BASELINE, 'sourceBasisTree': a.CONFIRM_BASELINE_TREE,
            'overlaySha256': a.CONFIRM_OVERLAY_SHA256,
            'inheritedProjectionSha256': f.contract['projectionSha256'],
            'runtimeFiles': {n: {'sha256': a.digest(row[0]), 'mode': row[1]} for n, row in f.runtime.items()}}
        f.expected['projectionSha256'] = a.fingerprint(f.expected)
        f.proof['projection'] = f.expected
        f.proof['image'].update(fileCount=2, sha256=a.digest(b'admin:new-content'))
        scope = SimpleNamespace(content_command=lambda n: 'synthetic-content:' + n,
            content_summary=lambda controller, n, output: json.loads(output))
        f.controller.api_admin_scope = lambda name: (scope, f.controller)
        run, compose = f.controller.run, f.controller.compose
        def inspect(*parts, **kw):
            if parts[:3] == ('docker', 'image', 'inspect') and parts[3] in (
                    f.rows['api']['reference'], f.rows['admin']['reference'], f.proof['image']['reference']):
                name = 'api' if parts[3] == f.rows['api']['reference'] else 'admin'
                new = parts[3] == f.proof['image']['reference']
                row = f.proof['image'] if new else f.rows[name]
                return json.dumps([{'Id': row['imageId'], 'Architecture': 'amd64', 'Config': {'Labels': {
                    'org.opencontainers.image.revision': f.args.commit if new else a.CONFIRM_BASELINE,
                    'id-business-v2.source-tree': f.args.source_tree if new else a.CONFIRM_BASELINE_TREE,
                    ('id-business-v2.admin-pending-projection-sha256' if new else
                     'id-business-v2.unpublished-component-successor-projection-sha256'):
                    f.expected['projectionSha256'] if new else f.contract['projectionSha256']}}}])
            return run(*parts, **kw)
        def content(directory, *parts, **kw):
            if parts[:2] == ('exec', '-T') and parts[2] in ('api', 'admin'):
                name = parts[2]
                row = f.proof['image'] if name == 'admin' and f.states['admin']['image'] == f.proof['image']['imageId'] else f.rows[name]
                return json.dumps({k: row[k] for k in ('fileCount', 'sha256')})
            return compose(directory, *parts, **kw)
        f.controller.run, f.controller.compose = inspect, content
        return f

    def execute(self, f, *, readback=True):
        with patch.object(a, 'CONFIRM_CONTRACT', f.contract), \
             patch.object(a, 'source_projection', return_value=(f.candidate, f.candidate, f.expected, f.runtime, '9' * 64)):
            result = a.publish(f.controller, f.args, f.proof)
            if readback:
                self.assertEqual(a.readback(f.controller, f.args.commit)['apiComponentBaseline'], a.CONFIRM_BASELINE)
            return result

    def test_native_proof_over_64k_has_its_own_bound_and_still_requires_exact_provenance(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as root:
            f = self.fixture(root)
            proof_path = f.previous / 'unpublished-component-successor-build-proof.json'
            state_path = f.previous / 'unpublished-component-successor-preservation.json'
            proof = a.read_json(proof_path); proof['safeNativeFixture'] = 'x' * 66000
            encoded = lambda row: (json.dumps(row, sort_keys=True, separators=(',', ':')) + '\n').encode()
            proof_path.write_bytes(encoded(proof))
            self.assertGreater(proof_path.stat().st_size, 65536)
            self.assertLess(proof_path.stat().st_size, a.CONFIRM_BASELINE_PROOF_LIMIT)
            with self.assertRaisesRegex(RuntimeError, 'PRIVATE_FILE_CHANGED'):
                a.read_json(proof_path)
            state = a.read_json(state_path); state['proofSha256'] = a.fingerprint(proof)
            state_path.write_bytes(encoded(state))
            ledger = f.manifest['apiComponentPublication']
            ledger['buildProofBytesSha256'] = a.digest(proof_path.read_bytes())
            ledger['preservationRecordBytesSha256'] = a.digest(state_path.read_bytes())
            manifest_raw = encoded(f.manifest)
            f.contract.update(manifestSha256=a.digest(manifest_raw), publicationSha256=a.fingerprint(ledger),
                buildProofSha256=ledger['buildProofBytesSha256'], preservationSha256=ledger['preservationRecordBytesSha256'])
            with patch.object(a, 'CONFIRM_CONTRACT', f.contract):
                self.assertEqual(a.confirm_baseline_records(f.previous, manifest_raw, f.manifest)[0], proof)
                proof['safeNativeFixture'] += 'tamper'; proof_path.write_bytes(encoded(proof))
                with self.assertRaisesRegex(RuntimeError, 'INHERITED_PROOF_CHANGED'):
                    a.confirm_baseline_records(f.previous, manifest_raw, f.manifest)
                proof_path.write_bytes(b'x' * (a.CONFIRM_BASELINE_PROOF_LIMIT + 1))
                with self.assertRaisesRegex(RuntimeError, 'PRIVATE_FILE_CHANGED'):
                    a.confirm_baseline_records(f.previous, manifest_raw, f.manifest)

    def test_success_updates_only_admin_preserves_native_api_proof_and_six_services(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as root:
            f = self.fixture(root); result = self.execute(f)
            self.assertEqual(result['status'], 'ADMIN_ONLY_PUBLISHED')
            manifest = a.read_json((f.base / 'current').resolve() / 'release-manifest.json')
            self.assertEqual(manifest['servicesUpdated'], ['admin'])
            self.assertFalse(manifest['migrationPerformed'])
            self.assertEqual(manifest['newMigrations'], [])
            for n in a.CONFIRM_ORIGIN_MARKERS:
                self.assertEqual(manifest[n], f.manifest[n])
            for n in f.states:
                if n != 'admin': self.assertEqual(f.states[n], f.original[n])
            self.assertEqual([r for r in f.actions if r[0] == 'compose' and r[1][:2] == ('up', '-d')],
                [('compose', ('up','-d','--no-deps','--no-build','--pull','never','--force-recreate','admin'))])
            self.assertFalse(any('migrate' in str(row) or 'GRANT' in str(row) for row in f.actions))

    def test_wrong_base_manifest_proof_preservation_and_native_container_drift_stop_before_switch(self):
        for fault in ('base', 'manifest', 'proof', 'preservation', 'container'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory(dir=RUNTIME) as root:
                f = self.fixture(root)
                if fault == 'base': f.args.expected_current = 'd' * 40
                elif fault == 'manifest': (f.previous / 'release-manifest.json').write_bytes(b'{}')
                elif fault in ('proof', 'preservation'):
                    suffix = 'build-proof' if fault == 'proof' else 'preservation'
                    (f.previous / ('unpublished-component-successor-' + suffix + '.json')).write_bytes(b'{}')
                else: f.configurations['api']['HostConfig']['Memory'] = 1024
                with self.assertRaises((RuntimeError, KeyError)): self.execute(f)
                self.assertFalse(any(r[0] == 'compose' and r[1][:2] == ('up', '-d') for r in f.actions))

    def test_prior_build_run_and_missing_content_proof_cannot_be_reused(self):
        for field, value in (('runId', a.CONFIRM_CONTRACT['runId']), ('sourceTree', a.CONFIRM_BASELINE_TREE),
                            ('qualityRunId', a.CONFIRM_CONTRACT['qualityRunId'])):
            with self.subTest(field=field), tempfile.TemporaryDirectory(dir=RUNTIME) as root:
                f = self.fixture(root); f.proof[field] = value
                with self.assertRaisesRegex(RuntimeError, 'BUILD_PROOF_CHANGED'): self.execute(f)
        with tempfile.TemporaryDirectory(dir=RUNTIME) as root:
            f = self.fixture(root); del f.proof['image']['sha256']
            with self.assertRaisesRegex(RuntimeError, 'BUILD_PROOF_CHANGED'): self.execute(f)

    def test_after_switch_configuration_drift_records_failure_and_never_restarts_api(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as root:
            f = self.fixture(root); compose = f.controller.compose
            def drift(directory, *parts, **kw):
                result = compose(directory, *parts, **kw)
                if parts[:2] == ('up', '-d'): f.configurations['api']['HostConfig']['Memory'] = 1024
                return result
            f.controller.compose = drift
            with self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICE_CHANGED'): self.execute(f)
            self.assertEqual(f.rollback, ['admin'])
            self.assertEqual(f.states['api'], f.original['api'])

    def test_independent_readback_rejects_source_origin_content_and_preserved_config_drift(self):
        for fault in ('source', 'origin', 'content', 'configuration'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory(dir=RUNTIME) as root:
                f = self.fixture(root); self.execute(f, readback=False)
                current = (f.base / 'current').resolve()
                if fault == 'source': (current / 'deploy/caddy/Caddyfile.aws').write_bytes(b'changed')
                elif fault == 'origin':
                    manifest = a.read_json(current / 'release-manifest.json')
                    manifest['apiComponentPublication'] = {'unreviewed': True}
                    (current / 'release-manifest.json').write_text(json.dumps(manifest))
                elif fault == 'content': f.proof['image']['sha256'] = '0' * 64
                else: f.configurations['mysql']['Mounts'].append({'Destination': '/changed', 'Source': '/changed'})
                with patch.object(a, 'CONFIRM_CONTRACT', f.contract), \
                     patch.object(a, 'source_projection', return_value=(f.candidate, f.candidate, f.expected, f.runtime, '9' * 64)), \
                     self.assertRaises(RuntimeError): a.readback(f.controller, f.args.commit)


class ConfirmPreflightTests(unittest.TestCase):
    def test_readonly_preflight_binds_native_proofs_runtime_content_capacity_and_original_services(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as root:
            f = ConfirmPublicationTests.fixture(self, root)
            lock = f.base / '.deploy.lock'; lock.write_bytes(b'')
            before = {p: p.read_bytes() for p in f.previous.rglob('*') if p.is_file()}
            with patch.object(a, 'CONFIRM_CONTRACT', f.contract), \
                 patch.object(a, 'source_projection', return_value=(f.candidate, f.candidate, f.expected, f.runtime, '9' * 64)):
                receipt = a.confirm_preflight(f.controller, f.args.commit, f.args.source_tree, a.CONFIRM_BASELINE)
            self.assertEqual(receipt['status'], 'ADMIN_CONFIRM_BASELINE_VERIFIED')
            self.assertEqual(receipt['currentCommit'], a.CONFIRM_BASELINE)
            self.assertEqual(receipt['projectionSha256'], f.expected['projectionSha256'])
            self.assertEqual(receipt['servicesVerified'], 7)
            self.assertEqual(receipt['businessActions'], 0)
            self.assertFalse(receipt['migrationPerformed'])
            self.assertEqual(before, {p: p.read_bytes() for p in f.previous.rglob('*') if p.is_file()})
            self.assertEqual(f.states, f.original)
            self.assertFalse(any(r[0] == 'compose' and r[1][:2] == ('up', '-d') for r in f.actions))
            self.assertFalse(any('systemctl' in str(r) or 'migrate' in str(r) for r in f.actions))

    def test_preflight_wrong_base_low_disk_runtime_and_service_drift_are_rejected_without_changes(self):
        for fault in ('base', 'disk', 'runtime', 'service'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory(dir=RUNTIME) as root:
                f = ConfirmPublicationTests.fixture(self, root); (f.base / '.deploy.lock').write_bytes(b'')
                base = a.CONFIRM_BASELINE
                if fault == 'base': base = 'd' * 40
                elif fault == 'disk': f.controller.shutil.disk_usage = lambda path: SimpleNamespace(free=6 * 1024**3)
                elif fault == 'runtime': (f.previous / next(iter(f.runtime))).write_bytes(b'changed-runtime')
                else: f.configurations['api']['HostConfig']['Memory'] = 512
                with patch.object(a, 'CONFIRM_CONTRACT', f.contract), \
                     patch.object(a, 'source_projection', return_value=(f.candidate, f.candidate, f.expected, f.runtime, '9' * 64)), \
                     self.assertRaises(RuntimeError):
                    a.confirm_preflight(f.controller, f.args.commit, f.args.source_tree, base)
                self.assertFalse(any(r[0] == 'compose' and r[1][:2] == ('up', '-d') for r in f.actions))


class ConfirmAccessTransportTests(unittest.TestCase):
    def execute(self, root, fault=None):
        candidate, tree, command = 'a' * 40, 'b' * 40, '12345678-1234-1234-1234-123456789abc'
        receipt = {'status': 'ADMIN_CONFIRM_BASELINE_VERIFIED', 'scope': a.CONFIRM_PROFILE,
            'candidateCommit': candidate, 'candidateTree': tree, 'currentCommit': a.CONFIRM_BASELINE,
            'manifestSha256': a.CONFIRM_CONTRACT['manifestSha256'], 'projectionSha256': 'c' * 64,
            'servicesVerified': 7, 'preservedServiceCount': 6, 'freeBytes': 8 * 1024**3,
            'onlinePublished': False, 'migrationPerformed': False, 'businessActions': 0}
        if fault == 'origin': receipt['currentCommit'] = 'd' * 40
        elif fault == 'projection': receipt['projectionSha256'] = 'd' * 64
        elif fault == 'extra': receipt['secret'] = 'SYNTHETIC_SECRET_NEVER_EMITTED'
        elif fault == 'count': receipt['servicesVerified'] = True
        for name in a.CONFIRM_HELPERS:
            p = Path(root) / 'scripts/production-release' / name
            p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b'# fixture helper\n')
        calls, parameters = [], []
        def aws(args, **kwargs):
            self.assertEqual(args[0], 'aws'); calls.append(args[1:3])
            if args[1:3] == ['ssm', 'send-command']:
                parameters.append(json.loads(args[args.index('--parameters') + 1]))
                output = {'Command': {'CommandId': command}}
            else:
                output = {'CommandId': command, 'InstanceId': 'i-05836da38606e633c', 'Status': 'Success',
                    'ResponseCode': 0, 'StandardErrorContent': '', 'StandardOutputContent': json.dumps(receipt)}
                if fault == 'invocation': output['CommandId'] = 'f' * 36
                if fault == 'duplicate': output['StandardOutputContent'] = '{"status":"wrong",' + json.dumps(receipt)[1:]
                if fault == 'failure':
                    output.update(Status='Failed', ResponseCode=1, StandardOutputContent=json.dumps({
                        'status': 'ADMIN_ONLY_RELEASE_FAILED', 'code': 'ADMIN_PENDING_DISK_CAPACITY_INSUFFICIENT'}))
            return SimpleNamespace(returncode=0, stdout=json.dumps(output), stderr='')
        env = {'RELEASE_OPERATION': 'verify_access', 'EXPECTED_CURRENT': a.CONFIRM_BASELINE,
            'RELEASE_COMMIT': candidate, 'SOURCE_TREE': tree,
            'PRODUCTION_INSTANCE_ID': 'i-05836da38606e633c', 'AWS_REGION': 'ap-northeast-1'}
        old = Path.cwd(); captured = io.StringIO()
        try:
            os.chdir(root)
            with patch.dict(os.environ, env), patch.object(a.subprocess, 'run', side_effect=aws), \
                 patch.object(a, 'source_projection', return_value=({}, {}, {'projectionSha256': 'c' * 64}, {}, None)), \
                 redirect_stdout(captured):
                if fault:
                    with self.assertRaisesRegex(RuntimeError, 'CONFIRM_ACCESS_PREFLIGHT_FAILED'):
                        a.confirm_access_transport()
                else:
                    self.assertEqual(a.confirm_access_transport(), receipt)
        finally:
            os.chdir(old)
        self.assertNotIn('SYNTHETIC_SECRET', captured.getvalue())
        return calls, parameters, a.read_json(Path(root) / '.deploy/production-release/admin-confirm-preflight-invocation.json')

    def test_exact_invocation_receipt_and_five_helper_seals_are_saved_as_safe_evidence(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as root:
            calls, parameters, metadata = self.execute(root)
            self.assertEqual(calls, [['ssm', 'send-command'], ['ssm', 'get-command-invocation']])
            self.assertTrue(metadata['preflightVerified'])
            commands = parameters[0]['commands']
            self.assertTrue(commands[-1].endswith(' --expected-current ' + a.CONFIRM_BASELINE))
            self.assertIn(' preflight --commit ', commands[-1])
            for name in a.CONFIRM_HELPERS: self.assertIn(name, commands[-2])
            self.assertFalse(any(' release ' in row or 'docker restart' in row or 'systemctl' in row for row in commands))
            self.assertEqual(parameters[0]['executionTimeout'], ['600'])

    def test_wrong_origin_projection_invocation_duplicate_extra_fields_boolean_and_failed_command_rejected(self):
        for fault in ('origin', 'projection', 'invocation', 'duplicate', 'extra', 'count', 'failure'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory(dir=RUNTIME) as root:
                _, _, metadata = self.execute(root, fault)
                self.assertFalse(metadata['preflightVerified'])
                self.assertFalse((Path(root) / '.deploy/production-release/admin-confirm-preflight-result.json').exists())
                if fault == 'failure': self.assertEqual(metadata['serverCode'], 'ADMIN_PENDING_DISK_CAPACITY_INSUFFICIENT')


if __name__=='__main__':unittest.main()
