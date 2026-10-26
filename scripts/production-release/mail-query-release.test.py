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
                  'sources':{source:'a'*64},'apiModules':[module],'baselineApiModules':{module:'1'*64},'adminFiles':{'index.html':'b'*64}}
        self.c['sourceProjectionSha256'] = m.sha(m.canonical(self.c['sources']))
        self.plan = {'commit':'c'*40,'tree':'d'*40,'workflowRunId':'123','workflowRunAttempt':'1',
                     'contractSha256':'e'*64,'controlSources':{'mail-query-release.py':'f'*64},
                     'nativeParentCapture':{'apiModules':{module:'1'*64}},
                     'qualitySourceEvidence':{'source':{'pullRequest':735}}}
        self.files = {'admin/html/index.html':'3'*64,'source/'+source:'a'*64}
        self.proof = {**copy.deepcopy(self.plan),'scope':m.SCOPE,'sources':self.c['sources'],
                      'apiModules':{module:'1'*64},'baselineApiModules':{module:'1'*64},
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
        proof['apiModules']=dict(proof['baselineApiModules'])
        proof['adminFiles']={n:inventory['admin/html/'+n] for n in proof['adminFiles']}
        c=copy.deepcopy(self.c);c['sources']={n:inventory['source/'+n] for n in c['sources']}
        c['sourceProjectionSha256']=m.sha(m.canonical(c['sources']));proof['sources']=c['sources']
        plan={**self.plan,'mode':'release','nativeParentCapture':captured,
              'contractSha256':m.sha((control/m.CONTRACT_FILE).read_bytes()),'controlSources':{},
              'artifactSha256':m.sha(b'archive'),'artifactUrl':'https://github.com/wangchaozhuanyong/id-business-system/releases/download/mail-query-'+self.plan['commit']+'/mail-query-artifact.tar.gz'}
        proof.update({k:v for k,v in plan.items() if k in self.plan})
        raw=json.dumps(proof).encode();(source/'build-proof.json').write_bytes(raw);plan['buildProofSha256']=m.sha(raw)
        after=copy.deepcopy(captured['services'])
        after['admin']['image']='new-admin'
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

    def test_switch_updates_only_admin_and_never_stops_business_services(self):
        plan,c,d,fence,marker,base=self.switch_fixture()
        result=m.release(plan,c)
        self.assertEqual(result['status'],'MAIL_QUERY_DEPLOYED')
        manifest=json.loads(next((base/'releases').glob('*mail-query/release-manifest.json')).read_bytes())
        self.assertEqual({manifest[n] for n in ('commit','applicationCommit','controlCommit')},{plan['commit']})
        self.assertEqual(manifest['version'],'v2-'+plan['commit'])
        self.assertEqual(manifest['buildProofSha256'],plan['buildProofSha256'])
        self.assertNotIn('acceptedSwitchCommandId',manifest)
        self.assertEqual(manifest['servicesUpdated'],['admin'])
        self.assertEqual(manifest['servicesRebound'],[])
        self.assertEqual([call.args[1:] for call in d.compose.call_args_list],
            [('up','-d','--no-deps','--no-build','--pull','never','admin')])
        self.assertEqual([x.args[1] for x in d.wait_healthy.call_args_list],['admin'])
        fence.acquire.assert_not_called();d.point_current.assert_called_once()
        self.assertEqual(set(manifest['actualDeployment']['images']),{'admin'})
        self.assertTrue(all(manifest['actualDeployment']['before'][n]==manifest['actualDeployment']['after'][n] for n in m.PRESERVED))

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

    def test_failed_switch_never_moves_pointer_or_rolls_back(self):
        plan,c,d,fence,marker,base=self.switch_fixture(fail=True)
        with self.assertRaisesRegex(RuntimeError,'synthetic startup failed'):m.release(plan,c)
        d.point_current.assert_not_called();fence.acquire.assert_not_called()
        journal=list((base/'.staging').rglob('switch-state.json'));self.assertEqual(len(journal),1)
        value=json.loads(journal[0].read_bytes());self.assertEqual(value['status'],'NEEDS_FORWARD_DIAGNOSIS')
        self.assertFalse(value['rollbackPerformed'])

    def test_api_payload_change_is_rejected_even_when_hashes_are_self_consistent(self):
        value=copy.deepcopy(self.proof);value['apiModules']={n:'0'*64 for n in value['apiModules']}
        with self.assertRaisesRegex(RuntimeError,'BASELINE_NOT_REPRODUCED'):
            m.verify_proof(value,self.plan,self.c,self.files)

    def native_snapshot_fixture(self):
        parent=HERE.parents[1]/'.runtime/mail-query-parent-tests';parent.mkdir(parents=True,exist_ok=True)
        temporary=tempfile.TemporaryDirectory(dir=parent);self.addCleanup(temporary.cleanup)
        base=Path(temporary.name);previous=base/'releases/published';previous.mkdir(parents=True)
        (base/'current').symlink_to(previous,target_is_directory=True)
        prior=json.loads((HERE/'online-profile-lock-contract.json').read_bytes())
        states={n:{'image':v,'containerId':'synthetic-'+n,'status':'running','health':None if n=='caddy' else 'healthy'}
                for n,v in prior['expectedImages'].items()}
        receipt={'commit':m.CURRENT,'before':states,'after':states,'businessActions':0}
        files={'release-manifest.json':{'commit':m.CURRENT,'status':'DEPLOYED','scope':m.SCOPE,'actualDeployment':receipt},
               'mail-query-preservation.json':receipt,
               'mail-query-build-proof.json':{'commit':m.CURRENT,'adminFiles':self.c['adminFiles'],'apiModules':self.proof['baselineApiModules'],'nativeParentCapture':{}}}
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
        profile=SimpleNamespace(helpers=Mock(return_value=(h,d,SimpleNamespace(read_hashes=Mock()))),content=Mock(),engine_content=Mock())
        billing=SimpleNamespace(smoke=Mock());profile.billing=billing
        stack=ExitStack();self.addCleanup(stack.close)
        stack.enter_context(patch.object(m,'BASE',base));stack.enter_context(patch.object(m,'load',return_value=profile))
        stack.enter_context(patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=7*1024**3)))
        stack.enter_context(patch.object(m,'published_billing',return_value=(billing,{},files['mail-query-build-proof.json'])))
        stack.enter_context(patch.object(m,'smoke'))
        return c,previous,h,profile

    def test_new_official_parent_retains_both_runtime_and_control_publication_proofs(self):
        c,previous,h,profile=self.native_snapshot_fixture()
        captured,*_=m.snapshot(c)
        self.assertEqual(captured['expectedCurrent'],m.CURRENT)
        self.assertEqual(captured['apiModules'],c['baselineApiModules'])
        self.assertEqual(captured['businessActions'],0)
        profile.content.assert_not_called()

    def test_parent_receipt_bytes_cannot_change_after_native_binding(self):
        c,previous,h,profile=self.native_snapshot_fixture()
        path=previous/'mail-query-preservation.json';path.write_bytes(path.read_bytes()+b' ')
        with self.assertRaisesRegex(RuntimeError,'PARENT_PROOF_CHANGED'):m.snapshot(c)
        h.snapshot.assert_not_called()

    def test_new_parent_requires_exact_recorded_containers_before_build_or_switch(self):
        c,previous,h,profile=self.native_snapshot_fixture()
        h.snapshot.return_value['api']['containerId']='another-container'
        with self.assertRaisesRegex(RuntimeError,'PARENT_SERVICES_CHANGED'):m.snapshot(c)
        h.guards.assert_not_called();profile.billing.smoke.assert_not_called()


class PublishedBillingTests(unittest.TestCase):
    def setUp(self):
        parent=HERE.parents[1]/'.runtime/mail-query-billing-binding-tests'
        parent.mkdir(parents=True,exist_ok=True)
        temporary=tempfile.TemporaryDirectory(dir=parent);self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name);self.controls=self.root/'scripts/production-release'
        self.controls.mkdir(parents=True)
        contract={'sources':{'apps/api/reviewed.ts':'a'*64}}
        (self.controls/'recharge-plan-billing-contract.json').write_text(json.dumps(contract))
        (self.controls/'recharge-plan-billing-release.py').write_text("PUBLISHED_IDENTITY = 'synthetic-verified-parent'\n")
        self.proof={'commit':m.BILLING_CURRENT,'scope':'RECHARGE_PLAN_BILLING_20261026','sources':contract['sources'],
                    'contractSha256':m.sha((self.controls/'recharge-plan-billing-contract.json').read_bytes()),
                    'controlSources':{p.name:m.sha(p.read_bytes()) for p in self.controls.iterdir()}}
        self.bind()

    def bind(self):
        path=self.root/'recharge-plan-billing-build-proof.json';path.write_text(json.dumps(self.proof))
        self.c={'billingProofSha256':m.sha(path.read_bytes())}

    def test_only_the_recorded_published_helper_is_loaded(self):
        module,contract,proof=m.published_billing(self.root,self.c)
        self.assertEqual(module.PUBLISHED_IDENTITY,'synthetic-verified-parent')
        self.assertEqual(contract['sources'],proof['sources'])

    def test_mutated_helper_and_contract_are_rejected_before_import(self):
        for name in ('recharge-plan-billing-release.py','recharge-plan-billing-contract.json'):
            path=self.controls/name;original=path.read_bytes();path.write_bytes(original+b' ')
            with self.subTest(name=name),self.assertRaisesRegex(RuntimeError,'BILLING_CONTROL_CHANGED'):
                m.published_billing(self.root,self.c)
            path.write_bytes(original)

    def test_another_release_cannot_replace_the_published_parent(self):
        self.proof['commit']='f'*40;self.bind()
        with self.assertRaisesRegex(RuntimeError,'BILLING_IDENTITY_CHANGED'):m.published_billing(self.root,self.c)

    def test_proof_bytes_must_match_the_native_parent(self):
        path=self.root/'recharge-plan-billing-build-proof.json';path.write_bytes(path.read_bytes()+b' ')
        with self.assertRaisesRegex(RuntimeError,'BILLING_PROOF_CHANGED'):m.published_billing(self.root,self.c)


class AvailabilityTests(unittest.TestCase):
    def fixture(self):
        parent=HERE.parents[1]/'.runtime/mail-query-availability-tests';parent.mkdir(parents=True,exist_ok=True)
        temporary=tempfile.TemporaryDirectory(dir=parent);self.addCleanup(temporary.cleanup)
        base=Path(temporary.name);(base/'.staging').mkdir()
        patcher=patch.object(m,'BASE',base);patcher.start();self.addCleanup(patcher.stop)
        original={role:{'containerId':role,'image':'same-image','reference':'same-reference','environmentSha256':'same-env',
                  'startedAtSha256':'old-start','status':'running','health':'healthy'}
                  for role in ('api','online-recharge','admin','mysql','caddy','media-resolver','auto-recharge')}
        states=copy.deepcopy(original)
        for role in ('api','online-recharge'):states[role]['startedAtSha256']='new-start'
        recovery={'status':'ORIGINAL_SERVICE_AVAILABILITY_RESTORED','commit':m.CURRENT,
            'manifestSha256':'a'*64,'before':original,'after':states,'imagesRebuilt':False,
            'migrationPerformed':False,'versionRolledBack':False,'businessActions':0}
        path=base/'.staging/mail-query-original-availability-123.json';path.write_text(json.dumps(recovery))
        c={'parentFiles':{'release-manifest.json':'a'*64},'availabilityRecovery':{'path':str(path),'sha256':m.sha(path.read_bytes())}}
        return c,states,original,path,recovery

    def test_exact_authorized_original_container_restart_proof_is_accepted(self):
        c,states,original,path,recovery=self.fixture()
        self.assertEqual(m.verify_availability(c,states,original),c['availabilityRecovery']['sha256'])

    def test_recovery_receipt_cannot_authorize_different_images_or_other_service_restarts(self):
        for role,key,value in [('api','image','other-image'),('admin','startedAtSha256','another-start')]:
            c,states,original,path,recovery=self.fixture();states[role][key]=value
            recovery['after']=states;path.write_text(json.dumps(recovery));c['availabilityRecovery']['sha256']=m.sha(path.read_bytes())
            with self.subTest(role=role),self.assertRaises(RuntimeError):m.verify_availability(c,states,original)


class GuardReuseTests(unittest.TestCase):
    def setUp(self):
        self.pub=m.load('mail-query-publication.py')
        self.rows=b'100644 blob '+b'a'*40+b'\tscripts/production-release/api-admin-scope.py\n'
        self.current=self.rows
        def git(*args):
            if args[0]=='fetch':return b''
            if args[0]=='rev-parse':return m.SOURCE_TREE.encode()
            if args[0]=='ls-tree':return self.rows if args[-1]==m.SOURCE else self.current
            raise AssertionError(args)
        self.log=('2026-10-26T00:00:00Z ##[group]Runner Image\n'
                  '2026-10-26T00:00:00Z Image: ubuntu-24.04\n'
                  '2026-10-26T00:00:00Z Version: fixture-image\n'
                  '2026-10-26T00:00:00Z ##[endgroup]\n'
                  '2026-10-26T00:00:00Z ##[group]Environment details\n'
                  '2026-10-26T00:00:00Z node: v24.21.0\n'
                  '2026-10-26T00:00:00Z npm: 11.19.0\n'
                  '2026-10-26T00:00:00Z ##[endgroup]\n').encode()
        def execute(*args):
            if args==('node','--version'):return b'v24.21.0'
            if args==('npm','--version'):return b'11.19.0'
            if args[0]=='gh' and args[-1].endswith('/logs'):return self.log
            raise AssertionError(args)
        def github(path):
            if path=='pulls/735':return {'merged_at':'fixture','head':{'sha':m.SOURCE}}
            return {'jobs':[{'id':456,'name':'recharge (guards)','status':'completed','conclusion':'success'}]}
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(self.pub.os.environ,{'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':self.pub.REPO,'ImageOS':'ubuntu24','ImageVersion':'fixture-image'}))
        self.stack.enter_context(patch.object(self.pub.sys,'platform','linux'))
        self.stack.enter_context(patch.object(self.pub,'git',side_effect=git))
        self.stack.enter_context(patch.object(self.pub,'execute',side_effect=execute))
        self.stack.enter_context(patch.object(self.pub,'check'))
        self.stack.enter_context(patch.object(self.pub,'github',side_effect=github))
        self.qa=self.stack.enter_context(patch.object(self.pub,'verified_run',return_value={'runId':'123','runAttempt':'1','sourceReceiptSha256':'a'*64}))
        self.stack.enter_context(patch('builtins.print'))

    def test_reuse_requires_complete_native_source_qa_identical_inputs_and_environment(self):
        result=self.pub.guard_reuse({})
        self.qa.assert_called_once_with(m.SOURCE,'pull_request',m.SOURCE_TREE,735)
        self.assertTrue(result['reused'])
        self.assertEqual(result['environment']['guardLogSha256'],m.sha(self.log))
        self.assertEqual(result['retainedInputsSha256'],m.sha(self.rows.rstrip(b'\n')))

    def test_changed_legacy_helper_requires_fresh_checks(self):
        self.current=self.rows.replace(b'a'*40,b'b'*40)
        self.assertFalse(self.pub.guard_reuse({})['reused'])

    def test_environment_change_or_unmeasured_logs_requires_fresh_checks(self):
        with patch.dict(self.pub.os.environ,{'ImageVersion':'another-image'}):
            self.assertFalse(self.pub.guard_reuse({})['reused'])
        self.log=b'no measured environment'
        self.assertFalse(self.pub.guard_reuse({})['reused'])

    def test_failed_native_source_quality_cannot_be_replaced_by_reuse(self):
        self.qa.side_effect=RuntimeError('MAIL_QUERY_QUALITY_REQUIRED')
        with self.assertRaisesRegex(RuntimeError,'QUALITY_REQUIRED'):self.pub.guard_reuse({})

    def test_local_or_other_repository_cannot_supply_native_reuse_evidence(self):
        with patch.dict(self.pub.os.environ,{'GITHUB_REPOSITORY':'other/repository'}):
            with self.assertRaisesRegex(RuntimeError,'NATIVE_GUARD_REQUIRED'):self.pub.guard_reuse({})
        self.qa.assert_not_called()


if __name__ == '__main__':
    unittest.main()
