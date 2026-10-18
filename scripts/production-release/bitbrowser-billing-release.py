"""Finite API/Admin overlay using the existing checkout switch and backup controller."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = Path('/opt/id-business-v2')
SCOPE = 'BITBROWSER_BILLING_QUOTE_REPAIR_20261018'
CURRENT = '8fef357efc8f2d94bdc5175de427db0c621e32ac'
CONTRACT_FILE = 'bitbrowser-billing-contract.json'
WORKFLOW = '.github/workflows/bitbrowser-billing-validation.yml'
SERVICES = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'online-recharge')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge')
API_SOURCES = frozenset('apps/api/src/id-business-v2/auto-recharge/' + name + '.ts' for name in (
    'bank-recharge-card.service', 'persistence/recharge-address.repository',
    'persistence/recharge.repository', 'recharge-account-restore', 'recharge-expired-checkout',
    'recharge-local.service', 'recharge-unidentified-checkout', 'recharge-validation'))
SHARED = frozenset(name + suffix for name in ('index', 'v2/auto-recharge', 'v2/checkout-diagnostic')
    for suffix in ('.js', '.d.ts'))
CONTROLS = frozenset(('bitbrowser-billing-release.py', 'bitbrowser-billing-build.py',
    'bitbrowser-billing-dispatch.py', 'bitbrowser-billing-release.test.py',
    'recharge-checkout-release.py', 'recharge-record-release.py', 'remote-deploy.py',
    'recharge-availability-release.py', 'online-query-network-release.py',
    'shared-bank-card-release.py', 'online-pending-features-release.py',
    'proxy-result-identity-release.py'))
MYSQL_FILES = frozenset('apps/api/src/id-business-v2/auto-recharge/' + name for name in (
    'recharge-billing.mysql.integration.spec.ts', 'recharge-callback-receipts.mysql.integration.spec.ts'))


def need(value, code):
    if not value:
        raise RuntimeError('BITBROWSER_BILLING_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location('bit_billing_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def valid_inventory(value, empty=False):
    return type(value) is dict and (bool(value) or empty) and all(
        isinstance(name, str) and re.fullmatch('[A-Za-z0-9_./-]+', name)
        and not name.startswith('/') and '..' not in Path(name).parts
        and isinstance(digest, str) and re.fullmatch('[a-f0-9]{64}', digest)
        for name, digest in value.items())


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
        and c.get('reviewBase') == CURRENT and re.fullmatch('[a-f0-9]{40}', c.get('sourceReviewCommit', ''))
        and c.get('migrationPerformed') is False and c.get('businessActions') == 0,
        'CONTRACT_IDENTITY_INVALID')
    sources = c.get('sources')
    need(valid_inventory(sources) and len(sources) == 64 and all(
        name.startswith(('apps/admin/src/v2/features/auto-recharge/',
            'apps/api/src/id-business-v2/auto-recharge/')) or name in (
                'apps/admin/src/v2/features/registry.ts', 'apps/admin/src/v2/features/registry.spec.ts',
                'apps/admin/src/v2/router/routes.ts', 'apps/admin/src/v2/router/routes.spec.ts',
                'packages/shared/src/index.ts', 'packages/shared/src/v2/auto-recharge.ts',
                'packages/shared/src/v2/checkout-diagnostic.ts', 'docs/V2_TASKS.md', 'docs/V2_PRODUCT_SCOPE.md',
                'scripts/acceptance-v2-auto-recharge.mjs')
        for name in sources), 'SOURCE_SCOPE_INVALID')
    need({n for n in sources if n.startswith('apps/api/') and not n.endswith('.spec.ts')} == API_SOURCES
        and set(c.get('apiModules', [])) == {n.removeprefix('apps/api/src/').removesuffix('.ts') + suffix
            for n in API_SOURCES for suffix in ('.js', '.d.ts', '.js.map')}
        and set(c.get('sharedFiles', [])) == SHARED, 'OUTPUT_SCOPE_INVALID')
    need(valid_inventory(c.get('controlPins')) and set(c['controlPins']) == CONTROLS
        and re.fullmatch('[a-f0-9]{64}', c.get('workflowSha256', ''))
        and re.fullmatch('[a-f0-9]{64}', c.get('predecessorProofSha256', ''))
        and valid_inventory(c.get('publishedAdminFiles')), 'CONTROL_SCOPE_INVALID')
    b = c.get('baseline', {})
    need(b.get('commit') == CURRENT and set(b.get('services', {})) == set(SERVICES)
        and b.get('businessActions') == 0 and b.get('databaseWrites') == 0
        and re.fullmatch('[a-f0-9]{64}', b.get('manifestSha256', ''))
        and b.get('proofs', {}).get('online-checkout-build-proof.json') == c['predecessorProofSha256']
        and set(b.get('runtimeConfigurationSha256', {})) == set(SERVICES)
        and all(s.get('status') == 'running' and (s.get('health') == 'healthy' or n == 'caddy')
            for n, s in b['services'].items()), 'BASELINE_INVALID')
    need(b.get('backupNormalizerSha256') == 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202'
        and c.get('engineHealth') == {'ready': True, 'mode': 'enabled', 'activeTasks': 0,
            'stopping': False, 'rpcConnected': True}, 'PROTECTION_SCOPE_INVALID')


def verify_mysql(value, identity, c):
    need(type(value) is dict and value.get('scope') == 'OWNED_EMPTY_DATABASE'
        and value.get('runtime') == 'github-actions-mysql-service'
        and all(value.get(k) == identity[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt'))
        and value.get('testFiles') == {n: c['sources'][n] for n in MYSQL_FILES}
        and value.get('testsTotal') == value.get('testsPassed') == 13
        and value.get('testsSkipped') == value.get('testsTodo') == value.get('productionActions') == 0
        and re.fullmatch('[a-f0-9]{64}', value.get('reportSha256', '')), 'MYSQL_EVIDENCE_INVALID')


def verify_proof(proof, plan, c, payload, h):
    validate_contract(c)
    need(all(proof.get(k) == plan.get(k) for k in ('commit', 'tree', 'workflowRunId',
        'workflowRunAttempt', 'contractSha256')) and proof.get('scope') == SCOPE
        and proof.get('sources') == c['sources'] and proof.get('controlSources') == c['controlPins']
        and proof.get('migrationPerformed') is False and proof.get('businessActions') == 0
        and proof.get('baselineRuntimeReproduced') is True and proof.get('baselineAdminReproduced') is True
        and proof.get('predecessorProofSha256') == c['predecessorProofSha256']
        and proof.get('qualityVerification') == plan.get('qualityVerification')
        and proof.get('isolatedMysqlVerification') == plan.get('isolatedMysqlVerification'), 'PROOF_INVALID')
    verify_mysql(proof.get('isolatedMysqlVerification'), plan, c)
    need(valid_inventory(proof.get('apiModules')) and set(proof['apiModules']) == set(c['apiModules'])
        and valid_inventory(proof.get('sharedFiles')) and set(proof['sharedFiles']) == SHARED
        and valid_inventory(proof.get('adminFiles')), 'PAYLOAD_SCOPE_INVALID')
    expected = {**{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
        **{'api/shared/' + n: v for n, v in proof['sharedFiles'].items()},
        **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()},
        **{'source/' + n: v for n, v in c['sources'].items()}}
    files = h.file_inventory(payload)
    files.pop('build-proof.json', None)
    need(files == proof.get('files') == expected, 'PAYLOAD_CHANGED')
    return proof


def check_hashes(d, container, expected):
    code = "const fs=require('fs'),c=require('crypto'),p=" + json.dumps(expected) + ";console.log(JSON.stringify(Object.fromEntries(Object.keys(p).map(n=>[n,fs.existsSync('/app/'+n)?c.createHash('sha256').update(fs.readFileSync('/app/'+n)).digest('hex'):null]))))"
    need(json.loads(d.run('docker', 'exec', container, 'node', '-e', code)) == expected,
        'RUNTIME_CONTENT_CHANGED')


def release(plan, c):
    validate_contract(c)
    need(c == json.loads((HERE / CONTRACT_FILE).read_bytes())
        and plan.get('contractSha256') == sha((HERE / CONTRACT_FILE).read_bytes())
        and plan.get('controlSources') == {**c['controlPins'], CONTRACT_FILE: sha((HERE / CONTRACT_FILE).read_bytes())},
        'PLAN_CONTROL_CHANGED')
    for name, digest in plan['controlSources'].items():
        need((HERE / name).is_file() and not (HERE / name).is_symlink()
            and sha((HERE / name).read_bytes()) == digest, 'EXECUTOR_CHANGED')
    p, h, d = load('recharge-checkout-release.py'), load('recharge-record-release.py'), load('remote-deploy.py')
    retired = load('online-query-network-release.py')
    p.PRESERVED, h.SERVICES = PRESERVED, SERVICES
    h.guards = lambda driver, directory, states, contract: retired.retired_guards(driver, directory, states, contract, h)
    original_build = h.build_image
    def build(driver, source, reference, role, state, stage):
        if role == 'api':
            file = source / 'Dockerfile'; raw = file.read_text()
            needle = 'COPY modules/ /app/apps/api/dist/\n'
            need(raw.count(needle) == 1, 'IMAGE_RECIPE_CHANGED')
            file.write_text(raw.replace(needle, needle + 'COPY shared/ /app/packages/shared/dist/\n'))
        return original_build(driver, source, reference, role, state, stage)
    h.build_image = build
    def baseline(driver, contract, helper, expected=None):
        b = c['baseline']; previous = (BASE / 'current').resolve()
        need(str(previous) == b['current'], 'CURRENT_CHANGED')
        raw = (previous / 'release-manifest.json').read_bytes()
        need(sha(raw) == b['manifestSha256'] and json.loads(raw)['commit'] == CURRENT, 'MANIFEST_CHANGED')
        need(sha((previous / 'online-checkout-build-proof.json').read_bytes()) == c['predecessorProofSha256'],
            'PREDECESSOR_PROOF_CHANGED')
        need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
        normalizer = Path(b['backupNormalizerPath'])
        need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink()
            and sha(normalizer.read_bytes()) == b['backupNormalizerSha256'], 'BACKUP_NORMALIZER_CHANGED')
        states = helper.snapshot(driver, previous)
        need(states == b['services'] and all(helper.configuration(driver, s) == b['runtimeConfigurationSha256'][n]
            for n, s in states.items()), 'SERVICES_CHANGED')
        need(all(sha((previous / n).read_bytes()) == v for n, v in b['configurationSha256'].items()), 'CONFIGURATION_CHANGED')
        need(driver.run('docker', 'exec', states['admin']['containerId'], 'sha256sum',
            '/etc/nginx/conf.d/default.conf').split()[0] == b['nginxSha256'], 'NGINX_CHANGED')
        check_hashes(driver, states['api']['containerId'], b['apiBaselineFiles'])
        p.verify_admin_inventory(p.admin_inventory(driver, states['admin']), b['preservedAdminInventory'])
        helper.guards(driver, previous, states, c)
        if expected is not None:
            need(p.utilities().runtime_receipt(previous, raw, states) == expected, 'BASELINE_MOVED')
        return previous, raw, states
    p.baseline = baseline
    original_smoke = p.smoke
    def smoke(driver, target, proof, states, contract, helper):
        original_smoke(driver, target, proof, states, contract, helper)
        check_hashes(driver, states['api']['containerId'], {'packages/shared/dist/' + n: v for n, v in proof['sharedFiles'].items()})
        retired.verify_retired_runtime(driver, states)
    p.smoke = smoke
    p.validate_proof = verify_proof
    p.source_projections = lambda previous, identity, contract, proof: {**previous, **{
        role: {'kind': SCOPE, 'commit': identity['commit'], 'parentProjection': previous.get(role),
            'buildProofSha256': identity['buildProofSha256'], 'sources': {n: v for n, v in c['sources'].items()
                if n.startswith(('apps/' + role + '/', 'packages/shared/'))}} for role in ('api', 'admin')}}
    legacy = {**c, **c['baseline'], 'sourceBaseline': CURRENT, 'publicFiles': c['publishedAdminFiles']}
    return p.release(plan, legacy, d, h)
