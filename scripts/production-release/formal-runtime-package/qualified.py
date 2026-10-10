"""Independent minimal runtime derivation; imports perform no collection."""
import copy
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
from types import MappingProxyType,SimpleNamespace,ModuleType
import uuid

HERE=Path(__file__).resolve().parent
REVIEWED_SOURCE_TABLE_SHA256='021dc4e4e54cbffe84200c41abc938b761383dbe81e3735f4ed609433da589c4'
REVIEWED_PROFILE_CANONICAL_SHA256='2e459113762e616f2007f1bc6328b25b4e13d8abdffc4ea9e556ea48cfda4dea'
_FIXED_REVIEWED_PROFILE={'dockerdBinarySha256': '05ba54e4ba99a3018891bc190f8be6ccdb2d483b4da715140f34ad73c5d6a1f3',
 'kind': 'ENGINE25_RUNTIME_QUALIFICATION_PROFILE_V1',
 'poolMode': 'REVIEWED_BUILTIN_ZERO_INPUTS',
 'reviewedCollectionToolSha256': {'/usr/bin/rpm': '412059160caea91ba8a32506fb60b17bb2755f1b13bce6b3469c875443e12516',
                                  '/usr/bin/systemctl': 'c6becb0141c72c25c89e9ac626606d5b625104c1d9a82b12a12062ea29b9a95b'},
 'rpm': {'architecture': 'x86_64',
         'epoch': '0',
         'name': 'docker',
         'release': '1.amzn2023.0.4',
         'version': '25.0.16'},
 'runtimeConfigurationRuleSha256': '22d1fe523e1d12760491ff1bcb9598b9b27b0b42b6df80181509b64208f1e909',
 'sourceInputs': {'binaryRpmSha256': '6aea3822bcd5494f5067b9750c60976684b55e8ef51be4945189774f8f02b273',
                  'cliCommit': '0bab007417226f0c43a897216c4e40471b9d70d1',
                  'cliSourceArchiveSha256': '25c98349fb669054b051beb91235a5041a195bbdbefaaf14930a2f1ca152bf06',
                  'completePatchReviewSha256': 'e71029fb56ee736d4993a66f8215019d2d4eb89eba56bc0728587021e04cae89',
                  'composeAssetSha256': 'c57ab918abd5b05ca7e7d0f275875dd1330a695074f309dc9eab1b49efafcd4b',
                  'engineCommit': '6fdf0a663f15d71b6944cb0b2bc3abac221ff15c',
                  'enginePatchSeriesSha256': '859aeabb9f6b7add1603f67a83495e4e17459545536ff73a2e2deb31cb469ec4',
                  'engineSourceArchiveSha256': 'e4b09862eca79992b4a11df0f7f661d364949637a71560281a5321f8985c5971',
                  'officialFileTableSha256': '3f72add415bd70975840a51024d9065308f60c054d791819c192e859aaaad122',
                  'poolSourceReviewSha256': '81d1315cbc648ad83fcdb566093d389c04b87b69641e84c0bd3e7992bf6f2965',
                  'srpmSha256': '8a26cc9bf2a2188c5641a6aac791ae5b0188b03a62f43912df83de96b4cc0f3e',
                  'unitPatchSeriesSha256': '51fb0d117049c18d2c9739256bb62d87650b655de32e517469c2f4a8b97a587f'},
 'sourceReviewReportSha256': '75d5c22723c703cc788cfec9dcdc7da6fe288fa626fc21737cd936f1b2312472',
 'spec': {'actualEndpointFields': ['Aliases',
                                   'DNSNames',
                                   'DriverOpts',
                                   'EndpointID',
                                   'Gateway',
                                   'GlobalIPv6Address',
                                   'GlobalIPv6PrefixLen',
                                   'IPAMConfig',
                                   'IPAddress',
                                   'IPPrefixLen',
                                   'IPv6Gateway',
                                   'Links',
                                   'MacAddress',
                                   'NetworkID'],
          'composeCliSha256': 'c57ab918abd5b05ca7e7d0f275875dd1330a695074f309dc9eab1b49efafcd4b',
          'composePath': '/usr/libexec/docker/cli-plugins/docker-compose',
          'composeVersion': '5.5.0',
          'defaultPools': [{'base': '172.17.0.0/16', 'size': 16},
                           {'base': '172.18.0.0/16', 'size': 16},
                           {'base': '172.19.0.0/16', 'size': 16},
                           {'base': '172.20.0.0/14', 'size': 16},
                           {'base': '172.24.0.0/14', 'size': 16},
                           {'base': '172.28.0.0/14', 'size': 16},
                           {'base': '192.168.0.0/16', 'size': 20}],
          'defaultPoolsStatement': 'UNDECLARED',
          'dockerCliSha256': 'bd00a70e8981680dd96f2d923e85a43644e87a7b998a83fe8eb8f5b318a6e594',
          'dockerCliVersion': '25.0.14',
          'dockerPath': '/usr/bin/docker',
          'enableIpv4Field': 'ABSENT',
          'engineApiVersion': '1.44',
          'engineVersion': '25.0.16',
          'kind': 'FROZEN_PRODUCTION_GENERATOR_V2',
          'nativePlatform': 'linux/x86_64',
          'networkCreatorVersion': '5.5.0',
          'networkFields': ['Attachable',
                            'ConfigFrom',
                            'ConfigOnly',
                            'Containers',
                            'Created',
                            'Driver',
                            'EnableIPv6',
                            'IPAM',
                            'Id',
                            'Ingress',
                            'Internal',
                            'Labels',
                            'Name',
                            'Options',
                            'Scope'],
          'poolSourceSha256': '81d1315cbc648ad83fcdb566093d389c04b87b69641e84c0bd3e7992bf6f2965',
          'referenceEndpointFields': ['Aliases',
                                      'DNSNames',
                                      'DriverOpts',
                                      'EndpointID',
                                      'Gateway',
                                      'GlobalIPv6Address',
                                      'GlobalIPv6PrefixLen',
                                      'IPAMConfig',
                                      'IPAddress',
                                      'IPPrefixLen',
                                      'IPv6Gateway',
                                      'Links',
                                      'MacAddress',
                                      'NetworkID'],
          'referenceGateway': 'FIRST_ADDRESS',
          'referenceIpamRowFields': ['Gateway', 'Subnet'],
          'referenceNetworkPolicy': 'OWNED_INTERNAL_IPV4_DEFAULT_POOL_V1',
          'referenceSubnetPrefix': None,
          'renderedDependencies': {'media-resolver': {'condition': 'service_healthy',
                                                      'required': True},
                                   'migrate': {'condition': 'service_completed_successfully',
                                               'required': True}},
          'renderedExternalNetworkExtra': {'ipam': {}},
          'renderedNetworkEntry': {},
          'renderedVolumeRow': {'source': 'auto_registration_data',
                                'target': '/app/.runtime/auto-registration',
                                'type': 'volume',
                                'volume': {}},
          'sourceIpamRowFields': ['Gateway', 'Subnet'],
          'sourceSha256': 'e931bee86deda110beea85be444afb82119f62b37be7f6d8b81f683621b8c4f9',
          'volumeCreatorVersion': '5.5.0',
          'volumeFields': ['CreatedAt',
                           'Driver',
                           'Labels',
                           'Mountpoint',
                           'Name',
                           'Options',
                           'Scope']},
 'zeroConfigurationEncodings': ['ABSENT']}
REVIEWED_SOURCE_TABLE=(_FIXED_REVIEWED_PROFILE,)
_SOURCE_TABLE_BYTES=None
REVIEWED_GENERATORS={}
IDENTITY=None
DERIVE=None
_EXTERNAL=None
_FACTORY=None

def _configure(external,pure,factory):
    global IDENTITY,DERIVE,_EXTERNAL,_FACTORY,VFS_SHA
    _EXTERNAL=external;IDENTITY=external.identity;DERIVE=pure;_FACTORY=factory
    VFS_SHA=external.leaf_pins['online-recharge-daemon-socket.py']

def _load_base():return _FACTORY()
def _load_socket():return _EXTERNAL.socket
def _load_legacy_socket_inventory():return _EXTERNAL.listener

VFS_SHA='eb72f3e3a4c57538329fb90f6ad39ed639d4f41c415eb4638b06936e0fe5efec'
UNIX_HOST='unix:///var/run/docker.sock'
ENGINE_GIT='6fdf0a6'
CLI_GIT='0bab007'
CLI_FULL_GIT='0bab007417226f0c43a897216c4e40471b9d70d1'
DOCKER_SHA='bd00a70e8981680dd96f2d923e85a43644e87a7b998a83fe8eb8f5b318a6e594'
DOCKERD_SHA='05ba54e4ba99a3018891bc190f8be6ccdb2d483b4da715140f34ad73c5d6a1f3'
COMPOSE_SHA='c57ab918abd5b05ca7e7d0f275875dd1330a695074f309dc9eab1b49efafcd4b'
BINARY_RPM_SHA='6aea3822bcd5494f5067b9750c60976684b55e8ef51be4945189774f8f02b273'
SRPM_SHA='8a26cc9bf2a2188c5641a6aac791ae5b0188b03a62f43912df83de96b4cc0f3e'
ENGINE_ARCHIVE_SHA='e4b09862eca79992b4a11df0f7f661d364949637a71560281a5321f8985c5971'
RPM={'name':'docker','epoch':'0','version':'25.0.16','release':'1.amzn2023.0.4','architecture':'x86_64'}
RPM_PACKAGE={k:v for k,v in RPM.items() if k!='epoch'}
SRPM_NAME='docker-25.0.16-1.amzn2023.0.4.src.rpm'
SOURCE_KEYS=('srpmSha256','engineSourceArchiveSha256','engineCommit','enginePatchSeriesSha256',
    'unitPatchSeriesSha256','cliCommit','cliSourceArchiveSha256','composeAssetSha256',
    'binaryRpmSha256','officialFileTableSha256','poolSourceReviewSha256','completePatchReviewSha256')
PROFILE_KEYS=('kind','spec','sourceInputs','sourceReviewReportSha256','poolMode','zeroConfigurationEncodings',
    'runtimeConfigurationRuleSha256','dockerdBinarySha256','rpm','reviewedCollectionToolSha256')
VFS_KEYS=('version','kind','status','authority','productionEligible','proofConstructed','rawOutputSuppressed','unixHost','listenerBinding','vfsBinding')
VFS_HASHES=('kernelSocketInodeSha256','vfsInodeSha256','vfsDeviceSha256','kernelCookieSha256','vfsIdentitySha256','nodeIdentitySha256','responseIdentitySha256')
BINDING_KEYS=('version','kind','status','authority','productionEligible','proofConstructed','rawOutputSuppressed',
    'unixHost','runtimeIdentity','socketNodeSha256','networkNamespaceSha256','listenerSha256','daemonFdSha256',
    'observationSha256','daemonListenerFdCount','listenerRowCount','socketActivationCreatorStatus','exclusiveAcceptingProcessStatus')
CODES=frozenset(('SOURCE_NOT_MEASURED','QUALIFIER_FROZEN_INPUT_CHANGED','SOURCE_PROFILE_INVALID',
    'RUNTIME_CAPABILITY_REQUIRED','VFS_BOUND_CAPABILITY_REQUIRED','RUNTIME_IDENTITY_INVALID','RUNTIME_PACKAGE_CHANGED','RUNTIME_BINARY_CHANGED',
    'SOCKET_BINDING_INVALID','SOCKET_BINDING_CHANGED','GENERATOR_SOURCE_CHANGED','DAEMON_CHANGED',
    'NATIVE_TOOL_CHANGED','POOL_SOURCE_CHANGED','CLIENT_SOURCE_CHANGED','QUALIFIER_UNAVAILABLE'))
HEX=re.compile('[a-f0-9]{64}\\Z')

class Rejected(RuntimeError):pass

def need(ok,code='SOURCE_PROFILE_INVALID'):
    if not ok:raise Rejected(code)

def digest(value):
    try:return hashlib.sha256(DERIVE.canonical(value)).hexdigest()
    except Exception:raise Rejected('SOURCE_PROFILE_INVALID') from None

def sha(value):return hashlib.sha256(value.encode() if type(value) is str else value).hexdigest()

def exact(value,keys):
    need(type(value) is dict and set(value)==set(keys));digest(value);return value

def hash_fields(value,keys):
    need(all(type(value[k]) is str and HEX.fullmatch(value[k]) for k in keys))

def _source_profile(profile,base):
    exact(profile,PROFILE_KEYS)
    need(profile['kind']=='ENGINE25_RUNTIME_QUALIFICATION_PROFILE_V1')
    source=exact(profile['sourceInputs'],SOURCE_KEYS)
    hash_fields(source,[k for k in SOURCE_KEYS if k.endswith('Sha256')])
    need(source['srpmSha256']==SRPM_SHA and source['engineSourceArchiveSha256']==ENGINE_ARCHIVE_SHA
        and type(source['engineCommit']) is str and re.fullmatch('6fdf0a6[a-f0-9]{33}',source['engineCommit'])
        and source['cliCommit']==CLI_FULL_GIT and source['composeAssetSha256']==COMPOSE_SHA
        and source['binaryRpmSha256']==BINARY_RPM_SHA)
    # Hash syntax alone is NOT source qualification: the entire profile can only
    # be selected from the one fixed immutable reviewed table; no caller admission.
    hash_fields(profile,('sourceReviewReportSha256','runtimeConfigurationRuleSha256','dockerdBinarySha256'))
    need(profile['dockerdBinarySha256']==DOCKERD_SHA and profile['rpm']==RPM)
    need(profile['poolMode'] in ('REVIEWED_BUILTIN_ZERO_INPUTS','REVIEWED_EXPLICIT_COMPLETE_INPUTS'))
    need(profile['zeroConfigurationEncodings'] in (['ABSENT'],['ABSENT','ARRAY_EMPTY']))
    exact(profile['reviewedCollectionToolSha256'],('/usr/bin/systemctl','/usr/bin/rpm'))
    hash_fields(profile['reviewedCollectionToolSha256'],('/usr/bin/systemctl','/usr/bin/rpm'))
    spec=exact(profile['spec'],base.SPEC_KEYS)
    need(spec['sourceSha256']==digest(source) and spec['poolSourceSha256']==source['poolSourceReviewSha256']
        and spec['engineVersion']=='25.0.16' and spec['engineApiVersion']=='1.44'
        and spec['dockerCliVersion']=='25.0.14' and spec['composeVersion']=='5.5.0'
        and spec['nativePlatform']=='linux/x86_64' and spec['dockerPath']=='/usr/bin/docker'
        and spec['composePath']=='/usr/libexec/docker/cli-plugins/docker-compose'
        and spec['dockerCliSha256']==DOCKER_SHA and spec['composeCliSha256']==COMPOSE_SHA)
    return copy.deepcopy(profile)

def _closed_listener(value,capability):
    exact(value,BINDING_KEYS)
    need(capability.validate_binding(value)==value,'SOCKET_BINDING_INVALID')
    need(type(value['version']) is int and value['version']==1
        and value['kind']=='DOCKERD_FIXED_UNIX_SOCKET_BINDING' and value['status']=='LISTENER_HELD_BY_RUNTIME_DAEMON'
        and value['unixHost']==UNIX_HOST and all(value[k] is False for k in ('authority','productionEligible','proofConstructed'))
        and value['rawOutputSuppressed'] is True and type(value['listenerRowCount']) is int and value['listenerRowCount']==1
        and type(value['daemonListenerFdCount']) is int and 1<=value['daemonListenerFdCount']<=8
        and value['socketActivationCreatorStatus']=='NOT_MEASURED'
        and value['exclusiveAcceptingProcessStatus']=='NOT_MEASURED','SOCKET_BINDING_INVALID')
    hash_fields(value,('socketNodeSha256','networkNamespaceSha256','listenerSha256','daemonFdSha256','observationSha256'))
    try:IDENTITY.validate_runtime_identity(value['runtimeIdentity'])
    except Exception:raise Rejected('RUNTIME_IDENTITY_INVALID') from None
    return value

def _closed_binding(value,capability):
    exact(value,VFS_KEYS)
    need(capability.validate_binding(value)==value,'SOCKET_BINDING_INVALID')
    need(type(value['version']) is int and value['version']==2
        and value['kind']=='DOCKERD_FIXED_UNIX_VFS_BINDING' and value['status']=='VFS_BOUND_TO_RUNTIME_DAEMON'
        and value['unixHost']==UNIX_HOST and all(value[k] is False for k in ('authority','productionEligible','proofConstructed'))
        and value['rawOutputSuppressed'] is True,'VFS_BOUND_CAPABILITY_REQUIRED')
    row=exact(value['vfsBinding'],(*VFS_HASHES,'protocol','status'))
    need(row['protocol']=='AF_NETLINK_NETLINK_SOCK_DIAG_UNIX_DIAG_VFS' and row['status']=='EXACT_VFS_MATCH','SOCKET_BINDING_INVALID')
    hash_fields(row,VFS_HASHES)
    _closed_listener(value['listenerBinding'],_load_legacy_socket_inventory())
    return value

class _Session:
    """Private immutable per-measure closure; not a public source admission API."""
    def __init__(self,base,profile,capability):
        self.base=base;self.profile=_source_profile(copy.deepcopy(profile),base)
        self.profile_sha=digest(self.profile);self.capability=capability
        self.initial_binding=None;self.initial_tools=None;self.initial_collection_tools=None;self.daemon_sha=None;self.environment=None;self.client_seals={};self.runner=None;self.deferred=[]
        self.old_spec=base.spec_validate;self.old_permissions=base.native_permissions
        self.old_client=base.controlled_client
    def native_tools(self):
        reader=IDENTITY._reader_factory();rows={}
        for path in ('/usr/bin/docker','/usr/libexec/docker/cli-plugins/docker-compose'):
            raw,identity=reader.read(path,128*1024**2,executable=True)
            rows[path]={'sha256':sha(raw),'identity':identity}
        need(rows['/usr/bin/docker']['sha256']==DOCKER_SHA
            and rows['/usr/libexec/docker/cli-plugins/docker-compose']['sha256']==COMPOSE_SHA,'NATIVE_TOOL_CHANGED')
        return rows
    def collection_tools(self):
        reader=IDENTITY._reader_factory();rows={}
        for path,expected in self.profile['reviewedCollectionToolSha256'].items():
            raw,identity=reader.read(path,128*1024**2,executable=True)
            need(sha(raw)==expected,'NATIVE_TOOL_CHANGED')
            rows[path]={'bytesSha256':sha(raw),'identity':identity}
        return rows
    def require_vfs(self):
        # Only the sealed VFS v2 module loaded by public measure may reach here.
        # Private tests mock only its collector I/O, never report validation.
        need(self.capability is not None and getattr(self.capability,'__file__',None)==str(_EXTERNAL.paths['online-recharge-daemon-socket.py'])
            and self.capability is _EXTERNAL.socket and type(_EXTERNAL.socket_bytes) is bytes
            and sha(_EXTERNAL.socket_bytes)==VFS_SHA,'VFS_BOUND_CAPABILITY_REQUIRED')
        _EXTERNAL.assert_stable()
    def runtime(self,d):
        self.require_vfs()
        need(self.capability is not None,'RUNTIME_CAPABILITY_REQUIRED')
        value=_closed_binding(self.capability.runtime_daemon_socket_binding(d),self.capability)
        runtime=value['listenerBinding']['runtimeIdentity'];p=self.profile
        need(runtime['runtime']['binarySha256']==p['dockerdBinarySha256'],'RUNTIME_BINARY_CHANGED')
        rpm=runtime['package']
        need(rpm['name']=='docker' and rpm['nevraSha256']==digest(RPM)
            and rpm['sourceRpmSha256']==sha(SRPM_NAME) and rpm['fileDigest']==DOCKERD_SHA,'RUNTIME_PACKAGE_CHANGED')
        tools=self.collection_tools()
        need(runtime['runtime']['collectionToolsSha256']==digest(tools),'NATIVE_TOOL_CHANGED')
        if self.initial_collection_tools is None:self.initial_collection_tools=copy.deepcopy(tools)
        else:need(tools==self.initial_collection_tools,'NATIVE_TOOL_CHANGED')
        if self.initial_binding is None:self.initial_binding=copy.deepcopy(value)
        else:
            self.capability.assert_same_binding(self.initial_binding,value)
            need(value==self.initial_binding,'SOCKET_BINDING_CHANGED')
        return value
    def pools(self,statement,runtime):
        p=self.profile;spec=p['spec'];args=runtime['cmdline'];config=runtime['configuration'];expected=spec['defaultPools']
        need(statement['status']==spec['defaultPoolsStatement'] and statement['status'] in ('DECLARED','UNDECLARED'),'POOL_SOURCE_CHANGED')
        if p['poolMode']=='REVIEWED_BUILTIN_ZERO_INPUTS':
            encoding=config['defaultAddressPoolsEncoding']
            expected_config=digest(None) if encoding=='ABSENT' else digest([])
            need(args['defaultAddressPoolCount']==0 and args['defaultAddressPoolSha256']==digest([])
                and config['defaultAddressPoolCount']==0
                and (encoding=='ABSENT' and 'ABSENT' in p['zeroConfigurationEncodings']
                    or encoding=='ARRAY' and 'ARRAY_EMPTY' in p['zeroConfigurationEncodings'])
                and config['defaultAddressPoolSha256']==expected_config
                and statement['status']=='UNDECLARED' and statement['pools']==[], 'POOL_SOURCE_CHANGED')
        else:
            argc=args['defaultAddressPoolCount'];cfgc=config['defaultAddressPoolCount']
            encoding=config['defaultAddressPoolsEncoding']
            zero_config=(cfgc==0 and (encoding=='ABSENT' and 'ABSENT' in p['zeroConfigurationEncodings']
                and config['defaultAddressPoolSha256']==digest(None) or encoding=='ARRAY'
                and 'ARRAY_EMPTY' in p['zeroConfigurationEncodings'] and config['defaultAddressPoolSha256']==digest([])))
            zero_args=(argc==0 and args['defaultAddressPoolSha256']==digest([]))
            need(statement['status']=='DECLARED' and statement['pools']==expected
                and (argc==len(expected)>0 and zero_config and args['defaultAddressPoolSha256']==digest(expected)
                    or cfgc==len(expected)>0 and encoding=='ARRAY' and zero_args
                    and config['defaultAddressPoolSha256']==digest(expected)), 'POOL_SOURCE_CHANGED')
        return True # internal predicate derived from actual runtime+reviewed row
    def spec_validate(self,observed,spec):
        need(digest(self.profile)==self.profile_sha and spec==self.profile['spec'],'SOURCE_PROFILE_INVALID')
        g=observed['generator']
        need(g['engineGitCommit']==ENGINE_GIT and g['dockerCliGitCommit']==CLI_GIT
            and g['enginePackage']==RPM_PACKAGE and g['dockerCliPackage']==RPM_PACKAGE,'GENERATOR_SOURCE_CHANGED')
        checked=self.old_spec(observed,spec)
        # No mutation follows before fixed socket + actual native CLI qualification.
        return checked
    def generator_still_same(self,d,environment,spec,daemon_sha):
        need(spec==self.profile['spec'] and digest(self.profile)==self.profile_sha,'SOURCE_PROFILE_INVALID')
        need(type(environment) is dict and set(environment)=={'PATH','LANG','LC_ALL','DOCKER_CONFIG','DOCKER_HOST'}
            and environment['DOCKER_HOST']==UNIX_HOST and environment['PATH']==IDENTITY.COLLECTION_ENV['PATH']
            and environment['LANG']==environment['LC_ALL']=='C','CLIENT_SOURCE_CHANGED')
        before=self.runtime(d);self.old_permissions(spec);tools=self.native_tools()
        if self.initial_tools is None:self.initial_tools=copy.deepcopy(tools)
        else:need(tools==self.initial_tools,'NATIVE_TOOL_CHANGED')
        info=self.base.frozen.read(d,spec['dockerPath'],'info','--format',self.base.frozen.INFO_FORMAT,env=environment)
        versions=self.base.frozen.read(d,spec['dockerPath'],'version','--format','{{json .}}',env=environment)
        need(sha(info['id'])==daemon_sha and info['serverVersion']=='25.0.16'
            and info['osType']+'/'+info['architecture']=='linux/x86_64','DAEMON_CHANGED')
        need(versions['Server']['Version']=='25.0.16' and versions['Server']['ApiVersion']=='1.44'
            and versions['Server'].get('GitCommit')==ENGINE_GIT and versions['Client']['Version']=='25.0.14'
            and versions['Client'].get('GitCommit')==CLI_GIT
            and d.run(spec['composePath'],'version','--short',env=environment,timeout=30).strip()=='5.5.0',
            'GENERATOR_SOURCE_CHANGED')
        statement=self.base.frozen.pools_statement(info['defaultAddressPools'])
        self.pools(statement,before['listenerBinding']['runtimeIdentity'])
        need(self.native_tools()==tools,'NATIVE_TOOL_CHANGED')
        after=self.runtime(d)
        self.capability.assert_same_binding(before,after);need(before==after,'SOCKET_BINDING_CHANGED')
        if self.daemon_sha is None:self.daemon_sha=daemon_sha
        else:need(self.daemon_sha==daemon_sha,'DAEMON_CHANGED')
    def controlled_client(self,d,work,spec,daemon_sha):
        # No inherited proxy/preload/context injections. Only known local host.
        self.runtime(d);self.old_permissions(spec)
        private=work/'docker-client';private.mkdir(mode=0o700)
        path=private/'config.json';path.write_bytes(b'{}\n');path.chmod(0o600)
        seal=self.base.file_seal(path,private=True)
        self.client_seals[path]=copy.deepcopy(seal)
        client_raw,current=self.base._sealed_file(path,private=True)
        need(current==seal and client_raw==b'{}\n','CLIENT_SOURCE_CHANGED')
        env={**IDENTITY.COLLECTION_ENV,'DOCKER_CONFIG':str(private),'DOCKER_HOST':UNIX_HOST}
        self.generator_still_same(d,env,spec,daemon_sha)
        need(self.base.file_seal(path,private=True)==seal,'CLIENT_SOURCE_CHANGED')
        self.environment=env
        return env,seal
    def install(self):
        self.base.spec_validate=self.spec_validate;self.base.generator_still_same=self.generator_still_same
        self.base.controlled_client=self.controlled_client
        # Inventory must hash the same absolute Docker ELF that executes; ambient
        # PATH must not select an unrelated file even for a read-only checksum.
        self.base.frozen.shutil=SimpleNamespace(which=lambda name:self.profile['spec']['dockerPath'] if name=='docker' else None)
        key=('25.0.16','5.5.0')
        self.base.REVIEWED_GENERATORS=MappingProxyType({key:copy.deepcopy(self.profile['spec'])})
    def assert_stable(self):
        need(self.runner is not None and self.initial_binding is not None and self.initial_tools is not None,'RUNTIME_CAPABILITY_REQUIRED')
        self.generator_still_same(self.runner,self.runner.environment,self.profile['spec'],self.daemon_sha)
        need(self.native_tools()==self.initial_tools,'NATIVE_TOOL_CHANGED')
    def rules(self):
        need(digest(self.profile)==self.profile_sha,'SOURCE_PROFILE_INVALID')
        return {'spec':copy.deepcopy(self.profile['spec']),'rulesSha256':digest(self.profile['spec']),
            'sourceInputsSha256':digest(self.profile['sourceInputs']),
            'sourceReviewReportSha256':self.profile['sourceReviewReportSha256']}
    def measure(self,d,directory,**kwargs):
        if self.runner is None:
            with _acquisition_context(d,self) as acquired:return acquired.measure(directory,**kwargs)
        need(d is self.runner,'CLIENT_SOURCE_CHANGED')
        self.assert_stable()
        try:
            result=self.base.measure(self.runner,directory,**kwargs)
            self.assert_stable()
            return result
        finally:self.remove_deferred()
    def remove_deferred(self):
        import shutil
        for path in self.deferred:
            need(path.parent==self.runner.BASE/'.runtime'/'online-recharge-declaration-measurement'
                and path.resolve()==path,'CLIENT_SOURCE_CHANGED')
            shutil.rmtree(path)
        self.deferred=[]

class _AcquiredSession:
    """Only existing source-facts acquisition/measurement within one lifetime."""
    __slots__=('_session','runner')
    def __init__(self,session):self._session=session;self.runner=session.runner
    def reviewed_rules(self):return self._session.rules()
    def assert_stable(self):return self._session.assert_stable()
    def measure(self,directory,*,services,image_reference,image_id,source_seal,stability_reader):
        return self._session.measure(self.runner,directory,services=services,image_reference=image_reference,
            image_id=image_id,source_seal=source_seal,stability_reader=stability_reader)

@contextmanager
def _acquisition_context(d,session):
    """Private implementation. Tests inject only into this private boundary."""
    import os,stat,shutil
    need(session.runner is None,'CLIENT_SOURCE_CHANGED');session.install()
    # Capability/source table was selected by the public caller before this point.
    session.require_vfs()
    root=d.BASE/'.runtime'/'online-recharge-qualified-client'
    need(root.is_absolute() and root.parent.resolve()==root.parent and not root.is_symlink(),'CLIENT_SOURCE_CHANGED')
    root.mkdir(mode=0o700,exist_ok=True)
    info=root.stat();need(info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)==0o700,'CLIENT_SOURCE_CHANGED')
    work=root/uuid.uuid4().hex;work.mkdir(mode=0o700)
    config=work/'config.json';config.write_bytes(b'{}\n');config.chmod(0o600)
    def defer_local_remove(path):
        path=Path(path);expected=d.BASE/'.runtime'/'online-recharge-declaration-measurement'
        need(path.parent==expected and re.fullmatch('[a-f0-9]{32}',path.name)
            and path.resolve()==path and path not in session.deferred,'CLIENT_SOURCE_CHANGED')
        session.deferred.append(path)
    session.base.shutil=SimpleNamespace(rmtree=defer_local_remove)
    try:
        session.runner=_ControlledDriver(d,session,config)
        session.base.frozen.clean_source_environment=session.runner.source_environment
        # Qualify process/VFS/tools BEFORE any production-service acquisition.
        session.runtime(session.runner);session.old_permissions(session.profile['spec'])
        session.initial_tools=session.native_tools()
        info=session.base.frozen.read(session.runner,session.profile['spec']['dockerPath'],'info',
            '--format',session.base.frozen.INFO_FORMAT,env=session.runner.environment)
        need(type(info.get('id')) is str and 0<len(info['id'])<=256,'DAEMON_CHANGED')
        session.daemon_sha=sha(info['id']);session.assert_stable()
        yield _AcquiredSession(session)
        session.assert_stable()
    finally:
        if session.runner is not None:session.remove_deferred()
        # Only this exact freshly-created client directory, never source or volumes.
        need(work.parent==root and work.name==config.parent.name and work.resolve()==work,'CLIENT_SOURCE_CHANGED')
        shutil.rmtree(work)
        session.runner=None;session.client_seals={}

@contextmanager
def acquisition_session(d):
    """No caller admission/bool/profile override; runtime qualification remains live."""
    try:
        profile=_reviewed_profile();base=_load_base();session=_Session(base,profile,_load_socket())
        with _acquisition_context(d,session) as acquired:yield acquired
    except Rejected as error:
        code=str(error);raise Rejected(code if code in CODES else 'QUALIFIER_UNAVAILABLE') from None
    except Exception:raise Rejected('QUALIFIER_UNAVAILABLE') from None

class _ControlledDriver:
    """Fixed executables + whitelisted environment for every execution.

    Ambient interpolation variables are never inherited. Source Compose uses its
    fixed real --env-file in memory; no real Env is materialized by this wrapper.
    """
    def __init__(self,driver,session,config):
        self.driver=driver;self.session=session;self.config=config;self.BASE=driver.BASE
        self.environment={**IDENTITY.COLLECTION_ENV,'DOCKER_CONFIG':str(config.parent),'DOCKER_HOST':UNIX_HOST}
        self.seal=session.base.file_seal(config,private=True)
        session.client_seals[config]=copy.deepcopy(self.seal)
    def __getattr__(self,name):
        # Do not delegate remote module's global service_state/compose functions:
        # those close over its raw run and would evade the clean execution path.
        need(name in ('require','api_admin_scope','ALL_SERVICES'),'CLIENT_SOURCE_CHANGED')
        return getattr(self.driver,name)
    def directory(self,directory):
        directory=Path(directory)
        need(directory.is_absolute() and directory.resolve()==directory
            and directory.is_relative_to(self.BASE/'releases'),'CLIENT_SOURCE_CHANGED')
        return directory
    def compose(self,directory,*args,env=None,timeout=300,input_data=None):
        directory=self.directory(directory)
        need(input_data is None and args and args[0] in ('config','ps'),'CLIENT_SOURCE_CHANGED')
        return self.run(self.session.profile['spec']['composePath'],'--env-file',str(directory/self.session.base.frozen.FILES[2]),
            '-f',str(directory/self.session.base.frozen.FILES[0]),'-f',str(directory/self.session.base.frozen.FILES[1]),
            *args,env=env or self.source_environment(directory),timeout=timeout)
    def production_services(self,directory):
        directory=self.directory(directory)
        row=self.session.base.file_seal(directory/self.session.base.frozen.FILES[0])
        need(row['sha256']==self.session.base.frozen.COMPOSE_BLOB_SHA256,'CLIENT_SOURCE_CHANGED')
        return tuple(self.session.base.frozen.SERVICES)
    def service_state(self,directory,service,*,include_container_id=False,include_environment_hash=False):
        need(service in self.session.base.frozen.SERVICES and type(include_container_id) is bool
            and type(include_environment_hash) is bool,'CLIENT_SOURCE_CHANGED')
        cid=self.compose(directory,'ps','-q',service,timeout=30)
        need(type(cid) is str and HEX.fullmatch(cid),'CLIENT_SOURCE_CHANGED')
        raw=self.run('docker','inspect',cid,timeout=30)
        data=self.session.base.frozen.unique_json(raw,2*1024**2)
        need(type(data) is list and len(data)==1 and type(data[0]) is dict,'CLIENT_SOURCE_CHANGED')
        data=data[0];digest(data)
        config=data.get('Config');state=data.get('State')
        need(type(config) is dict and type(state) is dict and data.get('Id')==cid,'CLIENT_SOURCE_CHANGED')
        values=config.get('Env');started=state.get('StartedAt')
        if include_environment_hash:
            need(type(values) is list and bool(values) and all(type(v) is str and '=' in v for v in values)
                and len({v.split('=',1)[0] for v in values})==len(values),'CLIENT_SOURCE_CHANGED')
        if include_container_id:need(type(started) is str and 0<len(started)<=128,'CLIENT_SOURCE_CHANGED')
        return {'image':data['Image'],'reference':config['Image'],'status':state['Status'],
            'health':state.get('Health',{}).get('Status'),
            **({'containerId':cid,'startedAtSha256':sha(started)} if include_container_id else {}),
            **({'environmentSha256':digest(sorted(values))} if include_environment_hash else {})}
    def source_environment(self,directory):
        names=set()
        for name in self.session.base.frozen.FILES[:2]:
            path=directory/name;raw,_=self.session.base._sealed_file(path)
            names.update(re.findall(r'\$\{([A-Za-z_][A-Za-z0-9_]*)',raw.decode()))
        # These execution-only keys do not occur in fixed old source placeholders.
        need(not names & set(self.environment),'CLIENT_SOURCE_CHANGED')
        return dict(self.environment)
    def run(self,*args,**kwargs):
        need(args and type(args[0]) is str,'CLIENT_SOURCE_CHANGED')
        args=list(args);program=args[0]
        env=kwargs.pop('env',None)
        need(set(kwargs)<= {'timeout'},'CLIENT_SOURCE_CHANGED')
        need(env is None or type(env) is dict,'CLIENT_SOURCE_CHANGED')
        if program in ('rpm','/usr/bin/rpm','/usr/bin/systemctl'):
            need(env in (None,IDENTITY.COLLECTION_ENV),'CLIENT_SOURCE_CHANGED')
            args[0]='/usr/bin/rpm' if program=='rpm' else program
            return self.driver.run(*args,env=dict(IDENTITY.COLLECTION_ENV),**kwargs)
        need(program in ('docker',self.session.profile['spec']['dockerPath'],self.session.profile['spec']['composePath']),'CLIENT_SOURCE_CHANGED')
        if program=='docker' and len(args)>1 and args[1]=='compose':
            args=[self.session.profile['spec']['composePath'],*args[2:]]
        elif program=='docker':args[0]=self.session.profile['spec']['dockerPath']
        environment=self.environment if env is None else env
        need(set(environment)==set(self.environment) and all(environment[k]==self.environment[k] for k in ('PATH','LANG','LC_ALL','DOCKER_HOST')),'CLIENT_SOURCE_CHANGED')
        config=Path(environment['DOCKER_CONFIG'])/'config.json'
        need(config in self.session.client_seals,'CLIENT_SOURCE_CHANGED')
        seal=self.session.base.file_seal(config,private=True)
        need(seal==self.session.client_seals[config],'CLIENT_SOURCE_CHANGED')
        client_raw,current=self.session.base._sealed_file(config,private=True)
        need(current==seal and client_raw==b'{}\n','CLIENT_SOURCE_CHANGED')
        if config==self.config:need(seal==self.seal,'CLIENT_SOURCE_CHANGED')
        result=self.driver.run(*args,env=dict(environment),**kwargs)
        need(self.session.base.file_seal(config,private=True)==seal,'CLIENT_SOURCE_CHANGED')
        return result

def _reviewed_profile():
    # Only the fixed literal row and captured Package table bytes may select a source.
    need(type(_SOURCE_TABLE_BYTES) is bytes and sha(_SOURCE_TABLE_BYTES)==REVIEWED_SOURCE_TABLE_SHA256,
        'SOURCE_NOT_MEASURED')
    need(type(REVIEWED_SOURCE_TABLE) is tuple and len(REVIEWED_SOURCE_TABLE)==1
        and type(REVIEWED_SOURCE_TABLE[0]) is dict,'SOURCE_NOT_MEASURED')
    need(sha(json.dumps(REVIEWED_SOURCE_TABLE[0],sort_keys=True,separators=(',',':'),allow_nan=False).encode())
        ==REVIEWED_PROFILE_CANONICAL_SHA256,'SOURCE_NOT_MEASURED')
    need(json.loads(_SOURCE_TABLE_BYTES)==list(REVIEWED_SOURCE_TABLE),'SOURCE_NOT_MEASURED')
    return copy.deepcopy(REVIEWED_SOURCE_TABLE[0])

def measure(d,directory,*,services,image_reference,image_id,source_seal,stability_reader):
    """Fixed source row does not bypass live runtime/resources or allow caller admission."""
    try:
        with acquisition_session(d) as acquired:
            return acquired.measure(directory,services=services,image_reference=image_reference,image_id=image_id,
                source_seal=source_seal,stability_reader=stability_reader)
    except Rejected as error:
        code=str(error);raise Rejected(code if code in CODES else 'QUALIFIER_UNAVAILABLE') from None
    except Exception:raise Rejected('QUALIFIER_UNAVAILABLE') from None

def reviewed_rules():
    """Read-only singleton source rules; no runtime qualification or caller override."""
    profile=_source_profile(_reviewed_profile(),_load_base())
    return {'spec':copy.deepcopy(profile['spec']),'rulesSha256':digest(profile['spec']),
        'sourceInputsSha256':digest(profile['sourceInputs']),
        'sourceReviewReportSha256':profile['sourceReviewReportSha256']}
