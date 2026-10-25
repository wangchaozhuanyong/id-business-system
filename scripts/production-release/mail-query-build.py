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
CURRENT = '034f737d551412928e99f589370b937f2b263593'
REVIEW_BASE = 'e3171368'
API = tuple('apps/api/src/id-business-v2/workspace/' + n + '.ts' for n in (
    'dto/id-business-v2-vendure-mailbox.dto', 'id-business-v2-mail-viewer.service',
    'id-business-v2-vendure-mailbox.service', 'providers/id-business-v2-vendure-mailbox.client',
    'vendure-mailbox-list'))
ADMIN = tuple('apps/admin/src/v2/' + n for n in (
    'components/workspace/V2MailBody.vue', 'components/workspace/V2MailMessageList.vue',
    'components/workspace/mail-viewer.ts', 'features/auto-recharge/VendureMailboxManager.vue'))
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


def build(plan, out):
    need(not out.exists(), 'BUILD_OUTPUT_EXISTS')
    out.mkdir(parents=True, mode=0o700)
    published = ROOT / '.codex-worktrees/mail-query-published-build'
    need(not published.exists(), 'BASE_SOURCE_EXISTS')
    subprocess.run(['git', 'worktree', 'add', '--detach', str(published), CURRENT], cwd=ROOT, check=True)
    recipe = load(published / 'scripts/production-release/online-country-evidence-build.py')
    h = load(HERE / 'recharge-record-release.py')
    current_contract = json.loads((HERE / 'online-profile-lock-contract.json').read_bytes())
    binding = current_contract['parentArtifact']
    with urllib.request.urlopen(binding['artifactUrl'], timeout=60) as response:
        raw = response.read(24 * 1024**2 + 1)
    need(h.digest(raw) == binding['artifactSha256'], 'PUBLISHED_ARTIFACT_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        proof_raw = archive.extractfile('payload/build-proof.json').read()
    need(h.digest(proof_raw) == binding['buildProofSha256'], 'PUBLISHED_PROOF_CHANGED')
    proof = json.loads(proof_raw)
    c = json.loads((published / 'scripts/production-release/online-country-evidence-contract.json').read_bytes())
    baseline_out = out / 'baseline'
    baseline_out.mkdir()
    recipe.build(c, proof, proof['qualitySourceEvidence'], proof['nativeParentCapture'], baseline_out)
    return overlay(plan, out, baseline_out)


def overlay(plan, out, baseline_out, admin_context=None):
    h = load(HERE / 'recharge-record-release.py')
    current_contract = json.loads((HERE / 'online-profile-lock-contract.json').read_bytes())
    api = baseline_out / 'api-context'
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
