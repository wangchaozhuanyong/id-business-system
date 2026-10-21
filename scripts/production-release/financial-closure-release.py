"""Finite billing overlay using the existing locked publication engine."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = Path('/opt/id-business-v2')
SCOPE = 'FINANCIAL_BILLING_CLOSURE_20261019'
RECIPE = 'financial-billing-20261019'
CONTRACT_FILE = 'financial-closure-contract.json'
SOURCE = '7fc353223095b66408b03af0ea117230abba1a63'
CURRENT = 'cb38a1ef351b42f98ce86740b2191fd54207fa32'
PARENT_PROOF = '21ae3a28caa39c7f4c08fdb70b3e20780c4ed639d4d0bc4d11272dbd9d6d0354'
ADMIN_ROOT = 'apps/admin/src/v2/features/online-recharge/'
API_ROOT = 'apps/api/src/id-business-v2/online-recharge/'
SOURCES = frozenset([ADMIN_ROOT + n for n in ('OnlineResourceView.vue', 'OnlineResultDialog.vue',
    'V2OnlineOverviewView.vue', 'billing-presentation.ts', 'sections.ts', 'tableSchemas.ts')]
    + [API_ROOT + 'persistence/' + n for n in ('admin.repository.ts', 'billing-summary.ts')])
MODULES = frozenset('id-business-v2/online-recharge/' + n for n in (
    'admin.controller.d.ts', 'admin.service.d.ts', 'persistence/admin.repository.d.ts',
    'persistence/admin.repository.js', 'persistence/admin.repository.js.map',
    'persistence/billing-summary.d.ts', 'persistence/billing-summary.js',
    'persistence/billing-summary.js.map'))
ABSENT = frozenset(n for n in MODULES if '/billing-summary.' in n)


def need(value, code):
    if not value:
        raise RuntimeError('FINANCIAL_PUBLICATION_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('financial_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('status') == 'FROZEN' and c.get('version') == 1 and c.get('scope') == SCOPE
         and c.get('recipe') == RECIPE and c.get('sourceReviewCommit') == SOURCE
         and c.get('expectedCurrent') == CURRENT and c.get('predecessorProofSha256') == PARENT_PROOF,
         'CONTRACT_IDENTITY')
    need(set(c.get('productionSources', {})) == SOURCES
         and set(c.get('sourceParents', {})) == SOURCES
         and all(re.fullmatch('[a-f0-9]{64}', v) for v in c['productionSources'].values())
         and all(v is None or re.fullmatch('[a-f0-9]{64}', v) for v in c['sourceParents'].values()),
         'SOURCE_SCOPE')
    need(set(c.get('apiModules', [])) == MODULES
         and set(c.get('parentApiModules', {})) == MODULES - ABSENT
         and all(re.fullmatch('[a-f0-9]{64}', v) for v in c['parentApiModules'].values())
         and c.get('updatedServices') == ['api', 'admin']
         and c.get('reboundServices') == ['online-recharge']
         and c.get('preservedServices') == ['mysql', 'caddy', 'media-resolver', 'auto-recharge'],
         'OUTPUT_SCOPE')
    need(c.get('migrationPerformed') is False and c.get('businessActions') == 0
         and c.get('sqlFenceHelperSha256') == c['controlPins']['api-admin-scope.py'], 'SIDE_EFFECT_SCOPE')
    need(set(c['parentImages']) == {'api', 'admin', 'online-recharge'}
         and all(re.fullmatch('sha256:[a-f0-9]{64}', v) for v in c['parentImages'].values())
         and re.fullmatch('[a-f0-9]{64}', c['parentManifestSha256'])
         and re.fullmatch('[a-f0-9]{64}', c['parentAdminIndexSha256']), 'PARENT_IDENTITY')


def verify_mysql(value, plan, c):
    need(value == plan.get('isolatedMysqlVerification')
         and value.get('testedCommit') == c['validation']['commit']
         and value.get('runId') == c['validation']['runId']
         and value.get('testsPassed') == 53 and value.get('testsSkipped') == 0
         and value.get('testsFailed') == 0 and value.get('interfaceCasesPassed') == 112
         and re.fullmatch('[a-f0-9]{64}', value.get('mysqlReportSha256', ''))
         and re.fullmatch('[a-f0-9]{64}', value.get('interfaceReportSha256', '')),
         'ISOLATED_ACCEPTANCE_CHANGED')


def verify_proof(proof, plan, c, payload, h):
    validate_contract(c)
    need(all(proof.get(n) == plan.get(n) for n in ('commit', 'tree', 'workflowRunId',
        'workflowRunAttempt', 'contractSha256', 'qualityVerification', 'isolatedMysqlVerification',
        'nativeParentCapture')) and proof.get('scope') == SCOPE and proof.get('recipe') == RECIPE
        and proof.get('productionSources') == c['productionSources']
        and proof.get('controlSources') == c['controlPins']
        and proof.get('businessActions') == 0 and proof.get('migrationPerformed') is False,
        'PROOF_IDENTITY')
    need(set(proof.get('apiModules', {})) == MODULES
         and proof.get('parentModulesReproduced') == c['parentApiModules']
         and proof.get('baselineSharedUnchanged') is True and proof.get('baselineClientUnchanged') is True
         and proof.get('baselineAdminIndexSha256') == c['parentAdminIndexSha256']
         and proof.get('projectedInterfaceCasesPassed') == 112, 'BUILD_DELTA_CHANGED')
    need(type(proof.get('adminFiles')) is dict and len(proof['adminFiles']) >= 250
         and 'index.html' in proof['adminFiles'], 'ADMIN_OUTPUTS_CHANGED')
    verify_mysql(proof['isolatedMysqlVerification'], plan, c)
    expected = {**{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
        **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()},
        **{'source/' + n: v for n, v in c['productionSources'].items()}}
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    need(actual == proof.get('files') == expected, 'PAYLOAD_CHANGED')
    return proof


def observe(c, p):
    """Inspect native provenance and hashes; no service or database writes."""
    validate_contract(c)
    h, d, _ = p.helpers()
    current = (BASE / 'current').resolve(strict=True)
    need(current.parent == BASE / 'releases', 'CURRENT_PATH')
    raw = (current / 'release-manifest.json').read_bytes()
    manifest = json.loads(raw)
    need(manifest.get('commit') == CURRENT and manifest.get('status') == 'DEPLOYED'
         and sha(raw) == c['parentManifestSha256']
         and sha((current / 'bitbrowser-history-build-proof.json').read_bytes()) == PARENT_PROOF,
         'PUBLISHED_PARENT_CHANGED')
    states = h.snapshot(d, current)
    need(all(states[n]['image'] == v for n, v in c['parentImages'].items()), 'PARENT_IMAGE_CHANGED')
    h.guards(d, current, states, c)
    for name, expected in c['sourceParents'].items():
        path = current / name
        need(not path.is_symlink() and path.resolve().is_relative_to(current)
             and (not path.exists() if expected is None else path.is_file() and sha(path.read_bytes()) == expected),
             'HOST_PARENT_SOURCE_CHANGED')
    runtime = p.runtime(d, states)
    need(runtime['apiModules'] == c['parentApiModules'], 'PARENT_COMPILED_MODULE_CHANGED')
    index = d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum',
                  '/usr/share/nginx/html/index.html').split()[0]
    need(index == c['parentAdminIndexSha256'], 'PARENT_ADMIN_CHANGED')
    normalizer = Path(c['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink()
         and sha(normalizer.read_bytes()) == c['backupNormalizerSha256'], 'NORMALIZER_CHANGED')
    database = p.database(d, states['api'])
    need(database == c['parentDatabase'] and database['pending'] == 0, 'DATABASE_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    baseline = {'commit': CURRENT, 'current': str(current), 'manifestSha256': sha(raw),
        'services': states, 'proofs': {'bitbrowser-history-build-proof.json': PARENT_PROOF},
        'configurationSha256': {n: sha((current / n).read_bytes()) for n in p.CONFIGURATION},
        'runtimeConfigurationSha256': {n: h.configuration(d, s) for n, s in states.items()},
        **runtime, 'database': database, 'backupNormalizerPath': str(normalizer),
        'backupNormalizerSha256': sha(normalizer.read_bytes())}
    return {'status': 'FINANCIAL_NATIVE_PARENT_VERIFIED', 'baseline': baseline,
            'businessActions': 0, 'databaseWrites': 0}


def engine(c):
    # Reuse locking, exact image layers, SQL fence, verified backup, finite
    # activation, immutable asset preservation and independent readback.
    p = load('bitbrowser-history-release.py')
    p.select_recipe(p.FOLLOWUP)
    p.SCOPE, p.CURRENT, p.PREDECESSOR_PROOF = SCOPE, CURRENT, PARENT_PROOF
    p.RECIPE = p.FOLLOWUP = p.BOUNDED = RECIPE
    p.CONTRACT_FILE, p.MODULES = CONTRACT_FILE, MODULES
    p.validate_contract, p.verify_proof, p.verify_mysql = validate_contract, verify_proof, verify_mysql
    p.production_sources = lambda contract: contract['productionSources']
    p.bounded_capture = lambda driver, helper, contract, plan: observe(contract, p)

    def selected_contract(driver, helper, contract, plan):
        capture = plan.get('nativeParentCapture', {})
        need(capture.get('status') == 'FINANCIAL_NATIVE_PARENT_VERIFIED'
             and capture.get('businessActions') == capture.get('databaseWrites') == 0,
             'NATIVE_PARENT_REQUIRED')
        baseline = capture['baseline']
        need(baseline['commit'] == CURRENT and baseline['manifestSha256'] == c['parentManifestSha256']
             and baseline['apiModules'] == c['parentApiModules']
             and baseline['database'] == c['parentDatabase'], 'PARENT_CAPTURE_CHANGED')
        return {**contract, 'baseline': baseline}

    p.bounded_runtime_contract = selected_contract

    def baseline(driver, helper, contract, expected=None):
        actual = observe(contract, p)['baseline']
        need(actual == contract['baseline'], 'BASELINE_MOVED')
        current = Path(actual['current'])
        raw = (current / 'release-manifest.json').read_bytes()
        receipt = load('recharge-availability-release.py').runtime_receipt(current, raw, actual['services'])
        receipt['verifiedBaseline'] = copy.deepcopy(actual)
        # The inherited engine carries this field in its journal/readback.
        # Its seal is this authenticated native finance baseline, not a file
        # from an unrelated historical entry recipe.
        receipt['entryParentSealSha256'] = sha(canonical(actual))
        if expected is not None:
            need(receipt == expected, 'PREFLIGHT_MOVED')
        return current, raw, actual['services'], receipt

    p.baseline = baseline
    return p


def release(plan, c):
    validate_contract(c)
    return engine(c).release(plan, c)
