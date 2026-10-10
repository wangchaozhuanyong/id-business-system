"""Synthetic controller/acquisition tests plus real private file races.
No Docker/AWS/netlink/generator admission or production proof is exercised.
"""
import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import stat
import tempfile
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
m=load('root_driver',HERE/'driver.py')
ROOT=HERE.parents[2]
S=runpy.run_path(str(ROOT/'scripts/production-release/online-recharge-scope.py'))
W=runpy.run_path(str(ROOT/'scripts/production-release/api-admin-scope.py'),init_globals={'SCOPE':'API_ADMIN_WORKSPACE'})
ctor=load('package_constructor',HERE/'constructor.py');ctor._configure(SimpleNamespace(**S),json.loads((HERE/'contract.json').read_bytes()))
C=ctor.__dict__
F=C['F'];digest=C['digest'];bd=C['byte_digest']
def h(value):
    return digest({'SYNTHETIC_ONLY':value})


def fixture(nonce='1'*32):
    policy=json.loads((ROOT/'scripts/production-release/online-recharge-recovery.json').read_text())
    actual=copy.deepcopy(policy['preflight']['services'])
    for name in ('api','admin'):
        for key in ('containerId','startedAtSha256','configurationSha256'):
            actual[name][key]=h(name+'.'+key)
    helpers={name:h(name) for name in S['DECLARATION_EQUIVALENCE_HELPERS']}
    root={'producer':{'commit':'a'*40,'sourceTree':'b'*40,'workflowRunId':'123','workflowRunAttempt':'1',
                     'archiveInventorySha256':h('archive inventory'),'helpers':helpers},
          'recoveryPolicy':policy,'historicalFiles':{k:('SYNTHETIC-'+k).encode() for k in F['historicalFiles']},
          'anchors':{k:{'oldBeforeContainerId':h(k+' old'),'candidateAfterContainerId':h(k+' candidate')}
                     for k in ('api','admin')},'actual':actual,
          'adminProjection':{'kind':'ADMIN_OLD_COMPLETE_CONFIGURATION_MATCH',
                     'originalConfigurationSha256':policy['preflight']['services']['admin']['configurationSha256'],
                     'projectedConfigurationSha256':policy['preflight']['services']['admin']['configurationSha256'],
                     'actualConfigurationSha256':actual['admin']['configurationSha256'],
                     'helperSha256':helpers[S['DECLARATION_EQUIVALENCE_HELPERS'][2]]},
          'configurationFiles':{'SYNTHETIC_FILE':h('config file')},'workspaceFiles':{'SYNTHETIC_FILE':h('workspace file')},
          'environmentFileSha256':h('source env bytes'),
          'stableObservation':{'snapshotSha256':digest(actual),'sourceFilesSha256':h('sourcefiles'),
                     'workspaceVolumeSha256':h('workspace volume'),'actualResourceSha256':h('actual resource')},
          'sourceArchiveBytesSha256':h('full archive bytes'),'generatorRulesSha256':h('fixture rules only')}
    state={'status':'created','running':False,'pid':0,'startedAtSha256':bd(b'0001-01-01T00:00:00Z'),'restartCount':0}
    project='online-recharge-reference-'+nonce
    def record(tag):
        return {'owner':nonce,'createdAtSha256':h(nonce+tag+'created'),
                'creationMetadataSha256':h(nonce+tag+'metadata'),'preCleanupMetadataSha256':h(nonce+tag+'metadata')}
    registry={'container':{**record('container'),'id':h(nonce+'cid'),'name':'/'+project+'-api-1',
                           'stateAtCreate':copy.deepcopy(state),'stateBeforeCleanup':copy.deepcopy(state)},
              'networks':{role:{**record(role),'id':h(nonce+role+'netid'),'name':project+'_'+role} for role in C['ROLES']},
              'volume':{**record('volume'),'name':project+'_auto_registration_data'}}
    facts={'version':1,'formalTableSha256':C['FORMAL_TABLE_SHA'],'sourceFileSealsSha256':h('source seals'),
           'generator':{'engineVersion':'27.4.1','composeVersion':'2.39.4','rulesSha256':root['generatorRulesSha256']},
           'source':{'renderedDeclarationSha256':h('full D'),'normalizedModelSha256':h('stable normalized D'),
                     'apiDeclaredHash':h('native api hash'),
                     'expectedEnvironmentSha256':actual['api']['environmentSha256'],
                     'referenceEnvironmentSha256':h('all surrogate union')},
           'referenceRegistry':registry,
           'referenceInputs':{'modelCanonicalSha256':h(nonce+'reference model'),
                     'surrogateEnvironmentSha256':h('all surrogate union'),
                     'emptyEnvironmentBytesSha256':bd(b''),'emptyDockerConfigBytesSha256':bd(b'{}\n'),
                     'beforeFileSealsSha256':h(nonce+'private files'),'afterFileSealsSha256':h(nonce+'private files')},
           'stableBefore':copy.deepcopy(root['stableObservation']),'stableAfter':copy.deepcopy(root['stableObservation'])}
    measured={'matched':True,'reason':'COMPLETE_EQUAL','status':'CONTROL_ONLY_DECLARATION_MEASURED',
              'actualRawConfigurationSha256':actual['api']['configurationSha256'],
              'referenceRawConfigurationSha256':h(nonce+'raw R'),
              'actualDeclarationNormalizedSha256':h('complete normalized'),'referenceDeclarationNormalizedSha256':h('complete normalized'),
              'historicalRawHashMatchClaimed':False,'authority':False,'productionEligible':False,
              'actualResourceSha256':root['stableObservation']['actualResourceSha256'],
              'sourceFileSealsSha256':facts['sourceFileSealsSha256'],
              'referenceResourceSha256':digest(C['adapter42_registered'](registry)),
              'sourceUnchangedBeforeAndAfter':True,'referenceNeverStarted':True,
              'referenceModelSha256':facts['referenceInputs']['modelCanonicalSha256'],
              'cleanup':{'ownedContainersRemaining':0,'ownedNetworksRemaining':0,'ownedVolumesRemaining':0,
                         'exactOwnerCreationSealsVerified':True,'existingResourcesMutated':False}}
    return measured,facts,root

DERIVE=load('package_pure',HERE/'pure.py')
SENTINEL='LOCAL_PRIVATE_ENV_NO_OUTPUT'
SOURCE_FILES=('docker-compose.aws-mysql.yml','compose.release.json','.env.aws.production')
CONFIG_FILES=('docker-compose.aws-mysql.yml','deploy/caddy/Caddyfile.aws','apps/api/prisma-mysql/schema.prisma','compose.release.json')
WORKSPACE_FILES=('release-manifest.json','api-workspace-build-proof.json','api-workspace-preservation.json','backup-verification.json','before-audit.json','after-audit.json')

class Controller:
    def __init__(self,case):
        self.case=case;self.BASE=case.base;self.calls=[]
        self._apiWorkspaceDeclarationProducer=copy.deepcopy(case.p)
        self._apiWorkspaceDeclarationEntry='PREFLIGHT';self.sys=SimpleNamespace(argv=['remote','--api-workspace-preflight'])
    def require(self,ok,code):
        if not ok:raise RuntimeError(code)
    def run(self,*args,**kwargs):
        self.calls.append((args,kwargs))
        c=self.case
        if args==('docker','inspect',c.services['api']['containerId']):return json.dumps([c.api])
        if args==('docker','inspect',c.services['admin']['containerId']):return json.dumps([c.admin])
        if args[:3]==('docker','network','inspect'):
            return json.dumps([next(n for n in c.networks.values() if n['Id']==args[3])])
        if args==('docker','volume','inspect',c.volume['Name']):return json.dumps([c.volume])
        raise AssertionError('UNAPPROVED_SYNTHETIC_COMMAND')

class DriverTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='sandbox-',dir=HERE);self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.directory=self.base/'releases'/('20261010T010203Z-'+m.BASELINE[:12]);self.directory.mkdir(parents=True,mode=0o700)
        (self.base/'current').symlink_to(self.directory)
        self.measured,self.facts,self.root=fixture()
        self.p={k:self.root['producer'][k] for k in m.PRODUCER_KEYS}
        self.services=copy.deepcopy(self.root['actual']);self.policy=copy.deepcopy(self.root['recoveryPolicy'])
        self.project='local-reference-fixture'
        self.volume={'Name':self.project+'_auto_registration_data','Driver':'local','Scope':'local','Mountpoint':'/LOCAL_FIXTURE_ONLY','Labels':{},'CreatedAt':'LOCAL_ONLY','Options':None}
        self.volume_summary={'name':self.volume['Name'],'status':'PRESENT','identitySha256':m.digest(self.volume)}
        self.networks={r:{'Id':h(r),'Name':self.project+'_'+r,'Labels':{},'LOCAL_SYNTHETIC_ONLY':True} for r in C['ROLES']}
        self.api={'Id':self.services['api']['containerId'],'Name':'/'+self.project+'-api-1',
                  'Image':self.services['api']['image'],'Config':{'Labels':{'com.docker.compose.project':self.project},'Env':['LOCAL_FIXTURE='+SENTINEL]},
                  'NetworkSettings':{'Networks':{self.project+'_'+r:{'NetworkID':n['Id']} for r,n in self.networks.items()}}}
        self.admin={'Id':self.services['admin']['containerId'],'LOCAL_SYNTHETIC_ONLY':True}
        for name in dict.fromkeys((*SOURCE_FILES,*CONFIG_FILES,*WORKSPACE_FILES)):
            path=self.directory/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(('LOCAL '+name+(SENTINEL if name==SOURCE_FILES[2] else '')).encode());path.chmod(0o600)
        self.configuration=self.file_hashes(CONFIG_FILES);self.workspace_files=self.file_hashes(WORKSPACE_FILES)
        docs={name:{'LOCAL_SYNTHETIC_ONLY':name} for name in S['DECLARATION_EQUIVALENCE_FIELDS']['historicalFiles']}
        docs['workspaceRecordBytesSha256']={'workspaceVolumeAfter':copy.deepcopy(self.volume_summary),'before':{n:{'containerId':self.root['anchors'][n]['oldBeforeContainerId']} for n in ('api','admin')}}
        docs['restoredRecordBytesSha256']={'after':{n:{'containerId':self.root['anchors'][n]['candidateAfterContainerId']} for n in ('api','admin')}}
        docs['recoveryPolicy']=self.policy;docs['firstFailure']={'LOCAL_ONLY':'FIRST'};docs['secondFailure']={'LOCAL_ONLY':'SECOND'}
        self.materials={'producer':copy.deepcopy(self.root['producer']),'archive_bytes':b'LOCAL_SYNTHETIC_ARCHIVE_NOT_GIT',
                        'historical_files':{n:m.canonical(d) for n,d in docs.items()}}
        self.recovery={'policy':self.policy,'source':self.base/'LOCAL_FIRST','marker':S['recovery_marker'](self.policy),
                       'restored':{'source':self.base/'LOCAL_SECOND','configurationAnchors':copy.deepcopy(self.root['anchors']),
                                   'configurationBefore':self.configuration,'workspaceOriginFiles':self.workspace_files,
                                   'environmentSha256':self.file_hashes(SOURCE_FILES)[SOURCE_FILES[2]]}}
        self.controller=Controller(self);self.online=SimpleNamespace(**S);self.workspace=SimpleNamespace(**W)
        self.reader=SimpleNamespace(CONFIG_FILES=CONFIG_FILES,SOURCE_FILES=SOURCE_FILES,WORKSPACE_FILES=WORKSPACE_FILES,
             INVENTORY=SimpleNamespace(NETWORK_ROLES=C['ROLES'],SERVICES=S['DECLARATION_EQUIVALENCE_SERVICES']),WORKSPACE={'WORKSPACE_VOLUME':'auto_registration_data'},
             NAME=__import__('re').compile('[a-z0-9][a-z0-9_-]{0,63}'),DERIVE=DERIVE,decode=json.loads)
        self.reader.files=lambda d,names,uid:{n:{'sha256':self.file_hashes((n,))[n]} for n in names}
        self.reader.volume_summary=lambda volume:copy.deepcopy(self.volume_summary)
        self.reader.make_reader=self.make_reader
        self.online.snapshot=lambda d,directory:copy.deepcopy(self.services)
        self.online.release_recovery=lambda d,directory:copy.deepcopy(self.recovery)
        self.online.configuration_hashes=lambda directory:self.file_hashes(CONFIG_FILES)
        self.online.workspace_files=lambda d,directory:self.file_hashes(WORKSPACE_FILES)
        self.online.legacy=lambda d:SimpleNamespace(workspace_volume=lambda *a,**k:copy.deepcopy(self.volume_summary))
        self.material_calls=0;self.source_calls=0;self.measure_calls=0;self.assert_calls=0;self.exit_calls=0
        self.action=None;self.exit_action=None;self.bound_history=None
        def materials(d,directory,recovery,*,producer,phase):
            self.assertEqual(phase,'LIVE');self.assertEqual(producer,self.p);self.material_calls+=1
            return copy.deepcopy(self.materials)
        self.online.declaration_equivalence_materials=materials
        self.online.restored_configuration_projection=lambda d,n,meta,actual,old,anchors:{'rawSha256':actual['configurationSha256'],'projectedSha256':old['configurationSha256']}
        self.online.declaration_equivalence_source_binding=self.source_binding
        self.saved_f=None
        def saved(d,*,producer,expected_sha):
            self.assertEqual(producer,self.p)
            d.require(type(self.saved_f) is bytes and m.byte_sha(self.saved_f)==expected_sha,'BAD_SYNTHETIC_F')
            return self.saved_f
        self.online.declaration_equivalence_preflight_bytes=saved
        self.session=SimpleNamespace(runner=self.controller,reviewed_rules=lambda:{'spec':{'LOCAL_SYNTHETIC_RULE':1},
           'rulesSha256':m.digest({'LOCAL_SYNTHETIC_RULE':1}),'sourceInputsSha256':h('sourceinputs'),'sourceReviewReportSha256':h('source review')},
           assert_stable=self.assert_stable,measure=self.measure)
        @contextmanager
        def context(d):
            self.assertIsInstance(d,m._ArchiveBoundController);self.assertIs(d._raw,self.controller)
            try:yield self.session
            finally:
                self.exit_calls+=1
                if self.exit_action:self.exit_action()
        self.qual=SimpleNamespace(acquisition_session=context)
        self.caps=SimpleNamespace(online=self.online,workspace=self.workspace,reader=self.reader,constructor=SimpleNamespace(**C),qualified=self.qual)
        self.cap_patch=patch.object(m,'_capabilities',return_value=self.caps);self.cap_patch.start();self.addCleanup(self.cap_patch.stop)
        self.uid_patch=patch.object(m,'_uid',return_value=os.getuid());self.uid_patch.start();self.addCleanup(self.uid_patch.stop)
        self.euid_patch=patch.object(m.os,'geteuid',return_value=0);self.euid_patch.start();self.addCleanup(self.euid_patch.stop)
        # Test-only base traversal starts at the private sandbox. Production
        # opens every real absolute parent with root/no-follow checks.
        self.base_patch=patch.object(m,'_base_fd',side_effect=self.base_fd);self.base_patch.start();self.addCleanup(self.base_patch.stop)

    def base_fd(self,base):
        self.assertEqual(Path(base),self.base)
        return os.open(base,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    def file_hashes(self,names):return {n:hashlib.sha256((self.directory/n).read_bytes()).hexdigest() for n in names}
    def raw(self):
        return {'snapshot':copy.deepcopy(self.services),'sourceFiles':{'configurationFiles':self.file_hashes(SOURCE_FILES),
                  'workspaceFiles':self.file_hashes(WORKSPACE_FILES)},'workspaceVolume':copy.deepcopy(self.volume),
                  'actualResource':{'networks':copy.deepcopy(self.networks),'volume':copy.deepcopy(self.volume)}}
    def make_reader(self,d,directory,**kwargs):
        self.assertIsInstance(d,m._SourceReadDriver);self.assertIs(d._runner,self.session.runner);self.assertEqual(directory,self.directory)
        raw=self.raw();self.acquired_reader_kwargs=copy.deepcopy(kwargs)
        def callback():
            current=self.raw()
            if current!=raw:raise RuntimeError('SYNTHETIC_OBSERVATION_CHANGED')
            return current
        return callback
    def assert_stable(self):self.assert_calls+=1
    def source_binding(self,d,proof,**materials):
        S['validate_declaration_equivalence_proof'](d,proof)
        self.assertEqual(set(materials),{'producer','archive_bytes','historical_files'})
        self.assertEqual(proof['semantic']['producer'],materials['producer'])
        self.assertEqual(proof['measurement']['sourceArchiveBytesSha256'],m.byte_sha(materials['archive_bytes']))
        self.assertEqual(proof['semantic']['historicalFiles'],{n:m.byte_sha(materials['historical_files'][n]) for n in S['DECLARATION_EQUIVALENCE_FIELDS']['historicalFiles']})
        self.bound_history=copy.deepcopy(materials);self.source_calls+=1
    def measure(self,directory,**kwargs):
        self.measure_calls+=1
        if self.action:self.action()
        raw=kwargs['stability_reader']();obs=DERIVE.observation(raw,self.services,self.file_hashes(SOURCE_FILES),raw['actualResource'])
        self.measured['actualResourceSha256']=obs['actualResourceSha256']
        self.facts['stableBefore']=copy.deepcopy(obs);self.facts['stableAfter']=copy.deepcopy(obs)
        self.facts['generator']['rulesSha256']=self.session.reviewed_rules()['rulesSha256']
        self.facts['source']['expectedEnvironmentSha256']=self.services['api']['environmentSha256']
        return {'measured':copy.deepcopy(self.measured),'facts':copy.deepcopy(self.facts)}
    def run_driver(self,purpose='INDEPENDENT_PREFLIGHT',raw=None):
        return m.measure_declaration_equivalence(self.controller,self.directory,self.recovery,producer=self.p,purpose=purpose,preflight_raw=raw)
    def registry_path(self):return self.base/'.runtime/online-recharge-declaration-measurement/registries'/m.registry_filename(self.p)
    def first(self):
        proof=self.run_driver()
        self.saved_f=m.canonical({'mode':'preflight','status':'API_ADMIN_WORKSPACE_BASELINE_VERIFIED','commit':m.BASELINE,
          'services':self.services,'releaseCandidateCommit':self.p['commit'],'workflowRunId':self.p['workflowRunId'],
          'workflowRunAttempt':self.p['workflowRunAttempt'],'pendingOnlineMigrationOrigin':{'restoredConfigurationProof':proof},
          'LOCAL_SYNTHETIC_ONLY':True})
        self.controller._apiWorkspaceDeclarationEntry='STAGE';self.controller.sys.argv=['remote','--api-workspace-only']
        self.controller._apiWorkspaceDeclarationPreflightSha256=m.byte_sha(self.saved_f)
        self.measured,self.facts,_=fixture('2'*32)
        return proof
    def reject(self,fn=None,code=None):
        with self.assertRaises(m.Rejected) as raised:(fn or self.run_driver)()
        self.assertIn(str(raised.exception),m.CODES);self.assertNotIn(SENTINEL,str(raised.exception));self.assertTrue(raised.exception.__suppress_context__)
        if code:self.assertEqual(str(raised.exception),code)
    def test_actual_getter_live_acquisition_cleanup_then_private_p1(self):
        proof=self.run_driver();S['validate_declaration_equivalence_proof'](self.controller,proof)
        self.assertEqual(self.material_calls,2);self.assertEqual(self.source_calls,1);self.assertEqual(self.exit_calls,1)
        self.assertEqual(self.assert_calls,2);self.assertGreater(len(self.controller.calls),0)
        raw=self.registry_path().read_bytes();self.assertNotIn(SENTINEL.encode(),raw)
        self.assertEqual(stat.S_IMODE(self.registry_path().stat().st_mode),0o600)
        self.assertEqual(stat.S_IMODE(self.registry_path().parent.stat().st_mode),0o700)
        self.assertEqual(m.decode(raw)['p1Sha256'],m.digest(proof))
    def test_p1_f_p2_private_registry_complete_pair(self):
        one=self.first();before=self.registry_path().read_bytes();two=self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f)
        self.assertEqual(one['semantic'],two['semantic']);self.assertNotEqual(one['measurement']['executionNonce'],two['measurement']['executionNonce'])
        self.assertEqual(two['measurement']['priorProofSha256'],m.digest(one));self.assertEqual(self.registry_path().read_bytes(),before)
        S['declaration_equivalence_pair_seal'](self.controller,one,two,self.saved_f)
    def test_missing_registry_cannot_accept_f_as_ownership_proof(self):
        self.first();self.registry_path().unlink();self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_MISSING')
    def test_fake_registry_proof_hash_rejected_before_second_measurement(self):
        self.first();path=self.registry_path();v=m.decode(path.read_bytes());v['p1Sha256']='a'*64;path.write_bytes(m.canonical(v));old=self.measure_calls
        self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_CHANGED');self.assertEqual(old,self.measure_calls)
    def test_registry_producer_and_unknown_fields_rejected(self):
        self.first();path=self.registry_path();v=m.decode(path.read_bytes());v['producer']['sourceTree']='c'*40;path.write_bytes(m.canonical(v))
        self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_INVALID')
    def test_same_owner_and_resource_id_reuse_rejected(self):
        one=self.first();self.measured,self.facts,_=fixture('1'*32)
        self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_DRIVER_UNAVAILABLE')
    def test_second_measurement_one_network_id_reuse_rejected(self):
        self.first();prior=m.decode(self.registry_path().read_bytes())['referenceRegistry']
        role=C['ROLES'][0];self.facts['referenceRegistry']['networks'][role]['id']=prior['networks'][role]['id']
        self.measured['referenceResourceSha256']=m.digest(C['adapter42_registered'](self.facts['referenceRegistry']))
        self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f))
    def test_wrong_f_bytes_and_transport_sha_rejected(self):
        self.first();self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f+b' '),'ROOT_PREFLIGHT_CHANGED')
    def test_missing_transport_f_sha_rejected_before_measurement(self):
        self.first();del self.controller._apiWorkspaceDeclarationPreflightSha256
        self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_PREFLIGHT_CHANGED')
    def test_current_producer_not_caller_producer(self):
        self.controller._apiWorkspaceDeclarationProducer['workflowRunId']='999';self.reject(code='ROOT_PRODUCER_CHANGED');self.assertEqual(self.measure_calls,0)
    def test_producer_changes_during_measurement_rejected_without_registry(self):
        self.action=lambda:self.controller._apiWorkspaceDeclarationProducer.update({'sourceTree':'c'*40})
        self.reject(code='ROOT_PRODUCER_CHANGED');self.assertFalse(self.registry_path().exists())
    def test_wrong_purpose_vs_actual_entry_and_multiple_flags_rejected(self):
        self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',b'{}'),'ROOT_ENTRY_INVALID')
        self.controller.sys.argv.append('--api-workspace-only');self.reject()
    def test_materials_full_archived_producer_mismatch_rejected(self):
        self.materials['producer']['commit']='f'*40;self.reject(code='ROOT_PRODUCER_CHANGED')
    def test_history_anchor_mismatch_is_rejected(self):
        self.recovery['restored']['configurationAnchors']['api']['candidateAfterContainerId']='f'*64;self.reject(code='ROOT_HISTORY_CHANGED')
    def test_history_material_changed_on_final_live_read_rejected(self):
        self.action=lambda:self.materials.update({'archive_bytes':b'DRIFT'});self.reject(code='ROOT_HISTORY_CHANGED')
    def test_seven_services_original_old_five_must_match(self):
        self.services[S['PRESERVED'][0]]['containerId']='f'*64;self.reject(code='ROOT_OBSERVATION_CHANGED')
    def test_api_image_or_environment_drift_cannot_be_normalized(self):
        self.services['api']['environmentSha256']='f'*64;self.reject(code='ROOT_OBSERVATION_CHANGED')
    def test_source_file_mutation_detected_before_qualification_measure(self):
        (self.directory/CONFIG_FILES[0]).write_bytes(b'DRIFT');self.reject(code='ROOT_SOURCE_CHANGED');self.assertEqual(self.measure_calls,0)
    def test_source_file_mutation_during_measurement_rejected(self):
        self.action=lambda:(self.directory/SOURCE_FILES[2]).write_bytes(b'DRIFT '+SENTINEL.encode());self.reject();self.assertFalse(self.registry_path().exists())
    def test_complete_network_drift_detected_by_raw_callback(self):
        self.action=lambda:self.networks[C['ROLES'][0]].update({'NEW_UNKNOWN_FIELD':True});self.reject()
    def test_admin_complete_hash_must_match_without_bool_override(self):
        self.online.restored_configuration_projection=lambda *a,**k:{'rawSha256':'a'*64,'projectedSha256':'b'*64}
        self.reject(code='ROOT_ADMIN_PROJECTION_FAILED');self.assertEqual(self.measure_calls,0)
    def test_cleanup_failure_cannot_write_p1_registry(self):
        self.measured['cleanup']['ownedNetworksRemaining']=1;self.reject();self.assertFalse(self.registry_path().exists())
    def test_cleanup_exit_failure_cannot_write_p1_registry(self):
        self.exit_action=lambda:(_ for _ in ()).throw(RuntimeError(SENTINEL));self.reject();self.assertFalse(self.registry_path().exists())
    def test_second_p1_cannot_overwrite_private_record(self):
        self.run_driver();before=self.registry_path().read_bytes();self.reject(code='ROOT_REGISTRY_EXISTS');self.assertEqual(self.registry_path().read_bytes(),before)
    def test_private_file_wrong_permissions_hardlink_symlink_and_fifo_rejected(self):
        self.first();p=self.registry_path();saved=p.read_bytes()
        p.chmod(0o640);self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_INVALID');p.chmod(0o600)
        link=p.with_name('hardlink');os.link(p,link);self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_INVALID');link.unlink()
        p.unlink();target=p.with_name('private-target');target.write_bytes(saved);target.chmod(0o600);p.symlink_to(target)
        self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f));p.unlink();os.mkfifo(p,0o600)
        self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_INVALID')
    def test_private_parent_symlink_or_unsafe_permission_rejected(self):
        self.first();parent=self.registry_path().parent;parent.chmod(0o750)
        self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_INVALID');parent.chmod(0o700)
        renamed=parent.with_name('old-registry');parent.rename(renamed);parent.symlink_to(renamed,target_is_directory=True)
        self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_INVALID')
    def test_duplicate_json_unknown_keys_and_oversize_records_rejected(self):
        self.first();p=self.registry_path();saved=p.read_bytes()
        p.write_bytes(b'{"version":1,"version":1}');self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_INVALID')
        p.write_bytes(b'x'*(m.MAX_REGISTRY+1));self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_INVALID')
        v=m.decode(saved);v['callerTrusted']=True;p.write_bytes(m.canonical(v));self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_INVALID')
    def test_leaf_replaced_during_real_registry_read_rejected(self):
        self.first();p=self.registry_path();original=m.os.read;changed=[]
        def read(fd,size):
            raw=original(fd,size)
            if raw and not changed:
                changed.append(True);p.rename(p.with_name('old-private'));p.write_bytes(raw);p.chmod(0o600)
            return raw
        with patch.object(m.os,'read',side_effect=read):self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_CHANGED')
    def test_registry_parent_replaced_during_real_read_rejected(self):
        self.first();p=self.registry_path();original=m.os.read;changed=[]
        def read(fd,size):
            raw=original(fd,size)
            if raw and not changed:
                changed.append(True);parent=p.parent;parent.rename(parent.with_name('old-private-dir'));parent.mkdir(mode=0o700);p.write_bytes(raw);p.chmod(0o600)
            return raw
        with patch.object(m.os,'read',side_effect=read):self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_CHANGED')
    def test_registry_is_reread_after_p2_comparison(self):
        self.first()
        def mutate():
            p=self.registry_path();v=m.decode(p.read_bytes());v['p1Sha256']='f'*64;p.write_bytes(m.canonical(v))
        self.action=mutate;self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_CHANGED')
    def test_public_entry_has_no_path_record_profile_or_trusted_bool_arguments(self):
        import inspect
        self.assertEqual(tuple(inspect.signature(m.measure_declaration_equivalence).parameters),
                         ('d','directory','recovery','producer','purpose','preflight_raw'))
    def test_reviewed_source_still_requires_real_bound_archive(self):
        package=m._local_package();selected=package.load_leaf('qualified.py')
        self.assertEqual(len(selected.REVIEWED_SOURCE_TABLE),1);selected._reviewed_profile()
        self.cap_patch.stop()
        try:
            with patch.object(m,'_local_package',return_value=package),patch.object(package,'bind_consumers',
                    side_effect=RuntimeError('SYNTHETIC_ARCHIVE_UNAVAILABLE')) as archive:
                self.reject(code='ROOT_DRIVER_UNAVAILABLE');archive.assert_called_once_with(self.p)
        finally:self.cap_patch.start()
        self.assertEqual(self.controller.calls,[]);self.assertEqual(self.material_calls,0)


    def test_reference_source_model_and_env_facts_cannot_be_missing_or_forged(self):
        original=self.session.measure
        def wrong(*args,**kwargs):
            result=original(*args,**kwargs)
            result['facts']['source']['expectedEnvironmentSha256']='f'*64
            return result
        self.session.measure=wrong
        self.reject();self.assertFalse(self.registry_path().exists())

    def test_reference_fact_hash_must_bind_exact_measurement_registry(self):
        self.facts['referenceRegistry']['container']['creationMetadataSha256']='f'*64
        self.facts['referenceRegistry']['container']['preCleanupMetadataSha256']='f'*64
        self.reject();self.assertFalse(self.registry_path().exists())

    def test_second_measurement_container_id_cannot_be_reused_even_with_different_owner(self):
        self.first();prior=m.decode(self.registry_path().read_bytes())['referenceRegistry']
        self.facts['referenceRegistry']['container']['id']=prior['container']['id']
        self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f))

    def test_private_record_wrong_uid_is_rejected_without_reading_payload(self):
        self.first()
        with patch.object(m,'_uid',return_value=os.getuid()+1):
            self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_INVALID')

    def test_nonroot_public_entry_rejected_before_any_qualified_collection(self):
        with patch.object(m.os,'geteuid',return_value=os.getuid()+1):
            self.reject(code='ROOT_ENTRY_INVALID')
        self.assertEqual(self.measure_calls,0);self.assertEqual(self.controller.calls,[])

    def test_missing_public_qualification_session_cannot_fallback_to_ambient_runner(self):
        self.qual.acquisition_session=None
        self.reject(code='ROOT_ACQUISITION_UNAVAILABLE')
        self.assertEqual(self.controller.calls,[]);self.assertEqual(self.material_calls,0)

    def test_unreviewed_source_session_refuses_before_history_or_reference(self):
        @contextmanager
        def closed(d):
            raise RuntimeError('SOURCE_NOT_MEASURED')
            yield
        self.qual.acquisition_session=closed
        self.reject(code='ROOT_GENERATOR_SOURCE_UNMEASURED')
        self.assertEqual(self.controller.calls,[]);self.assertFalse(self.registry_path().exists())

    def test_source_binding_rejection_prevents_p1_registry(self):
        self.online.declaration_equivalence_source_binding=lambda *a,**k:(_ for _ in ()).throw(RuntimeError(SENTINEL))
        self.reject();self.assertFalse(self.registry_path().exists())

    def test_p2_uses_same_private_record_after_stability_context(self):
        self.first();before=self.registry_path().read_bytes()
        self.facts['stableBefore']['sourceFilesSha256']='f'*64
        # The mock measurement overwrites observation facts from the actual
        # callback. A caller-shaped stale observation cannot establish stability.
        two=self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f)
        self.assertEqual(two['measurement']['stableBefore'],two['semantic']['stableObservation'])
        self.assertEqual(self.registry_path().read_bytes(),before)

    def test_unknown_rule_fields_do_not_act_as_generator_admission(self):
        original=self.session.reviewed_rules
        self.session.reviewed_rules=lambda:{**original(),'trusted':True}
        self.reject();self.assertEqual(self.controller.calls,[])

    def test_complete_actual_volume_mutation_is_not_replaced_by_summary_only(self):
        self.action=lambda:self.volume.update({'NEW_UNKNOWN_FIELD':SENTINEL})
        self.reject();self.assertFalse(self.registry_path().exists())



    def test_registry_mutation_on_context_exit_is_rejected_by_final_private_read(self):
        self.first()
        def mutate():
            p=self.registry_path();v=m.decode(p.read_bytes());v['p1Sha256']='f'*64;p.write_bytes(m.canonical(v))
        self.exit_action=mutate
        self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',self.saved_f),'ROOT_REGISTRY_CHANGED')

    def test_transport_f_changes_on_context_exit_is_rejected_by_final_read(self):
        self.first();original=self.saved_f
        self.exit_action=lambda:setattr(self,'saved_f',original+b' ')
        self.reject(lambda:self.run_driver('DEPLOYMENT_REMEASURE',original))

    def test_missing_source_facts_rejected_even_when_result_claims_matched(self):
        original=self.session.measure
        def missing(*args,**kwargs):
            result=original(*args,**kwargs);result['facts']=None;return result
        self.session.measure=missing
        self.reject();self.assertFalse(self.registry_path().exists())



    def test_absolute_registry_parent_traversal_uses_real_nofollow_directories(self):
        self.base_patch.stop()
        host=self.base/'sandbox-host';host.mkdir(mode=0o700)
        project=host/'srv/project';project.mkdir(parents=True,mode=0o700)
        original=os.open
        def open_root(path,*args,**kwargs):
            if path=='/' and 'dir_fd' not in kwargs:return original(host,*args,**kwargs)
            return original(path,*args,**kwargs)
        try:
            with patch.object(m.os,'open',side_effect=open_root):
                fd=m._base_fd(Path('/srv/project'))
                try:self.assertEqual(os.fstat(fd).st_ino,project.stat().st_ino)
                finally:os.close(fd)
                project.chmod(0o777)
                with self.assertRaises(m.Rejected):m._base_fd(Path('/srv/project'))
                project.chmod(0o700);project.rename(project.with_name('original'));project.symlink_to('original',target_is_directory=True)
                with self.assertRaises(m.Rejected):m._base_fd(Path('/srv/project'))
        finally:self.base_patch.start()

    def test_registry_filename_derived_only_from_validated_producer(self):
        for mutate in (lambda p:p.update({'commit':'../outside'}),lambda p:p.update({'workflowRunId':'1/other'}),
                       lambda p:p.update({'workflowRunAttempt':True}),lambda p:p.update({'unknown':'caller-path'})):
            value=copy.deepcopy(self.p);mutate(value)
            with self.assertRaises(m.Rejected):m.registry_filename(value)
        self.assertEqual(m.registry_filename(self.p),self.p['commit']+'-123-1.json')

    def test_old_ipv6_facts_table_cannot_satisfy_explicit_ipv4_successor(self):
        self.facts['formalTableSha256']=m.PARENT_FORMAL_TABLE
        self.reject();self.assertFalse(self.registry_path().exists())

    def test_execution_nonce_and_reference_counts_are_derived_not_caller_claims(self):
        self.facts['referenceRegistry']['container']['owner']='3'*32
        self.reject();self.assertFalse(self.registry_path().exists())

    def test_open_flags_bound_record_budget_and_exact_write_do_not_persist_raw_env(self):
        original=os.open;flags=[]
        def observe(path,*args,**kwargs):
            if isinstance(path,str) and path.endswith('.json'):flags.append(args[0])
            return original(path,*args,**kwargs)
        with patch.object(m.os,'open',side_effect=observe):self.run_driver()
        self.assertTrue(any(value & os.O_EXCL for value in flags))
        self.assertTrue(all(value & os.O_NOFOLLOW and value & os.O_NONBLOCK for value in flags))
        self.assertNotIn(SENTINEL.encode(),self.registry_path().read_bytes())

    def test_p1_write_existing_fifo_or_symlink_never_follows_or_overwrites(self):
        self.run_driver();p=self.registry_path();p.unlink();os.mkfifo(p,0o600)
        self.reject(code='ROOT_REGISTRY_EXISTS');p.unlink();target=p.with_name('outside');target.write_bytes(b'UNCHANGED');p.symlink_to(target)
        self.reject(code='ROOT_REGISTRY_EXISTS');self.assertEqual(target.read_bytes(),b'UNCHANGED')

    def test_varying_registry_nonce_changes_m_without_changing_stable_source_seal(self):
        one=self.run_driver();seal=copy.deepcopy(self.acquired_reader_kwargs['source_seal'])
        self.registry_path().unlink();self.measured,self.facts,_=fixture('2'*32)
        two=self.run_driver()
        self.assertEqual(seal,self.acquired_reader_kwargs['source_seal']);self.assertEqual(one['semantic'],two['semantic'])
        self.assertNotEqual(one['measurement']['referenceRegistrySha256'],two['measurement']['referenceRegistrySha256'])



    def test_local_archive_cache_starts_empty_and_never_uses_external_cache(self):
        self.controller._declarationSourceArchiveCache={'MALICIOUS_EXTERNAL':SENTINEL}
        seen=[];original=self.online.declaration_equivalence_materials
        def materials(d,*args,**kwargs):
            seen.append(copy.deepcopy(d._declarationSourceArchiveCache))
            self.assertNotIn('MALICIOUS_EXTERNAL',d._declarationSourceArchiveCache)
            value=original(d,*args,**kwargs)
            d._declarationSourceArchiveCache={(self.p['commit'],self.p['sourceTree']):value['archive_bytes']}
            return value
        self.online.declaration_equivalence_materials=materials
        self.run_driver()
        self.assertEqual(seen[0],{})
        self.assertEqual(seen[1],{(self.p['commit'],self.p['sourceTree']):self.materials['archive_bytes']})
        self.assertEqual(self.controller._declarationSourceArchiveCache,{'MALICIOUS_EXTERNAL':SENTINEL})

    def test_source_wrapper_does_not_forward_unknown_private_or_admission_flags(self):
        wrapper=m._SourceReadDriver(self.controller)
        for name in ('_onlineRechargeVerifiedOrigin','_apiWorkspaceDeclarationProducer','trusted','sourceProfile','callerPath'):
            setattr(self.controller,name,SENTINEL)
            with self.assertRaisesRegex(m.Rejected,'^ROOT_ACQUISITION_UNAVAILABLE$'):getattr(wrapper,name)
        self.assertEqual(wrapper._declarationSourceArchiveCache,{})
        self.assertIs(wrapper.run.__self__,self.controller)

    def test_no_repeated_database_backup_or_history_controller_operations(self):
        self.online.release_recovery=lambda *a,**k:(_ for _ in ()).throw(AssertionError('ORIGINAL_OUTER_GATE_MUST_NOT_REPEAT'))
        self.run_driver()
        self.assertTrue(all(args[:2] in (('docker','inspect'),('docker','network'),('docker','volume')) for args,kwargs in self.controller.calls))
        self.assertEqual(self.material_calls,2)

    def test_actual_history_receipt_bytes_cannot_be_replaced_by_hash_claims(self):
        # The source validator receives all nine actual byte objects, not a
        # caller's history digest map or an already-verified boolean.
        self.run_driver()
        self.assertEqual(set(self.bound_history['historical_files']),set(S['DECLARATION_EQUIVALENCE_FIELDS']['historicalFiles'])|{'firstFailure','secondFailure','recoveryPolicy'})
        self.assertTrue(all(type(raw) is bytes for raw in self.bound_history['historical_files'].values()))
        self.assertEqual(self.bound_history['archive_bytes'],self.materials['archive_bytes'])

    def test_history_marker_mismatch_rejects_even_when_caller_adds_trusted_true(self):
        self.recovery['trusted']=True;self.recovery['marker']={'CALLER_FAKE':True}
        self.reject(code='ROOT_HISTORY_CHANGED');self.assertEqual(self.material_calls,0)


    def diagnostic_failure(self,stage,code,primary=None):
        with self.assertRaises(m.Rejected) as caught:self.run_driver()
        error=caught.exception
        self.assertEqual(m.failure_diagnostic(error),{'stage':stage,'code':code})
        if primary:self.assertEqual(error.args,(primary,))
        self.assertFalse(self.registry_path().exists())
        self.assertTrue(error.__suppress_context__)
        self.assertNotIn(SENTINEL,json.dumps(m.failure_diagnostic(error)))
        return error

    def test_diagnostic_entry_remains_nonroot_rejection(self):
        with patch.object(m.os,'geteuid',return_value=os.getuid()+1):
            self.diagnostic_failure('ENTRY','ROOT_ENTRY_INVALID','ROOT_ENTRY_INVALID')
        self.assertEqual(self.material_calls,0);self.assertEqual(self.measure_calls,0)

    def test_diagnostic_acquisition_uses_exact_captured_qualifier_class(self):
        package=m._local_package();qualified=package.load_leaf('qualified.py')
        self.caps._diagnostic_errors=[(qualified.Rejected,qualified.CODES)]
        @contextmanager
        def closed(d):
            raise qualified.Rejected('VFS_BOUND_CAPABILITY_REQUIRED')
            yield
        self.qual.acquisition_session=closed
        self.diagnostic_failure('ACQUISITION','VFS_BOUND_CAPABILITY_REQUIRED','ROOT_DRIVER_UNAVAILABLE')
        self.assertEqual(self.material_calls,0);self.assertEqual(self.measure_calls,0)

    def test_diagnostic_qualified_initialization_retains_original_rejection(self):
        package=m._local_package();qualified=package.load_leaf('qualified.py')
        self.caps.qualified=qualified
        with patch.object(qualified,'_reviewed_profile',side_effect=RuntimeError(SENTINEL)), \
             patch.object(qualified,'_load_base',side_effect=AssertionError('FACTORY_MUST_NOT_RUN')):
            self.diagnostic_failure('QUALIFIER_PROFILE','RUNTIME_ERROR','ROOT_DRIVER_UNAVAILABLE')
        self.assertEqual(self.material_calls,0);self.assertEqual(self.measure_calls,0)
        self.assertEqual(self.exit_calls,0)

    def test_diagnostic_rules_and_original_closed_fields_still_reject(self):
        self.session.reviewed_rules=lambda:{'spec':{'LOCAL_ONLY':True}}
        self.diagnostic_failure('RULES','ROOT_SOURCE_CHANGED','ROOT_SOURCE_CHANGED')
        self.assertEqual(self.material_calls,0);self.assertEqual(self.exit_calls,1)

    def test_diagnostic_acquire_preserves_source_checks(self):
        self.controller._apiWorkspaceDeclarationProducer['sourceTree']='c'*40
        self.diagnostic_failure('ENTRY','ROOT_PRODUCER_CHANGED','ROOT_PRODUCER_CHANGED')
        self.assertEqual(self.material_calls,0)
        self.controller._apiWorkspaceDeclarationProducer=self.p.copy()
        self.online.snapshot=lambda *a: (_ for _ in ()).throw(m.Rejected('ROOT_OBSERVATION_CHANGED'))
        self.diagnostic_failure('ACQUIRE','ROOT_OBSERVATION_CHANGED','ROOT_OBSERVATION_CHANGED')
        self.assertEqual(self.measure_calls,0);self.assertEqual(self.exit_calls,1)

    def test_diagnostic_measure_survives_actual_qualified_exception_wrapper(self):
        package=m._local_package();qualified=package.load_leaf('qualified.py')
        inventory=load('diagnostic_inventory',HERE.parent/'online-recharge-declaration-measurement.py')
        collector=package.load_leaf('collector.py');collector._configure(inventory,DERIVE,package.contract)
        original=collector.Rejected('ACTUAL_NETWORK_INSPECT_CHANGED');delivered=[]
        self.caps._diagnostic_errors=[(qualified.Rejected,qualified.CODES),(collector.Rejected,collector.ERROR_CODES)]
        @contextmanager
        def inner(d,session):
            try:yield self.session
            except Exception as error:delivered.append(error);raise
            finally:self.exit_calls+=1
        patches=[patch.object(qualified,'_reviewed_profile',return_value={'LOCAL_MOCK_ONLY':True}),
                 patch.object(qualified,'_load_base',return_value=object()),
                 patch.object(qualified,'_Session',return_value=SimpleNamespace()),
                 patch.object(qualified,'_load_socket',return_value=object()),
                 patch.object(qualified,'_acquisition_context',inner)]
        for item in patches:item.start();self.addCleanup(item.stop)
        self.qual.acquisition_session=qualified.acquisition_session
        self.action=lambda:(_ for _ in ()).throw(original)
        self.diagnostic_failure('MEASURE','ACTUAL_NETWORK_INSPECT_CHANGED','ROOT_DRIVER_UNAVAILABLE')
        self.assertEqual(delivered,[original]);self.assertEqual(self.measure_calls,1)
        self.assertEqual(self.exit_calls,1);self.assertEqual(self.source_calls,0)

    def test_diagnostic_after_preserves_observation_rejection(self):
        self.action=lambda:self.services['mysql'].update(containerId='e'*64)
        self.diagnostic_failure('MEASURE','UNKNOWN','ROOT_DRIVER_UNAVAILABLE')
        self.assertEqual(self.measure_calls,1);self.assertEqual(self.exit_calls,1)

    def test_diagnostic_after_fixed_error_is_bounded(self):
        original=self.measure
        def measured(*a,**k):
            result=original(*a,**k)
            self.online.declaration_equivalence_materials=lambda *a,**k:(_ for _ in ()).throw(m.Rejected('ROOT_HISTORY_CHANGED'))
            return result
        self.session.measure=measured
        self.diagnostic_failure('AFTER','ROOT_HISTORY_CHANGED','ROOT_HISTORY_CHANGED')
        self.assertEqual(self.measure_calls,1);self.assertEqual(self.source_calls,0)

    def test_diagnostic_construct_keeps_unknown_literal_private(self):
        self.caps.constructor.construct_preview=lambda *a,**k:(_ for _ in ()).throw(ValueError(SENTINEL))
        self.diagnostic_failure('CONSTRUCT','UNKNOWN','ROOT_DRIVER_UNAVAILABLE')
        self.assertEqual(self.measure_calls,1);self.assertEqual(self.exit_calls,1)

    def test_diagnostic_close_never_persists_registry(self):
        package=m._local_package();qualified=package.load_leaf('qualified.py')
        self.caps._diagnostic_errors=[(qualified.Rejected,qualified.CODES)]
        self.exit_action=lambda:(_ for _ in ()).throw(qualified.Rejected('CLIENT_SOURCE_CHANGED'))
        self.diagnostic_failure('CLOSE','CLIENT_SOURCE_CHANGED','ROOT_DRIVER_UNAVAILABLE')
        self.assertEqual(self.source_calls,1);self.assertEqual(self.exit_calls,1)

    def test_diagnostic_registry_only_after_successful_cleanup(self):
        def denied(*a,**k):
            self.assertEqual(self.exit_calls,1)
            raise m.Rejected('ROOT_REGISTRY_INVALID')
        with patch.object(m,'_save_registry',side_effect=denied):
            self.diagnostic_failure('REGISTRY','ROOT_REGISTRY_INVALID','ROOT_REGISTRY_INVALID')
        self.assertEqual(self.source_calls,1)

    def test_diagnostic_legacy_plain_source_status_remains_non_authorizing(self):
        @contextmanager
        def closed(d):raise RuntimeError('SOURCE_NOT_MEASURED');yield
        self.qual.acquisition_session=closed
        self.diagnostic_failure('ACQUISITION','UNKNOWN','ROOT_GENERATOR_SOURCE_UNMEASURED')
        self.assertEqual(self.material_calls,0)


class DeclarationFailureProjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.package=m._local_package();cls.qualified=cls.package.load_leaf('qualified.py')
        cls.inventory=load('diagnostic_inventory_projection',HERE.parent/'online-recharge-declaration-measurement.py')
        cls.collector=cls.package.load_leaf('collector.py');cls.collector._configure(cls.inventory,DERIVE,cls.package.contract)
        cls.loader=m._load(HERE/'package_io.py',cls.package.manifest['files']['package_io.py'])
        cls.online=SimpleNamespace(**S)

    def test_closed_enums_equal_captured_existing_fixed_codes(self):
        expected=m.CODES|self.loader.CODES|self.qualified.DIAGNOSTIC_CODES|self.collector.ERROR_CODES|frozenset(m._SOURCE_FILE_PERMISSION_CODES.values())|m._FACTS_READER_CODES|m._FACTS_PURE_CODES|{'UNKNOWN','HTTP_ERROR','URL_ERROR','TIMEOUT'}
        self.assertEqual(m.DIAGNOSTIC_CODES,expected)
        self.assertEqual(S['DECLARATION_DIAGNOSTIC_CODES'],expected)
        self.assertEqual(S['DECLARATION_DIAGNOSTIC_STAGES'],m.DIAGNOSTIC_STAGES)

    def facts_capabilities(self):
        package=m._local_package()
        external=SimpleNamespace(online=self.online,workspace=SimpleNamespace(**W),
            inventory=self.inventory,paths={'api-admin-scope.py':HERE.parent/'api-admin-scope.py'},
            identity=SimpleNamespace(),leaf_pins=package.manifest['externalLeafPins'])
        with patch.object(m,'_local_package',return_value=package), \
             patch.object(package,'bind_consumers',return_value=external):
            return m._capabilities({'commit':'a'*40,'sourceTree':'b'*40,'workflowRunId':'1','workflowRunAttempt':'1'})

    def test_loaded_facts_exact_classes_capture_all_fourteen_fixed_literals(self):
        caps=self.facts_capabilities();reader=caps.reader;pure=reader.DERIVE
        bindings=caps._diagnostic_errors
        self.assertIn((reader.ReaderRejected,m._FACTS_READER_CODES),bindings)
        self.assertIn((pure.FactsRejected,m._FACTS_PURE_CODES),bindings)
        import ast
        def literals(name):
            return frozenset(node.value for node in ast.walk(ast.parse((HERE/name).read_bytes()))
                if isinstance(node,ast.Constant) and type(node.value) is str and node.value.startswith('FACTS_'))
        self.assertEqual(m._FACTS_READER_CODES,literals('reader.py'))
        self.assertEqual(m._FACTS_PURE_CODES,literals('pure.py'))
        self.assertEqual(len(m._FACTS_READER_CODES|m._FACTS_PURE_CODES),14)
        for cls,codes in ((reader.ReaderRejected,m._FACTS_READER_CODES),(pure.FactsRejected,m._FACTS_PURE_CODES)):
            for code in codes:
                with self.subTest(code=code):
                    self.assertEqual(m._reason(cls(code),'ACQUIRE',bindings),{'stage':'ACQUIRE','code':code})

    def test_loaded_facts_fake_subclass_args_and_undeclared_literals_stay_unknown(self):
        caps=self.facts_capabilities();bindings=caps._diagnostic_errors
        class Text(str):pass
        for cls,codes,other in ((caps.reader.ReaderRejected,m._FACTS_READER_CODES,m._FACTS_PURE_CODES),
                               (caps.reader.DERIVE.FactsRejected,m._FACTS_PURE_CODES,m._FACTS_READER_CODES)):
            code=next(iter(codes))
            fake=type(cls.__name__,(RuntimeError,),{})
            derived=type('Derived',(cls,),{})
            for error in (fake(code),derived(code),cls(code,SENTINEL),cls(Text(code)),
                          cls('FACTS_UNDECLARED'),cls(next(iter(other))),RuntimeError(code)):
                with self.subTest(errorType=type(error).__name__):
                    self.assertEqual(m._reason(error,'ACQUIRE',bindings),{'stage':'ACQUIRE','code':'UNKNOWN'})
                    rejected=m._rejected(error,'ACQUIRE',bindings)
                    self.assertEqual(m.failure_diagnostic(rejected),{'stage':'ACQUIRE','code':'UNKNOWN'})
                    self.assertNotIn(SENTINEL,json.dumps(m.failure_diagnostic(rejected)))

    def test_all_facts_fixed_literals_reach_online_and_api_without_extra_fields(self):
        caps=self.facts_capabilities();driver=S['_declaration_runtime_driver']()
        function=S['measure_declaration_equivalence']
        for cls,codes in ((caps.reader.ReaderRejected,m._FACTS_READER_CODES),
                          (caps.reader.DERIVE.FactsRejected,m._FACTS_PURE_CODES)):
            for code in codes:
                with self.subTest(code=code):
                    rejected=driver._rejected(cls(code),'ACQUIRE',caps._diagnostic_errors)
                    with patch.dict(function.__globals__,{'_declaration_runtime_driver':lambda:driver}), \
                         patch.object(driver,'measure_declaration_equivalence',side_effect=rejected):
                        with self.assertRaises(S['DeclarationDriverError']) as caught:
                            function(object(),Path('/LOCAL_ONLY'),{},producer={'LOCAL_SYNTHETIC_ONLY':True},purpose='INDEPENDENT_PREFLIGHT')
                    error,diagnostic=self.api_failure(caught.exception)
                    self.assertEqual(error.args,('API_ADMIN_PENDING_ONLINE_DRIVER_'+code,))
                    self.assertEqual(diagnostic['step'],'DECLARATION_ACQUIRE')
                    self.assertEqual(diagnostic['phase'],'MANIFEST')
                    self.assertEqual(set(S['declaration_failure_diagnostic'](caught.exception)),{'stage','code'})

    def test_qualified_marker_only_from_exact_captured_class_and_closed_getter(self):
        cls=self.qualified.Rejected;error=cls('QUALIFIER_UNAVAILABLE')
        error._qualified_failure=('DAEMON_INFO','RUNTIME_ERROR')
        caps=SimpleNamespace(qualified=self.qualified)
        self.assertEqual(m._qualified_reason(error,caps),{'stage':'DAEMON_INFO','code':'RUNTIME_ERROR'})
        class Derived(cls):pass
        for unknown in (RuntimeError(SENTINEL),Derived('QUALIFIER_UNAVAILABLE')):
            unknown._qualified_failure=('DAEMON_INFO','RUNTIME_ERROR')
            self.assertIsNone(m._qualified_reason(unknown,caps))
        for value in ({'stage':SENTINEL,'code':'RUNTIME_ERROR'},
                      {'stage':'DAEMON_INFO','code':SENTINEL},
                      {'stage':'DAEMON_INFO','code':'RUNTIME_ERROR','extra':SENTINEL},
                      ['DAEMON_INFO','RUNTIME_ERROR']):
            with patch.object(self.qualified,'failure_diagnostic',return_value=value):
                self.assertIsNone(m._qualified_reason(error,caps))
        self.assertIsNone(m._qualified_reason(error,SimpleNamespace(qualified=SimpleNamespace())))

    def test_qualified_diagnostic_reaches_online_and_api_with_no_extra_payload(self):
        driver=S['_declaration_runtime_driver']()
        rejected=driver._rejected(RuntimeError(SENTINEL),'ACQUISITION',
            failure={'stage':'DAEMON_INFO','code':'RUNTIME_ERROR'})
        function=S['measure_declaration_equivalence']
        with patch.dict(function.__globals__,{'_declaration_runtime_driver':lambda:driver}), \
             patch.object(driver,'measure_declaration_equivalence',side_effect=rejected):
            with self.assertRaises(S['DeclarationDriverError']) as caught:
                function(object(),Path('/LOCAL_ONLY'),{},producer={'LOCAL_SYNTHETIC_ONLY':True},purpose='INDEPENDENT_PREFLIGHT')
        error,diagnostic=self.api_failure(caught.exception)
        self.assertEqual(error.args,('API_ADMIN_PENDING_ONLINE_DRIVER_RUNTIME_ERROR',))
        self.assertEqual(diagnostic['step'],'DECLARATION_DAEMON_INFO')
        self.assertEqual(diagnostic['phase'],'MANIFEST')

    def test_native_cli_fixed_codes_reach_online_and_api_without_extra_fields(self):
        codes=tuple(self.qualified._NATIVE_PERMISSION_CODES.values())
        self.assertEqual(len(codes),14)
        driver=S['_declaration_runtime_driver']();function=S['measure_declaration_equivalence']
        for code in codes:
            with self.subTest(code=code):
                error=self.qualified.Rejected('QUALIFIER_UNAVAILABLE')
                error._qualified_failure=('NATIVE_PERMISSIONS',code)
                failure=m._qualified_reason(error,SimpleNamespace(qualified=self.qualified))
                self.assertEqual(failure,{'stage':'NATIVE_PERMISSIONS','code':code})
                rejected=driver._rejected(error,'ACQUISITION',failure=failure)
                with patch.dict(function.__globals__,{'_declaration_runtime_driver':lambda:driver}), \
                     patch.object(driver,'measure_declaration_equivalence',side_effect=rejected):
                    with self.assertRaises(S['DeclarationDriverError']) as caught:
                        function(object(),Path('/LOCAL_ONLY'),{},producer={'LOCAL_SYNTHETIC_ONLY':True},purpose='INDEPENDENT_PREFLIGHT')
                api_error,diagnostic=self.api_failure(caught.exception)
                self.assertEqual(api_error.args,('API_ADMIN_PENDING_ONLINE_DRIVER_'+code,))
                self.assertEqual(diagnostic['step'],'DECLARATION_NATIVE_PERMISSIONS')
                self.assertEqual(diagnostic['phase'],'MANIFEST')
                self.assertNotIn(SENTINEL,json.dumps(diagnostic))

    def test_trusted_exact_classes_and_unknown_messages_never_leak(self):
        bindings=[(self.loader.Rejected,self.loader.CODES),(self.qualified.Rejected,self.qualified.CODES),
                  (self.collector.Rejected,self.collector.ERROR_CODES)]
        for cls,codes in [(m.Rejected,m.CODES),*bindings]:
            code=next(iter(codes));error=cls(code)
            self.assertEqual(m._reason(error,'MEASURE',bindings),{'stage':'MEASURE','code':code})
            for message in (SENTINEL,code+'_'+SENTINEL,'','UNKNOWN'):
                self.assertEqual(m._reason(cls(message),'MEASURE',bindings)['code'],'UNKNOWN')
        class NoString(RuntimeError):
            def __str__(self):raise AssertionError('EXCEPTION_STRING_MUST_NOT_RUN')
        class RootSubclass(m.Rejected):
            def __str__(self):raise AssertionError('SUBCLASS_STRING_MUST_NOT_RUN')
        for error in (RuntimeError('ROOT_SOURCE_CHANGED'),NoString(SENTINEL),RootSubclass('ROOT_SOURCE_CHANGED')):
            rejected=m._rejected(error,'MEASURE',bindings)
            self.assertEqual(m.failure_diagnostic(rejected),{'stage':'MEASURE','code':'UNKNOWN'})
            self.assertNotIn(SENTINEL,json.dumps(m.failure_diagnostic(rejected)))

    def test_package_binding_subphases_use_real_captured_loader(self):
        for stage in ('SOURCE_PROFILE','ARCHIVE_BIND','CONFIGURE'):
            with self.subTest(stage=stage):
                package=m._local_package();load_leaf=package.load_leaf
                def leaf(name):
                    value=load_leaf(name)
                    if name=='qualified.py' and stage=='SOURCE_PROFILE':
                        value._reviewed_profile=lambda:(_ for _ in ()).throw(value.Rejected('SOURCE_PROFILE_INVALID'))
                    if name=='reader.py' and stage=='CONFIGURE':
                        # The actual Package's captured class, not a named fake.
                        cls=package._diagnostic_errors[0][0]
                        raise cls('PACKAGE_FILE_CHANGED')
                    return value
                external=SimpleNamespace(online=self.online,workspace=SimpleNamespace(**W),inventory=self.inventory,paths={'api-admin-scope.py':HERE.parent/'api-admin-scope.py'})
                bind_error=__import__('urllib.error',fromlist=['URLError']).URLError(SENTINEL)
                with patch.object(m,'_local_package',return_value=package),patch.object(package,'load_leaf',side_effect=leaf), \
                     patch.object(package,'bind_consumers',side_effect=bind_error if stage=='ARCHIVE_BIND' else None,return_value=external):
                    with self.assertRaises(m.Rejected) as caught:m._capabilities({'commit':'a'*40,'sourceTree':'b'*40,'workflowRunId':'1','workflowRunAttempt':'1'})
                self.assertEqual(m.failure_diagnostic(caught.exception),{'stage':stage,'code':{'SOURCE_PROFILE':'SOURCE_PROFILE_INVALID','ARCHIVE_BIND':'URL_ERROR','CONFIGURE':'PACKAGE_FILE_CHANGED'}[stage]})

    def test_local_package_constructor_rejection_is_captured_before_return(self):
        loader=m._load(HERE/'package_io.py',self.package.manifest['files']['package_io.py'])
        with patch.object(m,'_load',return_value=loader),patch.object(loader,'Package',side_effect=loader.Rejected('PACKAGE_SCHEMA_CHANGED')):
            with self.assertRaises(m.Rejected) as caught:m._local_package()
        self.assertEqual(m.failure_diagnostic(caught.exception),{'stage':'LOCAL_PACKAGE','code':'PACKAGE_SCHEMA_CHANGED'})

    def test_archive_http_url_types_are_finite_without_url_reason_or_body(self):
        from urllib.error import HTTPError,URLError
        for error,code in ((HTTPError('LOCAL_PRIVATE_URL',403,SENTINEL,{},None),'HTTP_ERROR'),(URLError(SENTINEL),'URL_ERROR'),(TimeoutError(SENTINEL),'TIMEOUT')):
            self.assertEqual(m._reason(error,'ARCHIVE_BIND'),{'stage':'ARCHIVE_BIND','code':code})
            self.assertEqual(m._reason(error,'MEASURE')['code'],'UNKNOWN')
            class Derived(type(error)):pass
            derived=Derived('LOCAL_PRIVATE_URL',403,SENTINEL,{},None) if code=='HTTP_ERROR' else Derived(SENTINEL)
            self.assertEqual(m._reason(derived,'ARCHIVE_BIND')['code'],'UNKNOWN')

    def test_new_driver_capture_is_exact_pinned_bytes_with_unchanged_leaves(self):
        driver=S['_declaration_runtime_driver']()
        self.assertEqual(S['FORMAL_RUNTIME_DRIVER_SHA256'],hashlib.sha256((HERE/'driver.py').read_bytes()).hexdigest())
        self.assertEqual(driver.PACKAGE_MANIFEST_SHA,m.PACKAGE_MANIFEST_SHA)
        self.assertEqual(self.package.manifest['files'],json.loads((HERE/'manifest.json').read_bytes())['files'])
        self.assertIsNone(driver.failure_diagnostic(RuntimeError('ROOT_SOURCE_CHANGED')))

    def api_failure(self,error):
        d=SimpleNamespace(_workspaceBaselineDiagnostic={'phase':'MANIFEST','step':'JOBS_IDLE','service':'none',
            'scope':'API_ADMIN_WORKSPACE','errorType':'RuntimeError','rawOutputSuppressed':True})
        def require(ok,code):
            if not ok:raise RuntimeError(code)
        d.require=require
        original=S['measure_declaration_equivalence']
        self.online.measure_declaration_equivalence=lambda *a,**k:(_ for _ in ()).throw(error)
        function=W['_pending_online_declaration_measure']
        with patch.dict(function.__globals__,{'pending_online_equivalence':lambda:self.online}):
            with self.assertRaises(RuntimeError) as caught:function(d,Path('/LOCAL_ONLY'),{},producer={
                'commit':'a'*40,'sourceTree':'b'*40,'workflowRunId':'1','workflowRunAttempt':'1'},purpose='INDEPENDENT_PREFLIGHT')
        self.online.measure_declaration_equivalence=original
        self.assertTrue(W['valid_workspace_diagnostic'](d._workspaceBaselineDiagnostic))
        self.assertEqual(set(d._workspaceBaselineDiagnostic),{'phase','step','service','scope','errorType','rawOutputSuppressed'})
        self.assertNotIn(SENTINEL,json.dumps(d._workspaceBaselineDiagnostic))
        return caught.exception,d._workspaceBaselineDiagnostic

    def test_real_three_layer_projection_preserves_bounded_stage_and_code(self):
        driver=S['_declaration_runtime_driver']()
        rejected=driver._rejected(driver.Rejected('ROOT_HISTORY_CHANGED'),'ACQUIRE')
        function=S['measure_declaration_equivalence']
        with patch.dict(function.__globals__,{'_declaration_runtime_driver':lambda:driver}), \
             patch.object(driver,'measure_declaration_equivalence',side_effect=rejected):
            with self.assertRaises(S['DeclarationDriverError']) as caught:function(object(),Path('/LOCAL_ONLY'),{},
                producer={'LOCAL_SYNTHETIC_ONLY':True},purpose='INDEPENDENT_PREFLIGHT')
        error,diagnostic=self.api_failure(caught.exception)
        self.assertEqual(error.args,('API_ADMIN_PENDING_ONLINE_DRIVER_ROOT_HISTORY_CHANGED',))
        self.assertEqual(diagnostic['step'],'DECLARATION_ACQUIRE')
        self.assertEqual(diagnostic['phase'],'MANIFEST')

    def test_unknown_cause_keeps_original_error_and_no_private_text(self):
        error=S['_declaration_driver_failure']('ONLINE_RECHARGE_DECLARATION_DRIVER_UNAVAILABLE',{'stage':'MEASURE','code':'UNKNOWN'})
        caught,diagnostic=self.api_failure(error)
        self.assertEqual(caught.args,('API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED',))
        self.assertEqual(diagnostic['step'],'DECLARATION_MEASURE')
        caught,diagnostic=self.api_failure(RuntimeError(SENTINEL))
        self.assertEqual(caught.args,('API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED',))
        self.assertEqual(diagnostic['step'],'DECLARATION_ENTRY')

    def test_original_source_status_and_missing_legacy_getter_still_reject(self):
        error=S['_declaration_driver_failure']('ONLINE_RECHARGE_DECLARATION_SOURCE_NOT_MEASURED',{'stage':'SOURCE_PROFILE','code':'SOURCE_NOT_MEASURED'})
        caught,diagnostic=self.api_failure(error)
        self.assertEqual(caught.args,('ONLINE_RECHARGE_DECLARATION_SOURCE_NOT_MEASURED',))
        self.assertEqual(diagnostic['step'],'DECLARATION_SOURCE_PROFILE')
        getter=self.online.declaration_failure_diagnostic;del self.online.declaration_failure_diagnostic
        try:
            caught,diagnostic=self.api_failure(RuntimeError(SENTINEL))
            self.assertEqual(caught.args,('API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED',))
            self.assertEqual(diagnostic['step'],'DECLARATION_ENTRY')
        finally:self.online.declaration_failure_diagnostic=getter

    def test_closed_marker_rejects_unknown_extra_fields_types_and_subclasses(self):
        cls=S['DeclarationDriverError'];helper=S['declaration_failure_diagnostic']
        class Derived(cls):pass
        for error in (RuntimeError('ROOT_HISTORY_CHANGED'),Derived('ONLINE_RECHARGE_DECLARATION_DRIVER_UNAVAILABLE')):
            error._declaration_failure=('MEASURE','ROOT_HISTORY_CHANGED');self.assertIsNone(helper(error))
        for failure in ((SENTINEL,'ROOT_HISTORY_CHANGED'),('MEASURE',SENTINEL),['MEASURE','ROOT_HISTORY_CHANGED'],('MEASURE','ROOT_HISTORY_CHANGED',SENTINEL)):
            error=cls('ONLINE_RECHARGE_DECLARATION_DRIVER_UNAVAILABLE');error._declaration_failure=failure
            self.assertIsNone(helper(error))
        for stage in m.DIAGNOSTIC_STAGES:
            diagnostic={'phase':'MANIFEST','step':'DECLARATION_'+stage,'service':'none','scope':'API_ADMIN_WORKSPACE','errorType':'RuntimeError','rawOutputSuppressed':True}
            self.assertTrue(W['valid_workspace_diagnostic'](diagnostic))
            diagnostic['secret']=SENTINEL;self.assertFalse(W['valid_workspace_diagnostic'](diagnostic))
        self.assertFalse(W['valid_workspace_diagnostic']({'phase':'MANIFEST','step':'DECLARATION_'+SENTINEL,'service':'none','scope':'API_ADMIN_WORKSPACE','errorType':'RuntimeError','rawOutputSuppressed':True}))
    def test_api_peripheral_materials_binding_and_producer_stages_preserve_checks(self):
        p={'commit':'a'*40,'sourceTree':'b'*40,'workflowRunId':'1','workflowRunAttempt':'1'}
        function=W['_pending_online_declaration_measure']
        for boundary in ('MATERIALS','SOURCE_BINDING','PRODUCER'):
            with self.subTest(boundary=boundary):
                calls=[];d=SimpleNamespace(_workspaceBaselineDiagnostic={'phase':'MANIFEST','step':'JOBS_IDLE',
                    'service':'none','scope':'API_ADMIN_WORKSPACE','errorType':'RuntimeError','rawOutputSuppressed':True})
                def require(ok,code):
                    if not ok:raise RuntimeError(code)
                d.require=require
                proof={'measurement':{'purpose':'DEPLOYMENT_REMEASURE' if boundary=='PRODUCER' else 'INDEPENDENT_PREFLIGHT'},
                    'semantic':{'producer':p.copy()}}
                def measured(*a,**k):
                    calls.append(d._workspaceBaselineDiagnostic['step']);return proof
                def materials(*a,**k):
                    calls.append(d._workspaceBaselineDiagnostic['step'])
                    if boundary=='MATERIALS':raise RuntimeError(SENTINEL)
                    return {'producer':p.copy(),'archive_bytes':b'LOCAL_ONLY','historical_files':{}}
                def binding(*a,**k):
                    calls.append(d._workspaceBaselineDiagnostic['step'])
                    if boundary=='SOURCE_BINDING':raise RuntimeError(SENTINEL)
                online=SimpleNamespace(measure_declaration_equivalence=measured,declaration_equivalence_materials=materials,
                    declaration_equivalence_source_binding=binding,declaration_failure_diagnostic=S['declaration_failure_diagnostic'])
                with patch.dict(function.__globals__,{'pending_online_equivalence':lambda:online}):
                    with self.assertRaises(RuntimeError) as caught:function(d,Path('/LOCAL_ONLY'),{},producer=p,purpose='INDEPENDENT_PREFLIGHT')
                self.assertEqual(caught.exception.args,('API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED',))
                self.assertEqual(d._workspaceBaselineDiagnostic['step'],'DECLARATION_'+boundary)
                self.assertEqual(calls,['DECLARATION_ENTRY','DECLARATION_MATERIALS']+([] if boundary=='MATERIALS' else ['DECLARATION_SOURCE_BINDING']))
                self.assertTrue(W['valid_workspace_diagnostic'](d._workspaceBaselineDiagnostic))
                self.assertNotIn(SENTINEL,json.dumps(d._workspaceBaselineDiagnostic))

    def test_api_final_origin_step_preserves_original_validation(self):
        with tempfile.TemporaryDirectory(prefix='diagnostic-origin-',dir=HERE) as sandbox:
            base=Path(sandbox);directory=base/'releases'/('LOCAL_ONLY-'+m.BASELINE[:12]);directory.mkdir(parents=True)
            (directory/'release-manifest.json').write_bytes(b'{"LOCAL_SYNTHETIC_ONLY":true}')
            d=SimpleNamespace(BASE=base,_workspaceBaselineDiagnostic={'phase':'MANIFEST','step':'JOBS_IDLE',
                'service':'none','scope':'API_ADMIN_WORKSPACE','errorType':'RuntimeError','rawOutputSuppressed':True})
            def require(ok,code):
                if not ok:raise RuntimeError(code)
            d.require=require;calls=[]
            def mark(name):return lambda *a,**k:calls.append(name)
            online=SimpleNamespace(recovery_services=mark('recovery_services'),verify_permission_seed=mark('verify_permission_seed'),
                require_fresh_resources=mark('require_fresh_resources'),jobs_idle=mark('jobs_idle'))
            recovery={'state':'APPLIED','marker':'LOCAL_ONLY','source':directory,
                'restored':{'source':directory,'manifestSha256':'a'*64,'recordSha256':'b'*64}}
            def validate(value):
                calls.append('validate_pending_online_origin')
                self.assertEqual(d._workspaceBaselineDiagnostic['step'],'DECLARATION_ORIGIN_CHECK')
                raise RuntimeError('API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED')
            fn=W['pending_online_first']
            with patch.dict(fn.__globals__,{'pending_online_recovery':lambda *a:(online,recovery),
                'snapshot':lambda *a:{},'validate_pending_online_origin':validate}):
                with self.assertRaisesRegex(RuntimeError,'^API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED$'):fn(d,directory)
            self.assertEqual(calls,['recovery_services','verify_permission_seed','require_fresh_resources','jobs_idle','validate_pending_online_origin'])
            self.assertTrue(W['valid_workspace_diagnostic'](d._workspaceBaselineDiagnostic))

    def test_api_peripheral_step_enums_keep_six_fields_closed(self):
        for stage in ('MATERIALS','SOURCE_BINDING','PRODUCER','ORIGIN_CHECK'):
            value={'phase':'MANIFEST','step':'DECLARATION_'+stage,'service':'none','scope':'API_ADMIN_WORKSPACE',
                'errorType':'RuntimeError','rawOutputSuppressed':True}
            self.assertTrue(W['valid_workspace_diagnostic'](value))
            value['rawOutputSuppressed']=False;self.assertFalse(W['valid_workspace_diagnostic'](value))

    def test_current_readonly_failure_transport_accepts_only_closed_six_fields(self):
        reader=runpy.run_path(str(HERE.parent/'api-admin-readonly.py'))
        diagnostic={'phase':'MANIFEST','step':'DECLARATION_MEASURE','service':'none','scope':'API_ADMIN_WORKSPACE',
            'errorType':'RuntimeError','rawOutputSuppressed':True}
        receipt={'status':'API_ADMIN_WORKSPACE_VERIFICATION_FAILED','code':'API_ADMIN_PENDING_ONLINE_DRIVER_ACTUAL_NETWORK_INSPECT_CHANGED',
            'errorType':'RuntimeError','workspaceDiagnostic':diagnostic}
        safe=reader['safe_failure'](receipt,'API_ADMIN_WORKSPACE')
        self.assertEqual(safe,receipt)
        diagnostic['unexpected']=SENTINEL
        safe=reader['safe_failure'](receipt,'API_ADMIN_WORKSPACE')
        self.assertNotIn('workspaceDiagnostic',safe);self.assertNotIn(SENTINEL,json.dumps(safe))

    def test_factory_configuration_cause_survives_before_context_yield(self):
        package=m._local_package();load_leaf=package.load_leaf;factories=[]
        def leaf(name):
            if name=='collector.py':raise package._diagnostic_errors[0][0]('PACKAGE_FILE_CHANGED')
            result=load_leaf(name)
            if name=='qualified.py':result._configure=lambda external,pure,factory:factories.append(factory)
            return result
        external=SimpleNamespace(online=self.online,workspace=SimpleNamespace(**W),inventory=self.inventory,
            paths={'api-admin-scope.py':HERE.parent/'api-admin-scope.py'})
        with patch.object(m,'_local_package',return_value=package),patch.object(package,'load_leaf',side_effect=leaf), \
             patch.object(package,'bind_consumers',return_value=external):
            caps=m._capabilities({'commit':'a'*40,'sourceTree':'b'*40,'workflowRunId':'1','workflowRunAttempt':'1'})
            with self.assertRaises(package._diagnostic_errors[0][0]):factories[0]()
        self.assertEqual(caps._diagnostic_failure,[{'stage':'CONFIGURE','code':'PACKAGE_FILE_CHANGED'}])
        self.assertEqual(m.failure_diagnostic(m._rejected(self.qualified.Rejected('QUALIFIER_UNAVAILABLE'),'ACQUISITION',
            caps._diagnostic_errors,caps._diagnostic_failure[0])),{'stage':'CONFIGURE','code':'PACKAGE_FILE_CHANGED'})


class LiveMaterialsAdapterTests(unittest.TestCase):
    """Actual pinned source helpers + real private files, synthetic archive.

    The archive has an independently recomputed Git tree, but its commit/run
    and historical records are synthetic; no production provenance is claimed.
    No Git write, source download, controller command or Docker call occurs.
    """
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='live-materials-',dir=HERE)
        self.addCleanup(self.temp.cleanup);self.base=Path(self.temp.name)
        self.online=m._load(ROOT/'scripts/production-release/online-recharge-scope.py',m.byte_sha((ROOT/'scripts/production-release/online-recharge-scope.py').read_bytes()))
        self.shared=SimpleNamespace(STATE_FILE='api-workspace-preservation.json',PROOF_FILE='api-workspace-build-proof.json')
        self.controller=SimpleNamespace(BASE=self.base,require=self.require,
            run=self.forbid,compose=self.forbid,production_services=self.forbid,service_state=self.forbid,
            _declarationSourceArchiveCache={'CALLER_CACHE_REFUSED':SENTINEL})
        self.runner=m._SourceReadDriver(self.controller)
        self.online.legacy=lambda d:self.shared
        self.policy=json.loads((ROOT/'scripts/production-release/online-recharge-recovery.json').read_bytes())
        self.measured,self.facts,self.root=fixture()
        self.history={name:m.canonical({'LOCAL_SYNTHETIC_RECORD':name})
                      for name in self.online.DECLARATION_EQUIVALENCE_FIELDS['historicalFiles']}
        old=self.policy['preflight']['services']
        before=copy.deepcopy(old);candidate=copy.deepcopy(old)
        for n in ('api','admin'):
            before[n]['containerId']=self.root['anchors'][n]['oldBeforeContainerId']
            candidate[n]['containerId']=self.root['anchors'][n]['candidateAfterContainerId']
        self.history.update({
            'workspaceManifestBytesSha256':m.canonical({'commit':m.BASELINE}),
            'workspaceBuildProofBytesSha256':m.canonical({'commit':m.BASELINE}),
            'workspaceRecordBytesSha256':m.canonical({'before':before,'after':old}),
            'restoredManifestBytesSha256':m.canonical({'commit':self.online.RESTORED_COMMIT}),
            'restoredRecordBytesSha256':m.canonical({'before':old,'after':candidate}),
            'restoredBuildProofBytesSha256':m.canonical(self.policy['restoredAttempt']['buildProof']),
            'recoveryPolicy':(ROOT/'scripts/production-release/online-recharge-recovery.json').read_bytes()})
        repo=HERE.parents[2]
        completed={p.parent.name:m.byte_sha(p.read_bytes()) for p in (repo/'apps/api/prisma-mysql/migrations').glob('*/migration.sql')}
        self.assertEqual(len(completed),47)
        state={'name':self.online.MIGRATION_NAME,'sha256':self.online.MIGRATION_IDENTITY['sha256'],
            'status':'APPLIED','schemaVerified':True,'appliedMigrationsSha256':m.digest(completed)}
        common={'errorType':'RuntimeError','rollbackOk':True,'previousCommit':m.BASELINE,
            'inverseMigrationPerformed':False,'mediaVolumeDeleted':False,'currentPointsToCandidate':False,'receiptPersisted':True}
        one={**common,'status':'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH','step':'migration','code':'ONLINE_RECHARGE_STEP_FAILED',
            'rollback':{},'servicesAttempted':[],'candidateCommit':self.online.RECOVERY_COMMIT,
            'migration':{**state,'performed':True},'migrationAttempted':True}
        two={**common,'status':'ONLINE_RECHARGE_FAILED_RESTORED','step':'audit-after',
            'code':'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED','rollback':{n:'RESTORED' for n in self.online.SWITCH_ORDER},
            'servicesAttempted':list(self.online.SWITCH_ORDER),'candidateCommit':self.online.RESTORED_COMMIT,
            'migration':{**state,'performed':False},'migrationAttempted':False}
        self.assertEqual(m.digest(one),self.online.RECOVERY_FAILURE_SHA256)
        self.assertEqual(m.digest(two),self.online.RESTORED_FAILURE_SHA256)
        self.history.update(firstFailure=m.canonical(one),secondFailure=m.canonical(two))
        releases=self.base/'releases';releases.mkdir(mode=0o700)
        self.directory=releases/('20261010T000000Z-'+m.BASELINE[:12])
        self.first=releases/('20261010T000000Z-'+self.online.RECOVERY_COMMIT[:12])
        self.second=releases/('20261010T000000Z-'+self.online.RESTORED_COMMIT[:12])
        for p in (self.directory,self.first,self.second):p.mkdir(mode=0o700)
        self.helpers=self.base/'executing-helpers';self.helpers.mkdir(mode=0o700)
        names=(*self.online.DECLARATION_EQUIVALENCE_HELPERS,
            'scripts/production-release/online-recharge-declaration-measurement.py',
            'scripts/production-release/api-admin-pending-receipt-wire.py',
            'scripts/production-release/online-recharge-daemon-identity.py',
            'scripts/production-release/online-recharge-daemon-listener.py',
            'scripts/production-release/online-recharge-daemon-socket.py')
        self.helper_bytes={n:(repo/n).read_bytes() for n in names}
        for n,raw in self.helper_bytes.items():self.write(self.helpers/Path(n).name,raw)
        self.write(self.helpers/self.online.RECOVERY_FILE,self.history['recoveryPolicy'])
        self.online.__file__=str(self.helpers/'online-recharge-scope.py')
        self.paths={
            'workspaceManifestBytesSha256':self.directory/'release-manifest.json',
            'workspaceRecordBytesSha256':self.directory/self.shared.STATE_FILE,
            'workspaceBuildProofBytesSha256':self.directory/self.shared.PROOF_FILE,
            'restoredManifestBytesSha256':self.second/'release-manifest.json',
            'restoredRecordBytesSha256':self.second/self.online.STATE_FILE,
            'restoredBuildProofBytesSha256':self.second/self.online.PROOF_FILE,
            'firstFailure':self.first/self.online.FAILURE_FILE,'secondFailure':self.second/self.online.FAILURE_FILE}
        for n,p in self.paths.items():self.write(p,self.history[n])
        self.recovery={'source':self.first,'policy':self.policy,'marker':self.online.recovery_marker(self.policy),
            'restored':{'source':self.second,'manifestSha256':m.byte_sha(self.history['restoredManifestBytesSha256']),
                'recordSha256':m.byte_sha(self.history['restoredRecordBytesSha256']),
                'workspaceOriginFiles':{self.paths[n].name:m.byte_sha(self.history[n]) for n in (
                    'workspaceManifestBytesSha256','workspaceRecordBytesSha256','workspaceBuildProofBytesSha256')}}}
        self.commit='a'*40;self.archive,self.tree=self.archive_bytes(self.helper_bytes)
        self.p={'commit':self.commit,'sourceTree':self.tree,'workflowRunId':'70000000001','workflowRunAttempt':'1'}
        self.download=patch.object(self.online.urllib.request,'urlopen',side_effect=lambda *a,**k:io.BytesIO(self.archive))
        self.mock_download=self.download.start();self.addCleanup(self.download.stop)

    @staticmethod
    def require(ok,code):
        if not ok:raise RuntimeError(code)
    @staticmethod
    def forbid(*args,**kwargs):raise AssertionError('LOCAL_SOURCE_TEST_CANNOT_EXECUTE')
    @staticmethod
    def write(path,raw):path.write_bytes(raw);path.chmod(0o600)
    def archive_bytes(self,files):
        entries={};stream=io.BytesIO()
        with tarfile.open(fileobj=stream,mode='w:gz') as tar:
            for name,raw in sorted(files.items()):
                item=tarfile.TarInfo('id-business-system-'+self.commit+'/'+name);item.size=len(raw);item.mode=0o644
                tar.addfile(item,io.BytesIO(raw));parts=Path(name).parts;parent=entries
                for p in parts[:-1]:parent=parent.setdefault(p,{})
                parent[parts[-1]]=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).digest()
        def encode(rows):
            raw=b''
            for name,value in sorted(rows.items(),key=lambda item:(item[0]+'/' if type(item[1]) is dict else item[0]).encode()):
                mode,oid=('40000',encode(value)) if type(value) is dict else ('100644',value)
                raw+=mode.encode()+b' '+name.encode()+b'\0'+oid
            return hashlib.sha1(b'tree '+str(len(raw)).encode()+b'\0'+raw).digest()
        return stream.getvalue(),encode(entries).hex()
    def materials(self):
        return self.online.declaration_equivalence_materials(self.runner,self.directory,self.recovery,producer=self.p,phase='LIVE')
    def proof(self,result):
        root=copy.deepcopy(self.root);root.update(producer=result['producer'],historicalFiles={
            n:result['historical_files'][n] for n in self.online.DECLARATION_EQUIVALENCE_FIELDS['historicalFiles']},
            sourceArchiveBytesSha256=m.byte_sha(result['archive_bytes']))
        root['adminProjection']['helperSha256']=result['producer']['helpers'][self.online.DECLARATION_EQUIVALENCE_HELPERS[2]]
        return C['construct_preview'](self.measured,root=root,facts=self.facts,purpose='INDEPENDENT_PREFLIGHT')
    def test_actual_live_helper_reads_owned_cache_and_all_history_bytes(self):
        result=self.materials();self.assertEqual(result['historical_files'],self.history)
        self.assertEqual(result['archive_bytes'],self.archive);self.assertEqual(self.materials(),result)
        self.mock_download.assert_called_once();self.assertEqual(set(self.runner._declarationSourceArchiveCache),{(self.commit,self.tree)})
        self.assertEqual(self.controller._declarationSourceArchiveCache,{'CALLER_CACHE_REFUSED':SENTINEL})
    def test_actual_live_cached_archive_rechecks_executing_helper_bytes(self):
        self.materials();path=self.helpers/'online-recharge-daemon-socket.py';self.write(path,path.read_bytes()+b'\n# LOCAL_TAMPER\n')
        with self.assertRaises(RuntimeError):self.materials()
        self.mock_download.assert_called_once()
    def test_actual_live_cached_archive_rechecks_receipt_original_bytes(self):
        self.materials();self.write(self.paths['secondFailure'],m.canonical({'malformed':SENTINEL}))
        with self.assertRaises(RuntimeError):self.materials()
        self.mock_download.assert_called_once()
    def test_actual_live_history_hash_claim_cannot_replace_source_file(self):
        self.materials();self.write(self.paths['workspaceRecordBytesSha256'],m.canonical({'sha256':h('claim'),'trusted':True}))
        with self.assertRaises(RuntimeError):self.materials()
    def test_actual_source_binding_checks_six_history_and_actual_archive(self):
        result=self.materials();proof=self.proof(result)
        bound=self.online.declaration_equivalence_source_binding(self.runner,proof,**result)
        self.assertEqual(bound['proofSha256'],m.digest(proof))
        altered=copy.deepcopy(result);altered['historical_files']['firstFailure']=m.canonical({'trusted':True})
        with self.assertRaises(RuntimeError):self.online.declaration_equivalence_source_binding(self.runner,proof,**altered)
    def test_actual_source_binding_rejects_omitted_historical_byte(self):
        result=self.materials();proof=self.proof(result);result['historical_files'].pop('secondFailure')
        with self.assertRaises(RuntimeError):self.online.declaration_equivalence_source_binding(self.runner,proof,**result)
    def test_actual_archive_wrong_tree_or_required_helper_cannot_be_claimed(self):
        self.runner._declarationSourceArchiveCache={(self.commit,self.tree):b'LOCAL_BAD_ARCHIVE'}
        with self.assertRaises(RuntimeError):self.materials()
        self.assertEqual(self.mock_download.call_count,0)
        files={n:raw for n,raw in self.helper_bytes.items() if not n.endswith('/online-recharge-daemon-socket.py')}
        self.archive,self.tree=self.archive_bytes(files);self.p['sourceTree']=self.tree
        self.runner._declarationSourceArchiveCache={}
        with self.assertRaises(RuntimeError):self.materials()
    def test_actual_live_fifo_rejected_before_open_or_block(self):
        path=self.paths['firstFailure'];path.unlink();os.mkfifo(path,0o600)
        with self.assertRaises(RuntimeError):self.materials()
        self.mock_download.assert_not_called()



class SourceFilePermissionDriverTests(unittest.TestCase):
    # Reuse the existing local fixture helpers without inheriting its test methods.
    base_fd=DriverTests.base_fd
    file_hashes=DriverTests.file_hashes
    raw=DriverTests.raw
    make_reader=DriverTests.make_reader
    assert_stable=DriverTests.assert_stable
    source_binding=DriverTests.source_binding
    measure=DriverTests.measure
    run_driver=DriverTests.run_driver
    registry_path=DriverTests.registry_path
    diagnostic_failure=DriverTests.diagnostic_failure
    def setUp(self):
        DriverTests.setUp(self)
        self.package=m._local_package()
        self.inventory=load('source_permission_inventory',HERE.parent/'online-recharge-declaration-measurement.py')
        self.collector=self.package.load_leaf('collector.py')
        self.collector._configure(self.inventory,DERIVE,self.package.contract)
        self.caps._diagnostic_errors=[(self.inventory.Rejected,self.collector.ERROR_CODES)]
        self.binding=m._source_file_permission_binding(self.collector,self.inventory.Rejected)
        self.assertIsNotNone(self.binding)
        self.caps._source_file_permission_bindings=[self.binding]
        self.source_directory=self.base/'source-permission';self.source_directory.mkdir(mode=0o700)

    def fail_source(self,name,private,reason):
        c=self.collector;path=self.source_directory/name
        path.write_bytes(SENTINEL.encode());path.chmod(0o644 if reason=='PRIVATE_MODE' else 0o666 if reason=='PUBLIC_WRITABLE' else 0o600)
        self.source_directory.chmod(0o770 if reason=='PARENT_WRITABLE' else 0o700)
        parent=c._file_parent;fstat=os.fstat;parents=[]
        def opened(value):
            fd,chain=parent(value);parents.append(fd);return fd,chain
        class OwnerMismatch:
            st_uid=os.getuid()+1
            @property
            def st_mode(self):raise AssertionError('PARENT_UID_AND_MUST_SHORT_CIRCUIT')
        def info(fd):return OwnerMismatch() if reason=='PARENT_UID' and fd in parents else fstat(fd)
        with patch.object(c,'_file_parent',side_effect=opened),patch.object(c.os,'fstat',side_effect=info):
            return c._sealed_file(path,private=private)

    def test_actual_inner_acquire_nine_codes_reach_exact_six_field_api_projection(self):
        fn=S['measure_declaration_equivalence'];api=W['_pending_online_declaration_measure']
        rows=(('COMPOSE','docker-compose.aws-mysql.yml',False,'PUBLIC_WRITABLE'),('RELEASE','compose.release.json',False,'PUBLIC_WRITABLE'),('CLIENT','config.json',True,'PRIVATE_MODE'))
        for role,name,private,leaf in rows:
            for reason in ('PARENT_UID','PARENT_WRITABLE',leaf):
                with self.subTest(role=role,reason=reason):
                    self.online.snapshot=lambda *a:self.fail_source(name,private,reason)
                    with patch.dict(fn.__globals__,{'_declaration_runtime_driver':lambda:m}):
                        with self.assertRaises(S['DeclarationDriverError']) as caught:
                            fn(self.controller,self.directory,self.recovery,producer=self.p,purpose='INDEPENDENT_PREFLIGHT')
                    code=m._SOURCE_FILE_PERMISSION_CODES[(role,reason)]
                    self.assertEqual(S['declaration_failure_diagnostic'](caught.exception),{'stage':'ACQUIRE','code':code})
                    probe=DeclarationFailureProjectionTests();probe.online=SimpleNamespace(**S)
                    projected,diagnostic=probe.api_failure(caught.exception)
                    self.assertEqual(projected.args,('API_ADMIN_PENDING_ONLINE_DRIVER_'+code,))
                    self.assertEqual(diagnostic,{'phase':'MANIFEST','step':'DECLARATION_ACQUIRE','service':'none','scope':'API_ADMIN_WORKSPACE','errorType':'RuntimeError','rawOutputSuppressed':True})
                    raw=json.dumps({'code':projected.args[0],'workspaceDiagnostic':diagnostic})
                    for secret in (str(self.source_directory),SENTINEL,'st_uid','st_mode','config.json','docker-compose.aws-mysql.yml','compose.release.json'):
                        self.assertNotIn(secret,raw)
                    self.assertFalse(self.registry_path().exists());self.assertEqual(self.measure_calls,0)
        self.assertEqual(self.exit_calls,9);self.assertEqual(self.material_calls,9)

    def test_other_stage_and_unissued_source_failures_stay_original_generic(self):
        self.action=lambda:self.fail_source('config.json',True,'PRIVATE_MODE')
        self.diagnostic_failure('MEASURE','SOURCE_FILE_PERMISSIONS','ROOT_DRIVER_UNAVAILABLE')
        self.assertEqual(self.measure_calls,1)
        self.action=None
        alias=self.inventory.Rejected('SOURCE_FILE_PERMISSIONS');alias._source_file_permission_failure=('CLIENT','PRIVATE_MODE')
        # Reproduce the corrupt-state gap through the actual inner catch: a
        # caller-installed legal tuple for a fresh alias still stays generic.
        self.collector._SOURCE_FILE_PERMISSION_FAILURE=(alias,'CLIENT','PRIVATE_MODE')
        self.online.snapshot=lambda *a:(_ for _ in ()).throw(alias)
        self.diagnostic_failure('ACQUIRE','SOURCE_FILE_PERMISSIONS','ROOT_DRIVER_UNAVAILABLE')
        self.assertEqual(self.measure_calls,1)

    def test_first_acquire_detail_survives_actual_qualified_cleanup_wrapper(self):
        qualified=self.package.load_leaf('qualified.py');delivered=[]
        self.caps.qualified=qualified
        self.caps._diagnostic_errors.append((qualified.Rejected,qualified.CODES))
        @contextmanager
        def inner(d,session):
            try:yield self.session
            except Exception as error:delivered.append(error);raise
            finally:
                self.exit_calls+=1
                raise qualified.Rejected('CLIENT_SOURCE_CHANGED')
        with patch.object(qualified,'_reviewed_profile',return_value={'LOCAL_MOCK_ONLY':True}), \
             patch.object(qualified,'_load_base',return_value=object()),patch.object(qualified,'_Session',return_value=SimpleNamespace()), \
             patch.object(qualified,'_load_socket',return_value=object()),patch.object(qualified,'_acquisition_context',inner):
            self.online.snapshot=lambda *a:self.fail_source('config.json',True,'PRIVATE_MODE')
            self.diagnostic_failure('ACQUIRE','SOURCE_CLIENT_PRIVATE_MODE','ROOT_DRIVER_UNAVAILABLE')
        self.assertEqual(len(delivered),1);self.assertEqual(delivered[0].args,('SOURCE_FILE_PERMISSIONS',))
        self.assertEqual(self.exit_calls,1);self.assertEqual(self.measure_calls,0)

    def test_binding_rejects_foreign_module_function_globals_alias_and_getter_failures(self):
        import types
        c=self.collector;cls=self.inventory.Rejected;getter=c.source_file_permission_failure
        self.assertIsNone(m._source_file_permission_binding(SimpleNamespace(**vars(c)),cls))
        self.assertIsNone(m._source_file_permission_binding(c,type('FreshAlias',(RuntimeError,),{})))
        foreign=types.FunctionType(getter.__code__,dict(getter.__globals__),getter.__name__,None,getter.__closure__)
        for value in (lambda error:('CLIENT','PRIVATE_MODE'),foreign,SimpleNamespace(__call__=getter)):
            with patch.object(c,'source_file_permission_failure',value):self.assertIsNone(m._source_file_permission_binding(c,cls))
        base={'stage':'ACQUIRE','code':'SOURCE_FILE_PERMISSIONS'};error=cls('SOURCE_FILE_PERMISSIONS')
        for value in (lambda error:(_ for _ in ()).throw(ValueError(SENTINEL)),lambda error:['CLIENT','PRIVATE_MODE'],lambda error:('CLIENT','PUBLIC_WRITABLE'),lambda error:('CLIENT','PRIVATE_MODE','EXTRA')):
            self.assertIs(m._source_file_permission_reason(base,error,[(cls,value)]),base)
        class Derived(cls):pass
        self.assertIs(m._source_file_permission_reason(base,Derived('SOURCE_FILE_PERMISSIONS'),[(cls,lambda error:('CLIENT','PRIVATE_MODE'))]),base)

    def test_actual_factory_binds_final_configured_pinned_collector(self):
        # Exercise the actual factory instead of injecting a caller-owned getter.
        package=self.package;leaf=package.load_leaf;factories=[]
        def load_leaf(name):
            result=leaf(name)
            if name=='qualified.py':result._configure=lambda external,pure,factory:factories.append(factory)
            return result
        external=SimpleNamespace(online=SimpleNamespace(**S),workspace=SimpleNamespace(**W),inventory=self.inventory,
            paths={'api-admin-scope.py':HERE.parent/'api-admin-scope.py'})
        with patch.object(m,'_local_package',return_value=package),patch.object(package,'load_leaf',side_effect=load_leaf), \
             patch.object(package,'bind_consumers',return_value=external):
            # The normal fixture patches _capabilities; stop it only for this factory check.
            self.cap_patch.stop()
            try:caps=m._capabilities(self.p)
            finally:self.cap_patch.start()
            self.assertEqual(caps._source_file_permission_bindings,[])
            collected=factories[0]()
        self.assertIs(collected.Rejected,self.inventory.Rejected)
        self.assertEqual(caps._source_file_permission_bindings,[(self.inventory.Rejected,collected.source_file_permission_failure)])
        self.assertIs(collected.source_file_permission_failure.__globals__,vars(collected))
        self.assertEqual(caps._diagnostic_failure,[])



class QualifiedInnerUnknownDriverTests(unittest.TestCase):
    # Reuse only fixture helpers, so selecting this class never runs DriverTests.
    base_fd=DriverTests.base_fd
    file_hashes=DriverTests.file_hashes
    raw=DriverTests.raw
    make_reader=DriverTests.make_reader
    assert_stable=DriverTests.assert_stable
    source_binding=DriverTests.source_binding
    measure=DriverTests.measure
    run_driver=DriverTests.run_driver
    registry_path=DriverTests.registry_path
    diagnostic_failure=DriverTests.diagnostic_failure
    def setUp(self):
        DriverTests.setUp(self)
        package=m._local_package()
        self.q=package.load_leaf('qualified.py')
        self.inventory=load('inner_unknown_inventory',HERE.parent/'online-recharge-declaration-measurement.py')
        self.collector=package.load_leaf('collector.py');self.collector._configure(self.inventory,DERIVE,package.contract)
        self.identity=load('inner_unknown_identity',HERE.parent/'online-recharge-daemon-identity.py')
        self.socket=load('inner_unknown_socket',HERE.parent/'online-recharge-daemon-socket.py')
        self.listener=load('inner_unknown_listener',HERE.parent/'online-recharge-daemon-listener.py')
        socket_path=HERE.parent/'online-recharge-daemon-socket.py'
        external=SimpleNamespace(identity=self.identity,listener=self.listener,socket=self.socket,
            paths={'online-recharge-daemon-socket.py':socket_path},
            leaf_pins={'online-recharge-daemon-socket.py':hashlib.sha256(socket_path.read_bytes()).hexdigest()},
            socket_bytes=socket_path.read_bytes(),assert_stable=lambda:None)
        self.q._configure(external,DERIVE,lambda:self.collector)
        self.caps.qualified=self.q
        # Match the real driver bindings: socket exceptions are not yet wrapped.
        self.caps._diagnostic_errors=[(self.q.Rejected,self.q.CODES),(self.inventory.Rejected,self.collector.ERROR_CODES)]
        self.states=[];self.delivered=[];self.cleanup_error=None
        @contextmanager
        def inner(d,session):
            # Only acquisition I/O/cleanup is synthetic. The public qualifier,
            # actual _Session.runtime and its capture/wrapping remain real.
            self.real_session=session;self.states.append(session._diagnostic_state)
            self.q._stage(session,'YIELD')
            try:yield self.session
            except Exception as error:
                self.delivered.append(error);self.q._capture(session,error);raise
            finally:
                self.exit_calls+=1
                self.q._stage(session,'CLEANUP')
                if self.cleanup_error is not None:
                    self.q._capture(session,self.cleanup_error,cleanup=True)
                    raise self.cleanup_error
        item=patch.object(self.q,'_acquisition_context',inner);item.start();self.addCleanup(item.stop)
        # This runs inside driver's real RULES body, before context unwinding.
        self.session.assert_stable=lambda:self.real_session.runtime(self.controller)
        self.original=self.socket.Rejected('RUNTIME_DRIFT')
        item=patch.object(self.socket,'runtime_daemon_socket_binding',side_effect=self.original)
        item.start();self.addCleanup(item.stop)

    def assert_closed_failure(self,stage,code):
        error=self.diagnostic_failure(stage,code,'ROOT_DRIVER_UNAVAILABLE')
        self.assertEqual(self.exit_calls,1);self.assertEqual(self.measure_calls,0)
        self.assertEqual(self.material_calls,0)
        self.assertEqual(BaseException.args.__get__(self.original),('RUNTIME_DRIFT',))
        return error

    def test_actual_rules_runtime_unknown_reaches_qualified_and_six_field_api(self):
        self.assertEqual(m._reason(self.original,'RULES',self.caps._diagnostic_errors),{'stage':'RULES','code':'UNKNOWN'})
        error=self.assert_closed_failure('RUNTIME_VFS','RUNTIME_DRIFT')
        self.assertIs(self.delivered[0],self.original)
        self.assertEqual(self.states[0].first,('RUNTIME_VFS','RUNTIME_DRIFT'))
        self.assertIsNone(self.states[0].cleanup)
        online=SimpleNamespace(**S)
        function=S['measure_declaration_equivalence']
        with patch.dict(function.__globals__,{'_declaration_runtime_driver':lambda:m}), \
             patch.object(m,'measure_declaration_equivalence',side_effect=error):
            with self.assertRaises(S['DeclarationDriverError']) as caught:
                function(object(),Path('/LOCAL_ONLY'),{},producer={'LOCAL_SYNTHETIC_ONLY':True},purpose='INDEPENDENT_PREFLIGHT')
        online_error=caught.exception
        d=SimpleNamespace(_workspaceBaselineDiagnostic={'phase':'MANIFEST','step':'JOBS_IDLE','service':'none',
            'scope':'API_ADMIN_WORKSPACE','errorType':'RuntimeError','rawOutputSuppressed':True})
        def require(ok,code):
            if not ok:raise RuntimeError(code)
        d.require=require
        online.measure_declaration_equivalence=lambda *a,**k:(_ for _ in ()).throw(online_error)
        api=W['_pending_online_declaration_measure']
        with patch.dict(api.__globals__,{'pending_online_equivalence':lambda:online}):
            with self.assertRaises(RuntimeError) as caught:
                api(d,Path('/LOCAL_ONLY'),{},producer=self.p,purpose='INDEPENDENT_PREFLIGHT')
        self.assertEqual(caught.exception.args,('API_ADMIN_PENDING_ONLINE_DRIVER_RUNTIME_DRIFT',))
        self.assertEqual(set(d._workspaceBaselineDiagnostic),{'phase','step','service','scope','errorType','rawOutputSuppressed'})
        self.assertEqual(d._workspaceBaselineDiagnostic['step'],'DECLARATION_RUNTIME_VFS')
        self.assertTrue(W['valid_workspace_diagnostic'](d._workspaceBaselineDiagnostic))
        self.assertNotIn(SENTINEL,json.dumps(d._workspaceBaselineDiagnostic))

    def test_known_inner_first_survives_qualified_cleanup_failure(self):
        known=m.Rejected('ROOT_SOURCE_CHANGED')
        self.session.reviewed_rules=lambda:(_ for _ in ()).throw(known)
        self.cleanup_error=PermissionError(SENTINEL)
        with patch.object(self.q,'failure_diagnostic',side_effect=AssertionError('KNOWN_FIRST_MUST_NOT_QUERY_GETTER')):
            self.assert_closed_failure('RULES','ROOT_SOURCE_CHANGED')
        self.assertIs(self.delivered[0],known)
        self.assertEqual(self.states[0].cleanup,('CLEANUP','PERMISSION_ERROR'))

    def test_unknown_inner_uses_qualified_original_cleanup_priority(self):
        self.cleanup_error=PermissionError(SENTINEL)
        self.assert_closed_failure('CLEANUP','PERMISSION_ERROR')
        self.assertEqual(self.states[0].first,('RUNTIME_VFS','RUNTIME_DRIFT'))
        self.assertEqual(self.states[0].cleanup,('CLEANUP','PERMISSION_ERROR'))

    def test_unknown_inner_invalid_throwing_missing_and_unknown_getters_fall_back(self):
        values=(None,{'stage':'RUNTIME_VFS','code':'UNKNOWN'},
                {'stage':'OUTSIDE','code':'RUNTIME_DRIFT'},
                {'stage':'RUNTIME_VFS','code':SENTINEL},
                {'stage':'RUNTIME_VFS','code':'RUNTIME_DRIFT','extra':SENTINEL})
        cases=[('value',value) for value in values]+[('throws',None),('missing',None),('no_qualifier_class',None),('both_unknown',None)]
        for kind,value in cases:
            with self.subTest(kind=kind,valueType=type(value).__name__):
                self.exit_calls=0;self.states=[];self.delivered=[]
                if kind=='throws':item=patch.object(self.q,'failure_diagnostic',side_effect=RuntimeError(SENTINEL))
                elif kind=='missing':item=patch.object(self.q,'failure_diagnostic',None)
                elif kind=='no_qualifier_class':item=patch.object(self.caps,'qualified',SimpleNamespace(acquisition_session=self.q.acquisition_session))
                elif kind=='both_unknown':
                    class ForeignError(RuntimeError):pass
                    self.session.reviewed_rules=lambda:(_ for _ in ()).throw(ForeignError(SENTINEL))
                    item=patch.object(self.q,'failure_diagnostic',wraps=self.q.failure_diagnostic)
                else:item=patch.object(self.q,'failure_diagnostic',return_value=value)
                with item:self.assert_closed_failure('RULES','UNKNOWN')

    def test_no_inner_failure_recorded_and_none_paths_preserve_original_behavior(self):
        cases=([{'stage':'CONFIGURE','code':'UNKNOWN'}],
               [{'stage':'CONFIGURE','code':'SOURCE_FILE_INVALID'}],[])
        for recorded in cases:
            with self.subTest(recorded=recorded):
                self.caps._diagnostic_failure=recorded
                with patch.object(self.q,'_reviewed_profile',side_effect=self.q.Rejected('SOURCE_NOT_MEASURED')):
                    with self.assertRaises(m.Rejected) as caught:self.run_driver()
                expected=recorded[0] if recorded else {'stage':'QUALIFIER_PROFILE','code':'SOURCE_NOT_MEASURED'}
                self.assertEqual(m.failure_diagnostic(caught.exception),expected)
                self.assertEqual(caught.exception.args,('ROOT_GENERATOR_SOURCE_UNMEASURED',))
                self.assertFalse(self.registry_path().exists());self.assertEqual(self.exit_calls,0)

if __name__=='__main__':unittest.main()
