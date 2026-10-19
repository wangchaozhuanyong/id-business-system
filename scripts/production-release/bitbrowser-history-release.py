"""Finite API-only successor for complete, read-only checkout history pagination."""
import argparse
import copy
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = Path('/opt/id-business-v2')
SCOPE = 'BITBROWSER_HISTORY_PAGINATION_20261019'
CURRENT = 'fe27681e1ef06b14616276dff33c3febeea47579'
PREDECESSOR_PROOF = 'c2b20ec0385b85c5118a0ee20eb7ec4e4a12ce7fd6bf6c4bc338f26b991868fc'
PREDECESSOR_CONTRACT = '32128879704885ddba87f3cd356bc7736dddadeb71e27b7cc445aa9f1bb4b46a'
CONTRACT_FILE = 'bitbrowser-history-contract.json'
WORKFLOW = '.github/workflows/bitbrowser-history-validation.yml'
SERVICES = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'online-recharge')
PRESERVED = ('admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')
API_SOURCES = frozenset('apps/api/src/id-business-v2/auto-recharge/' + n + '.ts'
    for n in ('persistence/recharge.repository', 'recharge-account-restore', 'recharge-unidentified-checkout'))
TEST_SOURCES = frozenset('apps/api/src/id-business-v2/auto-recharge/' + n + '.spec.ts' for n in (
    'persistence/recharge-history.repository', 'recharge-unidentified-checkout', 'recharge-unidentified-replacement'))
APPLICATION = API_SOURCES | TEST_SOURCES
MODULES = frozenset(n.removeprefix('apps/api/src/').removesuffix('.ts') + suffix
    for n in API_SOURCES for suffix in ('.js', '.d.ts', '.js.map'))
SHARED = frozenset(n + suffix for n in ('index', 'v2/auto-recharge', 'v2/checkout-diagnostic')
    for suffix in ('.js', '.d.ts'))
MYSQL_FILES = frozenset('apps/api/src/id-business-v2/auto-recharge/' + n
    for n in ('recharge-availability.mysql.integration.spec.ts', 'recharge-direct-payment.mysql.integration.spec.ts'))
INHERITED = frozenset(('bitbrowser-recovery-build.py', 'bitbrowser-recovery-release.py',
    'bitbrowser-recovery-contract.json', 'bitbrowser-billing-build.py', 'bitbrowser-billing-release.py',
    'bitbrowser-billing-contract.json', 'online-query-network-build.py', 'online-query-network-release.py',
    'online-query-network-contract.json', 'online-session-preflight-contract.json',
    'online-pending-features-contract.json', 'recharge-record-build.py', 'recharge-record-release.py',
    'remote-deploy.py', 'recharge-availability-release.py', 'recharge-checkout-release.py',
    'proxy-result-identity-release.py', 'api-admin-scope.py'))
CONTROLS = INHERITED | frozenset('bitbrowser-history-' + n
    for n in ('build.py', 'release.py', 'dispatch.py', 'release.test.py'))
CI_CONTROLS = frozenset('scripts/ci-recharge-' + n
    for n in ('scope.mjs', 'scope.test.mjs', 'check.mjs', 'check.test.mjs'))
ENGINE = {'ready': True, 'mode': 'enabled', 'activeTasks': 0, 'stopping': False, 'rpcConnected': True}
CONFIGURATION = ('.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml')
OBSERVE_PINS = {
    'recharge-record-release.py': '4ca6d0053f5dc4368d85722ef0df272ace0947c1c91993a0a3da598507b5163f',
    'remote-deploy.py': '889aedb75bbcb53863a55dc2a4c40a84e06dea1d64d493f6a4fca6dc233f855c',
    'online-query-network-release.py': '102f47d1dfd7eded71375da1d4e78215d48f8e20e9b4c11fabe1803331f98ce0',
    'bitbrowser-recovery-contract.json': PREDECESSOR_CONTRACT}


# A closed successor recipe reuses this controller; published legacy contracts stay byte-identical.
ADDRESS = 'existing-address-field-20261019'
ADDRESS_CURRENT = '0348f0327849f1e1203e43db9b26dbbeca6dfa34'
ADDRESS_TREE = '5e20ecd367c7e669593f7824b97397d9dfac653b'
ADDRESS_PROOF = '5c11d73a4816f2429b09b337e5fb10a1d3c40fff8f1b864378b3960f4e8d017c'
ADDRESS_API_IMAGE = 'sha256:215f8b1887ff12d1b6a93d2bc9c25496c68e36102f6185e2e78bce8a21260a01'
ADDRESS_ADMIN_IMAGE = 'sha256:7f6980a4adb511ea11fbd8064118d33ea600a6c2cec52e72d15bba22a54764c5'
ENTRY_CONTRACT_SHA = 'a7b87f7d009cf223fc9d92603b34caa8aea6d5609d462efbd21c24dda4f9f850'
ENTRY = 'entry-start-20261019'
ENTRY_CURRENT = '5f122fcb841c6029b46b023f41562529b7b4bde0'
ENTRY_TREE = 'bf9d39169479a27288631731981a5aadbd180f21'
ENTRY_PROOF = '4e31536da1cfbe01ac1a85bdf5d2dd35e98b2b77b54e9a3f55e7ec9b9701026d'
ENTRY_API_IMAGE = 'sha256:1c7fac5084fca5bf1f1077383837357107b6fb951ba3b659e8fa7a562c549b7d'
FOLLOWUP_CONTRACT_SHA = 'f79066e8b1347366df4ef90243cb55498e10b10898d2be9c952dd4efbced5881'
FOLLOWUP = 'followup-20261019'
FOLLOWUP_CURRENT = '02a348a6c6b252968bc63ccb38c7d2b82e0e0c66'
FOLLOWUP_PROOF = '3736a559f737576b8fd386a34abfc49587520c2644136f9c199b1bdec1b79cc9'
LEGACY_CONTRACT_SHA = '7b0adc46b435e4e1824c6c142d1948168aa38ebc010a8e81f071abb077b0dc91'
ADMIN_BUILD = CURRENT
ADMIN_PROOF = PREDECESSOR_PROOF
ADMIN_SOURCE = 'faea152b038c7ddb1a3199070f9dc7ffb5583c36'
HISTORY_SOURCE = '3317af5de7330c57a926181dd03cded795c4c38f'
ADMIN_ROOT = 'apps/admin/src/v2/features/auto-recharge/'
FOLLOWUP_API = frozenset('apps/api/src/id-business-v2/auto-recharge/' + n + '.ts'
    for n in ('recharge-account-restore', 'recharge-unidentified-checkout'))
FOLLOWUP_ADMIN = frozenset(ADMIN_ROOT + n for n in (
    'bitbrowser-native-quote.ts', 'bitbrowser-payment-observer.ts', 'bitbrowser-direct-payment.ts'))
FOLLOWUP_TESTS = frozenset(('apps/api/src/id-business-v2/auto-recharge/recharge-unidentified-replacement.spec.ts',
    *(ADMIN_ROOT + n for n in ('bitbrowser-native-quote.spec.ts', 'bitbrowser-native-observer.spec.ts',
        'bitbrowser-direct-payment.spec.ts'))))
BOUNDED = 'bounded-hold-20261019'
BOUNDED_CURRENT = '7df16100f7964bb7183f171ec5e9f275f4f48876'
BOUNDED_TREE = 'ddd571a0921335e9a437f0e99ee5886916680545'
BOUNDED_PROOF = 'e284ca254334424c8bfeca2ca07da5df75eb0740468fcea4ddc970b7b4b83bb5'
ADDRESS_CONTRACT_SHA = '61b090c8ac0b83ce13f713a62804666c92c22304fe4ea9442b6ccc29b441803c'
BOUNDED_ADMIN_IMAGE = 'sha256:5546f18f4f37b3343f9fddc9d07cba0724dd2a4f79ba8eb7ae76cb7706575631'
BOUNDED_API_INVENTORY = {'count': 1761, 'sha256': '4d1d653397205ae7e28c4c5cd7c6e2e18ff2a8104a0827e9940d53198638c891'}
BOUNDED_APPLICATION = frozenset(('apps/admin/src/v2/features/auto-recharge/RechargePaymentReview.vue', 'apps/admin/src/v2/features/auto-recharge/RechargeResult.vue', 'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-payment.spec.ts', 'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-payment.ts', 'apps/admin/src/v2/features/auto-recharge/bitbrowser-payment-evidence.spec.ts', 'apps/admin/src/v2/features/auto-recharge/bitbrowser-payment-evidence.ts', 'apps/admin/src/v2/features/auto-recharge/recharge-availability.ts', 'apps/api/src/id-business-v2/auto-recharge/bank-recharge-card.service.ts', 'apps/api/src/id-business-v2/auto-recharge/persistence/recharge-payment-hold.repository.ts', 'apps/api/src/id-business-v2/auto-recharge/persistence/recharge.repository.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-availability.spec.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-callback-lease.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-callback-receipts.spec.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-callback-receipts.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-card-billing.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-declined-resolution.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-direct-payment.spec.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-direct-payment.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-ledger-metadata.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-noncharge-proof.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-payment-hold.spec.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-resolution.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-retired-callback.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-terminal-failure.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts', 'apps/api/src/id-business-v2/bank-card-pool/persistence/shared-bank-card.repository.ts', 'apps/api/src/id-business-v2/bank-card-pool/persistence/shared-card-capacity.ts', 'apps/api/src/id-business-v2/bank-card-pool/persistence/shared-card-hold.ts', 'apps/api/src/id-business-v2/bank-card-pool/public-api.ts', 'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.mysql.integration.spec.ts', 'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.spec.ts', 'apps/api/src/id-business-v2/bank-card-pool/shared-card-capacity.spec.ts', 'apps/api/src/id-business-v2/bank-card-pool/shared-card-management.spec.ts', 'apps/api/src/id-business-v2/bank-card-pool/shared-card-recovery.spec.ts', 'apps/api/src/id-business-v2/bank-card-pool/shared-card-settlement.spec.ts', 'apps/api/src/id-business-v2/online-recharge/persistence/worker.card-capacity.spec.ts', 'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.spec.ts', 'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts'))
BOUNDED_PRODUCTION = frozenset(('apps/admin/src/v2/features/auto-recharge/RechargePaymentReview.vue', 'apps/admin/src/v2/features/auto-recharge/RechargeResult.vue', 'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-payment.ts', 'apps/admin/src/v2/features/auto-recharge/bitbrowser-payment-evidence.ts', 'apps/admin/src/v2/features/auto-recharge/recharge-availability.ts', 'apps/api/src/id-business-v2/auto-recharge/bank-recharge-card.service.ts', 'apps/api/src/id-business-v2/auto-recharge/persistence/recharge-payment-hold.repository.ts', 'apps/api/src/id-business-v2/auto-recharge/persistence/recharge.repository.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-callback-lease.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-callback-receipts.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-card-billing.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-declined-resolution.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-direct-payment.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-ledger-metadata.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-noncharge-proof.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-resolution.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-retired-callback.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge-terminal-failure.ts', 'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts', 'apps/api/src/id-business-v2/bank-card-pool/persistence/shared-bank-card.repository.ts', 'apps/api/src/id-business-v2/bank-card-pool/persistence/shared-card-capacity.ts', 'apps/api/src/id-business-v2/bank-card-pool/persistence/shared-card-hold.ts', 'apps/api/src/id-business-v2/bank-card-pool/public-api.ts', 'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts'))
BOUNDED_MODULES = frozenset(('id-business-v2/auto-recharge/bank-recharge-card.service.d.ts', 'id-business-v2/auto-recharge/bank-recharge-card.service.js', 'id-business-v2/auto-recharge/bank-recharge-card.service.js.map', 'id-business-v2/auto-recharge/persistence/recharge-payment-hold.repository.d.ts', 'id-business-v2/auto-recharge/persistence/recharge-payment-hold.repository.js', 'id-business-v2/auto-recharge/persistence/recharge-payment-hold.repository.js.map', 'id-business-v2/auto-recharge/persistence/recharge.repository.d.ts', 'id-business-v2/auto-recharge/persistence/recharge.repository.js', 'id-business-v2/auto-recharge/persistence/recharge.repository.js.map', 'id-business-v2/auto-recharge/recharge-callback-lease.d.ts', 'id-business-v2/auto-recharge/recharge-callback-lease.js', 'id-business-v2/auto-recharge/recharge-callback-lease.js.map', 'id-business-v2/auto-recharge/recharge-callback-receipts.d.ts', 'id-business-v2/auto-recharge/recharge-callback-receipts.js', 'id-business-v2/auto-recharge/recharge-callback-receipts.js.map', 'id-business-v2/auto-recharge/recharge-card-billing.d.ts', 'id-business-v2/auto-recharge/recharge-card-billing.js', 'id-business-v2/auto-recharge/recharge-card-billing.js.map', 'id-business-v2/auto-recharge/recharge-declined-resolution.d.ts', 'id-business-v2/auto-recharge/recharge-declined-resolution.js', 'id-business-v2/auto-recharge/recharge-declined-resolution.js.map', 'id-business-v2/auto-recharge/recharge-direct-payment.d.ts', 'id-business-v2/auto-recharge/recharge-direct-payment.js', 'id-business-v2/auto-recharge/recharge-direct-payment.js.map', 'id-business-v2/auto-recharge/recharge-ledger-metadata.js', 'id-business-v2/auto-recharge/recharge-ledger-metadata.js.map', 'id-business-v2/auto-recharge/recharge-local.service.js', 'id-business-v2/auto-recharge/recharge-local.service.js.map', 'id-business-v2/auto-recharge/recharge-name.service.d.ts', 'id-business-v2/auto-recharge/recharge-noncharge-proof.d.ts', 'id-business-v2/auto-recharge/recharge-noncharge-proof.js', 'id-business-v2/auto-recharge/recharge-noncharge-proof.js.map', 'id-business-v2/auto-recharge/recharge-resolution.d.ts', 'id-business-v2/auto-recharge/recharge-resolution.js', 'id-business-v2/auto-recharge/recharge-resolution.js.map', 'id-business-v2/auto-recharge/recharge-retired-callback.js', 'id-business-v2/auto-recharge/recharge-retired-callback.js.map', 'id-business-v2/auto-recharge/recharge-terminal-failure.d.ts', 'id-business-v2/auto-recharge/recharge-terminal-failure.js', 'id-business-v2/auto-recharge/recharge-terminal-failure.js.map', 'id-business-v2/auto-recharge/recharge.service.js', 'id-business-v2/auto-recharge/recharge.service.js.map', 'id-business-v2/bank-card-pool/persistence/shared-bank-card.repository.d.ts', 'id-business-v2/bank-card-pool/persistence/shared-bank-card.repository.js', 'id-business-v2/bank-card-pool/persistence/shared-bank-card.repository.js.map', 'id-business-v2/bank-card-pool/persistence/shared-card-capacity.d.ts', 'id-business-v2/bank-card-pool/persistence/shared-card-capacity.js', 'id-business-v2/bank-card-pool/persistence/shared-card-capacity.js.map', 'id-business-v2/bank-card-pool/persistence/shared-card-hold.d.ts', 'id-business-v2/bank-card-pool/persistence/shared-card-hold.js', 'id-business-v2/bank-card-pool/persistence/shared-card-hold.js.map', 'id-business-v2/bank-card-pool/public-api.d.ts', 'id-business-v2/bank-card-pool/public-api.js', 'id-business-v2/bank-card-pool/public-api.js.map', 'id-business-v2/bank-card-pool/shared-bank-card.controller.d.ts', 'id-business-v2/online-recharge/persistence/worker.repository.js', 'id-business-v2/online-recharge/persistence/worker.repository.js.map'))
BOUNDED_ORDER_ONLY = frozenset(('id-business-v2/auto-recharge/bank-recharge-correction.service.d.ts', 'id-business-v2/auto-recharge/bank-recharge-finance.service.d.ts', 'id-business-v2/auto-recharge/bank-recharge-manual-order.d.ts', 'id-business-v2/auto-recharge/bank-recharge-online-order.service.d.ts', 'id-business-v2/auto-recharge/bank-recharge-order.service.d.ts', 'id-business-v2/auto-recharge/bank-recharge-verified-order.d.ts', 'id-business-v2/auto-recharge/bank-recharge.controller.d.ts', 'id-business-v2/auto-recharge/persistence/bank-recharge-lifecycle.repository.d.ts', 'id-business-v2/auto-recharge/persistence/bank-recharge-online-order.repository.d.ts', 'id-business-v2/auto-recharge/persistence/bank-recharge-query.repository.d.ts', 'id-business-v2/auto-recharge/persistence/bank-recharge.repository.d.ts', 'id-business-v2/auto-recharge/persistence/recharge-card-removal.repository.d.ts', 'id-business-v2/auto-recharge/recharge-bank-callback.d.ts', 'id-business-v2/data-governance/persistence/data-governance-bank-restore.d.ts', 'id-business-v2/data-governance/persistence/id-business-v2-data-governance-query.repository.d.ts'))
BOUNDED_PROPAGATED = frozenset(('id-business-v2/auto-recharge/recharge-name.service.d.ts', 'id-business-v2/bank-card-pool/shared-bank-card.controller.d.ts'))
RECIPE = 'history-20261019'
UPDATED = ('api',)
REBOUND = ('online-recharge',)
PROOF_FILE = 'recharge-checkout-build-proof.json'
BASELINE_STATUS = 'BITBROWSER_HISTORY_READONLY_BASELINE'
ARTIFACT_LIMIT = 8 * 1024**2
_LEGACY = {n: globals()[n] for n in ('SCOPE', 'CURRENT', 'PREDECESSOR_PROOF', 'CONTRACT_FILE', 'PRESERVED',
    'API_SOURCES', 'TEST_SOURCES', 'APPLICATION', 'MODULES', 'INHERITED', 'CONTROLS', 'RECIPE', 'UPDATED',
    'PROOF_FILE', 'BASELINE_STATUS', 'ARTIFACT_LIMIT', 'REBOUND', 'MYSQL_FILES')}


def select_recipe(name):
    need(name in ('history-20261019', FOLLOWUP, ENTRY, ADDRESS, BOUNDED), 'RECIPE_INVALID')
    globals().update(_LEGACY)
    if name == FOLLOWUP:
        sources = FOLLOWUP_API
        inherited = INHERITED | frozenset(('bitbrowser-history-contract.json',))
        globals().update(RECIPE=name, SCOPE='BITBROWSER_FOLLOWUP_ACCEPTANCE_20261019',
            CURRENT=FOLLOWUP_CURRENT, PREDECESSOR_PROOF=FOLLOWUP_PROOF,
            CONTRACT_FILE='bitbrowser-followup-contract.json', PRESERVED=('mysql', 'caddy', 'media-resolver', 'auto-recharge'),
            API_SOURCES=sources, TEST_SOURCES=FOLLOWUP_TESTS,
            APPLICATION=sources | FOLLOWUP_ADMIN | FOLLOWUP_TESTS,
            MODULES=frozenset(n.removeprefix('apps/api/src/').removesuffix('.ts') + ext
                for n in sources for ext in ('.js', '.d.ts', '.js.map')),
            INHERITED=inherited, CONTROLS=inherited | (_LEGACY['CONTROLS'] - _LEGACY['INHERITED']),
            UPDATED=('api', 'admin'), PROOF_FILE='bitbrowser-history-build-proof.json',
            BASELINE_STATUS='BITBROWSER_FOLLOWUP_READONLY_BASELINE', ARTIFACT_LIMIT=32 * 1024**2)
    elif name == ENTRY:
        sources = frozenset(('apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts',))
        tests = frozenset(('apps/api/src/id-business-v2/auto-recharge/recharge-unidentified-replacement.spec.ts',))
        inherited = INHERITED | frozenset(('bitbrowser-history-contract.json', 'bitbrowser-followup-contract.json'))
        globals().update(RECIPE=name, SCOPE='BITBROWSER_ENTRY_START_20261019', CURRENT=ENTRY_CURRENT,
            PREDECESSOR_PROOF=ENTRY_PROOF, CONTRACT_FILE='bitbrowser-entry-start-contract.json',
            API_SOURCES=sources, TEST_SOURCES=tests, APPLICATION=sources | tests,
            MODULES=frozenset('id-business-v2/auto-recharge/recharge-local.service' + ext
                for ext in ('.js', '.d.ts', '.js.map')),
            INHERITED=inherited, CONTROLS=inherited | (_LEGACY['CONTROLS'] - _LEGACY['INHERITED']),
            PROOF_FILE='bitbrowser-history-build-proof.json', BASELINE_STATUS='BITBROWSER_ENTRY_START_READONLY_BASELINE')
    elif name == ADDRESS:
        sources = frozenset((ADMIN_ROOT + 'bitbrowser-payment-form.ts',))
        tests = frozenset((ADMIN_ROOT + 'bitbrowser-payment-form.spec.ts',))
        inherited = INHERITED | frozenset(('bitbrowser-history-contract.json', 'bitbrowser-followup-contract.json', 'bitbrowser-entry-start-contract.json'))
        globals().update(RECIPE=name, SCOPE='BITBROWSER_EXISTING_ADDRESS_FIELD_20261019', CURRENT=ADDRESS_CURRENT,
            PREDECESSOR_PROOF=ADDRESS_PROOF, CONTRACT_FILE='bitbrowser-existing-address-contract.json',
            API_SOURCES=frozenset(), TEST_SOURCES=tests, APPLICATION=sources | tests, MODULES=frozenset(),
            INHERITED=inherited, CONTROLS=inherited | (_LEGACY['CONTROLS'] - _LEGACY['INHERITED']),
            UPDATED=('admin',), REBOUND=(), PRESERVED=('api', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'online-recharge'),
            PROOF_FILE='bitbrowser-history-build-proof.json', BASELINE_STATUS='BITBROWSER_EXISTING_ADDRESS_READONLY_BASELINE',
            ARTIFACT_LIMIT=32 * 1024**2)
    elif name == BOUNDED:
        inherited = INHERITED | frozenset(('bitbrowser-history-contract.json', 'bitbrowser-followup-contract.json',
            'bitbrowser-entry-start-contract.json', 'bitbrowser-existing-address-contract.json'))
        globals().update(RECIPE=name, SCOPE='BITBROWSER_BOUNDED_HOLD_20261019', CURRENT=BOUNDED_CURRENT,
            PREDECESSOR_PROOF=BOUNDED_PROOF, CONTRACT_FILE='bitbrowser-bounded-hold-contract.json',
            API_SOURCES=frozenset(n for n in BOUNDED_PRODUCTION if n.startswith('apps/api/')),
            TEST_SOURCES=BOUNDED_APPLICATION - BOUNDED_PRODUCTION, APPLICATION=BOUNDED_APPLICATION,
            MODULES=BOUNDED_MODULES, INHERITED=inherited,
            CONTROLS=inherited | (_LEGACY['CONTROLS'] - _LEGACY['INHERITED']),
            UPDATED=('api', 'admin'), REBOUND=('online-recharge',), PRESERVED=('mysql', 'caddy', 'media-resolver', 'auto-recharge'),
            MYSQL_FILES=_LEGACY['MYSQL_FILES'] | frozenset(('apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.mysql.integration.spec.ts',)),
            PROOF_FILE='bitbrowser-history-build-proof.json', BASELINE_STATUS='BITBROWSER_BOUNDED_HOLD_READONLY_BASELINE',
            ARTIFACT_LIMIT=32 * 1024**2)
    return name


def need(value, code):
    if not value:
        raise RuntimeError('BITBROWSER_HISTORY_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('history_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inventory(value):
    return type(value) is dict and bool(value) and all(isinstance(n, str)
        and re.fullmatch('[A-Za-z0-9_./-]+', n) and not n.startswith('/') and '..' not in Path(n).parts
        and isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for n, v in value.items())


def summary(value):
    return type(value) is dict and set(value) == {'count', 'sha256'} and type(value['count']) is int \
        and value['count'] > 0 and isinstance(value['sha256'], str) and re.fullmatch('[a-f0-9]{64}', value['sha256'])


def validate_contract(c):
    need(type(c) is dict and c.get('version') == 1 and c.get('status') == 'FROZEN'
        and c.get('scope') == SCOPE and c.get('recipe', 'history-20261019') == RECIPE and c.get('expectedCurrent') == c.get('reviewBase') == CURRENT
        and re.fullmatch('[a-f0-9]{40}', c.get('sourceReviewCommit', ''))
        and c.get('migrationPerformed') is False and type(c.get('businessActions')) is int
        and c['businessActions'] == 0, 'CONTRACT_IDENTITY_INVALID')
    need(inventory(c.get('sources')) and set(c['sources']) == APPLICATION
        and set(c.get('apiModules', [])) == MODULES and c.get('updatedServices') == list(UPDATED)
        and c.get('reboundServices') == list(REBOUND) and c.get('preservedServices') == list(PRESERVED),
        'SOURCE_SCOPE_INVALID')
    if RECIPE == BOUNDED:
        validate_bounded_contract(c)
        return
    need(inventory(c.get('publishedApiModules')) and len(c['publishedApiModules']) == 40
        and MODULES <= set(c['publishedApiModules']) and inventory(c.get('publishedSharedFiles'))
        and set(c['publishedSharedFiles']) == SHARED, 'PREDECESSOR_OUTPUT_INVALID')
    need(inventory(c.get('controlPins')) and set(c['controlPins']) == CONTROLS
        and c['controlPins']['bitbrowser-recovery-contract.json'] == PREDECESSOR_CONTRACT
        and inventory(c.get('ciControlPins')) and set(c['ciControlPins']) == CI_CONTROLS
        and inventory(c.get('mysqlTestSources')) and set(c['mysqlTestSources']) == MYSQL_FILES
        and c.get('predecessorProofSha256') == PREDECESSOR_PROOF
        and re.fullmatch('[a-f0-9]{64}', c.get('workflowSha256', ''))
        and re.fullmatch('[a-f0-9]{64}', c.get('qualityWorkflowSha256', ''))
        and c.get('sqlFenceHelperSha256') == c['controlPins']['api-admin-scope.py'], 'CONTROL_SCOPE_INVALID')
    b = c.get('baseline', {})
    if RECIPE == ADDRESS:
        need(re.fullmatch('[a-f0-9]{40}', c.get('sourceReviewTree', '')) and b.get('commit') == CURRENT and b.get('apiModules') == {}
            and c.get('parentNative') == {'commit': ADDRESS_CURRENT, 'tree': ADDRESS_TREE, 'proofSha256': ADDRESS_PROOF,
                'contractSha256': ENTRY_CONTRACT_SHA, 'workflowRunId': '39202298576', 'apiImage': ADDRESS_API_IMAGE,
                'adminImage': ADDRESS_ADMIN_IMAGE}
            and c['controlPins'].get('bitbrowser-entry-start-contract.json') == ENTRY_CONTRACT_SHA
            and c['controlPins'].get('bitbrowser-followup-contract.json') == FOLLOWUP_CONTRACT_SHA
            and c['controlPins'].get('bitbrowser-history-contract.json') == LEGACY_CONTRACT_SHA
            and inventory(c.get('publishedAdminFiles')) and len(c['publishedAdminFiles']) == 261
            and c.get('adminNativeProofSha256') == ENTRY_PROOF and c.get('engineHealth') == ENGINE
            and inventory(c.get('mysqlInheritance', {}).get('inputs'))
            and c.get('mysqlInheritance', {}).get('parentProofSha256') == ADDRESS_PROOF
            and c.get('parentVerifiedBaseline', {}).get('commit') == ENTRY_CURRENT
            and re.fullmatch('[a-f0-9]{64}', c.get('parentVerifiedSealSha256', '')), 'ADDRESS_PROVENANCE_INVALID')
        verify_mysql(c['mysqlInheritance'].get('evidence'), {}, c)
        return
    if RECIPE == ENTRY:
        need(re.fullmatch('[a-f0-9]{40}', c.get('sourceReviewTree', ''))
            and b.get('commit') == CURRENT and b.get('apiModules') == {n: c['publishedApiModules'][n] for n in MODULES}
            and c.get('parentNative') == {'commit': ENTRY_CURRENT, 'tree': ENTRY_TREE,
                'proofSha256': ENTRY_PROOF, 'contractSha256': FOLLOWUP_CONTRACT_SHA,
                'workflowRunId': '39199575083', 'apiImage': ENTRY_API_IMAGE}
            and c['controlPins'].get('bitbrowser-history-contract.json') == LEGACY_CONTRACT_SHA
            and c['controlPins'].get('bitbrowser-followup-contract.json') == FOLLOWUP_CONTRACT_SHA
            and c.get('engineHealth') == ENGINE, 'ENTRY_PROVENANCE_INVALID')
        return
    need(b.get('commit') == CURRENT and b.get('status') == BASELINE_STATUS
        and type(b.get('businessActions')) is int and type(b.get('databaseWrites')) is int
        and b['businessActions'] == b['databaseWrites'] == 0
        and re.fullmatch('[a-f0-9]{64}', b.get('manifestSha256', ''))
        and Path(b.get('current', '')).parent == BASE / 'releases'
        and set(b.get('services', {})) == set(SERVICES)
        and all(s.get('status') == 'running' and (s.get('health') == 'healthy' or n == 'caddy')
            for n, s in b['services'].items())
        and inventory(b.get('runtimeConfigurationSha256')) and set(b['runtimeConfigurationSha256']) == set(SERVICES)
        and inventory(b.get('configurationSha256')) and set(b['configurationSha256']) == set(CONFIGURATION)
        and b.get('proofs', {}).get(PROOF_FILE) == PREDECESSOR_PROOF
        and inventory(b.get('apiModules')) and set(b['apiModules']) == MODULES
        and all(b['apiModules'][n] == c['publishedApiModules'][n] for n in MODULES)
        and all(summary(b.get(n)) for n in ('apiPreservedInventory', 'sharedInventory', 'clientInventory', 'adminInventory'))
        and b.get('database', {}).get('pending') == 0
        and inventory({n: b.get('database', {}).get(n) for n in ('ledger', 'columns')})
        and re.fullmatch('[a-f0-9]{64}', b.get('nginxSha256', ''))
        and b.get('backupNormalizerSha256') == 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202'
        and c.get('engineHealth') == ENGINE, 'BASELINE_INVALID')
    if RECIPE == FOLLOWUP:
        need(c.get('sourceReviewTree') and re.fullmatch('[a-f0-9]{40}', c['sourceReviewTree'])
            and c.get('adminBuildCommit') == ADMIN_BUILD and c.get('adminProofSha256') == ADMIN_PROOF
            and inventory(c.get('publishedAdminFiles')) and len(c['publishedAdminFiles']) == 261
            and c['controlPins'].get('bitbrowser-history-contract.json') == LEGACY_CONTRACT_SHA
            and b['proofs'].get('recharge-checkout-build-proof.json') == ADMIN_PROOF
            and b['services']['api']['image'] == 'sha256:e25b51ac8bb4c7ab0932a19f63a497d221f12e893a07cf05096085de5de822ef'
            and b['services']['admin']['image'] == 'sha256:611cca5fc6fcdbb60d77217b38069ce80027e37a0b31cba3be9ad3d6ab7fb01a',
            'FOLLOWUP_PROVENANCE_INVALID')



def production_sources(c):
    return {n: v for n, v in c['sources'].items() if RECIPE != BOUNDED or n in BOUNDED_PRODUCTION}


def validate_bounded_contract(c):
    allowed = {n.removeprefix('apps/api/src/').removesuffix('.ts') + suffix
        for n in API_SOURCES for suffix in ('.js', '.d.ts', '.js.map')} | BOUNDED_PROPAGATED
    need(c.get('sourceReviewCommit') == '04a284c1d038b2eadd6aef933c6cc26a5bfa6935'
        and c.get('sourceReviewTree') == '772404ac612f0c5a585efedefef3055ec686a7d9'
        and inventory(c.get('sourceReviewControls')) and set(c['sourceReviewControls']) == CI_CONTROLS
        and c.get('productionSources') == production_sources(c) and len(c['productionSources']) == 25
        and MODULES <= allowed and BOUNDED_PROPAGATED <= MODULES and not MODULES & BOUNDED_ORDER_ONLY,
        'BOUNDED_SOURCE_REVIEW_INVALID')
    need(inventory(c.get('controlPins')) and set(c['controlPins']) == CONTROLS
        and inventory(c.get('ciControlPins')) and set(c['ciControlPins']) == CI_CONTROLS
        and inventory(c.get('mysqlTestSources')) and set(c['mysqlTestSources']) == MYSQL_FILES
        and c.get('mysqlExpectedCounts') == [10, 8, 13]
        and c.get('sharedMysqlDatabase') == 'id_business_v2_shared_bank_fixture'
        and c.get('predecessorProofSha256') == BOUNDED_PROOF
        and c.get('sqlFenceHelperSha256') == c['controlPins']['api-admin-scope.py']
        and all(re.fullmatch('[a-f0-9]{64}', c.get(n, '')) for n in ('workflowSha256', 'qualityWorkflowSha256')),
        'BOUNDED_CONTROL_SCOPE_INVALID')
    old_contracts = {'bitbrowser-recovery-contract.json': PREDECESSOR_CONTRACT,
        'bitbrowser-history-contract.json': LEGACY_CONTRACT_SHA, 'bitbrowser-followup-contract.json': FOLLOWUP_CONTRACT_SHA,
        'bitbrowser-entry-start-contract.json': ENTRY_CONTRACT_SHA, 'bitbrowser-existing-address-contract.json': ADDRESS_CONTRACT_SHA}
    need(all(c['controlPins'].get(n) == digest for n, digest in old_contracts.items())
        and c.get('parentNative') == {'commit': BOUNDED_CURRENT, 'tree': BOUNDED_TREE,
            'proofSha256': BOUNDED_PROOF, 'contractSha256': ADDRESS_CONTRACT_SHA, 'workflowRunId': '39204594382',
            'apiImage': ADDRESS_API_IMAGE, 'adminImage': BOUNDED_ADMIN_IMAGE}
        and c.get('parentApiInventory') == BOUNDED_API_INVENTORY
        and c.get('engineHealth') == ENGINE and inventory(c.get('publishedAdminFiles'))
        and len(c['publishedAdminFiles']) == 261 and inventory(c.get('publishedApiModules'))
        and len(c['publishedApiModules']) == 40 and inventory(c.get('publishedSharedFiles'))
        and set(c['publishedSharedFiles']) == SHARED, 'BOUNDED_PROVENANCE_INVALID')
    baseline = c.get('baseline', {})
    need(baseline.get('commit') == CURRENT and inventory(baseline.get('apiModules'))
        and isinstance(c.get('absentApiModules'), list) and len(set(c['absentApiModules'])) == len(c['absentApiModules'])
        and set(baseline['apiModules']).isdisjoint(c['absentApiModules'])
        and set(baseline['apiModules']) | set(c['absentApiModules']) == MODULES
        and c.get('parentVerifiedBaseline', {}).get('commit') == ADDRESS_CURRENT
        and re.fullmatch('[a-f0-9]{64}', c.get('parentVerifiedSealSha256', '')),
        'BOUNDED_BASELINE_INVALID')
    rules = c.get('declarationOrderOnly', {})
    need(set(rules) == BOUNDED_ORDER_ONLY and all(type(rule) is dict and set(rule) == {'before', 'after'}
        and inventory({'before': rule['before'], 'after': rule['after']}) and rule['before'] != rule['after']
        for rule in rules.values()), 'BOUNDED_DECLARATION_RULE_INVALID')


def verify_bounded_capture(value, identity, c):
    need(type(value) is dict and value.get('status') == 'BITBROWSER_BOUNDED_PARENT_CAPTURED'
        and all(value.get(n) == identity[n] for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt'))
        and value.get('parentNative') == c['parentNative'] and value.get('apiInventory') == BOUNDED_API_INVENTORY
        and value.get('apiModules') == c['baseline']['apiModules'] and value.get('absentApiModules') == c['absentApiModules']
        and re.fullmatch('[a-f0-9]{64}', value.get('sealSha256', ''))
        and value.get('databaseWrites') == value.get('businessActions') == 0, 'BOUNDED_NATIVE_CAPTURE_INVALID')


def bounded_parent(d, h, c):
    parent = (BASE / 'current').resolve(strict=True)
    need(parent.parent == BASE / 'releases', 'BOUNDED_PARENT_PATH_CHANGED')
    raws = {n: (parent / n).read_bytes() for n in ('release-manifest.json',
        'bitbrowser-history-build-proof.json', 'bitbrowser-history-preservation.json')}
    need(sha(raws['bitbrowser-history-build-proof.json']) == BOUNDED_PROOF, 'BOUNDED_PARENT_PROOF_CHANGED')
    manifest, proof, preservation = (json.loads(raws[n]) for n in ('release-manifest.json',
        'bitbrowser-history-build-proof.json', 'bitbrowser-history-preservation.json'))
    old = json.loads((HERE / 'bitbrowser-existing-address-contract.json').read_bytes())
    before = c['parentVerifiedBaseline']
    origin = Path(before['current']).resolve(strict=True)
    need(origin.parent == BASE / 'releases' and str(origin) == before['current'], 'BOUNDED_PARENT_ORIGIN_CHANGED')
    old_raw = (origin / 'release-manifest.json').read_bytes()
    need(sha(old_raw) == before['manifestSha256'], 'BOUNDED_PARENT_ORIGIN_CHANGED')
    old_manifest = json.loads(old_raw)
    need(manifest.get('commit') == proof.get('commit') == preservation.get('commit') == CURRENT
        and manifest.get('sourceTree') == proof.get('tree') == preservation.get('tree') == BOUNDED_TREE
        and manifest.get('scope') == proof.get('scope') == 'BITBROWSER_EXISTING_ADDRESS_FIELD_20261019'
        and manifest.get('status') == 'DEPLOYED' and proof.get('recipe') == ADDRESS
        and proof.get('contractSha256') == ADDRESS_CONTRACT_SHA
        and proof.get('workflowRunId') == preservation.get('workflowRunId') == '39204594382'
        and proof.get('sources') == old['sources'] and proof.get('controlSources') == old['controlPins']
        and proof.get('isolatedMysqlVerification') == old['mysqlInheritance']['evidence']
        and proof.get('updatedServices') == ['admin'] and proof.get('apiModules') == {}
        and proof.get('businessActions') == preservation.get('businessActions') == 0
        and proof.get('migrationPerformed') is preservation.get('migrationPerformed') is False
        and manifest.get('bitbrowserHistoryPublication') == preservation
        and preservation.get('verifiedParentBaseline') == before
        and preservation.get('entryParentSealSha256') == c['parentVerifiedSealSha256']
        and manifest.get('previousCommit') == ADDRESS_CURRENT and manifest.get('previousRelease') == str(origin)
        and manifest.get('previousManifestSha256') == before['manifestSha256'], 'BOUNDED_PARENT_IDENTITY_CHANGED')
    need(preservation.get('before') == before['services'] and set(preservation.get('after', {})) == set(SERVICES)
        and set(preservation.get('images', {})) == {'admin'}
        and all(preservation['before'][n] == preservation['after'][n] for n in SERVICES if n != 'admin')
        and preservation['after']['api']['image'] == ADDRESS_API_IMAGE
        and preservation['after']['admin']['image'] == preservation['images']['admin']['imageId'] == BOUNDED_ADMIN_IMAGE
        and preservation.get('image') == preservation['images']['admin']
        and all(manifest['images'][n] == old_manifest['images'][n] for n in old_manifest['images'] if n != 'admin')
        and manifest['images']['admin'] == {'digest': BOUNDED_ADMIN_IMAGE,
            'reference': preservation['images']['admin']['reference'], 'sourceCommit': CURRENT}
        and manifest['roleSourceProjections']['api'] == old_manifest['roleSourceProjections']['api']
        and manifest.get('apiCompiledArtifact') == old_manifest.get('apiCompiledArtifact'), 'BOUNDED_PARENT_SERVICES_CHANGED')
    projection = manifest['roleSourceProjections']['admin']
    need(projection.get('commit') == CURRENT and projection.get('kind') == manifest['scope']
        and projection.get('buildProofSha256') == BOUNDED_PROOF and projection.get('sources') == old['sources']
        and projection.get('parentProjection') == old_manifest['roleSourceProjections']['admin']
        and manifest.get('adminSourceProjection') == projection and proof.get('adminFiles') == c['publishedAdminFiles'],
        'BOUNDED_PARENT_PROJECTION_CHANGED')
    states = h.snapshot(d, parent)
    need(states == preservation['after'], 'BOUNDED_PARENT_RUNTIME_MOVED')
    configs = {n: sha((parent / n).read_bytes()) for n in CONFIGURATION}
    selected = json.loads((parent / 'compose.release.json').read_bytes())
    original = json.loads((origin / 'compose.release.json').read_bytes())
    need(sha((origin / 'compose.release.json').read_bytes()) == before['configurationSha256']['compose.release.json']
        and selected['services']['admin']['image'] == preservation['images']['admin']['reference'], 'BOUNDED_PARENT_COMPOSE_CHANGED')
    selected['services']['admin']['image'] = original['services']['admin']['image']
    need(selected == original and all(configs[n] == before['configurationSha256'][n] for n in CONFIGURATION if n != 'compose.release.json')
        and {n: h.configuration(d, state) for n, state in states.items()} == before['runtimeConfigurationSha256']
        and database(d, states['api']) == before['database'], 'BOUNDED_PARENT_CONFIGURATION_CHANGED')
    admin_files = load('recharge-checkout-release.py').admin_inventory(d, states['admin'])
    verify_admin_merge(preservation['beforeAdminFiles'], proof['adminFiles'], admin_files, before['adminInventory'])
    # Complete inventory stays within this server process; no source or business data leaves production.
    code = r"const fs=require('fs'),path=require('path'),c=require('crypto'),o={};function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isSymbolicLink())throw Error('LINK');if(e.isDirectory())walk(p);else if(e.isFile())o[path.relative('/app/apps/api/dist',p)]=c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');else throw Error('KIND');}}walk('/app/apps/api/dist');console.log(JSON.stringify(o));"
    files = json.loads(d.run('docker', 'exec', states['api']['containerId'], 'node', '-e', code, timeout=90))
    picked = bounded_api_selection(files, MODULES, c['absentApiModules'], BOUNDED_API_INVENTORY)
    verify_bounded_declarations_native(files, c)
    need(picked['apiModules'] == c['baseline']['apiModules'], 'BOUNDED_COMPILED_BEFORE_NATIVE_MISMATCH')
    observed = runtime(d, states)
    need(observed['apiModules'] == picked['apiModules'] and all(observed[n] == before[n]
        for n in ('sharedInventory', 'clientInventory', 'nginxSha256')), 'BOUNDED_PARENT_CONTENT_CHANGED')
    baseline = {'status': BASELINE_STATUS, 'commit': CURRENT, 'current': str(parent),
        'manifestSha256': sha(raws['release-manifest.json']), 'services': states,
        'configurationSha256': configs, 'runtimeConfigurationSha256': before['runtimeConfigurationSha256'],
        'proofs': {n: sha(raws[n]) for n in raws if n != 'release-manifest.json'}, **observed,
        'database': before['database'], 'backupNormalizerPath': before['backupNormalizerPath'],
        'backupNormalizerSha256': before['backupNormalizerSha256'], 'businessActions': 0, 'databaseWrites': 0}
    h.guards(d, parent, states, c)
    return baseline, files


def verify_bounded_declarations_native(files, c):
    need(all(files.get(name) == rule['before'] for name, rule in c['declarationOrderOnly'].items()),
        'BOUNDED_DECLARATION_NATIVE_BEFORE_CHANGED')


def bounded_capture(d, h, c, plan):
    baseline, files = bounded_parent(d, h, c)
    seal = HERE / 'entry-parent-baseline.json'
    complete = HERE / 'bounded-parent-inventory.json'
    need(not seal.exists() and not complete.exists(), 'BOUNDED_PARENT_ALREADY_CAPTURED')
    # Immutable staging evidence only. No production files, SQL rows or lease are changed.
    for path, value in ((complete, files), (seal, entry_seal_record(plan, baseline))):
        with path.open('xb') as output:
            output.write(canonical(value)); output.flush(); os.fsync(output.fileno())
    value = {**{n: plan[n] for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt')},
        'status': 'BITBROWSER_BOUNDED_PARENT_CAPTURED', 'parentNative': c['parentNative'],
        'apiInventory': BOUNDED_API_INVENTORY, 'apiModules': baseline['apiModules'],
        'absentApiModules': c['absentApiModules'], 'sealSha256': sha(seal.read_bytes()),
        'databaseWrites': 0, 'businessActions': 0}
    verify_bounded_capture(value, plan, c)
    return value


def bounded_runtime_contract(d, h, c, plan):
    seal_raw = (HERE / 'entry-parent-baseline.json').read_bytes()
    seal = json.loads(seal_raw)
    baseline = seal['baseline']
    verify_entry_seal(plan, baseline, seal_raw)
    files = json.loads((HERE / 'bounded-parent-inventory.json').read_bytes())
    bounded_api_selection(files, MODULES, c['absentApiModules'], BOUNDED_API_INVENTORY)
    need(baseline['apiModules'] == c['baseline']['apiModules'] and baseline['commit'] == CURRENT,
        'BOUNDED_PARENT_SEAL_CHANGED')
    capture = plan.get('nativeParentCapture')
    verify_bounded_capture(capture, plan, c)
    need(capture['sealSha256'] == sha(seal_raw), 'BOUNDED_PARENT_SEAL_CHANGED')
    if plan['mode'] != 'readback':
        actual, actual_files = bounded_parent(d, h, c)
        need(actual == baseline and actual_files == files, 'BOUNDED_PARENT_MOVED')
    if plan.get('runtimeBaseline'):
        need(plan['runtimeBaseline'].get('entryParentSealSha256') == sha(seal_raw)
            and plan['runtimeBaseline'].get('verifiedBaseline') == baseline, 'BOUNDED_PARENT_SEAL_CHANGED')
    return {**c, 'baseline': baseline}


def verify_mysql(value, identity, c):
    if RECIPE == ADDRESS:
        inherited = c['mysqlInheritance']
        need(value == inherited['evidence'] and inherited['parentProofSha256'] == ADDRESS_PROOF, 'MYSQL_INHERITANCE_INVALID')
        identity = {'commit': ADDRESS_CURRENT, 'tree': ADDRESS_TREE, 'workflowRunId': '39202298576', 'workflowRunAttempt': '1'}
    need(type(value) is dict and value.get('scope') == 'OWNED_EMPTY_DATABASE'
        and value.get('runtime') == 'github-actions-mysql-service'
        and all(value.get(n) == identity[n] for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt'))
        and value.get('testFiles') == c['mysqlTestSources']
        and all(type(value.get(n)) is int for n in ('testsTotal', 'testsPassed', 'testsSkipped', 'testsTodo', 'productionActions'))
        and value['testsTotal'] == value['testsPassed'] == (31 if RECIPE == BOUNDED else 18)
        and value['testsSkipped'] == value['testsTodo'] == value['productionActions'] == 0
        and re.fullmatch('[a-f0-9]{64}', value.get('reportSha256', '')), 'MYSQL_EVIDENCE_INVALID')


def verify_proof(proof, plan, c, payload, h):
    validate_contract(c)
    need(all(proof.get(n) == plan.get(n) for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
        'contractSha256', 'qualityVerification', 'isolatedMysqlVerification'))
        and proof.get('version') == 1 and proof.get('scope') == SCOPE and proof.get('sources') == c['sources']
        and proof.get('controlSources') == c['controlPins'] and proof.get('baselineModulesReproduced') == c['baseline']['apiModules']
        and proof.get('predecessorProofSha256') == PREDECESSOR_PROOF
        and proof.get('baselineSharedUnchanged') is True and proof.get('migrationPerformed') is False
        and proof.get('businessActions') == 0 and proof.get('updatedServices') == list(UPDATED)
        and (RECIPE not in (ENTRY, BOUNDED) or proof.get('recipe') == RECIPE)
        and (inventory(proof.get('apiModules')) if MODULES else proof.get('apiModules') == {}) and set(proof['apiModules']) == MODULES, 'PROOF_INVALID')
    verify_mysql(proof.get('isolatedMysqlVerification'), plan, c)
    if RECIPE == BOUNDED:
        verify_bounded_capture(proof.get('nativeParentCapture'), plan, c)
        need(proof.get('nativeParentCapture') == plan.get('nativeParentCapture')
            and proof.get('productionSources') == production_sources(c), 'BOUNDED_PRODUCTION_CHANGED')
    expected = {**{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
        **{'source/' + n: v for n, v in production_sources(c).items()}}
    if RECIPE in (FOLLOWUP, ADDRESS, BOUNDED):
        need(proof.get('recipe') == RECIPE and proof.get('baselineAdminReproduced') is True
            and proof.get('baselineAdminFiles') == c['publishedAdminFiles'] and inventory(proof.get('adminFiles'))
            and len(proof['adminFiles']) >= 250 and 'index.html' in proof['adminFiles'],
            'ADMIN_BUILD_PROOF_INVALID')
        expected.update({'admin/html/' + n: v for n, v in proof['adminFiles'].items()})
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    need(actual == proof.get('files') == expected, 'PAYLOAD_CHANGED')
    return proof


def helpers():
    h, d = load('recharge-record-release.py'), load('remote-deploy.py')
    h.SERVICES = SERVICES
    retired = load('online-query-network-release.py')
    h.guards = lambda driver, directory, states, c: retired.retired_guards(driver, directory, states, c, h)
    return h, d, retired


def runtime(d, states, modules=None):
    # Only file names, counts and SHA256 values leave the containers.
    code = "const excluded=" + json.dumps(sorted(MODULES if modules is None else modules)) + ";" + r"""
const fs=require('fs'),path=require('path'),crypto=require('crypto');const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function inv(root,except=[]){const out={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name),n=path.relative(root,p);if(e.isSymbolicLink())throw Error('LINK');if(e.isDirectory())walk(p);else if(e.isFile()&&!except.includes(n))out[n]=hash(fs.readFileSync(p));else if(!e.isFile())throw Error('KIND');}}walk(root);const sorted=Object.fromEntries(Object.entries(out).sort(([a],[b])=>a<b?-1:a>b?1:0));return{count:Object.keys(sorted).length,sha256:hash(JSON.stringify(sorted))};}
console.log(JSON.stringify({apiModules:Object.fromEntries(excluded.filter(n=>ALLOW_MISSING?fs.existsSync('/app/apps/api/dist/'+n):true).map(n=>[n,hash(fs.readFileSync('/app/apps/api/dist/'+n))])),apiPreservedInventory:inv('/app/apps/api/dist',excluded),sharedInventory:inv('/app/packages/shared/dist'),clientInventory:inv('/app/node_modules/.prisma/client')}));
"""
    code = 'const ALLOW_MISSING=' + ('true' if RECIPE == BOUNDED else 'false') + ';' + code
    result = json.loads(d.run('docker', 'exec', states['api']['containerId'], 'node', '-e', code, timeout=90))
    rows = {}
    for line in d.run('docker', 'exec', states['admin']['containerId'], 'sh', '-c',
        'cd /usr/share/nginx/html && test -z "$(find . -type l -print -quit)" && find . -type f -exec sha256sum {} +', timeout=90).splitlines():
        digest, name = line.split('  ', 1)
        need(name.startswith('./') and re.fullmatch('[a-f0-9]{64}', digest) and name not in rows, 'ADMIN_INVENTORY_INVALID')
        rows[name.removeprefix('./')] = digest
    result['adminInventory'] = {'count': len(rows), 'sha256': sha(canonical(rows))}
    result['nginxSha256'] = d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum',
        '/etc/nginx/conf.d/default.conf').split()[0]
    return result


def database(d, state):
    code = r"""const{PrismaClient}=require('@prisma/client'),c=require('crypto');const p=new PrismaClient({log:[]});
(async()=>{const rows=await p.$queryRawUnsafe('SELECT migration_name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name');const pending=await p.$queryRawUnsafe('SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL');const cols=await p.$queryRawUnsafe('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');const hash=v=>c.createHash('sha256').update(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x)).digest('hex');console.log(JSON.stringify({ledger:hash(rows),columns:hash(cols),pending:Number(pending[0].n)}));})().catch(()=>process.exitCode=1).finally(()=>p.$disconnect());"""
    return json.loads(d.run('docker', 'exec', state['containerId'], 'node', '-e', code, timeout=60))


def observe():
    """Explicit read-only server entry; no credentials, business rows, files or state are changed."""
    need(all((HERE / n).is_file() and not (HERE / n).is_symlink()
        and sha((HERE / n).read_bytes()) == v for n, v in OBSERVE_PINS.items()), 'OBSERVER_HELPER_CHANGED')
    h, d, retired = helpers()
    current = (BASE / 'current').resolve(strict=True)
    need(current.parent == BASE / 'releases', 'CURRENT_PATH_INVALID')
    raw = (current / 'release-manifest.json').read_bytes()
    need(json.loads(raw).get('commit') == CURRENT, 'CURRENT_CHANGED')
    proof = (current / PROOF_FILE).read_bytes()
    need(sha(proof) == PREDECESSOR_PROOF, 'PREDECESSOR_PROOF_CHANGED')
    states = h.snapshot(d, current)
    h.guards(d, current, states, {'engineHealth': ENGINE})
    old = json.loads((HERE / 'bitbrowser-recovery-contract.json').read_bytes())
    normalizer = Path(old['baseline']['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink(), 'BACKUP_NORMALIZER_INVALID')
    return {'status': BASELINE_STATUS, 'commit': CURRENT, 'current': str(current),
        'manifestSha256': sha(raw), 'services': states,
        'configurationSha256': {n: sha((current / n).read_bytes()) for n in CONFIGURATION},
        'runtimeConfigurationSha256': {n: h.configuration(d, state) for n, state in states.items()},
        'proofs': {PROOF_FILE: sha(proof), **({'recharge-checkout-build-proof.json': ADMIN_PROOF} if RECIPE == FOLLOWUP else {})}, **runtime(d, states),
        'database': database(d, states['api']), 'backupNormalizerPath': str(normalizer),
        'backupNormalizerSha256': sha(normalizer.read_bytes()), 'freeBytes': shutil.disk_usage(BASE).free,
        'businessActions': 0, 'databaseWrites': 0}


def verify_entry_parent(c, manifest, proof, preservation, old, old_manifest):
    """Authenticate the previous finite publication before inheriting any runtime state."""
    parent = c['parentNative']
    need(manifest.get('commit') == proof.get('commit') == preservation.get('commit') == ENTRY_CURRENT
        and manifest.get('sourceTree') == proof.get('tree') == preservation.get('tree') == ENTRY_TREE
        and manifest.get('status') == 'DEPLOYED' and manifest.get('scope') == proof.get('scope') == 'BITBROWSER_FOLLOWUP_ACCEPTANCE_20261019'
        and proof.get('recipe') == FOLLOWUP and proof.get('contractSha256') == FOLLOWUP_CONTRACT_SHA
        and proof.get('workflowRunId') == preservation.get('workflowRunId') == parent['workflowRunId']
        and proof.get('sources') == old['sources'] and proof.get('controlSources') == old['controlPins']
        and proof.get('updatedServices') == ['api', 'admin'] and proof.get('migrationPerformed') is False
        and proof.get('businessActions') == 0 and preservation.get('businessActions') == 0
        and preservation.get('migrationPerformed') is False
        and manifest.get('bitbrowserHistoryPublication') == preservation
        and manifest.get('previousCommit') == old['expectedCurrent']
        and manifest.get('previousRelease') == old['baseline']['current']
        and manifest.get('previousManifestSha256') == old['baseline']['manifestSha256'], 'ENTRY_PARENT_IDENTITY_CHANGED')
    need(preservation.get('before') == old['baseline']['services']
        and set(preservation.get('after', {})) == set(SERVICES)
        and set(preservation.get('images', {})) == {'api', 'admin'}
        and all(preservation['after'][n] == preservation['before'][n]
            for n in ('mysql', 'caddy', 'media-resolver', 'auto-recharge'))
        and preservation['after']['api']['image'] == ENTRY_API_IMAGE
        and preservation['image'] == preservation['images']['api']
        and all(preservation['after'][n]['image'] == preservation['images'][n]['imageId']
            == manifest['images'][n]['digest'] and manifest['images'][n]['sourceCommit'] == ENTRY_CURRENT
            and manifest['images'][n]['reference'] == preservation['images'][n]['reference'] for n in ('api', 'admin'))
        and all(preservation['after'][n]['environmentSha256'] == preservation['before'][n]['environmentSha256']
            for n in ('api', 'admin', 'online-recharge'))
        and preservation['after']['online-recharge']['image'] == preservation['before']['online-recharge']['image'],
        'ENTRY_PARENT_SERVICES_CHANGED')
    for role in ('api', 'admin'):
        projection = manifest['roleSourceProjections'][role]
        need(projection.get('commit') == ENTRY_CURRENT and projection.get('kind') == manifest['scope']
            and projection.get('buildProofSha256') == ENTRY_PROOF
            and projection.get('sources') == {n: v for n, v in old['sources'].items() if n.startswith('apps/' + role + '/')}
            and projection.get('parentProjection') == old_manifest['roleSourceProjections'][role], 'ENTRY_PARENT_PROJECTION_CHANGED')
    need(manifest.get('adminSourceProjection') == manifest['roleSourceProjections']['admin']
        and proof.get('baselineAdminReproduced') is True and inventory(proof.get('adminFiles'))
        and len(proof['adminFiles']) == 261, 'ENTRY_PARENT_ADMIN_CHANGED')
    before_admin = preservation.get('beforeAdminFiles')
    need(inventory(before_admin) and {'count': len(before_admin), 'sha256': sha(canonical(before_admin))}
        == old['baseline']['adminInventory'], 'ENTRY_PARENT_ADMIN_HISTORY_CHANGED')
    return {**before_admin, **proof['adminFiles']}


def verify_entry_inventory(old, proof, admin_files, actual):
    expected = {**{n: old['baseline'][n] for n in ('apiPreservedInventory', 'sharedInventory', 'clientInventory', 'nginxSha256')},
        'apiModules': proof['apiModules'], 'adminInventory': {'count': len(admin_files), 'sha256': sha(canonical(admin_files))}}
    need(actual == expected, 'ENTRY_PARENT_CONTENT_CHANGED')


def entry_seal_record(plan, b):
    return {**{n: plan[n] for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt')}, 'baseline': b}


def verify_entry_seal(plan, b, raw):
    need(raw == canonical(entry_seal_record(plan, b)), 'ENTRY_PARENT_SEAL_CHANGED')


def entry_runtime_contract(d, h, c, plan):
    """OIDC preflight seals a verified parent baseline; release rechecks it; readback retains it."""
    sealed = plan.get('runtimeBaseline', {}).get('verifiedBaseline')
    readback = plan['mode'] == 'readback'
    need(plan['mode'] == 'preflight' or type(sealed) is dict, 'ENTRY_PARENT_SEAL_MISSING')
    seal_path = HERE / 'entry-parent-baseline.json'
    if plan['mode'] != 'preflight':
        need(seal_path.is_file() and not seal_path.is_symlink(), 'ENTRY_PARENT_SEAL_MISSING')
        seal_raw = seal_path.read_bytes()
        verify_entry_seal(plan, sealed, seal_raw)
        need(plan['runtimeBaseline'].get('entryParentSealSha256') == sha(seal_raw), 'ENTRY_PARENT_SEAL_CHANGED')
    parent = Path(sealed['current']) if readback else BASE / 'current'
    parent = parent.resolve(strict=True)
    need(parent.parent == BASE / 'releases' and (not readback or str(parent) == sealed['current']), 'ENTRY_PARENT_PATH_CHANGED')
    raw_manifest = (parent / 'release-manifest.json').read_bytes()
    raw_proof = (parent / 'bitbrowser-history-build-proof.json').read_bytes()
    raw_preservation = (parent / 'bitbrowser-history-preservation.json').read_bytes()
    old_raw = (HERE / 'bitbrowser-followup-contract.json').read_bytes()
    need(sha(raw_proof) == ENTRY_PROOF and sha(old_raw) == FOLLOWUP_CONTRACT_SHA, 'ENTRY_PARENT_PROOF_CHANGED')
    old = json.loads(old_raw)
    old_root = Path(old['baseline']['current']).resolve(strict=True)
    need(old_root.parent == BASE / 'releases' and str(old_root) == old['baseline']['current'], 'ENTRY_PARENT_ORIGIN_CHANGED')
    old_manifest_raw = (old_root / 'release-manifest.json').read_bytes()
    need(sha(old_manifest_raw) == old['baseline']['manifestSha256'], 'ENTRY_PARENT_ORIGIN_CHANGED')
    manifest, proof, preservation = json.loads(raw_manifest), json.loads(raw_proof), json.loads(raw_preservation)
    admin_files = verify_entry_parent(c, manifest, proof, preservation, old, json.loads(old_manifest_raw))
    hashes = {n: sha((parent / n).read_bytes()) for n in CONFIGURATION}
    old_compose_raw = (old_root / 'compose.release.json').read_bytes()
    need(sha(old_compose_raw) == old['baseline']['configurationSha256']['compose.release.json'], 'ENTRY_PARENT_ORIGIN_CHANGED')
    original_compose = json.loads(old_compose_raw)
    selected_compose = json.loads((parent / 'compose.release.json').read_bytes())
    for role in ('api', 'admin'):
        need(selected_compose['services'][role]['image'] == preservation['images'][role]['reference'], 'ENTRY_PARENT_COMPOSE_CHANGED')
        selected_compose['services'][role]['image'] = original_compose['services'][role]['image']
    need(selected_compose == original_compose
        and all(hashes[n] == old['baseline']['configurationSha256'][n] for n in CONFIGURATION if n != 'compose.release.json'),
        'ENTRY_PARENT_COMPOSE_CHANGED')
    parent_hashes = {'bitbrowser-history-build-proof.json': ENTRY_PROOF,
        'bitbrowser-history-preservation.json': sha(raw_preservation)}
    if readback:
        need(sealed['commit'] == ENTRY_CURRENT and sealed['manifestSha256'] == sha(raw_manifest)
            and sealed['proofs'] == parent_hashes and sealed['services'] == preservation['after']
            and sealed['configurationSha256'] == hashes and sealed['apiModules'] == c['baseline']['apiModules']
            and sealed['adminInventory'] == {'count': len(admin_files), 'sha256': sha(canonical(admin_files))},
            'ENTRY_PARENT_SEAL_CHANGED')
        return {**c, 'baseline': copy.deepcopy(sealed)}
    states = h.snapshot(d, parent)
    need(states == preservation['after'], 'ENTRY_PARENT_RUNTIME_MOVED')
    observed_parent = runtime(d, states, proof['apiModules'])
    verify_entry_inventory(old, proof, admin_files, observed_parent)
    need(load('recharge-checkout-release.py').admin_inventory(d, states['admin']) == admin_files
        and database(d, states['api']) == old['baseline']['database']
        and {n: h.configuration(d, st) for n, st in states.items()} == old['baseline']['runtimeConfigurationSha256'],
        'ENTRY_PARENT_CONTENT_CHANGED')
    original_admin = json.loads(d.run('docker', 'image', 'inspect', old['baseline']['services']['admin']['image']))[0]
    actual_admin = json.loads(d.run('docker', 'image', 'inspect', states['admin']['image']))[0]
    load('proxy-result-identity-release.py').verify_overlay_image(original_admin, actual_admin,
        {'commit': ENTRY_CURRENT, 'buildProofSha256': ENTRY_PROOF}, 1, load('recharge-checkout-release.py'))
    b = {'status': BASELINE_STATUS, 'commit': CURRENT, 'current': str(parent), 'manifestSha256': sha(raw_manifest),
        'services': states, 'configurationSha256': hashes, 'proofs': parent_hashes,
        'runtimeConfigurationSha256': old['baseline']['runtimeConfigurationSha256'], **runtime(d, states),
        'database': old['baseline']['database'], 'backupNormalizerPath': old['baseline']['backupNormalizerPath'],
        'backupNormalizerSha256': old['baseline']['backupNormalizerSha256'], 'businessActions': 0, 'databaseWrites': 0}
    need(b['apiModules'] == c['baseline']['apiModules'], 'ENTRY_PARENT_SELECTED_MODULE_CHANGED')
    need(sealed is None or b == sealed, 'ENTRY_PARENT_SEAL_CHANGED')
    normalizer = Path(b['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink()
        and sha(normalizer.read_bytes()) == b['backupNormalizerSha256'], 'BACKUP_NORMALIZER_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    h.guards(d, parent, states, c)
    if plan['mode'] == 'preflight':
        need(not seal_path.exists(), 'ENTRY_PARENT_ALREADY_SEALED')
        with seal_path.open('xb') as output:
            output.write(canonical(entry_seal_record(plan, b)))
            output.flush()
            os.fsync(output.fileno())
    return {**c, 'baseline': b}


def verify_address_parent(c, manifest, proof, preservation, old_entry, old_manifest):
    before = c['parentVerifiedBaseline']
    need(manifest.get('commit') == proof.get('commit') == preservation.get('commit') == ADDRESS_CURRENT
        and manifest.get('sourceTree') == proof.get('tree') == preservation.get('tree') == ADDRESS_TREE
        and manifest.get('status') == 'DEPLOYED' and manifest.get('scope') == proof.get('scope') == 'BITBROWSER_ENTRY_START_20261019'
        and proof.get('recipe') == ENTRY and proof.get('contractSha256') == ENTRY_CONTRACT_SHA
        and proof.get('workflowRunId') == preservation.get('workflowRunId') == '39202298576'
        and proof.get('sources') == old_entry['sources'] and proof.get('controlSources') == old_entry['controlPins']
        and proof.get('isolatedMysqlVerification') == c['mysqlInheritance']['evidence']
        and proof.get('updatedServices') == ['api'] and proof.get('migrationPerformed') is False
        and proof.get('businessActions') == 0 and preservation.get('businessActions') == 0
        and preservation.get('migrationPerformed') is False and manifest.get('bitbrowserHistoryPublication') == preservation
        and preservation.get('verifiedParentBaseline') == before
        and preservation.get('entryParentSealSha256') == c['parentVerifiedSealSha256']
        and manifest.get('previousCommit') == ENTRY_CURRENT and manifest.get('previousRelease') == before['current']
        and manifest.get('previousManifestSha256') == before['manifestSha256'], 'ADDRESS_PARENT_IDENTITY_CHANGED')
    need(preservation.get('before') == before['services'] and set(preservation.get('after', {})) == set(SERVICES)
        and set(preservation.get('images', {})) == {'api'}
        and all(preservation['after'][n] == preservation['before'][n] for n in ('admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge'))
        and preservation['after']['admin']['image'] == ADDRESS_ADMIN_IMAGE
        and preservation['after']['api']['image'] == preservation['images']['api']['imageId'] == ADDRESS_API_IMAGE
        and preservation.get('image') == preservation['images']['api']
        and manifest['images']['api'] == {'digest': ADDRESS_API_IMAGE, 'reference': preservation['images']['api']['reference'], 'sourceCommit': ADDRESS_CURRENT}
        and all(manifest['images'][n] == old_manifest['images'][n] for n in old_manifest['images'] if n != 'api')
        and preservation['after']['online-recharge']['image'] == preservation['before']['online-recharge']['image']
        and all(preservation['after'][n]['environmentSha256'] == preservation['before'][n]['environmentSha256'] for n in ('api', 'online-recharge')),
        'ADDRESS_PARENT_SERVICES_CHANGED')
    api = manifest['roleSourceProjections']['api']
    need(api.get('commit') == ADDRESS_CURRENT and api.get('kind') == manifest['scope'] and api.get('buildProofSha256') == ADDRESS_PROOF
        and api.get('sources') == old_entry['sources'] and api.get('parentProjection') == old_manifest['roleSourceProjections']['api']
        and manifest['roleSourceProjections']['admin'] == old_manifest['roleSourceProjections']['admin']
        and manifest.get('adminSourceProjection') == old_manifest.get('adminSourceProjection'), 'ADDRESS_PARENT_PROJECTION_CHANGED')


def address_runtime_contract(d, h, c, plan):
    sealed = plan.get('runtimeBaseline', {}).get('verifiedBaseline')
    readback = plan['mode'] == 'readback'
    need(plan['mode'] == 'preflight' or type(sealed) is dict, 'ENTRY_PARENT_SEAL_MISSING')
    seal_path = HERE / 'entry-parent-baseline.json'
    if plan['mode'] != 'preflight':
        need(seal_path.is_file() and not seal_path.is_symlink(), 'ENTRY_PARENT_SEAL_MISSING')
        raw_seal = seal_path.read_bytes()
        verify_entry_seal(plan, sealed, raw_seal)
        need(plan['runtimeBaseline'].get('entryParentSealSha256') == sha(raw_seal), 'ENTRY_PARENT_SEAL_CHANGED')
    parent = (Path(sealed['current']) if readback else BASE / 'current').resolve(strict=True)
    need(parent.parent == BASE / 'releases' and (not readback or str(parent) == sealed['current']), 'ADDRESS_PARENT_PATH_CHANGED')
    raw_manifest = (parent / 'release-manifest.json').read_bytes()
    raw_proof = (parent / 'bitbrowser-history-build-proof.json').read_bytes()
    raw_preservation = (parent / 'bitbrowser-history-preservation.json').read_bytes()
    raw_entry = (HERE / 'bitbrowser-entry-start-contract.json').read_bytes()
    need(sha(raw_proof) == ADDRESS_PROOF and sha(raw_entry) == ENTRY_CONTRACT_SHA, 'ADDRESS_PARENT_PROOF_CHANGED')
    old_entry = json.loads(raw_entry)
    before = c['parentVerifiedBaseline']
    old_root = Path(before['current']).resolve(strict=True)
    need(old_root.parent == BASE / 'releases' and str(old_root) == before['current'], 'ADDRESS_PARENT_ORIGIN_CHANGED')
    raw_old_manifest = (old_root / 'release-manifest.json').read_bytes()
    raw_admin_proof = (old_root / 'bitbrowser-history-build-proof.json').read_bytes()
    need(sha(raw_old_manifest) == before['manifestSha256'] and sha(raw_admin_proof) == ENTRY_PROOF, 'ADDRESS_PARENT_ORIGIN_CHANGED')
    manifest, proof, preservation = json.loads(raw_manifest), json.loads(raw_proof), json.loads(raw_preservation)
    old_manifest, admin_proof = json.loads(raw_old_manifest), json.loads(raw_admin_proof)
    verify_address_parent(c, manifest, proof, preservation, old_entry, old_manifest)
    need(admin_proof.get('commit') == ENTRY_CURRENT and admin_proof.get('adminFiles') == c['publishedAdminFiles'], 'ADDRESS_ADMIN_NATIVE_CHANGED')
    hashes = {n: sha((parent / n).read_bytes()) for n in CONFIGURATION}
    old_compose_raw = (old_root / 'compose.release.json').read_bytes()
    need(sha(old_compose_raw) == before['configurationSha256']['compose.release.json'], 'ADDRESS_PARENT_ORIGIN_CHANGED')
    original_compose, selected_compose = json.loads(old_compose_raw), json.loads((parent / 'compose.release.json').read_bytes())
    need(selected_compose['services']['api']['image'] == preservation['images']['api']['reference'], 'ADDRESS_PARENT_COMPOSE_CHANGED')
    selected_compose['services']['api']['image'] = original_compose['services']['api']['image']
    need(selected_compose == original_compose
        and all(hashes[n] == before['configurationSha256'][n] for n in CONFIGURATION if n != 'compose.release.json'), 'ADDRESS_PARENT_COMPOSE_CHANGED')
    parent_hashes = {'bitbrowser-history-build-proof.json': ADDRESS_PROOF, 'bitbrowser-history-preservation.json': sha(raw_preservation)}
    if readback:
        need(sealed['commit'] == CURRENT and sealed['manifestSha256'] == sha(raw_manifest)
            and sealed['proofs'] == parent_hashes and sealed['services'] == preservation['after']
            and sealed['configurationSha256'] == hashes and sealed['apiModules'] == {}
            and sealed['adminInventory'] == before['adminInventory'], 'ENTRY_PARENT_SEAL_CHANGED')
        return {**c, 'baseline': copy.deepcopy(sealed)}
    states = h.snapshot(d, parent)
    need(states == preservation['after'], 'ADDRESS_PARENT_RUNTIME_MOVED')
    observed = runtime(d, states, proof['apiModules'])
    expected = {**{n: before[n] for n in ('apiPreservedInventory', 'sharedInventory', 'clientInventory', 'adminInventory', 'nginxSha256')}, 'apiModules': proof['apiModules']}
    need(observed == expected and database(d, states['api']) == before['database']
        and {n: h.configuration(d, st) for n, st in states.items()} == before['runtimeConfigurationSha256'], 'ADDRESS_PARENT_CONTENT_CHANGED')
    old_preservation = json.loads((old_root / 'bitbrowser-history-preservation.json').read_bytes())
    need(old_manifest.get('bitbrowserHistoryPublication') == old_preservation, 'ADDRESS_ADMIN_HISTORY_CHANGED')
    old_followup_raw = (HERE / 'bitbrowser-followup-contract.json').read_bytes()
    need(sha(old_followup_raw) == FOLLOWUP_CONTRACT_SHA, 'ADDRESS_ADMIN_HISTORY_CHANGED')
    old_followup = json.loads(old_followup_raw)
    merged = verify_admin_merge(old_preservation['beforeAdminFiles'], admin_proof['adminFiles'],
        load('recharge-checkout-release.py').admin_inventory(d, states['admin']), old_followup['baseline']['adminInventory'])
    need(merged == before['adminInventory'], 'ADDRESS_ADMIN_HISTORY_CHANGED')
    b = {'status': BASELINE_STATUS, 'commit': CURRENT, 'current': str(parent), 'manifestSha256': sha(raw_manifest),
        'services': states, 'configurationSha256': hashes, 'proofs': parent_hashes,
        'runtimeConfigurationSha256': before['runtimeConfigurationSha256'], **runtime(d, states), 'database': before['database'],
        'backupNormalizerPath': before['backupNormalizerPath'], 'backupNormalizerSha256': before['backupNormalizerSha256'], 'businessActions': 0, 'databaseWrites': 0}
    need(b['apiModules'] == {} and (sealed is None or b == sealed), 'ENTRY_PARENT_SEAL_CHANGED')
    normalizer = Path(b['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink() and sha(normalizer.read_bytes()) == b['backupNormalizerSha256'], 'BACKUP_NORMALIZER_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    h.guards(d, parent, states, c)
    if plan['mode'] == 'preflight':
        need(not seal_path.exists(), 'ENTRY_PARENT_ALREADY_SEALED')
        with seal_path.open('xb') as output:
            output.write(canonical(entry_seal_record(plan, b)))
            output.flush()
            os.fsync(output.fileno())
    return {**c, 'baseline': b}


def baseline(d, h, c, expected=None):
    current = (BASE / 'current').resolve(strict=True)
    b = c['baseline']
    need(str(current) == b['current'] and current.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (current / 'release-manifest.json').read_bytes()
    need(sha(raw) == b['manifestSha256'] and json.loads(raw).get('commit') == CURRENT, 'MANIFEST_CHANGED')
    need(all(sha((current / n).read_bytes()) == v for n, v in b['proofs'].items()), 'PREDECESSOR_PROOF_CHANGED')
    states = h.snapshot(d, current)
    need(states == b['services'] and {n: h.configuration(d, s) for n, s in states.items()} == b['runtimeConfigurationSha256'],
        'SERVICES_CHANGED')
    need({n: sha((current / n).read_bytes()) for n in CONFIGURATION} == b['configurationSha256'], 'CONFIGURATION_CHANGED')
    need(runtime(d, states) == {n: b[n] for n in ('apiModules', 'apiPreservedInventory', 'sharedInventory',
        'clientInventory', 'adminInventory', 'nginxSha256')} and database(d, states['api']) == b['database'], 'RUNTIME_CHANGED')
    normalizer = Path(b['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink()
        and sha(normalizer.read_bytes()) == b['backupNormalizerSha256'], 'BACKUP_NORMALIZER_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    h.guards(d, current, states, c)
    receipt = load('recharge-availability-release.py').runtime_receipt(current, raw, states)
    if RECIPE in (ENTRY, ADDRESS, BOUNDED):
        receipt['verifiedBaseline'] = copy.deepcopy(b)
        receipt['entryParentSealSha256'] = sha((HERE / 'entry-parent-baseline.json').read_bytes())
    if expected is not None:
        need(receipt == expected, 'BASELINE_MOVED')
    return current, raw, states, receipt



def bounded_api_selection(files, selected, absent, authenticated_inventory):
    # Capture the full parent in server staging, returning only the finite
    # selection to avoid SSM output truncation. No draft dispatch calls this.
    need(inventory(files) and {'count': len(files), 'sha256': sha(canonical(files))} == authenticated_inventory,
        'BOUNDED_PARENT_FULL_INVENTORY_CHANGED')
    selected, absent = set(selected), set(absent)
    need(bool(selected) and absent <= selected and absent.isdisjoint(files)
        and all(name in files for name in selected - absent), 'BOUNDED_PARENT_SELECTED_OUTPUT_CHANGED')
    return {'apiModules': {name: files[name] for name in sorted(selected - absent)},
        'absentApiModules': sorted(absent), 'apiInventory': authenticated_inventory}


def verify_admin_merge(before, candidate, actual, baseline):
    need(inventory(before) and inventory(candidate)
        and {'count': len(before), 'sha256': sha(canonical(before))} == baseline, 'ADMIN_HISTORY_CHANGED')
    merged = {**before, **candidate}
    need(actual == merged, 'ADMIN_HISTORY_CHANGED')
    return {'count': len(merged), 'sha256': sha(canonical(merged))}


def smoke(d, h, retired, target, states, c, proof, before_admin=None):
    before = c['baseline']['services']
    need(all(states[n] == before[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(states['online-recharge']['image'] == before['online-recharge']['image']
        and all(states[n]['environmentSha256'] == before[n]['environmentSha256'] for n in (*UPDATED, 'online-recharge'))
        and {n: h.configuration(d, s) for n, s in states.items()} == c['baseline']['runtimeConfigurationSha256'],
        'RUNTIME_CONFIGURATION_CHANGED')
    observed = runtime(d, states)
    expected_runtime = {**{n: c['baseline'][n] for n in ('apiModules', 'apiPreservedInventory', 'sharedInventory',
        'clientInventory', 'adminInventory', 'nginxSha256')}, 'apiModules': proof['apiModules']}
    if RECIPE in (FOLLOWUP, ADDRESS, BOUNDED):
        need(type(before_admin) is dict and inventory(before_admin), 'ADMIN_HISTORY_MISSING')
        expected_runtime['adminInventory'] = verify_admin_merge(before_admin, proof['adminFiles'],
            load('recharge-checkout-release.py').admin_inventory(d, states['admin']), c['baseline']['adminInventory'])
        with urllib.request.urlopen(urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'}), timeout=25) as response:
            public = response.read(2 * 1024**2 + 1)
        need(sha(public) == proof['adminFiles']['index.html'] and ('v2-' + proof['commit']).encode() in public, 'PUBLIC_BUILD_CHANGED')
    need(observed == expected_runtime and database(d, states['api']) == c['baseline']['database'], 'RUNTIME_CONTENT_CHANGED')
    original = json.loads((Path(c['baseline']['current']) / 'compose.release.json').read_bytes())
    selected = json.loads((target / 'compose.release.json').read_bytes())
    for role in UPDATED:
        selected['services'][role]['image'] = original['services'][role]['image']
    need(selected == original and all(sha((target / n).read_bytes()) == c['baseline']['configurationSha256'][n]
        for n in CONFIGURATION if n != 'compose.release.json'), 'COMPOSE_SCOPE_CHANGED')
    row = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
    need(row['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'SIDECAR_BINDING_CHANGED')
    for name, digest in production_sources(c).items():
        path = target / name
        need(not path.is_symlink() and path.resolve().is_relative_to(target) and sha(path.read_bytes()) == digest, 'HOST_SOURCE_CHANGED')
    retired.verify_retired_runtime(d, states)
    h.engine_idle(d, states['online-recharge'], c, wait_connected=True)


def activate_services(d, target, before, fence):
    if 'api' in UPDATED:
        fence.stop(before['api'], grace=30)
        fence.stop(before['online-recharge'], grace=45)
        fence.close()
    d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', *UPDATED, timeout=180)
    for role in UPDATED:
        d.wait_healthy(target, role)
    fence.close()
    if REBOUND:
        d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', *REBOUND, timeout=180)
        for role in REBOUND:
            d.wait_healthy(target, role)


def release(plan, c):
    validate_contract(c)
    raw_contract = (HERE / CONTRACT_FILE).read_bytes()
    need(c == json.loads(raw_contract) and plan.get('contractSha256') == sha(raw_contract)
        and plan.get('controlSources') == {**c['controlPins'], CONTRACT_FILE: sha(raw_contract)}, 'PLAN_CHANGED')
    need(plan.get('recipe', 'history-20261019') == RECIPE, 'PLAN_RECIPE_CHANGED')
    need(plan.get('mode') in (('parent', 'preflight', 'release', 'readback') if RECIPE == BOUNDED else ('preflight', 'release', 'readback'))
        and all(re.fullmatch('[a-f0-9]{40}', plan.get(n, '')) for n in ('commit', 'tree'))
        and all(re.fullmatch('[1-9][0-9]*', plan.get(n, '')) for n in ('workflowRunId', 'workflowRunAttempt')), 'PLAN_IDENTITY_INVALID')
    for name, digest in plan['controlSources'].items():
        path = HERE / name
        need(path.is_file() and not path.is_symlink() and sha(path.read_bytes()) == digest, 'CONTROL_CHANGED')
    h, d, retired = helpers()
    a, p = load('recharge-availability-release.py'), load('proxy-result-identity-release.py')
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if RECIPE == BOUNDED:
            if plan['mode'] == 'parent':
                return bounded_capture(d, h, c, plan)
            c = bounded_runtime_contract(d, h, c, plan)
        elif RECIPE == ENTRY:
            c = entry_runtime_contract(d, h, c, plan)
        elif RECIPE == ADDRESS:
            c = address_runtime_contract(d, h, c, plan)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve(strict=True)
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            raw = (target / 'bitbrowser-history-build-proof.json').read_bytes()
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == SCOPE
                and sha(raw) == plan['buildProofSha256'], 'READBACK_IDENTITY_CHANGED')
            proof = json.loads(raw)
            receipt = json.loads((target / 'bitbrowser-history-preservation.json').read_bytes())
            states = h.snapshot(d, target)
            need(states == receipt['after'] and states[UPDATED[0]]['image'] == receipt['image']['imageId']
                and (RECIPE not in (FOLLOWUP, BOUNDED) or all(states[role]['image'] == receipt['images'][role]['imageId'] for role in UPDATED)),
                'READBACK_SERVICES_CHANGED')
            need(all(sha((target / 'scripts/production-release' / n).read_bytes()) == v
                for n, v in plan['controlSources'].items()), 'READBACK_EXECUTOR_CHANGED')
            if RECIPE in (ENTRY, ADDRESS, BOUNDED):
                need(receipt.get('verifiedParentBaseline') == c['baseline']
                    and receipt.get('entryParentSealSha256') == plan['runtimeBaseline']['entryParentSealSha256'], 'ENTRY_PARENT_SEAL_CHANGED')
            smoke(d, h, retired, target, states, c, proof, receipt.get('beforeAdminFiles'))
            h.guards(d, target, states, c)
            old_manifest = json.loads((Path(c['baseline']['current']) / 'release-manifest.json').read_bytes())
            old_projections = old_manifest['roleSourceProjections']
            if RECIPE == ENTRY:
                need(manifest['roleSourceProjections']['admin'] == old_projections['admin']
                    and manifest.get('adminSourceProjection') == old_manifest.get('adminSourceProjection')
                    and all(manifest['images'][n] == old_manifest['images'][n] for n in old_manifest['images'] if n != 'api'),
                    'ENTRY_PRESERVED_IDENTITY_CHANGED')
            if RECIPE == ADDRESS:
                need(manifest['roleSourceProjections']['api'] == old_projections['api']
                    and manifest.get('apiCompiledArtifact') == old_manifest.get('apiCompiledArtifact')
                    and all(manifest['images'][n] == old_manifest['images'][n] for n in old_manifest['images'] if n != 'admin'),
                    'ADDRESS_PRESERVED_IDENTITY_CHANGED')
            need(all(manifest['roleSourceProjections'][role]['parentProjection'] == old_projections[role] for role in UPDATED),
                'SOURCE_INHERITANCE_CHANGED')
            return {'status': 'BITBROWSER_HISTORY_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                'updatedServices': list(UPDATED), 'preservedServices': list(PRESERVED), 'businessActions': 0, 'migrationPerformed': False}
        if plan['mode'] == 'release':
            need(type(plan.get('runtimeBaseline')) is dict, 'PREFLIGHT_RECEIPT_MISSING')
        previous, raw_manifest, before, receipt = baseline(d, h, c, plan.get('runtimeBaseline'))
        if plan['mode'] == 'preflight':
            return {'status': 'BITBROWSER_HISTORY_PREFLIGHT_VERIFIED', 'commit': plan['commit'],
                'runtimeBaseline': receipt, 'businessActions': 0, 'migrationPerformed': False}
        stage = BASE / '.staging' / ('bitbrowser-history-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/bitbrowser-history-' + plan['commit'] + '/bitbrowser-history-artifact.tar.gz'
        need(plan.get('artifactUrl') == url, 'ARTIFACT_LOCATION_CHANGED')
        with urllib.request.urlopen(url, timeout=60) as response:
            bundle = response.read(ARTIFACT_LIMIT + 1)
        need(0 < len(bundle) <= ARTIFACT_LIMIT and sha(bundle) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = h.safe_archive(bundle, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(sha(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = verify_proof(json.loads(raw_proof), plan, c, payload, h)
        images = {}
        for role in UPDATED:
            context = payload / role
            a.normalize_image_context(context)
            reference = 'id-business-v2-history:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            copy_line = 'COPY modules/ /app/apps/api/dist/' if role == 'api' else 'COPY html/ /usr/share/nginx/html/'
            (context / 'Dockerfile').write_text('FROM ' + h.base_image_reference(d, before[role])
                + '\n' + copy_line + '\nLABEL org.opencontainers.image.revision="' + plan['commit']
                + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
            original = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            h.build_image(d, context, reference, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
            p.verify_overlay_image(original, built, plan, 1, load('recharge-checkout-release.py'))
            images[role] = {'reference': reference, 'imageId': built['Id']}
        before_admin = load('recharge-checkout-release.py').admin_inventory(d, before['admin']) if RECIPE in (FOLLOWUP, ADDRESS, BOUNDED) else None
        baseline(d, h, c, plan['runtimeBaseline'])
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(c['baseline']['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-bitbrowser-history')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name in production_sources(c):
            destination = target / name
            need(not destination.is_symlink() and destination.resolve().is_relative_to(target), 'SOURCE_PATH_CHANGED')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((payload / 'source' / name).read_bytes())
            destination.chmod(0o644)
        for name in plan['controlSources']:
            destination = target / 'scripts/production-release' / name
            need(not destination.is_symlink() and destination.resolve().is_relative_to(target), 'CONTROL_PATH_CHANGED')
            destination.write_bytes((HERE / name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in UPDATED:
            override['services'][role]['image'] = images[role]['reference']
        a.write_release_override(target / 'compose.release.json', override)
        baseline(d, h, c, plan['runtimeBaseline'])
        retired.SCOPE = SCOPE
        markers = retired.claim_retired_markers(d, before, plan)
        fence = p.sql_fence_class(c)(d, previous)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'maintenance': markers}) + '\n')
        try:
            fence.acquire()
            p.verify_markers(markers)
            activate_services(d, target, before, fence)
            after = h.snapshot(d, target)
            need(all(after[role]['image'] == images[role]['imageId'] for role in UPDATED), 'IMAGE_CHANGED')
            smoke(d, h, retired, target, after, c, proof, before_admin)
        except BaseException:
            journal.write_text(json.dumps({'status': 'NEEDS_FORWARD_DIAGNOSIS', 'target': str(target),
                'maintenanceHeld': True, 'rollbackPerformed': False}) + '\n')
            raise
        finally:
            fence.close()
        image = images[UPDATED[0]]
        preservation = {'status': 'BITBROWSER_HISTORY_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'],
            'before': before, 'after': after, 'image': image, 'images': images, 'beforeAdminFiles': before_admin, 'backup': backup, 'workflowRunId': plan['workflowRunId'],
            'businessActions': 0, 'migrationPerformed': False}
        if RECIPE in (ENTRY, ADDRESS, BOUNDED):
            preservation['verifiedParentBaseline'] = copy.deepcopy(c['baseline'])
            preservation['entryParentSealSha256'] = plan['runtimeBaseline']['entryParentSealSha256']
        (target / 'bitbrowser-history-preservation.json').write_text(json.dumps(preservation, sort_keys=True, indent=2) + '\n')
        (target / 'bitbrowser-history-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        for role in UPDATED:
            manifest['roleSourceProjections'][role] = {'kind': SCOPE, 'commit': plan['commit'],
                'parentProjection': copy.deepcopy(manifest['roleSourceProjections'][role]),
                'sources': {n: v for n, v in production_sources(c).items() if n.startswith('apps/' + role + '/')},
                'buildProofSha256': plan['buildProofSha256']}
            manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
        if RECIPE in (FOLLOWUP, ADDRESS, BOUNDED):
            manifest['previousAdminSourceProjection'] = copy.deepcopy(manifest.get('adminSourceProjection'))
            manifest['adminSourceProjection'] = copy.deepcopy(manifest['roleSourceProjections']['admin'])
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE,
            previousCommit=CURRENT, previousRelease=str(previous), previousManifestSha256=sha(raw_manifest),
            status='DEPLOYED', servicesUpdated=list(UPDATED), servicesRebound=list(REBOUND), newMigrations=[],
            migrationPerformed=False, paymentActions=0, bitbrowserHistoryPublication=preservation,
            compiledArtifactSelection=list(UPDATED))
        artifact = {'url': url, 'sha256': plan['artifactSha256'], 'validationRun': plan['workflowRunId']}
        if 'api' in UPDATED:
            manifest['apiCompiledArtifact'] = artifact
        if 'admin' in UPDATED:
            manifest['adminCompiledArtifact'] = artifact
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-bitbrowser-history')
        p.release_markers(markers)
        h.guards(d, target, after, c)
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target)}) + '\n')
        return {n: preservation[n] for n in ('status', 'commit', 'tree', 'image', 'workflowRunId', 'businessActions', 'migrationPerformed')}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recipe', default='history-20261019', choices=('history-20261019', FOLLOWUP, ENTRY, ADDRESS, BOUNDED))
    parser.add_argument('--observe', action='store_true', required=True)
    args = parser.parse_args()
    select_recipe(args.recipe)
    print(json.dumps(observe(), sort_keys=True))
