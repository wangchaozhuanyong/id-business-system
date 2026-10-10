"""Independent minimal runtime derivation; imports perform no collection."""
import copy
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import stat
import uuid

HERE = Path(__file__).resolve().parent
frozen = None
derive = None
FORMAL_TABLE_SHA = None
BASELINE = None
NETWORK_ROLES = ('default','media-egress','recharge-control','registration-control')

def _configure(inventory,pure,contract):
    global frozen,derive,FORMAL_TABLE_SHA,check,fingerprint,sha,Rejected,BASELINE,NETWORK_ROLES
    if inventory.BASELINE!=contract['baselineCommit'] or tuple(inventory.NETWORK_ROLES)!=NETWORK_ROLES:
        raise RuntimeError('PACKAGE_SCHEMA_CHANGED')
    frozen=inventory;derive=pure;FORMAL_TABLE_SHA=contract['formalTableSha256']
    check,fingerprint,sha,Rejected=inventory.check,inventory.fingerprint,inventory.sha,inventory.Rejected
    BASELINE,NETWORK_ROLES=inventory.BASELINE,inventory.NETWORK_ROLES

TARGET, VOLUME_KEY = '/app/.runtime/auto-registration', 'auto_registration_data'
OWNER_KEY = 'id-business-v2.online-recharge.declaration-reference-owner'
DEPS = ('media-resolver:service_healthy:false', 'migrate:service_completed_successfully:false')
ENV_KEYS = frozenset(('APP_PORT', 'APP_PUBLIC_URL', 'AUTH_PROVIDER', 'AUTO_RECHARGE_WORKER_TOKEN',
 'AUTO_RECHARGE_WORKER_URL', 'AUTO_REGISTRATION_WORKER_URL', 'CORS_ORIGIN', 'CURRENCY_RATE_PROVIDER',
 'CURRENCY_RATE_REQUEST_TIMEOUT_MS', 'DATABASE_URL', 'FIELD_ENCRYPTION_KEY', 'GOOGLE_DRIVE_SYNC_FOLDER_ID',
 'HASH_SECRET', 'ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED', 'ID_BUSINESS_V2_EXCHANGE_RATE_NETWORK_ENABLED',
 'ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP', 'ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS',
 'ID_BUSINESS_V2_FREE_MANUAL_MODE', 'ID_BUSINESS_V2_MEDIA_RESOLVER_URL', 'JWT_EXPIRES_IN', 'JWT_SECRET',
 'MICROSOFT_MAIL_OAUTH_CLIENT_ID', 'MICROSOFT_MAIL_OAUTH_CLIENT_SECRET', 'MICROSOFT_MAIL_OAUTH_REDIRECT_URI',
 'NODE_ENV', 'VENDURE_MAILBOX_ADMIN_API_URL', 'VENDURE_MAILBOX_API_KEY', 'VENDURE_MAILBOX_SHOP_API_URL',
 'VENDURE_MAILBOX_WEBHOOK_SECRET', 'WEBSITE_ANALYTICS_SERVICE_ACCOUNT_JSON', 'WEBSITE_VISIT_INGEST_SECRET'))
HEALTH_TEST = ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/api/health/ready').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
REVIEWED_GENERATORS = {}  # Intentionally empty. Never import LOCAL fixture policies.
SPEC_KEYS = frozenset(('referenceNetworkPolicy', 'kind', 'engineVersion', 'composeVersion', 'engineApiVersion', 'nativePlatform',
 'dockerCliVersion', 'dockerCliSha256', 'composeCliSha256', 'dockerPath', 'composePath', 'sourceSha256', 'poolSourceSha256',
 'networkFields', 'volumeFields', 'enableIpv4Field', 'sourceIpamRowFields', 'referenceIpamRowFields',
 'actualEndpointFields', 'referenceEndpointFields', 'referenceGateway', 'referenceSubnetPrefix', 'networkCreatorVersion',
 'volumeCreatorVersion', 'defaultPoolsStatement', 'defaultPools', 'renderedDependencies',
 'renderedNetworkEntry', 'renderedVolumeRow', 'renderedExternalNetworkExtra'))
SEAL_KEYS = frozenset(('baselineCommit', 'directory', 'files', 'servicesSha256', 'stabilitySha256', 'replaceAnchors'))
PACK_KEYS = frozenset(('project', 'directory', 'filesLabel', 'envFile', 'configHash', 'metadata',
 'api', 'image', 'imageReference', 'imageId', 'networks', 'volume', 'owner', 'replaceAnchors'))
DECLARED_SERVICE_ROLES = {
    'mysql': ('default',), 'migrate': ('default',), 'media-resolver': ('media-egress',),
    'auto-recharge': ('recharge-control', 'recharge-egress'),
    'auto-registration': ('registration-control', 'registration-egress'),
    'api': NETWORK_ROLES, 'admin': ('default',), 'caddy': ('default',),
}
ENDPOINT_FIELDS = frozenset(('Aliases', 'DNSNames', 'DriverOpts', 'EndpointID', 'Gateway', 'GlobalIPv6Address',
    'GlobalIPv6PrefixLen', 'IPAddress', 'IPAMConfig', 'IPPrefixLen', 'IPv6Gateway', 'Links', 'MacAddress', 'NetworkID'))
# Only our literal codes may escape, including when the supplied driver raises a
# Rejected exception itself. Its arbitrary exception text remains in memory.
ERROR_CODES = frozenset(('ACTUAL_IDENTITY','ACTUAL_IDENTITY_CHANGED','ACTUAL_INSPECT_CHANGED','ACTUAL_NETWORK_ADDRESS','ACTUAL_NETWORK_DECLARATION','ACTUAL_NETWORK_ID_OR_MEMBERS','ACTUAL_NETWORK_INSPECT_CHANGED','ACTUAL_NETWORK_MEMBERS','ACTUAL_NETWORK_SET','ACTUAL_PRIMARY_NETWORK','ACTUAL_STATE_OR_ENV','ACTUAL_VOLUME_INSPECT_CHANGED','BOUND_LABEL','CLEANUP_FAILED','CLEANUP_REMAINING','CLEANUP_SEAL_CHANGED','CLIENT_DEFAULT_INJECTION','CLI_SOURCE_CHANGED','COMPLETE_CONFIGURATION_DIFFERENCE','CONFIGURATION_INVALID','DAEMON_CHANGED','DAEMON_SOURCE_NOT_MEASURED','DEPENDENCY_LABEL','ENV_INVALID','EXISTING_REFERENCE_REFUSED','HOST_MOUNTS_SHAPE','IMAGE_INSPECT_CHANGED','MEASUREMENT_FAILED','MOUNT_BINDING','ORIGIN_CHANGED','PACK_IMAGE_OR_NATIVE_IDENTITY','PACK_INVALID','PRIMARY_NETWORK','PRIMARY_NETWORK_OR_IMAGE','REFERENCE_ID_CHANGED','REFERENCE_MODEL_CHANGED','REFERENCE_NETWORK_OVERLAP','REFERENCE_NETWORK_SET','REFERENCE_PATH_INVALID','REFERENCE_PENDING_ENDPOINT','REFERENCE_RESOURCE_CHANGED','REFERENCE_STARTED_OR_OWNER_CHANGED','REFERENCE_STATE_OWNER_OR_ENV','REPLACE_LABEL','RESOURCE_DEFAULT_POOL_INVALID','RESOURCE_INVENTORY_INVALID','RESOURCE_IPAM_INVALID','RESOURCE_OWNER_OR_MEMBERS_INVALID','RESOURCE_PROPERTIES_INVALID','RESOURCE_READ_INVALID','RESOURCE_SCHEMA_INVALID','RESOURCE_VOLUME_INVALID','SOURCE_DECLARATION_INVALID','SOURCE_ENV_INVALID','SOURCE_ENV_SEAL_CHANGED','SOURCE_FILES_CHANGED','SOURCE_FILE_INVALID','SOURCE_FILE_PERMISSIONS','SOURCE_IMAGE_INVALID','SOURCE_MODEL_HASH_INVALID','SOURCE_NETWORK_DECLARATION','SOURCE_NOT_MEASURED','SOURCE_PATH_INVALID','SOURCE_PROJECT_INVALID','SOURCE_REPLACE_ANCHOR_INVALID','SOURCE_SEAL_INVALID','SOURCE_VOLUME_DECLARATION'))


def bounded_error(error):
    return str(error) if isinstance(error, Rejected) and str(error) in ERROR_CODES else 'MEASUREMENT_FAILED'


def env_map(values):
    check(isinstance(values, list), 'ENV_INVALID')
    out = {}
    for item in values:
        check(isinstance(item, str) and '=' in item, 'ENV_INVALID')
        key, value = item.split('=', 1)
        check(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) and key not in out, 'ENV_INVALID')
        out[key] = value
    return out


def expected_env(api, image):
    values = api.get('environment')
    check(isinstance(values, dict) and set(values) == ENV_KEYS and all(isinstance(v, str) for v in values.values()),
          'SOURCE_ENV_INVALID')
    return {**env_map(image.get('Config', {}).get('Env')), **values}


def surrogate(values):
    return {key: 'DECLARATION_SURROGATE_V1_' + sha(key) for key in values}


def configuration(meta):
    mounts = meta.get('Mounts')
    check(isinstance(meta.get('Config'), dict) and isinstance(meta.get('HostConfig'), dict)
          and isinstance(mounts, list) and all(isinstance(m, dict) and isinstance(m.get('Destination'), str)
          for m in mounts) and len({m['Destination'] for m in mounts}) == len(mounts), 'CONFIGURATION_INVALID')
    return {'Config': copy.deepcopy(meta['Config']), 'HostConfig': copy.deepcopy(meta['HostConfig']),
            'Mounts': sorted(copy.deepcopy(mounts), key=lambda m: m['Destination'])}


def never_started(meta):
    state = meta.get('State', {})
    return (state.get('Status') == 'created' and state.get('Running') is False and type(state.get('Pid')) is int
            and state['Pid'] == 0 and state.get('StartedAt') == '0001-01-01T00:00:00Z'
            and type(meta.get('RestartCount')) is int and meta['RestartCount'] == 0)


def _file_identity(info):
    return (info.st_dev,info.st_ino,info.st_uid,info.st_gid,info.st_mode,info.st_nlink,
            info.st_size,info.st_mtime_ns,info.st_ctime_ns)

def _file_parent(path):
    check(path.is_absolute() and '..' not in path.parts,'SOURCE_FILE_INVALID')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    chain=[]
    try:
        root=os.fstat(fd);chain.append((root.st_dev,root.st_ino,root.st_uid,root.st_gid,root.st_mode))
        for part in path.parts[1:-1]:
            visible=os.stat(part,dir_fd=fd,follow_symlinks=False)
            check(stat.S_ISDIR(visible.st_mode),'SOURCE_FILE_INVALID')
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            try:
                opened=os.fstat(child)
                check(_file_identity(opened)==_file_identity(visible),'SOURCE_FILE_INVALID')
                chain.append((opened.st_dev,opened.st_ino,opened.st_uid,opened.st_gid,opened.st_mode))
            except Exception:os.close(child);raise
            os.close(fd);fd=child
        return fd,chain
    except Exception:os.close(fd);raise

# Private observation only: original check values, order, and exception stay intact.
_SOURCE_FILE_PERMISSION_REASON = None
_SOURCE_FILE_PERMISSION_FAILURE = None
_SOURCE_FILE_PERMISSION_PAIRS = frozenset((
    ('COMPOSE','PARENT_UID'),('COMPOSE','PARENT_WRITABLE'),('COMPOSE','PUBLIC_WRITABLE'),
    ('RELEASE','PARENT_UID'),('RELEASE','PARENT_WRITABLE'),('RELEASE','PUBLIC_WRITABLE'),
    ('CLIENT','PARENT_UID'),('CLIENT','PARENT_WRITABLE'),('CLIENT','PRIVATE_MODE'),
))

def _source_file_permission_predicate(ok,reason):
    global _SOURCE_FILE_PERMISSION_REASON
    if ok is False:_SOURCE_FILE_PERMISSION_REASON=reason
    return ok

def _source_file_permission_original_error(error):
    if type(error) is not Rejected:return False
    args=BaseException.args.__get__(error)
    return type(args) is tuple and len(args)==1 and type(args[0]) is str and args[0]=='SOURCE_FILE_PERMISSIONS'

def _source_file_permission_channel():
    # Mutable observation state alone cannot issue a diagnostic. The closure
    # keeps the one tuple identity produced by the original rejection branch.
    issued=None
    def clear():
        nonlocal issued
        issued=None
    def issue(error,role,reason):
        nonlocal issued
        issued=(error,role,reason)
        return issued
    def source_file_permission_failure(error):
        row=_SOURCE_FILE_PERMISSION_FAILURE
        if row is not issued or not _source_file_permission_original_error(error):return None
        if (type(row) is tuple and len(row)==3 and row[0] is error
                and type(row[1]) is str and type(row[2]) is str
                and (row[1],row[2]) in _SOURCE_FILE_PERMISSION_PAIRS):return row[1:]
        return None
    return clear,issue,source_file_permission_failure

_source_file_permission_clear,_source_file_permission_issue,source_file_permission_failure=_source_file_permission_channel()

def _sealed_file(path,*,private=False):
    # Keep the original file_seal owner/mode/size rules, with captured bounded
    # bytes and complete descriptor/path/ancestor seals. No public admission API.
    global _SOURCE_FILE_PERMISSION_REASON,_SOURCE_FILE_PERMISSION_FAILURE
    _SOURCE_FILE_PERMISSION_REASON=None;_SOURCE_FILE_PERMISSION_FAILURE=None
    _source_file_permission_clear()
    path=Path(path);parent=None;fd=None
    try:
        parent,chain=_file_parent(path);info=os.stat(path.name,dir_fd=parent,follow_symlinks=False)
        check(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==os.getuid()
              and 0<=info.st_size<=1024**2,'SOURCE_FILE_INVALID')
        directory_info=os.fstat(parent)
        check(_source_file_permission_predicate(directory_info.st_uid==os.getuid(),'PARENT_UID')
              and _source_file_permission_predicate(stat.S_IMODE(directory_info.st_mode)&0o022==0,'PARENT_WRITABLE'),
              'SOURCE_FILE_PERMISSIONS')
        if private:check(_source_file_permission_predicate(stat.S_IMODE(info.st_mode) in (0o400,0o600),'PRIVATE_MODE'),'SOURCE_FILE_PERMISSIONS')
        else:check(_source_file_permission_predicate(stat.S_IMODE(info.st_mode)&0o022==0,'PUBLIC_WRITABLE'),'SOURCE_FILE_PERMISSIONS')
        fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
        check(_file_identity(os.fstat(fd))==_file_identity(info),'SOURCE_FILE_INVALID');raw=b''
        while len(raw)<=1024**2:
            data=os.read(fd,min(65536,1024**2+1-len(raw)))
            if not data:break
            raw+=data
        check(len(raw)==info.st_size and _file_identity(os.fstat(fd))==_file_identity(info)==
              _file_identity(os.stat(path.name,dir_fd=parent,follow_symlinks=False)),'SOURCE_FILE_INVALID')
        final,again=_file_parent(path)
        try:
            check(chain==again and os.fstat(final).st_dev==os.fstat(parent).st_dev
                  and os.fstat(final).st_ino==os.fstat(parent).st_ino,'SOURCE_FILE_INVALID')
        finally:os.close(final)
        return raw,{'sha256':sha(raw),'identitySha256':fingerprint({
            'device':info.st_dev,'inode':info.st_ino,'uid':info.st_uid,'gid':info.st_gid,
            'mode':info.st_mode,'size':info.st_size,'links':info.st_nlink})}
    except Rejected as error:
        # Classify only after the unchanged check rejected; no extra success-path reads.
        try:
            if _source_file_permission_original_error(error):
                name=path.name;role=None
                if type(name) is str:
                    if private is False:
                        if name=='docker-compose.aws-mysql.yml':role='COMPOSE'
                        elif name=='compose.release.json':role='RELEASE'
                    elif private is True and name=='config.json':role='CLIENT'
                reason=_SOURCE_FILE_PERMISSION_REASON
                if type(role) is str and type(reason) is str and (role,reason) in _SOURCE_FILE_PERMISSION_PAIRS:
                    _SOURCE_FILE_PERMISSION_FAILURE=_source_file_permission_issue(error,role,reason)
        except Exception:pass
        raise
    except Exception:raise Rejected('SOURCE_FILE_INVALID') from None
    finally:
        _SOURCE_FILE_PERMISSION_REASON=None
        if fd is not None:os.close(fd)
        if parent is not None:os.close(parent)

def file_seal(path,*,private=False):
    return _sealed_file(path,private=private)[1]


def spec_validate(report, spec):
    check(isinstance(spec, dict) and set(spec) == SPEC_KEYS
          and spec['kind'] == 'FROZEN_PRODUCTION_GENERATOR_V2' and spec['referenceNetworkPolicy'] == 'OWNED_INTERNAL_IPV4_DEFAULT_POOL_V1', 'SOURCE_NOT_MEASURED')
    g = report['generator']
    check(all(spec[key] == g[key] for key in ('engineVersion', 'composeVersion', 'engineApiVersion',
              'nativePlatform', 'dockerCliVersion', 'dockerCliSha256', 'composeCliSha256'))
          and all(isinstance(spec[key], str) and frozen.HEX.fullmatch(spec[key])
                  for key in ('sourceSha256', 'poolSourceSha256')), 'SOURCE_NOT_MEASURED')
    check(spec['dockerPath'] in ('/usr/bin/docker', '/usr/local/bin/docker') and spec['composePath'] in (
        '/usr/libexec/docker/cli-plugins/docker-compose', '/usr/lib/docker/cli-plugins/docker-compose',
        '/usr/local/lib/docker/cli-plugins/docker-compose', '/usr/local/libexec/docker/cli-plugins/docker-compose'),
        'SOURCE_NOT_MEASURED')
    for field, allowed in (('networkFields', frozen.NETWORK_FIELDS), ('volumeFields', frozen.VOLUME_FIELDS)):
        check(isinstance(spec[field], list) and spec[field] == sorted(set(spec[field]))
              and set(spec[field]) <= allowed, 'SOURCE_NOT_MEASURED')
    required_network = frozen.NETWORK_FIELDS - {'EnableIPv4'}
    check(set(spec['networkFields']) == required_network | ({'EnableIPv4'} if spec['enableIpv4Field'] == 'PRESENT' else set())
          and set(spec['volumeFields']) == frozen.VOLUME_FIELDS - {'Status'}
          and spec['nativePlatform'] in ('linux/x86_64', 'linux/amd64', 'linux/aarch64', 'linux/arm64')
          and all(isinstance(spec[k], str) and frozen.VERSION.fullmatch(spec[k])
                  for k in ('networkCreatorVersion', 'volumeCreatorVersion')), 'SOURCE_NOT_MEASURED')
    check(spec['enableIpv4Field'] in ('PRESENT', 'ABSENT') and spec['referenceGateway'] == 'FIRST_ADDRESS'
          and spec['referenceSubnetPrefix'] is None,
          'SOURCE_NOT_MEASURED')
    check(spec['sourceIpamRowFields'] == ['Gateway', 'Subnet']
          and spec['referenceIpamRowFields'] == (['Subnet'] if spec['referenceGateway'] == 'ABSENT' else ['Gateway', 'Subnet'])
          and set(spec['actualEndpointFields']) == ENDPOINT_FIELDS
          and set(spec['referenceEndpointFields']) == ENDPOINT_FIELDS
          and len(spec['actualEndpointFields']) == len(ENDPOINT_FIELDS)
          and len(spec['referenceEndpointFields']) == len(ENDPOINT_FIELDS), 'SOURCE_NOT_MEASURED')
    dependencies = spec['renderedDependencies']
    check(isinstance(dependencies, dict) and set(dependencies) == {'migrate', 'media-resolver'}
          and all(isinstance(row, dict) and set(row) in ({'condition', 'required'}, {'condition', 'required', 'restart'})
                  and row['required'] is True and row.get('restart', False) is False
                  and row['condition'] == ('service_completed_successfully' if name == 'migrate' else 'service_healthy')
                  for name, row in dependencies.items())
          and spec['renderedNetworkEntry'] == {}
          and spec['renderedVolumeRow'] == {'type': 'volume', 'source': VOLUME_KEY, 'target': TARGET, 'volume': {}}
          and spec['renderedExternalNetworkExtra'] in ({}, {'ipam': {}}), 'SOURCE_NOT_MEASURED')
    statement = report['daemonDefaultAddressPools']
    check(statement['status'] == spec['defaultPoolsStatement'] and statement['status'] in ('DECLARED', 'UNDECLARED')
          and (statement['pools'] == spec['defaultPools'] if statement['status'] == 'DECLARED' else True)
          and isinstance(spec['defaultPools'], list) and bool(spec['defaultPools']), 'SOURCE_NOT_MEASURED')
    frozen.pools_statement([{'Base': r.get('base'), 'Size': r.get('size')} for r in spec['defaultPools']])
    # Builtins, when info is UNDECLARED, require an explicitly frozen source rule;
    # they are never inferred from RFC1918 or this machine's LOCAL Docker.
    check(report['resources']['status'] == 'OBSERVED' and report['resources']['unknownNetworkFieldCount'] == 0
          and report['resources']['unknownVolumeFieldCount'] == 0, 'SOURCE_NOT_MEASURED')
    return spec


def source_api_validate(api, directory, spec):
    check(isinstance(api, dict) and set(api) <= frozen.API_FIELDS and {'build','environment','networks','volumes',
          'healthcheck','cap_drop','read_only','restart','security_opt','init','logging','tmpfs','depends_on','image'} <= set(api),
          'SOURCE_DECLARATION_INVALID')
    check(api['cap_drop'] == ['ALL'] and api['read_only'] is True and api['init'] is True
          and api['restart'] == 'unless-stopped' and api['security_opt'] == ['no-new-privileges:true']
          and api['tmpfs'] == ['/tmp:rw,noexec,nosuid,nodev,size=64m']
          and api.get('labels') in (None, {}) and api.get('pull_policy') in (None, 'never'), 'SOURCE_DECLARATION_INVALID')
    check(api['build'] == {'context': str(directory), 'dockerfile': 'apps/api/Dockerfile.mysql', 'target': 'runtime'},
          'SOURCE_DECLARATION_INVALID')
    health = api['healthcheck']
    check(health == {'test': HEALTH_TEST, 'interval': '30s', 'timeout': '5s', 'start_period': '45s', 'retries': 5},
          'SOURCE_DECLARATION_INVALID')
    log = api['logging']
    check(isinstance(log, dict) and set(log) == {'driver','options'} and log['driver'] == 'json-file'
          and isinstance(log['options'], dict) and set(log['options']) == {'max-file','max-size'}
          and re.fullmatch('[1-9][0-9]{0,3}', log['options']['max-file'])
          and re.fullmatch('[1-9][0-9]{0,8}[kKmMgG]', log['options']['max-size']), 'SOURCE_DECLARATION_INVALID')
    check(api['depends_on'] == spec['renderedDependencies'] and isinstance(api['networks'], dict)
          and set(api['networks']) == set(NETWORK_ROLES)
          # compose-go's nil *ServiceNetworkConfig renders as null; an exact
          # empty object is the same attribute-free declaration, not a mask.
          and all(row is None or type(row) is dict and row == {}
                  for row in api['networks'].values())
          and api['volumes'] == [spec['renderedVolumeRow']], 'SOURCE_DECLARATION_INVALID')


def ipam_rule(net, spec, *, reference=False):
    ipam = net.get('IPAM')
    check(isinstance(ipam, dict) and set(ipam) == {'Driver','Options','Config'} and ipam['Driver'] == 'default'
          and ipam['Options'] in (None, {}) and isinstance(ipam['Config'], list) and len(ipam['Config']) == 1,
          'RESOURCE_IPAM_INVALID')
    row = ipam['Config'][0]
    expected_fields = spec['referenceIpamRowFields'] if reference else spec['sourceIpamRowFields']
    check(isinstance(row, dict) and set(row) == set(expected_fields), 'RESOURCE_IPAM_INVALID')
    try: subnet = ipaddress.ip_network(row['Subnet'], strict=True)
    except (ValueError, TypeError): raise Rejected('RESOURCE_IPAM_INVALID') from None
    if reference:
        check(subnet.version == 4 and any(subnet.subnet_of(ipaddress.ip_network(p['base']))
              and subnet.prefixlen == p['size'] for p in spec['defaultPools'])
              and row.get('Gateway') == str(subnet.network_address + 1), 'RESOURCE_IPAM_INVALID')
    else:
        check(subnet.version == 4 and any(subnet.subnet_of(ipaddress.ip_network(p['base']))
              and subnet.prefixlen == p['size'] for p in spec['defaultPools'])
              and row.get('Gateway') == str(subnet.network_address + 1), 'RESOURCE_DEFAULT_POOL_INVALID')
    return subnet


def managed_network_hash(declaration, role, project, spec):
    check(type(project) is str and frozen.RESOURCE_NAME.fullmatch(project)
          and type(role) is str and role in NETWORK_ROLES, 'SOURCE_NETWORK_DECLARATION')
    expected = {'name':project+'_'+role, **({'internal':True} if role.endswith('control') else {})}
    check(type(declaration) is dict and type(declaration.get('name')) is str
          and set(declaration) <= {'name','ipam','internal'}
          and declaration in (expected, {**expected, **spec['renderedExternalNetworkExtra']})
          and ('ipam' not in declaration or type(declaration['ipam']) is dict and declaration['ipam'] == {})
          and ('internal' not in declaration or declaration['internal'] is True), 'SOURCE_NETWORK_DECLARATION')
    # Compose 870908c NetworkHash marshals the compose-go NetworkConfig struct:
    # Name precedes the always-present empty Ipam struct, then Internal. Docker's
    # effective bridge driver and allocated IPAM are not part of this declaration.
    value = {'name':declaration['name'], 'ipam':{}}
    if role.endswith('control'): value['internal'] = True
    return sha(json.dumps(value, separators=(',',':'), ensure_ascii=True).encode('ascii'))


def managed_volume_hash(declaration, project):
    check(type(project) is str and frozen.RESOURCE_NAME.fullmatch(project)
          and type(declaration) is dict and type(declaration.get('name')) is str
          and declaration == {'name':project+'_'+VOLUME_KEY}, 'SOURCE_VOLUME_DECLARATION')
    # VolumeHash supplies the local default before marshaling Name, then Driver.
    value = {'name':declaration['name'], 'driver':'local'}
    return sha(json.dumps(value, separators=(',',':'), ensure_ascii=True).encode('ascii'))


def network_validate(net, role, project, spec, *, reference=False, owner=None, declaration=None):
    check(isinstance(net, dict) and set(net) == set(spec['networkFields']) and frozen.HEX.fullmatch(net.get('Id',''))
          and net.get('Name') == project + '_' + role and isinstance(net.get('Created'), str)
          and 0 < len(net['Created']) <= 80, 'RESOURCE_SCHEMA_INVALID')
    check(net['Driver'] == 'bridge' and net['Scope'] == 'local' and net['Internal'] is (True if reference else role.endswith('control'))
          and net['EnableIPv6'] is False and net['Attachable'] is False and net['Ingress'] is False
          and net['ConfigOnly'] is False and net['ConfigFrom'] == {'Network':''}
          and net['Options'] in (None, {}), 'RESOURCE_PROPERTIES_INVALID')
    if spec['enableIpv4Field'] == 'PRESENT': check(net.get('EnableIPv4') is True, 'RESOURCE_PROPERTIES_INVALID')
    else: check('EnableIPv4' not in net, 'RESOURCE_SCHEMA_INVALID')
    expected_labels = ({OWNER_KEY: owner} if reference else {'com.docker.compose.project':project,
        'com.docker.compose.network':role, 'com.docker.compose.version':spec['networkCreatorVersion']})
    labels = [expected_labels]
    if not reference and declaration is not None:
        labels.append({**expected_labels, 'com.docker.compose.config-hash':managed_network_hash(declaration,role,project,spec)})
    check(net['Labels'] in labels and isinstance(net.get('Containers'), dict)
          and (net['Containers'] == {} if reference else True), 'RESOURCE_OWNER_OR_MEMBERS_INVALID')
    return ipam_rule(net, spec, reference=reference)


def volume_validate(vol, project, spec, *, reference=False, owner=None, declaration=None):
    check(isinstance(vol, dict) and set(vol) == set(spec['volumeFields']) and vol['Name'] == project + '_' + VOLUME_KEY
          and vol['Driver'] == 'local' and vol['Scope'] == 'local' and vol['Options'] in (None, {})
          and isinstance(vol.get('CreatedAt'), str) and 0 < len(vol['CreatedAt']) <= 80
          and isinstance(vol.get('Mountpoint'), str) and vol['Mountpoint'].startswith('/'), 'RESOURCE_VOLUME_INVALID')
    labels = ({OWNER_KEY:owner} if reference else {'com.docker.compose.project':project,
              'com.docker.compose.volume':VOLUME_KEY,'com.docker.compose.version':spec['volumeCreatorVersion']})
    expected_labels = [labels]
    if not reference and declaration is not None:
        expected_labels.append({**labels, 'com.docker.compose.config-hash':managed_volume_hash(declaration,project)})
    check(vol['Labels'] in expected_labels, 'RESOURCE_OWNER_OR_MEMBERS_INVALID')


def endpoint_dns_names(meta, aliases):
    # Moby 6fdf0a6 buildEndpointDNSNames + sliceutil.Dedup. The first
    # occurrence determines PTR order; do not sort or omit any DNSNames bytes.
    check(isinstance(meta, dict) and isinstance(meta.get('Name'), str)
          and isinstance(meta.get('Id'), str) and frozen.HEX.fullmatch(meta['Id'])
          and isinstance(meta.get('Config'), dict) and isinstance(meta['Config'].get('Hostname'), str)
          and isinstance(aliases, list) and all(isinstance(value, str) for value in aliases),
          'ACTUAL_NETWORK_DECLARATION')
    values = []
    if meta['Name']:
        name = meta['Name']
        values.append(name[1:] if name.startswith('/') else name)
    values.extend(aliases)
    values.append(meta['Id'][:12])
    if meta['Config']['Hostname']:
        values.append(meta['Config']['Hostname'])
    return list(dict.fromkeys(values))


def actual_endpoints(meta, networks, services, spec):
    rows = meta.get('NetworkSettings', {}).get('Networks')
    check(isinstance(rows, dict) and set(rows) == {n['Name'] for n in networks.values()}, 'ACTUAL_NETWORK_SET')
    members = {row['containerId']:name for name,row in services.items()}
    for role, net in networks.items():
        endpoint = rows[net['Name']]; subnet = ipam_rule(net, spec)
        check(isinstance(endpoint, dict) and set(endpoint) == set(spec['actualEndpointFields'])
              and endpoint.get('NetworkID') == net['Id']
              and frozen.HEX.fullmatch(endpoint.get('EndpointID','')) and set(net['Containers']) <= set(members)
              and meta['Id'] in net['Containers']
              and all(role in DECLARED_SERVICE_ROLES[members[cid]] for cid in net['Containers']), 'ACTUAL_NETWORK_ID_OR_MEMBERS')
        try: address = ipaddress.ip_address(endpoint.get('IPAddress'))
        except (ValueError, TypeError): raise Rejected('ACTUAL_NETWORK_ADDRESS') from None
        check(address in subnet and address not in (subnet.network_address,subnet.broadcast_address)
              and type(endpoint.get('IPPrefixLen')) is int and endpoint['IPPrefixLen'] == subnet.prefixlen
              and endpoint.get('Gateway') == str(subnet.network_address+1)
              and endpoint.get('GlobalIPv6Address') == '' and type(endpoint.get('GlobalIPv6PrefixLen')) is int
              and endpoint['GlobalIPv6PrefixLen'] == 0
              and endpoint.get('IPv6Gateway') == '', 'ACTUAL_NETWORK_ADDRESS')
        aliases = endpoint.get('Aliases')
        check(isinstance(aliases,list) and sorted(aliases) == sorted((meta['Name'].lstrip('/'),'api'))
              and endpoint.get('IPAMConfig') is None and endpoint.get('DriverOpts') is None
              and endpoint.get('Links') is None
              and endpoint.get('DNSNames') == endpoint_dns_names(meta, aliases), 'ACTUAL_NETWORK_DECLARATION')
        macs, ips = set(), set()
        for cid, member in net['Containers'].items():
            check(isinstance(member,dict) and set(member) == {'Name','EndpointID','MacAddress','IPv4Address','IPv6Address'}
                  and member['Name'] in (meta['Config']['Labels']['com.docker.compose.project']+'-'+members[cid]+'-1',
                                        meta['Config']['Labels']['com.docker.compose.project']+'_'+members[cid]+'_1')
                  and frozen.HEX.fullmatch(member['EndpointID']) and re.fullmatch('[0-9a-f]{2}(?::[0-9a-f]{2}){5}',member['MacAddress'])
                  and member['IPv6Address'] == '', 'ACTUAL_NETWORK_MEMBERS')
            try: interface = ipaddress.ip_interface(member['IPv4Address'])
            except (ValueError,TypeError): raise Rejected('ACTUAL_NETWORK_MEMBERS') from None
            check(interface.network == subnet and interface.ip not in ips and member['MacAddress'] not in macs,
                  'ACTUAL_NETWORK_MEMBERS')
            ips.add(interface.ip); macs.add(member['MacAddress'])
        self_row = net['Containers'][meta['Id']]
        check(self_row['IPv4Address'] == str(address)+'/'+str(subnet.prefixlen)
              and self_row['EndpointID'] == endpoint['EndpointID'] and self_row['MacAddress'] == endpoint.get('MacAddress'),
              'ACTUAL_NETWORK_ADDRESS')
    check(meta['HostConfig'].get('NetworkMode') in rows, 'ACTUAL_PRIMARY_NETWORK')


def identity(meta):
    state = meta.get('State', {})
    check(isinstance(meta.get('Id'),str) and frozen.HEX.fullmatch(meta['Id']) and isinstance(meta.get('Image'),str)
          and frozen.DIGEST.fullmatch(meta['Image']) and isinstance(state.get('StartedAt'),str), 'ACTUAL_IDENTITY')
    return {'image':meta['Image'],'reference':meta['Config']['Image'],'status':state.get('Status'),
        'health':state.get('Health',{}).get('Status'),'containerId':meta['Id'],
        'startedAtSha256':sha(state['StartedAt']),'environmentSha256':fingerprint(sorted(meta['Config']['Env'])),
        'configurationSha256':fingerprint(configuration(meta))}


def dependency_label(value):
    check(isinstance(value,str) and (value == '' or sorted(value.split(',')) == list(DEPS)), 'DEPENDENCY_LABEL')
    return '' if value == '' else ','.join(DEPS)


def bind_pack(pack, spec, *, reference=False, source=None):
    check(isinstance(pack,dict) and set(pack) == PACK_KEYS, 'PACK_INVALID')
    meta = pack['metadata']; config = meta['Config']; labels = config.get('Labels')
    check(isinstance(labels,dict) and meta['Image'] == pack['imageId'] == pack['image']['Id']
          and config['Image'] == pack['imageReference'] and config['Cmd'] == pack['image']['Config']['Cmd']
          and config['Entrypoint'] == pack['image']['Config']['Entrypoint']
          and config['Hostname'] == meta['Id'][:12] and meta['Name'] in (
              '/'+pack['project']+'-api-1','/'+pack['project']+'_api_1'), 'PACK_IMAGE_OR_NATIVE_IDENTITY')
    expected_labels = {'com.docker.compose.project':pack['project'],'com.docker.compose.service':'api',
       'com.docker.compose.container-number':'1','com.docker.compose.oneoff':'False',
       'com.docker.compose.version':spec['composeVersion'],'com.docker.compose.image':pack['imageId'],
       'com.docker.compose.project.working_dir':pack['directory'],'com.docker.compose.project.config_files':pack['filesLabel'],
       'com.docker.compose.project.environment_file':pack['envFile'],'com.docker.compose.config-hash':pack['configHash']}
    check(all(labels.get(k) == v for k,v in expected_labels.items()), 'BOUND_LABEL')
    dep = dependency_label(labels.get('com.docker.compose.depends_on'))
    merged = expected_env(source['api'] if reference else pack['api'], pack['image'])
    if reference:
        check(never_started(meta) and labels.get(OWNER_KEY) == pack['owner'] and dep == ''
              and 'com.docker.compose.replace' not in labels
              and env_map(config['Env']) == surrogate(merged), 'REFERENCE_STATE_OWNER_OR_ENV')
        rows = meta.get('NetworkSettings',{}).get('Networks')
        check(isinstance(rows,dict) and set(rows) == {n['Name'] for n in pack['networks'].values()}, 'REFERENCE_NETWORK_SET')
        for endpoint in rows.values():
            check(isinstance(endpoint,dict) and set(endpoint) == set(spec['referenceEndpointFields'])
                  and endpoint['NetworkID'] == '' and endpoint['EndpointID'] == ''
                  and all(endpoint[k] == '' for k in ('Gateway','IPAddress','IPv6Gateway','GlobalIPv6Address','MacAddress'))
                  and type(endpoint['IPPrefixLen']) is int and endpoint['IPPrefixLen'] == 0
                  and type(endpoint['GlobalIPv6PrefixLen']) is int and endpoint['GlobalIPv6PrefixLen'] == 0
                  and isinstance(endpoint.get('Aliases'), list)
                  and sorted(endpoint['Aliases']) == sorted((meta['Name'].lstrip('/'), 'api'))
                  and endpoint.get('IPAMConfig') is None and endpoint.get('DriverOpts') is None
                  and endpoint.get('Links') is None and endpoint.get('DNSNames') is None, 'REFERENCE_PENDING_ENDPOINT')
    else:
        check(meta['State']['Running'] is True and meta['State']['Status'] == 'running'
              and meta['State'].get('Health',{}).get('Status') == 'healthy'
              and type(meta['State']['Pid']) is int and meta['State']['Pid'] > 0
              and OWNER_KEY not in labels and env_map(config['Env']) == merged, 'ACTUAL_STATE_OR_ENV')
        allowed = (pack['replaceAnchors']['candidateAfterContainerId'],pack['replaceAnchors']['stableName'],'api-1')
        check(labels.get('com.docker.compose.replace') in allowed, 'REPLACE_LABEL')
    vol = pack['volume']; mounts = configuration(meta)['Mounts']
    check(len(mounts) == 1, 'MOUNT_BINDING')
    fields = {'Type':'volume','Driver':'local','Name':vol['Name'],'Source':vol['Mountpoint'],
              'Destination':TARGET,'Mode':'rw','RW':True,'Propagation':''}
    check(all(mounts[0].get(k) == v for k,v in fields.items())
          and meta['HostConfig'].get('Binds') == [vol['Name']+':'+TARGET+':rw']
          and meta['HostConfig'].get('Mounts') in (None,[]), 'MOUNT_BINDING')
    mode = meta['HostConfig'].get('NetworkMode')
    roles = [role for role,net in pack['networks'].items() if net['Name'] == mode]
    check(len(roles) == 1, 'PRIMARY_NETWORK')
    return merged,dep,roles[0]


def compare(source, reference, spec):
    try:
        return _compare(source, reference, spec)
    except Exception as error:
        raise Rejected(bounded_error(error)) from None


def _compare(source, reference, spec):
    merged, dep, role = bind_pack(source,spec)
    _, _, ref_role = bind_pack(reference,spec,reference=True,source=source)
    check(role == ref_role and source['imageId'] == reference['imageId']
          and source['imageReference'] == reference['imageReference'], 'PRIMARY_NETWORK_OR_IMAGE')
    a,r = configuration(source['metadata']),configuration(reference['metadata'])
    raw_a,raw_r = fingerprint(a),fingerprint(r)
    a['Config']['Env'] = [k+'='+merged[k] for k in sorted(merged)]
    r['Config']['Env'] = list(a['Config']['Env'])
    r['Config']['Hostname'] = source['metadata']['Id'][:12]
    al,rl = a['Config']['Labels'],r['Config']['Labels']
    for key in ('com.docker.compose.project','com.docker.compose.project.working_dir',
                'com.docker.compose.project.config_files','com.docker.compose.project.environment_file',
                'com.docker.compose.config-hash'): rl[key] = al[key]
    al['com.docker.compose.depends_on'] = rl['com.docker.compose.depends_on'] = dep
    rl['com.docker.compose.replace'] = al['com.docker.compose.replace']
    del rl[OWNER_KEY]
    r['HostConfig']['NetworkMode'] = source['networks'][role]['Name']
    r['HostConfig']['Binds'] = list(a['HostConfig']['Binds'])
    r['Mounts'][0]['Name'],r['Mounts'][0]['Source'] = source['volume']['Name'],source['volume']['Mountpoint']
    check(('Mounts' in a['HostConfig']) is ('Mounts' in r['HostConfig'])
          and type(a['HostConfig'].get('Mounts')) is type(r['HostConfig'].get('Mounts')), 'HOST_MOUNTS_SHAPE')
    normalized_a, normalized_r = fingerprint(a), fingerprint(r)
    matched = normalized_a == normalized_r
    return {'matched':matched,'reason':'COMPLETE_EQUAL' if matched else 'COMPLETE_DIFFERENCE',
       'actualRawConfigurationSha256':raw_a,'referenceRawConfigurationSha256':raw_r,
       'actualDeclarationNormalizedSha256':normalized_a,'referenceDeclarationNormalizedSha256':normalized_r,
       'historicalRawHashMatchClaimed':False,'authority':False,'productionEligible':False}


def read_one(d, kind, identity_value, *, env=None):
    rows = frozen.read(d, 'docker', kind, 'inspect', identity_value, env=env)
    check(isinstance(rows,list) and len(rows) == 1 and isinstance(rows[0],dict), 'RESOURCE_READ_INVALID')
    return rows[0]


def source_hash(d, directory):
    text = d.run('docker','compose','--env-file',str(directory/frozen.FILES[2]),
        '-f',str(directory/frozen.FILES[0]),'-f',str(directory/frozen.FILES[1]),'config','--hash','api',
        env=frozen.clean_source_environment(directory),timeout=30)
    return config_hash(text)


def config_hash(text):
    check(isinstance(text, str) and len(text) <= 256, 'SOURCE_MODEL_HASH_INVALID')
    match = re.fullmatch(r'api[ \t]+([a-f0-9]{64})\n?', text)
    check(match is not None, 'SOURCE_MODEL_HASH_INVALID')
    return match.group(1)


def prepare_source(d, directory, services, image_reference, image_id, source_seal, spec):
    frozen.validate_services(services)
    directory = Path(directory)
    check(isinstance(source_seal,dict) and set(source_seal) == SEAL_KEYS
          and source_seal['baselineCommit'] == BASELINE and source_seal['directory'] == str(directory)
          and source_seal['servicesSha256'] == fingerprint(services)
          and isinstance(source_seal['files'],dict) and set(source_seal['files']) == set(frozen.FILES)
          and frozen.HEX.fullmatch(source_seal['stabilitySha256']), 'SOURCE_SEAL_INVALID')
    check(directory.is_absolute() and directory.resolve() == directory
          and directory.is_relative_to(d.BASE/'releases'), 'SOURCE_PATH_INVALID')
    files = {name:file_seal(directory/name,private=name==frozen.FILES[2]) for name in frozen.FILES}
    check(all(files[name]['sha256'] == source_seal['files'][name] for name in frozen.FILES)
          and files[frozen.FILES[0]]['sha256'] == frozen.COMPOSE_BLOB_SHA256, 'SOURCE_FILES_CHANGED')
    model = frozen.render_source(d,directory)
    derive.canonical(model)
    check(set(model.get('services', {})) == set(DECLARED_SERVICE_ROLES)
          and all(isinstance(model['services'][name].get('networks'), dict)
                  and set(model['services'][name]['networks']) == set(roles)
                  for name, roles in DECLARED_SERVICE_ROLES.items()), 'SOURCE_DECLARATION_INVALID')
    project = model.get('name'); check(isinstance(project,str) and frozen.RESOURCE_NAME.fullmatch(project), 'SOURCE_PROJECT_INVALID')
    api = model['services']['api']; source_api_validate(api,directory,spec)
    check(api['image'] == image_reference == services['api']['reference']
          and image_id == services['api']['image'], 'SOURCE_IMAGE_INVALID')
    image = read_one(d,'image',image_reference)
    architecture = {'linux/x86_64':'amd64','linux/amd64':'amd64','linux/aarch64':'arm64','linux/arm64':'arm64'}[spec['nativePlatform']]
    check(image['Id'] == image_id and image.get('Os') == 'linux' and image.get('Architecture') == architecture,
          'SOURCE_IMAGE_INVALID')
    actual = read_one(d,'container',services['api']['containerId'])
    check(identity(actual) == services['api'], 'ACTUAL_IDENTITY_CHANGED')
    original_env = expected_env(api,image)
    check(env_map(actual['Config']['Env']) == original_env
          and fingerprint(sorted(k+'='+v for k,v in original_env.items())) == services['api']['environmentSha256'],
          'SOURCE_ENV_SEAL_CHANGED')
    anchors = source_seal['replaceAnchors']
    check(isinstance(anchors,dict) and set(anchors) == {'candidateAfterContainerId','stableName'}
          and isinstance(anchors['candidateAfterContainerId'],str) and frozen.HEX.fullmatch(anchors['candidateAfterContainerId'])
          and anchors['stableName'] == actual['Name'].lstrip('/'), 'SOURCE_REPLACE_ANCHOR_INVALID')
    rows = actual.get('NetworkSettings',{}).get('Networks'); check(isinstance(rows,dict), 'ACTUAL_NETWORK_SET')
    nets = {}
    for role in NETWORK_ROLES:
        rendered = model.get('networks',{}).get(role)
        expected = {'name':project+'_'+role, **({'internal':True} if role.endswith('control') else {})}
        check(rendered in (expected, {**expected, **spec['renderedExternalNetworkExtra']}),
              'SOURCE_NETWORK_DECLARATION')
        endpoint = rows.get(rendered['name'])
        check(isinstance(endpoint,dict) and frozen.HEX.fullmatch(endpoint.get('NetworkID','')), 'ACTUAL_NETWORK_ID_OR_MEMBERS')
        net = read_one(d,'network',endpoint['NetworkID'])
        check(net['Id'] == endpoint['NetworkID'],'ACTUAL_NETWORK_ID_OR_MEMBERS')
        network_validate(net,role,project,spec,declaration=rendered);nets[role] = net
    actual_endpoints(actual,nets,services,spec)
    vol_declared = model.get('volumes',{}).get(VOLUME_KEY)
    check(vol_declared == {'name':project+'_'+VOLUME_KEY},'SOURCE_VOLUME_DECLARATION')
    vol = read_one(d,'volume',vol_declared['name']);volume_validate(vol,project,spec,declaration=vol_declared)
    pack = {'project':project,'directory':str(directory),'filesLabel':','.join(str(directory/n) for n in frozen.FILES[:2]),
        'envFile':str(directory/frozen.FILES[2]),'configHash':source_hash(d,directory),'metadata':actual,
        'api':api,'image':image,'imageReference':image_reference,'imageId':image_id,'networks':nets,
        'volume':vol,'owner':None,'replaceAnchors':anchors}
    bind_pack(pack,spec)
    return pack,files,model


def inventory_ids(d, kind, env):
    args = (('container','ls','-a','--no-trunc','--format','{{.ID}}') if kind=='containers'
            else ('network','ls','--no-trunc','--format','{{.ID}}') if kind=='networks'
            else ('volume','ls','--format','{{.Name}}'))
    text = d.run('docker',*args,env=env,timeout=30)
    rows = text.splitlines() if text else []
    check(all(frozen.RESOURCE_NAME.fullmatch(v) if kind=='volumes' else frozen.HEX.fullmatch(v) for v in rows),
          'RESOURCE_INVENTORY_INVALID')
    return set(rows)


def controlled_client(d, work, spec, daemon_sha):
    context = frozen.read(d,'docker','context','inspect')
    check(isinstance(context,list) and len(context)==1,'DAEMON_SOURCE_NOT_MEASURED')
    host = context[0].get('Endpoints',{}).get('docker',{}).get('Host')
    check(host == 'unix:///var/run/docker.sock' and os.environ.get('DOCKER_HOST',host) == host,
          'DAEMON_SOURCE_NOT_MEASURED')
    private = work/'docker-client';private.mkdir(mode=0o700)
    path = private/'config.json';path.write_bytes(b'{}\n');path.chmod(0o600)
    client_seal = file_seal(path,private=True)
    client_raw,current=_sealed_file(path,private=True)
    check(current==client_seal and frozen.unique_json(client_raw.decode())=={},'CLIENT_DEFAULT_INJECTION')
    environment = {key:value for key,value in os.environ.items() if not key.startswith(('DOCKER_','COMPOSE_'))}
    environment.update({'DOCKER_CONFIG':str(private),'DOCKER_HOST':host})
    generator_still_same(d, environment, spec, daemon_sha)
    return environment,client_seal


_NATIVE_CLI_ROLES = frozenset(('DOCKER', 'COMPOSE'))
_NATIVE_CLI_REASONS = frozenset(('NOT_REGULAR', 'LEAF_SYMLINK', 'UID', 'NLINK',
    'OWNER_EXEC', 'SPECIAL_MODE', 'WRITABLE'))
_NATIVE_CLI_ATTEMPT = None
_NATIVE_CLI_FAILURE = None


def _native_cli_predicate(ok, reason):
    global _NATIVE_CLI_ATTEMPT
    row = _NATIVE_CLI_ATTEMPT
    if (ok is False and type(row) is tuple and len(row) == 2
            and type(row[0]) is str and row[0] in _NATIVE_CLI_ROLES):
        _NATIVE_CLI_ATTEMPT = (row[0], reason)
    return ok


def _native_cli_original_error(error):
    if type(error) is not Rejected:return False
    values = BaseException.args.__get__(error)
    return type(values) is tuple and len(values) == 1 and type(values[0]) is str and values[0] == 'CLI_SOURCE_CHANGED'


def native_permission_failure(error):
    # One bounded issuance, bound to the exact original exception object. The
    # inventory Rejected alias and caller-owned exception attributes confer no trust.
    row = _NATIVE_CLI_FAILURE
    if not _native_cli_original_error(error):
        return None
    if (type(row) is tuple and len(row) == 3 and row[0] is error
            and type(row[1]) is str and row[1] in _NATIVE_CLI_ROLES
            and type(row[2]) is str and row[2] in _NATIVE_CLI_REASONS):
        return row[1:]
    return None


def trusted_native_permissions(info, *, socket=False):
    mode = stat.S_IMODE(info.st_mode)
    if socket:
        check(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and mode & 0o002 == 0,
              'DAEMON_SOURCE_NOT_MEASURED')
    else:
        check(_native_cli_predicate(stat.S_ISREG(info.st_mode), 'NOT_REGULAR')
              and _native_cli_predicate(info.st_uid == 0, 'UID')
              and _native_cli_predicate(info.st_nlink == 1, 'NLINK')
              and _native_cli_predicate(mode & 0o100 != 0, 'OWNER_EXEC')
              and _native_cli_predicate(mode & 0o7022 == 0,
                  'SPECIAL_MODE' if mode & 0o7000 != 0 else 'WRITABLE'), 'CLI_SOURCE_CHANGED')


def native_permissions(spec):
    # Linux production paths only. A LOCAL desktop socket/CLI is not a fallback.
    global _NATIVE_CLI_ATTEMPT, _NATIVE_CLI_FAILURE
    _NATIVE_CLI_FAILURE = None
    for role, literal in (('DOCKER', spec['dockerPath']), ('COMPOSE', spec['composePath'])):
        path = Path(literal)
        _NATIVE_CLI_ATTEMPT = (role, None)
        try:
            check(_native_cli_predicate(path.is_file(), 'NOT_REGULAR')
                  and _native_cli_predicate(not path.is_symlink(), 'LEAF_SYMLINK'), 'CLI_SOURCE_CHANGED')
            trusted_native_permissions(path.stat())
        except Exception as error:
            row = _NATIVE_CLI_ATTEMPT
            if (_native_cli_original_error(error) and type(row) is tuple and len(row) == 2
                    and type(row[0]) is str and row[0] in _NATIVE_CLI_ROLES
                    and type(row[1]) is str and row[1] in _NATIVE_CLI_REASONS):
                _NATIVE_CLI_FAILURE = (error, row[0], row[1])
            raise
        finally:
            _NATIVE_CLI_ATTEMPT = None
    path = Path('/var/run/docker.sock')
    check(not path.is_symlink(), 'DAEMON_SOURCE_NOT_MEASURED')
    trusted_native_permissions(path.stat(), socket=True)


def generator_still_same(d, environment, spec, daemon_sha):
    native_permissions(spec)
    info = frozen.read(d,spec['dockerPath'],'info','--format',frozen.INFO_FORMAT,env=environment)
    check(sha(info['id']) == daemon_sha and info['serverVersion'] == spec['engineVersion']
          and info['osType'] + '/' + info['architecture'] == spec['nativePlatform'], 'DAEMON_CHANGED')
    versions = frozen.read(d,spec['dockerPath'],'version','--format','{{json .}}',env=environment)
    check(versions['Server']['Version'] == spec['engineVersion']
          and versions['Server']['ApiVersion'] == spec['engineApiVersion']
          and versions['Client']['Version'] == spec['dockerCliVersion']
          and d.run(spec['composePath'],'version','--short',env=environment,timeout=30).strip() == spec['composeVersion'],
          'CLI_SOURCE_CHANGED')
    check(frozen.binary_hash(spec['dockerPath'],'docker') == spec['dockerCliSha256']
          and frozen.binary_hash(spec['composePath'],'compose') == spec['composeCliSha256'],'CLI_SOURCE_CHANGED')
    statement = frozen.pools_statement(info['defaultAddressPools'])
    check(statement['status'] == spec['defaultPoolsStatement']
          and (statement['pools'] == spec['defaultPools'] if statement['status'] == 'DECLARED' else True), 'DAEMON_CHANGED')


def reference_model(source, project, owner, spec):
    api = copy.deepcopy(source['api']);api.pop('depends_on')
    api['environment'] = surrogate(expected_env(source['api'],source['image']))
    api['labels'] = {OWNER_KEY:owner}
    api['pull_policy'] = 'never'
    # Keep complete build/health/security/Cmd defaults; no sleep or entrypoint override.
    return {'name':project,'services':{'api':api},
       'networks':{role:{'name':project+'_'+role,'external':True} for role in NETWORK_ROLES},
       'volumes':{VOLUME_KEY:{'name':project+'_'+VOLUME_KEY,'external':True}}}


def reference_cli(d, work, project, spec, env, *args):
    return d.run(spec['composePath'],'--project-name',project,'--project-directory',str(work),
       '--env-file',str(work/'.env.empty'),'-f',str(work/'compose.reference.json'),'-f',str(work/'compose.release.json'),
       *args,env=env,timeout=30)


def resource_seal(value):
    return fingerprint(value)


def source_still_same(d, source, files, spec):
    current = read_one(d,'container',source['metadata']['Id'])
    check(identity(current) == identity(source['metadata'])
          and current.get('NetworkSettings') == source['metadata'].get('NetworkSettings'), 'ACTUAL_INSPECT_CHANGED')
    check(read_one(d,'image',source['imageReference']) == source['image'], 'IMAGE_INSPECT_CHANGED')
    for net in source['networks'].values():
        check(read_one(d,'network',net['Id']) == net,'ACTUAL_NETWORK_INSPECT_CHANGED')
    check(read_one(d,'volume',source['volume']['Name']) == source['volume'],'ACTUAL_VOLUME_INSPECT_CHANGED')
    for name,sealed in files.items():
        check(file_seal(Path(source['directory'])/name,private=name==frozen.FILES[2]) == sealed,'SOURCE_FILES_CHANGED')


def measure(d, directory, *, services, image_reference, image_id, source_seal, stability_reader):
    """Prepare, stop-only create, compare, verify unchanged source, exact cleanup.

    Default registry is empty. All accepted-generator test fixtures are runtime
    mocks. This prototype produces no proof and never grants production authority.
    """
    try:
        observed = frozen.inventory(d,directory,services=services,image_reference=image_reference,image_id=image_id)
        key = (observed['generator']['engineVersion'],observed['generator']['composeVersion'])
        check(key in REVIEWED_GENERATORS,'SOURCE_NOT_MEASURED')
        spec = spec_validate(observed,copy.deepcopy(REVIEWED_GENERATORS[key]))
        check(callable(stability_reader),'SOURCE_SEAL_INVALID')
        source,files,model = prepare_source(d,Path(directory),services,image_reference,image_id,source_seal,spec)
        actual_resource={'networks':source['networks'],'volume':source['volume']}
        derive.canonical(actual_resource)
        observation=lambda: derive.observation(stability_reader(),services,
            {name:row['sha256'] for name,row in files.items()},actual_resource)
        stable_before=observation()
        check(fingerprint(stable_before)==source_seal['stabilitySha256'],'ORIGIN_CHANGED')
        return stopped_orchestrator(d,source,files,services,source_seal,spec,observed,observation,
            full_source_model=model,stable_before=stable_before)
    except Exception as error:
        raise Rejected(bounded_error(error)) from None


def stopped_orchestrator(d, source, files, services, source_seal, spec, observed, stability_reader, *, full_source_model, stable_before):
    root = d.BASE/'.runtime'/'online-recharge-declaration-measurement'
    check(root.parent.is_absolute() and root.parent.resolve() == root.parent
          and not root.is_symlink(),'REFERENCE_PATH_INVALID')
    root.mkdir(mode=0o700,exist_ok=True)
    check(stat.S_IMODE(root.stat().st_mode)==0o700 and root.stat().st_uid==os.getuid(),'REFERENCE_PATH_INVALID')
    owner = uuid.uuid4().hex;project = 'online-recharge-reference-'+owner
    work = root/owner;work.mkdir(mode=0o700)
    state = {'container':None,'networks':{},'volume':None};registered = {'container':None,'networks':{},'volume':None}
    environment=None;initial=None;result=None;failure=None;cleanup_error=False
    private_inputs=None;private_inputs_after=None;empty_environment_sha=None;empty_client_sha=None;pre_cleanup={'container':None,'networks':{},'volume':None}
    deleted=[];remaining_counts={};facts=None
    try:
        environment,client_seal = controlled_client(d,work,spec,observed['generator']['daemonIdentitySha256'])
        initial = {kind:inventory_ids(d,kind,environment) for kind in ('containers','networks','volumes')}
        planned = reference_model(source,project,owner,spec)
        model_path = work/'compose.reference.json';model_path.write_text(json.dumps(planned,sort_keys=True)+'\n');model_path.chmod(0o600)
        release_path = work/'compose.release.json';release_path.write_bytes(b'{}\n');release_path.chmod(0o600)
        empty_path=work/'.env.empty';empty_path.write_bytes(b'');empty_path.chmod(0o600)
        seals={path.name:file_seal(path,private=True) for path in (model_path,release_path,empty_path)}
        check(empty_path.stat().st_size == 0, 'REFERENCE_MODEL_CHANGED')
        private_inputs={'compose':seals,'dockerClient':client_seal}
        empty_raw,empty_seal=_sealed_file(empty_path,private=True)
        client_raw,current_client=_sealed_file(work/'docker-client/config.json',private=True)
        check(empty_seal==seals[empty_path.name] and current_client==client_seal,'REFERENCE_MODEL_CHANGED')
        empty_environment_sha=sha(empty_raw)
        empty_client_sha=sha(client_raw)
        check(empty_environment_sha==sha(b'') and empty_client_sha==sha(b'{}\n'),'CLIENT_DEFAULT_INJECTION')
        # Dry render all planned resource names and every surrogate BEFORE create.
        rendered = frozen.unique_json(reference_cli(d,work,project,spec,environment,'config','--format','json'))
        ref_api=rendered['services']['api']
        expected_api=copy.deepcopy(source['api']);expected_api.pop('depends_on')
        expected_api['environment']=surrogate(expected_env(source['api'],source['image']))
        expected_api['labels']={OWNER_KEY:owner};expected_api['pull_policy']='never'
        check(ref_api == expected_api,'REFERENCE_MODEL_CHANGED')
        check(set(rendered.get('networks',{}))==set(NETWORK_ROLES)
              and all(rendered['networks'][role]=={'name':project+'_'+role,'external':True,**spec['renderedExternalNetworkExtra']}
                      for role in NETWORK_ROLES)
              and rendered.get('volumes')=={VOLUME_KEY:{'name':project+'_'+VOLUME_KEY,'external':True}},'REFERENCE_MODEL_CHANGED')
        ref_hash=config_hash(reference_cli(d,work,project,spec,environment,'config','--hash','api'))
        owner_existing = d.run(spec['dockerPath'],'container','ls','-a','--filter','label='+OWNER_KEY+'='+owner,
                               '--format','{{.ID}}',env=environment,timeout=30)
        check(owner_existing=='','EXISTING_REFERENCE_REFUSED')
        network_names = set(d.run(spec['dockerPath'],'network','ls','--format','{{.Name}}',env=environment,timeout=30).splitlines())
        check(not ({project+'_'+role for role in NETWORK_ROLES} & network_names)
              and project+'_'+VOLUME_KEY not in initial['volumes'],'EXISTING_REFERENCE_REFUSED')
        for role in NETWORK_ROLES:
            name=project+'_'+role
            # Explicit successor: default IPv4 only, no subnet/pool/global-config arguments.
            nid=d.run(spec['dockerPath'],'network','create','--driver','bridge','--internal',
                      '--label',OWNER_KEY+'='+owner,name,env=environment,timeout=30).strip()
            check(frozen.HEX.fullmatch(nid) and nid not in initial['networks'],'EXISTING_REFERENCE_REFUSED')
            net=read_one(d,'network',nid,env=environment)
            check(net.get('Id')==nid and net.get('Name')==name and net.get('Labels')=={OWNER_KEY:owner}
                  and isinstance(net.get('Created'),str),'REFERENCE_ID_CHANGED')
            state['networks'][role]=net;registered['networks'][role]=resource_seal(net)
            network_validate(net,role,project,spec,reference=True,owner=owner)
        subnets=[ipam_rule(net,spec,reference=True) for net in state['networks'].values()]
        check(all(not a.overlaps(b) for i,a in enumerate(subnets) for b in subnets[i+1:]),'REFERENCE_NETWORK_OVERLAP')
        actual_subnets=[ipam_rule(net,spec) for net in source['networks'].values()]
        check(all(not a.overlaps(b) for a in subnets for b in actual_subnets),'REFERENCE_NETWORK_OVERLAP')
        vname=project+'_'+VOLUME_KEY;check(vname not in initial['volumes'],'EXISTING_REFERENCE_REFUSED')
        d.run(spec['dockerPath'],'volume','create','--driver','local','--label',OWNER_KEY+'='+owner,vname,env=environment,timeout=30)
        vol=read_one(d,'volume',vname,env=environment)
        check(vol.get('Name')==vname and vol.get('Labels')=={OWNER_KEY:owner}
              and isinstance(vol.get('CreatedAt'),str),'REFERENCE_ID_CHANGED')
        state['volume']=vol;registered['volume']=resource_seal(vol)
        volume_validate(vol,project,spec,reference=True,owner=owner)
        check(file_seal(work/'docker-client'/'config.json',private=True)==client_seal,'CLIENT_DEFAULT_INJECTION')
        check(all(file_seal(work/name,private=True)==seal for name,seal in seals.items()),'REFERENCE_MODEL_CHANGED')
        generator_still_same(d,environment,spec,observed['generator']['daemonIdentitySha256'])
        reference_cli(d,work,project,spec,environment,'create','--no-build','--pull','never','api')
        ids=d.run(spec['dockerPath'],'container','ls','-a','--no-trunc','--filter','label='+OWNER_KEY+'='+owner,
                  '--filter','label=com.docker.compose.project='+project,'--format','{{.ID}}',env=environment,timeout=30).splitlines()
        check(len(ids)==1 and frozen.HEX.fullmatch(ids[0]) and ids[0] not in initial['containers'],'EXISTING_REFERENCE_REFUSED')
        meta=read_one(d,'container',ids[0],env=environment)
        check(never_started(meta) and meta['Config']['Labels'].get(OWNER_KEY)==owner,'REFERENCE_STARTED_OR_OWNER_CHANGED')
        state['container']=meta;registered['container']=resource_seal(meta)
        ref={'project':project,'directory':str(work),'filesLabel':str(model_path)+','+str(release_path),
             'envFile':str(empty_path),'configHash':ref_hash,'metadata':meta,'api':ref_api,'image':source['image'],
             'imageReference':source['imageReference'],'imageId':source['imageId'],'networks':state['networks'],
             'volume':vol,'owner':owner,'replaceAnchors':None}
        derive.canonical(meta)
        result=compare(source,ref,spec);check(result['matched'],'COMPLETE_CONFIGURATION_DIFFERENCE')
        check(all(read_one(d,'network',n['Id'],env=environment)==n for n in state['networks'].values())
              and read_one(d,'volume',vol['Name'],env=environment)==vol,'REFERENCE_RESOURCE_CHANGED')
        source_still_same(d,source,files,spec)
        check(stability_reader()==stable_before,'ORIGIN_CHANGED')
        check(all(file_seal(work/name,private=True)==seal for name,seal in seals.items()),'REFERENCE_MODEL_CHANGED')
        check(file_seal(work/'docker-client'/'config.json',private=True)==client_seal,'CLIENT_DEFAULT_INJECTION')
        private_inputs_after={'compose':{name:file_seal(work/name,private=True) for name in seals},
            'dockerClient':file_seal(work/'docker-client'/'config.json',private=True)}
        check(private_inputs_after==private_inputs,'REFERENCE_MODEL_CHANGED')
        generator_still_same(d,environment,spec,observed['generator']['daemonIdentitySha256'])
        result.update({'status':'CONTROL_ONLY_DECLARATION_MEASURED','actualResourceSha256':fingerprint({
             'networks':source['networks'],'volume':source['volume']}),'sourceFileSealsSha256':fingerprint(files),
             'referenceResourceSha256':fingerprint(registered),'sourceUnchangedBeforeAndAfter':True,
             'referenceNeverStarted':True,'referenceModelSha256':fingerprint(planned)})
    except Exception as error:
        failure=Rejected(bounded_error(error))
    finally:
        if environment is not None:
            # Discover only newly-created exact planned names with this unique owner
            # after a create whose response was lost. Never delete by prefix alone.
            if initial is not None:
                for role in NETWORK_ROLES:
                    if role in state['networks']:continue
                    try:
                        rows=frozen.read(d,'docker','network','inspect',project+'_'+role,env=environment)
                        net=rows[0] if isinstance(rows,list) and len(rows)==1 else None
                        if net is not None and net.get('Id') not in initial['networks']:
                            check(net.get('Name')==project+'_'+role and net.get('Labels')=={OWNER_KEY:owner}
                                  and isinstance(net.get('Created'),str),'REFERENCE_ID_CHANGED')
                            state['networks'][role]=net;registered['networks'][role]=resource_seal(net)
                    except Rejected:cleanup_error=True
                    except Exception:pass
                if state['volume'] is None:
                    try:
                        rows=frozen.read(d,'docker','volume','inspect',project+'_'+VOLUME_KEY,env=environment)
                        vol=rows[0] if isinstance(rows,list) and len(rows)==1 else None
                        if vol is not None and vol.get('Name') not in initial['volumes']:
                            check(vol.get('Name')==project+'_'+VOLUME_KEY and vol.get('Labels')=={OWNER_KEY:owner}
                                  and isinstance(vol.get('CreatedAt'),str),'REFERENCE_ID_CHANGED')
                            state['volume']=vol;registered['volume']=resource_seal(vol)
                    except Rejected:cleanup_error=True
                    except Exception:pass
                if state['container'] is None:
                    try:
                        ids=d.run(spec['dockerPath'],'container','ls','-a','--no-trunc','--filter','label='+OWNER_KEY+'='+owner,
                            '--filter','label=com.docker.compose.project='+project,'--format','{{.ID}}',env=environment,timeout=30).splitlines()
                        if len(ids)==1 and frozen.HEX.fullmatch(ids[0]) and ids[0] not in initial['containers']:
                            meta=read_one(d,'container',ids[0],env=environment)
                            check(never_started(meta) and meta['Config']['Labels'].get(OWNER_KEY)==owner
                                  and meta['Name']=='/'+project+'-api-1','REFERENCE_STARTED_OR_OWNER_CHANGED')
                            state['container']=meta;registered['container']=resource_seal(meta)
                        elif ids:
                            cleanup_error=True
                    except Rejected:cleanup_error=True
                    except Exception:pass
            targets=([('container',state['container'],'Id',registered['container'])] if state['container'] else [])
            if state['volume']:targets.append(('volume',state['volume'],'Name',registered['volume']))
            targets.extend(('network',row,'Id',registered['networks'][role]) for role,row in state['networks'].items())
            for kind,row,key,sealed in targets:
                try:
                    current=read_one(d,kind,row[key],env=environment)
                    labels=current['Config']['Labels'] if kind=='container' else current['Labels']
                    check(labels.get(OWNER_KEY)==owner and resource_seal(current)==sealed,'CLEANUP_SEAL_CHANGED')
                    if kind=='container':check(never_started(current),'REFERENCE_STARTED_OR_OWNER_CHANGED')
                    if kind=='network':
                        role=next(r for r,v in state['networks'].items() if v['Id']==row[key]);pre_cleanup['networks'][role]=copy.deepcopy(current)
                    else:pre_cleanup[kind]=copy.deepcopy(current)
                    d.run(spec['dockerPath'],kind,'rm',row[key],env=environment,timeout=30)
                    deleted.append((kind,row[key]))
                except Exception:cleanup_error=True
            for kind in ('container','network','volume'):
                try:
                    remaining=d.run(spec['dockerPath'],kind,'ls',*(['-a'] if kind=='container' else []),
                       '--filter','label='+OWNER_KEY+'='+owner,'--format','{{.Name}}' if kind=='volume' else '{{.ID}}',
                       env=environment,timeout=30)
                    remaining_counts[kind]=len(remaining.splitlines())
                    check(remaining=='','CLEANUP_REMAINING')
                except Exception:cleanup_error=True
        # Remove only this exact UUID-owned local input directory. No source files.
        if not cleanup_error:
            check(work.parent==root and work.name==owner and work.resolve()==work,'REFERENCE_PATH_INVALID')
            try:shutil.rmtree(work)
            except Exception:cleanup_error=True
    if cleanup_error:raise Rejected('CLEANUP_FAILED') from None
    if failure is not None:raise Rejected(bounded_error(failure)) from None
    check(result is not None,'MEASUREMENT_FAILED')
    # Acquisition AFTER exact cleanup, rather than reusing the pre-cleanup read.
    source_still_same(d,source,files,spec)
    stable_after=stability_reader()
    check(stable_after==stable_before,'ORIGIN_CHANGED')
    check(len(deleted)==6 and all(name not in initial[kind+'s'] for kind,name in deleted),'CLEANUP_FAILED')
    check(all(initial[kind]<=inventory_ids(d,kind,environment) for kind in initial),'CLEANUP_FAILED')
    result['cleanup']={'ownedContainersRemaining':remaining_counts['container'],
        'ownedNetworksRemaining':remaining_counts['network'],'ownedVolumesRemaining':remaining_counts['volume'],
        'exactOwnerCreationSealsVerified':len(deleted)==6,'existingResourcesMutated':False}
    original_env=expected_env(source['api'],source['image'])
    default_env=env_map(source['image']['Config']['Env'])
    normalized_model=derive.normalize_source_intent(full_source_model,source['directory'],source['project'],original_env,default_env)
    facts={'version':1,'formalTableSha256':FORMAL_TABLE_SHA,'sourceFileSealsSha256':fingerprint(files),
        'generator':{'engineVersion':observed['generator']['engineVersion'],
            'composeVersion':observed['generator']['composeVersion'],'rulesSha256':fingerprint(spec)},
        'source':{'renderedDeclarationSha256':fingerprint(full_source_model),
            'normalizedModelSha256':derive.digest(normalized_model),'apiDeclaredHash':source['configHash'],
            'expectedEnvironmentSha256':derive.environment_digest(original_env),
            'referenceEnvironmentSha256':derive.environment_digest(surrogate(original_env))},
        'referenceRegistry':derive.registry(state,pre_cleanup,owner),
        'referenceInputs':{'modelCanonicalSha256':fingerprint(planned),
            'surrogateEnvironmentSha256':derive.environment_digest(surrogate(original_env)),
            'emptyEnvironmentBytesSha256':empty_environment_sha,'emptyDockerConfigBytesSha256':empty_client_sha,
            'beforeFileSealsSha256':fingerprint(private_inputs),'afterFileSealsSha256':fingerprint(private_inputs_after)},
        'stableBefore':stable_before,'stableAfter':stable_after}
    derive.canonical(facts)
    check(facts['source']['normalizedModelSha256']!=result['referenceModelSha256'],'SOURCE_MODEL_HASH_INVALID')
    return {'measured':result,'facts':facts}
