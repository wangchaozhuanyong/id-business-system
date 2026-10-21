"""Finite admin successor for the observed official titlebar; preserve API and history."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCOPE = 'BITBROWSER_PAGE_HEADER_20261021'
RECIPE = 'page-header-20261021'
CONTRACT_FILE = 'settled-checkout-contract.json'
CURRENT = '5275824b2400f965b3ba9604155c18d3a7bcd5e4'
SOURCE = 'b2c56b274e8aae397bd1b66dff28a85063fe801d'
SOURCE_FILE = 'apps/admin/src/v2/features/auto-recharge/bitbrowser-payment-page.ts'
TEST_FILE = SOURCE_FILE.replace('.ts', '.spec.ts')
SOURCES = frozenset((SOURCE_FILE,))
TESTS = frozenset((TEST_FILE,))
MODULES = frozenset()
UPDATED = ('admin',)
REBOUND = ()
PRESERVED = ('api', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'online-recharge')


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
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourcePullRequest') == 661,
         'CONTRACT_IDENTITY')
    need(set(c.get('productionSources', {})) == SOURCES
         and set(c.get('validationSources', {})) == TESTS
         and set(c.get('sourceParents', {})) == SOURCES
         and c.get('apiModules') == [] and c.get('updatedServices') == list(UPDATED)
         and c.get('reboundServices') == list(REBOUND)
         and c.get('preservedServices') == list(PRESERVED), 'FINITE_SCOPE')
    need(c.get('migrationPerformed') is False and c.get('businessActions') == 0
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py'], 'SIDE_EFFECT_SCOPE')
    b = c['baseline']
    need(b['commit'] == CURRENT and b['apiModules'] == {}
         and b['database']['pending'] == 0 and len(b['services']) == 7
         and set(b['proofs']) == {'bitbrowser-history-build-proof.json'}, 'PARENT_SCOPE')
    parent = c['adminParent']
    need(parent['commit'] == 'aec7c4adae25394f489337a8c883d3b6be50af7b'
         and len(parent['adminFiles']) == 263 and 'index.html' in parent['adminFiles']
         and all(re.fullmatch('[a-f0-9]{64}', v) for v in (
             parent['proofSha256'], *parent['adminFiles'].values())), 'ADMIN_PARENT_CHANGED')
    need(all(re.fullmatch('[a-f0-9]{64}', v) for v in (
        *c['productionSources'].values(), *c['validationSources'].values(),
        *c['sourceParents'].values(), *c['controlPins'].values(),
        b['manifestSha256'], *b['proofs'].values())), 'HASH_INVALID')


def verify_quality(value, commit):
    need(type(value) is dict and set(value) == {'sources', 'release'}
         and value['sources']['commit'] == SOURCE
         and value['sources']['pullRequest'] == 661
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
         and proof.get('baselineAdminReproduced') is True
         and proof.get('baselineAdminFiles') == c['adminParent']['adminFiles']
         and proof.get('apiModules') == {}
         and proof.get('businessActions') == 0 and proof.get('migrationPerformed') is False,
         'BUILD_PROOF_CHANGED')
    verify_quality(proof['qualityVerification'], proof['commit'])
    files = proof.get('adminFiles', {})
    need(len(files) >= 250 and 'index.html' in files
         and files['index.html'] != c['adminParent']['adminFiles']['index.html']
         and all(re.fullmatch('[a-f0-9]{64}', v) for v in files.values()), 'ADMIN_SCOPE')
    expected = {**{'admin/html/' + n: v for n, v in files.items()},
                **{'source/' + n: v for n, v in c['productionSources'].items()}}
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    need(actual == proof.get('files') == expected, 'PAYLOAD_CHANGED')
    return proof


def engine(c):
    validate_contract(c)
    p = load('bitbrowser-history-release.py')
    p.SCOPE, p.RECIPE, p.FOLLOWUP, p.CURRENT = SCOPE, RECIPE, RECIPE, CURRENT
    p.CONTRACT_FILE, p.MODULES = CONTRACT_FILE, MODULES
    p.ARTIFACT_LIMIT = 32 * 1024**2
    p.UPDATED, p.REBOUND, p.PRESERVED = UPDATED, REBOUND, PRESERVED
    p.validate_contract, p.verify_proof = validate_contract, verify_proof
    p.production_sources = lambda contract: contract['productionSources']
    original_helpers = p.helpers

    def helpers():
        h, d, retired = original_helpers()
        original_build = h.build_image

        def image(driver, context, reference, role, before, stage):
            need(role == 'admin', 'ADMIN_ONLY_BUILD')

            class FreshAdminBuild:
                def run(self, *args, **kwargs):
                    need(args[:2] == ('docker', 'build'), 'ADMIN_BUILD_COMMAND_CHANGED')
                    return driver.run(*args[:2], '--no-cache', *args[2:], **kwargs)

            original_build(FreshAdminBuild(), context, reference, role, before, stage)
            need(driver.run('docker', 'run', '--rm', '--network', 'none', '--user', '101:101',
                            '--entrypoint', 'sh', reference, '-c',
                            'test -r /usr/share/nginx/html/index.html && test -x /usr/share/nginx/html/assets && echo READABLE').strip() == 'READABLE',
                 'NONROOT_ADMIN_UNREADABLE')

        h.build_image = image
        return h, d, retired

    p.helpers = helpers
    # The existing lock, native baseline, fresh backup, SQL fence, immutable
    # historical assets, health checks and independent readback remain inherited.
    return p


def release(plan, c):
    return engine(c).release(plan, c)
