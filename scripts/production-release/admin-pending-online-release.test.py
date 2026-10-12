"""Exact source projection and offline Admin publication; no production traffic."""
import copy
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
RUNTIME = ROOT / '.runtime/admin-independent-release-tests'; RUNTIME.mkdir(parents=True, exist_ok=True)


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


if __name__=='__main__':unittest.main()
