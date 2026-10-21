"""One-module connection successor preserving the live release; no payment or data writes."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCOPE = 'BITBROWSER_SETTLED_CONNECTION_20261021'
RECIPE = 'settled-connection-20261021'
CONTRACT_FILE = 'settled-checkout-contract.json'
CURRENT = 'be4dc7ea9da6b42fbc9f61653cb006d1242b1493'
SOURCE = '336ac9a8a983e0df3741ee118d83f9fcbacb73ba'
SOURCE_FILE = 'apps/api/src/id-business-v2/auto-recharge/recharge-account-restore.ts'
TEST_FILE = SOURCE_FILE.replace('recharge-account-restore.ts', 'recharge-unidentified-replacement.spec.ts')
SOURCES = frozenset((SOURCE_FILE,))
TESTS = frozenset((TEST_FILE,))
MODULES = frozenset('id-business-v2/auto-recharge/recharge-account-restore' + s
                    for s in ('.js', '.js.map', '.d.ts'))
UPDATED = ('api',)
REBOUND = ('online-recharge',)
PRESERVED = ('admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')


def need(value, code):
    if not value:
        raise RuntimeError('SETTLED_CHECKOUT_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('settled_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('status') == 'FROZEN' and c.get('scope') == SCOPE
         and c.get('recipe') == RECIPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourcePullRequest') == 659,
         'CONTRACT_IDENTITY')
    need(set(c.get('productionSources', {})) == SOURCES
         and set(c.get('validationSources', {})) == TESTS
         and set(c.get('sourceParents', {})) == SOURCES
         and set(c.get('apiModules', [])) == MODULES
         and c.get('updatedServices') == list(UPDATED)
         and c.get('reboundServices') == list(REBOUND)
         and c.get('preservedServices') == list(PRESERVED), 'FINITE_SCOPE')
    need(c.get('migrationPerformed') is False and c.get('businessActions') == 0
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py'], 'SIDE_EFFECT_SCOPE')
    b = c['baseline']
    need(b['commit'] == CURRENT and set(b['apiModules']) == MODULES
         and b['database']['pending'] == 0 and len(b['services']) == 7
         and set(b['proofs']) == {'bitbrowser-history-build-proof.json'}, 'PARENT_SCOPE')
    need(all(re.fullmatch('[a-f0-9]{64}', v) for v in (
        *c['productionSources'].values(), *c['validationSources'].values(),
        *c['sourceParents'].values(), *b['apiModules'].values(), *c['controlPins'].values(),
        b['manifestSha256'], *b['proofs'].values())), 'HASH_INVALID')


def verify_quality(value, commit):
    need(type(value) is dict and set(value) == {'sources', 'release'}
         and value['sources']['commit'] == SOURCE
         and value['sources']['pullRequest'] == 659
         and value['release']['commit'] == commit
         and all(re.fullmatch('[1-9][0-9]*', str(v['runId'])) for v in value.values())
         and re.fullmatch('[a-f0-9]{64}', value['sources']['sourceReceiptSha256']),
         'QUALITY_REQUIRED')


def verify_proof(proof, plan, c, payload, h):
    validate_contract(c)
    need(all(proof.get(n) == plan.get(n) for n in ('commit', 'tree', 'workflowRunId',
         'workflowRunAttempt', 'contractSha256', 'qualityVerification'))
         and proof.get('version') == 1 and proof.get('scope') == SCOPE
         and proof.get('recipe') == RECIPE and proof.get('productionSources') == c['productionSources']
         and proof.get('controlSources') == c['controlPins']
         and proof.get('parentModulesReproduced') == c['baseline']['apiModules']
         and proof.get('compiledUnselectedUnchanged') is True
         and proof.get('baselineSharedUnchanged') is True
         and proof.get('baselineClientUnchanged') is True
         and proof.get('businessActions') == 0 and proof.get('migrationPerformed') is False,
         'BUILD_PROOF_CHANGED')
    verify_quality(proof['qualityVerification'], proof['commit'])
    need(set(proof.get('apiModules', {})) == MODULES
         and proof['apiModules'][next(n for n in MODULES if n.endswith('.js'))]
         != c['baseline']['apiModules'][next(n for n in MODULES if n.endswith('.js'))], 'MODULE_SCOPE')
    expected = {**{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
                **{'source/' + n: v for n, v in c['productionSources'].items()}}
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    need(actual == proof.get('files') == expected, 'PAYLOAD_CHANGED')
    return proof


def engine(c):
    validate_contract(c)
    p = load('bitbrowser-history-release.py')
    p.SCOPE, p.RECIPE, p.CURRENT = SCOPE, RECIPE, CURRENT
    p.CONTRACT_FILE, p.MODULES = CONTRACT_FILE, MODULES
    p.UPDATED, p.REBOUND, p.PRESERVED = UPDATED, REBOUND, PRESERVED
    p.validate_contract, p.verify_proof = validate_contract, verify_proof
    p.production_sources = lambda contract: contract['productionSources']
    original_helpers = p.helpers

    def helpers():
        h, d, retired = original_helpers()
        original_build = h.build_image

        def image(driver, context, reference, role, before, stage):
            need(role == 'api', 'API_ONLY_BUILD')
            dockerfile = context / 'Dockerfile'
            text = dockerfile.read_text()
            line = 'COPY modules/ /app/apps/api/dist/'
            need(text.count(line) == 1, 'API_OVERLAY_LAYOUT')
            shutil.copytree(context / 'modules', context / 'overlay/app/apps/api/dist')
            load('recharge-availability-release.py').normalize_image_context(context / 'overlay')
            dockerfile.write_text(text.replace(line, 'COPY overlay/ /'))

            class FreshApiBuild:
                def run(self, *args, **kwargs):
                    need(args[:2] == ('docker', 'build'), 'API_BUILD_COMMAND_CHANGED')
                    return driver.run(*args[:2], '--no-cache', *args[2:], **kwargs)

            original_build(FreshApiBuild(), context, reference, role, before, stage)
            code = 'const fs=require("fs");for(const n of ' + json.dumps(sorted(MODULES)) + ')fs.readFileSync("/app/apps/api/dist/"+n);console.log("READABLE")'
            need(driver.run('docker', 'run', '--rm', '--network', 'none', '--user', '1000:1000',
                            '--entrypoint', 'node', reference, '-e', code).strip() == 'READABLE',
                 'NONROOT_API_UNREADABLE')

        h.build_image = image
        return h, d, retired

    p.helpers = helpers
    # Native baseline, locking, backup, SQL fence, finite image build, smoke,
    # service/source preservation and independent readback remain inherited.
    return p


def release(plan, c):
    return engine(c).release(plan, c)
