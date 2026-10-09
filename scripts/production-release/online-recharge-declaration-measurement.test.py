import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / '.runtime/online-recharge-release-20261009/build/declaration-producer-adapter-tests'
RUNTIME.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location('declaration_measurement', Path(__file__).with_name('online-recharge-declaration-measurement.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SENTINEL = 'LOCAL_TEST_DO_NOT_EXPOSE_PRIVATE_VALUE'
IMAGE = 'sha256:' + 'a' * 64
PROJECT = 'source-project'


def states():
    return {name: {'image':IMAGE,'reference':'source-' + name,'status':'running',
            'health':None if name=='caddy' else 'healthy','containerId':str(i+1)*64,
            'startedAtSha256':'b'*64,'environmentSha256':'c'*64,'configurationSha256':'d'*64}
            for i,name in enumerate(m.SERVICES)}


def model():
    return {'name':PROJECT,'services':{'api':{'image':'source-api','environment':{'API_PRIVATE':SENTINEL},
        'build':{'context':'/source','target':'runtime'},'read_only':True,'init':True,
        'networks':{role:{} for role in m.NETWORK_ROLES},
        'volumes':[{'type':'volume','source':'auto_registration_data','target':'/app/.runtime/auto-registration'}]}}}


class DockerReadFixture:
    def __init__(self):
        self.calls=[];self.failed=set();self.default_pools=[];self.compose_version='2.39.4'
        self.cached_image=IMAGE;self.source=model();self.network_unknown=False;self.volume_unknown=False
        self.packages={}
        self.info={'id':'engine-fixture-only','serverVersion':'28.4.0','defaultAddressPools':self.default_pools,
            'osType':'linux','architecture':'x86_64','plugins':[{'Name':'compose','Path':'/usr/libexec/docker/cli-plugins/docker-compose'}]}
        self.version={'Server':{'Version':'28.4.0','ApiVersion':'1.51'},'Client':{'Version':'28.4.0'}}
        self.nets={PROJECT+'_'+role:{'NetworkID':str(i+1)*64} for i,role in enumerate(m.NETWORK_ROLES)}
        self.mounts=[{'Type':'volume','Name':PROJECT+'_auto_registration_data','Source':'/fixture/mount'}]

    def run(self,*args,**kwargs):
        self.calls.append((args,kwargs))
        # Actual Env is never read by this adapter's inventory mode.
        if any('.Config.Env' in str(a) for a in args):
            raise AssertionError('Inventory requested actual Env')
        if args[:3]==('docker','compose','version'):
            if 'generator' in self.failed:raise RuntimeError(SENTINEL)
            return self.compose_version
        if args[:2]==('docker','info'):
            if 'generator' in self.failed:raise RuntimeError(SENTINEL)
            self.info['defaultAddressPools']=self.default_pools
            return json.dumps(self.info)
        if args[:2]==('docker','version'):return json.dumps(self.version)
        if args[:2]==('rpm','-qf'):
            if args[2] in self.packages:return self.packages[args[2]]
            raise RuntimeError(SENTINEL)
        if args[:3]==('docker','image','inspect'):
            if 'image' in self.failed:raise RuntimeError(SENTINEL)
            return json.dumps(self.cached_image)
        if args[:2]==('docker','compose') and 'config' in args:
            if 'source' in self.failed:raise RuntimeError(SENTINEL)
            return json.dumps(self.source)
        if args[:2]==('docker','inspect'):
            if 'resource' in self.failed:raise RuntimeError(SENTINEL)
            return json.dumps(self.nets if args[3]=='{{json .NetworkSettings.Networks}}' else self.mounts)
        if args[:3]==('docker','network','inspect'):
            role=m.NETWORK_ROLES[int(args[3][0])-1]
            row={'Name':PROJECT+'_'+role,'Id':args[3],'Driver':'bridge','Scope':'local',
                'Internal':role.endswith('control'),'EnableIPv4':True,'EnableIPv6':False,
                'IPAM':{'Driver':'default','Config':[]},'Attachable':False,'Ingress':False,
                'ConfigOnly':False,'ConfigFrom':{'Network':''},'Labels':{'private':SENTINEL},'Options':{}}
            if self.network_unknown:row[SENTINEL]=SENTINEL
            return json.dumps([row])
        if args[:3]==('docker','volume','inspect'):
            row={'Name':args[3],'Driver':'local','Scope':'local','Mountpoint':'/fixture/mount',
                 'CreatedAt':'2026-10-10T00:00:00Z','Options':None,'Labels':{'private':SENTINEL}}
            if self.volume_unknown:row[SENTINEL]=SENTINEL
            return json.dumps([row])
        raise AssertionError('Unexpected command')


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='source-',dir=RUNTIME)
        self.directory=Path(self.temp.name)
        for name in m.FILES:self.directory.joinpath(name).write_text('')
        self.d=DockerReadFixture()
        self.binary=patch.object(m,'binary_hash',return_value='e'*64);self.binary.start()
    def tearDown(self):
        self.binary.stop();self.temp.cleanup()
    def inventory(self):
        return m.inventory(self.d,self.directory,services=states(),image_reference='source-api',image_id=IMAGE)
    def test_collected_inventory_is_closed_readonly_and_never_eligible(self):
        result=self.inventory()
        self.assertEqual(m.validate_inventory(result),result)
        self.assertEqual(result['generator']['composeVersion'],'2.39.4')
        self.assertEqual(result['resources']['connectedNetworkCount'],4)
        self.assertEqual(result['resources']['namedVolumeCount'],1)
        self.assertEqual(result['cacheImage']['status'],'MATCH')
        self.assertEqual(result['daemonDefaultAddressPools']['status'],'UNDECLARED')
        self.assertEqual(result['status'],'SOURCE_NOT_MEASURED')
        for key in ('authority','productionEligible','measurementPerformed','proofConstructed'):
            self.assertIs(result[key],False)
        self.assertNotIn(SENTINEL,json.dumps(result))
        self.assertTrue(all(args[:2] not in (('docker','create'),('docker','start'),('docker','run')) for args,_ in self.d.calls))
        self.assertTrue(all('create' not in args and 'up' not in args for args,_ in self.d.calls))
    def test_explicit_daemon_pools_retained_and_no_builtin_defaults_invented(self):
        self.d.default_pools=[{'Base':'10.64.0.0/16','Size':24}]
        result=self.inventory()
        self.assertEqual(result['daemonDefaultAddressPools']['pools'],[{'base':'10.64.0.0/16','size':24}])
        self.assertEqual(result['daemonDefaultAddressPools']['reviewedRulesStatus'],'SOURCE_NOT_MEASURED')
    def test_unknown_or_malformed_daemon_pools_not_silently_assumed(self):
        for rows in ('',False,{},[{'Base':SENTINEL,'Size':24}],[{'Base':'10.0.0.1/16','Size':24}],
                     [{'Base':'10.0.0.0/16','Size':True}],[{'Base':'10.0.0.0/16','Size':24,'token':SENTINEL}]):
            with self.subTest(type=type(rows).__name__):
                self.d.default_pools=rows;r=self.inventory()
                self.assertEqual(r['daemonDefaultAddressPools']['status'],'UNAVAILABLE')
                self.assertIn('DEFAULT_POOLS_UNAVAILABLE',r['codes']);self.assertNotIn(SENTINEL,json.dumps(r))
    def test_native_nil_pools_only_observes_no_custom_declaration(self):
        self.d.default_pools=None
        r=self.inventory()
        self.assertEqual(r['daemonDefaultAddressPools'],{'status':'UNDECLARED','pools':[],
            'reviewedRulesStatus':'SOURCE_NOT_MEASURED','sourceEncoding':'NULL',
            'sourceValueSha256':m.fingerprint(None)})
        self.assertNotIn('DEFAULT_POOLS_UNAVAILABLE',r['codes'])
        self.assertEqual(m.REVIEWED_GENERATORS,{})
        self.assertFalse(r['authority']);self.assertFalse(r['measurementPerformed'])
        self.d.default_pools=[]
        array=self.inventory()['daemonDefaultAddressPools']
        self.assertEqual(array['sourceEncoding'],'ARRAY')
        self.assertNotEqual(array['sourceValueSha256'],r['daemonDefaultAddressPools']['sourceValueSha256'])
    def test_native_version_git_and_installed_package_identity_are_observed_only(self):
        self.d.version['Server']['GitCommit']='abc1234'
        self.d.version['Client']['GitCommit']='def1234'
        self.d.packages={'/usr/bin/dockerd':'docker|25.0.16|1.amzn2023.0.1|x86_64',
                         '/usr/bin/docker':'docker-cli|25.0.14|1.amzn2023.0.1|x86_64'}
        r=self.inventory();g=r['generator']
        self.assertEqual(g['engineGitCommit'],'abc1234')
        self.assertEqual(g['dockerCliGitCommit'],'def1234')
        self.assertEqual(g['enginePackage']['version'],'25.0.16')
        self.assertEqual(g['dockerCliPackage']['name'],'docker-cli')
        self.assertFalse(r['authority']);self.assertFalse(r['productionEligible'])
        self.assertEqual(m.REVIEWED_GENERATORS,{})
    def test_unmeasured_or_malformed_native_package_fields_are_suppressed(self):
        for value in (SENTINEL,'unknown|25.0.16|1.amzn2023.0.1|x86_64',
                      'docker|'+SENTINEL+'|1.amzn2023.0.1|x86_64',
                      'docker|25.0.16|'+SENTINEL+'|x86_64',
                      'docker|25.0.16|1.amzn2023.0.1|'+SENTINEL):
            self.d.version['Server']['GitCommit']=SENTINEL
            self.d.packages={'/usr/bin/dockerd':value}
            r=self.inventory();self.assertIsNone(r['generator']['enginePackage'])
            self.assertIsNone(r['generator']['engineGitCommit']);self.assertNotIn(SENTINEL,json.dumps(r))
    def test_unreviewed_local_generator_versions_only_observed_not_registered(self):
        self.d.compose_version='5.4.0'
        r=self.inventory();self.assertEqual(r['generator']['composeVersion'],'5.4.0')
        self.assertEqual(m.REVIEWED_GENERATORS,{})
        with self.assertRaisesRegex(m.Rejected,'^SOURCE_NOT_MEASURED$'):
            m.measure(self.d,self.directory,services=states(),image_reference='source-api',image_id=IMAGE,
                      source_seal={},stability_reader=lambda:None)
        self.assertTrue(all('create' not in args and 'run' not in args and 'start' not in args for args,_ in self.d.calls))
    def test_unknown_version_suffix_cannot_be_returned_as_dynamic_secret(self):
        self.d.compose_version='2.39.4-'+SENTINEL
        r=self.inventory();self.assertIsNone(r['generator']['composeVersion'])
        self.assertIn('GENERATOR_UNAVAILABLE',r['codes']);self.assertNotIn(SENTINEL,json.dumps(r))
    def test_read_failure_summary_never_returns_exception_stdout_or_stderr(self):
        self.d.failed={'generator','image','source','resource'}
        r=self.inventory();self.assertNotIn(SENTINEL,json.dumps(r))
        self.assertEqual(r['codes'],['SOURCE_NOT_MEASURED','GENERATOR_UNAVAILABLE','SOURCE_SHAPE_UNAVAILABLE',
                                     'IMAGE_CACHE_UNAVAILABLE','RESOURCE_SCHEMA_UNAVAILABLE'])
    def test_source_ambient_variable_and_compose_overrides_removed_without_dropping_path(self):
        self.directory.joinpath(m.FILES[0]).write_text('${SOURCE_SECRET:?}')
        with patch.dict(m.os.environ,{'SOURCE_SECRET':SENTINEL,'COMPOSE_PROJECT_NAME':SENTINEL,'PATH':'/controlled'}):
            cleaned=m.clean_source_environment(self.directory)
        self.assertNotIn('SOURCE_SECRET',cleaned);self.assertNotIn('COMPOSE_PROJECT_NAME',cleaned)
        self.assertEqual(cleaned['PATH'],'/controlled')
    def test_unresolved_source_env_reports_not_measured(self):
        self.d.source['services']['api']['environment']['API_PRIVATE']=None
        r=self.inventory();self.assertEqual(r['sourceShape']['status'],'NOT_MEASURED')
        self.assertIn('SOURCE_SHAPE_UNAVAILABLE',r['codes'])
    def test_native_null_command_fields_are_observed_without_removing_them(self):
        self.d.source['services']['api'].update(command=None,entrypoint=None)
        before=copy.deepcopy(self.d.source)
        r=self.inventory()
        self.assertEqual(r['sourceShape']['status'],'OBSERVED')
        self.assertTrue({'command','entrypoint'} <= set(r['sourceShape']['apiFieldNames']))
        self.assertEqual(self.d.source,before)
        self.assertFalse(r['authority']);self.assertFalse(r['proofConstructed'])
    def test_rendered_shape_keeps_only_known_nested_field_names(self):
        api=self.d.source['services']['api']
        api['depends_on']={'migrate':{'condition':'service_completed_successfully','required':True}}
        api['networks']={role:{'priority':0} for role in m.NETWORK_ROLES}
        api['volumes'][0]['volume']={}
        r=self.inventory();shape=r['sourceShape']['representation']
        self.assertEqual(shape['dependencyFieldNames'],{'migrate':['condition','required']})
        self.assertEqual(shape['networkEntryFieldNames']['default'],['priority'])
        self.assertEqual(shape['volumeFieldNames'],[['source','target','type','volume']])
        for branch in ('depends_on','networks'):
            bad=copy.deepcopy(api)
            target=bad[branch][next(iter(bad[branch]))];target[SENTINEL]=SENTINEL
            self.d.source['services']['api']=bad
            rejected=self.inventory()
            self.assertEqual(rejected['sourceShape']['status'],'NOT_MEASURED')
            self.assertNotIn(SENTINEL,json.dumps(rejected))
        self.d.source['services']['api']=api
    def test_explicit_command_or_entrypoint_cannot_claim_fixed_source_shape(self):
        for key in ('command','entrypoint'):
            for value in ([],['true'],'',SENTINEL,False,0,{}):
                with self.subTest(key=key,value_type=type(value).__name__):
                    self.d.source=model();self.d.source['services']['api'][key]=value
                    r=self.inventory()
                    self.assertEqual(r['sourceShape']['status'],'NOT_MEASURED')
                    self.assertIn('SOURCE_SHAPE_UNAVAILABLE',r['codes'])
                    self.assertNotIn(SENTINEL,json.dumps(r))
    def test_schema_unknown_names_are_counted_and_hashed_not_output(self):
        self.d.network_unknown=True;self.d.volume_unknown=True
        r=self.inventory();self.assertEqual(r['resources']['unknownNetworkFieldCount'],4)
        self.assertEqual(r['resources']['unknownVolumeFieldCount'],1)
        self.assertNotIn(SENTINEL,json.dumps(r));self.assertEqual(r['resources']['reviewedSchemaStatus'],'SOURCE_NOT_MEASURED')
    def test_image_cache_mismatch_is_measured_mismatch_not_authority(self):
        self.d.cached_image='sha256:'+'f'*64
        r=self.inventory();self.assertEqual(r['cacheImage']['status'],'MISMATCH');self.assertIs(r['authority'],False)
    def test_wrong_running_network_id_never_triggers_arbitrary_lookup(self):
        self.d.nets[next(iter(self.d.nets))]['NetworkID']=SENTINEL
        r=self.inventory();self.assertIn('RESOURCE_SCHEMA_UNAVAILABLE',r['codes'])
        self.assertFalse(any(SENTINEL in args for args,_ in self.d.calls))
    def test_binary_arbitrary_file_is_rejected_before_file_read(self):
        self.binary.stop()
        with patch.object(Path,'open',side_effect=AssertionError('Must not open')):
            with self.assertRaisesRegex(m.Rejected,'^SOURCE_NOT_MEASURED$'):
                m.binary_hash('/private/'+SENTINEL,'compose')
        self.binary.start()
    def test_report_unknown_or_hostile_transport_fields_all_reject_without_values(self):
        good=self.inventory();cases=[]
        for key in ('authority','productionEligible','measurementPerformed','proofConstructed'):
            bad=copy.deepcopy(good);bad[key]=True;cases.append(bad)
        bad=copy.deepcopy(good);bad[SENTINEL]=SENTINEL;cases.append(bad)
        bad=copy.deepcopy(good);bad['status']='BASELINE_VERIFIED';cases.append(bad)
        bad=copy.deepcopy(good);bad['codes'].append('SOURCE_NOT_MEASURED_'+SENTINEL);cases.append(bad)
        bad=copy.deepcopy(good);bad['generator']['composeVersion']=SENTINEL;cases.append(bad)
        bad=copy.deepcopy(good);bad['resources']=SENTINEL;cases.append(bad)
        bad=copy.deepcopy(good);bad['sourceShape']['apiFieldNames']=[SENTINEL];cases.append(bad)
        bad=copy.deepcopy(good);bad['daemonDefaultAddressPools']['pools']=[{'base':'10.0.0.0/16','size':24,'token':SENTINEL}];cases.append(bad)
        for value in [*cases,None,[],SENTINEL]:
            with self.subTest(type=type(value).__name__),self.assertRaisesRegex(m.Rejected,'^INVENTORY_INVALID$'):
                m.validate_inventory(value)
    def test_inconsistent_not_measured_and_observed_states_cannot_claim_collection(self):
        good=self.inventory()
        cases=[]
        for branch,field in (('resources','networkSchemaSha256'),('sourceShape','schemaSha256')):
            bad=copy.deepcopy(good);bad[branch][field]=None;cases.append(bad)
        for branch in ('resources','sourceShape'):
            bad=copy.deepcopy(good);bad[branch]['status']='NOT_MEASURED';cases.append(bad)
        bad=copy.deepcopy(good);bad['sourceShape']['declaredNetworkCount']=3;cases.append(bad)
        bad=copy.deepcopy(good);bad['resources']['namedVolumeCount']=True;cases.append(bad)
        for bad in cases:
            with self.assertRaisesRegex(m.Rejected,'^INVENTORY_INVALID$'):m.validate_inventory(bad)
    def test_measurement_stays_closed_without_reviewed_generator_even_when_all_reads_succeed(self):
        guard=lambda: 'a'*64
        with patch.object(m,'_measure_reviewed',side_effect=AssertionError('Must not enter orchestrator')):
            with self.assertRaisesRegex(m.Rejected,'^SOURCE_NOT_MEASURED$'):
                m.measure(self.d,self.directory,services=states(),image_reference='source-api',image_id=IMAGE,
                          source_seal={'version':1},stability_reader=guard)
        self.assertEqual(m.REVIEWED_GENERATORS,{})

    def test_duplicate_json_keys_oversize_constants_rejected(self):
        for raw in ('{"x":1,"x":2}','{"x":NaN}',SENTINEL,'x'*(16*1024**2+1)):
            with self.assertRaisesRegex(m.Rejected,'^INPUT_INVALID$'):m.unique_json(raw)
    def test_invalid_snapshot_or_alias_image_rejected_before_read(self):
        for rows,ref,img in (({**states(),'extra':{}},'source-api',IMAGE),
                            (states(),'source-other',IMAGE),(states(),'source-api','sha256:'+'f'*64)):
            with self.assertRaisesRegex(m.Rejected,'^INPUT_INVALID$'):
                m.inventory(self.d,self.directory,services=rows,image_reference=ref,image_id=img)
        self.assertEqual(self.d.calls,[])


if __name__=='__main__':unittest.main()
