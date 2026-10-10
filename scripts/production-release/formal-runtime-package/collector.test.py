"""SYNTHETIC_ONLY; mock driver exclusively. No Docker/AWS/subprocess."""
import copy
import json
import math
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
FIX=runpy.run_path(str(HERE/'collector-fixture.test-support.py'));a=FIX['a'];M=a.frozen
ctor=FIX['load']('fixture_constructor',HERE/'constructor.py');consumer=FIX['load']('current_online_for_pure',FIX['ROOT']/'scripts/production-release/online-recharge-scope.py');ctor._configure(consumer,json.loads((HERE/'contract.json').read_bytes()));C=ctor.__dict__
D=a.derive

class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='synthetic-',dir=HERE)
        self.base=Path(self.temp.name);self.directory=self.base/'releases'/'source'
        self.directory.mkdir(parents=True);(self.base/'.runtime').mkdir()
        (self.directory/M.FILES[0]).write_bytes((HERE/'fixture-compose.test.yml').read_bytes())
        (self.directory/M.FILES[1]).write_bytes(b'{}\n');(self.directory/M.FILES[2]).write_bytes(b'')
        (self.directory/M.FILES[2]).chmod(0o600)
        self.d=FIX['FakeDocker'](self.base,self.directory)
        self.binary=patch.object(M,'binary_hash',return_value='e'*64);self.binary.start()
        self.permissions=patch.object(a,'native_permissions',return_value=None);self.permissions.start()
        self.calls=0
        self.raw=self.observed()
        hashes=D.observation(self.raw,self.d.services,self.d.seal['files'],self.raw['actualResource'])
        self.d.seal['stabilitySha256']=a.fingerprint(hashes)
    def tearDown(self):
        self.permissions.stop();self.binary.stop();self.temp.cleanup()
    def observed(self):
        return {'snapshot':copy.deepcopy(self.d.services),
            'sourceFiles':{'configurationFiles':copy.deepcopy(self.d.seal['files']),
                'workspaceFiles':{'workspace-record.json':a.sha(b'SYNTHETIC WORKSPACE RECORD')}},
            'workspaceVolume':copy.deepcopy(self.d.source_volume),
            'actualResource':{'networks':copy.deepcopy(self.d.source_networks),'volume':copy.deepcopy(self.d.source_volume)}}
    def read_stability(self):self.calls+=1;return copy.deepcopy(self.raw)
    def measure(self,reader=None):
        with patch.dict(a.REVIEWED_GENERATORS,{('25.0.16','5.5.0'):FIX['policy']()}):
            return a.measure(self.d,self.directory,services=self.d.services,image_reference='source-api',
                image_id=FIX['IMAGE'],source_seal=self.d.seal,stability_reader=reader or self.read_stability)
    def validation_root(self,result):
        return {'producer':{},'recoveryPolicy':{},'historicalFiles':{},'anchors':{},'actual':self.d.services,
            'adminProjection':{},'configurationFiles':{},'workspaceFiles':{},'environmentFileSha256':a.sha(b''),
            'stableObservation':result['facts']['stableBefore'],'sourceArchiveBytesSha256':a.sha(b'SYNTHETIC ARCHIVE'),
            'generatorRulesSha256':a.fingerprint(FIX['policy']())}
    def test_source_absent_and_null_defaults_keep_complete_model(self):
        for key in ('command','entrypoint'):self.d.source_api[key]=None
        self.d.actual=FIX['metadata'](self.directory,self.d.source_api,self.d.source_networks,self.d.source_volume)
        self.d.services['api']=a.identity(self.d.actual)
        self.d.seal['servicesSha256']=a.fingerprint(self.d.services)
        self.raw=self.observed();self.d.seal['stabilitySha256']=a.fingerprint(D.observation(self.raw,self.d.services,self.d.seal['files'],self.raw['actualResource']))
        result=self.measure();self.assertEqual(result['facts']['source']['renderedDeclarationSha256'],a.fingerprint(self.d.source_model))
        C['validate_facts'](result['measured'],result['facts'],self.validation_root(result))
    def test_no_model_or_resource_digest_can_replace_normalized_source(self):
        result=self.measure();f=result['facts']
        self.assertNotEqual(f['source']['normalizedModelSha256'],f['source']['renderedDeclarationSha256'])
        self.assertNotEqual(f['source']['normalizedModelSha256'],f['referenceInputs']['modelCanonicalSha256'])
        self.assertNotEqual(f['source']['normalizedModelSha256'],result['measured']['referenceResourceSha256'])
    def test_full_facts_exact_constructor_validation(self):
        result=self.measure();m,f=result['measured'],result['facts']
        self.assertEqual(set(result),{'measured','facts'})
        self.assertEqual(set(f),C['FACT_KEYS']);self.assertEqual(set(m),C['MEASURED_KEYS'])
        C['validate_facts'](m,f,self.validation_root(result))
        self.assertEqual(f['source']['expectedEnvironmentSha256'],self.d.services['api']['environmentSha256'])
        self.assertEqual(f['source']['apiDeclaredHash'],a.fingerprint(self.d.source_api))
        self.assertEqual(f['source']['renderedDeclarationSha256'],a.fingerprint(self.d.source_model))
        self.assertFalse(m['authority']);self.assertFalse(m['productionEligible'])
        self.assertEqual(self.calls,3)
    def test_schema_every_node_closed(self):
        f=self.measure()['facts'];schema={node:{'fields':tuple(fields)} for node,fields in [('facts',C['FACT_KEYS']),('source',C['SOURCE_FACT_KEYS']),('generator',('engineVersion','composeVersion','rulesSha256')),('referenceInputs',C['INPUT_KEYS']),('referenceRegistry',C['REGISTRY_KEYS']),('stableObservation',('snapshotSha256','sourceFilesSha256','workspaceVolumeSha256','actualResourceSha256')),('container',C['CONTAINER_KEYS']),('volume',C['VOLUME_KEYS']),('network',C['NETWORK_KEYS'])]}
        for node,key in [('facts',None),('source','source'),('generator','generator'),('referenceInputs','referenceInputs'),
            ('referenceRegistry','referenceRegistry'),('stableObservation','stableBefore')]:
            self.assertEqual(set(f if key is None else f[key]),set(schema[node]['fields']))
        for node,row in [('container',f['referenceRegistry']['container']),('volume',f['referenceRegistry']['volume'])]:
            self.assertEqual(set(row),set(schema[node]['fields']))
        for row in f['referenceRegistry']['networks'].values():self.assertEqual(set(row),set(schema['network']['fields']))
    def test_two_owners_same_source_digest_different_measurement(self):
        first=self.measure();self.calls=0;second=self.measure()
        self.assertEqual(first['facts']['source'],second['facts']['source'])
        self.assertEqual(first['facts']['stableBefore'],second['facts']['stableBefore'])
        for path in [('referenceRegistry','container','owner'),('referenceRegistry','container','id')]:
            def get(result):
                v=result['facts']
                for k in path:v=v[k]
                return v
            self.assertNotEqual(get(first),get(second))
        self.assertNotEqual(first['measured']['referenceModelSha256'],second['measured']['referenceModelSha256'])
        self.assertNotEqual(first['facts']['source']['normalizedModelSha256'],first['measured']['referenceModelSha256'])
    def test_registry_real_mock_read_creation_and_precleanup_equal(self):
        f=self.measure()['facts'];r=f['referenceRegistry']
        for row in [r['container'],r['volume'],*r['networks'].values()]:
            self.assertEqual(row['creationMetadataSha256'],row['preCleanupMetadataSha256'])
        self.assertEqual(r['container']['stateAtCreate'],r['container']['stateBeforeCleanup'])
        self.assertEqual(len({v['id'] for v in r['networks'].values()}),4)
        self.assertEqual(len(self.d.removed),6)
    def test_private_inputs_and_empty_bytes_derived(self):
        f=self.measure()['facts'];i=f['referenceInputs']
        self.assertEqual(i['beforeFileSealsSha256'],i['afterFileSealsSha256'])
        self.assertEqual(i['emptyEnvironmentBytesSha256'],a.sha(b''))
        self.assertEqual(i['emptyDockerConfigBytesSha256'],a.sha(b'{}\n'))
        self.assertEqual(i['surrogateEnvironmentSha256'],f['source']['referenceEnvironmentSha256'])
        self.assertEqual(list((self.base/'.runtime/online-recharge-declaration-measurement').iterdir()),[])
    def test_no_raw_env_or_inspect_leaks(self):
        raw=json.dumps(self.measure())
        for value in [FIX['PRIVATE'],'CONTROL_SOURCE_','KEY0=','"Config"','"HostConfig"','"Mountpoint"','"State"']:
            self.assertNotIn(value,raw)
    def test_no_registry_unknown_generator_no_mutation(self):
        self.assertEqual(a.REVIEWED_GENERATORS,{})
        with self.assertRaisesRegex(a.Rejected,'SOURCE_NOT_MEASURED'):
            a.measure(self.d,self.directory,services=self.d.services,image_reference='source-api',image_id=FIX['IMAGE'],
                source_seal=self.d.seal,stability_reader=self.read_stability)
        self.assertFalse(any('create' in cmd for cmd,_ in self.d.calls))
    def test_engine25_unknown_no_ipv4_fallback(self):
        old=self.d.run
        def run(*args,**kw):
            text=old(*args,**kw)
            if 'info' in args:
                v=json.loads(text);v['serverVersion']='25.0.0';return json.dumps(v)
            if 'version' in args and '--format' in args:
                v=json.loads(text);v['Server']['Version']='25.0.0';return json.dumps(v)
            return text
        self.d.run=run
        with self.assertRaises(a.Rejected):self.measure()
        self.assertFalse(any('create' in cmd for cmd,_ in self.d.calls))
    def test_workspace_claim_or_boolean_not_raw_read_refused(self):
        for value in [{'trusted':True},{'name':self.d.source_volume['Name'],'status':'PRESENT','identitySha256':'9'*64},True]:
            self.raw['workspaceVolume']=value
            with self.assertRaises(a.Rejected):self.measure()
    def test_existing_workspace_projection_matches_source_contract(self):
        result=self.measure();v=self.d.source_volume
        identity={n:v.get(n) for n in ('Name','Driver','Scope','Mountpoint','Labels','CreatedAt','Options')}
        summary={'name':v['Name'],'status':'PRESENT','identitySha256':a.fingerprint(identity)}
        self.assertEqual(result['facts']['stableBefore']['workspaceVolumeSha256'],a.fingerprint(summary))
    def test_hash_only_observation_rejected(self):
        with self.assertRaises(a.Rejected):self.measure(lambda:{k:'a'*64 for k in C['F']['stableObservation']})
    def test_observation_shadowfield_rejected(self):
        self.raw['trusted']=True
        with self.assertRaises(a.Rejected):self.measure()
    def test_actual_resource_mismatch_rejected(self):
        self.raw['actualResource']['volume']['CreatedAt']='SYNTHETIC CHANGE'
        with self.assertRaises(a.Rejected):self.measure()
    def test_snapshot_mismatch_rejected(self):
        self.raw['snapshot']['api']['containerId']='9'*64
        with self.assertRaises(a.Rejected):self.measure()
    def test_config_file_mismatch_rejected(self):
        self.raw['sourceFiles']['configurationFiles'][M.FILES[0]]='9'*64
        with self.assertRaises(a.Rejected):self.measure()
    def test_post_cleanup_observation_drift_rejected(self):
        def reader():
            self.calls+=1;r=copy.deepcopy(self.raw)
            if self.calls==3:r['sourceFiles']['workspaceFiles']['workspace-record.json']='9'*64
            return r
        with self.assertRaisesRegex(a.Rejected,'ORIGIN_CHANGED'):self.measure(reader)
        self.assertEqual(len(self.d.removed),6)
    def test_late_container_drift_rejected_before_cleanup(self):
        self.d.fail='reference_started'
        with self.assertRaises(a.Rejected):self.measure()
    def test_reference_unknown_configuration_not_ignored(self):
        self.d.fail='reference_cmd'
        with self.assertRaises(a.Rejected):self.measure()
    def test_registry_bad_owner_and_mutated_metadata_rejected(self):
        owner='1'*32;project='online-recharge-reference-'+owner
        row=FIX['volume'](project,owner)
        for mutate in [lambda v:v.update({'CreatedAt':'changed'}),lambda v:v['Labels'].update({a.OWNER_KEY:'2'*32})]:
            current=copy.deepcopy(row);mutate(current)
            with self.assertRaises(D.FactsRejected):D.resource_record('volume',row,current,owner)
    def test_registry_running_reference_rejected(self):
        owner='1'*32;project='online-recharge-reference-'+owner;nets={r:FIX['network'](r,i,project,owner) for i,r in enumerate(a.NETWORK_ROLES,1)}
        row=FIX['metadata'](self.directory,FIX['api'](self.directory),nets,FIX['volume'](project,owner),project,owner)
        row['State']['Running']=True
        with self.assertRaises(D.FactsRejected):D.resource_record('container',row,copy.deepcopy(row),owner)
    def test_normalized_complete_unknown_field_changes_digest(self):
        env=a.expected_env(self.d.source_api,FIX['image']());default=a.env_map(FIX['image']()['Config']['Env'])
        def normalize(model):return D.normalize_source_intent(model,str(self.directory),FIX['PROJECT'],env,default)
        original=normalize(self.d.source_model)
        for mutate in [lambda m:m['services']['mysql'].update({'unrecognizedField':{'some':True}}),
            lambda m:m['services']['api']['healthcheck'].update({'retries':6}),
            lambda m:m['networks']['default'].update({'internal':True}),lambda m:m.update({'unknownTop':[1,2]})]:
            model=copy.deepcopy(self.d.source_model);mutate(model)
            self.assertNotEqual(D.digest(original),D.digest(normalize(model)))
    def test_source_role_paths_not_reference_identity(self):
        env=a.expected_env(self.d.source_api,FIX['image']());default=a.env_map(FIX['image']()['Config']['Env'])
        n=D.normalize_source_intent(self.d.source_model,str(self.directory),FIX['PROJECT'],env,default)
        text=json.dumps(n);self.assertNotIn(str(self.directory),text);self.assertNotIn(FIX['PROJECT'],text)
        self.assertIn('SOURCE_DIRECTORY',text);self.assertIn(a.TARGET,text)
        bad=copy.deepcopy(self.d.source_model);bad['unknownPath']=str(self.directory)+'/unlisted'
        with self.assertRaises(D.FactsRejected):D.normalize_source_intent(bad,str(self.directory),FIX['PROJECT'],env,default)
    def test_full_default_env_and_source_union_sensitive_to_change(self):
        env=a.expected_env(self.d.source_api,FIX['image']());default=a.env_map(FIX['image']()['Config']['Env'])
        one=D.normalize_source_intent(self.d.source_model,str(self.directory),FIX['PROJECT'],env,default)
        default['KEY0']='CHANGED'
        two=D.normalize_source_intent(self.d.source_model,str(self.directory),FIX['PROJECT'],env,default)
        self.assertNotEqual(D.digest(one),D.digest(two))
        image=copy.deepcopy(FIX['image']());image['Config']['Env'].append('KEY=duplicate')
        with self.assertRaises(a.Rejected):a.expected_env(self.d.source_api,image)
    def test_nonfinite_oversize_depth_subclass_reject(self):
        class Bad(dict):pass
        for v in [Bad({'a':1}),{'a':math.nan},{'a':'X'*(D.MAX_RAW+1)}]:
            with self.assertRaises(D.FactsRejected):D.digest(v)
        nested={};v=nested
        for _ in range(66):v['x']={};v=v['x']
        with self.assertRaises(D.FactsRejected):D.digest(nested)
    def test_constructor_rejects_mutated_derived_facts(self):
        r=self.measure();root=self.validation_root(r)
        for mutate in [lambda f:f['source'].update({'normalizedModelSha256':r['measured']['referenceModelSha256']}),
            lambda f:f['generator'].update({'rulesSha256':'9'*64}),
            lambda f:f['stableAfter'].update({'workspaceVolumeSha256':'9'*64}),
            lambda f:f['referenceInputs'].update({'afterFileSealsSha256':'9'*64}),
            lambda f:f['referenceRegistry']['volume'].update({'owner':'9'*32})]:
            f=copy.deepcopy(r['facts']);mutate(f)
            with self.assertRaises(RuntimeError):C['validate_facts'](r['measured'],f,root)

    def test_explicit_ipv4_creation_flags_and_fresh_counts(self):
        result=self.measure()
        calls=[v[0] if isinstance(v,tuple) and len(v)==2 else v for v in self.d.calls]
        creates=[list(v) for v in calls if len(v)>2 and list(v)[1:3]==['network','create']]
        self.assertEqual(len(creates),4)
        for args in creates:
            self.assertIn('--internal',args)
            for forbidden in ('--ipv4=false','--ipv6=true','--subnet','--gateway','--ip-range','--aux-address','--opt'):
                self.assertNotIn(forbidden,args)
        self.assertEqual(len(result['facts']['referenceRegistry']['networks']),4)
        self.assertFalse(result['measured']['authority']);self.assertFalse(result['measured']['productionEligible'])
    def test_old_ipv6_contract_cannot_qualify_successor(self):
        policy=FIX['policy']();policy['referenceNetworkPolicy']='OWNED_IPV6_ULA_V1'
        with patch.dict(a.REVIEWED_GENERATORS,{('25.0.16','5.5.0'):policy}):
            with self.assertRaises(a.Rejected):a.measure(self.d,self.directory,services=self.d.services,image_reference='source-api',image_id=FIX['IMAGE'],source_seal=self.d.seal,stability_reader=self.read_stability)
        self.assertFalse(self.d.created_networks);self.assertFalse(self.d.removed)
    def mutate_created_network(self,mutation):
        real=FIX['network']
        def changed(role,index,project=FIX['PROJECT'],owner=None):
            row=real(role,index,project,owner)
            if owner is not None:mutation(row,index)
            return row
        with patch.dict(FIX['FakeDocker'].run.__globals__,{'network':changed}):
            with self.assertRaises(a.Rejected):self.measure()
        self.assertFalse(self.d.created_networks)
        self.assertIsNone(self.d.created_container);self.assertIsNone(self.d.created_volume)
    def test_reference_overlap_with_actual_source_refused_and_cleaned(self):
        def mutation(row,index):row['IPAM']['Config']=[{'Subnet':'10.64.1.0/24','Gateway':'10.64.1.1'}]
        self.mutate_created_network(mutation)
        self.assertEqual(len(self.d.removed),4)
    def test_reference_ipv6_refused_and_cleaned(self):
        def mutation(row,index):row.update(EnableIPv6=True);row['IPAM']['Config']=[{'Subnet':'fd00:1::/64','Gateway':'fd00:1::1'}]
        self.mutate_created_network(mutation)
        self.assertEqual(len(self.d.removed),1)
    def test_reference_outside_reviewed_pool_refused_and_cleaned(self):
        def mutation(row,index):row['IPAM']['Config']=[{'Subnet':'10.65.1.0/24','Gateway':'10.65.1.1'}]
        self.mutate_created_network(mutation)
        self.assertEqual(len(self.d.removed),1)
    def test_reference_gateway_not_first_refused_and_cleaned(self):
        def mutation(row,index):row['IPAM']['Config'][0]['Gateway']='10.64.'+str(index+100)+'.2'
        self.mutate_created_network(mutation)
        self.assertEqual(len(self.d.removed),1)
    def test_pool_source_absent_cannot_authorize_create(self):
        policy=FIX['policy']();policy['defaultPools']=[]
        with patch.dict(a.REVIEWED_GENERATORS,{('25.0.16','5.5.0'):policy}):
            with self.assertRaises(a.Rejected):a.measure(self.d,self.directory,services=self.d.services,image_reference='source-api',image_id=FIX['IMAGE'],source_seal=self.d.seal,stability_reader=self.read_stability)
        self.assertFalse(self.d.created_networks);self.assertFalse(self.d.removed)
    def test_reference_ipv4_field_on_wrong_api_refused_and_cleaned(self):
        def mutation(row,index):row['EnableIPv4']=True
        self.mutate_created_network(mutation)
        self.assertEqual(len(self.d.removed),1)
    def test_reference_internal_false_refused_and_cleaned(self):
        def mutation(row,index):row['Internal']=False
        self.mutate_created_network(mutation)
        self.assertEqual(len(self.d.removed),1)

if __name__=='__main__':unittest.main(verbosity=2)
