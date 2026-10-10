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
    def test_real_identity_reader_tuples_match_and_tool_drift_rejects(self):
        # Real descriptor reads in an owned sandbox; only root ownership is
        # privately adapted to this test UID. Production reader remains uid 0.
        identity=external.identity
        sandbox=self.base/'identity-reader';(sandbox/'usr/bin').mkdir(parents=True)
        paths=('/usr/bin/systemctl','/usr/bin/rpm')
        fixture={path:b'\x7fELFCONTROL_ONLY_IDENTITY_READER_'+path.encode() for path in paths}
        for path,raw in fixture.items():
            target=sandbox/path.lstrip('/');target.write_bytes(raw);target.chmod(0o755)
        reader=identity._Reader(str(sandbox))
        selected=profile();selected['reviewedCollectionToolSha256']={path:q.sha(raw) for path,raw in fixture.items()}
        self.session=q._Session(a,selected,self.cap)
        with patch.object(identity,'_root_owned',side_effect=lambda st:st.st_uid==os.getuid()), \
             patch.object(identity,'_reader_factory',return_value=reader) as factory:
            rows=self.session.collection_tools()
            self.assertEqual(set(rows),set(paths))
            self.assertTrue(all(type(row['identity']['file']) is tuple and len(row['identity']['file'])==9
                and all(type(parent) is tuple and len(parent)==5 for parent in row['identity']['parents'])
                for row in rows.values()))
            # The strict pure JSON domain must keep rejecting the native tuples.
            with self.assertRaisesRegex(q.Rejected,'^SOURCE_PROFILE_INVALID$'):q.digest(rows)
            runtime=self.cap.value['listenerBinding']['runtimeIdentity']['runtime']
            runtime['collectionToolsSha256']=identity.fingerprint(rows)
            with self.subTest(boundary='real_reader_native_fingerprint'):
                self.assertEqual(self.runtime(),self.cap.value)
                self.assertEqual(self.runtime(),self.cap.value)
                self.assertEqual(self.session.initial_collection_tools,rows)
                self.assertGreaterEqual(factory.call_count,3)
            with self.subTest(boundary='wrong_aggregate_hash'):
                runtime['collectionToolsSha256']=q.digest(selected['reviewedCollectionToolSha256'])
                with self.assertRaisesRegex(q.Rejected,'^NATIVE_TOOL_CHANGED$'):self.runtime()
                runtime['collectionToolsSha256']=identity.fingerprint(rows)
            target=sandbox/'usr/bin/rpm'
            with self.subTest(boundary='changed_binary_bytes'):
                target.write_bytes(fixture['/usr/bin/rpm']+b'CONTROL_ONLY_CHANGED')
                with self.assertRaisesRegex(q.Rejected,'^NATIVE_TOOL_CHANGED$'):self.runtime()
                target.write_bytes(fixture['/usr/bin/rpm']);target.chmod(0o755)
            # Re-establish the local test baseline after the intentional write.
            self.session.initial_collection_tools=None;self.session.initial_binding=None
            before=self.session.collection_tools();runtime['collectionToolsSha256']=identity.fingerprint(before)
            self.runtime()
            with self.subTest(boundary='same_bytes_different_inode'):
                saved=sandbox/'usr/bin/rpm.previous';target.rename(saved)
                target.write_bytes(fixture['/usr/bin/rpm']);target.chmod(0o755)
                after=self.session.collection_tools()
                self.assertEqual(after['/usr/bin/rpm']['bytesSha256'],before['/usr/bin/rpm']['bytesSha256'])
                self.assertNotEqual(after['/usr/bin/rpm']['identity']['file'],before['/usr/bin/rpm']['identity']['file'])
                runtime['collectionToolsSha256']=identity.fingerprint(after)
                with self.assertRaisesRegex(q.Rejected,'^NATIVE_TOOL_CHANGED$'):self.runtime()
            with self.subTest(boundary='unsafe_tool_permissions'):
                target.chmod(0o777)
                with self.assertRaisesRegex(identity.Rejected,'^PERMISSIONS_INVALID$'):self.session.collection_tools()
                target.chmod(0o755)
            with self.subTest(boundary='missing_vfs_precedes_reader'):
                self.session.capability=None;factory.reset_mock()
                with self.assertRaisesRegex(q.Rejected,'^VFS_BOUND_CAPABILITY_REQUIRED$'):self.runtime()
                factory.assert_not_called()
            self.no_create()

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

class InternalQualificationDiagnosticTests(unittest.TestCase):
    def setUp(self):
        import hashlib
        from types import MethodType
        from unittest.mock import Mock
        self.q=load('internal_qualification_diagnostic',HERE/'qualified.py')
        self.pure=pure;self.base=factory();self.inventory=self.base.frozen
        self.identity=external.identity;self.listener=external.listener;self.socket=external.socket
        self.package=load('internal_diagnostic_package',HERE/'package_io.py')
        # Only a synthetic bound-method implementation is substituted. Its
        # exception types/codes are the captured package module's exact globals.
        exec('def synthetic_stable(self):\n    return None\n',self.package.__dict__)
        stable=MethodType(self.package.synthetic_stable,object())
        self.external=SimpleNamespace(identity=self.identity,listener=self.listener,socket=self.socket,
            paths={'online-recharge-daemon-socket.py':HERE.parent/'online-recharge-daemon-socket.py'},
            leaf_pins={'online-recharge-daemon-socket.py':hashlib.sha256((HERE.parent/'online-recharge-daemon-socket.py').read_bytes()).hexdigest()},
            socket_bytes=(HERE.parent/'online-recharge-daemon-socket.py').read_bytes(),assert_stable=stable)
        self.q._configure(self.external,self.pure,lambda:self.base)
        self.q._SOURCE_TABLE_BYTES=(HERE/'reviewed-source-table.json').read_bytes()
        self.profile=self.q._reviewed_profile()
        self.sandbox=ROOT/'.runtime/online-recharge-release-20261009/build/qualified-internal-diagnostic-tests'
        self.sandbox.mkdir(mode=0o700,parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=self.sandbox,prefix='owned-')
        self.root=Path(self.temp.name);(self.root/'.runtime').mkdir(mode=0o700)
        self.driver=SimpleNamespace(BASE=self.root,run=Mock(side_effect=AssertionError('ACTUAL_RUN_FORBIDDEN')))
        self.tools={p:{'bytesSha256':h,'identity':{'inode':i,'uid':0}} for i,(p,h) in enumerate(self.profile['reviewedCollectionToolSha256'].items())}
        # Existing valid synthetic VFS shape; no actual inventory or receipt is read.
        self.report=copy.deepcopy(vfs_binding())
        self.report['listenerBinding']['runtimeIdentity']['runtime']['collectionToolsSha256']=self.identity.fingerprint(self.tools)
        self.patches=[patch.object(self.socket,'runtime_daemon_socket_binding',return_value=self.report),
            patch.object(self.q._Session,'collection_tools',return_value=self.tools),
            patch.object(self.q._Session,'native_tools',return_value={'SYNTHETIC_NATIVE_TOOL':'OBSERVED'}),
            patch.object(self.base,'native_permissions',return_value=None),
            patch.object(self.inventory,'read',return_value={'id':'SYNTHETIC_DAEMON'}),
            patch.object(self.q._Session,'assert_stable',return_value=None)]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def diagnostic(self,error,stage,code,arg='QUALIFIER_UNAVAILABLE'):
        self.assertIs(type(error),self.q.Rejected)
        self.assertEqual(BaseException.args.__get__(error),(arg,))
        self.assertEqual(self.q.failure_diagnostic(error),{'stage':stage,'code':code})
        self.assertNotIn('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED',json.dumps(self.q.failure_diagnostic(error)))
    def rejected(self,stage,code,patcher=None,body=None,arg='QUALIFIER_UNAVAILABLE'):
        if patcher is not None:patcher.start()
        try:
            with self.assertRaises(self.q.Rejected) as found:
                with self.q.acquisition_session(self.driver) as session:
                    if body is not None:body(session)
            self.diagnostic(found.exception,stage,code,arg)
            self.driver.run.assert_not_called()
            client=self.root/'.runtime/online-recharge-qualified-client'
            if client.exists() and stage not in ('CLIENT_CONFIG','CLEANUP'):self.assertEqual(list(client.iterdir()),[])
            return found.exception
        finally:
            if patcher is not None:patcher.stop()
    def test_happy_context_real_private_empty_file_and_cleanup(self):
        with self.q.acquisition_session(self.driver) as session:
            file=session.runner.config
            self.assertEqual(file.read_bytes(),b'{}\n');self.assertEqual(file.stat().st_mode&0o777,0o600)
            self.assertIsNone(self.q.failure_diagnostic(self.q.Rejected('QUALIFIER_UNAVAILABLE')))
        self.assertFalse(file.parent.exists());self.driver.run.assert_not_called()
    def test_profile_fixed_rejection_args_retained(self):
        self.rejected('QUALIFIER_PROFILE','SOURCE_NOT_MEASURED',patch.object(self.q,'_reviewed_profile',side_effect=self.q.Rejected('SOURCE_NOT_MEASURED')),arg='SOURCE_NOT_MEASURED')
    def test_factory_exact_type_error(self):
        self.rejected('FACTORY','TYPE_ERROR',patch.object(self.q,'_load_base',side_effect=TypeError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED')))
    def test_factory_bound_package_exact_code(self):
        self.rejected('FACTORY','PACKAGE_FILE_CHANGED',patch.object(self.q,'_load_base',side_effect=self.package.Rejected('PACKAGE_FILE_CHANGED')))
    def test_session_exact_attribute_error(self):
        self.rejected('SESSION','ATTRIBUTE_ERROR',patch.object(self.q,'_Session',side_effect=AttributeError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED')))
    def test_install_original_fixed_arg_retained(self):
        self.rejected('INSTALL','CLIENT_SOURCE_CHANGED',patch.object(self.q._Session,'install',side_effect=self.q.Rejected('CLIENT_SOURCE_CHANGED')),arg='CLIENT_SOURCE_CHANGED')
    def test_vfs_source_bound_package_failure(self):
        from types import MethodType
        exec("def synthetic_failed(self):\n    raise Rejected('PACKAGE_SOURCE_CHANGED')\n",self.package.__dict__)
        self.external.assert_stable=MethodType(self.package.synthetic_failed,object())
        self.rejected('VFS_SOURCE','PACKAGE_SOURCE_CHANGED')
    def test_directory_exact_permission_error(self):
        original=Path.mkdir
        def denied(path,*args,**kwargs):
            if path.name=='online-recharge-qualified-client':raise PermissionError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED')
            return original(path,*args,**kwargs)
        self.rejected('CLIENT_DIRECTORY','PERMISSION_ERROR',patch.object(Path,'mkdir',denied))
    def test_config_exact_os_error(self):
        original=Path.write_bytes
        def denied(path,raw):
            if path.name=='config.json':raise OSError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED')
            return original(path,raw)
        self.rejected('CLIENT_CONFIG','OS_ERROR',patch.object(Path,'write_bytes',denied))
    def test_client_real_bound_collector_file_error(self):
        self.rejected('CLIENT_CONFIG','SOURCE_FILE_INVALID',patch.object(self.base,'file_seal',side_effect=self.base.Rejected('SOURCE_FILE_INVALID')))
    def test_runtime_vfs_exact_bound_socket_code(self):
        self.rejected('RUNTIME_VFS','VFS_DIAG_UNAVAILABLE',patch.object(self.socket,'runtime_daemon_socket_binding',side_effect=self.socket.Rejected('VFS_DIAG_UNAVAILABLE')))
    def test_runtime_vfs_exact_bound_identity_code(self):
        self.rejected('RUNTIME_VFS','RUNTIME_DRIFT',patch.object(self.socket,'runtime_daemon_socket_binding',side_effect=self.identity.Rejected('RUNTIME_DRIFT')))
    def test_collection_tools_bound_identity_permission(self):
        self.rejected('COLLECTION_TOOLS','PERMISSIONS_INVALID',patch.object(self.q._Session,'collection_tools',side_effect=self.identity.Rejected('PERMISSIONS_INVALID')))
    def test_full_identity_fingerprint_accepts_tuple_without_loosening_pure_schema(self):
        rows=copy.deepcopy(self.tools)
        for row in rows.values():row['identity']={'file':tuple(range(9)),'parents':[tuple(range(5))]}
        expected=self.identity.fingerprint(rows)
        self.report['listenerBinding']['runtimeIdentity']['runtime']['collectionToolsSha256']=expected
        with self.assertRaisesRegex(self.q.Rejected,'^SOURCE_PROFILE_INVALID$'):self.q.digest(rows)
        with patch.object(self.q._Session,'collection_tools',return_value=rows):
            with self.q.acquisition_session(self.driver) as session:
                self.assertEqual(self.identity.fingerprint(rows),expected)
                self.assertIsNotNone(session.runner)
        self.assertEqual(list((self.root/'.runtime/online-recharge-qualified-client').iterdir()),[])
        self.driver.run.assert_not_called()
    def test_native_permissions_bound_collector_code(self):
        self.rejected('NATIVE_PERMISSIONS','CLI_SOURCE_CHANGED',patch.object(self.base,'native_permissions',side_effect=self.base.Rejected('CLI_SOURCE_CHANGED')))
    def test_native_tools_exact_os_error(self):
        self.rejected('NATIVE_TOOLS','OS_ERROR',patch.object(self.q._Session,'native_tools',side_effect=FileNotFoundError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED')))
    def test_daemon_info_exact_type_error(self):
        self.rejected('DAEMON_INFO','TYPE_ERROR',patch.object(self.inventory,'read',side_effect=TypeError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED')))
    def test_stability_failure_before_yield(self):
        self.rejected('STABILITY','DAEMON_CHANGED',patch.object(self.q._Session,'assert_stable',side_effect=self.q.Rejected('DAEMON_CHANGED')),arg='DAEMON_CHANGED')
    def test_body_exception_bare_private_reraise_and_real_cleanup(self):
        error=ValueError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED')
        session=self.q._Session(self.base,self.profile,self.socket);session._diagnostic_state=self.q._DiagnosticState();session._diagnostic_state.bind_base(self.base)
        with self.assertRaises(ValueError) as found:
            with self.q._acquisition_context(self.driver,session):raise error
        self.assertIs(found.exception,error)
        self.assertEqual(session._diagnostic_state.first,('YIELD','UNKNOWN'))
        self.assertEqual(list((self.root/'.runtime/online-recharge-qualified-client').iterdir()),[])
    def test_public_body_keeps_original_unavailable_arg(self):
        def body(_):raise ValueError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED')
        self.rejected('YIELD','UNKNOWN',body=body)
    def test_post_yield_stability_failure(self):
        with patch.object(self.q._Session,'assert_stable',side_effect=[None,self.q.Rejected('SOCKET_BINDING_CHANGED')]):
            self.rejected('STABILITY','SOCKET_BINDING_CHANGED',arg='SOCKET_BINDING_CHANGED')
    def test_cleanup_failure_is_not_suppressed(self):
        with patch.object(self.q._Session,'remove_deferred',side_effect=PermissionError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED')):
            self.rejected('CLEANUP','PERMISSION_ERROR')
    def test_first_inner_failure_preserved_before_cleanup(self):
        with patch.object(self.q._Session,'native_tools',side_effect=TypeError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED')):
            with patch.object(self.q._Session,'remove_deferred',side_effect=PermissionError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED')):
                error=self.rejected('CLEANUP','PERMISSION_ERROR')
                self.assertEqual(self.q.failure_diagnostic(error)['stage'],'CLEANUP')
        # Original inner reason remains retained in the private state, while
        # actual cleanup exception still rejects rather than yielding success.
        state=self.q._DiagnosticState();state.stage='NATIVE_TOOLS';state.capture(TypeError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED'))
        state.stage='CLEANUP';state.capture(PermissionError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED'),cleanup=True)
        self.assertEqual(state.first,('NATIVE_TOOLS','TYPE_ERROR'));self.assertEqual(state.cleanup,('CLEANUP','PERMISSION_ERROR'))
    def test_secret_magic_exception_does_not_execute_str_or_args(self):
        class SecretError(RuntimeError):
            def __str__(self):raise AssertionError('STR_EXECUTED')
            @property
            def args(self):raise AssertionError('ARGS_EXECUTED')
        self.rejected('RUNTIME_VFS','UNKNOWN',patch.object(self.socket,'runtime_daemon_socket_binding',side_effect=SecretError('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED')))
    def test_foreign_same_code_and_exact_subclass_are_not_accepted(self):
        class Subclass(self.socket.Rejected):pass
        for error,expected in ((RuntimeError('VFS_DIAG_UNAVAILABLE'),'RUNTIME_ERROR'),(Subclass('VFS_DIAG_UNAVAILABLE'),'UNKNOWN')):
            with self.subTest(type=type(error).__name__):
                self.rejected('RUNTIME_VFS',expected,patch.object(self.socket,'runtime_daemon_socket_binding',side_effect=error))
    def test_malformed_bound_args_cannot_claim_fixed_code(self):
        class HashBomb(str):
            def __hash__(self):raise AssertionError('HASH_EXECUTED')
        for args in (('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED',),('RUNTIME_DRIFT','SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED'),(HashBomb('RUNTIME_DRIFT'),),()):
            with self.subTest(count=len(args)):
                self.rejected('RUNTIME_VFS','UNKNOWN',patch.object(self.socket,'runtime_daemon_socket_binding',side_effect=self.identity.Rejected(*args)))
    def test_getter_rejects_subclass_shadow_types_and_malicious_marker(self):
        class Subclass(self.q.Rejected):pass
        class HashBomb(str):
            def __hash__(self):raise AssertionError('HASH_EXECUTED')
        for value in (['YIELD','UNKNOWN'],('YIELD',True),('YIELD',HashBomb('UNKNOWN')),('YIELD','MATCH'),('NEW_STAGE','UNKNOWN'),('YIELD','UNKNOWN','x')):
            error=self.q.Rejected('QUALIFIER_UNAVAILABLE');error._qualified_failure=value
            self.assertIsNone(self.q.failure_diagnostic(error))
        error=Subclass('QUALIFIER_UNAVAILABLE');error._qualified_failure=('YIELD','UNKNOWN')
        self.assertIsNone(self.q.failure_diagnostic(error))
        for args in ((HashBomb('QUALIFIER_UNAVAILABLE'),),('QUALIFIER_UNAVAILABLE','SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED'),('SYNTHETIC_DIAGNOSTIC_SECRET_NEVER_PUBLISHED',),()):
            error=self.q.Rejected(*args);error._qualified_failure=('YIELD','UNKNOWN')
            self.assertIsNone(self.q.failure_diagnostic(error))
    def test_diagnostic_binding_unknown_codes_rejected(self):
        class Foreign(RuntimeError):pass
        self.assertIsNone(self.q._diagnostic_binding(SimpleNamespace(Rejected=Foreign,CODES=frozenset({'MATCH'}))))
        state=self.q._DiagnosticState();state.stage='FACTORY';state.capture(Foreign('PACKAGE_FILE_CHANGED'))
        self.assertEqual(state.first,('FACTORY','UNKNOWN'))


if __name__=='__main__':unittest.main(verbosity=2)
