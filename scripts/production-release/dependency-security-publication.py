"""Read the deployed dependency baseline through the existing bounded OIDC/SSM transport."""
import argparse
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import re
import subprocess
import shutil

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PREFIX = 'dependency-security'
CONTRACT_FILE = PREFIX + '-contract.json'
WORKFLOW = '.github/workflows/dependency-security-publication.yml'
OUT = ROOT / '.deploy' / PREFIX
CURRENT = '506b371601f48838f9a6846447c2ab4d899262bb'
SOURCE = '7d815639c875bc7e4bcb3d7715c74b954b9f8ecb'
SOURCES = frozenset(('package.json', 'package-lock.json', 'apps/api/package.json'))


def need(value, code):
    if not value:
        raise RuntimeError('DEPENDENCY_SECURITY_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('dependency_security_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate(c):
    need(c['version'] == 1 and c['expectedCurrent'] == CURRENT and c['sourceCommit'] == SOURCE
         and c['sourcePullRequest'] == 766 and set(c['sources']) == SOURCES, 'CONTRACT_CHANGED')
    need(c['businessActions'] == 0 and c['migrationPerformed'] is False
         and c['automaticRollback'] is False, 'SIDE_EFFECT_SCOPE')
    need(c['predecessorPlan']['commit'] == CURRENT
         and c['predecessorReadback']['commandId'] == 'ef1b37fc-73fc-4a52-b452-258dbe9ab130'
         and c['predecessorReadback']['workflowRunId'] == '41171016727', 'PREDECESSOR_CHANGED')
    need(all(re.fullmatch(r'node_modules/(?:@[a-z0-9-]+/)?[a-z0-9-]+(?:/node_modules/(?:@[a-z0-9-]+/)?[a-z0-9-]+)*', n)
             for n in c['packageDirectories']) and len(c['packageDirectories']) == 16, 'PACKAGE_PATH_CHANGED')


def check(c):
    validate(c)
    for name, digest in c['sources'].items():
        need(sha((ROOT / name).read_bytes()) == digest
             == sha(subprocess.check_output(['git', 'show', SOURCE + ':' + name], cwd=ROOT)), 'SOURCE_CHANGED')
    for name, digest in c['helperPins'].items():
        need(sha((HERE / name).read_bytes()) == digest, 'HELPER_CHANGED')


def dependency_state(d, container, c, *, image=False):
    code = r'''
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const names=JSON.parse(process.argv[1]);
const inventory={};
function summary(root,excluded=[]){const rows={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
 const p=path.join(dir,e.name),n=path.relative(root,p);if(excluded.some(x=>n===x||n.startsWith(x+'/')))continue;
 if(e.isSymbolicLink())rows[n]='link:'+fs.readlinkSync(p);else if(e.isDirectory())walk(p);else if(e.isFile())rows[n]=hash(fs.readFileSync(p));else throw Error('KIND');
}}walk(root);return{count:Object.keys(rows).length,sha256:hash(JSON.stringify(Object.fromEntries(Object.entries(rows).sort(([a],[b])=>a<b?-1:a>b?1:0))))};}

for(const name of names){
 const root='/app/'+name,rows={};
 if(!fs.existsSync(root)){inventory[name]=null;continue;}
 function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const p=path.join(dir,e.name),n=path.relative(root,p);
  if(e.isSymbolicLink())throw Error('PACKAGE_LINK');
  if(e.isDirectory())walk(p);else if(e.isFile())rows[n]=hash(fs.readFileSync(p));else throw Error('PACKAGE_KIND');
 }}
 walk(root);const ordered=Object.fromEntries(Object.entries(rows).sort(([a],[b])=>a<b?-1:a>b?1:0));
 inventory[name]={count:Object.keys(rows).length,sha256:hash(JSON.stringify(ordered)),version:JSON.parse(fs.readFileSync(root+'/package.json')).version};
}
const metadata={};for(const n of ['package.json','package-lock.json','apps/api/package.json']){
 const p='/app/'+n;metadata[n]=fs.existsSync(p)?hash(fs.readFileSync(p)):null;
}
console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,inventory,metadata,preservedNodeModules:summary('/app/node_modules',names.map(n=>n.slice('node_modules/'.length)))}));
'''
    command = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', container] if image else ['docker', 'exec', container, 'node']
    return json.loads(d.run(*command, '-e', code, json.dumps(c['packageDirectories']), timeout=90))


def release(plan, c):
    """Capture only. No compose switch, database write, network comparison, or cleanup."""
    validate(c)
    need(plan['mode'] == 'parent', 'READ_ONLY_MODE_REQUIRED')
    need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes()), 'CONTRACT_HASH_CHANGED')
    need(all(sha((HERE / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'CONTROL_CHANGED')
    base = Path('/opt/id-business-v2')
    current = (base / 'current').resolve(strict=True)
    manifest_raw = (current / 'release-manifest.json').read_bytes()
    manifest = json.loads(manifest_raw)
    need(current.parent == base / 'releases' and manifest['commit'] == CURRENT, 'CURRENT_CHANGED')
    previous = load('online-session-observer-release.py')
    previous_contract = json.loads((HERE / previous.CONTRACT_FILE).read_bytes())
    result = previous.release({**c['predecessorPlan'], 'mode': 'readback'}, previous_contract)
    need(result['status'] == 'ONLINE_SESSION_OBSERVER_20261031_INDEPENDENT_READBACK_VERIFIED', 'PREDECESSOR_UNVERIFIED')
    core = previous.engine(previous_contract, c['predecessorPlan'])
    h, _old, d, *_ = core.LEGACY.helpers()
    before = h.snapshot(d, current)
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()
    runtime = history.runtime(d, before)
    dependencies = dependency_state(d, before['api']['containerId'], c)
    host_sources = {n: sha((current / n).read_bytes()) if (current / n).is_file() else None for n in SOURCES}
    need((base / 'current').resolve() == current and h.snapshot(d, current) == before, 'CAPTURE_DRIFT')
    return {'status': 'DEPENDENCY_SECURITY_PARENT_VERIFIED', 'commit': CURRENT,
            'baseline': {'current': str(current), 'manifestSha256': sha(manifest_raw), 'services': before,
                         'runtime': runtime, 'dependencies': dependencies, 'hostMetadataSha256': host_sources,
                         'configurationSha256': {n: sha((current / n).read_bytes()) for n in history.CONFIGURATION},
                         'runtimeConfigurationSha256': {n: h.configuration(d, state) for n, state in before.items()},
                         'database': history.database(d, before['api']),
                         'backupNormalizerPath': c['predecessorPlan']['nativeParentCapture']['baseline']['backupNormalizerPath'],
                         'freeBytes': shutil.disk_usage(base).free},
            'businessActions': 0, 'migrationPerformed': False}


def transport(plan):
    f = load('financial-closure-publication.py')
    source = inspect.getsource(f.transport)
    need(source.count("directory/'financial-closure-release.py'") == 1, 'TRANSPORT_CHANGED')
    source = source.replace("directory/'financial-closure-release.py'", "directory/'dependency-security-publication.py'")
    source = source.replace('financial-entry-', 'dependency-security-entry-')
    source = source.replace('FINANCIAL_PUBLICATION|BITBROWSER_HISTORY', 'DEPENDENCY_SECURITY|FINANCIAL_PUBLICATION|BITBROWSER_HISTORY')
    values = dict(f.__dict__)
    exec(compile(source, '<dependency-security-transport>', 'exec'), values)
    return values['transport'](plan, 'parent', OUT)


def capture(c):
    check(c)
    f = load('financial-closure-publication.py')
    f.WORKFLOW = WORKFLOW
    need(os.environ.get('EXPECTED_CURRENT') == CURRENT, 'EXPECTED_CURRENT_CHANGED')
    need(json.loads(f.execute('aws', 'sts', 'get-caller-identity', '--output', 'json'))['Account'] == '098208446664', 'AWS_ACCOUNT_CHANGED')
    native = f.native_identity()
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    OUT.mkdir(mode=0o700, parents=True)
    controls = {**c['helperPins'], CONTRACT_FILE: sha((HERE / CONTRACT_FILE).read_bytes()),
                Path(__file__).name: sha(Path(__file__).read_bytes())}
    plan = {**native, 'contractSha256': controls[CONTRACT_FILE], 'controlSources': controls}
    (OUT / 'capture-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    result = transport(plan)
    need(result['status'] == 'DEPENDENCY_SECURITY_PARENT_VERIFIED', 'CAPTURE_FAILED')
    print(json.dumps({'status': result['status'], **native, 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('check', 'capture'))
    args = parser.parse_args()
    contract = json.loads((HERE / CONTRACT_FILE).read_bytes())
    {'check': check, 'capture': capture}[args.mode](contract)
