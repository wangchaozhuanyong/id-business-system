"""Self-contained synthetic test fixture; excluded from transported closure."""
import copy,hashlib,importlib.util,json,os,stat,tempfile,unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
a=load('minimal_collector_fixture',HERE/'collector.py');M=load('actual_inventory_parser_for_mock',ROOT/'scripts/production-release/online-recharge-declaration-measurement.py')
D=load('pure_fixture',HERE/'pure.py');a._configure(M,D,json.loads((HERE/'contract.json').read_bytes()))
# Actual runtime capability I/O is forbidden in this exclusively synthetic path.
def unavailable():raise RuntimeError('MOCK_RUNTIME_NOT_MEASURED')
M.daemon_identity_capability=unavailable;M.daemon_socket_capability=unavailable
PRIVATE='CONTROL_ONLY_PRIVATE_SENTINEL'
PROJECT='source-project'
IMAGE='sha256:'+'a'*64
API_ID='4'*64
SOURCE_ENV={k:'CONTROL_SOURCE_'+k for k in a.ENV_KEYS}
ENV_IMAGE=['KEY='+PRIVATE,'KEY0=CONTROL_IMAGE_PREFIX']
ENDPOINT_KEYS=['Aliases','DNSNames','DriverOpts','EndpointID','Gateway','GlobalIPv6Address','GlobalIPv6PrefixLen','IPAddress',
               'IPAMConfig','IPPrefixLen','IPv6Gateway','Links','MacAddress','NetworkID']


def policy():
    return {'referenceNetworkPolicy':'OWNED_INTERNAL_IPV4_DEFAULT_POOL_V1','kind':'FROZEN_PRODUCTION_GENERATOR_V2','engineVersion':'25.0.16','composeVersion':'5.5.0',
      'engineApiVersion':'1.44','nativePlatform':'linux/x86_64','dockerCliSha256':'e'*64,'composeCliSha256':'e'*64,
      'dockerCliVersion':'25.0.14',
      'dockerPath':'/usr/bin/docker','composePath':'/usr/libexec/docker/cli-plugins/docker-compose',
      'sourceSha256':'f'*64,'poolSourceSha256':'1'*64,'networkFields':sorted(M.NETWORK_FIELDS-{'EnableIPv4'}),
      'volumeFields':sorted(M.VOLUME_FIELDS-{'Status'}),'enableIpv4Field':'ABSENT',
      'sourceIpamRowFields':['Gateway','Subnet'],'referenceIpamRowFields':['Gateway','Subnet'],
      'actualEndpointFields':list(ENDPOINT_KEYS),'referenceEndpointFields':list(ENDPOINT_KEYS),'referenceGateway':'FIRST_ADDRESS','referenceSubnetPrefix':None,
      'networkCreatorVersion':'5.5.0','volumeCreatorVersion':'5.5.0','defaultPoolsStatement':'DECLARED',
      'defaultPools':[{'base':'10.64.0.0/16','size':24}],
      'renderedDependencies':{'media-resolver':{'condition':'service_healthy','required':True},
                             'migrate':{'condition':'service_completed_successfully','required':True}},
      'renderedNetworkEntry':{},'renderedVolumeRow':{'type':'volume','source':a.VOLUME_KEY,'target':a.TARGET,'volume':{}},
      'renderedExternalNetworkExtra':{}}


def image():
    return {'Id':IMAGE,'Os':'linux','Architecture':'amd64','Config':{'Env':ENV_IMAGE,
             'Cmd':['node','dist/main.js'],'Entrypoint':['/entrypoint'],'Labels':{}}}


def api(directory):
    return {'build':{'context':str(directory),'dockerfile':'apps/api/Dockerfile.mysql','target':'runtime'},
      'cap_drop':['ALL'],'depends_on':copy.deepcopy(policy()['renderedDependencies']),
      'environment':copy.deepcopy(SOURCE_ENV),'healthcheck':{'test':a.HEALTH_TEST,'interval':'30s','timeout':'5s','start_period':'45s','retries':5},
      'init':True,'logging':{'driver':'json-file','options':{'max-file':'10','max-size':'20m'}},
      'networks':{r:{} for r in a.NETWORK_ROLES},'read_only':True,'restart':'unless-stopped',
      'security_opt':['no-new-privileges:true'],'tmpfs':['/tmp:rw,noexec,nosuid,nodev,size=64m'],
      'volumes':[copy.deepcopy(policy()['renderedVolumeRow'])],'image':'source-api','pull_policy':'never'}


def network(role,index,project=PROJECT,owner=None):
    ref=owner is not None;nid=hashlib.sha256((owner+role).encode()).hexdigest() if ref else str(index)*64
    subnet='10.64.'+str(index+100 if ref else index)+'.0/24'
    ipam={'Subnet':subnet,'Gateway':'10.64.'+str(index+100 if ref else index)+'.1'}
    members={} if ref else {API_ID:{'Name':PROJECT+'-api-1','EndpointID':str(index+4)*64,
      'MacAddress':'02:00:00:00:00:0'+str(index),'IPv4Address':'10.64.'+str(index)+'.2/24','IPv6Address':''}}
    labels={a.OWNER_KEY:owner} if ref else {'com.docker.compose.project':project,'com.docker.compose.network':role,'com.docker.compose.version':'5.5.0'}
    return {'Id':nid,'Name':project+'_'+role,'Created':'2026-10-10T00:00:00Z','Scope':'local','Driver':'bridge',
      'EnableIPv6':False,'IPAM':{'Driver':'default','Options':None,'Config':[ipam]},
      'Internal':True if ref else role.endswith('control'),'Attachable':False,'Ingress':False,'ConfigFrom':{'Network':''},
      'ConfigOnly':False,'Containers':members,'Options':{},'Labels':labels}


def volume(project=PROJECT,owner=None):
    return {'Name':project+'_'+a.VOLUME_KEY,'Driver':'local','Scope':'local','CreatedAt':'2026-10-10T00:00:00Z',
      'Mountpoint':'/fixture/'+project+'/volume','Options':None,'Labels':({a.OWNER_KEY:owner} if owner else {
        'com.docker.compose.project':project,'com.docker.compose.volume':a.VOLUME_KEY,'com.docker.compose.version':'5.5.0'})}


def metadata(directory,api_model,nets,vol,project=PROJECT,owner=None,files=None):
    ref=owner is not None;cid=hashlib.sha256(owner.encode()).hexdigest() if ref else API_ID
    config_labels={'com.docker.compose.project':project,'com.docker.compose.service':'api','com.docker.compose.container-number':'1',
      'com.docker.compose.oneoff':'False','com.docker.compose.version':'5.5.0','com.docker.compose.image':IMAGE,
      'com.docker.compose.project.working_dir':str(directory),
      'com.docker.compose.project.config_files':','.join(str(p) for p in (files or (directory/M.FILES[0],directory/M.FILES[1]))),
      'com.docker.compose.project.environment_file':str(directory/('.env.empty' if ref else M.FILES[2])),
      'com.docker.compose.config-hash':a.fingerprint(api_model),'com.docker.compose.depends_on':''}
    if ref:config_labels[a.OWNER_KEY]=owner
    else:config_labels['com.docker.compose.replace']='api-1'
    env=api_model['environment'] if ref else a.expected_env(api_model,image())
    eps={}
    for i,(role,net) in enumerate(nets.items(),1):
        eps[net['Name']]={'Aliases':[project+'-api-1','api'],'DNSNames':None if ref else [project+'-api-1','api',cid[:12]],'DriverOpts':None,'EndpointID':'' if ref else str(i+4)*64,
          'Gateway':'' if ref else '10.64.'+str(i)+'.1','GlobalIPv6Address':'','GlobalIPv6PrefixLen':0,
          'IPAddress':'' if ref else '10.64.'+str(i)+'.2','IPAMConfig':None,'IPPrefixLen':0 if ref else 24,
          'IPv6Gateway':'','Links':None,'MacAddress':'' if ref else '02:00:00:00:00:0'+str(i),'NetworkID':'' if ref else net['Id']}
    return {'Id':cid,'Image':IMAGE,'Name':'/'+project+'-api-1','Created':'2026-10-10T00:00:00Z','RestartCount':0,
      'State':({'Status':'created','Running':False,'Pid':0,'StartedAt':'0001-01-01T00:00:00Z'} if ref else {
         'Status':'running','Running':True,'Pid':100,'StartedAt':'2026-10-10T00:00:00Z','Health':{'Status':'healthy'}}),
      'Config':{'Image':'source-api','Env':[k+'='+v for k,v in env.items()],'Hostname':cid[:12],
        'Cmd':image()['Config']['Cmd'],'Entrypoint':image()['Config']['Entrypoint'],'Labels':config_labels,
        'Healthcheck':{'Test':a.HEALTH_TEST,'Retries':5},'User':'node','WorkingDir':'/app'},
      'HostConfig':{'Binds':[vol['Name']+':'+a.TARGET+':rw'],'NetworkMode':nets['default']['Name'],
        'Mounts':None,'Privileged':False,'ReadonlyRootfs':True,'Init':True,'CapDrop':['ALL'],
        'SecurityOpt':['no-new-privileges:true'],'Tmpfs':{'/tmp':'rw,noexec,nosuid,nodev,size=64m'},
        'RestartPolicy':{'Name':'unless-stopped','MaximumRetryCount':0},'LogConfig':{'Type':'json-file','Config':{'max-file':'10','max-size':'20m'}}},
      'Mounts':[{'Type':'volume','Driver':'local','Name':vol['Name'],'Source':vol['Mountpoint'],
        'Destination':a.TARGET,'Mode':'rw','RW':True,'Propagation':''}], 'NetworkSettings':{'Networks':eps}}


class FakeDocker:
    def __init__(self,base,directory):
        self.BASE=base;self.directory=directory;self.source_api=api(directory)
        self.source_model={'name':PROJECT,'services':{'api':self.source_api},'networks':{r:{'name':PROJECT+'_'+r,
          **({'internal':True} if r.endswith('control') else {})} for r in a.NETWORK_ROLES},'volumes':{a.VOLUME_KEY:{'name':PROJECT+'_'+a.VOLUME_KEY}}}
        self.source_model['services'].update({name:{'networks':{r:{} for r in roles}}
            for name,roles in a.DECLARED_SERVICE_ROLES.items() if name!='api'})
        self.source_networks={r:network(r,i) for i,r in enumerate(a.NETWORK_ROLES,1)};self.source_volume=volume()
        self.actual=metadata(directory,self.source_api,self.source_networks,self.source_volume)
        self.calls=[];self.removed=[];self.created_networks={};self.created_volume=None;self.created_container=None
        self.fail=None;self.reference_project=None;self.reference_owner=None
        self.services={name:{'image':IMAGE,'reference':'source-'+name,'status':'running','health':None if name=='caddy' else 'healthy',
           'containerId':str(i)*64,'startedAtSha256':'1'*64,'environmentSha256':'2'*64,'configurationSha256':'3'*64}
           for i,name in enumerate(M.SERVICES,1)}
        self.services['api']=a.identity(self.actual)
        self.seal={'baselineCommit':a.BASELINE,'directory':str(directory),
          'files':{n:a.sha((directory/n).read_bytes()) for n in M.FILES},'servicesSha256':a.fingerprint(self.services),
          'stabilitySha256':'b'*64,'replaceAnchors':{'candidateAfterContainerId':'9'*64,'stableName':PROJECT+'-api-1'}}
    def run(self,*raw,**kwargs):
        self.calls.append((raw,kwargs));args=list(raw)
        if args[0] in ('docker','/usr/bin/docker'):args[0]='docker'
        if args[0]==policy()['composePath']:
            if args[1:]==['version','--short']:return policy()['composeVersion']
            work=Path(args[args.index('--project-directory')+1]);project=args[args.index('--project-name')+1]
            model=json.loads((work/'compose.reference.json').read_text());self.reference_project=project
            self.reference_owner=model['services']['api']['labels'][a.OWNER_KEY]
            if 'config' in args:
                if '--hash' in args:return 'api '+a.fingerprint(model['services']['api'])
                if self.fail=='dry_model':model['services']['api']['init']=False
                return json.dumps(model)
            if 'create' in args:
                assert args[-6:]==['create','--no-build','--pull','never','api'] or 'create' in args
                assert 'up' not in args and 'start' not in args and '--no-build' in args and args[args.index('--pull')+1]=='never'
                self.created_container=metadata(work,model['services']['api'],self.created_networks,self.created_volume,
                  project,self.reference_owner,files=(work/'compose.reference.json',work/'compose.release.json'))
                if self.fail=='reference_cmd':self.created_container['Config']['Cmd']=['CONTROL_CHANGED']
                if self.fail=='reference_started':self.created_container['State'].update({'Running':True,'Status':'running','Pid':100})
                if self.fail=='source_network_changed':self.source_networks['default']['Created']='2026-10-10T00:00:01Z'
                if self.fail=='lost_create':raise RuntimeError(PRIVATE)
                if self.fail=='driver_rejected_secret':raise a.Rejected(PRIVATE)
                return 'created'
            raise AssertionError('Unexpected compose operation')
        if args[:2]==['docker','context']:return json.dumps([{'Endpoints':{'docker':{'Host':'unix:///var/run/docker.sock'}}}])
        if args[:2]==['docker','info']:return json.dumps({'id':'fixture-daemon','serverVersion':'25.0.16',
          'defaultAddressPools':[{'Base':'10.64.0.0/16','Size':24}],'osType':'linux','architecture':'x86_64',
          'plugins':[{'Name':'compose','Path':policy()['composePath']}]})
        if args[:2]==['docker','version']:return json.dumps({'Server':{'Version':'25.0.16','ApiVersion':'1.44'},'Client':{'Version':'25.0.14'}})
        if args[:3]==['docker','compose','version']:return '5.5.0'
        if args[:2]==['docker','compose']:
            return 'api '+a.fingerprint(self.source_api) if '--hash' in args else json.dumps(self.source_model)
        if args[:3]==['docker','image','inspect']:
            return json.dumps(IMAGE) if '--format' in args else json.dumps([image()])
        if args[:2]==['docker','inspect']:
            return json.dumps(self.actual['NetworkSettings']['Networks'] if args[3]=='{{json .NetworkSettings.Networks}}' else self.actual['Mounts'])
        kind=args[1]
        if args[2]=='ls':
            if '--filter' in args:
                labels=[args[i+1] for i,v in enumerate(args) if v=='--filter']
                owner=next((v.split('=',2)[-1] for v in labels if a.OWNER_KEY in v),None)
                if kind=='container':return self.created_container['Id'] if self.created_container and self.reference_owner==owner else ''
                if kind=='volume':return self.created_volume['Name'] if self.created_volume and self.reference_owner==owner else ''
                return '\n'.join(n['Id'] for n in self.created_networks.values() if n['Labels'].get(a.OWNER_KEY)==owner)
            if kind=='container':return '\n'.join([r['containerId'] for r in self.services.values()])
            if kind=='volume':return self.source_volume['Name']
            if args[-1]=='{{.Name}}':return '\n'.join(n['Name'] for n in self.source_networks.values())
            return '\n'.join(n['Id'] for n in self.source_networks.values())
        if args[2]=='create':
            name=args[-1];owner=args[args.index('--label')+1].split('=',1)[1]
            self.reference_owner=owner;self.reference_project=name[:-len(a.VOLUME_KEY)-1] if kind=='volume' else next(name[:-len(r)-1] for r in a.NETWORK_ROLES if name.endswith('_'+r))
            if kind=='network':
                role=next(r for r in a.NETWORK_ROLES if name.endswith('_'+r));row=network(role,len(self.created_networks)+1,self.reference_project,owner)
                self.created_networks[role]=row
                if self.fail=='invalid_ula':row['IPAM']['Config'][0]['Subnet']='10.0.0.0/24'
                if self.fail=='foreign_lost_network':
                    row['Labels'][a.OWNER_KEY]='CONTROL_FOREIGN_OWNER';raise RuntimeError(PRIVATE)
                if self.fail=='lost_network':raise RuntimeError(PRIVATE)
                return row['Id']
            self.created_volume=volume(self.reference_project,owner)
            return name
        if args[2]=='inspect':
            target=args[3]
            if kind=='container':
                row=self.actual if target==API_ID else self.created_container
                if row is None or row['Id']!=target:raise RuntimeError('not found')
                # Synthetic Moby API 1.44 inspect projection; the stored metadata
                # and source model remain unchanged, just as the daemon copies them.
                inspected=copy.deepcopy(row)
                for endpoint in inspected['NetworkSettings']['Networks'].values():
                    endpoint['Aliases']=list(dict.fromkeys([*endpoint['Aliases'],
                        inspected['Id'][:12],inspected['Config']['Hostname']]))
                return json.dumps([inspected])
            if kind=='volume':
                for row in [self.source_volume,self.created_volume]:
                    if row is not None and row['Name']==target:return json.dumps([row])
                raise RuntimeError('not found')
            for row in [*self.source_networks.values(),*self.created_networks.values()]:
                if target in (row['Id'],row['Name']):return json.dumps([row])
            raise RuntimeError('not found')
        if args[2]=='rm':
            target=args[3];self.removed.append((kind,target))
            if kind=='container':self.created_container=None
            elif kind=='volume':self.created_volume=None
            else:self.created_networks={r:n for r,n in self.created_networks.items() if n['Id']!=target}
            return target
        raise AssertionError('Unexpected fixture command')

