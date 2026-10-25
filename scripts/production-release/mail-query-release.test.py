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

    def switch_fixture(self, fail=False):
        parent = HERE.parents[1] / '.runtime/mail-query-switch-tests'
        parent.mkdir(parents=True,exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name);(base/'.staging').mkdir(); previous=base/'releases/original';previous.mkdir(parents=True)
        captured={'current':str(previous),'apiModules':self.proof['baselineApiModules'],'services':{},'businessActions':0}
        for role in (*m.PRESERVED,'api','admin','online-recharge'):
            captured['services'][role]={'image':'old-'+role,'containerId':'container-'+role,'environmentSha256':'same'}
        (previous/'release-manifest.json').write_text(json.dumps({'commit':m.CURRENT,'images':{},'roleSourceProjections':{}}))
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
        p=SimpleNamespace(verify_image=Mock())
        fence=SimpleNamespace(acquire=Mock(),check_idle=Mock(),close=Mock())
        marker=base/'maintenance.json'
        def claim(*args):marker.write_text('synthetic owned marker');return {'paths':[str(marker)]}
        def remove(*args):self.assertEqual(marker.read_text(),'synthetic owned marker');marker.unlink()
        finite=SimpleNamespace(claim_markers=None,release_markers=Mock(side_effect=remove),sql_fence_class=lambda _:lambda *_:fence)
        retired=SimpleNamespace(SCOPE=None,claim_retired_markers=Mock(side_effect=claim))
        available=SimpleNamespace(acquire_release_lock=Mock(),normalize_image_context=Mock())
        modules={'recharge-availability-release.py':available,'proxy-result-identity-release.py':finite,'online-query-network-release.py':retired}
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
        calls=[call.args[1:] for call in d.compose.call_args_list]
        self.assertEqual(calls[:2],[('stop','online-recharge'),('stop','api')])
        self.assertEqual(calls[2],('up','-d','--no-deps','--no-build','--pull','never','api','admin'))
        self.assertEqual(calls[3][-2:],('--force-recreate','online-recharge'))
        self.assertEqual([x.args[1] for x in d.wait_healthy.call_args_list],['api','admin','online-recharge'])
        self.assertFalse(marker.exists());d.point_current.assert_called_once()

    def test_failed_switch_keeps_owned_marker_and_never_moves_pointer_or_rolls_back(self):
        plan,c,d,fence,marker,base=self.switch_fixture(fail=True)
        with self.assertRaisesRegex(RuntimeError,'synthetic startup failed'):m.release(plan,c)
        self.assertTrue(marker.exists());d.point_current.assert_not_called();fence.close.assert_called()
        journal=list((base/'.staging').rglob('switch-state.json'));self.assertEqual(len(journal),1)
        value=json.loads(journal[0].read_bytes());self.assertEqual(value['status'],'NEEDS_FORWARD_DIAGNOSIS')
        self.assertFalse(value['rollbackPerformed'])


if __name__ == '__main__':
    unittest.main()
