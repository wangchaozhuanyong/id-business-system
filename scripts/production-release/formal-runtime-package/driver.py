"""Fixed runtime acquisition bound to reviewed source and the formal entry.

All source acquisition/measurement uses the qualified private client session.
P1 registries contain only closed hashes/resource identities, never Env/inspect.
The public entry has the existing online-scope signature, not a caller record.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import types
import urllib.error

HERE = Path(__file__).resolve().parent
BASELINE = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
PARENT_FORMAL_TABLE = '1d090ebf96ad9186587f78c99842fce4503abc1fa710f1e4b1be82fca310706e'
FORMAL_TABLE = '6e67c5dd29b7535604460c54ad726120e4c288a71e5debb59361d52ffb523f79'
PACKAGE_MANIFEST_SHA = '72459dbea16c2b38be5a140152bfbab06447bd9551a0ee49565ed7d70a767806'
MAX_REGISTRY = 32768
HEX = re.compile(r'[a-f0-9]{64}\Z')
PRODUCER_KEYS = ('commit','sourceTree','workflowRunId','workflowRunAttempt')
REGISTRY_KEYS = ('version','producer','p1Sha256','referenceRegistry')
CODES = frozenset(('ROOT_DRIVER_SOURCE_UNMEASURED','ROOT_GENERATOR_SOURCE_UNMEASURED',
    'ROOT_ENTRY_INVALID','ROOT_PRODUCER_CHANGED','ROOT_SOURCE_CHANGED','ROOT_HISTORY_CHANGED',
    'ROOT_ACQUISITION_UNAVAILABLE','ROOT_OBSERVATION_CHANGED','ROOT_ADMIN_PROJECTION_FAILED',
    'ROOT_MEASUREMENT_INVALID','ROOT_PREFLIGHT_CHANGED','ROOT_REGISTRY_INVALID',
    'ROOT_REGISTRY_MISSING','ROOT_REGISTRY_EXISTS','ROOT_REGISTRY_CHANGED','ROOT_DRIVER_UNAVAILABLE'))

class Rejected(RuntimeError): pass

DIAGNOSTIC_STAGES = frozenset((
    'PACKAGE_BIND','LOCAL_PACKAGE','SOURCE_PROFILE',
    'ARCHIVE_BIND','CONFIGURE','ENTRY',
    'ACQUISITION','RULES','ACQUIRE',
    'MEASURE','AFTER','CONSTRUCT',
    'CLOSE','REGISTRY','QUALIFIER_PROFILE',
    'FACTORY','SESSION','INSTALL',
    'VFS_SOURCE','CLIENT_DIRECTORY','CLIENT_CONFIG',
    'RUNTIME_VFS','COLLECTION_TOOLS','NATIVE_PERMISSIONS',
    'NATIVE_TOOLS','DAEMON_INFO','STABILITY',
    'YIELD','CLEANUP',
))
DIAGNOSTIC_CODES = frozenset((
    'ACTUAL_IDENTITY','ACTUAL_IDENTITY_CHANGED','ACTUAL_INSPECT_CHANGED',
    'ACTUAL_NETWORK_ADDRESS','ACTUAL_NETWORK_DECLARATION','ACTUAL_NETWORK_ID_OR_MEMBERS',
    'ACTUAL_NETWORK_INSPECT_CHANGED','ACTUAL_NETWORK_MEMBERS','ACTUAL_NETWORK_SET',
    'ACTUAL_PRIMARY_NETWORK','ACTUAL_STATE_OR_ENV','ACTUAL_VOLUME_INSPECT_CHANGED',
    'ATTRIBUTE_ERROR','BASE_SOURCE_UNMEASURED','BINDING_REPORT_INVALID',
    'BOUND_LABEL','CLEANUP_FAILED','CLEANUP_REMAINING',
    'CLEANUP_SEAL_CHANGED','CLIENT_DEFAULT_INJECTION','CLIENT_SOURCE_CHANGED',
    'CLI_SOURCE_CHANGED','CMDLINE_INVALID','COMPLETE_CONFIGURATION_DIFFERENCE',
    'CONFIGURATION_INVALID','CONFIG_INVALID','DAEMON_CHANGED',
    'DAEMON_FD_MISSING','DAEMON_SOURCE_NOT_MEASURED','DEPENDENCY_LABEL',
    'ENV_INVALID','EXECUTABLE_INVALID','EXISTING_REFERENCE_REFUSED',
    'FD_INVALID','GENERATOR_SOURCE_CHANGED','HOST_MOUNTS_SHAPE',
    'HTTP_ERROR','IMAGE_INSPECT_CHANGED','LISTENER_INVALID',
    'MEASUREMENT_FAILED','MOUNT_BINDING','NAMESPACE_MISMATCH',
    'NATIVE_TOOL_CHANGED','ORIGIN_CHANGED','OS_ERROR',
    'PACKAGE_ARCHIVE_CHANGED','PACKAGE_BINARY_MISMATCH','PACKAGE_DIGEST_UNSUPPORTED',
    'PACKAGE_FILE_CHANGED','PACKAGE_INPUT_INVALID','PACKAGE_INVALID',
    'PACKAGE_SCHEMA_CHANGED','PACKAGE_SOURCE_CHANGED','PACK_IMAGE_OR_NATIVE_IDENTITY',
    'PACK_INVALID','PATH_INVALID','PERMISSIONS_INVALID',
    'PERMISSION_ERROR','POOL_SOURCE_CHANGED','PRIMARY_NETWORK',
    'PRIMARY_NETWORK_OR_IMAGE','PROCESS_INVALID','PROC_ALIAS_INVALID',
    'QUALIFIER_FROZEN_INPUT_CHANGED','QUALIFIER_UNAVAILABLE','REFERENCE_ID_CHANGED',
    'REFERENCE_MODEL_CHANGED','REFERENCE_NETWORK_OVERLAP','REFERENCE_NETWORK_SET',
    'REFERENCE_PATH_INVALID','REFERENCE_PENDING_ENDPOINT','REFERENCE_RESOURCE_CHANGED',
    'REFERENCE_STARTED_OR_OWNER_CHANGED','REFERENCE_STATE_OWNER_OR_ENV','REPLACE_LABEL',
    'REPORT_INVALID','RESOURCE_DEFAULT_POOL_INVALID','RESOURCE_INVENTORY_INVALID',
    'RESOURCE_IPAM_INVALID','RESOURCE_OWNER_OR_MEMBERS_INVALID','RESOURCE_PROPERTIES_INVALID',
    'RESOURCE_READ_INVALID','RESOURCE_SCHEMA_INVALID','RESOURCE_VOLUME_INVALID',
    'ROOT_ACQUISITION_UNAVAILABLE','ROOT_ADMIN_PROJECTION_FAILED','ROOT_DRIVER_SOURCE_UNMEASURED',
    'ROOT_DRIVER_UNAVAILABLE','ROOT_ENTRY_INVALID','ROOT_GENERATOR_SOURCE_UNMEASURED',
    'ROOT_HISTORY_CHANGED','ROOT_MEASUREMENT_INVALID','ROOT_OBSERVATION_CHANGED',
    'ROOT_PREFLIGHT_CHANGED','ROOT_PRODUCER_CHANGED','ROOT_REGISTRY_CHANGED',
    'ROOT_REGISTRY_EXISTS','ROOT_REGISTRY_INVALID','ROOT_REGISTRY_MISSING',
    'ROOT_SOURCE_CHANGED','RUNTIME_BINARY_CHANGED','RUNTIME_CAPABILITY_REQUIRED',
    'RUNTIME_DRIFT','RUNTIME_ERROR','RUNTIME_IDENTITY_INVALID',
    'RUNTIME_PACKAGE_CHANGED','RUNTIME_UNAVAILABLE','SERVICE_INVALID',
    'SOCKET_BINDING_CHANGED','SOCKET_BINDING_DRIFT','SOCKET_BINDING_INVALID',
    'SOCKET_BINDING_UNAVAILABLE','SOCKET_PATH_INVALID','SOCKET_PERMISSIONS_INVALID',
    'SOURCE_DECLARATION_INVALID','SOURCE_ENV_INVALID','SOURCE_ENV_SEAL_CHANGED',
    'SOURCE_FILES_CHANGED','SOURCE_FILE_INVALID','SOURCE_FILE_PERMISSIONS',
    'SOURCE_IMAGE_INVALID','SOURCE_MODEL_HASH_INVALID','SOURCE_NETWORK_DECLARATION',
    'SOURCE_NOT_MEASURED','SOURCE_PATH_INVALID','SOURCE_PROFILE_INVALID',
    'SOURCE_PROJECT_INVALID','SOURCE_REPLACE_ANCHOR_INVALID','SOURCE_SEAL_INVALID',
    'SOURCE_VOLUME_DECLARATION','TIMEOUT','TYPE_ERROR',
    'UNKNOWN','URL_ERROR','VFS_BINDING_UNAVAILABLE',
    'VFS_BOUND_CAPABILITY_REQUIRED','VFS_DIAG_UNAVAILABLE','VFS_DRIFT',
    'VFS_NODE_MISMATCH','VFS_QUERY_INVALID','VFS_REPORT_INVALID',
    'VFS_SOURCE_UNMEASURED','VFS_WIRE_INVALID',
    'FILE_EXISTS_ERROR','FILE_NOT_FOUND_ERROR',
))

def _literal_error(error,cls,codes):
    # Only the exact captured exception class may contribute its fixed literal.
    # BaseException's descriptor avoids arbitrary __str__/args overrides.
    if type(error) is cls:
        args=BaseException.args.__get__(error)
        if len(args)==1 and type(args[0]) is str and args[0] in codes:return args[0]
    return None

def failure_diagnostic(error):
    if type(error) is Rejected:
        value=error.__dict__.get('_declaration_failure')
        if (type(value) is tuple and len(value)==2 and type(value[0]) is str and type(value[1]) is str
                and value[0] in DIAGNOSTIC_STAGES and value[1] in DIAGNOSTIC_CODES):
            return {'stage':value[0],'code':value[1]}
    return None

def _reason(error,stage,bindings=()):
    prior=failure_diagnostic(error)
    if prior is not None:return prior
    code=_literal_error(error,Rejected,CODES)
    for cls,codes in bindings:
        if code is None:code=_literal_error(error,cls,codes)
    if code is None and stage=='ARCHIVE_BIND':
        if type(error) is urllib.error.HTTPError:code='HTTP_ERROR'
        elif type(error) is urllib.error.URLError:code='URL_ERROR'
        elif type(error) is TimeoutError:code='TIMEOUT'
    return {'stage':stage,'code':code if code in DIAGNOSTIC_CODES else 'UNKNOWN'}

def _qualified_reason(error,caps):
    if caps is None or type(error) is not getattr(caps.qualified,'Rejected',None):return None
    getter=getattr(caps.qualified,'failure_diagnostic',None)
    value=getter(error) if callable(getter) else None
    if (type(value) is dict and set(value)=={'stage','code'}
            and type(value['stage']) is str and type(value['code']) is str
            and value['stage'] in DIAGNOSTIC_STAGES and value['code'] in DIAGNOSTIC_CODES):
        return value
    return None

def _rejected(error,stage,bindings=(),failure=None):
    args=BaseException.args.__get__(error)
    code=args[0] if isinstance(error,Rejected) and len(args)==1 and type(args[0]) is str and args[0] in CODES else 'ROOT_DRIVER_UNAVAILABLE'
    # Preserve the existing non-authorizing source status, without trusting a
    # generic exception's message as a diagnostic cause.
    if len(args)==1 and type(args[0]) is str and args[0]=='SOURCE_NOT_MEASURED':code='ROOT_GENERATOR_SOURCE_UNMEASURED'
    rejected=Rejected(code)
    detail=failure if failure is not None else _reason(error,stage,bindings)
    rejected._declaration_failure=(detail['stage'],detail['code'])
    return rejected

def need(ok,code):
    if not ok: raise Rejected(code)

def canonical(value):
    try:
        raw=json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
        need(len(raw)<=2*1024**2,'ROOT_SOURCE_CHANGED')
        return raw
    except Rejected: raise
    except Exception: raise Rejected('ROOT_SOURCE_CHANGED') from None

def digest(value): return hashlib.sha256(canonical(value)).hexdigest()
def byte_sha(raw):
    need(type(raw) is bytes,'ROOT_SOURCE_CHANGED');return hashlib.sha256(raw).hexdigest()

def exact(value,fields,code='ROOT_SOURCE_CHANGED'):
    need(type(value) is dict and set(value)==set(fields),code);canonical(value);return value

def decode(raw,limit=MAX_REGISTRY):
    need(type(raw) is bytes and 0<len(raw)<=limit,'ROOT_REGISTRY_INVALID')
    def pairs(rows):
        result={}
        for key,value in rows:
            need(key not in result,'ROOT_REGISTRY_INVALID');result[key]=value
        return result
    try:
        value=json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(need(False,'ROOT_REGISTRY_INVALID')))
        canonical(value);return value
    except Rejected: raise
    except Exception: raise Rejected('ROOT_REGISTRY_INVALID') from None

def producer(value):
    exact(value,PRODUCER_KEYS,'ROOT_PRODUCER_CHANGED')
    need(all(type(value[k]) is str and re.fullmatch('[a-f0-9]{40}',value[k]) for k in ('commit','sourceTree'))
         and all(type(value[k]) is str and re.fullmatch('[1-9][0-9]*',value[k]) for k in ('workflowRunId','workflowRunAttempt')),
         'ROOT_PRODUCER_CHANGED')
    return copy.deepcopy(value)

def _bootstrap_parent(path):
    # Fixed internal bootstrap only: no owner/path admission parameter.
    need(path.is_absolute() and '..' not in path.parts,'ROOT_DRIVER_SOURCE_UNMEASURED')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    chain=[]
    try:
        root=os.fstat(fd)
        need(stat.S_ISDIR(root.st_mode) and root.st_uid==0 and stat.S_IMODE(root.st_mode)&0o022==0,
             'ROOT_DRIVER_SOURCE_UNMEASURED')
        chain.append((root.st_dev,root.st_ino,root.st_uid,root.st_gid,root.st_mode))
        for part in path.parts[1:-1]:
            visible=os.stat(part,dir_fd=fd,follow_symlinks=False)
            need(stat.S_ISDIR(visible.st_mode) and visible.st_uid in (0,os.getuid())
                 and stat.S_IMODE(visible.st_mode)&0o022==0,'ROOT_DRIVER_SOURCE_UNMEASURED')
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            try:
                opened=os.fstat(child)
                need(file_identity(visible)==file_identity(opened),'ROOT_DRIVER_SOURCE_UNMEASURED')
                chain.append((opened.st_dev,opened.st_ino,opened.st_uid,opened.st_gid,opened.st_mode))
            except Exception:os.close(child);raise
            os.close(fd);fd=child
        return fd,chain
    except Exception:os.close(fd);raise

def _bootstrap_read(path):
    # Bounded ordinary-file bytes are captured once, then compiled from those
    # bytes. A regular->FIFO race can never block at open/read.
    path=Path(path);parent=None;fd=None
    try:
        parent,chain=_bootstrap_parent(path)
        before=os.stat(path.name,dir_fd=parent,follow_symlinks=False)
        need(stat.S_ISREG(before.st_mode) and before.st_uid==os.getuid()
             and before.st_nlink==1 and stat.S_IMODE(before.st_mode) in (0o600,0o644)
             and 0<before.st_size<=2*1024**2,'ROOT_DRIVER_SOURCE_UNMEASURED')
        fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
        need(file_identity(os.fstat(fd))==file_identity(before),'ROOT_DRIVER_SOURCE_UNMEASURED')
        raw=b''
        while len(raw)<=2*1024**2:
            data=os.read(fd,min(65536,2*1024**2+1-len(raw)))
            if not data:break
            raw+=data
        need(len(raw)==before.st_size and file_identity(os.fstat(fd))==file_identity(before)==
             file_identity(os.stat(path.name,dir_fd=parent,follow_symlinks=False)),
             'ROOT_DRIVER_SOURCE_UNMEASURED')
        after,again=_bootstrap_parent(path)
        try:
            need(chain==again and os.fstat(parent).st_ino==os.fstat(after).st_ino
                 and os.fstat(parent).st_dev==os.fstat(after).st_dev,'ROOT_DRIVER_SOURCE_UNMEASURED')
        finally:os.close(after)
        return raw
    except Exception:raise Rejected('ROOT_DRIVER_SOURCE_UNMEASURED') from None
    finally:
        if fd is not None:os.close(fd)
        if parent is not None:os.close(parent)

def _load(path,expected,globals=None):
    raw=_bootstrap_read(path)
    need(byte_sha(raw)==expected,'ROOT_DRIVER_SOURCE_UNMEASURED')
    module=types.ModuleType('_root_bound_'+path.stem);module.__file__=str(path)
    if globals:module.__dict__.update(globals)
    try:exec(compile(raw,str(path),'exec'),module.__dict__)
    except Exception:raise Rejected('ROOT_DRIVER_SOURCE_UNMEASURED') from None
    return module

def _local_package():
    bindings=[]
    try:
        raw=_bootstrap_read(HERE/'manifest.json')
        need(byte_sha(raw)==PACKAGE_MANIFEST_SHA,'ROOT_DRIVER_SOURCE_UNMEASURED')
        manifest=decode(raw,limit=65536)
        row=manifest['files']['package_io.py']
        loader=_load(HERE/'package_io.py',row)
        bindings.append((loader.Rejected,loader.CODES))
        package=loader.Package(HERE,manifest)
        package._diagnostic_errors=bindings
        return package
    except Exception as error:raise _rejected(error,'LOCAL_PACKAGE',bindings) from None

def _capabilities(producer_value=None):
    stage='LOCAL_PACKAGE';bindings=[];failures=[]
    try:
        package=_local_package();bindings=package._diagnostic_errors
        stage='SOURCE_PROFILE'
        qualified=package.load_leaf('qualified.py');bindings.append((qualified.Rejected,qualified.CODES))
        # Fixed literal source selection precedes archive and runtime/tool acquisition.
        qualified._reviewed_profile()
        stage='ARCHIVE_BIND'
        external=package.bind_consumers(producer(producer_value))
        stage='CONFIGURE'
        pure=package.load_leaf('pure.py')
        reader=package.load_leaf('reader.py');reader._configure(external.online,external.workspace,external.inventory,pure,external.paths['api-admin-scope.py'])
        constructor=package.load_leaf('constructor.py');constructor._configure(external.online,package.contract)
        def factory():
            try:
                collector=package.load_leaf('collector.py')
                bindings.append((external.inventory.Rejected,collector.ERROR_CODES))
                collector._configure(external.inventory,pure,package.contract);return collector
            except Exception as error:
                if not failures:failures.append(_reason(error,'CONFIGURE',bindings))
                raise
        qualified._configure(external,pure,factory)
        return types.SimpleNamespace(online=external.online,workspace=external.workspace,qualified=qualified,
            reader=reader,constructor=constructor,package=package,_diagnostic_errors=bindings,_diagnostic_failure=failures)
    except Exception as error:raise _rejected(error,stage,bindings) from None


def _uid(): return 0

def file_identity(item):
    return (item.st_dev,item.st_ino,item.st_uid,item.st_gid,item.st_mode,item.st_nlink,
            item.st_size,item.st_mtime_ns,item.st_ctime_ns)

def trusted_directory(item):
    need(stat.S_ISDIR(item.st_mode) and item.st_uid==_uid() and stat.S_IMODE(item.st_mode)&0o022==0,
         'ROOT_REGISTRY_INVALID')

def _base_fd(base):
    base=Path(base)
    need(base.is_absolute() and base.parts[0]=='/' and '..' not in base.parts,'ROOT_REGISTRY_INVALID')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        for part in base.parts[1:]:
            visible=os.stat(part,dir_fd=fd,follow_symlinks=False)
            # Parent nodes must be owned by root; no arbitrary caller symlinks.
            trusted_directory(visible)
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            trusted_directory(os.fstat(child));need(file_identity(visible)==file_identity(os.fstat(child)),
                                                    'ROOT_REGISTRY_CHANGED')
            os.close(fd);fd=child
        return fd
    except Exception:
        os.close(fd);raise

def _registry_dir(base,*,create):
    fd=_base_fd(base)
    try:
        for part in ('.runtime','online-recharge-declaration-measurement','registries'):
            try: visible=os.stat(part,dir_fd=fd,follow_symlinks=False)
            except FileNotFoundError:
                need(create,'ROOT_REGISTRY_MISSING')
                os.mkdir(part,mode=0o700,dir_fd=fd)
                visible=os.stat(part,dir_fd=fd,follow_symlinks=False)
            need(stat.S_ISDIR(visible.st_mode) and visible.st_uid==_uid() and stat.S_IMODE(visible.st_mode)==0o700,
                 'ROOT_REGISTRY_INVALID')
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            need(file_identity(visible)==file_identity(os.fstat(child)),'ROOT_REGISTRY_CHANGED')
            os.close(fd);fd=child
        return fd
    except Exception:
        os.close(fd);raise

def registry_filename(p):
    p=producer(p)
    return p['commit']+'-'+p['workflowRunId']+'-'+p['workflowRunAttempt']+'.json'

def validate_registry(value,p,constructor):
    exact(value,REGISTRY_KEYS,'ROOT_REGISTRY_INVALID')
    need(type(value['version']) is int and value['version']==1 and value['producer']==producer(p)
         and type(value['p1Sha256']) is str and HEX.fullmatch(value['p1Sha256']),'ROOT_REGISTRY_INVALID')
    constructor.registry(value['referenceRegistry'])
    return value

def _save_registry(base,p,proof,reference_registry,constructor):
    need(proof['measurement']['purpose']=='INDEPENDENT_PREFLIGHT' and
         proof['measurement']['cleanupVerified'] is True,'ROOT_MEASUREMENT_INVALID')
    value=validate_registry({'version':1,'producer':producer(p),'p1Sha256':digest(proof),
                            'referenceRegistry':copy.deepcopy(reference_registry)},p,constructor)
    need(digest(reference_registry)==proof['measurement']['referenceRegistrySha256'],'ROOT_REGISTRY_INVALID')
    raw=canonical(value);need(len(raw)<=MAX_REGISTRY,'ROOT_REGISTRY_INVALID')
    parent=_registry_dir(base,create=True);fd=None
    try:
        try:fd=os.open(registry_filename(p),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK,0o600,dir_fd=parent)
        except FileExistsError:raise Rejected('ROOT_REGISTRY_EXISTS') from None
        initial=os.fstat(fd)
        need(stat.S_ISREG(initial.st_mode) and initial.st_uid==_uid() and initial.st_nlink==1 and
             stat.S_IMODE(initial.st_mode)==0o600 and initial.st_size==0,'ROOT_REGISTRY_INVALID')
        offset=0
        while offset<len(raw):
            wrote=os.write(fd,raw[offset:]);need(wrote>0,'ROOT_REGISTRY_INVALID');offset+=wrote
        os.fsync(fd);final=os.fstat(fd)
        need(file_identity(final)==file_identity(os.stat(registry_filename(p),dir_fd=parent,follow_symlinks=False)) and
             final.st_size==len(raw),'ROOT_REGISTRY_CHANGED')
        os.fsync(parent)
        visible_parent=_registry_dir(base,create=False)
        try:need(file_identity(os.fstat(parent))==file_identity(os.fstat(visible_parent)),'ROOT_REGISTRY_CHANGED')
        finally:os.close(visible_parent)
    finally:
        if fd is not None:os.close(fd)
        os.close(parent)
    # Reopen through the complete protected parent chain, not our retained fd.
    need(_read_registry(base,p,constructor)==value,'ROOT_REGISTRY_CHANGED')
    return digest(value)

def _read_registry(base,p,constructor):
    parent=_registry_dir(base,create=False);fd=None
    try:
        try:fd=os.open(registry_filename(p),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
        except FileNotFoundError:raise Rejected('ROOT_REGISTRY_MISSING') from None
        directory_before=file_identity(os.fstat(parent))
        first=os.fstat(fd)
        need(stat.S_ISREG(first.st_mode) and first.st_uid==_uid() and first.st_nlink==1 and
             stat.S_IMODE(first.st_mode)==0o600 and 0<first.st_size<=MAX_REGISTRY,'ROOT_REGISTRY_INVALID')
        raw=b''
        while len(raw)<=MAX_REGISTRY:
            chunk=os.read(fd,min(4096,MAX_REGISTRY+1-len(raw)))
            if not chunk:break
            raw+=chunk
        need(len(raw)==first.st_size and file_identity(first)==file_identity(os.fstat(fd))==
             file_identity(os.stat(registry_filename(p),dir_fd=parent,follow_symlinks=False)),'ROOT_REGISTRY_CHANGED')
        visible_parent=_registry_dir(base,create=False)
        try:need(directory_before==file_identity(os.fstat(parent))==file_identity(os.fstat(visible_parent)),'ROOT_REGISTRY_CHANGED')
        finally:os.close(visible_parent)
    finally:
        if fd is not None:os.close(fd)
        os.close(parent)
    return validate_registry(decode(raw),p,constructor)

def _current(d,directory):
    path=Path(directory);base=Path(d.BASE)
    need(path.is_absolute() and path.parent==base/'releases' and not path.is_symlink() and path.resolve()==path
         and re.fullmatch('[0-9]{8}T[0-9]{6}Z-'+BASELINE[:12],path.name)
         and (base/'current').resolve()==path,'ROOT_SOURCE_CHANGED')
    return path

def _producer(workspace,d,expected):
    value=producer(workspace.pending_online_declaration_producer(d))
    need(value==producer(expected),'ROOT_PRODUCER_CHANGED');return value

def _entry(workspace,d,purpose):
    need(purpose in ('INDEPENDENT_PREFLIGHT','DEPLOYMENT_REMEASURE'),'ROOT_ENTRY_INVALID')
    expected='PREFLIGHT' if purpose=='INDEPENDENT_PREFLIGHT' else 'STAGE'
    need(workspace.pending_online_declaration_entry(d)==expected,'ROOT_ENTRY_INVALID')

def _inspect(reader,d,*args):
    value=reader.decode(d.run(*args,timeout=30))
    need(type(value) is list and len(value)==1 and type(value[0]) is dict,'ROOT_ACQUISITION_UNAVAILABLE')
    return value[0]

class _ArchiveBoundController:
    """Only archived current pure consumers; execution stays actual raw run."""
    def __init__(self,raw,caps):
        self._raw=raw;self._caps=caps;self.BASE=raw.BASE
        self.ALL_SERVICES=tuple(caps.reader.INVENTORY.SERVICES)
    def api_admin_scope(self,name):
        need(name=='API_ADMIN_WORKSPACE','ROOT_ACQUISITION_UNAVAILABLE')
        return self._caps.workspace,Path(self._caps.workspace.__file__)
    def __getattr__(self,name):
        need(name in ('run','require'),'ROOT_ACQUISITION_UNAVAILABLE')
        return getattr(self._raw,name)

class _SourceReadDriver:
    """One run's local archive cache; no external/private metadata delegation.

    All execution continues through the qualified fixed-host/private-client
    runner. Existing external history/database/backups gates are not rerun here.
    """
    _PUBLIC = frozenset(('run','compose','production_services','service_state','require','api_admin_scope','ALL_SERVICES'))
    def __init__(self,runner):
        self._runner=runner
        self.BASE=runner.BASE
        self._declarationSourceArchiveCache={}
    def __getattr__(self,name):
        need(name in self._PUBLIC,'ROOT_ACQUISITION_UNAVAILABLE')
        return getattr(self._runner,name)

def acquire(caps,d,directory,recovery,p):
    """Actual LIVE history/archive + seven snapshots + complete resources in memory."""
    online,reader=caps.online,caps.reader
    directory=_current(d,directory)
    # The fixed external entry already ran its original complete history/DB/
    # backup gates. We bind that context again to actual LIVE original bytes.
    need(type(recovery) is dict and type(recovery.get('restored')) is dict and
         digest(recovery.get('policy'))==online.RECOVERY_POLICY_SHA256 and
         recovery.get('marker')==online.recovery_marker(recovery['policy']),
         'ROOT_HISTORY_CHANGED')
    materials=online.declaration_equivalence_materials(d,directory,recovery,producer=p,phase='LIVE')
    need(type(materials) is dict and set(materials)=={'producer','archive_bytes','historical_files'}
         and type(materials['archive_bytes']) is bytes and type(materials['historical_files']) is dict,
         'ROOT_HISTORY_CHANGED')
    full=materials['producer'];need(all(full.get(k)==p[k] for k in PRODUCER_KEYS),'ROOT_PRODUCER_CHANGED')
    docs={k:online.closed_recovery_json(d,raw) for k,raw in materials['historical_files'].items()}
    need(digest(docs['recoveryPolicy'])==online.RECOVERY_POLICY_SHA256 and docs['recoveryPolicy']==recovery['policy'],
         'ROOT_HISTORY_CHANGED')
    anchors={n:{'oldBeforeContainerId':docs['workspaceRecordBytesSha256']['before'][n]['containerId'],
                'candidateAfterContainerId':docs['restoredRecordBytesSha256']['after'][n]['containerId']} for n in ('api','admin')}
    need(anchors==recovery['restored']['configurationAnchors'],'ROOT_HISTORY_CHANGED')
    services=online.snapshot(d,directory);online._declaration_states(services)
    original=recovery['policy']['preflight']['services']
    need(all(services[n]==original[n] for n in online.PRESERVED) and all(services[n][k]==original[n][k]
         for n in ('api','admin') for k in online.DECLARATION_EQUIVALENCE_STABLE_KEYS),'ROOT_OBSERVATION_CHANGED')
    names=tuple(dict.fromkeys((*reader.CONFIG_FILES,*reader.SOURCE_FILES,*reader.WORKSPACE_FILES)))
    files=reader.files(directory,names,0)
    configuration=online.configuration_hashes(directory);workspace=online.workspace_files(d,directory)
    source_files={n:files[n]['sha256'] for n in reader.SOURCE_FILES}
    need(configuration==recovery['restored']['configurationBefore'] and workspace==recovery['restored']['workspaceOriginFiles']
         and source_files[reader.SOURCE_FILES[2]]==recovery['restored']['environmentSha256']
         and {n:files[n]['sha256'] for n in reader.CONFIG_FILES}==configuration
         and {n:files[n]['sha256'] for n in reader.WORKSPACE_FILES}==workspace,'ROOT_SOURCE_CHANGED')
    api=_inspect(reader,d,'docker','inspect',services['api']['containerId'])
    project=api['Config']['Labels']['com.docker.compose.project']
    need(type(project) is str and reader.NAME.fullmatch(project),'ROOT_ACQUISITION_UNAVAILABLE')
    endpoints=api['NetworkSettings']['Networks']
    need(set(endpoints)=={project+'_'+r for r in reader.INVENTORY.NETWORK_ROLES},'ROOT_ACQUISITION_UNAVAILABLE')
    networks={r:_inspect(reader,d,'docker','network','inspect',endpoints[project+'_'+r]['NetworkID']) for r in reader.INVENTORY.NETWORK_ROLES}
    volume=_inspect(reader,d,'docker','volume','inspect',project+'_'+reader.WORKSPACE['WORKSPACE_VOLUME'])
    volume_summary=online.legacy(d).workspace_volume(d,directory,attached=True,api_metadata=api)
    need(volume_summary==reader.volume_summary(volume)==docs['workspaceRecordBytesSha256']['workspaceVolumeAfter'],
         'ROOT_OBSERVATION_CHANGED')
    raw={'snapshot':services,'sourceFiles':{'configurationFiles':source_files,'workspaceFiles':workspace},
         'workspaceVolume':volume,'actualResource':{'networks':networks,'volume':volume}}
    observation=reader.DERIVE.observation(raw,services,source_files,raw['actualResource'])
    seal={'baselineCommit':BASELINE,'directory':str(directory),'files':source_files,'servicesSha256':digest(services),
          'stabilitySha256':digest(observation),'replaceAnchors':{'candidateAfterContainerId':anchors['api']['candidateAfterContainerId'],
          'stableName':api['Name'].lstrip('/')}}
    callback=reader.make_reader(d,directory,source_seal=seal,services=services,configuration=configuration,
                               workspace_files=workspace,workspace_volume=volume_summary)
    first=callback();need(first==raw,'ROOT_OBSERVATION_CHANGED')
    admin=_inspect(reader,d,'docker','inspect',services['admin']['containerId'])
    projection=online.restored_configuration_projection(d,'admin',admin,services['admin'],original['admin'],anchors['admin'])
    need(projection=={'rawSha256':services['admin']['configurationSha256'],
                      'projectedSha256':original['admin']['configurationSha256']},'ROOT_ADMIN_PROJECTION_FAILED')
    need(_inspect(reader,d,'docker','inspect',services['admin']['containerId'])==admin,'ROOT_OBSERVATION_CHANGED')
    root={'producer':copy.deepcopy(full),'recoveryPolicy':copy.deepcopy(recovery['policy']),
          'historicalFiles':{k:materials['historical_files'][k] for k in online.DECLARATION_EQUIVALENCE_FIELDS['historicalFiles']},
          'anchors':anchors,'actual':copy.deepcopy(services),'adminProjection':{
            'kind':'ADMIN_OLD_COMPLETE_CONFIGURATION_MATCH','originalConfigurationSha256':original['admin']['configurationSha256'],
            'projectedConfigurationSha256':projection['projectedSha256'],'actualConfigurationSha256':projection['rawSha256'],
            'helperSha256':full['helpers'][online.DECLARATION_EQUIVALENCE_HELPERS[2]]},
          'configurationFiles':configuration,'workspaceFiles':workspace,'environmentFileSha256':source_files[reader.SOURCE_FILES[2]],
          'stableObservation':observation,'sourceArchiveBytesSha256':byte_sha(materials['archive_bytes']),
          'generatorRulesSha256':None}
    return {'root':root,'source_seal':seal,'materials':materials,'reader':callback}

def measure_declaration_equivalence(d,directory,recovery,*,producer:dict,purpose,preflight_raw=None):
    stage='ENTRY';caps=None;failure=None
    try:
        need(os.geteuid()==0,'ROOT_ENTRY_INVALID')
        stage='PACKAGE_BIND'
        caps=_capabilities(producer)
        stage='ENTRY'
        p=_producer(caps.workspace,d,producer);_entry(caps.workspace,d,purpose)
        need(preflight_raw is None if purpose=='INDEPENDENT_PREFLIGHT' else
             type(preflight_raw) is bytes and 0<len(preflight_raw)<65536,'ROOT_PREFLIGHT_CHANGED')
        # The public successor context is fixed-source reviewed, private-empty
        # client, VFS2/runtime/tool qualified. No caller/admission bool can replace it.
        stage='ACQUISITION'
        factory=getattr(caps.qualified,'acquisition_session',None)
        need(callable(factory),'ROOT_ACQUISITION_UNAVAILABLE')
        with factory(_ArchiveBoundController(d,caps)) as session:
            try:
                stage='RULES'
                runner=_SourceReadDriver(session.runner)
                if hasattr(caps,'package'):caps.package.assert_stable()
                rules=session.reviewed_rules()
                exact(rules,('spec','rulesSha256','sourceInputsSha256','sourceReviewReportSha256'))
                need(digest(rules['spec'])==rules['rulesSha256'] and all(type(rules[k]) is str and HEX.fullmatch(rules[k])
                     for k in ('rulesSha256','sourceInputsSha256','sourceReviewReportSha256')),'ROOT_GENERATOR_SOURCE_UNMEASURED')
                session.assert_stable()
                stage='ACQUIRE'
                acquired=acquire(caps,runner,directory,recovery,p)
                root=acquired['root'];root['generatorRulesSha256']=rules['rulesSha256']
                prior=None;fraw=None;first=None
                if purpose=='DEPLOYMENT_REMEASURE':
                    expected=getattr(d,'_apiWorkspaceDeclarationPreflightSha256',None)
                    need(type(expected) is str and HEX.fullmatch(expected),'ROOT_PREFLIGHT_CHANGED')
                    fraw=caps.online.declaration_equivalence_preflight_bytes(runner,producer=p,expected_sha=expected)
                    need(fraw==preflight_raw,'ROOT_PREFLIGHT_CHANGED')
                    f=caps.online.closed_recovery_json(runner,fraw)
                    first=f['pendingOnlineMigrationOrigin']['restoredConfigurationProof']
                    caps.online.validate_declaration_equivalence_proof(runner,first)
                    need(first['semantic']['producer']==root['producer'] and first['measurement']['purpose']=='INDEPENDENT_PREFLIGHT',
                         'ROOT_PRODUCER_CHANGED')
                    stage='REGISTRY'
                    prior=_read_registry(runner.BASE,p,caps.constructor)
                    need(prior['p1Sha256']==digest(first) and digest(prior['referenceRegistry'])==first['measurement']['referenceRegistrySha256'],
                         'ROOT_REGISTRY_CHANGED')
                stage='MEASURE'
                result=session.measure(directory,services=root['actual'],image_reference=root['actual']['api']['reference'],
                         image_id=root['actual']['api']['image'],source_seal=acquired['source_seal'],stability_reader=acquired['reader'])
                exact(result,('measured','facts'),'ROOT_MEASUREMENT_INVALID')
                stage='AFTER'
                after=acquired['reader']()
                need(caps.reader.DERIVE.observation(after,root['actual'],acquired['source_seal']['files'],after['actualResource'])==root['stableObservation'],
                     'ROOT_OBSERVATION_CHANGED')
                _producer(caps.workspace,d,p);_entry(caps.workspace,d,purpose);_current(runner,directory)
                materials=caps.online.declaration_equivalence_materials(runner,directory,recovery,producer=p,phase='LIVE')
                need(materials==acquired['materials'],'ROOT_HISTORY_CHANGED')
                session.assert_stable()
                if hasattr(caps,'package'):caps.package.assert_stable()
                stage='CONSTRUCT'
                proof=caps.constructor.construct_preview(result['measured'],root=root,facts=result['facts'],purpose=purpose,
                    preflight_raw=fraw,prior_registry=prior['referenceRegistry'] if prior else None)
                caps.online.validate_declaration_equivalence_proof(runner,proof)
                caps.online.declaration_equivalence_source_binding(runner,proof,**materials)
                if first is not None:
                    caps.online.declaration_equivalence_pair_seal(runner,first,proof,fraw)
                    need(_read_registry(runner.BASE,p,caps.constructor)==prior,'ROOT_REGISTRY_CHANGED')
            except Exception as error:
                failure=_reason(error,stage,getattr(caps,'_diagnostic_errors',()))
                raise
            stage='CLOSE'
        # Private client cleanup/runtime exit must have succeeded before P1 is
        # persisted, so context failure cannot leave a registry implying success.
        stage='AFTER'
        _producer(caps.workspace,d,p);_entry(caps.workspace,d,purpose);_current(d,directory)
        if first is not None:
            need(_read_registry(d.BASE,p,caps.constructor)==prior,'ROOT_REGISTRY_CHANGED')
            need(caps.online.declaration_equivalence_preflight_bytes(d,producer=p,expected_sha=expected)==fraw,
                 'ROOT_PREFLIGHT_CHANGED')
        if hasattr(caps,'package'):caps.package.assert_stable()
        stage='REGISTRY'
        if purpose=='INDEPENDENT_PREFLIGHT':
            _save_registry(d.BASE,p,proof,result['facts']['referenceRegistry'],caps.constructor)
        return proof
    except Exception as error:
        bindings=getattr(caps,'_diagnostic_errors',()) if caps is not None else ()
        recorded=getattr(caps,'_diagnostic_failure',()) if caps is not None else ()
        if failure is None and recorded:failure=recorded[0]
        if failure is None:failure=_qualified_reason(error,caps)
        raise _rejected(error,stage,bindings,failure) from None
