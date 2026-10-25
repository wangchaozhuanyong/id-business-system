"""Offline finite paired-release and preservation tests. No production access."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('proxy_failure_release', HERE / 'online-proxy-failure-evidence-release.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ProxyFailureReleaseTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())
        source = {'head': p.SOURCE, 'tree': p.SOURCE_TREE, 'pullRequest': 710, 'runId': '123', 'sourceReceiptSha256': 'd' * 64}
        control = {'head': 'c' * 40, 'tree': 'b' * 40, 'pullRequest': 711, 'runId': '124', 'sourceReceiptSha256': 'e' * 64}
        qa = {'source': source, 'control': control, 'main': {'head': 'a' * 40, 'runId': '125'}, 'commit': 'a' * 40, 'tree': 'b' * 40}
        self.plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '126', 'workflowRunAttempt': '1',
            'contractSha256': p.sha((HERE / p.CONTRACT_FILE).read_bytes()),
            'controlSources': {**self.c['controlPins'], p.CONTRACT_FILE: p.sha((HERE / p.CONTRACT_FILE).read_bytes())},
            'qualitySourceEvidence': qa,
            'nativeParentCapture': {'baseline': {}, 'status': 'ONLINE_CHECKOUT_RESUME_PARENT_VERIFIED', 'businessActions': 0}}
        self.c['baselineAdminFilesSha256'] = p.core().load('recharge-record-release.py').fingerprint({'index.html': 'd' * 64})
        modules = {n.removesuffix('.js') + ext: 'e' * 64 for n in self.c['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
        self.proof = {**self.plan, 'version': 1, 'scope': p.SCOPE, 'sources': self.c['sources'],
            'afterEngineFiles': self.c['afterEngineFiles'], 'baselineApiReproduced': True,
            'baselineAdminSourceReproduced': True, 'baselineAdminFiles': {'index.html': 'd' * 64},
            'adminFiles': {'index.html': 'd' * 64}, 'apiModules': modules, 'migrationPerformed': False, 'businessActions': 0}
        self.files = {**{'source/' + n: v for n, v in self.c['sources'].items()},
            **{'api/modules/' + n: v for n, v in modules.items()},
            **{'admin/html/' + n: v for n, v in self.proof['adminFiles'].items()},
            **{'engine/' + n: v for n, v in self.c['afterEngineFiles'].items() if self.c['beforeEngineFiles'].get(n) != v}}
        self.proof['files'] = self.files

    def test_valid_exact_triple_and_current_parent(self):
        p.validate_contract(self.c)
        p.verify_proof(self.proof, self.plan, self.c, self.files)
        self.assertEqual(p.UPDATED, ('api', 'admin', 'online-recharge'))
        self.assertEqual(self.c['parentArtifact']['commit'], p.CURRENT)
        self.assertEqual(self.c['parentPlan']['commit'], p.CURRENT)
        self.assertEqual(self.c['apiModules'], p.API)

    def test_common_switch_and_original_preservation_are_reused(self):
        original = p.load('online-checkout-resume-release.py')
        core = p.core()
        self.assertEqual(core.publish_pair.__code__.co_code, original.publish_pair.__code__.co_code)
        self.assertEqual(core.smoke.__code__.co_code, original.smoke.__code__.co_code)
        self.assertEqual(core.capture_parent, p.capture_parent)

    def test_parent_source_or_target_change_is_rejected(self):
        for key in ('expectedCurrent', 'sourceReviewCommit', 'awsTargetAccount', 'awsTargetInstance'):
            changed = copy.deepcopy(self.c); changed[key] = 'f' * 40
            with self.assertRaises(RuntimeError): p.validate_contract(changed)

    def test_admin_or_extra_api_module_is_rejected(self):
        for key, value in [('updatedServices', ['api', 'online-recharge']), ('apiModules', [*p.API, 'id-business-v2/orders.js'])]:
            changed = copy.deepcopy(self.c); changed[key] = value
            with self.assertRaises(RuntimeError): p.validate_contract(changed)

    def test_unreviewed_engine_or_source_change_is_rejected(self):
        for key in ('afterEngineFiles', 'sources'):
            changed = copy.deepcopy(self.c); changed[key]['extra.js'] = 'f' * 64
            with self.assertRaises(RuntimeError): p.validate_contract(changed)

    def test_extra_payload_and_private_browser_files_are_rejected(self):
        for name in ('api/modules/auth/session.js', 'engine/runtime/browser-profiles/cookie', 'admin/html/index.html'):
            with self.assertRaises(RuntimeError): p.verify_proof(self.proof, self.plan, self.c, {**self.files, name: 'f' * 64})

    def test_unreproduced_api_or_migration_is_rejected(self):
        for key, value in [('baselineApiReproduced', False), ('baselineAdminSourceReproduced', False), ('migrationPerformed', True), ('businessActions', 1)]:
            changed = {**self.proof, key: value}
            with self.assertRaises(RuntimeError): p.verify_proof(changed, self.plan, self.c, self.files)

    def test_source_quality_or_control_tree_cannot_be_substituted(self):
        for node, field in [('source', 'head'), ('source', 'tree'), ('control', 'tree'), ('main', 'head')]:
            changed = copy.deepcopy(self.proof); changed['qualitySourceEvidence'][node][field] = 'f' * 40
            with self.assertRaises(RuntimeError): p.verify_proof(changed, self.plan, self.c, self.files)

    def test_admin_inventory_and_sql_fence_are_bound(self):
        self.assertEqual(self.c['sqlFenceHelperSha256'], self.c['controlPins']['api-admin-scope.py'])
        changed = {**self.proof, 'adminFiles': {'index.html': 'f' * 64}}
        with self.assertRaises(RuntimeError): p.verify_proof(changed, self.plan, self.c, self.files)

    def test_both_jobs_receive_expected_current_and_one_release_lane(self):
        workflow = (HERE.parents[1] / '.github/workflows/online-proxy-failure-evidence-publication.yml').read_text()
        for job in ('validate', 'publish'):
            body = workflow.split('  ' + job + ':\n', 1)[1].split('\n  publish:', 1)[0]
            self.assertIn('      EXPECTED_CURRENT: ${{ inputs.expected_current }}', body)
        self.assertIn('group: id-business-v2-production-release', workflow)
        self.assertIn('cancel-in-progress: false', workflow)

    def test_failure_report_does_not_expose_raw_exception(self):
        report = p.failure_report(RuntimeError('Authorization: private'), {'mode': 'parent', 'controlSources': {}})
        self.assertNotIn('private', json.dumps(report))


    def test_parent_reproduction_and_triple_build_are_required(self):
        build = (HERE / 'online-proxy-failure-evidence-build.py').read_text()
        self.assertIn("PUBLISHED_API_NOT_REPRODUCED", build)
        self.assertIn("PUBLISHED_ADMIN_NOT_REPRODUCED", build)
        self.assertIn("admin / 'apps/admin/dist'", build)
        self.assertIn("card_read['sourceReviewCommit']", build)
        publication = (HERE / 'online-proxy-failure-evidence-publication.py').read_text()
        self.assertIn("'recharge (admin)'", publication)
        self.assertIn("pr_number == 710", publication)
        self.assertIn("COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN", publication)

    def test_control_payload_or_source_runtime_hashes_cannot_be_changed(self):
        for name in ('sources', 'expectedApiFiles'):
            changed = copy.deepcopy(self.c)
            changed[name][next(iter(changed[name]))] = '0' * 64
            with self.assertRaises(RuntimeError): p.validate_contract(changed)


    def test_original_normal_publication_cannot_be_repeated(self):
        with self.assertRaisesRegex(RuntimeError, 'ORIGINAL_RELEASE_ALREADY_ACCEPTED'):
            p.release({'mode':'release'}, self.c)

    def test_recovery_only_changes_admin_and_finishes_original_version_once(self):
        import tempfile,types,base64,hashlib
        from unittest.mock import patch
        root = HERE.parents[1] / '.runtime/proxy-failure-evidence-20261025/recovery-fixtures'
        root.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as tmp:
            base=Path(tmp);previous=base/'releases/previous';target=base/'releases/target';stage=base/'stage'
            for path in (previous,target,stage):path.mkdir(parents=True)
            (base/'current').symlink_to(previous)
            original=self.c['acceptedRecovery']['plan'];images={r:{'reference':r+'-candidate','imageId':r+'-new'} for r in p.UPDATED}
            before={r:{'image':r+'-old','reference':r+'-old'} for r in (*p.UPDATED,*p.PRESERVED)}
            states=copy.deepcopy(before)
            for role in ('api','online-recharge'):states[role]={'image':images[role]['imageId'],'reference':images[role]['reference']}
            observed={'status':'ONLINE_PROXY_ACCEPTED_SWITCH_OBSERVED','allConfigurationMatched':True,'services':copy.deepcopy(states)}
            old={'services':before,'manifestSha256':p.sha(b'{"images":{}}'),'expectedCurrent':p.CURRENT,'sources':{},'engineRoot':self.c['engineRoot']}
            for path in (previous,target):(path/'release-manifest.json').write_bytes(b'{"images":{}}')
            journal={'status':'SWITCH_FAILED','target':str(target),'previous':str(previous),'businessActions':0}
            (stage/'switch-state.json').write_text(json.dumps(journal))
            backup_dir=base/'backups'/('recharge-record-'+original['commit']+'-'+original['workflowRunId']);backup_dir.mkdir(parents=True)
            raw=b'synthetic backup';backup_path=backup_dir/'fixture.sql.gz';backup_path.write_bytes(raw)
            backup={'path':str(backup_path),'size':len(raw),'sha256':p.sha(raw),'s3Bucket':'fixture','s3Key':'fixture'}
            (backup_dir/'backup-operation.json').write_text('{"status":"VERIFIED"}')
            (backup_dir/'backup-verification.json').write_text(json.dumps(backup))
            calls=[]
            def compose(directory,*args,**kwargs):
                self.assertEqual(directory,target);self.assertEqual(args,('up','-d','--no-deps','admin'))
                calls.append('admin');states['admin']={'image':images['admin']['imageId'],'reference':images['admin']['reference']}
            def point(directory,stamp):
                self.assertEqual(directory,target);(base/'current').unlink();(base/'current').symlink_to(target)
            d=types.SimpleNamespace(compose=compose,wait_healthy=lambda directory,role: self.assertEqual(role,'admin'),assert_no_active_recharge=lambda _:None,
                environment_values=lambda _:{},point_current=point,run=lambda *a,**kw:json.dumps({'ContentLength':len(raw),'ChecksumSHA256':base64.b64encode(hashlib.sha256(raw).digest()).decode(),'ServerSideEncryption':'AES256'}))
            h=types.SimpleNamespace(snapshot=lambda *_:copy.deepcopy(states),engine_idle=lambda *a,**kw:None,guards=lambda *a:None)
            def smoke(*a):
                for role in p.UPDATED:self.assertEqual(states[role]['image'],images[role]['imageId'])
            def load(name):
                if name=='online-unpaid-validation-release.py':return types.SimpleNamespace(configuration_equivalence=lambda *a:{'matched':True})
                if name=='online-query-network-release.py':return types.SimpleNamespace(SCOPE='fixture')
                if name=='proxy-result-identity-release.py':return types.SimpleNamespace(verify_markers=lambda _:calls.append('verify_marker'),release_markers=lambda _:calls.append('release_marker'))
                if name=='recharge-availability-release.py':return types.SimpleNamespace(acquire_release_lock=lambda _:None)
                raise AssertionError(name)
            core=types.SimpleNamespace(load=load,smoke=smoke)
            def material(_):return original,old,stage,json.loads((stage/'switch-state.json').read_text()),target,previous,b'{}',{},h,d,core,images
            with patch.object(p,'BASE',base),patch.object(p,'load',load),patch.object(p,'recovery_material',material):
                changed={**observed,'services':{**observed['services'],'api':{'image':'unexpected'}}}
                with self.assertRaisesRegex(RuntimeError,'OBSERVED_SERVICES_CHANGED'):
                    p.recovery_complete({'mode':'recovery_complete','commit':'c'*40,'acceptedObservation':changed},self.c)
                self.assertEqual(calls,[])
                result=p.recovery_complete({'mode':'recovery_complete','commit':'c'*40,'acceptedObservation':observed},self.c)
                self.assertEqual(result['status'],'ONLINE_PROXY_FORWARD_COMPLETED');self.assertFalse(result['apiExecutorRecreated'])
                self.assertEqual(calls.count('admin'),1)
                self.assertEqual((base/'current').resolve(),target)
                readback=p.recovery_complete({'mode':'recovery_readback','commit':'c'*40,'acceptedObservation':result['observation']},self.c)
                self.assertEqual(readback['status'],'ONLINE_PROXY_COMPLETION_READBACK_VERIFIED')
                with self.assertRaises(RuntimeError):p.recovery_complete({'mode':'recovery_complete','commit':'c'*40,'acceptedObservation':result['observation']},self.c)
                self.assertEqual(calls.count('admin'),1)

    def test_recovery_is_bound_to_original_operation_and_never_rebuilds(self):
        source=(HERE/'online-proxy-failure-evidence-release.py').read_text()
        self.assertIn("original['workflowRunId'] == '40178946393'",source)
        self.assertIn("not (stage/'forward-finalization.json').exists()",source)
        recovery=source.split('def recovery_complete(',1)[1]
        self.assertNotIn('build_image',recovery);self.assertNotIn('fresh_scoped_backup',recovery)
        self.assertEqual(recovery.count('d.compose('),1)
        self.assertIn("d.compose(target,'up','-d','--no-deps','admin'",recovery)


if __name__ == '__main__': unittest.main()
