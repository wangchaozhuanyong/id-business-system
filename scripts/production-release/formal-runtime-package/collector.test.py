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
        self.which=patch.object(M.shutil,'which',return_value=FIX['policy']()['dockerPath']);self.which.start();self.addCleanup(self.which.stop)
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
    def empty_network_source(self,rows):
        self.d.source_api['networks']=copy.deepcopy(rows)
        self.d.actual=FIX['metadata'](self.directory,self.d.source_api,self.d.source_networks,self.d.source_volume)
        self.d.services['api']=a.identity(self.d.actual)
        self.d.seal['servicesSha256']=a.fingerprint(self.d.services)
        self.raw=self.observed();self.d.seal['stabilitySha256']=a.fingerprint(D.observation(
            self.raw,self.d.services,self.d.seal['files'],self.raw['actualResource']))
    def test_attribute_free_null_and_empty_networks_preserve_complete_source_hashes(self):
        hashes=[]
        for rows in ({r:None for r in a.NETWORK_ROLES},{r:{} for r in a.NETWORK_ROLES},
                     {r:None if r=='default' else {} for r in a.NETWORK_ROLES}):
            with self.subTest(rows=rows):
                self.empty_network_source(rows);original=copy.deepcopy(self.d.source_model)
                result=self.measure();facts=result['facts']
                self.assertEqual(self.d.source_model,original)
                self.assertEqual(facts['source']['renderedDeclarationSha256'],a.fingerprint(original))
                self.assertEqual(facts['source']['apiDeclaredHash'],a.fingerprint(self.d.source_api))
                C['validate_facts'](result['measured'],facts,self.validation_root(result))
                hashes.append((facts['source']['renderedDeclarationSha256'],facts['source']['normalizedModelSha256']))
                self.assertFalse(result['measured']['authority']);self.assertFalse(result['measured']['productionEligible'])
        self.assertEqual(len({raw for raw,_ in hashes}),3)
        self.assertEqual(len({normalized for _,normalized in hashes}),3)
    def test_service_network_attributes_and_nonobjects_remain_refused(self):
        class EmptyDict(dict):pass
        for value in ({'priority':0},{'aliases':[]},{'ipv4_address':''},{'CONTROL_UNKNOWN':None},
                      [],False,'',0,EmptyDict()):
            with self.subTest(value=value):
                api=copy.deepcopy(self.d.source_api);api['networks']['default']=value
                with self.assertRaisesRegex(a.Rejected,'^SOURCE_DECLARATION_INVALID$'):
                    a.source_api_validate(api,self.directory,FIX['policy']())
        self.assertFalse(self.d.created_networks)
    def test_service_network_missing_or_unknown_role_remains_refused(self):
        for unknown in (False,True):
            api=copy.deepcopy(self.d.source_api);api['networks'].pop('default')
            if unknown:api['networks']['CONTROL_UNKNOWN']=None
            with self.assertRaisesRegex(a.Rejected,'^SOURCE_DECLARATION_INVALID$'):
                a.source_api_validate(api,self.directory,FIX['policy']())
    def test_source_network_empty_ipam_uses_reviewed_shape_and_preserves_full_model(self):
        spec=FIX['policy']();spec['renderedExternalNetworkExtra']={'ipam':{}}
        for present in (False,True):
            for row in self.d.source_model['networks'].values():
                row.pop('ipam',None)
                if present:row['ipam']={}
            original=copy.deepcopy(self.d.source_model)
            _,_,model=a.prepare_source(self.d,self.directory,self.d.services,'source-api',FIX['IMAGE'],self.d.seal,spec)
            self.assertEqual(model,original);self.assertEqual(self.d.source_model,original)
        self.assertFalse(self.d.created_networks)
    def test_actual_null_networks_and_empty_ipam_complete_measurement_and_cleanup(self):
        spec=FIX['policy']();spec['renderedExternalNetworkExtra']={'ipam':{}}
        self.d.source_api.update({'command':None,'entrypoint':None})
        self.empty_network_source({r:None for r in a.NETWORK_ROLES})
        for row in self.d.source_model['networks'].values():row['ipam']={}
        original=copy.deepcopy(self.d.source_model);original_run=self.d.run
        def official_shape(*args,**kwargs):
            raw=original_run(*args,**kwargs)
            if args[0]==spec['composePath'] and 'config' in args and '--format' in args:
                model=json.loads(raw)
                for row in model['networks'].values():row['ipam']={}
                return json.dumps(model)
            return raw
        self.d.run=official_shape
        with patch.dict(a.REVIEWED_GENERATORS,{('25.0.16','5.5.0'):spec}):
            result=a.measure(self.d,self.directory,services=self.d.services,image_reference='source-api',
                image_id=FIX['IMAGE'],source_seal=self.d.seal,stability_reader=self.read_stability)
        self.assertEqual(self.calls,3);self.assertEqual(len(self.d.removed),6)
        self.assertEqual(self.d.created_networks,{})
        self.assertIsNone(self.d.created_container);self.assertIsNone(self.d.created_volume)
        self.assertEqual(self.d.source_model,original)
        self.assertEqual(result['facts']['source']['renderedDeclarationSha256'],a.fingerprint(original))
        self.assertTrue(all(row is None for row in self.d.source_api['networks'].values()))
        root=self.validation_root(result);root['generatorRulesSha256']=a.fingerprint(spec)
        C['validate_facts'](result['measured'],result['facts'],root)
        self.assertFalse(result['measured']['authority']);self.assertFalse(result['measured']['productionEligible'])
    def test_source_network_ipam_unknown_fields_name_and_internal_still_refused(self):
        spec=FIX['policy']();spec['renderedExternalNetworkExtra']={'ipam':{}}
        original=copy.deepcopy(self.d.source_model['networks'])
        mutations=({'ipam':{'config':[]}},{'ipam':None},{'ipam':[]},{'CONTROL_UNKNOWN':False},
                   {'name':'CONTROL_OTHER_NETWORK'},{'internal':True})
        for update in mutations:
            with self.subTest(update=update):
                self.d.source_model['networks']=copy.deepcopy(original)
                self.d.source_model['networks']['default'].update(update)
                with self.assertRaisesRegex(a.Rejected,'^SOURCE_NETWORK_DECLARATION$'):
                    a.prepare_source(self.d,self.directory,self.d.services,'source-api',FIX['IMAGE'],self.d.seal,spec)
        self.assertFalse(self.d.created_networks)
    def test_reference_empty_network_representation_or_attribute_drift_is_not_normalized(self):
        self.empty_network_source({r:None for r in a.NETWORK_ROLES});original_run=self.d.run
        for value in ({},{'priority':0},{'aliases':[]},{'ipv4_address':''}):
            def altered(*args,**kwargs):
                raw=original_run(*args,**kwargs)
                if args[0]==FIX['policy']()['composePath'] and 'config' in args and '--format' in args:
                    model=json.loads(raw);model['services']['api']['networks']['default']=value
                    return json.dumps(model)
                return raw
            self.d.run=altered
            with self.subTest(value=value),self.assertRaisesRegex(a.Rejected,'^REFERENCE_MODEL_CHANGED$'):
                self.measure()
            self.assertFalse(self.d.created_networks);self.assertIsNone(self.d.created_container)
        self.d.run=original_run
    def test_api144_alias_projection_exact_order_dedup_and_hostname(self):
        spec=FIX['policy']();meta=copy.deepcopy(self.d.actual);name=meta['Name'].lstrip('/');cid=meta['Id'][:12]
        for hostname,expected in ((cid,[name,'api',cid]),('CONTROL_HOST',[name,'api',cid,'CONTROL_HOST']),
                                  ('api',[name,'api',cid]),(name,[name,'api',cid]),('',[name,'api',cid,''])):
            meta['Config']['Hostname']=hostname;original=copy.deepcopy(meta)
            with self.subTest(hostname=hostname):
                self.assertEqual(a.endpoint_aliases(meta,spec),expected);self.assertEqual(meta,original)
        pack,_,_=a.prepare_source(self.d,self.directory,self.d.services,'source-api',FIX['IMAGE'],self.d.seal,spec)
        changed=copy.deepcopy(pack);changed['metadata']['Config']['Hostname']='CONTROL_HOST'
        for reference in (False,True):
            with self.subTest(reference=reference),self.assertRaisesRegex(a.Rejected,'^PACK_IMAGE_OR_NATIVE_IDENTITY$'):
                a.bind_pack(changed,spec,reference=reference,source=pack)
        spec['engineApiVersion']='1.45'
        self.assertEqual(a.endpoint_aliases(meta,spec),[name,'api'])
    def test_api144_actual_aliases_reject_order_duplicates_missing_wrong_id_and_legacy(self):
        spec=FIX['policy']();meta=json.loads(self.d.run(spec['dockerPath'],'container','inspect',FIX['API_ID']))[0]
        expected=a.endpoint_aliases(meta,spec);a.actual_endpoints(meta,self.d.source_networks,self.d.services,spec)
        bad=(expected[:2],list(reversed(expected)),expected+[expected[-1]],expected+['CONTROL_EXTRA'],
             [expected[0],expected[1],'9'*12],[expected[0],expected[2],expected[1]],
             [expected[0],'OTHER_SERVICE',expected[2]],['9'*12+'_'+expected[0],*expected[1:]])
        for role in a.NETWORK_ROLES:
            for aliases in bad:
                changed=copy.deepcopy(meta);changed['NetworkSettings']['Networks'][self.d.source_networks[role]['Name']]['Aliases']=aliases
                with self.subTest(role=role,aliases=aliases),self.assertRaisesRegex(a.Rejected,'^ACTUAL_NETWORK_DECLARATION$'):
                    a.actual_endpoints(changed,self.d.source_networks,self.d.services,spec)
        for field,value in (('DNSNames',list(reversed(expected))),('IPAMConfig',{}),('DriverOpts',{}),('Links',[])):
            changed=copy.deepcopy(meta);next(iter(changed['NetworkSettings']['Networks'].values()))[field]=value
            with self.subTest(field=field),self.assertRaisesRegex(a.Rejected,'^ACTUAL_NETWORK_DECLARATION$'):
                a.actual_endpoints(changed,self.d.source_networks,self.d.services,spec)
    def test_api144_stopped_reference_aliases_reject_legacy_order_duplicate_and_extra(self):
        original_run=self.d.run;mutations=('legacy','order','duplicate','wrong_id','extra')
        for mutation in mutations:
            projected=False;before_removed=len(self.d.removed)
            def run(*args,**kwargs):
                nonlocal projected
                raw=original_run(*args,**kwargs)
                if args[0] in ('docker',FIX['policy']()['dockerPath']) and args[1:3]==('container','inspect') and args[3]!=FIX['API_ID']:
                    rows=json.loads(raw);row=rows[0];projected=True
                    self.assertFalse(row['State']['Running']);self.assertEqual(row['State']['Status'],'created')
                    for endpoint in row['NetworkSettings']['Networks'].values():
                        self.assertIsNone(endpoint['DNSNames']);aliases=endpoint['Aliases']
                        self.assertEqual(aliases,a.endpoint_aliases(row,FIX['policy']()))
                        endpoint['Aliases']=(aliases[:2] if mutation=='legacy' else list(reversed(aliases)) if mutation=='order'
                            else aliases+[aliases[-1]] if mutation=='duplicate' else [aliases[0],aliases[1],'9'*12]
                            if mutation=='wrong_id' else aliases+['CONTROL_EXTRA'])
                    return json.dumps(rows)
                return raw
            self.d.run=run
            with self.subTest(mutation=mutation),self.assertRaisesRegex(a.Rejected,'^REFERENCE_PENDING_ENDPOINT$'):
                self.measure()
            self.assertTrue(projected);self.assertEqual(len(self.d.removed)-before_removed,6)
            self.assertFalse(self.d.created_networks);self.assertIsNone(self.d.created_volume);self.assertIsNone(self.d.created_container)
        self.d.run=original_run
    def test_api144_fake_inspect_projects_only_independent_returned_copy(self):
        original=copy.deepcopy(self.d.actual);spec=FIX['policy']()
        inspected=json.loads(self.d.run(spec['dockerPath'],'container','inspect',FIX['API_ID']))[0]
        self.assertEqual(self.d.actual,original);self.assertNotEqual(inspected,original)
        for name,row in inspected['NetworkSettings']['Networks'].items():
            self.assertEqual(row['Aliases'],a.endpoint_aliases(inspected,spec))
            self.assertEqual(original['NetworkSettings']['Networks'][name]['Aliases'],[original['Name'].lstrip('/'),'api'])
            self.assertEqual(row['DNSNames'],a.endpoint_dns_names(inspected,row['Aliases']))
            row['Aliases'].append('CONTROL_RETURNED_COPY_CHANGE')
        again=json.loads(self.d.run(spec['dockerPath'],'container','inspect',FIX['API_ID']))[0]
        self.assertEqual(self.d.actual,original)
        self.assertTrue(all(row['Aliases']==a.endpoint_aliases(again,spec) for row in again['NetworkSettings']['Networks'].values()))
    def test_api144_complete_measurement_keeps_original_source_resources_and_dns(self):
        stored=copy.deepcopy(self.d.actual);model=copy.deepcopy(self.d.source_model);resources=copy.deepcopy(self.raw['actualResource'])
        original_run=self.d.run;observed_actual=[];observed_reference=[]
        def run(*args,**kwargs):
            raw=original_run(*args,**kwargs)
            if args[0] in ('docker',FIX['policy']()['dockerPath']) and args[1:3]==('container','inspect'):
                row=json.loads(raw)[0];reference=args[3]!=FIX['API_ID']
                (observed_reference if reference else observed_actual).append(copy.deepcopy(row))
                for endpoint in row['NetworkSettings']['Networks'].values():
                    self.assertEqual(endpoint['Aliases'],a.endpoint_aliases(row,FIX['policy']()))
                    if reference:self.assertIsNone(endpoint['DNSNames'])
                    else:self.assertEqual(endpoint['DNSNames'],a.endpoint_dns_names(row,endpoint['Aliases']))
            return raw
        self.d.run=run;result=self.measure()
        self.assertTrue(observed_actual);self.assertTrue(observed_reference)
        self.assertTrue(all(not row['State']['Running'] for row in observed_reference))
        self.assertEqual(self.calls,3);self.assertEqual(len(self.d.removed),6)
        self.assertEqual(self.d.actual,stored);self.assertEqual(self.d.source_model,model)
        self.assertEqual(self.observed()['actualResource'],resources)
        self.assertEqual(result['facts']['source']['renderedDeclarationSha256'],a.fingerprint(model))
        self.assertEqual(result['measured']['actualResourceSha256'],a.fingerprint(resources))
        self.assertEqual(result['facts']['stableBefore'],result['facts']['stableAfter'])
        C['validate_facts'](result['measured'],result['facts'],self.validation_root(result))
        self.assertFalse(result['measured']['authority']);self.assertFalse(result['measured']['productionEligible'])
        self.assertFalse(self.d.created_networks);self.assertIsNone(self.d.created_volume);self.assertIsNone(self.d.created_container)
    def test_api144_source_alias_drift_still_fails_original_full_snapshot_guard(self):
        original_run=self.d.run;changed=False
        def run(*args,**kwargs):
            nonlocal changed
            raw=original_run(*args,**kwargs)
            if not changed and args[:3]==(FIX['policy']()['dockerPath'],'network','create'):
                changed=True;next(iter(self.d.actual['NetworkSettings']['Networks'].values()))['Aliases'].append('CONTROL_SOURCE_DRIFT')
            return raw
        self.d.run=run
        with self.assertRaisesRegex(a.Rejected,'^ACTUAL_INSPECT_CHANGED$'):self.measure()
        self.assertTrue(changed);self.assertFalse(self.d.created_networks)
        self.assertIsNone(self.d.created_volume);self.assertIsNone(self.d.created_container)
    def test_managed_resource_hash_matches_independent_go_golden_preimages(self):
        spec=FIX['policy']();spec['renderedExternalNetworkExtra']={'ipam':{}}
        goldens={
            'default':'f15736d8669582e860d4b1b3f840fee87d26e9c1a39dc19c05c407f2eb013550',
            'media-egress':'5e5f2edd57113e55960c687830f5c567e4c924b4b82393abee5c880380aecb2f',
            'recharge-control':'384ff6825ef9654a6b41079119bc4d212fd0b42b7b3e53028609e0a884053678',
            'registration-control':'f71d7517522d9336e10cd7a2e3736a9ce0df96f1e9d1dd285dc3bd8854311f0f'}
        original_sha=a.sha;preimages=[]
        def capture(raw):preimages.append(raw);return original_sha(raw)
        for role,golden in goldens.items():
            declaration={'name':'source_'+role,**({'internal':True} if role.endswith('control') else {})}
            before=copy.deepcopy(declaration)
            with patch.object(a,'sha',side_effect=capture):
                self.assertEqual(a.managed_network_hash(declaration,role,'source',spec),golden)
                self.assertEqual(a.managed_network_hash({**declaration,'ipam':{}},role,'source',spec),golden)
            expected=('{{"name":"source_{}","ipam":{{}}{}}}'.format(
                role,',"internal":true' if role.endswith('control') else '')).encode('ascii')
            self.assertEqual(preimages[-2:],[expected,expected]);self.assertEqual(declaration,before)
        declaration={'name':'source_'+a.VOLUME_KEY}
        with patch.object(a,'sha',side_effect=capture):
            self.assertEqual(a.managed_volume_hash(declaration,'source'),
                '930228f5fe9d211c215db22a86fe1687e9b5d4292be276a0fb5a338714f7c9d8')
        self.assertEqual(preimages[-1],b'{"name":"source_auto_registration_data","driver":"local"}')
        self.assertNotEqual(original_sha(preimages[-1]),a.fingerprint({'name':declaration['name'],'driver':'local'}))
    def test_managed_resource_hash_requires_exact_original_declarations(self):
        spec=FIX['policy']();spec['renderedExternalNetworkExtra']={'ipam':{}}
        class Row(dict):pass
        class Name(str):pass
        for role in a.NETWORK_ROLES:
            original={'name':FIX['PROJECT']+'_'+role,**({'internal':True} if role.endswith('control') else {})}
            bad=[None,[],Row(original),{**original,'name':Name(original['name'])},
                 {**original,'name':'OTHER_'+role},{**original,'ipam':{'config':[]}},
                 {**original,'ipam':None},{**original,'ipam':Row()},
                 {**original,'driver':'bridge'},{**original,'external':False},
                 {**original,'aliases':[]},{**original,'UNKNOWN':{}},
                 {**original,'internal':1 if role.endswith('control') else False}]
            for row in bad:
                with self.subTest(role=role,row=row),self.assertRaisesRegex(a.Rejected,'^SOURCE_NETWORK_DECLARATION$'):
                    a.managed_network_hash(row,role,FIX['PROJECT'],spec)
            for project,wrong_role in ((Name(FIX['PROJECT']),role),('../source',role),(FIX['PROJECT'],'UNKNOWN')):
                with self.assertRaisesRegex(a.Rejected,'^SOURCE_NETWORK_DECLARATION$'):
                    a.managed_network_hash(original,wrong_role,project,spec)
        volume={'name':FIX['PROJECT']+'_'+a.VOLUME_KEY}
        for row in (None,[],Row(volume),{**volume,'name':Name(volume['name'])},
                    {'name':'OTHER_'+a.VOLUME_KEY},{**volume,'driver':'local'},
                    {**volume,'external':False},{**volume,'UNKNOWN':{}}):
            with self.subTest(row=row),self.assertRaisesRegex(a.Rejected,'^SOURCE_VOLUME_DECLARATION$'):
                a.managed_volume_hash(row,FIX['PROJECT'])
    def test_managed_network_four_labels_require_exact_hash_and_owner(self):
        spec=FIX['policy']()
        for role in a.NETWORK_ROLES:
            declaration=self.d.source_model['networks'][role];net=copy.deepcopy(self.d.source_networks[role])
            a.network_validate(net,role,FIX['PROJECT'],spec,declaration=declaration) # exact legacy three
            net['Labels']['com.docker.compose.config-hash']=a.managed_network_hash(declaration,role,FIX['PROJECT'],spec)
            original=copy.deepcopy(net)
            a.network_validate(net,role,FIX['PROJECT'],spec,declaration=declaration)
            self.assertEqual(net,original)
            for key,value in (('com.docker.compose.config-hash','0'*64),('com.docker.compose.config-hash',None),
                              ('com.docker.compose.project','OTHER'),('com.docker.compose.network','OTHER'),
                              ('com.docker.compose.version','OTHER'),('UNKNOWN','CONTROL'),(a.OWNER_KEY,'CONTROL')):
                bad=copy.deepcopy(original);bad['Labels'][key]=value
                with self.subTest(role=role,key=key),self.assertRaisesRegex(a.Rejected,'^RESOURCE_OWNER_OR_MEMBERS_INVALID$'):
                    a.network_validate(bad,role,FIX['PROJECT'],spec,declaration=declaration)
            for key in ('com.docker.compose.project','com.docker.compose.network','com.docker.compose.version'):
                bad=copy.deepcopy(original);del bad['Labels'][key]
                with self.assertRaisesRegex(a.Rejected,'^RESOURCE_OWNER_OR_MEMBERS_INVALID$'):
                    a.network_validate(bad,role,FIX['PROJECT'],spec,declaration=declaration)
            with self.assertRaisesRegex(a.Rejected,'^RESOURCE_OWNER_OR_MEMBERS_INVALID$'):
                a.network_validate(net,role,FIX['PROJECT'],spec) # no declaration cannot authorize fourth label
    def test_managed_volume_four_labels_require_exact_hash_and_owner(self):
        spec=FIX['policy']();declaration=self.d.source_model['volumes'][a.VOLUME_KEY]
        vol=copy.deepcopy(self.d.source_volume)
        a.volume_validate(vol,FIX['PROJECT'],spec,declaration=declaration)
        vol['Labels']['com.docker.compose.config-hash']=a.managed_volume_hash(declaration,FIX['PROJECT'])
        original=copy.deepcopy(vol);a.volume_validate(vol,FIX['PROJECT'],spec,declaration=declaration)
        self.assertEqual(vol,original)
        for key,value in (('com.docker.compose.config-hash','0'*64),('com.docker.compose.config-hash',''),
                          ('com.docker.compose.project','OTHER'),('com.docker.compose.volume','OTHER'),
                          ('com.docker.compose.version','OTHER'),('UNKNOWN','CONTROL'),(a.OWNER_KEY,'CONTROL')):
            bad=copy.deepcopy(original);bad['Labels'][key]=value
            with self.subTest(key=key),self.assertRaisesRegex(a.Rejected,'^RESOURCE_OWNER_OR_MEMBERS_INVALID$'):
                a.volume_validate(bad,FIX['PROJECT'],spec,declaration=declaration)
        for key in ('com.docker.compose.project','com.docker.compose.volume','com.docker.compose.version'):
            bad=copy.deepcopy(original);del bad['Labels'][key]
            with self.assertRaisesRegex(a.Rejected,'^RESOURCE_OWNER_OR_MEMBERS_INVALID$'):
                a.volume_validate(bad,FIX['PROJECT'],spec,declaration=declaration)
        with self.assertRaisesRegex(a.Rejected,'^RESOURCE_OWNER_OR_MEMBERS_INVALID$'):
            a.volume_validate(vol,FIX['PROJECT'],spec)
    def test_managed_hash_does_not_relax_source_members_or_reference_owner(self):
        spec=FIX['policy']();owner='1'*32
        for role in a.NETWORK_ROLES:
            net=copy.deepcopy(self.d.source_networks[role]);declaration=self.d.source_model['networks'][role]
            net['Labels']['com.docker.compose.config-hash']=a.managed_network_hash(declaration,role,FIX['PROJECT'],spec)
            net['Containers']=[]
            with self.assertRaisesRegex(a.Rejected,'^RESOURCE_OWNER_OR_MEMBERS_INVALID$'):
                a.network_validate(net,role,FIX['PROJECT'],spec,declaration=declaration)
            reference=FIX['network'](role,1,owner=owner)
            a.network_validate(reference,role,FIX['PROJECT'],spec,reference=True,owner=owner)
            for labels,members in (({a.OWNER_KEY:'OTHER'},{}),({**reference['Labels'],'com.docker.compose.config-hash':'0'*64},{}),
                                   (reference['Labels'],{'9'*64:{}})):
                bad=copy.deepcopy(reference);bad.update({'Labels':labels,'Containers':members})
                with self.assertRaisesRegex(a.Rejected,'^RESOURCE_OWNER_OR_MEMBERS_INVALID$'):
                    a.network_validate(bad,role,FIX['PROJECT'],spec,reference=True,owner=owner,declaration=declaration)
        reference=FIX['volume'](owner=owner);a.volume_validate(reference,FIX['PROJECT'],spec,reference=True,owner=owner)
        reference['Labels']['com.docker.compose.config-hash']='0'*64
        with self.assertRaisesRegex(a.Rejected,'^RESOURCE_OWNER_OR_MEMBERS_INVALID$'):
            a.volume_validate(reference,FIX['PROJECT'],spec,reference=True,owner=owner,
                declaration=self.d.source_model['volumes'][a.VOLUME_KEY])
        nets=copy.deepcopy(self.d.source_networks);nets['default']['Containers']['9'*64]={}
        with self.assertRaisesRegex(a.Rejected,'^ACTUAL_NETWORK_ID_OR_MEMBERS$'):
            a.actual_endpoints(self.d.actual,nets,self.d.services,spec)
    def managed_labels_source(self,spec):
        for role,net in self.d.source_networks.items():
            net['Labels']['com.docker.compose.config-hash']=a.managed_network_hash(
                self.d.source_model['networks'][role],role,FIX['PROJECT'],spec)
        self.d.source_volume['Labels']['com.docker.compose.config-hash']=a.managed_volume_hash(
            self.d.source_model['volumes'][a.VOLUME_KEY],FIX['PROJECT'])
        self.raw=self.observed();self.d.seal['stabilitySha256']=a.fingerprint(D.observation(
            self.raw,self.d.services,self.d.seal['files'],self.raw['actualResource']))
    def test_four_label_source_complete_measurement_preserves_raw_model_and_resources(self):
        spec=FIX['policy']();spec['renderedExternalNetworkExtra']={'ipam':{}}
        self.d.source_api.update({'command':None,'entrypoint':None})
        self.empty_network_source({r:None for r in a.NETWORK_ROLES})
        for row in self.d.source_model['networks'].values():row['ipam']={}
        legacy_resource_hash=a.fingerprint(self.observed()['actualResource']);self.managed_labels_source(spec)
        source=copy.deepcopy(self.d.source_model);resources=copy.deepcopy(self.raw['actualResource'])
        original_run=self.d.run;reference_labels=[]
        def run(*args,**kwargs):
            raw=original_run(*args,**kwargs)
            if args[0]==spec['composePath'] and 'config' in args and '--format' in args:
                model=json.loads(raw)
                for row in model['networks'].values():row['ipam']={}
                return json.dumps(model)
            if args[0]==spec['dockerPath'] and args[1:3]==('network','create'):
                reference_labels.append(copy.deepcopy(list(self.d.created_networks.values())[-1]['Labels']))
            if args[0]==spec['dockerPath'] and args[1:3]==('volume','create'):
                reference_labels.append(copy.deepcopy(self.d.created_volume['Labels']))
            return raw
        self.d.run=run
        with patch.dict(a.REVIEWED_GENERATORS,{('25.0.16','5.5.0'):spec}):
            result=a.measure(self.d,self.directory,services=self.d.services,image_reference='source-api',
                image_id=FIX['IMAGE'],source_seal=self.d.seal,stability_reader=self.read_stability)
        self.assertEqual(self.calls,3);self.assertEqual(len(self.d.removed),6)
        self.assertEqual(len(reference_labels),5);self.assertTrue(all(set(row)=={a.OWNER_KEY} for row in reference_labels))
        self.assertEqual(self.d.source_model,source);self.assertEqual(self.observed()['actualResource'],resources)
        self.assertEqual(result['facts']['source']['renderedDeclarationSha256'],a.fingerprint(source))
        self.assertEqual(result['measured']['actualResourceSha256'],a.fingerprint(resources))
        self.assertEqual(result['facts']['stableBefore']['actualResourceSha256'],a.fingerprint(resources))
        self.assertNotEqual(result['measured']['actualResourceSha256'],legacy_resource_hash)
        self.assertEqual(result['facts']['stableBefore'],result['facts']['stableAfter'])
        root=self.validation_root(result);root['generatorRulesSha256']=a.fingerprint(spec)
        C['validate_facts'](result['measured'],result['facts'],root)
        self.assertFalse(result['measured']['authority']);self.assertFalse(result['measured']['productionEligible'])
        self.assertFalse(self.d.created_networks);self.assertIsNone(self.d.created_volume);self.assertIsNone(self.d.created_container)
    def test_managed_resource_label_drift_keeps_original_full_snapshot_refusal(self):
        spec=FIX['policy']();self.managed_labels_source(spec);original_run=self.d.run
        for kind in ('network','volume'):
            self.managed_labels_source(spec);changed=False
            def drift(*args,**kwargs):
                nonlocal changed
                raw=original_run(*args,**kwargs)
                if not changed and args[0]==spec['dockerPath'] and args[1:3]==('network','create'):
                    changed=True;target=self.d.source_networks['default'] if kind=='network' else self.d.source_volume
                    target['Labels']['com.docker.compose.config-hash']='0'*64
                return raw
            self.d.run=drift
            with self.subTest(kind=kind),self.assertRaisesRegex(a.Rejected,
                    '^ACTUAL_'+('NETWORK' if kind=='network' else 'VOLUME')+'_INSPECT_CHANGED$'):
                self.measure()
            self.assertTrue(changed);self.assertFalse(self.d.created_networks)
            self.assertIsNone(self.d.created_volume);self.assertIsNone(self.d.created_container)
        self.d.run=original_run
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


class FixtureDockerPathIsolationTests(unittest.TestCase):
    def test_host_missing_or_noncanonical_path_is_ignored_and_restored(self):
        original_which=M.shutil.which
        for host_path in (None,'/synthetic-host/bin/docker'):
            with self.subTest(host_missing=host_path is None):
                with patch.object(M.shutil,'which',return_value=host_path) as host_lookup:
                    case=CollectorTests('test_full_facts_exact_constructor_validation')
                    case.setUp()
                    try:
                        case.test_full_facts_exact_constructor_validation()
                        fixture_lookup=M.shutil.which
                        fixture_lookup.assert_called_once_with('docker')
                        self.assertEqual(fixture_lookup.return_value,FIX['policy']()['dockerPath'])
                        self.assertEqual(a.REVIEWED_GENERATORS,{})
                    finally:
                        case.doCleanups()
                        case.tearDown()
                    self.assertIs(M.shutil.which,host_lookup)
                    host_lookup.assert_not_called()
                self.assertIs(M.shutil.which,original_which)
        for capability in (M.daemon_identity_capability,M.daemon_socket_capability):
            with self.assertRaisesRegex(RuntimeError,'^MOCK_RUNTIME_NOT_MEASURED$'):capability()


class NativePermissionDiagnosticTests(unittest.TestCase):
    # Only native metadata is synthetic. No host CLI/socket or subprocess is read.
    def setUp(self):
        import stat
        from types import SimpleNamespace
        from unittest.mock import Mock
        self.spec={'dockerPath':'SYNTHETIC_DOCKER','composePath':'SYNTHETIC_COMPOSE'}
        self.good=lambda **changes:SimpleNamespace(**{'st_mode':stat.S_IFREG|0o755,'st_uid':0,'st_nlink':1,**changes})
        self.paths={role:Mock() for role in ('DOCKER','COMPOSE','SOCKET')}
        for role in ('DOCKER','COMPOSE'):
            self.paths[role].is_file.return_value=True;self.paths[role].is_symlink.return_value=False
            self.paths[role].stat.return_value=self.good()
        self.paths['SOCKET'].is_symlink.return_value=False
        self.paths['SOCKET'].stat.return_value=SimpleNamespace(st_mode=stat.S_IFSOCK|0o660,st_uid=0)
        self.patch=patch.object(a,'Path',side_effect=lambda literal:self.paths[{'SYNTHETIC_DOCKER':'DOCKER','SYNTHETIC_COMPOSE':'COMPOSE','/var/run/docker.sock':'SOCKET'}[literal]])
        self.patch.start();a._NATIVE_CLI_FAILURE=None;a._NATIVE_CLI_ATTEMPT=None
    def tearDown(self):self.patch.stop()
    def failure(self,role,reason):
        with self.assertRaises(a.Rejected) as found:a.native_permissions(self.spec)
        self.assertIs(type(found.exception),a.Rejected)
        self.assertEqual(BaseException.args.__get__(found.exception),('CLI_SOURCE_CHANGED',))
        self.assertEqual(a.native_permission_failure(found.exception),(role,reason))
        self.assertIsNone(a._NATIVE_CLI_ATTEMPT)
        return found.exception
    def test_every_predicate_both_fixed_roles(self):
        import stat
        cases={'NOT_REGULAR':{'st_mode':stat.S_IFDIR|0o755},'UID':{'st_uid':501},'NLINK':{'st_nlink':2},
            'OWNER_EXEC':{'st_mode':stat.S_IFREG|0o644},'SPECIAL_MODE':{'st_mode':stat.S_IFREG|0o4755},
            'WRITABLE':{'st_mode':stat.S_IFREG|0o775}}
        for role in ('DOCKER','COMPOSE'):
            for reason,changes in cases.items():
                with self.subTest(role=role,reason=reason):
                    for native in ('DOCKER','COMPOSE'):self.paths[native].stat.return_value=self.good()
                    self.paths[role].stat.return_value=self.good(**changes)
                    self.failure(role,reason)
            self.paths[role].stat.return_value=self.good();self.paths[role].is_symlink.return_value=True
            self.failure(role,'LEAF_SYMLINK');self.paths[role].is_symlink.return_value=False
    def test_is_file_false_short_circuits_link_and_stat_and_second_tool(self):
        self.paths['DOCKER'].is_file.return_value=False
        self.failure('DOCKER','NOT_REGULAR')
        for call in (self.paths['DOCKER'].is_symlink,self.paths['DOCKER'].stat,
                self.paths['COMPOSE'].is_file,self.paths['SOCKET'].stat):call.assert_not_called()
    def test_leaf_symlink_short_circuits_stat(self):
        self.paths['DOCKER'].is_symlink.return_value=True
        self.failure('DOCKER','LEAF_SYMLINK');self.paths['DOCKER'].stat.assert_not_called()
        self.paths['COMPOSE'].is_file.assert_not_called()
    def test_double_invalid_reports_only_original_first_predicate(self):
        import stat
        self.paths['DOCKER'].stat.return_value=self.good(st_uid=501,st_nlink=2,st_mode=stat.S_IFREG|0o4644)
        self.failure('DOCKER','UID')
        self.paths['DOCKER'].stat.return_value=self.good(st_mode=stat.S_IFREG|0o4775)
        self.failure('DOCKER','SPECIAL_MODE')
    def test_attribute_reads_keep_original_short_circuit(self):
        import stat
        reads=[]
        class Info:
            @property
            def st_mode(self):reads.append('mode');return stat.S_IFREG|0o755
            @property
            def st_uid(self):reads.append('uid');return 501
            @property
            def st_nlink(self):raise AssertionError('LATE_ATTRIBUTE_READ')
        self.paths['DOCKER'].stat.return_value=Info()
        self.failure('DOCKER','UID');self.assertEqual(reads,['mode','mode','uid'])
    def test_non_bool_original_value_is_not_coerced_by_observer(self):
        calls=[]
        class Value:
            def __bool__(self):calls.append('bool');return False
        value=Value()
        self.assertIs(a._native_cli_predicate(value,'UID'),value)
        self.assertEqual(calls,[])
    def test_same_alias_attrs_subclass_unknown_args_have_no_issuance(self):
        self.paths['DOCKER'].stat.return_value=self.good(st_uid=501)
        issued=self.failure('DOCKER','UID')
        ordinary=a.Rejected('CLI_SOURCE_CHANGED');ordinary._native_cli_failure=('DOCKER','UID')
        class Subclass(a.Rejected):pass
        class EvilString(str):
            def __eq__(self,other):raise AssertionError('EQ_EXECUTED')
        for error in (ordinary,Subclass('CLI_SOURCE_CHANGED'),a.Rejected('SECRET_UNKNOWN'),
                a.Rejected(EvilString('CLI_SOURCE_CHANGED')),a.Rejected('CLI_SOURCE_CHANGED','SECRET')):
            self.assertIsNone(a.native_permission_failure(error))
        self.assertEqual(a.native_permission_failure(issued),('DOCKER','UID'))
    def test_next_success_clears_prior_issuance_and_socket_fail_is_not_cli(self):
        self.paths['DOCKER'].stat.return_value=self.good(st_uid=501)
        issued=self.failure('DOCKER','UID');self.paths['DOCKER'].stat.return_value=self.good()
        a.native_permissions(self.spec);self.assertIsNone(a.native_permission_failure(issued))
        self.paths['SOCKET'].is_symlink.return_value=True
        with self.assertRaisesRegex(a.Rejected,'^DAEMON_SOURCE_NOT_MEASURED$') as found:a.native_permissions(self.spec)
        self.assertIsNone(a.native_permission_failure(found.exception))
    def test_exact_missing_stat_retains_builtin_and_no_issuance(self):
        self.paths['DOCKER'].stat.side_effect=FileNotFoundError('SYNTHETIC_PRIVATE_PATH')
        with self.assertRaises(FileNotFoundError) as found:a.native_permissions(self.spec)
        self.assertIsNone(a.native_permission_failure(found.exception));self.assertIsNone(a._NATIVE_CLI_ATTEMPT)
    def test_corrupt_private_slot_never_confers_issuance_or_replaces_guard(self):
        for row in (None,{},[],('DOCKER',),('UNKNOWN','UID'),('DOCKER',[])):
            a._NATIVE_CLI_FAILURE=row
            self.assertIsNone(a.native_permission_failure(a.Rejected('CLI_SOURCE_CHANGED')))
        for row in (None,{},[],('DOCKER',),('UNKNOWN','UID')):
            a._NATIVE_CLI_ATTEMPT=row
            self.assertIs(a._native_cli_predicate(False,'UID'),False)
        a._NATIVE_CLI_ATTEMPT=None

    def test_guard_calls_and_arguments_unchanged(self):
        with patch.object(a,'check',wraps=a.check) as guard:
            a.native_permissions(self.spec)
        self.assertEqual(guard.call_args_list,[unittest.mock.call(True,'CLI_SOURCE_CHANGED'),
            unittest.mock.call(True,'CLI_SOURCE_CHANGED'),unittest.mock.call(True,'CLI_SOURCE_CHANGED'),
            unittest.mock.call(True,'CLI_SOURCE_CHANGED'),unittest.mock.call(True,'DAEMON_SOURCE_NOT_MEASURED'),
            unittest.mock.call(True,'DAEMON_SOURCE_NOT_MEASURED')])


class SourceFilePermissionDiagnosticTests(unittest.TestCase):
    """Real sealed-file reads in a local owned fixture; no host/runtime tool calls."""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='source-permission-',dir=HERE)
        self.addCleanup(self.temp.cleanup);self.directory=Path(self.temp.name)
        self.directory.chmod(0o700)
        self.collector=FIX['load']('source_permission_collector',HERE/'collector.py')
        self.collector._configure(M,D,json.loads((HERE/'contract.json').read_bytes()))

    @staticmethod
    def roles():
        return (('COMPOSE','docker-compose.aws-mysql.yml',False,'PUBLIC_WRITABLE'),
                ('RELEASE','compose.release.json',False,'PUBLIC_WRITABLE'),
                ('CLIENT','config.json',True,'PRIVATE_MODE'))

    def failure(self,name,private,reason):
        # UID mismatch is synthesized because tests must not change actual ownership.
        # Writable/mode predicates operate on actual local file/directory modes.
        from contextlib import ExitStack
        from types import SimpleNamespace
        import os
        c=self.collector;path=self.directory/name;path.write_bytes(b'LOCAL_CONTROL_ONLY')
        path.chmod(0o644 if reason=='PRIVATE_MODE' else 0o666 if reason=='PUBLIC_WRITABLE' else 0o600)
        self.directory.chmod(0o770 if reason=='PARENT_WRITABLE' else 0o700)
        real_parent=c._file_parent;real_fstat=os.fstat;real_check=c.check;parents=[];issued=[]
        def parent(value):
            fd,chain=real_parent(value);parents.append(fd);return fd,chain
        class OwnerMismatch:
            st_uid=os.getuid()+1
            @property
            def st_mode(self):raise AssertionError('PARENT_UID_AND_MUST_SHORT_CIRCUIT')
        def fstat(fd):
            return OwnerMismatch() if reason=='PARENT_UID' and fd in parents else real_fstat(fd)
        def check(ok,code):
            try:return real_check(ok,code)
            except c.Rejected as error:issued.append(error);raise
        try:
            with ExitStack() as stack:
                stack.enter_context(patch.object(c,'_file_parent',side_effect=parent))
                stack.enter_context(patch.object(c.os,'fstat',side_effect=fstat))
                stack.enter_context(patch.object(c,'check',side_effect=check))
                predicates=stack.enter_context(patch.object(c,'_source_file_permission_predicate',wraps=c._source_file_permission_predicate))
                with self.assertRaises(c.Rejected) as caught:c._sealed_file(path,private=private)
            self.assertEqual(caught.exception.args,('SOURCE_FILE_PERMISSIONS',))
            self.assertIs(caught.exception,issued[-1]);self.assertIsNone(c._SOURCE_FILE_PERMISSION_REASON)
            for fd in parents:
                with self.assertRaises(OSError):real_fstat(fd)
            return caught.exception,[call.args for call in predicates.call_args_list]
        finally:self.directory.chmod(0o700)

    def test_real_sealed_file_nine_roles_reasons_and_original_short_circuit(self):
        for role,name,private,leaf in self.roles():
            for reason in ('PARENT_UID','PARENT_WRITABLE',leaf):
                with self.subTest(role=role,reason=reason):
                    error,trace=self.failure(name,private,reason)
                    self.assertEqual(self.collector.source_file_permission_failure(error),(role,reason))
                    expected=[(False,'PARENT_UID')] if reason=='PARENT_UID' else [(True,'PARENT_UID'),(False,'PARENT_WRITABLE')] if reason=='PARENT_WRITABLE' else [(True,'PARENT_UID'),(True,'PARENT_WRITABLE'),(False,leaf)]
                    self.assertEqual(trace,expected)

    def test_original_leaf_type_owner_link_size_guards_remain_generic(self):
        import os,stat
        from types import SimpleNamespace
        c=self.collector;path=self.directory/'config.json';path.write_bytes(b'LOCAL_CONTROL_ONLY');path.chmod(0o600)
        real_stat=os.stat;fields=('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
        variants=({'st_mode':stat.S_IFDIR|0o700},{'st_uid':os.getuid()+1},{'st_nlink':2},{'st_size':1024**2+1})
        for bad in variants:
            with self.subTest(guard=tuple(bad)):
                def info(name,*args,**kwargs):
                    value=real_stat(name,*args,**kwargs)
                    return SimpleNamespace(**{**{field:getattr(value,field) for field in fields},**bad}) if name==path.name and kwargs.get('dir_fd') is not None else value
                with patch.object(c.os,'stat',side_effect=info),patch.object(c,'_source_file_permission_predicate',wraps=c._source_file_permission_predicate) as observer:
                    with self.assertRaises(c.Rejected) as caught:c._sealed_file(path,private=True)
                self.assertEqual(caught.exception.args,('SOURCE_FILE_INVALID',));observer.assert_not_called()
                self.assertIsNone(c.source_file_permission_failure(caught.exception))

    def test_unknown_roles_private_identity_and_falsey_values_cannot_issue(self):
        for name,private in (('unknown.yml',False),('config.json',False),('compose.release.json',True),('docker-compose.aws-mysql.yml',0),('config.json',1)):
            with self.subTest(name=name,private=private):
                error,_=self.failure(name,private,'PARENT_UID')
                self.assertIsNone(self.collector.source_file_permission_failure(error))
        c=self.collector
        class Falsey:
            def __bool__(self):raise AssertionError('OBSERVER_MUST_NOT_COERCE')
        c._SOURCE_FILE_PERMISSION_REASON=None;value=Falsey()
        self.assertIs(c._source_file_permission_predicate(value,'PARENT_UID'),value)
        self.assertIsNone(c._SOURCE_FILE_PERMISSION_REASON)

    def test_exact_issued_identity_args_alias_subclass_and_stale_are_closed(self):
        c=self.collector;error,_=self.failure('config.json',True,'PRIVATE_MODE')
        original=c._SOURCE_FILE_PERMISSION_FAILURE
        alias=c.Rejected('SOURCE_FILE_PERMISSIONS');alias._source_file_permission_failure=('CLIENT','PRIVATE_MODE')
        class Derived(c.Rejected):pass
        for foreign in (alias,Derived('SOURCE_FILE_PERMISSIONS'),RuntimeError('SOURCE_FILE_PERMISSIONS')):
            self.assertIsNone(c.source_file_permission_failure(foreign))
            # A fresh exception plus a caller-replaced legal slot must not issue.
            c._SOURCE_FILE_PERMISSION_FAILURE=(foreign,'CLIENT','PRIVATE_MODE')
            self.assertIsNone(c.source_file_permission_failure(foreign))
        copied=tuple(list(original));self.assertIsNot(copied,original)
        for row in ((alias,'CLIENT','PRIVATE_MODE'),(error,'CLIENT','PARENT_UID'),copied,(error,'CLIENT','PUBLIC_WRITABLE'),[error,'CLIENT','PRIVATE_MODE'],(error,'CLIENT','PRIVATE_MODE','EXTRA'),(error,'UNKNOWN','PRIVATE_MODE')):
            c._SOURCE_FILE_PERMISSION_FAILURE=row;self.assertIsNone(c.source_file_permission_failure(error))
        c._SOURCE_FILE_PERMISSION_FAILURE=original
        error.args=('SOURCE_FILE_PERMISSIONS','EXTRA');self.assertIsNone(c.source_file_permission_failure(error))
        error.args=('SOURCE_FILE_PERMISSIONS',);self.assertEqual(c.source_file_permission_failure(error),('CLIENT','PRIVATE_MODE'))
        path=self.directory/'config.json';path.chmod(0o600)
        raw,_=c._sealed_file(path,private=True);self.assertEqual(raw,b'LOCAL_CONTROL_ONLY')
        self.assertIsNone(c.source_file_permission_failure(error));self.assertIsNone(c._SOURCE_FILE_PERMISSION_FAILURE)

    def test_failed_role_classification_cannot_replace_original_exception(self):
        # A classification-only failure is diagnostic, never a new admission decision.
        c=self.collector;error,_=self.failure('config.json',True,'PRIVATE_MODE')
        self.assertEqual(error.args,('SOURCE_FILE_PERMISSIONS',))
        path=self.directory/'config.json';path.chmod(0o644)
        with patch.object(c,'_source_file_permission_original_error',side_effect=ValueError('LOCAL_CONTROL_ONLY')):
            with self.assertRaises(c.Rejected) as caught:c._sealed_file(path,private=True)
        self.assertEqual(caught.exception.args,('SOURCE_FILE_PERMISSIONS',))
        self.assertIsNone(c._SOURCE_FILE_PERMISSION_FAILURE)

if __name__=='__main__':unittest.main(verbosity=2)
