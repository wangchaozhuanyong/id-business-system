"""Finite Admin-only successor; retain the existing six other services and data."""
import importlib.util
import json
from pathlib import Path
import re
import shutil

HERE = Path(__file__).resolve().parent
PREFIX = 'interaction-flow'
CONTRACT_FILE = PREFIX + '-contract.json'
SCOPE = 'ADMIN_INTERACTION_FLOW_20261104'
CURRENT = '9c176b8210d0961a3ca55f74fe23387db71c0494'
ADMIN_PARENT = CURRENT


def load(name):
    spec = importlib.util.spec_from_file_location('interaction_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('permission-loading-runtime.py')
need, sha, canonical = P.need, P.sha, P.canonical


def validate_contract(c):
    need(c['version'] == 1 and c['scope'] == SCOPE and c['expectedCurrent'] == CURRENT
         and c['baselineAdminCommit'] == CURRENT and c['sourceBase'] == CURRENT
         and c['reviewBase'] == CURRENT and c['awsAccount'] == '098208446664'
         and c['updatedServices'] == ['admin'] and c['migrationPerformed'] is False
         and type(c['businessActions']) is int and c['businessActions'] == 0
         and set(c['preservedServices']) == {'api', 'mysql', 'caddy', 'auto-recharge', 'online-recharge', 'media-resolver'}, 'SCOPE_CHANGED')
    need(bool(c['sources']) and all((n.startswith('apps/admin/src/v2/')
         or n in ('apps/admin/src/runtime/performance.ts', 'apps/admin/src/components/ui/FeatureHelp.vue')) and '..' not in Path(n).parts
         and not n.endswith('.spec.ts') and re.fullmatch('[a-f0-9]{64}', v)
         for n, v in c['sources'].items()), 'SOURCE_SCOPE_CHANGED')
    need(c['baselineAdminFiles'] and all(not n.startswith('/') and '..' not in Path(n).parts
         and re.fullmatch('[a-f0-9]{64}', v) for n, v in c['baselineAdminFiles'].items()), 'BASELINE_FILES_CHANGED')


def host_source_inventory(current, c):
    result = {}
    for name in c['sources']:
        path = current / name
        need(path.parent.resolve().is_relative_to(current) and not path.is_symlink(), 'PARENT_HOST_SOURCE_LINK')
        result[name] = sha(path.read_bytes()) if path.is_file() else None
    return result


def capture(c, d, h, diagnostics=None):
    if diagnostics is not None:
        diagnostics['stage'] = 'PARENT_CAPTURE'
    current = (P.BASE / 'current').resolve(strict=True)
    raw = (current / 'release-manifest.json').read_bytes()
    manifest = json.loads(raw)
    need(current.parent == P.BASE / 'releases' and manifest['commit'] == CURRENT
         and manifest['status'] == 'DEPLOYED', 'CURRENT_CHANGED')
    states = h.snapshot(d, current)
    need(set(states) == set(c['preservedServices']) | {'admin'}
         and all(states[n]['image'] == manifest['images'][n]['digest'] for n in ('api', 'admin')), 'PARENT_IMAGES_CHANGED')
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()
    runtime = history.runtime(d, states)
    load('shared-bank-card-release.py').read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', c['baselineAdminFiles'])
    need(shutil.disk_usage(P.BASE).free > 6 * 1024**3, 'DISK_LOW')
    names = ('.env.aws.production', 'docker-compose.aws-mysql.yml', 'compose.release.json', 'deploy/caddy/Caddyfile.aws', 'apps/api/prisma-mysql/schema.prisma')
    return {'current': str(current), 'manifestSha256': sha(raw), 'services': states,
            'runtime': runtime, 'hostSourceSha256': host_source_inventory(current, c),
            'configurationSha256': {n: sha((current / n).read_bytes()) for n in names},
            'adminConfigurationSha256': h.configuration(d, states['admin'])}


for name in ('PREFIX', 'CONTRACT_FILE', 'SCOPE', 'CURRENT', 'ADMIN_PARENT'):
    setattr(P, name, globals()[name])
P.validate_contract = validate_contract
P.capture = capture
P.host_source_inventory = host_source_inventory


def release(plan, c):
    validate_contract(c)
    P.SOURCES = tuple(c['sources'])
    return P.release(plan, c)


verify_proof = P.verify_proof
