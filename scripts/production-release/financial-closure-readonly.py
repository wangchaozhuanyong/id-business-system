"""Read production identity and 49+11 counts using the existing main-only OIDC role."""
import base64
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
import zlib

ROOT = Path(__file__).resolve().parents[2]
INSTANCE = 'i-05836da38606e633c'
REGION = 'ap-northeast-1'
REPOSITORY = 'wangchaozhuanyong/id-business-system'
FROZEN_RULES = '9c982c6f6c4573715d6679d64eb898ea20080430aa18ac42ae093beac181f26e'


def need(value, code):
    if not value:
        raise RuntimeError('FINANCIAL_READONLY_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def execute(*args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, timeout=90)
    need(result.returncode == 0, 'TRANSPORT_FAILED')
    return result.stdout


def bundle():
    need(sha((ROOT / 'scripts/lib/v2-data-integrity-audit.mjs').read_bytes()) == FROZEN_RULES,
         'GENERAL_RULES_CHANGED')
    source = r"""
import { V2_DATA_INTEGRITY_CHECKS, buildV2DataIntegrityCheckQuery, assertV2AuditConnectionReadOnly } from './scripts/lib/v2-data-integrity-audit.mjs';
import { V2_ONLINE_RECHARGE_INTEGRITY_CHECKS } from './scripts/lib/v2-online-recharge-integrity.mjs';
const general=V2_DATA_INTEGRITY_CHECKS.map(r=>({...r,scope:'general',severity:'error'}));
const online=V2_ONLINE_RECHARGE_INTEGRITY_CHECKS.map(r=>({...r,scope:'online-recharge'}));
console.log(JSON.stringify({grantCheck:assertV2AuditConnectionReadOnly.toString(),rules:[...general,...online].map(r=>({code:r.code,severity:r.severity,scope:r.scope,sql:buildV2DataIntegrityCheckQuery(r.sql)}))}));
"""
    result = subprocess.run(['node', '--input-type=module', '-'], input=source.encode(),
                            cwd=ROOT, capture_output=True, timeout=30)
    need(result.returncode == 0, 'RULES_UNAVAILABLE')
    data = json.loads(result.stdout)
    need(len(data['rules']) == 60
         and sum(r['scope'] == 'general' for r in data['rules']) == 49
         and sum(r['scope'] == 'online-recharge' for r in data['rules']) == 11, 'RULE_COUNT_CHANGED')
    runner = r"""
const fs=require('node:fs'),{PrismaClient}=require('@prisma/client');
let stage='INPUT',ruleCode=null;
(async()=>{const input=JSON.parse(fs.readFileSync(0,'utf8')),url=new URL(input.auditUrl);
if(url.protocol!=='mysql:'||url.hostname!=='mysql'||input.rules.length!==60)throw Error('TARGET');
url.searchParams.set('connection_limit','1');
const p=new PrismaClient({datasourceUrl:url.toString(),log:[]});
try{stage='CONNECT';await p.$connect();stage='GRANTS';assertV2AuditConnectionReadOnly(await p.$queryRawUnsafe('SHOW GRANTS'));
stage='READONLY';
await p.$executeRawUnsafe('SET SESSION TRANSACTION READ ONLY');
const checks=await p.$transaction(async tx=>{stage='SNAPSHOT';const [v]=await tx.$queryRawUnsafe('SELECT DATABASE() AS db, @@transaction_isolation AS iso, @@session.transaction_read_only AS ro, @@session.foreign_key_checks AS fk');
if(v.db!==decodeURIComponent(url.pathname.slice(1))||v.iso!=='REPEATABLE-READ'||String(v.ro)!=='1'||String(v.fk)!=='1')throw Error('SNAPSHOT');
const out=[];for(const rule of input.rules){stage='RULE';ruleCode=rule.code;const rows=await tx.$queryRawUnsafe(rule.sql),raw=rows.length===1?String(rows[0].count):'',count=Number(raw);
if(!/^\d+$/.test(raw)||!Number.isSafeInteger(count))throw Error('COUNT');out.push({code:rule.code,severity:rule.severity,scope:rule.scope,count});}return out;},{isolationLevel:'RepeatableRead',timeout:120000});
console.log(JSON.stringify({status:'AUDITED',checks,verifiedReadOnlyAccount:true,databaseWrites:0}));
}finally{await p.$disconnect().catch(()=>undefined);}})().catch(()=>{console.log(JSON.stringify({status:'AUDIT_UNAVAILABLE',databaseWrites:0,stage,rule:ruleCode}));process.exitCode=1;});
"""
    return {'runner': data['grantCheck'] + '\n' + runner, 'rules': data['rules']}


def observe_server(data):
    # This whole function is sent as immutable source. No helper is downloaded,
    # file is written, service is switched or database privilege is granted.
    import hashlib
    import json
    from pathlib import Path
    import re
    import shutil
    import subprocess
    from urllib.parse import urlsplit, urlunsplit

    def digest(raw):
        return hashlib.sha256(raw).hexdigest()

    def run(*args, private_input=None, allowed_codes=(0,)):
        value = subprocess.run(args, capture_output=True, text=True, input=private_input, timeout=180)
        if value.returncode not in allowed_codes:
            raise RuntimeError('READ_FAILED')
        return value.stdout.strip()

    base = Path('/opt/id-business-v2')
    current = (base / 'current').resolve(strict=True)
    assert current.parent == base / 'releases'
    raw = (current / 'release-manifest.json').read_bytes()
    manifest = json.loads(raw)
    assert re.fullmatch('[a-f0-9]{40}', manifest['commit'])
    roles = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'online-recharge')
    compose = ['docker', 'compose', '--env-file', str(current / '.env.aws.production'),
               '-f', str(current / 'docker-compose.aws-mysql.yml'),
               '-f', str(current / 'compose.release.json')]
    states = {}
    for role in roles:
        container = run(*compose, 'ps', '-a', '-q', role)
        assert re.fullmatch('[a-f0-9]{64}', container)
        row = json.loads(run('docker', 'inspect', container))[0]
        config = {key: row[key] for key in ('Config', 'HostConfig', 'Mounts')}
        states[role] = {'containerId': row['Id'], 'image': row['Image'],
                        'status': row['State']['Status'],
                        'health': row['State'].get('Health', {}).get('Status'),
                        'configurationSha256': digest(json.dumps(config, sort_keys=True,
                                                               separators=(',', ':')).encode())}
    module = '/app/apps/api/dist/id-business-v2/online-recharge/persistence/admin.repository.js'
    api_hash = run('docker', 'exec', states['api']['containerId'], 'sha256sum', module).split()[0]
    index_hash = run('docker', 'exec', states['admin']['containerId'], 'sha256sum',
                     '/usr/share/nginx/html/index.html').split()[0]
    identity = {'current': str(current), 'commit': manifest['commit'],
                'manifestSha256': digest(raw), 'services': states,
                'apiBillingSha256': api_hash, 'adminIndexSha256': index_hash,
                'freeBytes': shutil.disk_usage(base).free}
    values = {}
    for line in (current / '.env.aws.production').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key] = value.strip().strip('"').strip("'")
    audit = {'status': 'AUDIT_UNAVAILABLE', 'databaseWrites': 0, 'stage': 'CONFIGURATION', 'rule': None}
    try:
        url = urlsplit(values['V2_DATA_INTEGRITY_DATABASE_URL'])
        assert url.scheme == 'mysql' and url.hostname in ('127.0.0.1', 'localhost')
        info, separator, _ = url.netloc.rpartition('@')
        assert separator and info
        private_url = urlunsplit(url._replace(netloc=info + '@mysql' + (':' + str(url.port) if url.port else '')))
        audit = {'status': 'AUDIT_UNAVAILABLE', 'databaseWrites': 0, 'stage': 'CONNECT', 'rule': None}
        result = run('docker', 'exec', '-i', '-w', '/app', states['api']['containerId'],
                     'node', '-e', data['runner'],
                     private_input=json.dumps({'auditUrl': private_url, 'rules': data['rules']}),
                     allowed_codes=(0, 1))
        audit = json.loads(result)
    except Exception:
        pass
    assert (base / 'current').resolve() == current and (current / 'release-manifest.json').read_bytes() == raw
    return {'status': 'FINANCIAL_READONLY_OBSERVED', 'identity': identity, 'audit': audit,
            'productionWrites': 0}


def parameters(data):
    source = inspect.getsource(observe_server)
    source += '\nimport json\ntry:\n print(json.dumps(observe_server(' + repr(data) + '),sort_keys=True))\n'
    source += 'except Exception:\n print(\'{"status":"OBSERVATION_FAILED","productionWrites":0}\')\n raise SystemExit(1) from None\n'
    encoded = base64.b64encode(zlib.compress(source.encode())).decode()
    program = 'import base64,zlib;exec(compile(zlib.decompress(base64.b64decode(' + repr(encoded) + ")), '<financial-readonly>', 'exec'))"
    result = {'commands': ['python3 -c ' + shlex.quote(program)], 'executionTimeout': ['300']}
    need(len(json.dumps(result).encode()) < 24000, 'INPUT_BOUND_EXCEEDED')
    return result


def validate_report(report, definitions):
    need(type(report) is dict and set(report) == {'status', 'identity', 'audit', 'productionWrites'}
         and report['status'] == 'FINANCIAL_READONLY_OBSERVED' and report['productionWrites'] == 0,
         'REPORT_INVALID')
    identity = report['identity']
    need(set(identity) == {'current', 'commit', 'manifestSha256', 'services', 'apiBillingSha256',
                           'adminIndexSha256', 'freeBytes'}, 'IDENTITY_INVALID')
    need(re.fullmatch('/opt/id-business-v2/releases/[A-Za-z0-9_-]+', identity['current'])
         and re.fullmatch('[a-f0-9]{40}', identity['commit'])
         and all(re.fullmatch('[a-f0-9]{64}', identity[n]) for n in
                 ('manifestSha256', 'apiBillingSha256', 'adminIndexSha256'))
         and type(identity['freeBytes']) is int and identity['freeBytes'] >= 0, 'IDENTITY_INVALID')
    need(set(identity['services']) == {'api', 'admin', 'mysql', 'caddy', 'media-resolver',
                                      'auto-recharge', 'online-recharge'}, 'SERVICES_INVALID')
    for row in identity['services'].values():
        need(set(row) == {'containerId', 'image', 'status', 'health', 'configurationSha256'}
             and all(re.fullmatch('[a-f0-9]{64}', row[k]) for k in ('containerId', 'configurationSha256'))
             and re.fullmatch('sha256:[a-f0-9]{64}', row['image'])
             and row['status'] in ('running', 'exited', 'restarting', 'paused', 'dead', 'created', 'removing')
             and row['health'] in (None, 'healthy', 'unhealthy', 'starting'), 'SERVICES_INVALID')
    audit = report['audit']
    if audit.get('status') == 'AUDIT_UNAVAILABLE':
        need(set(audit) == {'status', 'databaseWrites', 'stage', 'rule'}
             and audit['databaseWrites'] == 0
             and audit['stage'] in ('INPUT', 'CONNECT', 'GRANTS', 'READONLY', 'SNAPSHOT', 'RULE', 'CONFIGURATION')
             and (audit['rule'] in {d['code'] for d in definitions}
                  if audit['stage'] == 'RULE' else audit['rule'] is None), 'AUDIT_INVALID')
        return False
    need(set(audit) == {'status', 'checks', 'verifiedReadOnlyAccount', 'databaseWrites'}
         and audit['status'] == 'AUDITED' and audit['verifiedReadOnlyAccount'] is True
         and audit['databaseWrites'] == 0 and len(audit['checks']) == 60, 'AUDIT_INVALID')
    for actual, expected in zip(audit['checks'], definitions):
        need(set(actual) == {'code', 'severity', 'scope', 'count'}
             and all(actual[k] == expected[k] for k in ('code', 'severity', 'scope'))
             and type(actual['count']) is int and 0 <= actual['count'] <= 2**53 - 1, 'AUDIT_INVALID')
    return True


def main():
    need(os.environ.get('GITHUB_ACTIONS') == 'true'
         and os.environ.get('GITHUB_REF') == 'refs/heads/main'
         and os.environ.get('GITHUB_REPOSITORY') == REPOSITORY
         and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'MAIN_ONLY')
    commit = os.environ.get('GITHUB_SHA', '')
    need(re.fullmatch('[a-f0-9]{40}', commit) is not None
         and execute('git', 'rev-parse', 'HEAD').decode().strip() == commit
         and execute('gh', 'api', 'repos/' + REPOSITORY + '/git/ref/heads/main',
                     '--jq', '.object.sha').decode().strip() == commit, 'MAIN_MOVED')
    run_id, attempt = (os.environ.get(n, '') for n in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'))
    need(all(re.fullmatch('[1-9][0-9]*', n) for n in (run_id, attempt)), 'RUN_INVALID')
    os.umask(0o077)
    output = ROOT / '.deploy/financial-closure-readonly' / (run_id + '-' + attempt)
    output.mkdir(parents=True, exist_ok=False)
    data = bundle()
    request = parameters(data)
    (output / 'parameters.json').write_text(json.dumps(request, sort_keys=True) + '\n')
    (output / 'intent.json').write_text(json.dumps({'commit': commit, 'runId': run_id,
        'runAttempt': attempt, 'instanceId': INSTANCE, 'sourceSha256': sha(Path(__file__).read_bytes()),
        'parameterSha256': sha(json.dumps(request, sort_keys=True).encode()), 'productionWrites': 0}) + '\n')
    command = execute('aws', '--region', REGION, 'ssm', 'send-command', '--instance-ids', INSTANCE,
                      '--document-name', 'AWS-RunShellScript', '--parameters', json.dumps(request),
                      '--comment', 'ID financial closure read-only identity and counts',
                      '--query', 'Command.CommandId', '--output', 'text').decode().strip()
    need(re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command) is not None, 'COMMAND_INVALID')
    (output / 'command-id.txt').write_text(command + '\n')
    for poll in range(72):
        time.sleep(5)
        try:
            invocation_raw = execute('aws', '--region', REGION, 'ssm', 'get-command-invocation',
                                     '--command-id', command, '--instance-id', INSTANCE, '--output', 'json')
        except RuntimeError:
            # SSM can briefly report InvocationDoesNotExist immediately after
            # accepting the one command. Only reads retry, never send-command.
            if poll < 3:
                continue
            raise
        invocation = json.loads(invocation_raw)
        if invocation['Status'] in ('Pending', 'InProgress', 'Delayed'):
            continue
        metadata = {k: invocation.get(k) for k in
                    ('CommandId', 'InstanceId', 'DocumentName', 'PluginName', 'Status', 'ResponseCode')}
        (output / 'invocation-metadata.json').write_text(json.dumps(metadata) + '\n')
        need(metadata == {'CommandId': command, 'InstanceId': INSTANCE,
                          'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript',
                          'Status': 'Success', 'ResponseCode': 0}
             and type(invocation.get('ResponseCode')) is int
             and type(invocation.get('ExecutionEndDateTime')) is str
             and 0 < len(invocation['ExecutionEndDateTime']) <= 80
             and invocation.get('StandardErrorContent') == '', 'NATIVE_FAILED')
        stdout = invocation.get('StandardOutputContent', '')
        need(type(stdout) is str and 0 < len(stdout) < 24000, 'OUTPUT_BOUND_EXCEEDED')
        report = json.loads(stdout)
        complete = validate_report(report, data['rules'])
        (output / 'result.json').write_text(json.dumps(report, sort_keys=True, indent=2) + '\n')
        (output / 'invocation.json').write_bytes(invocation_raw)
        print(json.dumps({'status': report['status'], 'commit': report['identity']['commit'],
                          'checkCount': 60 if complete else 0, 'auditAvailable': complete,
                          'productionWrites': 0}))
        need(complete, 'AUDIT_UNAVAILABLE')
        return
    raise RuntimeError('FINANCIAL_READONLY_RESULT_PENDING')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(code if re.fullmatch('FINANCIAL_READONLY_[A-Z0-9_]+', code) else 'FINANCIAL_READONLY_FAILED')
        raise SystemExit(1) from None
