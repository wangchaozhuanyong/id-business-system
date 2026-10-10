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


if __name__=='__main__':unittest.main()
