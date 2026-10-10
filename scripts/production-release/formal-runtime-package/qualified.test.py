"""SYNTHETIC_ONLY qualification integration; actual pinned VFS validator/codec.

No subprocess/Docker/AWS/netlink in this suite. Only VFS collection I/O is mocked;
source-row admission is private test-only and never publicly registered.
"""
import copy
import json
import os
from pathlib import Path
import runpy
import tempfile
import struct
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
# Same-producer external capabilities are ordinary current sibling code;
# runtime collection is mocked, including every kernel/system tool getter.
from types import SimpleNamespace
FIX=runpy.run_path(str(HERE/'collector-fixture.test-support.py'))
ROOT=HERE.parents[2]
load=FIX['load'];a=FIX['a'];M=a.frozen
q=load('minimal_qualified_subject',HERE/'qualified.py')
pure=load('minimal_qualified_pure',HERE/'pure.py')
manifest=json.loads((HERE/'manifest.json').read_bytes())
contract=json.loads((HERE/'contract.json').read_bytes())
paths={n:ROOT/'scripts/production-release'/n for n in manifest['consumerFiles']}
external=SimpleNamespace(
 identity=load('minimal_qualified_identity',paths['online-recharge-daemon-identity.py']),
 listener=load('minimal_qualified_listener',paths['online-recharge-daemon-listener.py']),
 socket=load('minimal_qualified_socket',paths['online-recharge-daemon-socket.py']),
 paths=paths,leaf_pins=manifest['externalLeafPins'],
 socket_bytes=paths['online-recharge-daemon-socket.py'].read_bytes(),assert_stable=lambda:None)
def factory():
 c=load('minimal_qualified_collector',HERE/'collector.py')
 i=load('minimal_qualified_inventory',paths['online-recharge-declaration-measurement.py'])
 def unavailable():raise RuntimeError('MOCK_RUNTIME_NOT_MEASURED')
 i.daemon_identity_capability=unavailable;i.daemon_socket_capability=unavailable
 c._configure(i,pure,contract)
 return c
q._configure(external,pure,factory)
legacy=q._load_legacy_socket_inventory()
Q=q.__dict__


def tools():
    return {p:{'bytesSha256':q.sha('SYNTHETIC_'+p),'identity':{'inode':i,'uid':0}}
        for i,p in enumerate(('/usr/bin/systemctl','/usr/bin/rpm'))}


def profile():
    source={key:q.sha('SYNTHETIC_REVIEW_'+key) for key in q.SOURCE_KEYS}
    source.update(srpmSha256=q.SRPM_SHA,engineSourceArchiveSha256=q.ENGINE_ARCHIVE_SHA,
        engineCommit=q.ENGINE_GIT+'a'*33,cliCommit=q.CLI_FULL_GIT,composeAssetSha256=q.COMPOSE_SHA,binaryRpmSha256=q.BINARY_RPM_SHA)
    spec=FIX['policy']();spec.update(sourceSha256=q.digest(source),poolSourceSha256=source['poolSourceReviewSha256'],
        dockerCliSha256=q.DOCKER_SHA,composeCliSha256=q.COMPOSE_SHA)
    return {'kind':'ENGINE25_RUNTIME_QUALIFICATION_PROFILE_V1','spec':spec,'sourceInputs':source,
        'sourceReviewReportSha256':q.sha('SYNTHETIC_REVIEW'),'poolMode':'REVIEWED_EXPLICIT_COMPLETE_INPUTS',
        'zeroConfigurationEncodings':['ABSENT'],'runtimeConfigurationRuleSha256':q.sha('SYNTHETIC_CONFIG_RULE'),
        'dockerdBinarySha256':q.DOCKERD_SHA,'rpm':copy.deepcopy(q.RPM),
        'reviewedCollectionToolSha256':{p:v['bytesSha256'] for p,v in tools().items()}}


def binding():
    runtime={key:q.sha('SYNTHETIC_'+key) for key in ('pidSha256','starttimeSha256','processSha256',
        'binarySha256','executableIdentitySha256','installedIdentitySha256','runtimeIdentitySha256','collectionToolsSha256')}
    runtime.update(binarySha256=q.DOCKERD_SHA,collectionToolsSha256=q.digest(tools()),
        executablePathKind='FIXED_USR_BIN_DOCKERD',rootIdentity='OBSERVED_ROOT',installedBinding='SAME_INODE_AND_SHA256')
    rid={'version':1,'kind':'DOCKERD_RUNTIME_IDENTITY','status':'RUNTIME_BOUND','authority':False,
        'productionEligible':False,'proofConstructed':False,'rawOutputSuppressed':True,'runtime':runtime,
        'cmdline':{'sha256':q.sha('SYNTHETIC_CMDLINE'),'argumentCount':2,'configFileEncoding':'DEFAULT_FIXED',
            'defaultAddressPoolCount':1,'defaultAddressPoolSha256':q.digest(profile()['spec']['defaultPools'])},
        'configuration':{'status':'ABSENT','sourceSha256':q.sha('SYNTHETIC_ABSENT'),'defaultAddressPoolsEncoding':'ABSENT',
            'defaultAddressPoolCount':0,'defaultAddressPoolSha256':q.digest(None),'effectiveRulesStatus':'SOURCE_NOT_MEASURED'},
        'package':{'name':'docker','nevraSha256':q.digest(q.RPM),'sourceRpmSha256':q.sha(q.SRPM_NAME),
            'fileDigestAlgorithm':'SHA256','fileDigest':q.DOCKERD_SHA,'querySha256':q.sha('SYNTHETIC_RPM'),
            'signatureStatus':'NOT_MEASURED','sourceRpmRetrieved':False,'patchesStatus':'NOT_MEASURED'},
        'effectivePoolRulesStatus':'SOURCE_NOT_MEASURED'}
    value={key:q.sha('SYNTHETIC_'+key) for key in ('socketNodeSha256','networkNamespaceSha256','listenerSha256','daemonFdSha256','observationSha256')}
    value.update(version=1,kind='DOCKERD_FIXED_UNIX_SOCKET_BINDING',status='LISTENER_HELD_BY_RUNTIME_DAEMON',
        authority=False,productionEligible=False,proofConstructed=False,rawOutputSuppressed=True,unixHost=q.UNIX_HOST,
        runtimeIdentity=rid,daemonListenerFdCount=1,listenerRowCount=1,
        socketActivationCreatorStatus='NOT_MEASURED',exclusiveAcceptingProcessStatus='NOT_MEASURED')
    legacy.validate_binding(value)
    return value


def vfs_binding(listener=None):
    cap=q._load_socket();inode=12345;vfs_inode=54321;device=cap.kernel_device(os.makedev(0,2));seq=41;port=7777
    def attribute(kind,data):
        raw=cap.ATTR.pack(cap.ATTR.size+len(data),kind)+data
        return raw+b'\0'*(-len(raw)%4)
    body=cap.RESPONSE.pack(1,1,10,0,inode,101,202)
    body+=attribute(1,struct.pack('=II',vfs_inode,device))+attribute(6,b'\0')+attribute(7,struct.pack('=I',0))
    packet=cap.HEADER.pack(cap.HEADER.size+len(body),20,0,seq,port)+body
    parsed=cap.decode_packet(packet,sequence=seq,port=port,inode=inode)
    h=cap.digest
    row={'protocol':'AF_NETLINK_NETLINK_SOCK_DIAG_UNIX_DIAG_VFS','status':'EXACT_VFS_MATCH',
        'kernelSocketInodeSha256':h(inode),'vfsInodeSha256':h(vfs_inode),'vfsDeviceSha256':h(device),
        'kernelCookieSha256':h(parsed['cookie']),'vfsIdentitySha256':h({'inode':vfs_inode,'device':device}),
        'nodeIdentitySha256':q.sha('SYNTHETIC_NODE_IDENTITY'),'responseIdentitySha256':h(parsed)}
    value={'version':2,'kind':'DOCKERD_FIXED_UNIX_VFS_BINDING','status':'VFS_BOUND_TO_RUNTIME_DAEMON',
        'authority':False,'productionEligible':False,'proofConstructed':False,'rawOutputSuppressed':True,
        'unixHost':q.UNIX_HOST,'listenerBinding':listener or binding(),'vfsBinding':row}
    cap.validate_binding(value)
    return value

class Driver(FIX['FakeDocker']):
    def run(self,*args,**kwargs):
        args=list(args)
        if args[0]==FIX['policy']()['composePath'] and '--project-directory' not in args:
            args=['docker','compose',*args[1:]]
        if args[:3]==['docker','compose','version'] and '--short' in args:return '5.5.0'
        if args[:2]==['docker','compose'] and 'ps' in args:
            self.calls.append((tuple(args),kwargs));return self.services[args[-1]]['containerId']
        if args[0] in ('docker','/usr/bin/docker') and len(args)==3 and args[1]=='inspect':
            self.calls.append((tuple(args),kwargs));meta=copy.deepcopy(self.actual);meta['Id']=args[-1]
            name=next(name for name,row in self.services.items() if row['containerId']==args[-1])
            meta['Config']['Image']='source-'+name
            if name=='caddy':meta['State'].pop('Health',None)
            return json.dumps([meta])
        if args[0] in ('docker','/usr/bin/docker') and args[1]=='version':
            self.calls.append((tuple(args),kwargs))
            return json.dumps({'Server':{'Version':'25.0.16','ApiVersion':'1.44','GitCommit':q.ENGINE_GIT},
                'Client':{'Version':'25.0.14','GitCommit':q.CLI_GIT}})
        return super().run(*args,**kwargs)


class QualificationTests(unittest.TestCase):
    def setUp(self):
        global a,M
        a=q._load_base();M=a.frozen
        self.temp=tempfile.TemporaryDirectory(prefix='synthetic-',dir=HERE)
        self.base=Path(self.temp.name);self.directory=self.base/'releases/source';self.directory.mkdir(parents=True)
        (self.base/'.runtime').mkdir()
        (self.directory/M.FILES[0]).write_bytes((HERE/'fixture-compose.test.yml').read_bytes())
        (self.directory/M.FILES[1]).write_bytes(b'{}\n');(self.directory/M.FILES[2]).write_bytes(b'');(self.directory/M.FILES[2]).chmod(0o600)
        self.d=Driver(self.base,self.directory);self.cap=q._load_socket();self.cap.value=vfs_binding();self.cap.calls=0
        self.session=q._Session(a,profile(),self.cap)
        self.patches=[patch.object(M,'binary_hash',side_effect=lambda p,kind:q.COMPOSE_SHA if kind=='compose' else q.DOCKER_SHA),
            patch.object(M,'native_package',return_value=copy.deepcopy(q.RPM_PACKAGE)),
            patch.object(self.session,'old_permissions',return_value=None),
            patch.object(self.session,'native_tools',return_value={'docker':{'sha256':q.DOCKER_SHA,'identity':'SYNTHETIC'},
                'compose':{'sha256':q.COMPOSE_SHA,'identity':'SYNTHETIC'}}),
            patch.object(self.session,'collection_tools',side_effect=tools),
            patch.object(self.cap,'runtime_daemon_socket_binding',side_effect=self.collect_vfs)]
        for p in self.patches:p.start()
        self.raw=self.observed()
        self.d.seal['stabilitySha256']=a.fingerprint(a.derive.observation(self.raw,self.d.services,self.d.seal['files'],self.raw['actualResource']))
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def collect_vfs(self,driver):
        self.cap.calls+=1;return copy.deepcopy(self.cap.value)
    def observed(self):
        return {'snapshot':copy.deepcopy(self.d.services),
            'sourceFiles':{'configurationFiles':copy.deepcopy(self.d.seal['files']),'workspaceFiles':{'workspace-record.json':a.sha(b'SYNTHETIC')}},
            'workspaceVolume':copy.deepcopy(self.d.source_volume),
            'actualResource':{'networks':copy.deepcopy(self.d.source_networks),'volume':copy.deepcopy(self.d.source_volume)}}
    def measure(self):
        return self.session.measure(self.d,self.directory,services=self.d.services,image_reference='source-api',
            image_id=FIX['IMAGE'],source_seal=self.d.seal,stability_reader=lambda:copy.deepcopy(self.raw))
    def runtime(self):
        return self.session.runtime(self.d)
    def no_create(self):self.assertFalse(any('create' in cmd for cmd,_ in self.d.calls))
    def test_unbound_public_source_refuses_before_any_command(self):
        for call in (q.reviewed_rules,lambda:q.measure(self.d,self.directory,services=self.d.services,
            image_reference='source-api',image_id=FIX['IMAGE'],source_seal=self.d.seal,stability_reader=lambda:self.raw)):
            with self.assertRaisesRegex(q.Rejected,'SOURCE_NOT_MEASURED'):call()
        self.assertEqual(self.d.calls,[]);self.assertEqual(q.REVIEWED_GENERATORS,{})
        self.assertIsNone(q._SOURCE_TABLE_BYTES);self.assertEqual(len(q.REVIEWED_SOURCE_TABLE),1)
    def test_unbound_public_context_has_no_acquisition(self):
        with self.assertRaisesRegex(q.Rejected,'SOURCE_NOT_MEASURED'):
            with q.acquisition_session(self.d):self.fail('yielded')
        self.assertEqual(self.d.calls,[])
    def test_private_context_acquisition_seven_uses_clean_runner_not_raw_functions(self):
        def escaped(*args,**kwargs):raise AssertionError('RAW_GLOBAL_FUNCTION_ESCAPED')
        self.d.service_state=escaped;self.d.production_services=escaped;self.d.compose=escaped
        with patch.dict(os.environ,{'LD_PRELOAD':'SYNTHETIC_PRIVATE','HTTP_PROXY':'SYNTHETIC_PRIVATE'}):
            with q._acquisition_context(self.d,self.session) as acquired:
                self.assertEqual(set(acquired.runner.production_services(self.directory)),set(M.SERVICES))
                for name in M.SERVICES:
                    row=acquired.runner.service_state(self.directory,name,include_container_id=True,include_environment_hash=True)
                    self.assertEqual(set(row),{'image','reference','status','health','containerId','startedAtSha256','environmentSha256'})
                    self.assertEqual(row['containerId'],self.d.services[name]['containerId'])
                self.assertEqual(acquired.reviewed_rules()['rulesSha256'],q.digest(profile()['spec']))
                acquired.assert_stable()
        for _,kw in self.d.calls:
            self.assertEqual(set(kw['env']),{'PATH','LANG','LC_ALL','DOCKER_CONFIG','DOCKER_HOST'})
        self.assertEqual(list((self.base/'.runtime/online-recharge-qualified-client').iterdir()),[])
    def test_context_measure_same_outer_client_and_complete_facts(self):
        with q._acquisition_context(self.d,self.session) as acquired:
            outer=acquired.runner.environment['DOCKER_CONFIG']
            result=acquired.measure(self.directory,services=self.d.services,image_reference='source-api',
                image_id=FIX['IMAGE'],source_seal=self.d.seal,stability_reader=lambda:copy.deepcopy(self.raw))
            self.assertEqual(set(result),{'measured','facts'})
            acquired.assert_stable();self.assertTrue((Path(outer)/'config.json').is_file())
            self.assertEqual(list((self.base/'.runtime/online-recharge-declaration-measurement').iterdir()),[])
        self.assertFalse(Path(outer).exists())
    def test_context_exit_drift_rejects_and_cleans_own_client(self):
        with self.assertRaises(Exception):
            with q._acquisition_context(self.d,self.session) as acquired:
                outer=Path(acquired.runner.environment['DOCKER_CONFIG'])
                self.cap.value['vfsBinding']['kernelCookieSha256']='a'*64
        self.assertFalse(outer.exists())
    def test_context_exception_cleans_owned_local_files(self):
        with self.assertRaisesRegex(RuntimeError,'SYNTHETIC_ONLY'):
            with q._acquisition_context(self.d,self.session) as acquired:
                outer=Path(acquired.runner.environment['DOCKER_CONFIG']);raise RuntimeError('SYNTHETIC_ONLY')
        self.assertFalse(outer.exists())
    def test_context_rules_cannot_mutate_fixed_profile(self):
        with q._acquisition_context(self.d,self.session) as acquired:
            first=acquired.reviewed_rules();first['spec']['defaultPools'].append({'base':'10.65.0.0/16','size':24})
            self.assertEqual(acquired.reviewed_rules()['spec'],profile()['spec'])
    def test_context_rejects_unknown_callable_escape_and_compose_mutation(self):
        with q._acquisition_context(self.d,self.session) as acquired:
            for method in ('run_raw','wait_healthy','rollback_service','raw'):
                with self.subTest(method=method),self.assertRaisesRegex(q.Rejected,'CLIENT_SOURCE_CHANGED'):getattr(acquired.runner,method)
            with self.assertRaisesRegex(q.Rejected,'CLIENT_SOURCE_CHANGED'):acquired.runner.compose(self.directory,'up')
            with self.assertRaisesRegex(q.Rejected,'CLIENT_SOURCE_CHANGED'):acquired.runner.service_state(self.directory,'online-recharge')
    def test_public_no_profile_or_capability_override(self):
        for key in ('profile','spec','rulesSha256','capability','sourceReviewed'):
            with self.subTest(key=key),self.assertRaises(TypeError):q.measure(self.d,self.directory,**{key:True})
    def test_legacy_socket_rejected_before_create(self):
        self.session.capability=legacy
        with self.assertRaisesRegex(q.Rejected,'VFS_BOUND_CAPABILITY_REQUIRED'):
            self.session.measure(self.d,self.directory,services=self.d.services,image_reference='source-api',
                image_id=FIX['IMAGE'],source_seal=self.d.seal,stability_reader=lambda:self.raw)
        self.no_create();self.assertEqual(self.cap.calls,0)
        self.assertEqual(q._load_socket().LISTENER_SHA,q.sha(Path(legacy.__file__).read_bytes()))
    def test_closed_profile_rejects_unknown(self):
        p=profile();p['callerReviewed']=True
        with self.assertRaises(q.Rejected):q._source_profile(p,a)
    def test_fixed_source_ids_not_syntax_only(self):
        for key in ('srpmSha256','engineSourceArchiveSha256','engineCommit','cliCommit','composeAssetSha256','binaryRpmSha256'):
            p=profile();p['sourceInputs'][key]='b'*len(p['sourceInputs'][key]);p['spec']['sourceSha256']=q.digest(p['sourceInputs'])
            with self.subTest(key=key),self.assertRaises(q.Rejected):q._source_profile(p,a)
    def test_binary_and_rpm_profile_must_exact(self):
        for change in ('dockerd','rpm','cli','compose'):
            p=profile()
            if change=='dockerd':p['dockerdBinarySha256']='f'*64
            elif change=='rpm':p['rpm']['release']='1.amzn2023.other'
            else:p['spec']['dockerCliSha256' if change=='cli' else 'composeCliSha256']='f'*64
            with self.subTest(change=change),self.assertRaises(q.Rejected):q._source_profile(p,a)
    def test_spec_same_version_different_git_or_package_refused(self):
        observed=M.inventory(self.d,self.directory,services=self.d.services,image_reference='source-api',image_id=FIX['IMAGE'])
        for key,change in (('engineGitCommit','a'*7),('dockerCliGitCommit','b'*7),('enginePackage',{'name':'docker','version':'25.0.16','release':'other','architecture':'x86_64'})):
            bad=copy.deepcopy(observed);bad['generator'][key]=change
            with self.subTest(key=key),self.assertRaisesRegex(q.Rejected,'GENERATOR_SOURCE_CHANGED'):
                self.session.spec_validate(bad,profile()['spec'])
            self.no_create()
    def test_runtime_package_recheck(self):
        self.cap.value['listenerBinding']['runtimeIdentity']['package']['nevraSha256']='a'*64
        with self.assertRaisesRegex(q.Rejected,'RUNTIME_PACKAGE_CHANGED'):self.runtime()
    def test_runtime_wrong_dockerd_sha(self):
        self.cap.value['listenerBinding']['runtimeIdentity']['runtime']['binarySha256']='a'*64
        self.cap.value['listenerBinding']['runtimeIdentity']['package']['fileDigest']='a'*64
        with self.assertRaisesRegex(q.Rejected,'RUNTIME_BINARY_CHANGED'):self.runtime()
    def test_full_collection_tool_digest_not_digest_of_hash_map(self):
        self.runtime()
        self.assertNotEqual(q.digest(profile()['reviewedCollectionToolSha256']),q.digest(tools()))
        self.cap.value['listenerBinding']['runtimeIdentity']['runtime']['collectionToolsSha256']=q.digest(profile()['reviewedCollectionToolSha256'])
        with self.assertRaisesRegex(q.Rejected,'NATIVE_TOOL_CHANGED'):self.runtime()
    def test_collection_tool_inode_drift(self):
        self.runtime();changed=tools();changed['/usr/bin/rpm']['identity']['inode']=999
        self.cap.value['listenerBinding']['runtimeIdentity']['runtime']['collectionToolsSha256']=q.digest(changed)
        with patch.object(self.session,'collection_tools',return_value=changed),self.assertRaisesRegex(q.Rejected,'NATIVE_TOOL_CHANGED'):self.runtime()
    def test_socket_netns_process_drift(self):
        for path in ('socketNodeSha256','networkNamespaceSha256','listenerSha256','daemonFdSha256','observationSha256'):
            self.session.initial_binding=None;self.runtime();original=copy.deepcopy(self.cap.value)
            self.cap.value['listenerBinding'][path]='a'*64
            with self.subTest(path=path),self.assertRaises(Exception):self.runtime()
            self.cap.value=original
    def test_unknown_socket_field_and_authority_refused(self):
        for key,value in (('authority',True),('unixHost','tcp://127.0.0.1:2375'),('version',True),('unknown',True)):
            bad=vfs_binding();bad[key]=value
            with self.subTest(key=key),self.assertRaises(Exception):q._closed_binding(bad,self.cap)
        for key,value in (('listenerRowCount',True),('daemonListenerFdCount',0),('unknown',True)):
            bad=vfs_binding();bad['listenerBinding'][key]=value
            with self.subTest(key=key),self.assertRaises(Exception):q._closed_binding(bad,self.cap)
    def test_full_vfs_hash_drift_not_hidden_by_same_listener(self):
        for key in q.VFS_HASHES:
            self.session.initial_binding=None;self.runtime();original=copy.deepcopy(self.cap.value)
            self.cap.value['vfsBinding'][key]='a'*64
            with self.subTest(key=key),self.assertRaises(Exception):self.runtime()
            self.cap.value=original
    def test_vfs_required_closed_kind_protocol_not_legacy(self):
        for key,value in (('protocol','OTHER'),('status','MATCH'),('unknown','a'*64)):
            bad=vfs_binding();bad['vfsBinding'][key]=value
            with self.subTest(key=key),self.assertRaises(Exception):q._closed_binding(bad,self.cap)
        with self.assertRaises(Exception):q._closed_binding(binding(),self.cap)
    def test_fixed_vfs_kernel_protocol_fixture_not_boolean(self):
        cap=self.cap;request=cap.query_bytes(12345,41,7777)
        self.assertEqual(len(request),40)
        self.assertEqual(cap.HEADER.unpack_from(request),(40,20,1,41,7777))
        self.assertEqual(cap.REQUEST.unpack_from(request,16),(1,0,0,1<<10,12345,0x42,0xffffffff,0xffffffff))
        for val in (True,0,-1,2**32):
            with self.subTest(inode=val),self.assertRaises(Exception):cap.query_bytes(val,41,7777)
    def test_builtin_only_empty_actual_inputs(self):
        p=self.session.profile;p['poolMode']='REVIEWED_BUILTIN_ZERO_INPUTS';p['spec']['defaultPoolsStatement']='UNDECLARED'
        r=binding()['runtimeIdentity'];r['cmdline'].update(defaultAddressPoolCount=0,defaultAddressPoolSha256=q.digest([]))
        self.session.pools({'status':'UNDECLARED','pools':[]},r)
        for node,key,val in (('cmdline','defaultAddressPoolCount',1),('cmdline','defaultAddressPoolSha256','b'*64),
            ('configuration','defaultAddressPoolSha256','c'*64),('configuration','defaultAddressPoolsEncoding','ARRAY')):
            bad=copy.deepcopy(r);bad[node][key]=val
            with self.subTest(node=node,key=key),self.assertRaisesRegex(q.Rejected,'POOL_SOURCE_CHANGED'):
                self.session.pools({'status':'UNDECLARED','pools':[]},bad)
    def test_explicit_pool_complete_unused_zero_input(self):
        r=binding()['runtimeIdentity'];statement={'status':'DECLARED','pools':profile()['spec']['defaultPools']}
        self.session.pools(statement,r)
        for key,val in (('defaultAddressPoolSha256','b'*64),('defaultAddressPoolCount',1),('defaultAddressPoolsEncoding','ARRAY')):
            bad=copy.deepcopy(r);bad['configuration'][key]=val
            with self.subTest(key=key),self.assertRaisesRegex(q.Rejected,'POOL_SOURCE_CHANGED'):self.session.pools(statement,bad)
    def test_explicit_config_pool_requires_cmdline_exact_zero(self):
        r=binding()['runtimeIdentity'];r['cmdline'].update(defaultAddressPoolCount=0,defaultAddressPoolSha256=q.digest([]))
        r['configuration'].update(status='OBSERVED',defaultAddressPoolsEncoding='ARRAY',defaultAddressPoolCount=1,
            defaultAddressPoolSha256=q.digest(profile()['spec']['defaultPools']))
        statement={'status':'DECLARED','pools':profile()['spec']['defaultPools']};self.session.pools(statement,r)
        r['cmdline']['defaultAddressPoolSha256']='b'*64
        with self.assertRaisesRegex(q.Rejected,'POOL_SOURCE_CHANGED'):self.session.pools(statement,r)
    def test_mock_complete_flow_closed_facts_cleanup(self):
        result=self.measure();self.assertEqual(set(result),{'measured','facts'})
        self.assertFalse(result['measured']['authority']);self.assertFalse(result['measured']['productionEligible'])
        self.assertEqual(len(self.d.removed),6)
        self.assertEqual(list((self.base/'.runtime/online-recharge-qualified-client').iterdir()),[])
        self.assertGreater(self.cap.calls,4)
    def test_complete_facts_accepted_by_fixed_constructor_schema(self):
        cm=load('minimal_qualified_constructor',HERE/'constructor.py')
        cm._configure(load('minimal_qualified_online',paths['online-recharge-scope.py']),contract);c=cm.__dict__
        result=self.measure()
        root={'producer':{},'recoveryPolicy':{},'historicalFiles':{},'anchors':{},'actual':self.d.services,
            'adminProjection':{},'configurationFiles':{},'workspaceFiles':{},'environmentFileSha256':a.sha(b''),
            'stableObservation':result['facts']['stableBefore'],'sourceArchiveBytesSha256':a.sha(b'SYNTHETIC ARCHIVE'),
            'generatorRulesSha256':q.digest(profile()['spec'])}
        c['validate_facts'](result['measured'],result['facts'],root)
    def test_environment_all_calls_no_ambient_injections(self):
        bad={'LD_PRELOAD':'SYNTHETIC_PRIVATE','LD_LIBRARY_PATH':'SYNTHETIC_PRIVATE','HTTP_PROXY':'SYNTHETIC_PRIVATE',
            'DOCKER_HOST':'tcp://attacker:2375','DOCKER_CONTEXT':'evil','COMPOSE_FILE':'evil','PATH':'evil','DATABASE_URL':'SYNTHETIC_PRIVATE'}
        with patch.dict(os.environ,bad):self.measure()
        for args,kw in self.d.calls:
            env=kw.get('env');self.assertIsNotNone(env)
            self.assertEqual(set(env),{'PATH','LANG','LC_ALL','DOCKER_CONFIG','DOCKER_HOST'})
            self.assertEqual(env['DOCKER_HOST'],q.UNIX_HOST);self.assertEqual(env['PATH'],q.IDENTITY.COLLECTION_ENV['PATH'])
            self.assertFalse(set(bad)-{'PATH','DOCKER_HOST'} & set(env))
    def test_controlled_driver_unknown_environment_refused(self):
        client=self.base/'client';client.mkdir(mode=0o700);file=client/'config.json';file.write_bytes(b'{}\n');file.chmod(0o600)
        driver=q._ControlledDriver(self.d,self.session,file)
        for field,value in (('LD_PRELOAD','x'),('HTTP_PROXY','x'),('DOCKER_CONTEXT','evil'),('DOCKER_HOST','tcp://evil')):
            env=copy.deepcopy(driver.environment);env[field]=value
            with self.subTest(field=field),self.assertRaisesRegex(q.Rejected,'CLIENT_SOURCE_CHANGED'):
                driver.run('docker','info',env=env)
    def test_arbitrary_empty_private_config_not_registered(self):
        client=self.base/'client';client.mkdir(mode=0o700);file=client/'config.json';file.write_bytes(b'{}\n');file.chmod(0o600)
        driver=q._ControlledDriver(self.d,self.session,file)
        other=self.base/'other-client';other.mkdir(mode=0o700);(other/'config.json').write_bytes(b'{}\n');(other/'config.json').chmod(0o600)
        env={**driver.environment,'DOCKER_CONFIG':str(other)}
        with self.assertRaisesRegex(q.Rejected,'CLIENT_SOURCE_CHANGED'):driver.run('docker','info',env=env)
        self.assertEqual(self.d.calls,[])
    def test_client_config_injection_and_file_replacement(self):
        client=self.base/'client';client.mkdir(mode=0o700);file=client/'config.json';file.write_bytes(b'{}\n');file.chmod(0o600)
        driver=q._ControlledDriver(self.d,self.session,file);file.write_bytes(b'{"proxies":{}}\n')
        with self.assertRaisesRegex(q.Rejected,'CLIENT_SOURCE_CHANGED'):driver.run('docker','info')
    def test_source_envfile_explicit_no_env_materialized(self):
        self.measure();source=[args for args,_ in self.d.calls if '--env-file' in args and str(self.directory/M.FILES[2]) in args]
        self.assertTrue(source)
        for path in (self.base/'.runtime').rglob('*'):
            if path.is_file():self.assertNotIn(b'CONTROL_SOURCE_',path.read_bytes())
    def test_no_raw_or_runtime_random_ids_in_source_rules(self):
        result=self.measure();raw=json.dumps(result)
        self.assertNotIn('CONTROL_SOURCE_',raw);self.assertNotIn(FIX['PRIVATE'],raw)
        self.assertNotIn('socketNodeSha256',raw);self.assertNotIn('collectionToolsSha256',raw)
        self.assertEqual(result['facts']['generator']['rulesSha256'],q.digest(profile()['spec']))
    def test_inventory_path_is_fixed_not_ambient_which(self):
        self.session.install()
        with patch.dict(os.environ,{'PATH':'/SYNTHETIC_UNTRUSTED'}):
            self.assertEqual(M.shutil.which('docker'),'/usr/bin/docker')
        self.assertIsNone(M.shutil.which('arbitrary'))
    def test_pool_runtime_drift_refused_before_create(self):
        self.cap.value['listenerBinding']['runtimeIdentity']['cmdline']['defaultAddressPoolSha256']='b'*64
        with self.assertRaises(Exception):self.measure()
        self.no_create()
    def test_source_input_hash_cannot_be_self_reported(self):
        bad=profile();bad['spec']['sourceSha256']='b'*64
        with self.assertRaises(q.Rejected):q._source_profile(bad,a)
    def test_unknown_program_rejected_before_runner(self):
        client=self.base/'client';client.mkdir(mode=0o700);file=client/'config.json';file.write_bytes(b'{}\n');file.chmod(0o600)
        driver=q._ControlledDriver(self.d,self.session,file)
        for program in ('/SYNTHETIC/docker','sh','env','curl'):
            with self.subTest(program=program),self.assertRaisesRegex(q.Rejected,'CLIENT_SOURCE_CHANGED'):driver.run(program)
        self.assertEqual(self.d.calls,[])
    def test_normalizers_and_network_guards_unchanged(self):
        self.session.install()
        for name in ('configuration','normalize','compare','ipam_rule','network_validate','reference_model'):
            if hasattr(a,name):self.assertEqual(getattr(a,name).__code__.co_filename,str(HERE/'collector.py'))
    def test_source_execution_key_interpolation_refused(self):
        client=self.base/'client';client.mkdir(mode=0o700);file=client/'config.json';file.write_bytes(b'{}\n');file.chmod(0o600)
        driver=q._ControlledDriver(self.d,self.session,file)
        (self.directory/M.FILES[1]).write_text('${PATH}')
        with self.assertRaisesRegex(q.Rejected,'CLIENT_SOURCE_CHANGED'):driver.source_environment(self.directory)



class ReviewedSourceAdmissionTests(unittest.TestCase):
    """Real Package singleton selection; only runtime collection I/O is mocked."""
    def captured(self):
        io=load('public_source_package_io',HERE/'package_io.py')
        package=io.Package(HERE,manifest)
        selected=package.load_leaf('qualified.py');selected._configure(external,pure,factory)
        return package,selected
    def test_real_package_singleton_literal_canonical_and_closed_rules(self):
        package,selected=self.captured();row=selected._reviewed_profile()
        self.assertEqual(len(selected.REVIEWED_SOURCE_TABLE),1)
        self.assertEqual(json.loads(package.raw['reviewed-source-table.json']),[row])
        self.assertEqual(selected.sha(package.raw['reviewed-source-table.json']),selected.REVIEWED_SOURCE_TABLE_SHA256)
        self.assertEqual(selected.digest(row),selected.REVIEWED_PROFILE_CANONICAL_SHA256)
        self.assertEqual(selected._source_profile(row,factory()),row)
        result=selected.reviewed_rules()
        self.assertEqual(set(result),{'spec','rulesSha256','sourceInputsSha256','sourceReviewReportSha256'})
        self.assertEqual(result['spec'],row['spec'])
        self.assertEqual(result['sourceInputsSha256'],row['spec']['sourceSha256'])
        self.assertFalse(hasattr(selected,'TABLE_BYTES'))
    def test_unbound_empty_unknown_multiple_and_missing_schema_cannot_select(self):
        package,selected=self.captured();row=selected._reviewed_profile()
        missing=copy.deepcopy(row);missing.pop('runtimeConfigurationRuleSha256')
        unknown=copy.deepcopy(row);unknown['trusted']=True
        for data in (None,b'[]\n',b'[{}]\n',json.dumps([row,row]).encode(),json.dumps([missing]).encode(),
                     json.dumps([unknown]).encode(),json.dumps([row],separators=(',',':')).encode()):
            with self.subTest(kind=type(data).__name__),patch.object(selected,'_load_base',side_effect=AssertionError('FACTORY_FORBIDDEN')):
                selected._SOURCE_TABLE_BYTES=data
                with self.assertRaisesRegex(selected.Rejected,'^SOURCE_NOT_MEASURED$'):selected.reviewed_rules()
    def test_complete_literal_drift_and_missing_profile_schema_reject(self):
        package,selected=self.captured();row=selected._reviewed_profile()
        changed=copy.deepcopy(row);changed['sourceReviewReportSha256']='0'*64
        selected.REVIEWED_SOURCE_TABLE=(changed,)
        with self.assertRaisesRegex(selected.Rejected,'^SOURCE_NOT_MEASURED$'):selected._reviewed_profile()
        for key in ('runtimeConfigurationRuleSha256','reviewedCollectionToolSha256'):
            changed=copy.deepcopy(row);changed.pop(key)
            with self.subTest(key=key),self.assertRaisesRegex(selected.Rejected,'^SOURCE_PROFILE_INVALID$'):
                selected._source_profile(changed,factory())
    def test_actual_full_endpoint_parser_rejects_missing_or_unknown_dns_field(self):
        package,selected=self.captured();row=selected._reviewed_profile();spec=row['spec']
        observed={'generator':{key:spec[key] for key in ('engineVersion','composeVersion','engineApiVersion','nativePlatform',
            'dockerCliVersion','dockerCliSha256','composeCliSha256')},
            'daemonDefaultAddressPools':{'status':'UNDECLARED','pools':[]},
            'resources':{'status':'OBSERVED','unknownNetworkFieldCount':0,'unknownVolumeFieldCount':0}}
        base=factory();self.assertEqual(base.spec_validate(observed,spec),spec)
        for mode in ('missing','unknown'):
            changed=copy.deepcopy(spec)
            if mode=='missing':changed['referenceEndpointFields'].remove('DNSNames')
            else:changed['actualEndpointFields'].append('UNREVIEWED')
            with self.subTest(mode=mode),self.assertRaisesRegex(base.Rejected,'^SOURCE_NOT_MEASURED$'):
                base.spec_validate(observed,changed)
    def test_singleton_missing_vfs_cannot_create_or_call_runner(self):
        from unittest.mock import Mock
        package,selected=self.captured()
        with tempfile.TemporaryDirectory(dir=HERE,prefix='reviewed-source-') as temporary:
            driver=SimpleNamespace(BASE=Path(temporary),run=Mock(side_effect=AssertionError('RUN_FORBIDDEN')))
            with patch.object(selected,'_load_socket',return_value=None) as vfs:
                with self.assertRaisesRegex(selected.Rejected,'^VFS_BOUND_CAPABILITY_REQUIRED$'):
                    with selected.acquisition_session(driver):self.fail('QUALIFIED')
                vfs.assert_called_once()
            driver.run.assert_not_called();self.assertEqual(list(Path(temporary).iterdir()),[])
    def test_singleton_runtime_unavailable_cleans_client_without_reference(self):
        from unittest.mock import Mock
        package,selected=self.captured()
        with tempfile.TemporaryDirectory(dir=HERE,prefix='reviewed-source-') as temporary:
            base=Path(temporary);(base/'.runtime').mkdir(mode=0o700)
            driver=SimpleNamespace(BASE=base,run=Mock(side_effect=AssertionError('RUN_FORBIDDEN')))
            with patch.object(external.socket,'runtime_daemon_socket_binding',side_effect=RuntimeError('SYNTHETIC_UNAVAILABLE')) as runtime:
                with self.assertRaisesRegex(selected.Rejected,'^QUALIFIER_UNAVAILABLE$'):
                    with selected.acquisition_session(driver):self.fail('QUALIFIED')
                runtime.assert_called_once()
            driver.run.assert_not_called()
            self.assertEqual(list((base/'.runtime/online-recharge-qualified-client').iterdir()),[])
            self.assertFalse((base/'.runtime/online-recharge-declaration-measurement').exists())

if __name__=='__main__':unittest.main(verbosity=2)
