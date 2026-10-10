"""Independent minimal runtime derivation; imports perform no collection."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
ONLINE = None
WORKSPACE = None
WORKSPACE_PATH = None
INVENTORY = None
DERIVE = None
MAX_BYTES=2*1024**2
CONFIG_FILES=('docker-compose.aws-mysql.yml','deploy/caddy/Caddyfile.aws','apps/api/prisma-mysql/schema.prisma','compose.release.json')
SOURCE_FILES=('docker-compose.aws-mysql.yml','compose.release.json','.env.aws.production')
WORKSPACE_FILES=('release-manifest.json','api-workspace-build-proof.json','api-workspace-preservation.json','backup-verification.json','before-audit.json','after-audit.json')

def _configure(online,workspace,inventory,pure,workspace_path):
    global ONLINE,WORKSPACE,INVENTORY,DERIVE,WORKSPACE_PATH
    if (*workspace.CONFIG_FILES,'compose.release.json') != CONFIG_FILES or tuple(inventory.FILES)!=SOURCE_FILES:
        raise RuntimeError('PACKAGE_SCHEMA_CHANGED')
    ONLINE=online.__dict__;WORKSPACE=workspace.__dict__;INVENTORY=inventory;DERIVE=pure;WORKSPACE_PATH=workspace_path

SEAL_KEYS=('baselineCommit','directory','files','servicesSha256','stabilitySha256','replaceAnchors')
HEX=re.compile('[a-f0-9]{64}\\Z')
NAME=re.compile('[a-z0-9][a-z0-9_-]{0,63}\\Z')

class ReaderRejected(RuntimeError):pass

def need(ok,code='FACTS_READER_INVALID'):
    if not ok:raise ReaderRejected(code)

def canonical(value):
    try:return DERIVE.canonical(value)
    except Exception:raise ReaderRejected('FACTS_READER_INVALID') from None

def digest(value):return hashlib.sha256(canonical(value)).hexdigest()

def exact(value,keys):
    need(type(value) is dict and set(value)==set(keys));canonical(value);return value

def hashes(value,keys):
    exact(value,keys);need(all(type(v) is str and HEX.fullmatch(v) for v in value.values()));return value

def decode(raw):
    need(type(raw) is str and 0<len(raw.encode())<=MAX_BYTES,'FACTS_READ_BOUND')
    def pairs(rows):
        result={}
        for key,value in rows:
            need(key not in result,'FACTS_READ_JSON');result[key]=value
        return result
    try:
        value=json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(need(False,'FACTS_READ_JSON')))
        canonical(value);return value
    except ReaderRejected:raise
    except Exception:raise ReaderRejected('FACTS_READ_JSON') from None

def stat_seal(info):
    return {'device':info.st_dev,'inode':info.st_ino,'uid':info.st_uid,'gid':info.st_gid,
        'mode':info.st_mode,'size':info.st_size,'links':info.st_nlink}

def directory_fd(directory,uid):
    """Root→source complete openat identity chain. Ancestors are observed only;
    fixed base/releases/source must retain existing owner/non-writable rules.
    No symlinks are followed, and visible leafs must equal opened descriptors.
    """
    directory=Path(directory)
    need(directory.is_absolute() and directory.resolve()==directory,'FACTS_PATH_CHANGED')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    result={'/':stat_seal(os.fstat(fd))};current=Path('/')
    owned_start=len(directory.parts)-3
    try:
        for index,part in enumerate(directory.parts[1:],1):
            need(part not in ('.','..'),'FACTS_PATH_CHANGED')
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            try:
                opened=os.fstat(child);visible=os.stat(part,dir_fd=fd,follow_symlinks=False)
                need(stat_seal(opened)==stat_seal(visible),'FACTS_PATH_CHANGED')
                if index>=owned_start:
                    need(opened.st_uid==uid and stat.S_IMODE(opened.st_mode)&0o022==0,'FACTS_PATH_CHANGED')
                current=current/part;result[str(current)]=stat_seal(opened)
            except Exception:os.close(child);raise
            os.close(fd);fd=child
        return fd,result
    except Exception:os.close(fd);raise

def files(directory,names,uid):
    """openat/no-follow complete descriptor traversal; no raw bytes returned."""
    result={}
    basefd,root_chain=directory_fd(directory,uid)
    try:
        for name in names:
            path=Path(name);need(not path.is_absolute() and path.parts and all(p not in ('.','..') for p in path.parts))
            parent=os.dup(basefd);parent_seals={'':stat_seal(os.fstat(basefd))};parts=[]
            try:
                for part in path.parts[:-1]:
                    child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
                    info=os.fstat(child);need(info.st_uid==uid and stat.S_IMODE(info.st_mode)&0o022==0,'FACTS_FILE_CHANGED')
                    parts.append(part);parent_seals['/'.join(parts)]=stat_seal(info)
                    os.close(parent);parent=child
                fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
                try:
                    first=os.fstat(fd);need(stat.S_ISREG(first.st_mode) and first.st_nlink==1 and first.st_uid==uid
                        and stat.S_IMODE(first.st_mode)&0o022==0 and first.st_size<=1024**2,'FACTS_FILE_CHANGED')
                    if name==SOURCE_FILES[2]:need(stat.S_IMODE(first.st_mode) in (0o400,0o600),'FACTS_FILE_CHANGED')
                    chunks=[];size=0
                    while True:
                        chunk=os.read(fd,65536)
                        if not chunk:break
                        size+=len(chunk);need(size<=1024**2,'FACTS_READ_BOUND');chunks.append(chunk)
                    last=os.fstat(fd);visible=os.stat(path.name,dir_fd=parent,follow_symlinks=False)
                    need(stat_seal(first)==stat_seal(last)==stat_seal(visible),'FACTS_FILE_CHANGED')
                    # Reopen the visible relative parent chain before releasing
                    # the original descriptors; rename+replacement cannot hide
                    # behind an otherwise identical open leaf inode.
                    currentfd=os.dup(basefd);observed={'':stat_seal(os.fstat(basefd))};currentparts=[]
                    try:
                        for part in path.parts[:-1]:
                            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=currentfd)
                            os.close(currentfd);currentfd=child;currentparts.append(part)
                            observed['/'.join(currentparts)]=stat_seal(os.fstat(currentfd))
                        need(observed==parent_seals,'FACTS_FILE_CHANGED')
                    finally:os.close(currentfd)
                    result[name]={'sha256':hashlib.sha256(b''.join(chunks)).hexdigest(),'identity':stat_seal(last),'parents':parent_seals}
                finally:os.close(fd)
            finally:os.close(parent)
        finalfd,final_chain=directory_fd(directory,uid)
        try:need(final_chain==root_chain and stat_seal(os.fstat(finalfd))==stat_seal(os.fstat(basefd)),'FACTS_PATH_CHANGED')
        finally:os.close(finalfd)
        return result
    except OSError:raise ReaderRejected('FACTS_FILE_CHANGED') from None
    finally:os.close(basefd)

class _ReadDriver:
    """Only exact existing read commands reach injected transport."""
    def __init__(self,runner,directory,services):
        self.raw=runner;self.BASE=runner.BASE;self.directory=directory;self.ALL_SERVICES=INVENTORY.SERVICES
        self.container_ids={r['containerId'] for r in services.values()};self.network_ids=set();self.volume_name=None
        need(len(self.container_ids)==7,'FACTS_SNAPSHOT_CHANGED')
    def api_admin_scope(self,name):
        need(name=='API_ADMIN_WORKSPACE');return (SimpleNamespace(**WORKSPACE),WORKSPACE_PATH)
    def require(self,ok,_code):need(ok)
    def production_services(self,directory):
        need(directory==self.directory);value=self.raw.production_services(directory)
        need(type(value) in (list,tuple) and set(value)==set(self.ALL_SERVICES) and len(value)==7)
        return value
    def service_state(self,directory,service,**kwargs):
        need(directory==self.directory and service in self.ALL_SERVICES
            and kwargs=={'include_container_id':True,'include_environment_hash':True})
        value=self.raw.service_state(directory,service,**kwargs)
        need(type(value) is dict and set(value) in (set(INVENTORY.IDENTITY_KEYS),set(INVENTORY.IDENTITY_KEYS)-{'configurationSha256'}))
        canonical(value);return copy.deepcopy(value)
    def run(self,*args,**kwargs):
        need(kwargs in ({},{'timeout':30}))
        allowed=(len(args)==3 and args[:2]==('docker','inspect') and args[2] in self.container_ids)
        allowed=allowed or (len(args)==4 and args[:3]==('docker','network','inspect') and args[3] in self.network_ids)
        allowed=allowed or (self.volume_name is not None and args==('docker','volume','inspect',self.volume_name))
        allowed=allowed or (self.volume_name is not None and args==('docker','volume','ls','--filter','name=^'+self.volume_name+'$','--format','{{.Name}}'))
        need(allowed,'FACTS_UNAPPROVED_COMMAND')
        raw=self.raw.run(*args,**kwargs)
        if args[:3]==('docker','volume','ls'):
            need(type(raw) is str and raw==self.volume_name,'FACTS_RESOURCE_CHANGED');return raw
        decode(raw) # strict duplicate/finite/budget validation before old json.loads
        return raw

def inspect_one(driver,*args):
    value=decode(driver.run(*args));need(type(value) is list and len(value)==1 and type(value[0]) is dict)
    return value[0]

def snapshot(driver,directory):
    value=ONLINE['snapshot'](driver,directory) # default include_engine=False only
    try:INVENTORY.validate_services(value)
    except Exception:raise ReaderRejected('FACTS_SNAPSHOT_CHANGED') from None
    return copy.deepcopy(value)

def volume_summary(volume):
    keys=('Name','Driver','Scope','Mountpoint','Labels','CreatedAt','Options')
    return {'name':volume['Name'],'status':'PRESENT','identitySha256':digest({k:volume.get(k) for k in keys})}

class _Reader:
    def __init__(self,runner,directory,*,source_seal,services,configuration,workspace_files,workspace_volume,uid):
        self.directory=Path(directory);self.uid=uid
        self.source=copy.deepcopy(exact(source_seal,SEAL_KEYS));self.services=copy.deepcopy(services)
        try:INVENTORY.validate_services(services)
        except Exception:raise ReaderRejected('FACTS_SNAPSHOT_CHANGED') from None
        self.configuration=copy.deepcopy(hashes(configuration,CONFIG_FILES))
        self.workspace_files=copy.deepcopy(hashes(workspace_files,WORKSPACE_FILES))
        self.workspace_volume=copy.deepcopy(exact(workspace_volume,('name','status','identitySha256')))
        need(workspace_volume['status']=='PRESENT' and type(workspace_volume['identitySha256']) is str
            and HEX.fullmatch(workspace_volume['identitySha256']) and type(workspace_volume['name']) is str)
        hashes(self.source['files'],SOURCE_FILES)
        need(self.source['files'][SOURCE_FILES[0]]==INVENTORY.COMPOSE_BLOB_SHA256,'FACTS_SOURCE_CHANGED')
        need(self.source['baselineCommit']==INVENTORY.BASELINE and self.source['directory']==str(self.directory)
            and self.source['servicesSha256']==digest(self.services) and type(self.source['stabilitySha256']) is str
            and HEX.fullmatch(self.source['stabilitySha256']))
        exact(self.source['replaceAnchors'],('candidateAfterContainerId','stableName'))
        need(type(self.source['replaceAnchors']['candidateAfterContainerId']) is str
            and HEX.fullmatch(self.source['replaceAnchors']['candidateAfterContainerId']))
        self.base=Path(runner.BASE);need(self.directory.is_absolute() and self.directory.parent==self.base/'releases')
        self.driver=_ReadDriver(runner,self.directory,self.services)
        self.original_files=None;self.original_dirs=None
    def directories(self):
        need(self.base.is_absolute() and self.base.resolve()==self.base,'FACTS_PATH_CHANGED')
        fd,chain=directory_fd(self.directory,self.uid)
        try:return chain
        finally:os.close(fd)
    def __call__(self):
        try:return self._read()
        except ReaderRejected:raise
        except Exception:raise ReaderRejected('FACTS_READER_FAILED') from None
    def _read(self):
        dirs=self.directories()
        names=tuple(dict.fromkeys((*CONFIG_FILES,*SOURCE_FILES,*WORKSPACE_FILES)))
        before=files(self.directory,names,self.uid)
        if self.original_files is not None:need(before==self.original_files and dirs==self.original_dirs,'FACTS_FILE_CHANGED')
        conf=ONLINE['configuration_hashes'](self.directory) # real signature: directory
        workspace=ONLINE['workspace_files'](self.driver,self.directory)
        need(conf==self.configuration and workspace==self.workspace_files,'FACTS_SOURCE_CHANGED')
        need({k:before[k]['sha256'] for k in CONFIG_FILES}==conf
            and {k:before[k]['sha256'] for k in WORKSPACE_FILES}==workspace
            and {k:before[k]['sha256'] for k in SOURCE_FILES}==self.source['files'],'FACTS_SOURCE_CHANGED')
        observed=snapshot(self.driver,self.directory);need(observed==self.services,'FACTS_SNAPSHOT_CHANGED')
        api=inspect_one(self.driver,'docker','inspect',observed['api']['containerId'])
        labels=api.get('Config',{}).get('Labels',{});project=labels.get('com.docker.compose.project')
        need(type(project) is str and NAME.fullmatch(project) and api.get('Id')==observed['api']['containerId'],'FACTS_RESOURCE_CHANGED')
        need(api.get('Name') in ('/'+project+'-api-1','/'+project+'_api_1')
            and self.source['replaceAnchors']['stableName']==api['Name'].lstrip('/'),'FACTS_RESOURCE_CHANGED')
        configuration={'Config':api.get('Config'),'HostConfig':api.get('HostConfig'),
            'Mounts':sorted(api.get('Mounts',[]),key=lambda row:row['Destination'])}
        need(api.get('Image')==observed['api']['image'] and api['Config'].get('Image')==observed['api']['reference']
            and digest(configuration)==observed['api']['configurationSha256'],'FACTS_SNAPSHOT_CHANGED')
        state=api.get('State',{})
        env=api['Config'].get('Env')
        need(type(env) is list and all(type(v) is str and '=' in v for v in env)
            and len({v.split('=',1)[0] for v in env})==len(env)
            and digest(sorted(env))==observed['api']['environmentSha256']
            and state.get('Status')==observed['api']['status']
            and state.get('Health',{}).get('Status')==observed['api']['health']
            and type(state.get('StartedAt')) is str
            and hashlib.sha256(state['StartedAt'].encode()).hexdigest()==observed['api']['startedAtSha256'],
            'FACTS_SNAPSHOT_CHANGED')
        endpoints=api.get('NetworkSettings',{}).get('Networks')
        need(type(endpoints) is dict and set(endpoints)=={project+'_'+r for r in INVENTORY.NETWORK_ROLES},'FACTS_NETWORK_CHANGED')
        self.driver.network_ids={row.get('NetworkID') for row in endpoints.values() if type(row) is dict}
        need(len(self.driver.network_ids)==4 and all(type(n) is str and HEX.fullmatch(n) for n in self.driver.network_ids),'FACTS_NETWORK_CHANGED')
        networks={}
        for role in INVENTORY.NETWORK_ROLES:
            endpoint=endpoints[project+'_'+role];net=inspect_one(self.driver,'docker','network','inspect',endpoint['NetworkID'])
            need(net.get('Id')==endpoint['NetworkID'] and net.get('Name')==project+'_'+role
                and set(net)<=INVENTORY.NETWORK_FIELDS,'FACTS_NETWORK_CHANGED')
            canonical(net);networks[role]=net
        self.driver.volume_name=project+'_'+WORKSPACE['WORKSPACE_VOLUME']
        volume=inspect_one(self.driver,'docker','volume','inspect',self.driver.volume_name)
        need(volume.get('Name')==self.driver.volume_name and set(volume)<=INVENTORY.VOLUME_FIELDS,'FACTS_RESOURCE_CHANGED')
        # Call actual frozen helper, including path/attachment/label checks. Its
        # independent second volume inspect must agree with our complete read.
        summary=WORKSPACE['workspace_volume'](self.driver,self.directory,attached=True,api_metadata=api)
        need(summary==volume_summary(volume)==self.workspace_volume,'FACTS_RESOURCE_CHANGED')
        same_volume=inspect_one(self.driver,'docker','volume','inspect',self.driver.volume_name)
        need(same_volume==volume,'FACTS_RESOURCE_CHANGED')
        # Full repeats and source files bracket all acquisition, not just hashes.
        for role,net in networks.items():
            need(inspect_one(self.driver,'docker','network','inspect',net['Id'])==net,'FACTS_NETWORK_CHANGED')
        need(inspect_one(self.driver,'docker','inspect',observed['api']['containerId'])==api,'FACTS_SNAPSHOT_CHANGED')
        need(snapshot(self.driver,self.directory)==observed,'FACTS_SNAPSHOT_CHANGED')
        need(ONLINE['configuration_hashes'](self.directory)==conf
            and ONLINE['workspace_files'](self.driver,self.directory)==workspace,'FACTS_SOURCE_CHANGED')
        after=files(self.directory,names,self.uid)
        need(before==after and self.directories()==dirs,'FACTS_FILE_CHANGED')
        raw={'snapshot':observed,'sourceFiles':{'configurationFiles':{k:before[k]['sha256'] for k in SOURCE_FILES},
            'workspaceFiles':workspace},'workspaceVolume':copy.deepcopy(volume),
            'actualResource':{'networks':networks,'volume':volume}}
        canonical(raw)
        derived=DERIVE.observation(raw,self.services,self.source['files'],raw['actualResource'])
        need(digest(derived)==self.source['stabilitySha256'],'FACTS_OBSERVATION_CHANGED')
        if self.original_files is None:self.original_files=before;self.original_dirs=dirs
        return raw # internal in-memory capability; caller must never log this

def make_reader(runner,directory,*,source_seal,services,configuration,workspace_files,workspace_volume):
    """Production intended factory remains root-only; grants no authority."""
    need(os.getuid()==0,'FACTS_ROOT_CAPABILITY_REQUIRED')
    try:
        return _Reader(runner,directory,source_seal=source_seal,services=services,configuration=configuration,
            workspace_files=workspace_files,workspace_volume=workspace_volume,uid=0)
    except ReaderRejected:raise
    except Exception:raise ReaderRejected('FACTS_READER_FAILED') from None
