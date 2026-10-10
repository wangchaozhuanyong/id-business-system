"""Pure, bounded facts derivations. No driver, subprocess, or production authority."""
import copy
import hashlib
import json
import math
import re

ROLES = ('default','media-egress','recharge-control','registration-control')
OWNER_KEY = 'id-business-v2.online-recharge.declaration-reference-owner'
HEX = re.compile('[a-f0-9]{64}\\Z')
NONCE = re.compile('[a-f0-9]{32}\\Z')
MAX_RAW = 2 * 1024**2
ZERO = '0001-01-01T00:00:00Z'

class FactsRejected(RuntimeError):
    pass

def require(ok):
    if not ok:
        raise FactsRejected('FACTS_INPUT_INVALID')

def canonical(value):
    # Reject unsupported/subclass/bool-as-int and non-finite JSON anywhere.
    def walk(v,depth=0):
        require(depth <= 64)
        if type(v) is dict:
            require(all(type(k) is str for k in v))
            for x in v.values():walk(x,depth+1)
        elif type(v) is list:
            for x in v:walk(x,depth+1)
        else:
            require(type(v) in (str,int,float,bool,type(None)))
            if type(v) is float:require(math.isfinite(v))
    walk(value)
    raw=json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    require(len(raw)<=MAX_RAW)
    return raw

def digest(value):return hashlib.sha256(canonical(value)).hexdigest()
def byte_sha(value):
    require(type(value) is bytes and len(value)<=MAX_RAW)
    return hashlib.sha256(value).hexdigest()

def exact(value,keys):
    require(type(value) is dict and set(value)==set(keys));canonical(value);return value

def environment_digest(env):
    require(type(env) is dict and all(type(k) is str and re.fullmatch('[A-Za-z_][A-Za-z0-9_]*',k)
        and type(v) is str for k,v in env.items()))
    return digest(sorted(k+'='+v for k,v in env.items()))

def normalize_source_intent(model,directory,project,expected,default_env):
    """Complete D + full image/default union, fixed source roles only.

    Runtime project/directory names become unambiguous typed JSON role objects;
    no recursive deletion or caller mask. Unknown fields survive unchanged. An
    unknown occurrence of the known physical source path/project is rejected.
    Container target paths and literal business values remain intact.
    """
    require(type(directory) is str and directory.startswith('/') and type(project) is str)
    require(type(model) is dict and model.get('name')==project and type(model.get('services')) is dict)
    result=copy.deepcopy(model);result['name']={'fixedRole':'SOURCE_PROJECT'}
    def source_path(value):
        require(type(value) is str and (value==directory or value.startswith(directory+'/')))
        relative=value[len(directory):].lstrip('/')
        require(not any(part in ('.','..') for part in relative.split('/')))
        return {'fixedRole':'SOURCE_DIRECTORY','relative':relative}
    for service in result['services'].values():
        require(type(service) is dict)
        build=service.get('build')
        if type(build) is dict and 'context' in build:
            build['context']=source_path(build['context'])
        mounts=service.get('volumes',[])
        require(type(mounts) is list)
        for row in mounts:
            require(type(row) is dict)
            if row.get('type')=='bind':row['source']=source_path(row.get('source'))
    for role,row in result.get('networks',{}).items():
        require(type(row) is dict and row.get('name')==project+'_'+role)
        row['name']={'fixedRole':'SOURCE_NETWORK','role':role}
    for role,row in result.get('volumes',{}).items():
        require(type(row) is dict and row.get('name')==project+'_'+role)
        row['name']={'fixedRole':'SOURCE_VOLUME','role':role}
    # Never copy a reference role/nonce into stable intent; reject unknown source
    # physical identifiers rather than normalize fields without a fixed rule.
    def leftovers(v):
        if type(v) is dict:
            require(OWNER_KEY not in v)
            for x in v.values():leftovers(x)
        elif type(v) is list:
            for x in v:leftovers(x)
        elif type(v) is str:
            require(directory not in v and project not in v and 'online-recharge-reference-' not in v)
    leftovers(result)
    environment_digest(expected);environment_digest(default_env)
    return {'kind':'FIXED_OLD_DECLARATION_INTENT_V1','declaration':result,
        'imageDefaultEnvironment':copy.deepcopy(default_env),'expectedEnvironment':copy.deepcopy(expected)}

def observation(raw,services,configuration_files,actual_resource):
    exact(raw,('snapshot','sourceFiles','workspaceVolume','actualResource'))
    require(raw['snapshot']==services and raw['actualResource']==actual_resource)
    exact(raw['sourceFiles'],('configurationFiles','workspaceFiles'))
    require(raw['sourceFiles']['configurationFiles']==configuration_files)
    workspace=raw['sourceFiles']['workspaceFiles']
    require(type(workspace) is dict and bool(workspace) and all(type(k) is str and k
        and type(v) is str and HEX.fullmatch(v) for k,v in workspace.items()))
    # The trusted root callback supplies the complete volume inspect, not a
    # claimed PRESENT/hash/boolean. Bind it to our independently read volume.
    require(raw['workspaceVolume']==actual_resource['volume'])
    volume=raw['workspaceVolume']
    require(type(volume) is dict and type(volume.get('Name')) is str)
    identity={n:volume.get(n) for n in ('Name','Driver','Scope','Mountpoint','Labels','CreatedAt','Options')}
    observed=copy.deepcopy(raw)
    observed['workspaceVolume']={'name':volume['Name'],'status':'PRESENT','identitySha256':digest(identity)}
    return {name+'Sha256':digest(observed[node]) for name,node in (
        ('snapshot','snapshot'),('sourceFiles','sourceFiles'),
        ('workspaceVolume','workspaceVolume'),('actualResource','actualResource'))}

def state(meta):
    s=exact({key:meta['State'][key] for key in ('Status','Running','Pid','StartedAt')},('Status','Running','Pid','StartedAt'))
    require(s['Status']=='created' and s['Running'] is False and type(s['Pid']) is int and s['Pid']==0
        and s['StartedAt']==ZERO and type(meta['RestartCount']) is int and meta['RestartCount']==0)
    return {'status':s['Status'],'running':s['Running'],'pid':s['Pid'],
        'startedAtSha256':byte_sha(s['StartedAt'].encode()),'restartCount':meta['RestartCount']}

def resource_record(kind,created,current,owner):
    require(type(owner) is str and NONCE.fullmatch(owner))
    require(digest(created)==digest(current))
    labels=created['Config']['Labels'] if kind=='container' else created['Labels']
    require(labels.get(OWNER_KEY)==owner)
    name=created['Name'];project='online-recharge-reference-'+owner
    require(type(name) is str)
    if kind=='container':require(name=='/'+project+'-api-1')
    elif kind=='volume':require(name==project+'_auto_registration_data')
    else:require(name in {project+'_'+r for r in ROLES})
    row={'name':name,'owner':owner,'createdAtSha256':byte_sha(created['CreatedAt' if kind=='volume' else 'Created'].encode()),
        'creationMetadataSha256':digest(created),'preCleanupMetadataSha256':digest(current)}
    if kind!='volume':
        require(type(created['Id']) is str and HEX.fullmatch(created['Id']));row['id']=created['Id']
    if kind=='container':
        row.update({'stateAtCreate':state(created),'stateBeforeCleanup':state(current)})
    return row

def registry(created,pre_cleanup,owner):
    exact(created,('container','networks','volume'));exact(pre_cleanup,('container','networks','volume'))
    exact(created['networks'],ROLES);exact(pre_cleanup['networks'],ROLES)
    rows={'container':resource_record('container',created['container'],pre_cleanup['container'],owner),
        'networks':{r:resource_record('network',created['networks'][r],pre_cleanup['networks'][r],owner) for r in ROLES},
        'volume':resource_record('volume',created['volume'],pre_cleanup['volume'],owner)}
    require(len({v['id'] for v in rows['networks'].values()})==4)
    return rows
