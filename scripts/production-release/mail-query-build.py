"""Reproduce the published source recipe, then build only the reviewed mailbox delta."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
CURRENT = '21f63083dd8044726811f6d055b3da675ced31d7'
REVIEW_BASE = 'e3171368'
API = tuple('apps/api/src/id-business-v2/workspace/' + n + '.ts' for n in (
    'dto/id-business-v2-vendure-mailbox.dto', 'id-business-v2-mail-viewer.service',
    'id-business-v2-vendure-mailbox.service', 'providers/id-business-v2-vendure-mailbox.client',
    'vendure-mailbox-list'))
ADMIN = tuple('apps/admin/src/v2/' + n for n in (
    'components/workspace/V2MailBody.vue', 'components/workspace/V2MailMessageList.vue',
    'components/workspace/mail-viewer.ts', 'features/auto-recharge/VendureMailboxManager.vue',
    'features/auto-recharge/VendureMailboxHealth.vue'))
SHARED = ('packages/shared/src/v2/vendure-mailbox.ts',)
SOURCES = (*API, *ADMIN, *SHARED)


def need(value, code):
    if not value:
        raise RuntimeError('MAIL_QUERY_' + code)


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def compile_context(context, role, commit):
    env={**os.environ,'NODE_ENV':'production','V2_BUILD_ID':'v2-'+commit}
    commands=[['npm','run','build','--workspace','packages/shared']]
    if role=='api':commands.append(['npm','run','prisma:mysql:generate'])
    commands.append(['npm','run','build','--workspace','apps/'+role])
    for command in commands:subprocess.run(command,cwd=context,env=env,check=True)


def build(plan, out):
    need(not out.exists(), 'BUILD_OUTPUT_EXISTS')
    out.mkdir(parents=True, mode=0o700)
    published=ROOT/'.codex-worktrees/mail-query-published-build'
    need(not published.exists(),'BASE_SOURCE_EXISTS')
    subprocess.run(['git','worktree','add','--detach',str(published),CURRENT],cwd=ROOT,check=True)
    recipe=load(published/'scripts/production-release/recharge-plan-billing-build.py')
    h=load(HERE/'recharge-record-release.py')
    current=json.loads((HERE/'mail-query-contract.json').read_bytes())
    binding=current['parentNativeArtifact']
    with urllib.request.urlopen(binding['url'],timeout=60) as response:raw=response.read(96*1024**2+1)
    need(h.digest(raw)==binding['sha256'],'PUBLISHED_ARTIFACT_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:proof_raw=archive.extractfile('payload/build-proof.json').read()
    need(h.digest(proof_raw)==binding['buildProofSha256'],'PUBLISHED_PROOF_CHANGED')
    proof=json.loads(proof_raw)
    need(proof['commit']==CURRENT and proof['workflowRunId']==binding['workflowRunId'],'PUBLISHED_IDENTITY_CHANGED')
    parent=json.loads((published/'scripts/production-release/recharge-plan-billing-contract.json').read_bytes())
    need(proof['sources']==parent['sources'],'PUBLISHED_SOURCE_CHANGED')
    recipe.OUT=out/'baseline';recipe.OUT.mkdir()
    api,admin=recipe.reconstruct(parent)
    recipe.compile(api,'api',parent['baselineAdminBuildCommit'])
    recipe.compile(admin,'admin',parent['baselineAdminBuildCommit'])
    before=h.file_inventory(api/'apps/api/dist')
    need(recipe.runtime_groups(before)==proof['baselineApiGroups'] and
         h.file_inventory(admin/'apps/admin/dist')==proof['baselineAdminFiles'],'PUBLISHED_BASE_NOT_REPRODUCED')
    for role,context in [('api',api),('admin',admin)]:
        selected={n:v for n,v in parent['sources'].items() if n.startswith(('apps/'+role+'/', 'packages/shared/'))}
        recipe.overlay(context,selected,CURRENT)
        compile_context(context,role,CURRENT)
    after=h.file_inventory(api/'apps/api/dist')
    changed={n for n in before.keys()|after.keys() if before.get(n)!=after.get(n)}
    need(not (before.keys()-after.keys()) and all(n in proof['apiModules'] or n.endswith('.d.ts')
         or n=='tsconfig.build.tsbuildinfo' for n in changed),'PUBLISHED_RUNTIME_SCOPE_CHANGED')
    need(all(after.get(n)==v for n,v in proof['apiModules'].items())
         and h.file_inventory(admin/'apps/admin/dist')==proof['adminFiles']==current['adminFiles'],
         'PUBLISHED_RUNTIME_NOT_REPRODUCED')
    # Generator paths can differ on this fresh compiler context; the runtime client is retained in the parent image.
    need(h.digest((api/'node_modules/.prisma/client/schema.prisma').read_bytes())==proof['prismaClientFiles']['schema.prisma'],
         'PUBLISHED_SCHEMA_CHANGED')
    return overlay(plan,out,recipe.OUT,admin_context=admin,api_context=api)


def overlay(plan, out, baseline_out, admin_context=None, api_context=None):
    h = load(HERE / 'recharge-record-release.py')
    current_contract = json.loads((HERE / 'mail-query-contract.json').read_bytes())
    api = api_context or baseline_out / 'api-context'
    if admin_context is None:
        candidates = [p.parent.parent for p in (baseline_out / 'admin-source').rglob('apps/admin')
                      if p.parent.parent.name == 'admin-baseline' and (p.parent.parent / 'package.json').is_file()]
        need(len(candidates) == 1, 'ADMIN_CONTEXT_AMBIGUOUS')
        admin_context = candidates[0]
    admin = admin_context
    before_api = h.file_inventory(api / 'apps/api/dist')
    before_shared = h.file_inventory(api / 'packages/shared/dist')
    before_admin = h.file_inventory(admin / 'apps/admin/dist')
    need(before_admin == current_contract['adminFiles'], 'ADMIN_NOT_REPRODUCED')
    source_hashes = {}
    for name in SOURCES:
        context = admin if name in ADMIN else api
        destination = context / name
        original = destination.read_bytes() if destination.exists() else None
        if name.endswith('V2MailBody.vue'):
            need(original is None, 'NEW_COMPONENT_ALREADY_EXISTS')
        else:
            need(original == git('show', REVIEW_BASE + ':' + name), 'UNREVIEWED_BASE_SOURCE')
        raw = (ROOT / name).read_bytes()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(raw)
        source_hashes[name] = h.digest(raw)
        if name in SHARED:
            (admin / name).write_bytes(raw)
    env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + plan['commit']}
    for context, workspaces in ((api, ('packages/shared', 'apps/api')), (admin, ('packages/shared', 'apps/admin'))):
        for workspace in workspaces:
            subprocess.run(['npm', 'run', 'build', '--workspace', workspace], cwd=context, env=env, check=True)
    after_api = h.file_inventory(api / 'apps/api/dist')
    after_shared = h.file_inventory(api / 'packages/shared/dist')
    need({n:v for n,v in before_shared.items() if n.endswith('.js')} ==
         {n:v for n,v in after_shared.items() if n.endswith('.js')}, 'SHARED_RUNTIME_CHANGED')
    modules = {name.removeprefix('apps/api/src/').removesuffix('.ts') + ext
               for name in API for ext in ('.js', '.js.map')}
    changed = {n for n in before_api.keys() | after_api.keys() if before_api.get(n) != after_api.get(n)}
    need(not (before_api.keys() - after_api.keys()) and all(
        n in modules or n.endswith('.d.ts') or n == 'tsconfig.build.tsbuildinfo' for n in changed), 'API_RUNTIME_SCOPE_CHANGED')
    payload = out / 'payload'
    shutil.copytree(admin / 'apps/admin/dist', payload / 'admin/html')
    for name in modules:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(api / 'apps/api/dist' / name, target)
    for name in SOURCES:
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    result = {**plan, 'scope': 'MAIL_QUERY_20261026', 'sources': source_hashes,
              'baselineApiModules': {n: before_api[n] for n in modules},
              'baselineAdminFiles': before_admin, 'apiModules': {n: after_api[n] for n in modules},
              'adminFiles': h.file_inventory(admin / 'apps/admin/dist'),
              'files': h.file_inventory(payload), 'migrationPerformed': False, 'businessActions': 0}
    (payload / 'build-proof.json').write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
    return result
