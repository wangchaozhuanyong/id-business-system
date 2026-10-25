"""Reject provenance, payload and live-baseline drift before any publication."""
import copy
import importlib.util
import json
from pathlib import Path
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import Mock, patch
import shutil
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mail_query', HERE / 'mail-query-release.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ProofTests(unittest.TestCase):
    def setUp(self):
        source = 'apps/api/src/id-business-v2/workspace/vendure-mailbox-list.ts'
        module = 'id-business-v2/workspace/vendure-mailbox-list.js'
        self.c = {'scope':m.SCOPE,'expectedCurrent':m.CURRENT,'migrationPerformed':False,'businessActions':0,
                  'sources':{source:'a'*64},'apiModules':[module],'adminFiles':{'index.html':'b'*64}}
        self.c['sourceProjectionSha256'] = m.sha(m.canonical(self.c['sources']))
        self.plan = {'commit':'c'*40,'tree':'d'*40,'workflowRunId':'123','workflowRunAttempt':'1',
                     'contractSha256':'e'*64,'controlSources':{'mail-query-release.py':'f'*64},
                     'nativeParentCapture':{'apiModules':{module:'1'*64}},
                     'qualitySourceEvidence':{'source':{'pullRequest':721}}}
        self.files = {'api/modules/'+module:'2'*64,'admin/html/index.html':'3'*64,'source/'+source:'a'*64}
        self.proof = {**copy.deepcopy(self.plan),'scope':m.SCOPE,'sources':self.c['sources'],
                      'apiModules':{module:'2'*64},'baselineApiModules':{module:'1'*64},
                      'baselineAdminFiles':self.c['adminFiles'],'adminFiles':{'index.html':'3'*64},
                      'files':self.files,'migrationPerformed':False,'businessActions':0}

    def test_exact_native_proof_is_accepted(self):
        m.verify_proof(self.proof,self.plan,self.c,self.files)

    def test_every_native_identity_field_is_bound(self):
        for key in self.plan:
            value=copy.deepcopy(self.proof);value[key]='changed'
            with self.subTest(key=key),self.assertRaises(RuntimeError):
                m.verify_proof(value,self.plan,self.c,self.files)

    def test_live_module_and_admin_bytes_must_be_reproduced(self):
        for key in ('baselineApiModules','baselineAdminFiles'):
            value=copy.deepcopy(self.proof);value[key]={'unexpected':'0'*64}
            with self.subTest(key=key),self.assertRaises(RuntimeError):
                m.verify_proof(value,self.plan,self.c,self.files)

    def test_no_engine_or_unrelated_module_can_enter_artifact(self):
        for name in ('engine/worker.js','api/modules/orders.js','source/.env.aws.production'):
            files={**self.files,name:'0'*64};value={**self.proof,'files':files}
            with self.subTest(name=name),self.assertRaises(RuntimeError):
                m.verify_proof(value,self.plan,self.c,files)

    def test_business_effect_or_migration_claim_is_rejected(self):
        for key,value in (('migrationPerformed',True),('businessActions',1),('businessActions',False)):
            with self.subTest(key=key,value=value),self.assertRaises(RuntimeError):
                m.verify_proof({**self.proof,key:value},self.plan,self.c,self.files)

    def test_source_projection_and_payload_hashes_are_bound(self):
        with self.assertRaises(RuntimeError):
            m.verify_proof(self.proof,self.plan,{**self.c,'sourceProjectionSha256':'0'*64},self.files)
        files={**self.files,'admin/html/index.html':'0'*64}
        with self.assertRaises(RuntimeError):
            m.verify_proof({**self.proof,'files':files},self.plan,self.c,files)

    def switch_fixture(self, fail=False, fail_recovery=False):
        parent = HERE.parents[1] / '.runtime/mail-query-switch-tests'
        parent.mkdir(parents=True,exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name);(base/'.staging').mkdir(); previous=base/'releases/original';previous.mkdir(parents=True)
        captured={'current':str(previous),'apiModules':self.proof['baselineApiModules'],'services':{},'businessActions':0,'manifestSha256':'a'*64}
        for role in (*m.PRESERVED,'api','admin','online-recharge'):
            captured['services'][role]={'image':'old-'+role,'containerId':'container-'+role,'environmentSha256':'same'}
        (previous/'release-manifest.json').write_text(json.dumps({'commit':m.CURRENT,'images':{},'roleSourceProjections':{},'applicationCommit':'old-app','controlCommit':'old-control','version':'old-version','buildProofSha256':'old-proof','acceptedSwitchCommandId':'old-command'}))
        (previous/'compose.release.json').write_text(json.dumps({'services':{n:{'image':'old-'+n} for n in captured['services']}}))
        control=base/'controls';control.mkdir();(control/m.CONTRACT_FILE).write_text(json.dumps(self.c))
        source=base/'payload';source.mkdir()
        for name in self.files:
            path=source/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('synthetic '+name)
        inventory=m.H.file_inventory(source)
        proof=copy.deepcopy(self.proof);proof['files']=inventory
        proof['apiModules']={n:inventory['api/modules/'+n] for n in proof['apiModules']}
        proof['adminFiles']={n:inventory['admin/html/'+n] for n in proof['adminFiles']}
        c=copy.deepcopy(self.c);c['sources']={n:inventory['source/'+n] for n in c['sources']}
        c['sourceProjectionSha256']=m.sha(m.canonical(c['sources']));proof['sources']=c['sources']
        plan={**self.plan,'mode':'release','nativeParentCapture':captured,
              'contractSha256':m.sha((control/m.CONTRACT_FILE).read_bytes()),'controlSources':{},
              'artifactSha256':m.sha(b'archive'),'artifactUrl':'https://github.com/wangchaozhuanyong/id-business-system/releases/download/mail-query-'+self.plan['commit']+'/mail-query-artifact.tar.gz'}
        proof.update({k:v for k,v in plan.items() if k in self.plan})
        raw=json.dumps(proof).encode();(source/'build-proof.json').write_bytes(raw);plan['buildProofSha256']=m.sha(raw)
        after=copy.deepcopy(captured['services'])
        for role in ('api','admin'):after[role]['image']='new-'+role
        after['online-recharge']['containerId']='rebound-original-engine'
        def run(*args,**kwargs):
            if args[:3]==('docker','image','inspect'):
                name=args[3];return json.dumps([{'Id':'new-'+name.rsplit('-',1)[-1]}])
            raise AssertionError(args)
        def compose(directory,*args,**kwargs):
            if fail and args[:2]==('up','-d'):raise RuntimeError('synthetic startup failed')
        d=SimpleNamespace(run=Mock(side_effect=run),compose=Mock(side_effect=compose),wait_healthy=Mock(),point_current=Mock())
        def extract(_raw,destination):
            target=destination/'payload';shutil.copytree(source,target);return target
        h=SimpleNamespace(safe_archive=extract,file_inventory=m.H.file_inventory,base_image_reference=lambda *_:'synthetic:base',
            build_image=Mock(),fresh_scoped_backup=Mock(return_value={'s3Verified':True}),snapshot=Mock(return_value=after),guards=Mock())
        recovery=SimpleNamespace(recover=Mock(return_value={'recoveredLocks':0}))
        if fail_recovery:recovery.recover.side_effect=RuntimeError('synthetic recovery failed')
        p=SimpleNamespace(verify_image=Mock(),profile_recovery_source=lambda _:recovery,
            stop_recharge_and_recover=m.load('online-checkout-release.py').stop_recharge_and_recover)
        fence=SimpleNamespace(acquire=Mock(),check_idle=Mock(),close=Mock())
        marker=base/'maintenance.json'
        def claim(*args):marker.write_text('synthetic owned marker');return {'paths':[str(marker)]}
        def remove(*args):self.assertEqual(marker.read_text(),'synthetic owned marker');marker.unlink()
        finite=SimpleNamespace(claim_markers=None,release_markers=Mock(side_effect=remove),sql_fence_class=lambda _:lambda *_:fence)
        retired=SimpleNamespace(SCOPE=None,claim_retired_markers=Mock(side_effect=claim))
        available=SimpleNamespace(acquire_release_lock=Mock(),normalize_image_context=Mock())
        modules={'recharge-availability-release.py':available,'proxy-result-identity-release.py':finite,'online-query-network-release.py':retired,
                 'online-profile-lock-release.py':SimpleNamespace(helpers=lambda _:(h,d,p))}
        (control/'online-profile-lock-contract.json').write_text('{}')
        stack=ExitStack();self.addCleanup(stack.close)
        stack.enter_context(patch.object(m,'BASE',base));stack.enter_context(patch.object(m,'HERE',control))
        stack.enter_context(patch.object(m,'load',side_effect=lambda name:modules[name]))
        stack.enter_context(patch.object(m,'snapshot',return_value=(captured,{'backupNormalizerPath':str(base/'normalizer')},h,d,p)))
        stack.enter_context(patch.object(m,'smoke'))
        response=Mock();response.__enter__=Mock(return_value=SimpleNamespace(read=lambda _:b'archive'));response.__exit__=Mock(return_value=False)
        stack.enter_context(patch.object(m.urllib.request,'urlopen',return_value=response))
        return plan,c,d,fence,marker,base

    def test_parent_and_preflight_retain_identical_native_capture(self):
        plan,c,d,fence,marker,base=self.switch_fixture()
        parent=m.release({**plan,'mode':'parent'},c)
        result=m.release({**plan,'mode':'preflight','nativeParentCapture':parent},c)
        self.assertEqual(result['status'],'MAIL_QUERY_PREFLIGHT_VERIFIED')
        d.compose.assert_not_called();d.point_current.assert_not_called()

    def test_switch_starts_both_web_roles_and_rebinds_original_engine(self):
        plan,c,d,fence,marker,base=self.switch_fixture()
        result=m.release(plan,c)
        self.assertEqual(result['status'],'MAIL_QUERY_DEPLOYED')
        manifest=json.loads(next((base/'releases').glob('*mail-query/release-manifest.json')).read_bytes())
        self.assertEqual({manifest[n] for n in ('commit','applicationCommit','controlCommit')},{plan['commit']})
        self.assertEqual(manifest['version'],'v2-'+plan['commit'])
        self.assertEqual(manifest['buildProofSha256'],plan['buildProofSha256'])
        self.assertEqual(manifest['apiCompiledArtifact'],manifest['adminCompiledArtifact'])
        self.assertNotIn('acceptedSwitchCommandId',manifest)
        calls=[call.args[1:] for call in d.compose.call_args_list]
        self.assertEqual(calls[:2],[('stop','online-recharge'),('stop','api')])
        self.assertEqual(calls[2],('up','-d','--no-deps','--no-build','--pull','never','api','admin'))
        self.assertEqual(calls[3][-2:],('--force-recreate','online-recharge'))
        self.assertEqual([x.args[1] for x in d.wait_healthy.call_args_list],['api','admin','online-recharge'])
        self.assertFalse(marker.exists());d.point_current.assert_called_once()

    def test_independent_readback_binds_running_state_and_formal_source_tree(self):
        plan,c,d,fence,marker,base=self.switch_fixture()
        m.release(plan,c)
        target=d.point_current.call_args.args[0];(base/'current').symlink_to(target,target_is_directory=True)
        result=m.release({**plan,'mode':'readback'},c)
        self.assertEqual(result['status'],'MAIL_QUERY_INDEPENDENT_READBACK_VERIFIED')
        manifest=target/'release-manifest.json';value=json.loads(manifest.read_bytes())
        value['sourceTree']='e'*40;manifest.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError,'READBACK_CHANGED'):
            m.release({**plan,'mode':'readback'},c)

    def test_failed_switch_keeps_owned_marker_and_never_moves_pointer_or_rolls_back(self):
        plan,c,d,fence,marker,base=self.switch_fixture(fail=True)
        with self.assertRaisesRegex(RuntimeError,'synthetic startup failed'):m.release(plan,c)
        self.assertTrue(marker.exists());d.point_current.assert_not_called();fence.close.assert_called()
        journal=list((base/'.staging').rglob('switch-state.json'));self.assertEqual(len(journal),1)
        value=json.loads(journal[0].read_bytes());self.assertEqual(value['status'],'NEEDS_FORWARD_DIAGNOSIS')
        self.assertFalse(value['rollbackPerformed'])

    def test_profile_recovery_failure_cannot_start_new_images_or_move_the_current_pointer(self):
        plan,c,d,fence,marker,base=self.switch_fixture(fail_recovery=True)
        with self.assertRaisesRegex(RuntimeError,'synthetic recovery failed'):m.release(plan,c)
        self.assertTrue(marker.exists());d.point_current.assert_not_called();fence.close.assert_called()
        self.assertFalse(any(call.args[1]=='up' for call in d.compose.call_args_list))

    def native_snapshot_fixture(self):
        parent=HERE.parents[1]/'.runtime/mail-query-parent-tests';parent.mkdir(parents=True,exist_ok=True)
        temporary=tempfile.TemporaryDirectory(dir=parent);self.addCleanup(temporary.cleanup)
        base=Path(temporary.name);previous=base/'releases/published';previous.mkdir(parents=True)
        (base/'current').symlink_to(previous,target_is_directory=True)
        prior=json.loads((HERE/'online-profile-lock-contract.json').read_bytes())
        states={n:{'image':v,'containerId':'synthetic-'+n,'status':'running','health':None if n=='caddy' else 'healthy'}
                for n,v in prior['expectedImages'].items()}
        receipt={'commit':m.CURRENT,'imagesRebuilt':False,'after':states,'businessActions':0}
        files={'release-manifest.json':{'commit':m.CURRENT,'status':'DEPLOYED','profileLockPublication':receipt},
               'online-profile-lock-preservation.json':receipt,
               'online-profile-lock-build-proof.json':{'commit':m.CURRENT},
               'online-checkout-build-proof.json':{'commit':'034f737d551412928e99f589370b937f2b263593'}}
        for name,value in files.items():(previous/name).write_text(json.dumps(value))
        for name in ('.env.aws.production','compose.release.json','docker-compose.aws-mysql.yml'):
            (previous/name).write_text('synthetic configuration only')
        c={**self.c,'parentRelease':str(previous),'parentFiles':{n:m.sha((previous/n).read_bytes()) for n in files},
           'baselineApiModules':self.proof['baselineApiModules']}
        def run(*args,**kwargs):
            if args[-1]=='/etc/nginx/conf.d/default.conf':return 'f'*64+'  '+args[-1]
            return '\n'.join(value+'  /app/apps/api/dist/'+name for name,value in c['baselineApiModules'].items())
        d=SimpleNamespace(run=Mock(side_effect=run))
        h=SimpleNamespace(snapshot=Mock(return_value=copy.deepcopy(states)),guards=Mock(),configuration=lambda *_:'opaque-hash')
        profile=SimpleNamespace(helpers=Mock(return_value=(h,d,SimpleNamespace())),content=Mock())
        stack=ExitStack();self.addCleanup(stack.close)
        stack.enter_context(patch.object(m,'BASE',base));stack.enter_context(patch.object(m,'load',return_value=profile))
        stack.enter_context(patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=7*1024**3)))
        return c,previous,h,profile

    def test_new_official_parent_retains_both_runtime_and_control_publication_proofs(self):
        c,previous,h,profile=self.native_snapshot_fixture()
        captured,*_=m.snapshot(c)
        self.assertEqual(captured['expectedCurrent'],m.CURRENT)
        self.assertEqual(captured['apiModules'],c['baselineApiModules'])
        self.assertEqual(captured['businessActions'],0)
        profile.content.assert_called_once();h.guards.assert_called_once()

    def test_parent_receipt_bytes_cannot_change_after_native_binding(self):
        c,previous,h,profile=self.native_snapshot_fixture()
        path=previous/'online-profile-lock-preservation.json';path.write_bytes(path.read_bytes()+b' ')
        with self.assertRaisesRegex(RuntimeError,'PARENT_PROOF_CHANGED'):m.snapshot(c)
        h.snapshot.assert_not_called()

    def test_new_parent_requires_exact_recorded_containers_before_build_or_switch(self):
        c,previous,h,profile=self.native_snapshot_fixture()
        h.snapshot.return_value['api']['containerId']='another-container'
        with self.assertRaisesRegex(RuntimeError,'PARENT_SERVICES_CHANGED'):m.snapshot(c)
        h.guards.assert_not_called();profile.content.assert_not_called()


if __name__ == '__main__':
    unittest.main()
