#!/usr/bin/env python3
"""Run one exact, guarded production release on the existing EC2 instance."""

import argparse
import base64
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import stat
import subprocess
import sys
import tarfile
import time
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit
import urllib.request


BASE = Path('/opt/id-business-v2')
SERVICES = ('media-resolver', 'auto-recharge', 'auto-registration', 'api', 'admin')
ALL_SERVICES = (*SERVICES, 'mysql', 'caddy')
HISTORY_POLICY_ID = 'historical-finance-20261005'
HISTORY_BASELINE = 'ed2f75b0f4075347224ce3b2c82a90ed514d8d22'
HISTORY_CONTINUATION_POLICY_ID = 'historical-finance-20261005-registration-continuation'
HISTORY_CONTINUATION_BASELINE = 'd0f359dc78b2d2b166893bfec8545609f5baa16d'
CONTINUATION_POLICY_SHA256 = '7407cc7c5676657b3f24b6e5649f1316cd3c64adb5aeb8f47006cfda58124137'
CONTINUATION_CONTROL_FILES = frozenset({
    '.github/workflows/production-release.yml',
    'scripts/ci-recharge-scope.mjs', 'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.mjs', 'scripts/ci-recharge-release.test.mjs',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/production-release/maintain-image-cache.test.py',
    'scripts/lib/v2-release-history-policy.mjs',
    'scripts/v2-release-history-audit.mjs', 'scripts/v2-release-history-policy.test.mjs',
    'deploy/aws/historical-finance-20261005-registration-continuation.json',
    'docs/PRODUCTION_RELEASE_OIDC.md',
})
CONTINUATION_CANDIDATE_FILES = frozenset({
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py',
    'docs/V2_TASKS.md',
})
# A third, fixed one-use entry pinned to independently verified successful 6a receipts.
HISTORY_DIAGNOSTICS_POLICY_ID = 'historical-finance-20261005-recharge-diagnostics'
HISTORY_DIAGNOSTICS_BASELINE = '6a82a774f2a65e00d4f260c629f7152bf7935d1d'
HISTORY_POST_CLEANUP_POLICY_ID = 'historical-finance-20261005-post-cleanup'
HISTORY_POST_CLEANUP_BASELINE = '6a82a774f2a65e00d4f260c629f7152bf7935d1d'
HISTORY_POST_CLEANUP_DATABASE = 'id_business_v2_partial_cleanup_20261005_v1'
HISTORY_POST_CLEANUP_RECEIPT_SHA256 = 'f788c9328fd9f8eed17aa058a449d1f427f7ebadce97b2f29a0a321dc792315f'
POST_CLEANUP_OPERATION = BASE / 'backups/mysql/partial-two-order-authorized-20261005-v1'
POST_CLEANUP_SEAL = POST_CLEANUP_OPERATION / 'reviewed-financial-release-seal.json'
POST_CLEANUP_RECEIPT = POST_CLEANUP_OPERATION / 'post-open-readonly-audit-v1.json'
HISTORY_ORDER_ARCHIVE_POLICY_ID = 'historical-finance-20261005-order-archive'
HISTORY_ORDER_ARCHIVE_BASELINE = '3ca300486d0edfadda83c094a48474a63959fce7'
ORDER_ARCHIVE_BASELINE_TREE = 'b376704b4039bcc162433c3358205ae60c4dcfa9'
ORDER_ARCHIVE_SEAL = POST_CLEANUP_OPERATION / 'reviewed-order-archive-release-seal.json'
ORDER_ARCHIVE_MIGRATION = '20261005193000_order_independent_archive'
ORDER_ARCHIVE_MIGRATION_SHA256 = '5738091ee212f78514c322a38d271bdc22ae6ec3743daf5e17835e52d93e0e04'
DIAGNOSTICS_POLICY_SHA256 = '0682cb5ec0f95dabc49bcd3ba4d38384d1353ddfe275dd6dcf122f540d1dbcba'
DIAGNOSTICS_PROOF_SHA256 = '5412e83e9702c09d2e070e98b7eb4256dfd8cfbbf4be6bf09e3f13202a2bb670'
DIAGNOSTICS_MANIFEST_SHA256 = '202262260aca06d9c2d613e9b3ed1e7e6dc9d41d02e6834560e44488dfb33866'
DIAGNOSTICS_COMPOSE_SHA256 = '05cd335251b31010af76b6c727927c2ae04158c481cb64186156229a3f6801b8'
DIAGNOSTICS_OVERRIDE_RAW_SHA256 = '10b7d30b6bd08d356b516d67dd54b39620b9b6fc1ca7e22bb760008a7cd0a635'
DIAGNOSTICS_OVERRIDE_CANONICAL_SHA256 = '9437772305ea1d18f790c528c3db05e126970153c77cdbe55d644122fe8b7313'
REGISTRATION_PROOF_SHA256 = '5762fb16f9787ca1c3bcb255a31e50188dc868de66bbaee8768cab8945cb21ba'
DIAGNOSTICS_CANDIDATE_FILES = frozenset({
    'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py',
    'docs/V2_TASKS.md',
    'scripts/ci-recharge-check.mjs',
})
DIAGNOSTICS_CONTROL_FILES = frozenset({
    '.github/workflows/production-release.yml',
    'scripts/ci-recharge-scope.mjs', 'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-release.test.mjs',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/production-release/maintain-image-cache.test.py',
    'scripts/lib/v2-release-history-policy.mjs',
    'scripts/v2-release-history-policy.test.mjs',
    'deploy/aws/historical-finance-20261005-recharge-diagnostics.json',
    'docs/PRODUCTION_RELEASE_OIDC.md',
})
# Independent fixed maintenance entry: original six cost closures, no new exception.
HISTORY_MAINTENANCE_POLICY_ID = 'historical-finance-20261005-maintenance-continuation'
HISTORY_MAINTENANCE_BASELINE = '6a82a774f2a65e00d4f260c629f7152bf7935d1d'
MAINTENANCE_POLICY_SHA256 = '2103ab9a701fca15af406284874ef70d91004d6b2ac5cdd92fa91a8403399135'
MAINTENANCE_DATABASE = 'id_business_v2_partial_cleanup_20261005_v1'
MAINTENANCE_PROOF_CANONICAL_SHA256 = '94e2ec1ba79c0cb2da503ce49b00260c7f8574ff487bf1f24e5002b7908cf1e3'
MAINTENANCE_EXPECTED_GATE = {'accepted': True, 'status': 'APPROVED_MAINTENANCE_SUBSET', 'policyId': 'historical-finance-20261005-maintenance-continuation', 'expectedCurrent': '6a82a774f2a65e00d4f260c629f7152bf7935d1d', 'fixedCurrent': '6a82a774f2a65e00d4f260c629f7152bf7935d1d', 'checkCount': 48, 'executedCheckCount': 48, 'unavailableCheckCount': 0, 'violationCount': 6, 'databaseName': 'id_business_v2_partial_cleanup_20261005_v1', 'policySha256': '2103ab9a701fca15af406284874ef70d91004d6b2ac5cdd92fa91a8403399135', 'rulesSha256': '259332c0c8eb2d3d96d066cecd7cbe294ed5f2bd1e7af0d1c39f6c002859d7f4', 'schemaSha256': '3aef82a77e90f3cb4a2a953d67808193168159aa8983276b67e12f916a0a3655', 'entitySetSha256': 'f23d021df7a2693b4b5ad3de3818ab6ea475a2362e7c71dd39dc489f3eeb2c43', 'closureItemsSha256': '0a917c246769c7bcc16d23859e687ed036c97c6289612ea4efc5f7dc16a0ab83', 'receiptSetSha256': '52839f3b24b7f47897db165a04a22f51d2d5918ad5946cad2f669f53536e831d', 'sourceSha256': '526e724a822540c5f33ddd9e38c71e3079efa1fce9672f8ceef5096e38cc7208'}
MAINTENANCE_RECEIPT_SHA256 = {'originManifest': '202262260aca06d9c2d613e9b3ed1e7e6dc9d41d02e6834560e44488dfb33866', 'originBefore': 'b54520e73edffbc0a9fcf6592da3733b04564c5b65ff41f1ed8789ea782804d5', 'originAfter': '818e1980ab01bff0eafaca24863601bca8b02aa0e4bcadf64c3a671bc38edf63', 'maintenanceSwitch': 'f8394310c8fe2a91a61c77e7bef4b2b196b68f704131a1fe11b116c2687f4634', 'maintenanceResume': '1692deacad7dc074a3fb2e30ef22d7f5b6fec8dd7930644d8d950f0089c21582', 'maintenanceProof': 'd8b9fae9fb2269d8ae601bdcd7aeaf0f978b4865567723fe5d278de95279ca6b'}
MAINTENANCE_CANDIDATE_FILES = frozenset(['apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py', 'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py', 'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py', 'docs/V2_TASKS.md', 'scripts/ci-recharge-check.mjs', 'scripts/lib/v2-data-integrity-audit.mjs', 'scripts/v2-data-integrity-audit.test.mjs', 'scripts/backup-aws-mysql.sh', 'scripts/aws-mysql-backup.test.mjs'])
MAINTENANCE_CONTROL_FILES = frozenset(['.github/workflows/production-release.yml', '.github/workflows/quality.yml', 'scripts/ci-recharge-scope.mjs', 'scripts/ci-recharge-scope.test.mjs', 'scripts/ci-recharge-release.test.mjs', 'scripts/production-release/dispatch.sh', 'scripts/production-release/remote-deploy.py', 'scripts/production-release/remote-deploy.test.py', 'scripts/production-release/maintain-image-cache.py', 'scripts/production-release/maintain-image-cache.test.py', 'scripts/lib/v2-release-history-policy.mjs', 'scripts/v2-release-history-policy.test.mjs', 'deploy/aws/historical-finance-20261005-recharge-diagnostics.json', 'scripts/lib/v2-release-maintenance-policy.mjs', 'scripts/v2-release-maintenance-audit.mjs', 'scripts/v2-release-maintenance-policy.test.mjs', 'deploy/aws/historical-finance-20261005-maintenance-continuation.json', 'docs/PRODUCTION_RELEASE_OIDC.md'])
MAINTENANCE_FIXED_RECEIPT_PATHS = {'maintenanceSwitch': '/opt/id-business-v2/backups/mysql/partial-two-order-authorized-20261005-v1/switch-receipt.json', 'maintenanceResume': '/opt/id-business-v2/backups/mysql/partial-two-order-authorized-20261005-v1/resume-open-receipt.json', 'maintenanceProof': '/opt/id-business-v2/.staging/registration-subset-proof-20261005-f8dbc40100a1/historical-subset-proof.json'}
MAINTENANCE_STDIN_WRAPPER = """import { readSync } from 'node:fs';
try {
  const bytes = Buffer.alloc(16385);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(0, bytes, length, bytes.length - length, null);
    if (!count) break;
    length += count;
  }
  if (length < 2 || length > 16384) throw new Error();
  const input = JSON.parse(bytes.subarray(0, length).toString('utf8'));
  if (!input || Array.isArray(input) || Object.keys(input).join(',') !== 'auditURL') throw new Error();
  const { validateAuditUrl } = await import('./scripts/lib/v2-release-maintenance-policy.mjs');
  process.env.V2_DATA_INTEGRITY_DATABASE_URL = validateAuditUrl(input.auditURL);
  process.argv = [process.execPath, 'scripts/v2-release-maintenance-audit.mjs', ...process.argv.slice(1)];
  await import('./scripts/v2-release-maintenance-audit.mjs');
} catch {
  console.error('MAINTENANCE_GATE_REJECTED');
  process.exitCode = 1;
}
"""


MAILBOX_POLICY_ID = 'historical-finance-20261005-mailbox-batch'
MAILBOX_BASELINE = 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'
MAILBOX_IMAGE_IDENTITY = ('f5826f9fb4ad0d846d9875c035c913a61eb68290', '37312405714', '1')
MAILBOX_POLICY_SHA256 = 'f3051a718cdbd55840d50affe6e5e1ddc62f187ff231f309679998608189481c'
MAILBOX_MANIFEST_SHA256 = 'a0c248295509397e1862b13bd3aa41f46f32955ad8862226de56e63f868be9d8'
MAILBOX_EXPECTED_GATE = {'accepted': True, 'status': 'APPROVED_MAILBOX_FROZEN_EXCEPTIONS', 'policyId': 'historical-finance-20261005-mailbox-batch', 'policySha256': 'f3051a718cdbd55840d50affe6e5e1ddc62f187ff231f309679998608189481c', 'expectedCurrent': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0', 'fixedCurrent': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0', 'imageCommit': 'f5826f9fb4ad0d846d9875c035c913a61eb68290', 'imageRun': '37312405714', 'imageAttempt': '1', 'checkCount': 48, 'executedCheckCount': 48, 'unavailableCheckCount': 0, 'violationCount': 6, 'snapshotSha256': '03c3c6c494f7c5878441813814d3dc0fac9ad9d4b3480b0e81835129c97c76df', 'servicesUpdated': ['api']}

MAILBOX_CARRIED_SOURCE = {'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py': 'f63eeb60d191aeb535c96bcd13cdbca8bbf040119ef08ca259875f621f283972', 'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py': 'a7becf0fc1d17dd6e843dbdf0c7ecb138a739ca6d9e8979767846e9b31d07d88'}
MAILBOX_REUSE_BUILD_CONTROLS = {
    'scripts/production-release/build-images.sh': '91e8dd6e59ff0bf45407e621d73063a0f63f663710828e8e4c727c4913b8536b',
    'scripts/production-release/push-images.sh': 'f39a459a6da9fb0bfc00a0b83624b4a6767bb888a4b58de9a091ff4b3d89eb40',
}

REUSE_CONTROL_FILES = frozenset({
    'deploy/aws/recharge-pro-menu-b8-20261005.json',
    'scripts/v2-release-mailbox-audit.mjs',
    'scripts/v2-release-mailbox-audit.test.mjs',
    'deploy/aws/historical-finance-20261005-mailbox-batch.json',
    '.github/workflows/production-release.yml',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-release.test.mjs',
    'scripts/production-release/cleanup-reviewed-cache.py',
    'scripts/production-release/cleanup-reviewed-cache.test.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/production-release/maintain-image-cache.test.py',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/reuse-images.py',
    'scripts/production-release/storage-maintenance.py',
    'scripts/production-release/storage-maintenance.test.py',
    'scripts/production-release/audit-retention-mysql.test.py',
    'deploy/aws/cache-cleanup-recharge-names-20261002.json',
    'deploy/aws/cache-cleanup-recharge-execution-20261002.json',
    'deploy/aws/cache-cleanup-storage-20261002.json',
    'deploy/aws/cache-cleanup-bitbrowser-direct-20261003.json',
    'deploy/aws/cache-cleanup-legacy-20261002.json',
    'deploy/aws/cache-cleanup-unused-legacy-20261003.json',
    'docs/PRODUCTION_RELEASE_OIDC.md',
    'docs/RECHARGE_NAMES_CACHE_RECOVERY_20261002.md',
    'docs/RECHARGE_EXECUTION_CACHE_RECOVERY_20261002.md',
    'docs/STORAGE_CLEANUP_20261002.md',
    'docs/V2_TASKS.md',
})


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def historical_fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True,
        separators=(',', ':')).encode()).hexdigest()


def require_historical_baseline(policy_id, expected_current):
    baselines = {HISTORY_POLICY_ID: HISTORY_BASELINE,
                 HISTORY_CONTINUATION_POLICY_ID: HISTORY_CONTINUATION_BASELINE,
                 HISTORY_DIAGNOSTICS_POLICY_ID: HISTORY_DIAGNOSTICS_BASELINE,
                 HISTORY_MAINTENANCE_POLICY_ID: HISTORY_MAINTENANCE_BASELINE,
                 HISTORY_ORDER_ARCHIVE_POLICY_ID: HISTORY_ORDER_ARCHIVE_BASELINE,
                 HISTORY_POST_CLEANUP_POLICY_ID: HISTORY_POST_CLEANUP_BASELINE}
    require(policy_id in baselines and expected_current == baselines[policy_id],
            'Historical release exception cannot be reused after publication')


def fixed_continuation(policy_id=HISTORY_CONTINUATION_POLICY_ID):
    # Only these two compiled identities can select continuation behavior.
    if policy_id == HISTORY_CONTINUATION_POLICY_ID:
        return (HISTORY_CONTINUATION_BASELINE, CONTINUATION_POLICY_SHA256,
                CONTINUATION_CANDIDATE_FILES, CONTINUATION_CONTROL_FILES)
    require(policy_id == HISTORY_DIAGNOSTICS_POLICY_ID,
            'Unknown fixed historical continuation')
    return (HISTORY_DIAGNOSTICS_BASELINE, DIAGNOSTICS_POLICY_SHA256,
            DIAGNOSTICS_CANDIDATE_FILES, DIAGNOSTICS_CONTROL_FILES)


def continuation_policy(source, policy_id=HISTORY_CONTINUATION_POLICY_ID):
    baseline, policy_sha256, candidate_files, _controls = fixed_continuation(policy_id)
    policy = json.loads((source / 'deploy/aws' / (policy_id + '.json')).read_text())
    require(historical_fingerprint(policy) == policy_sha256
            and policy.get('id') == policy_id
            and policy.get('expectedCurrent') == baseline
            and set(policy.get('candidateSourceSha256', {})) == candidate_files,
            'Historical continuation policy changed')
    original = {**policy, 'id': HISTORY_POLICY_ID, 'expectedCurrent': HISTORY_BASELINE}
    original.pop('continuation', None); original.pop('candidateSourceSha256', None)
    require(historical_fingerprint(original) ==
            '58be04eac7b385fdcd7386746358e1c02ff2b925a92b635cf6afe588495fd4ca',
            'Historical continuation changed the original approved scope')
    if policy_id == HISTORY_DIAGNOSTICS_POLICY_ID:
        proof = policy.get('continuation', {})
        require(historical_fingerprint(proof) == DIAGNOSTICS_PROOF_SHA256
                and proof.get('originPolicySha256') ==
                    '58be04eac7b385fdcd7386746358e1c02ff2b925a92b635cf6afe588495fd4ca'
                and proof.get('continuationOf') == HISTORY_POLICY_ID
                and proof.get('fixedCurrent') == HISTORY_DIAGNOSTICS_BASELINE
                and proof.get('manifest', {}).get('commit') == HISTORY_DIAGNOSTICS_BASELINE
                and proof.get('manifest', {}).get('previousCommit') == HISTORY_CONTINUATION_BASELINE,
                'Historical diagnostics successful proof changed')
    return policy


def private_historical_receipt(path):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as receipt:
            metadata = os.fstat(receipt.fileno())
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                    and stat.S_IMODE(metadata.st_mode) in (0o600, 0o400),
                    'Historical continuation receipt is not private')
            data = receipt.read(8 * 1024 * 1024 + 1)
        require(len(data) <= 8 * 1024 * 1024, 'Historical continuation receipt is too large')
        return data
    except OSError:
        raise RuntimeError('Historical continuation receipt unavailable') from None


def verify_continuation_baseline(previous, policy, policy_id=HISTORY_CONTINUATION_POLICY_ID):
    baseline, _policy_sha256, _candidates, _controls = fixed_continuation(policy_id)
    diagnostics = policy_id == HISTORY_DIAGNOSTICS_POLICY_ID
    previous_commit = HISTORY_CONTINUATION_BASELINE if diagnostics else HISTORY_BASELINE
    previous_policy = HISTORY_CONTINUATION_POLICY_ID if diagnostics else HISTORY_POLICY_ID
    previous_expected = HISTORY_CONTINUATION_BASELINE if diagnostics else HISTORY_BASELINE
    proof = policy['continuation']
    if diagnostics:
        require(historical_fingerprint(proof) == DIAGNOSTICS_PROOF_SHA256,
                'Historical diagnostics successful proof changed')
    files = [('release-manifest.json', 'manifestSha256'),
             ('before-audit.json', 'beforeReceiptSha256'),
             ('after-audit.json', 'afterReceiptSha256')]
    receipts = {}
    for name, digest_key in files:
        data = private_historical_receipt(previous / name)
        require(hashlib.sha256(data).hexdigest() == proof[digest_key],
                'Historical continuation successful receipt changed')
        receipts[name] = json.loads(data)
    manifest = receipts['release-manifest.json']
    require(all(manifest.get(key) == value for key, value in proof['manifest'].items())
            and manifest.get('commit') == baseline
            and manifest.get('previousCommit') == previous_commit
            and proof['continuationOf'] == HISTORY_POLICY_ID
            and proof['fixedCurrent'] == baseline,
            'Historical continuation successful manifest changed')
    sources = {name: group['sha256'] for name, group in policy['sources'].items()}
    for stage in ('before', 'after'):
        report = receipts[stage + '-audit.json']
        summary = manifest.get('dataAudit' + stage.title(), {})
        gate = report.get('gate', {})
        require(report.get('ok') is False and report.get('checkCount') == 48
                and report.get('violationCount') == 10
                and summary.get('checkCount') == 48 and summary.get('violationCount') == 10
                and gate == summary.get('historicalException')
                and historical_fingerprint(gate) == proof[stage + 'GateSha256']
                and gate.get('accepted') is True and gate.get('policyId') == previous_policy
                and gate.get('expectedCurrent') == previous_expected and gate.get('stage') == stage
                and gate.get('checkCount') == gate.get('executedCheckCount') == 48
                and gate.get('unavailableCheckCount') == 0 and gate.get('violationCount') == 10
                and gate.get('sources') == sources
                and gate.get('metadataSha256') == proof['metadataSha256'],
                'Historical continuation successful audit changed')
        if diagnostics:
            require(gate.get('status') == 'APPROVED_HISTORICAL_EXCEPTIONS'
                    and gate.get('fixedCurrent') == HISTORY_CONTINUATION_BASELINE
                    and gate.get('continuationOf') == HISTORY_POLICY_ID
                    and historical_fingerprint(gate.get('continuation')) == REGISTRATION_PROOF_SHA256
                    and gate.get('metadataSha256') == gate.get('continuation', {}).get('metadataSha256'),
                    'Historical diagnostics previous registration gate changed')
    return manifest


def verify_continuation_archive(release, source, policy, policy_id=HISTORY_CONTINUATION_POLICY_ID):
    baseline_sha, _policy_sha256, candidates, controls = fixed_continuation(policy_id)
    require(set(policy.get('candidateSourceSha256', {})) == candidates,
            'Historical continuation candidate scope changed')
    mode_mask = 0o7777 if policy_id == HISTORY_DIAGNOSTICS_POLICY_ID else 0o111
    if policy_id == HISTORY_DIAGNOSTICS_POLICY_ID:
        require(all(not path.is_symlink() and (path.is_file() or path.is_dir())
                    for path in release.rglob('*')),
                'Unsafe diagnostics candidate source entry')
    prefix = f'id-business-system-{baseline_sha}/'
    baseline = {}; seen = set()
    for member in source.getmembers():
        require((member.name == prefix[:-1] or member.name.startswith(prefix))
                and '..' not in Path(member.name).parts
                and (member.isfile() or member.isdir()), 'Unsafe continuation source archive entry')
        if not member.isfile():
            continue
        name = member.name[len(prefix):]
        require(name not in seen, 'Duplicate continuation source archive entry')
        seen.add(name)
        if name not in controls and name not in candidates:
            baseline[name] = (hashlib.sha256(source.extractfile(member).read()).hexdigest(),
                              member.mode & mode_mask)
    actual = {str(path.relative_to(release)):
              (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mode & mode_mask)
              for path in release.rglob('*') if path.is_file()
              and str(path.relative_to(release)) not in controls
              and str(path.relative_to(release)) not in candidates}
    require(actual == baseline, 'Historical continuation contains unrelated source changes')
    require(all((release / name).is_file() and not (release / name).is_symlink()
                and ((release / name).stat().st_mode & 0o7777 == 0o644
                     if policy_id == HISTORY_DIAGNOSTICS_POLICY_ID else
                     (release / name).stat().st_mode & 0o111 == 0)
                and hashlib.sha256((release / name).read_bytes()).hexdigest() == digest
                for name, digest in policy['candidateSourceSha256'].items()),
            'Historical diagnostics candidate source changed'
            if policy_id == HISTORY_DIAGNOSTICS_POLICY_ID else
            'Historical continuation registration source changed')


def normalize_diagnostics_candidate_modes(release, policy):
    # GitHub archives can carry 0664. Only the seven pinned, newly extracted
    # diagnostic candidates may lose group-write before the unchanged archive guard.
    require(policy.get('id') == HISTORY_DIAGNOSTICS_POLICY_ID
            and policy.get('expectedCurrent') == HISTORY_DIAGNOSTICS_BASELINE
            and set(policy.get('candidateSourceSha256', {})) == DIAGNOSTICS_CANDIDATE_FILES,
            'Historical continuation candidate scope changed')
    opened = []
    identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
                             info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    try:
        for name, digest in policy['candidateSourceSha256'].items():
            path = release / name
            require(not release.is_symlink() and all(not (release / Path(*Path(name).parts[:index])).is_symlink()
                    for index in range(1, len(Path(name).parts) + 1)),
                    'Unsafe diagnostics candidate source entry')
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            candidate = os.fdopen(descriptor, 'rb')
            metadata = os.fstat(candidate.fileno())
            opened.append((path, candidate, metadata))
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                    and stat.S_IMODE(metadata.st_mode) in (0o644, 0o664)
                    and hashlib.sha256(candidate.read()).hexdigest() == digest
                    and identity(os.fstat(candidate.fileno())) == identity(metadata),
                    'Historical diagnostics candidate source changed')
        # Validate every descriptor/path again before modifying any of the seven.
        require(all(identity(path.lstat()) == identity(metadata)
                    and identity(os.fstat(candidate.fileno())) == identity(metadata)
                    and not path.is_symlink() for path, candidate, metadata in opened),
                'Historical diagnostics candidate source changed')
        for _path, candidate, _metadata in opened:
            if stat.S_IMODE(os.fstat(candidate.fileno()).st_mode) == 0o664:
                os.fchmod(candidate.fileno(), 0o644)
    except OSError:
        raise RuntimeError('Historical diagnostics candidate source changed') from None
    finally:
        for _path, candidate, _metadata in opened:
            candidate.close()


def verify_continuation_running_images(states, manifest):
    require(all(states.get(service, {}).get('image') ==
                manifest.get('images', {}).get(service, {}).get('digest')
                and bool(states.get(service, {}).get('image')) for service in SERVICES),
            'Historical continuation running image changed')


def maintenance_policy(source):
    policy = json.loads((source / 'deploy/aws' /
                         (HISTORY_MAINTENANCE_POLICY_ID + '.json')).read_text())
    require(historical_fingerprint(policy) == MAINTENANCE_POLICY_SHA256
            and policy.get('id') == HISTORY_MAINTENANCE_POLICY_ID
            and policy.get('expectedCurrent') == HISTORY_MAINTENANCE_BASELINE
            and policy.get('databaseName') == MAINTENANCE_DATABASE
            and policy.get('receiptSha256') == MAINTENANCE_RECEIPT_SHA256
            and set(policy.get('candidateSourceSha256', {})) == MAINTENANCE_CANDIDATE_FILES,
            'Maintenance continuation policy changed')
    # Preserve the exact latest source of every prior public policy.
    for name, expected in (
        (HISTORY_POLICY_ID, '58be04eac7b385fdcd7386746358e1c02ff2b925a92b635cf6afe588495fd4ca'),
        (HISTORY_CONTINUATION_POLICY_ID, CONTINUATION_POLICY_SHA256),
        (HISTORY_DIAGNOSTICS_POLICY_ID, DIAGNOSTICS_POLICY_SHA256),
    ):
        original = json.loads((source / 'deploy/aws' / (name + '.json')).read_text())
        require(historical_fingerprint(original) == expected,
                'Maintenance continuation changed a prior policy')
    return policy


def maintenance_receipt_paths(previous):
    return {
        'originManifest': previous / 'release-manifest.json',
        'originBefore': previous / 'before-audit.json',
        'originAfter': previous / 'after-audit.json',
        **{key: Path(value) for key, value in MAINTENANCE_FIXED_RECEIPT_PATHS.items()},
    }


def private_maintenance_receipt(path):
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and stat.S_IMODE(before.st_mode) in (0o400, 0o600)
                and before.st_size <= 8 * 1024 * 1024,
                'Maintenance continuation receipt is not private')
        with os.fdopen(descriptor, 'rb', closefd=False) as receipt:
            raw = receipt.read(8 * 1024 * 1024 + 1)
        after = os.fstat(descriptor)
        require(len(raw) == before.st_size == after.st_size
                and before.st_mtime_ns == after.st_mtime_ns
                and before.st_ctime_ns == after.st_ctime_ns,
                'Maintenance continuation receipt changed while reading')
        return raw
    except OSError:
        raise RuntimeError('Maintenance continuation receipt unavailable') from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def verify_maintenance_baseline(previous, policy):
    receipts = {}
    for key, path in maintenance_receipt_paths(previous).items():
        raw = private_maintenance_receipt(path)
        require(hashlib.sha256(raw).hexdigest() == MAINTENANCE_RECEIPT_SHA256[key],
                'Maintenance continuation successful receipt changed')
        receipts[key] = json.loads(raw)
    manifest = receipts['originManifest']
    proof = receipts['maintenanceProof']
    require(manifest.get('commit') == HISTORY_MAINTENANCE_BASELINE
            and historical_fingerprint(proof) == MAINTENANCE_PROOF_CANONICAL_SHA256
            and proof.get('proved') is True and proof.get('releaseAllowed') is False
            and proof.get('fixedOriginalSixMode') is True
            and proof.get('candidateCheckCount') == proof.get('candidateExecutedCheckCount') == 48
            and proof.get('candidateUnavailableCheckCount') == 0
            and proof.get('candidateViolationCount') == proof.get('candidateCostCount') == 6
            and proof.get('candidateCashCount') == 0
            and proof.get('schemaSha256') == policy['schemaSha256']
            and proof.get('candidateEntitySetSha256') == policy['candidateEntitySetSha256']
            and proof.get('oldEntitySetSha256') == policy['candidateEntitySetSha256'],
            'Maintenance continuation successful proof changed')
    return manifest


def normalize_maintenance_candidate_modes(release, policy):
    # GitHub archive group-write is removed only from the eleven fixed,
    # newly extracted candidates, after every descriptor and path is verified.
    require(historical_fingerprint(policy) == MAINTENANCE_POLICY_SHA256
            and policy.get('id') == HISTORY_MAINTENANCE_POLICY_ID
            and policy.get('expectedCurrent') == HISTORY_MAINTENANCE_BASELINE
            and set(policy.get('candidateSourceSha256', {})) == MAINTENANCE_CANDIDATE_FILES,
            'Maintenance continuation candidate scope changed')
    opened = []
    identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
                             info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    def safe_parents(name):
        return (not release.is_symlink() and release.is_dir()
                and all(not (release / Path(*Path(name).parts[:index])).is_symlink()
                        for index in range(1, len(Path(name).parts))))
    try:
        for name, digest in policy['candidateSourceSha256'].items():
            path = release / name
            require(safe_parents(name), 'Unsafe maintenance candidate source entry')
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            candidate = os.fdopen(descriptor, 'rb')
            metadata = os.fstat(candidate.fileno())
            target = 0o755 if name == 'scripts/backup-aws-mysql.sh' else 0o644
            opened.append((name, path, candidate, metadata, target))
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                    and metadata.st_size <= 8 * 1024 * 1024
                    and stat.S_IMODE(metadata.st_mode) in (target, target | 0o020)
                    and hashlib.sha256(candidate.read()).hexdigest() == digest
                    and identity(os.fstat(candidate.fileno())) == identity(metadata),
                    'Maintenance continuation candidate source changed')
        require(all(safe_parents(name) and not path.is_symlink()
                    and identity(path.lstat()) == identity(metadata)
                    and identity(os.fstat(candidate.fileno())) == identity(metadata)
                    for name, path, candidate, metadata, _target in opened),
                'Maintenance continuation candidate source changed')
        for _name, _path, candidate, metadata, target in opened:
            if stat.S_IMODE(metadata.st_mode) != target:
                os.fchmod(candidate.fileno(), target)
    except OSError:
        raise RuntimeError('Maintenance continuation candidate source changed') from None
    finally:
        for _name, _path, candidate, _metadata, _target in opened:
            candidate.close()


def verify_maintenance_archive(release, source, policy):
    require(set(policy.get('candidateSourceSha256', {})) == MAINTENANCE_CANDIDATE_FILES,
            'Maintenance continuation candidate scope changed')
    require(all(not path.is_symlink() and (path.is_file() or path.is_dir())
                for path in release.rglob('*')), 'Unsafe maintenance candidate source entry')
    prefix = f'id-business-system-{HISTORY_MAINTENANCE_BASELINE}/'
    baseline = {}; seen = set()
    for member in source.getmembers():
        require((member.name == prefix[:-1] or member.name.startswith(prefix))
                and '..' not in Path(member.name).parts
                and (member.isfile() or member.isdir()), 'Unsafe maintenance source archive entry')
        if not member.isfile():
            continue
        name = member.name[len(prefix):]
        require(name not in seen, 'Duplicate maintenance source archive entry')
        seen.add(name)
        if name not in MAINTENANCE_CONTROL_FILES and name not in MAINTENANCE_CANDIDATE_FILES:
            baseline[name] = (hashlib.sha256(source.extractfile(member).read()).hexdigest(),
                              member.mode & 0o7777)
    actual = {str(path.relative_to(release)):
              (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mode & 0o7777)
              for path in release.rglob('*') if path.is_file()
              and str(path.relative_to(release)) not in MAINTENANCE_CONTROL_FILES
              and str(path.relative_to(release)) not in MAINTENANCE_CANDIDATE_FILES}
    require(actual == baseline, 'Maintenance continuation contains unrelated source changes')
    require(all((release / name).is_file() and not (release / name).is_symlink()
                and (release / name).stat().st_mode & 0o7777 ==
                    (0o755 if name == 'scripts/backup-aws-mysql.sh' else 0o644)
                and hashlib.sha256((release / name).read_bytes()).hexdigest() == digest
                for name, digest in policy['candidateSourceSha256'].items()),
            'Maintenance continuation candidate source changed')


def require_maintenance_release_arguments(args, image_commit, image_run, image_attempt):
    require(not args.admin_only, 'Maintenance continuation requires full publication')
    require((image_commit, image_run, image_attempt) ==
                (args.commit, args.run_id, args.run_attempt),
            'Maintenance continuation forbids image reuse')


def require_maintenance_scope(additions, edge_changed):
    require(not additions and not edge_changed,
            'Maintenance continuation forbids migrations and edge changes')


def require_maintenance_environment_unchanged(previous, release, expected):
    require((previous / '.env.aws.production').read_bytes() == expected
            and (release / '.env.aws.production').read_bytes() == expected,
            'Maintenance continuation production environment changed')


def maintenance_container_audit_url(values):
    try:
        raw = values['V2_DATA_INTEGRITY_DATABASE_URL']
        require(isinstance(raw, str) and 0 < len(raw.encode()) <= 12000,
                'Maintenance continuation audit configuration invalid')
        parts = urlsplit(raw)
        query = parse_qsl(parts.query, keep_blank_values=True, strict_parsing=True) if parts.query else []
        names = [key for key, _value in query]
        require(parts.scheme == 'mysql' and parts.hostname in ('127.0.0.1', 'localhost')
                and parts.username == 'id_business_audit' and bool(parts.password)
                and parts.port in (None, 3306) and not parts.fragment
                and parts.path == '/' + MAINTENANCE_DATABASE
                and values.get('MYSQL_DATABASE') == MAINTENANCE_DATABASE
                and len(names) == len(set(names))
                and set(names) <= {'connection_limit', 'charset', 'connect_timeout', 'pool_timeout'}
                and all(value == '1' for key, value in query if key == 'connection_limit'),
                'Maintenance continuation audit configuration invalid')
        for key, value in query:
            require((value == 'utf8mb4' if key == 'charset' else
                     bool(re.fullmatch(r'[1-9][0-9]{0,2}', value))),
                    'Maintenance continuation audit configuration invalid')
        if 'connection_limit' not in names:
            query.append(('connection_limit', '1'))
        userinfo, separator, _host = parts.netloc.rpartition('@')
        require(bool(separator and userinfo), 'Maintenance continuation audit configuration invalid')
        return urlunsplit(parts._replace(netloc=f'{userinfo}@mysql', query=urlencode(query)))
    except (KeyError, ValueError):
        raise RuntimeError('Maintenance continuation audit configuration invalid') from None


def maintenance_audit(directory, receipt, *, stage, source, before_receipt=None, origin=None):
    require(stage in ('before', 'after') and source is not None and origin is not None,
            'Maintenance continuation audit source missing')
    policy = maintenance_policy(source)
    verify_maintenance_baseline(origin, policy)
    connection_url = maintenance_container_audit_url(
        environment_values(directory / '.env.aws.production'))
    profile = json.loads(compose(directory, 'config', '--format', 'json'))['services']['migrate']
    require(profile.get('read_only') is True
            and profile.get('security_opt') == ['no-new-privileges:true']
            and profile.get('cap_drop') == ['ALL']
            and profile.get('cap_add') in (None, []) and not profile.get('privileged')
            and not profile.get('devices')
            and set(profile.get('environment', {})) == {'NODE_ENV', 'DATABASE_URL'},
            'Maintenance continuation audit profile changed')
    mounts = ['-v', f'{source / "scripts"}:/app/scripts:ro',
              '-v', f'{source / "deploy/aws"}:/release-policy:ro']
    for name in policy['candidateSourceSha256']:
        mounts.extend(['-v', f'{source / name}:/release-source/{name}:ro'])
    for key, path in maintenance_receipt_paths(origin).items():
        mounts.extend(['-v', f'{path}:/release-evidence/{key}.json:ro'])
    audit_args = ['node', '--input-type=module', '-e', MAINTENANCE_STDIN_WRAPPER, '--',
                  f'--policy=/release-policy/{HISTORY_MAINTENANCE_POLICY_ID}.json',
                  f'--expected-current={HISTORY_MAINTENANCE_BASELINE}', f'--stage={stage}']
    if stage == 'after':
        require(before_receipt is not None, 'Maintenance continuation before audit missing')
        private_maintenance_receipt(before_receipt)
        mounts.extend(['-v', f'{before_receipt}:/release-before-audit.json:ro'])
        audit_args.append('--before-receipt=/release-before-audit.json')
    input_data = json.dumps({'auditURL': connection_url})
    require(len(input_data.encode()) <= 16384, 'Maintenance continuation audit input too large')
    output = compose(directory, 'run', '--rm', '--no-deps', '-T', '--pull', 'never',
        '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH',
        *mounts, '-e', 'DATABASE_URL=', 'migrate', *audit_args,
        input_data=input_data, timeout=240)
    report = json.loads(output)
    require(report.get('ok') is False and report.get('checkCount') == 48
            and report.get('violationCount') == 6
            and report.get('gate') == {**MAINTENANCE_EXPECTED_GATE, 'stage': stage},
            'Approved maintenance integrity gate failed')
    if stage == 'after':
        before = json.loads(private_maintenance_receipt(before_receipt))
        require(before.get('gate') == {**MAINTENANCE_EXPECTED_GATE, 'stage': 'before'},
                'Approved maintenance before integrity gate changed')
    receipt.write_text(json.dumps(report, indent=2) + '\n')
    receipt.chmod(0o600)
    return {'checkCount': 48, 'violationCount': 6, 'historicalException': report['gate']}


def require_mailbox_release_arguments(args, image_commit, image_run, image_attempt):
    require(args.expected_current == MAILBOX_BASELINE and not args.admin_only
            and (image_commit, image_run, image_attempt) == MAILBOX_IMAGE_IDENTITY
            and args.commit != image_commit,
            'Mailbox release approval or immutable image identity changed')


def mailbox_policy(source):
    policy = json.loads((source / 'deploy/aws' / (MAILBOX_POLICY_ID + '.json')).read_text())
    require(hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            == MAILBOX_POLICY_SHA256, 'Mailbox release approval changed')
    require(policy.get('servicesUpdated') == ['api'] and policy.get('externalTestAcknowledged') is True
            and policy.get('carriedWorkerSourceSha256') == MAILBOX_CARRIED_SOURCE,
            'Mailbox API-only approval scope changed')
    return policy


def verify_mailbox_baseline(previous):
    raw = (previous / 'release-manifest.json').read_bytes()
    require(hashlib.sha256(raw).hexdigest() == MAILBOX_MANIFEST_SHA256
            and json.loads(raw).get('commit') == MAILBOX_BASELINE,
            'Mailbox production baseline changed')


def require_mailbox_scope(previous, release, additions, edge_changed, original_environment):
    require(not additions and not edge_changed, 'Mailbox release cannot migrate or change edge configuration')
    require((previous / '.env.aws.production').read_bytes() == original_environment
            and (release / '.env.aws.production').read_bytes() == original_environment,
            'Mailbox release environment changed')


def mailbox_audit(directory, receipt, *, stage, source, before_receipt=None, origin=None):
    require(stage in ('before', 'after') and source is not None and origin is not None,
            'Mailbox audit source missing')
    mailbox_policy(source)
    verify_mailbox_baseline(origin)
    connection_url = maintenance_container_audit_url(environment_values(directory / '.env.aws.production'))
    profile = json.loads(compose(directory, 'config', '--format', 'json'))['services']['migrate']
    require(profile.get('read_only') is True
            and profile.get('security_opt') == ['no-new-privileges:true']
            and profile.get('cap_drop') == ['ALL']
            and profile.get('cap_add') in (None, []) and not profile.get('privileged')
            and not profile.get('devices')
            and set(profile.get('environment', {})) == {'NODE_ENV', 'DATABASE_URL'},
            'Mailbox audit profile changed')
    mounts = ['-v', f'{source / "scripts"}:/app/scripts:ro',
              '-v', f'{source / "deploy/aws"}:/release-policy:ro']
    wrapper = MAINTENANCE_STDIN_WRAPPER.replace('v2-release-maintenance-audit.mjs',
                                               'v2-release-mailbox-audit.mjs').replace(
                                                   'MAINTENANCE_GATE_REJECTED', 'MAILBOX_GATE_REJECTED')
    audit_args = ['node', '--input-type=module', '-e', wrapper, '--',
                  f'--policy=/release-policy/{MAILBOX_POLICY_ID}.json',
                  f'--expected-current={MAILBOX_BASELINE}', f'--stage={stage}']
    if stage == 'after':
        require(before_receipt is not None, 'Mailbox before audit missing')
        before = json.loads(private_maintenance_receipt(before_receipt))
        require(json.dumps(before.get('gate'), sort_keys=True, separators=(',', ':'))
                == json.dumps({**MAILBOX_EXPECTED_GATE, 'stage': 'before'}, sort_keys=True, separators=(',', ':')),
                'Mailbox before audit changed')
        mounts.extend(['-v', f'{before_receipt}:/release-before-audit.json:ro'])
        audit_args.append('--before-receipt=/release-before-audit.json')
    output = compose(directory, 'run', '--rm', '--no-deps', '-T', '--pull', 'never',
        '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH',
        *mounts, '-e', 'DATABASE_URL=', 'migrate', *audit_args,
        input_data=json.dumps({'auditURL': connection_url}), timeout=240)
    report = json.loads(output)
    policy = mailbox_policy(source)
    require(report.get('ok') is False and type(report.get('checkCount')) is int
            and report['checkCount'] == 48 and type(report.get('violationCount')) is int
            and report['violationCount'] == 6 and report.get('checks') == policy['snapshot']['checks']
            and json.dumps(report.get('gate'), sort_keys=True, separators=(',', ':'))
            == json.dumps({**MAILBOX_EXPECTED_GATE, 'stage': stage}, sort_keys=True, separators=(',', ':')),
            'Approved mailbox financial integrity gate failed')
    receipt.write_text(json.dumps(report, indent=2) + '\n')
    receipt.chmod(0o600)
    return {'checkCount': 48, 'violationCount': 6, 'historicalException': report['gate']}


def command_failure_summary(data):
    error = data.get('StandardErrorContent', '')
    errors = re.findall(r'(?m)^([A-Za-z]+Error):', error)
    lines = re.findall(r'File "[^"\n]*remote-deploy\.py", line ([0-9]+)', error)
    reasons = (
        'Production baseline changed', 'Active recharge jobs prevent release',
        'Active registration jobs prevent release', 'Registration runtime guard unavailable',
        'Production database configuration invalid', 'Production database identity unavailable',
        'Production database identity mismatch',
        'A production service is not running', 'A production service is not healthy',
        'Invalid current release path', 'Insufficient free disk after pull',
        'Resource temporarily unavailable', 'No space left on device',
        'Permission denied', 'invalid syntax',
        'Historical diagnostics running manifest changed',
        'Historical diagnostics requires the fixed independent worker layout',
        'Historical continuation running image changed',
        'Historical diagnostics image override changed',
        'Production container identity unavailable',
        'Production container start identity unavailable',
    )
    status = data.get('Status')
    return {
        'status': status if status in ('Success', 'Failed', 'Cancelled', 'TimedOut',
                                       'InProgress', 'Pending', 'Cancelling') else 'Unknown',
        'responseCode': data.get('ResponseCode') if isinstance(data.get('ResponseCode'), int) else None,
        'errorType': errors[-1] if errors and errors[-1] in (
            'SyntaxError', 'RuntimeError', 'BlockingIOError', 'FileNotFoundError',
            'PermissionError', 'OSError', 'TypeError', 'ValueError', 'AssertionError',
            'ConnectionError', 'UnicodeDecodeError', 'ModuleNotFoundError', 'NameError'
        ) else 'Unclassified',
        'sourceLine': int(lines[-1]) if lines else None,
        'reason': next((reason for reason in reasons if reason in error), 'raw error suppressed'),
    }


def require_reusable_paths(paths, *, mailbox_only=False):
    allowed = REUSE_CONTROL_FILES | ((set(MAILBOX_CARRIED_SOURCE) | set(MAILBOX_REUSE_BUILD_CONTROLS)) if mailbox_only else set())
    require(set(paths) <= allowed, 'Application or build source changed since image build')


def verify_mailbox_carried_sources(directory):
    for name, digest in MAILBOX_CARRIED_SOURCE.items():
        require(hashlib.sha256((directory / name).read_bytes()).hexdigest() == digest,
                'Unchanged worker source carry differs from approved mailbox release')
    for name, digest in MAILBOX_REUSE_BUILD_CONTROLS.items():
        require(hashlib.sha256((directory / name).read_bytes()).hexdigest() == digest,
                'Mailbox reusable build controls differ from verified API-only scope')


def verify_reusable_archive(release, source, commit, *, mailbox_only=False):
    allowed = REUSE_CONTROL_FILES | ((set(MAILBOX_CARRIED_SOURCE) | set(MAILBOX_REUSE_BUILD_CONTROLS)) if mailbox_only else set())
    if mailbox_only:
        verify_mailbox_carried_sources(release)
    prefix = f'id-business-system-{commit}/'
    hashes = {}
    seen = set()
    for member in source.getmembers():
        require((member.name == prefix[:-1] or member.name.startswith(prefix))
                and '..' not in Path(member.name).parts
                and (member.isfile() or member.isdir()), 'Unsafe reusable source archive entry')
        if not member.isfile():
            continue
        name = member.name[len(prefix):]
        require(name not in seen, 'Duplicate reusable archive entry')
        seen.add(name)
        if name not in allowed:
            hashes[name] = (hashlib.sha256(source.extractfile(member).read()).hexdigest(),
                            member.mode & 0o111)
    actual = {str(p.relative_to(release)): (hashlib.sha256(p.read_bytes()).hexdigest(),
                                         p.stat().st_mode & 0o111)
              for p in release.rglob('*') if p.is_file()
              and str(p.relative_to(release)) not in allowed}
    require(actual == hashes, 'Reusable image source differs from release application source')


def release_services(admin_only, additions, edge_changed=False, *, historical_diagnostics=False,
                     historical_mailbox=False, historical_post_cleanup=False, historical_order_archive=False,
                     registration_only=False):
    require(sum((historical_diagnostics, historical_mailbox, historical_post_cleanup, historical_order_archive,
                 registration_only)) <= 1,
            'Historical release selection is ambiguous')
    if registration_only:
        require(not admin_only and not additions and not edge_changed,
                'Registration publication requires unchanged schema and one Worker only')
        return ('auto-registration',), ('auto-recharge',)
    if historical_mailbox:
        require(not admin_only and not additions and not edge_changed,
                'Mailbox release must update only the API without migrations or edge changes')
        return ('api',), ('api',)
    if historical_order_archive:
        require(not admin_only and not edge_changed
                and additions in ([], [ORDER_ARCHIVE_MIGRATION + '/migration.sql']),
                'Order archive publication requires only API, Admin and its unique migration')
        return ('api', 'admin'), ('api', 'migrate', 'admin')
    if historical_post_cleanup:
        require(not admin_only and not additions and not edge_changed,
                'Post-cleanup publication requires unchanged schema and API-only scope')
        return ('api',), ('api', 'migrate')
    if historical_diagnostics:
        require(not admin_only, 'Historical diagnostics requires Worker publication')
        require_diagnostics_migration_scope(additions, edge_changed)
        return ('auto-recharge',), ('auto-recharge',)
    require(not (admin_only and additions), 'Admin-only release contains migrations')
    services = ('admin',) if admin_only else SERVICES
    require(not (admin_only and edge_changed), 'Admin-only release contains edge configuration changes')
    images = tuple(dict.fromkeys(image_service(service) for service in services))
    if not admin_only:
        images = (*images, 'migrate')
    return (*services, 'caddy') if edge_changed else services, images


def image_service(service):
    # Independent processes reuse one Worker build; the runtime role is Compose config.
    return 'auto-recharge' if service == 'auto-registration' else service


def release_image_references(services, images, repository, tags):
    targets = (*[service for service in services if service in SERVICES],
               *[service for service in images if service not in SERVICES])
    return {service: f'{repository}:{tags[image_service(service)]}' for service in targets}


def has_registration_worker(directory):
    return bool(re.search(r'(?m)^  auto-registration:$',
                          (directory / 'docker-compose.aws-mysql.yml').read_text()))


def production_services(directory):
    # The first split release has no registration container in its old baseline.
    return tuple(service for service in ALL_SERVICES
                 if service != 'auto-registration' or has_registration_worker(directory))


def rollback_service(previous, release, service, before):
    if service not in before:
        require(service == 'auto-registration', 'Unexpected added production service')
        compose(release, 'rm', '-s', '-f', service, timeout=300)
        require(not compose(release, 'ps', '-q', '--all', service),
                'Rollback added registration worker remains')
        return
    compose(previous, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never',
            '--force-recreate', service, timeout=300)
    require(service_state(previous, service)['image'] == before[service]['image'],
            'Rollback image mismatch')
    wait_healthy(previous, service)


def run(*args, env=None, timeout=300, input_data=None):
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=timeout,
                            **({'input': input_data} if input_data is not None else {}))
    if result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} failed (exit {result.returncode}); output suppressed')
    return result.stdout.strip()


def compose(directory, *args, env=None, timeout=300, input_data=None):
    return run(
        'docker', 'compose', '--env-file', str(directory / '.env.aws.production'),
        '-f', str(directory / 'docker-compose.aws-mysql.yml'),
        '-f', str(directory / 'compose.release.json'), *args,
        env=env, timeout=timeout,
        **({'input_data': input_data} if input_data is not None else {}),
    )


def environment_values(path):
    values = {}
    for line in path.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key] = value.strip().strip('"').strip("'")
    return values


def service_state(directory, service, *, include_container_id=False, include_environment_hash=False):
    container = compose(directory, 'ps', '-q', service)
    require(bool(container), f'{service} container missing')
    data = json.loads(run('docker', 'inspect', container))[0]
    if include_environment_hash:
        require(isinstance(data.get('Config', {}).get('Env'), list)
                and bool(data['Config']['Env'])
                and all(isinstance(value, str) for value in data['Config']['Env']),
                'Production container environment identity unavailable')
    if include_container_id:
        require(isinstance(data.get('Id'), str) and re.fullmatch(r'[0-9a-f]{64}', data['Id']),
                'Production container identity unavailable')
        started_at = data['State'].get('StartedAt')
        require(isinstance(started_at, str) and 0 < len(started_at) <= 128,
                'Production container start identity unavailable')
    return {
        'image': data['Image'],
        'reference': data['Config']['Image'],
        'status': data['State']['Status'],
        'health': data['State'].get('Health', {}).get('Status'),
        **({'containerId': data['Id'],
            'startedAtSha256': hashlib.sha256(started_at.encode()).hexdigest()}
           if include_container_id else {}),
        **({'environmentSha256': historical_fingerprint(sorted(data['Config'].get('Env', [])))}
           if include_environment_hash else {}),
    }


def wait_healthy(directory, service):
    for _ in range(90):
        state = service_state(directory, service)
        if state['status'] == 'running' and (state['health'] == 'healthy'
                                           or (service == 'caddy' and state['health'] is None)):
            return state
        if state['status'] not in ('running', 'created'):
            break
        time.sleep(2)
    raise RuntimeError(f'{service} did not become healthy')


def historical_audit_reader(directory, service='migrate'):
    probe = ("const os=require('node:os'); const user=os.userInfo(); "
             "console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),user:user.username}));")
    try:
        identity = json.loads(compose(directory, 'run', '--rm', '--no-deps',
            '--entrypoint', 'node', service, '-e', probe, timeout=30))
    except Exception:
        raise RuntimeError('Historical audit reader identity unavailable') from None
    require(isinstance(identity, dict) and set(identity) == {'uid', 'gid', 'user'}
            and identity['user'] == 'node'
            and all(type(identity[key]) is int and 0 < identity[key] <= 2147483647
                    for key in ('uid', 'gid')), 'Historical audit reader identity unavailable')
    return identity


def prepare_historical_before_receipt(directory, receipt, service='migrate'):
    # Existing before receipts become private node-readable mounts; operation evidence
    # uses separate reader copies below so its original ownership never changes.
    identity = historical_audit_reader(directory, service)
    try:
        descriptor = os.open(receipt, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise RuntimeError('Historical before audit receipt unavailable') from None
    try:
        metadata = os.fstat(descriptor)
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                and stat.S_IMODE(metadata.st_mode) in (0o600, 0o400)
                and metadata.st_uid in (os.geteuid(), identity['uid']),
                'Historical before audit receipt is not private')
        os.fchown(descriptor, identity['uid'], identity['gid'])
        os.fchmod(descriptor, 0o400)
    except OSError:
        raise RuntimeError('Historical before audit ownership unavailable') from None
    finally:
        os.close(descriptor)


def prepare_post_cleanup_reader_copy(directory, original, digest, filename, identity):
    # Docker resolves the host mount as root; its node process reads only this 0400 copy.
    require(filename in ('post-cleanup-seal.reader.json', 'post-cleanup-receipt.reader.json',
                         'order-archive-seal.reader.json', 'order-archive-cleanup.reader.json'),
            'Post-cleanup reader filename changed')
    try:
        descriptor = os.open(original, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as stream:
            metadata = os.fstat(stream.fileno())
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                    and metadata.st_uid == os.geteuid() and stat.S_IMODE(metadata.st_mode) == 0o600,
                    'Post-cleanup original evidence is not private')
            content = stream.read()
        require(hashlib.sha256(content).hexdigest() == digest, 'Post-cleanup original evidence changed')
        reader = directory / filename
        descriptor = os.open(reader, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fchown(stream.fileno(), identity['uid'], identity['gid'])
            os.fchmod(stream.fileno(), 0o400)
    except FileExistsError:
        # A prior validated attempt may be reused only with the exact reader identity and bytes.
        pass
    except OSError:
        raise RuntimeError('Post-cleanup reader evidence unavailable') from None
    try:
        descriptor = os.open(reader, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as stream:
            metadata = os.fstat(stream.fileno())
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                    and stat.S_IMODE(metadata.st_mode) == 0o400
                    and metadata.st_uid == identity['uid'] and metadata.st_gid == identity['gid']
                    and hashlib.sha256(stream.read()).hexdigest() == digest,
                    'Post-cleanup reader evidence changed')
    except OSError:
        raise RuntimeError('Post-cleanup reader evidence unavailable') from None
    return reader


def reviewed_post_cleanup_seal(source, expected_sha, candidate_commit, candidate_tree):
    require(re.fullmatch(r'[a-f0-9]{64}', expected_sha or '') is not None,
            'Reviewed post-cleanup external seal required')
    for path, digest in ((POST_CLEANUP_SEAL, expected_sha),
                         (POST_CLEANUP_RECEIPT, HISTORY_POST_CLEANUP_RECEIPT_SHA256)):
        require(path.is_file() and not path.is_symlink()
                and path.stat().st_nlink == 1 and path.stat().st_uid == os.geteuid()
                and stat.S_IMODE(path.stat().st_mode) == 0o600
                and hashlib.sha256(path.read_bytes()).hexdigest() == digest,
                'Post-cleanup private sealed evidence changed')
    seal = json.loads(POST_CLEANUP_SEAL.read_text())
    policy = json.loads((source / 'deploy/aws' / (HISTORY_POST_CLEANUP_POLICY_ID + '.json')).read_text())
    require(seal.get('version') == 1 and seal.get('userApproved') is True
            and seal.get('policyId') == HISTORY_POST_CLEANUP_POLICY_ID
            and seal.get('expectedCurrent') == HISTORY_POST_CLEANUP_BASELINE
            and seal.get('activeDatabase') == HISTORY_POST_CLEANUP_DATABASE
            and seal.get('candidateCommit') == candidate_commit
            and seal.get('candidateTree') == candidate_tree
            and re.fullmatch(r'[a-f0-9]{40}', candidate_commit or '') is not None
            and re.fullmatch(r'[a-f0-9]{40}', candidate_tree or '') is not None
            and candidate_commit != HISTORY_POST_CLEANUP_BASELINE
            and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{5,299}', seal.get('approvalReference', '')) is not None
            and re.fullmatch(r'sha256:[a-f0-9]{64}', seal.get('apiImage', '')) is not None
            and seal.get('policySha256') == historical_fingerprint(policy)
            and seal.get('sourceAnchorSha256') == policy.get('sourceAnchorSha256')
            and policy.get('id') == HISTORY_POST_CLEANUP_POLICY_ID
            and policy.get('userApproved') is False
            and policy.get('activation') == 'EXTERNAL_REVIEWED_SEAL_REQUIRED'
            and policy.get('expectedCurrent') == HISTORY_POST_CLEANUP_BASELINE
            and policy.get('activeDatabase') == HISTORY_POST_CLEANUP_DATABASE
            and policy.get('cleanupReceiptSha256') == HISTORY_POST_CLEANUP_RECEIPT_SHA256
            and policy.get('checkCount') == 49
            and seal.get('candidateBindingsSha256') == historical_fingerprint(policy.get('candidateBindings')),
            'Post-cleanup reviewed candidate seal changed')
    bindings = policy.get('candidateBindings', {}).get('sourceSha256', {})
    require(isinstance(bindings, dict) and bool(bindings), 'Post-cleanup candidate source missing')
    for name, digest in bindings.items():
        require(isinstance(name, str) and '..' not in name
                and re.fullmatch(r'(apps/api/src/id-business-v2/|scripts/|packages/shared/src/)[A-Za-z0-9_./-]+', name)
                and name != 'scripts/lib/v2-release-history-policy.mjs'
                and isinstance(digest, str) and re.fullmatch(r'[a-f0-9]{64}', digest),
                'Post-cleanup source boundary changed')
        path = source / name
        require(path.is_file() and not path.is_symlink()
                and hashlib.sha256(path.read_bytes()).hexdigest() == digest,
                'Post-cleanup candidate source changed')
    return policy, seal


def reviewed_order_archive_seal(source, expected_sha, candidate_commit, candidate_tree,
                                prepared_sha, image_run, image_attempt):
    require(re.fullmatch(r'[a-f0-9]{64}', expected_sha or '') is not None
            and re.fullmatch(r'[1-9][0-9]*', image_run or '') is not None
            and re.fullmatch(r'[1-9][0-9]*', image_attempt or '') is not None,
            'Reviewed order archive external seal required')
    for path, digest in ((ORDER_ARCHIVE_SEAL, expected_sha),
                         (POST_CLEANUP_RECEIPT, HISTORY_POST_CLEANUP_RECEIPT_SHA256)):
        raw = private_maintenance_receipt(path)
        require(stat.S_IMODE(path.stat().st_mode) == 0o600
                and hashlib.sha256(raw).hexdigest() == digest,
                'Order archive private reviewed evidence changed')
    seal = json.loads(private_maintenance_receipt(ORDER_ARCHIVE_SEAL))
    policy = json.loads((source / 'deploy/aws' / (HISTORY_ORDER_ARCHIVE_POLICY_ID + '.json')).read_text())
    bindings = policy.get('candidateBindings', {})
    require(seal.get('version') == 1 and seal.get('userApproved') is True
            and seal.get('policyId') == HISTORY_ORDER_ARCHIVE_POLICY_ID
            and seal.get('scope') == 'API_ADMIN_ORDER_ARCHIVE'
            and seal.get('expectedCurrent') == HISTORY_ORDER_ARCHIVE_BASELINE
            and seal.get('historicalSourceBaseline') == HISTORY_POST_CLEANUP_BASELINE
            and seal.get('activeDatabase') == HISTORY_POST_CLEANUP_DATABASE
            and seal.get('candidateCommit') == candidate_commit
            and seal.get('candidateTree') == candidate_tree
            and candidate_commit != HISTORY_ORDER_ARCHIVE_BASELINE
            and re.fullmatch(r'[a-f0-9]{40}', candidate_commit or '') is not None
            and re.fullmatch(r'[a-f0-9]{40}', candidate_tree or '') is not None
            and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{5,299}', seal.get('approvalReference', '')) is not None
            and re.fullmatch(r'[a-f0-9]{64}', prepared_sha or '') is not None
            and seal.get('preparedImagesSha256') == prepared_sha
            and seal.get('preparationRunId') == int(image_run)
            and seal.get('preparationRunAttempt') == int(image_attempt)
            and seal.get('policySha256') == historical_fingerprint(policy)
            and seal.get('candidateBindingsSha256') == historical_fingerprint(bindings)
            and seal.get('sourceTree') == bindings.get('sourceTree')
            and seal.get('sourceAnchorSha256') == policy.get('sourceAnchorSha256')
            and seal.get('cleanupReceiptSha256') == HISTORY_POST_CLEANUP_RECEIPT_SHA256
            and policy.get('id') == HISTORY_ORDER_ARCHIVE_POLICY_ID
            and policy.get('userApproved') is False
            and policy.get('activation') == 'EXTERNAL_REVIEWED_SEAL_REQUIRED'
            and policy.get('expectedCurrent') == HISTORY_ORDER_ARCHIVE_BASELINE
            and policy.get('historicalSourceBaseline') == HISTORY_POST_CLEANUP_BASELINE
            and policy.get('activeDatabase') == HISTORY_POST_CLEANUP_DATABASE
            and policy.get('cleanupReceiptSha256') == HISTORY_POST_CLEANUP_RECEIPT_SHA256
            and policy.get('checkCount') == 49
            and isinstance(seal.get('images'), dict) and set(seal['images']) == {'api', 'admin', 'migrate'}
            and all(re.fullmatch(r'sha256:[a-f0-9]{64}', value or '') for value in seal['images'].values())
            and seal.get('migration') == bindings.get('migration')
            and bindings.get('migration', {}).get('name') == ORDER_ARCHIVE_MIGRATION
            and bindings.get('migration', {}).get('sqlSha256') == ORDER_ARCHIVE_MIGRATION_SHA256,
            'Order archive reviewed candidate seal changed')
    return policy, seal


def require_order_archive_source_scope(release, policy):
    bindings = policy['candidateBindings']
    hashes, modes = bindings.get('sourceSha256'), bindings.get('sourceGitModes')
    policy_path = 'deploy/aws/' + HISTORY_ORDER_ARCHIVE_POLICY_ID + '.json'
    entries = list(release.rglob('*'))
    require(all(not path.is_symlink() for path in entries), 'Order archive source contains a linked entry')
    files = {str(path.relative_to(release)): path for path in entries if not path.is_dir()}
    files.pop(policy_path, None)
    require(isinstance(hashes, dict) and bool(hashes) and isinstance(modes, dict)
            and set(files) == set(hashes) == set(modes) and policy_path not in hashes,
            'Order archive complete source projection changed')
    tree = {}
    for name, path in files.items():
        mode = modes[name]
        require(mode in ('100644', '100755') and path.is_file() and not path.is_symlink()
                and path.stat().st_nlink == 1 and '..' not in Path(name).parts
                and stat.S_IMODE(path.stat().st_mode) in ((0o644, 0o664) if mode == '100644' else (0o755, 0o775)),
                'Order archive source entry mode changed')
        raw = path.read_bytes()
        require(hashlib.sha256(raw).hexdigest() == hashes[name], 'Order archive candidate source changed')
        oid = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).digest()
        parent = tree
        parts = Path(name).parts
        for part in parts[:-1]:
            parent = parent.setdefault(part, {})
        parent[parts[-1]] = (mode, oid)
    def git_tree(entries):
        raw = b''
        for name, value in sorted(entries.items(), key=lambda item: (item[0] + '/' if isinstance(item[1], dict) else item[0]).encode()):
            mode, oid = ('40000', git_tree(value)) if isinstance(value, dict) else value
            raw += mode.encode() + b' ' + name.encode() + b'\0' + oid
        return hashlib.sha1(b'tree ' + str(len(raw)).encode() + b'\0' + raw).digest()
    require(git_tree(tree).hex() == bindings.get('sourceTree'), 'Order archive source projection tree changed')
    migration = release / 'apps/api/prisma-mysql/migrations' / ORDER_ARCHIVE_MIGRATION / 'migration.sql'
    require(hashlib.sha256(migration.read_bytes()).hexdigest() == ORDER_ARCHIVE_MIGRATION_SHA256
            and hashlib.sha256((release / 'apps/api/prisma-mysql/schema.prisma').read_bytes()).hexdigest()
                == bindings['migration'].get('mysqlSchemaSha256'), 'Order archive migration source changed')


def require_order_archive_preservation(previous, release, expected_environment, states):
    require_diagnostics_environment_unchanged(previous, release, expected_environment)
    for name in ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws'):
        require((previous / name).read_bytes() == (release / name).read_bytes(),
                'Order archive publication changed runtime configuration')
    current = {service: service_state(previous, service, include_container_id=True, include_environment_hash=True)
               for service in states if service not in ('api', 'admin')}
    require(all(current[service] == states[service] for service in current),
            'Order archive publication changed a preserved service container')


def require_order_archive_schema_change(previous, release, policy):
    migration = policy['candidateBindings']['migration']
    baseline = (previous / 'apps/api/prisma-mysql/schema.prisma').read_bytes()
    candidate = (release / 'apps/api/prisma-mysql/schema.prisma').read_bytes()
    field = b'  archivedAt                   DateTime?                           @map("archived_at") @db.DateTime(6)\n'
    index = b'  @@index([deletedAt, archivedAt, createdAt, id], map: "id_business_v2_orders_archive_list_idx")\n'
    require(hashlib.sha256(baseline).hexdigest() == migration.get('baselineMysqlSchemaSha256')
            and hashlib.sha256(candidate).hexdigest() == migration.get('mysqlSchemaSha256')
            and candidate.count(field) == candidate.count(index) == 1
            and candidate.replace(field, b'', 1).replace(index, b'', 1) == baseline,
            'Order archive publication changed schema beyond its nullable field and index')


def require_order_archive_baseline(previous, manifest, states):
    require(manifest.get('commit') == HISTORY_ORDER_ARCHIVE_BASELINE
            and manifest.get('sourceTree') == ORDER_ARCHIVE_BASELINE_TREE
            and has_registration_worker(previous), 'Order archive current runtime baseline changed')
    verify_continuation_running_images(states, manifest)
    override = json.loads((previous / 'compose.release.json').read_text())
    require(set(override) == {'services'} and set(override['services']) == {*SERVICES, 'migrate'}
            and all(override['services'][service].get('image') == states[service]['reference']
                    and override['services'][service].get('pull_policy') == 'never'
                    for service in SERVICES), 'Order archive current runtime image declarations changed')


def verify_order_archive_admin_build(release, policy):
    hashes = policy['candidateBindings'].get('adminBuildHashes', {})
    require(isinstance(hashes, dict) and 'apps/admin/dist/index.html' in hashes and 0 < len(hashes) <= 4096,
            'Order archive Admin build evidence missing')
    paths = {}
    for name, digest in hashes.items():
        require(re.fullmatch(r'apps/admin/dist/[A-Za-z0-9_./-]+', name or '') is not None
                and '..' not in Path(name).parts and re.fullmatch(r'[a-f0-9]{64}', digest or '') is not None,
                'Order archive Admin build source changed')
        paths['/usr/share/nginx/html/' + name.removeprefix('apps/admin/dist/')] = digest
    output = compose(release, 'run', '--rm', '--no-deps', '--pull', 'never',
        '--entrypoint', 'sh', 'admin', '-ec',
        'find /usr/share/nginx/html -type f -exec sha256sum {} +; find /usr/share/nginx/html -type l -print',
        timeout=240)
    actual = {}
    for line in output.splitlines():
        digest, separator, name = line.partition('  ')
        require(separator and name not in actual, 'Order archive Admin build evidence malformed')
        # The pinned nginx base includes this error page; Vite does not emit it.
        if name == '/usr/share/nginx/html/50x.html' and name not in paths:
            continue
        actual[name] = digest
    require(actual == paths, 'Order archive Admin image build changed')
    return {'verifiedFiles': len(paths), 'sha256': historical_fingerprint(hashes)}


def order_archive_audit(directory, receipt, *, stage, source, before_receipt,
                        seal_sha, candidate_commit, candidate_tree, prepared_sha, image_run, image_attempt):
    policy, seal = reviewed_order_archive_seal(source, seal_sha, candidate_commit, candidate_tree,
                                               prepared_sha, image_run, image_attempt)
    require(stage in ('before', 'after'), 'Order archive audit stage missing')
    override = json.loads((directory / 'compose.release.json').read_text())
    image = json.loads(run('docker', 'image', 'inspect', override['services']['api']['image']))[0]
    require(image['Id'] == seal['images']['api'], 'Order archive audit image changed')
    values = environment_values(directory / '.env.aws.production')
    url = maintenance_container_audit_url(values)
    env = os.environ.copy(); env['V2_DATA_INTEGRITY_DATABASE_URL'] = url
    identity = historical_audit_reader(directory, 'api')
    seal_reader = prepare_post_cleanup_reader_copy(directory, ORDER_ARCHIVE_SEAL, seal_sha,
        'order-archive-seal.reader.json', identity)
    cleanup_reader = prepare_post_cleanup_reader_copy(directory, POST_CLEANUP_RECEIPT,
        HISTORY_POST_CLEANUP_RECEIPT_SHA256, 'order-archive-cleanup.reader.json', identity)
    mounts = ['-v', f'{source / "scripts"}:/app/scripts:ro', '-v', f'{source / "deploy/aws"}:/release-policy:ro',
              '-v', f'{seal_reader}:/release-order-archive-seal.json:ro',
              '-v', f'{cleanup_reader}:/release-cleanup-receipt.json:ro']
    arguments = ['node', 'scripts/v2-order-archive-release-audit.mjs',
        f'--policy=/release-policy/{HISTORY_ORDER_ARCHIVE_POLICY_ID}.json',
        f'--expected-current={HISTORY_ORDER_ARCHIVE_BASELINE}', f'--stage={stage}',
        '--order-archive-seal=/release-order-archive-seal.json', f'--order-archive-seal-sha256={seal_sha}',
        '--cleanup-receipt=/release-cleanup-receipt.json',
        f'--candidate-commit={candidate_commit}', f'--candidate-tree={candidate_tree}']
    if stage == 'after':
        require(before_receipt is not None, 'Order archive before audit missing')
        prepare_historical_before_receipt(directory, before_receipt, 'api')
        mounts.extend(['-v', f'{before_receipt}:/release-before-audit.json:ro'])
        arguments.append('--before-receipt=/release-before-audit.json')
    report = json.loads(compose(directory, 'run', '--rm', '--no-deps', '--pull', 'never',
        *mounts, '-e', 'V2_DATA_INTEGRITY_DATABASE_URL', 'api', *arguments, env=env, timeout=240))
    gate = report.get('gate', {})
    require(report.get('ok') is False and report.get('checkCount') == gate.get('checkCount') == 49
            and report.get('violationCount') == gate.get('violationCount') == 5
            and gate.get('executedCheckCount') == 49 and gate.get('unavailableCheckCount') == 0
            and gate.get('accepted') is True and gate.get('policyId') == HISTORY_ORDER_ARCHIVE_POLICY_ID
            and gate.get('status') == 'APPROVED_ORDER_ARCHIVE_HISTORICAL_EXCEPTIONS'
            and gate.get('scope') == 'API_ADMIN_ORDER_ARCHIVE' and gate.get('stage') == stage
            and gate.get('candidateCommit') == candidate_commit and gate.get('candidateTree') == candidate_tree
            and gate.get('sourceTree') == policy['candidateBindings']['sourceTree']
            and gate.get('releaseSealSha256') == seal_sha and gate.get('images') == seal['images']
            and gate.get('expectedCurrent') == HISTORY_ORDER_ARCHIVE_BASELINE
            and gate.get('historicalSourceBaseline') == HISTORY_POST_CLEANUP_BASELINE
            and gate.get('sourceAnchorSha256') == policy['sourceAnchorSha256']
            and gate.get('sources') == {name: {'rowCount': group['rowCount'], 'sha256': group['sha256']}
                                       for name, group in policy['sources'].items()}
            and gate.get('metadataSha256') == policy['metadataSha256']
            and gate.get('cleanupReceiptSha256') == HISTORY_POST_CLEANUP_RECEIPT_SHA256
            and gate.get('migration') == seal['migration']
            and gate.get('preparedImagesSha256') == prepared_sha
            and gate.get('preparationRunId') == int(image_run) and gate.get('preparationRunAttempt') == int(image_attempt),
            'Reviewed order archive historical integrity gate failed')
    receipt.write_text(json.dumps(report, indent=2) + '\n'); receipt.chmod(0o600)
    return {'checkCount': 49, 'violationCount': 5, 'historicalException': gate}


def audit(directory, receipt, *, historical_exception=False, historical_continuation=False,
          historical_diagnostics=False, historical_maintenance=False, historical_mailbox=False,
          historical_post_cleanup=False, post_cleanup_seal_sha256=None,
          historical_order_archive=False, order_archive_seal_sha256=None,
          order_archive_prepared_sha256=None, image_run=None, image_attempt=None,
          candidate_commit=None, candidate_tree=None, stage=None, source=None,
          before_receipt=None, origin=None):
    require(sum((historical_exception, historical_continuation, historical_diagnostics,
                 historical_maintenance, historical_mailbox, historical_post_cleanup,
                 historical_order_archive)) <= 1,
            'Historical release selection is ambiguous')
    if historical_mailbox:
        return mailbox_audit(directory, receipt, stage=stage, source=source,
                             before_receipt=before_receipt, origin=origin)
    if historical_order_archive:
        return order_archive_audit(directory, receipt, stage=stage, source=source,
            before_receipt=before_receipt, seal_sha=order_archive_seal_sha256,
            candidate_commit=candidate_commit, candidate_tree=candidate_tree,
            prepared_sha=order_archive_prepared_sha256, image_run=image_run, image_attempt=image_attempt)
    if historical_maintenance:
        return maintenance_audit(directory, receipt, stage=stage, source=source,
                                 before_receipt=before_receipt, origin=origin)
    policy_id = (HISTORY_POST_CLEANUP_POLICY_ID if historical_post_cleanup else
                 HISTORY_DIAGNOSTICS_POLICY_ID if historical_diagnostics else
                 HISTORY_CONTINUATION_POLICY_ID if historical_continuation else HISTORY_POLICY_ID)
    baseline = (HISTORY_POST_CLEANUP_BASELINE if historical_post_cleanup else
                HISTORY_DIAGNOSTICS_BASELINE if historical_diagnostics else
                HISTORY_CONTINUATION_BASELINE if historical_continuation else HISTORY_BASELINE)
    historical = historical_exception or historical_continuation or historical_diagnostics or historical_post_cleanup
    policy = continuation_policy(source, policy_id) if historical_continuation or historical_diagnostics else None
    audit_service = 'api' if historical_post_cleanup else 'migrate'
    if historical_post_cleanup:
        require(source is not None, 'Post-cleanup candidate source missing')
        policy, release_seal = reviewed_post_cleanup_seal(source, post_cleanup_seal_sha256, candidate_commit, candidate_tree)
        require(stage in ('before', 'after'), 'Post-cleanup audit stage missing')
        runtime_state = service_state(directory, 'api')
        runtime_image = runtime_state['image']
        require(json.loads((directory / 'compose.release.json').read_text()).get('services', {})
                .get('api', {}).get('image') == runtime_state['reference'],
                'Post-cleanup audit API reference changed')
        require(json.loads(run('docker', 'image', 'inspect', runtime_state['reference']))[0]['Id'] == runtime_image,
                'Post-cleanup audit API image provenance changed')
        if stage == 'after':
            require(runtime_image == release_seal['apiImage'], 'Post-cleanup API image changed')
    values = environment_values(directory / '.env.aws.production')
    audit_url = values.get('V2_DATA_INTEGRITY_DATABASE_URL')
    require(bool(audit_url), 'Read-only audit database URL missing')
    parts = urlsplit(audit_url)
    require(parts.scheme == 'mysql' and parts.hostname in ('127.0.0.1', 'localhost'),
            'Unexpected read-only audit database host')
    userinfo, separator, _host = parts.netloc.rpartition('@')
    require(bool(separator and userinfo), 'Read-only audit database credentials missing')
    container_url = urlunsplit(parts._replace(
        netloc=f'{userinfo}@mysql' + (f':{parts.port}' if parts.port else '')))
    env = os.environ.copy()
    env['V2_DATA_INTEGRITY_DATABASE_URL'] = container_url
    audit_args = ['node', 'scripts/v2-data-integrity-audit.mjs']
    mounts = ['-v', f'{directory / "scripts"}:/app/scripts:ro']
    if historical:
        require(stage in ('before', 'after') and source is not None,
                'Historical exception audit source missing')
        mounts = ['-v', f'{source / "scripts"}:/app/scripts:ro',
                  '-v', f'{source / "deploy/aws"}:/release-policy:ro']
        audit_args = ['node', 'scripts/v2-release-history-audit.mjs',
                      f'--policy=/release-policy/{policy_id}.json',
                      f'--expected-current={baseline}',
                      f'--stage={stage}']
        if historical_post_cleanup:
            identity = historical_audit_reader(directory, audit_service)
            seal_reader = prepare_post_cleanup_reader_copy(directory, POST_CLEANUP_SEAL,
                post_cleanup_seal_sha256, 'post-cleanup-seal.reader.json', identity)
            cleanup_reader = prepare_post_cleanup_reader_copy(directory, POST_CLEANUP_RECEIPT,
                HISTORY_POST_CLEANUP_RECEIPT_SHA256, 'post-cleanup-receipt.reader.json', identity)
            mounts.extend(['-v', f'{seal_reader}:/release-post-cleanup-seal.json:ro',
                           '-v', f'{cleanup_reader}:/release-cleanup-receipt.json:ro'])
            audit_args.extend(['--post-cleanup-seal=/release-post-cleanup-seal.json',
                               '--cleanup-receipt=/release-cleanup-receipt.json',
                               f'--post-cleanup-seal-sha256={post_cleanup_seal_sha256}',
                               f'--candidate-commit={candidate_commit}', f'--candidate-tree={candidate_tree}'])
        if stage == 'after':
            require(before_receipt is not None, 'Historical before audit missing')
            prepare_historical_before_receipt(directory, before_receipt, audit_service)
            mounts.extend(['-v', f'{before_receipt}:/release-before-audit.json:ro'])
            audit_args.append('--before-receipt=/release-before-audit.json')
    output = compose(
        directory, 'run', '--rm', '--no-deps',
        *mounts,
        '-e', 'V2_DATA_INTEGRITY_DATABASE_URL',
        audit_service, *audit_args,
        env=env, timeout=240,
    )
    report = json.loads(output)
    if historical:
        gate = report.get('gate', {})
        if historical_post_cleanup:
            require(report.get('ok') is False and report.get('checkCount') == 49
                    and report.get('violationCount') == gate.get('violationCount') == 5
                    and gate.get('accepted') is True and gate.get('policyId') == policy_id
                    and gate.get('status') == 'APPROVED_POST_CLEANUP_HISTORICAL_EXCEPTIONS'
                    and gate.get('expectedCurrent') == baseline and gate.get('stage') == stage
                    and gate.get('checkCount') == gate.get('executedCheckCount') == 49
                    and gate.get('unavailableCheckCount') == 0
                    and gate.get('releaseSealSha256') == post_cleanup_seal_sha256
                    and gate.get('candidateCommit') == candidate_commit
                    and gate.get('candidateTree') == candidate_tree
                    and gate.get('sourceAnchorSha256') == policy['sourceAnchorSha256']
                    and gate.get('sources') == {name: {'rowCount': group['rowCount'], 'sha256': group['sha256']}
                                                for name, group in policy['sources'].items()}
                    and gate.get('metadataSha256') == policy['metadataSha256']
                    and gate.get('cleanupReceiptSha256') == HISTORY_POST_CLEANUP_RECEIPT_SHA256
                    and gate.get('apiImage') == release_seal['apiImage']
                    and report.get('identity', {}).get('databaseName') == HISTORY_POST_CLEANUP_DATABASE
                    and str(report['identity'].get('readOnly')) == '0'
                    and str(report['identity'].get('superReadOnly')) == '0'
                    and str(report['identity'].get('sessionReadOnly')) == '1'
                    and report['identity'].get('currentUser', '').split('@')[0] == 'id_business_audit'
                    and report['identity'].get('transactionIsolation') == 'REPEATABLE-READ'
                    and str(report['identity'].get('foreignKeyChecks')) == '1',
                    'Approved post-cleanup integrity gate failed')
            require(service_state(directory, 'api')['image'] == runtime_image,
                    'Post-cleanup audit API runtime changed')
            receipt.write_text(json.dumps(report, indent=2) + '\n')
            receipt.chmod(0o600)
            return {'checkCount': 49, 'violationCount': 5, 'historicalException': gate}
        require(gate.get('accepted') is True and gate.get('policyId') == policy_id
                and gate.get('expectedCurrent') == baseline
                and gate.get('stage') == stage and gate.get('checkCount') == 48
                and report.get('violationCount') == gate.get('violationCount') == 10
                and (stage != 'after' or gate.get('unavailableCheckCount') == 0),
                'Approved historical integrity gate failed')
        if historical_continuation or historical_diagnostics:
            require(report.get('ok') is False and report.get('checkCount') == 48
                    and gate.get('status') == 'APPROVED_HISTORICAL_EXCEPTIONS'
                    and gate.get('executedCheckCount') == 48
                    and gate.get('unavailableCheckCount') == 0
                    and gate.get('continuationOf') == HISTORY_POLICY_ID
                    and gate.get('fixedCurrent') == baseline
                    and gate.get('continuation') == policy['continuation']
                    and gate.get('metadataSha256') == policy['continuation']['metadataSha256']
                    and gate.get('sources') == {
                        name: group['sha256'] for name, group in policy['sources'].items()},
                    'Approved historical continuation integrity gate failed')
    else:
        require(report.get('ok') is True and report.get('violationCount') == 0,
                'Financial data integrity audit failed')
    receipt.write_text(json.dumps(report, indent=2) + '\n')
    receipt.chmod(0o600)
    return {'checkCount': report.get('checkCount'), 'violationCount': report.get('violationCount'),
            **({'historicalException': report['gate']} if historical else {})}


def current_job_database(directory):
    # mysql's initdb environment can still name the old schema after a reviewed
    # cutover. Verify configuration and the live API connection before any lease read.
    try:
        values = environment_values(directory / '.env.aws.production')
        database = values.get('MYSQL_DATABASE')
        endpoint = urlsplit(values.get('DATABASE_URL', ''))
        require(isinstance(database, str) and re.fullmatch(r'[A-Za-z0-9_]{1,64}', database)
                and endpoint.scheme == 'mysql' and endpoint.hostname == 'mysql'
                and endpoint.username == 'id_business_app' and bool(endpoint.password)
                and endpoint.path == '/' + database and not endpoint.fragment
                and (endpoint.port is None or 1 <= endpoint.port <= 65535),
                'Production database configuration invalid')
    except Exception:
        raise RuntimeError('Production database configuration invalid') from None
    # Credentials stay inside the running API. Only validated schema names leave it.
    probe = '''const {PrismaClient}=require('@prisma/client');
let client;
(async()=>{
 try {
  const endpoint=new URL(process.env.DATABASE_URL);
  const configuredDatabase=endpoint.pathname.slice(1);
  if(endpoint.protocol!=='mysql:'||endpoint.hostname!=='mysql'
     ||endpoint.username!=='id_business_app'||!endpoint.password||endpoint.hash
     ||! /^[A-Za-z0-9_]{1,64}$/.test(configuredDatabase))throw Error();
  client=new PrismaClient();
  const rows=await client.$queryRawUnsafe('SELECT DATABASE() AS databaseName');
  const actualDatabase=rows.length===1?rows[0].databaseName:null;
  if(typeof actualDatabase!=='string'||! /^[A-Za-z0-9_]{1,64}$/.test(actualDatabase))throw Error();
  console.log(JSON.stringify({configuredDatabase,actualDatabase}));
 } catch {
  console.error('Production database identity unavailable');process.exitCode=1;
 } finally {if(client)await client.$disconnect().catch(()=>{});}
})();'''
    try:
        identity = json.loads(compose(directory, 'exec', '-T', 'api', 'node', '-e', probe,
                                      timeout=30))
        require(isinstance(identity, dict)
                and set(identity) == {'configuredDatabase', 'actualDatabase'}
                and all(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_]{1,64}', value)
                        for value in identity.values()),
                'Production database identity unavailable')
    except Exception:
        raise RuntimeError('Production database identity unavailable') from None
    require(identity['configuredDatabase'] == identity['actualDatabase'] == database,
            'Production database identity mismatch')
    return database


def assert_no_active_recharge(directory):
    database = current_job_database(directory)
    count = compose(
        directory, 'exec', '-e', 'MYSQL_DATABASE=' + database, '-T', 'mysql', 'sh', '-c',
        "mysql --batch --skip-column-names -u root --password=\"$MYSQL_ROOT_PASSWORD\" "
        "\"$MYSQL_DATABASE\" -e \"SELECT COUNT(*) FROM id_business_v2_recharge_jobs "
        "WHERE state <> 0x66696e6973686564 AND lease_until > UTC_TIMESTAMP(6)\"",
    )
    require(count == '0', 'Active recharge jobs prevent release')


def registration_runtime_state(directory):
    # Only the running Worker's authenticated loopback health is read. The token
    # remains in that container; neither response bodies nor exceptions are logged.
    probe = '''import json, os, urllib.request, urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None
request = urllib.request.Request('http://127.0.0.1:8051/registration/health',
    headers={'X-Recharge-Worker': os.environ.get('AUTO_RECHARGE_WORKER_TOKEN', '')})
try:
    with urllib.request.build_opener(NoRedirect).open(request, timeout=3) as response:
        value = json.loads(response.read(16384))
    if (not isinstance(value, dict) or value.get('ready') is not True
            or value.get('engine') != 'camoufox'
            or (required_role is not None and value.get('workerRole') != required_role)
            or type(value.get('registrationBusy')) is not bool
            or type(value.get('registrationWindowRetained')) is not bool):
        raise ValueError()
    print(json.dumps({'supported': True,
        'registrationBusy': value['registrationBusy'],
        'registrationWindowRetained': value['registrationWindowRetained']}))
except urllib.error.HTTPError as error:
    if error.code != 404:
        raise SystemExit('Registration runtime guard unavailable') from None
    print(json.dumps({'supported': False}))
except Exception:
    raise SystemExit('Registration runtime guard unavailable') from None
'''
    try:
        service = 'auto-registration' if has_registration_worker(directory) else 'auto-recharge'
        probe = 'required_role = ' + repr('registration' if service == 'auto-registration' else None) + '\n' + probe
        value = json.loads(compose(directory, 'exec', '-T', service,
                                   'python', '-c', probe, timeout=15))
    except Exception:
        raise RuntimeError('Registration runtime guard unavailable') from None
    if (isinstance(value, dict) and set(value) == {'supported'}
            and value['supported'] is False):
        require(service == 'auto-recharge', 'Registration runtime guard unavailable')
        return value
    require(isinstance(value, dict) and set(value) == {
        'supported', 'registrationBusy', 'registrationWindowRetained'}
        and value['supported'] is True
        and type(value['registrationBusy']) is bool
        and type(value['registrationWindowRetained']) is bool,
        'Registration runtime guard unavailable')
    return value


def assert_no_active_registration(directory):
    runtime = registration_runtime_state(directory)
    require(not runtime.get('registrationBusy')
            and not runtime.get('registrationWindowRetained'),
            'Active registration jobs prevent release')
    # A new Worker also protects a dispatched attempt before its profile receipt.
    # Legacy Workers have no built-in windows; only explicit reg_ active attempts
    # are protected there. Historical partial rows alone cannot prove occupancy.
    builtin_filter = '' if runtime['supported'] else (
        ' AND LEFT(browser_profile_id, 4) = 0x7265675f')
    database = current_job_database(directory)
    count = compose(
        directory, 'exec', '-e', 'MYSQL_DATABASE=' + database, '-T', 'mysql', 'sh', '-c',
        'mysql --batch --skip-column-names -u root --password="$MYSQL_ROOT_PASSWORD" '
        '"$MYSQL_DATABASE" -e "SELECT COUNT(*) FROM id_business_v2_registration_jobs '
        'WHERE state IN (0x72756e6e696e67, 0x6177616974696e675f656d61696c, '
        '0x6177616974696e675f75736572) AND lease_until > UTC_TIMESTAMP(6)'
        + builtin_filter + '"',
    )
    require(count == '0', 'Active registration jobs prevent release')


def assert_no_active_jobs(directory, *, worker_changes):
    assert_no_active_recharge(directory)
    if worker_changes:
        assert_no_active_registration(directory)


def assert_release_jobs_idle(directory, services, *, mailbox_only=False):
    if mailbox_only:
        # User explicitly identified the other window's external browser test and
        # asked this release to proceed. Only API publication may use this entry.
        require(tuple(services) == ('api',), 'Mailbox release cannot restart a test executor')
        verify_mailbox_baseline(directory)
        return
    assert_no_active_jobs(directory,
        worker_changes=registration_worker_changes(directory, services))


def registration_worker_changes(directory, services):
    return ('auto-registration' in services
            or ('auto-recharge' in services and not has_registration_worker(directory)))


def require_diagnostics_registration_isolation(previous, manifest, states):
    # Only the immutable successful split baseline can skip the registration idle
    # guard before candidate extraction. Full candidate source proof is still required.
    data = private_historical_receipt(previous / 'release-manifest.json')
    require(hashlib.sha256(data).hexdigest() == DIAGNOSTICS_MANIFEST_SHA256
            and json.loads(data) == manifest
            and manifest.get('commit') == HISTORY_DIAGNOSTICS_BASELINE,
            'Historical diagnostics running manifest changed')
    require(hashlib.sha256((previous / 'docker-compose.aws-mysql.yml').read_bytes()).hexdigest()
            == DIAGNOSTICS_COMPOSE_SHA256 and has_registration_worker(previous),
            'Historical diagnostics requires the fixed independent worker layout')
    verify_continuation_running_images(states, manifest)
    registration = manifest.get('images', {}).get('auto-registration', {})
    override_data = (previous / 'compose.release.json').read_bytes()
    override = json.loads(override_data)
    # The frozen runtime override has six services; the manifest can also retain
    # historical image records that are not runtime service declarations.
    expected_override = {'services': {service: {
        'image': manifest['images'].get(service, {}).get('reference'), 'pull_policy': 'never'}
        for service in (*SERVICES, 'migrate')}}
    require(hashlib.sha256(override_data).hexdigest() == DIAGNOSTICS_OVERRIDE_RAW_SHA256
        and historical_fingerprint(override) == DIAGNOSTICS_OVERRIDE_CANONICAL_SHA256
        and override == expected_override
        and all(isinstance(image['image'], str) and image['image']
                for image in expected_override['services'].values())
        and bool(registration.get('reference'))
        and states.get('auto-registration', {}).get('reference') == registration['reference'],
        'Historical diagnostics image override changed')


def require_diagnostics_environment_unchanged(previous, release, expected):
    require((previous / '.env.aws.production').read_bytes() == expected
            and (release / '.env.aws.production').read_bytes() == expected,
            'Historical diagnostics production environment changed')


def require_post_cleanup_source_scope(previous, release, policy):
    require((previous / 'docker-compose.aws-mysql.yml').read_bytes()
            == (release / 'docker-compose.aws-mysql.yml').read_bytes(),
            'Post-cleanup Compose definition changed')
    # All API runtime files outside the bound financial paths must match the exact running source.
    # The five upstream Python worker changes remain pending source, with their old containers/images preserved.
    def protected_files(root):
        files = [path for path in (root / 'apps/api/src').rglob('*') if path.is_file()
                 and not str(path.relative_to(root)).startswith((
                     'apps/api/src/id-business-v2/finance/', 'apps/api/src/id-business-v2/orders/',
                     'apps/api/src/id-business-v2/auto-recharge/worker/'))]
        for folder in ('apps/api/prisma-mysql', 'packages/shared/src'):
            files.extend(path for path in (root / folder).rglob('*') if path.is_file())
        files.extend(root / name for name in ('package.json', 'package-lock.json',
            'apps/api/package.json', 'apps/api/Dockerfile.mysql', 'packages/shared/package.json',
            'apps/api/tsconfig.json', 'apps/api/tsconfig.build.json'))
        require(all(path.is_file() and not path.is_symlink() for path in files),
                'Post-cleanup protected API source unavailable')
        return {str(path.relative_to(root)): (hashlib.sha256(path.read_bytes()).hexdigest(),
                                             path.stat().st_mode & 0o7777) for path in files}
    require(protected_files(previous) == protected_files(release),
            'Post-cleanup contains unrelated API runtime changes')
    bound = set(policy['candidateBindings']['sourceSha256'])
    def unbound_finance_files(root):
        files = []
        for folder in ('apps/api/src/id-business-v2/finance', 'apps/api/src/id-business-v2/orders'):
            files.extend(path for path in (root / folder).rglob('*') if path.is_file()
                         and str(path.relative_to(root)) not in bound)
        require(all(not path.is_symlink() for path in files), 'Post-cleanup unbound financial source unavailable')
        return {str(path.relative_to(root)): (hashlib.sha256(path.read_bytes()).hexdigest(),
                                             path.stat().st_mode & 0o7777) for path in files}
    require(unbound_finance_files(previous) == unbound_finance_files(release),
            'Post-cleanup contains unbound financial source changes')
    def worker_files(root):
        return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in (root / 'apps/api/src/id-business-v2/auto-recharge/worker').rglob('*')
                if path.is_file() and not path.is_symlink()}
    old_worker = worker_files(previous); new_worker = worker_files(release)
    pending = {name: {'previousSha256': old_worker.get(name), 'candidateSha256': new_worker.get(name)}
               for name in sorted(set(old_worker) | set(new_worker)) if old_worker.get(name) != new_worker.get(name)}
    allowed_pending = {name for name in DIAGNOSTICS_CANDIDATE_FILES
                       if name.startswith('apps/api/src/id-business-v2/auto-recharge/worker/')}
    require(set(pending) <= allowed_pending, 'Post-cleanup contains unreviewed pending worker source changes')
    return pending


def require_post_cleanup_preservation(previous, release, environment, before):
    require_diagnostics_environment_unchanged(previous, release, environment)
    current = {service: service_state(previous, service, include_container_id=True,
        include_environment_hash=True) for service in before if service != 'api'}
    require(current == {service: state for service, state in before.items() if service != 'api'},
            'Post-cleanup preserved service changed')


def post_cleanup_retention_maintenance(release):
    module = runpy.run_path(str(release / 'scripts/production-release/retire-orphan-retention.py'))
    result = module['retire'](apply=True)
    require(isinstance(result, dict) and result.get('ok') is True
            and result.get('status') in ('LEGACY_RETENTION_UNITS_ABSENT', 'LEGACY_RETENTION_ALREADY_RETIRED',
                'LEGACY_RETENTION_TIMER_RETIRED_FAILURE_HISTORY_PRESERVED')
            and result.get('databaseWrites') == result.get('deletedFiles') == 0
            and type(result.get('timerMutations')) is int and result['timerMutations'] in (0, 1),
            'Post-cleanup retention maintenance result unavailable')
    return result


def migration_plan(previous, release):
    old_root = previous / 'apps/api/prisma-mysql/migrations'
    new_root = release / 'apps/api/prisma-mysql/migrations'
    old_files = {str(path.relative_to(old_root)): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in old_root.rglob('*') if path.is_file()}
    new_files = {str(path.relative_to(new_root)): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in new_root.rglob('*') if path.is_file()}
    require(all(new_files.get(name) == digest for name, digest in old_files.items()),
            'Existing migration changed or disappeared')
    additions = sorted(set(new_files) - set(old_files))
    for name in additions:
        require(name.endswith('/migration.sql'), 'Unexpected new migration file')
        sql = (new_root / name).read_text()
        require(not re.search(
            r'\bDROP\s+(?:TABLE|COLUMN|INDEX|DATABASE)\b|\bTRUNCATE\s+TABLE\b|'
            r'(?m:^\s*(?:DELETE\s+FROM|UPDATE\s+`?\w+))', sql, re.I),
                f'Migration requires a separate review: {name}')
    return additions


def fresh_backup(previous):
    run('systemctl', 'start', 'id-business-v2-mysql-backup.service', timeout=600)
    require(run('systemctl', 'show', 'id-business-v2-mysql-backup.service',
                '--property=ExecMainStatus', '--value') == '0', 'Backup service failed')
    backups = sorted((BASE / 'backups/mysql').glob('id-business-v2-*.sql.gz'))
    require(bool(backups) and time.time() - backups[-1].stat().st_mtime < 600,
            'No fresh verified backup')
    backup = backups[-1]
    values = environment_values(previous / '.env.aws.production')
    bucket = values['MYSQL_BACKUP_S3_BUCKET']
    region = values.get('MYSQL_BACKUP_S3_REGION') or 'ap-northeast-1'
    key = values.get('MYSQL_BACKUP_S3_PREFIX', 'mysql/daily').rstrip('/') + '/' + backup.name
    head = json.loads(run('aws', 's3api', 'head-object', '--bucket', bucket, '--key', key,
                          '--checksum-mode', 'ENABLED', '--region', region))
    digest = hashlib.sha256(backup.read_bytes()).digest()
    require(head['ContentLength'] == backup.stat().st_size
            and head.get('ChecksumSHA256') == base64.b64encode(digest).decode()
            and head.get('ServerSideEncryption') == 'AES256', 'S3 backup verification failed')
    return {'name': backup.name, 'sha256': digest.hex(), 'size': backup.stat().st_size,
            's3Verified': True}


def sync_new_table_grants(release, additions):
    tables = []
    for name in additions:
        sql = (release / 'apps/api/prisma-mysql/migrations' / name).read_text()
        tables.extend(re.findall(r'\bCREATE\s+TABLE\s+`([A-Za-z0-9_]+)`', sql, re.I))
    values = environment_values(release / '.env.aws.production')
    parts = urlsplit(values['MIGRATION_DATABASE_URL'])
    require(parts.scheme == 'mysql' and parts.hostname == 'mysql',
            'Unexpected migration database host')
    root_url = urlunsplit(parts._replace(
        netloc=f'root:{quote(values["MYSQL_ROOT_PASSWORD"], safe="")}@mysql'
        + (f':{parts.port}' if parts.port else '')))
    env = os.environ.copy()
    env['DATABASE_URL'] = root_url
    output = compose(
        release, 'run', '--rm', '--no-deps',
        '-v', f'{release / "scripts"}:/app/scripts:ro', '-e', 'DATABASE_URL',
        'migrate', 'node', 'scripts/sync-v2-new-table-grants.mjs', *sorted(set(tables)),
        env=env, timeout=240,
    )
    report = json.loads(output)
    require(report.get('ok') is True, 'New table database grants failed')
    return report


def normalize_worker_isolation(compose_text):
    """Undo only the reviewed split layout for the existing Compose change gate."""
    def worker_block(service):
        matches = re.findall(r'(?ms)^  ' + re.escape(service)
                             + r':\n.*?(?=^  [a-z][a-z0-9-]*:\n|\Z)', compose_text)
        require(len(matches) == 1, 'Invalid independent worker compose layout')
        return matches[0]

    recharge = worker_block('auto-recharge')
    registration = worker_block('auto-registration')
    image = ('    image: &browser-worker-image '
             '${AUTO_RECHARGE_WORKER_IMAGE:-id-business-v2-auto-recharge:local}\n')
    build = ('    build:\n      context: .\n'
             '      dockerfile: apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile\n')
    role = '      AUTO_RECHARGE_WORKER_ROLE: recharge\n'
    require(recharge.count(image) == 1 and recharge.count(build) == 1
            and recharge.count(role) == 1, 'Invalid independent worker compose layout')
    expected = recharge.replace('  auto-recharge:\n', '  auto-registration:\n', 1)
    expected = expected.replace(image, '    image: *browser-worker-image\n', 1)
    expected = expected.replace(build, '', 1).replace(role,
        '      AUTO_RECHARGE_WORKER_ROLE: registration\n', 1)
    expected = expected.replace('      - recharge-control\n', '      - registration-control\n', 1)
    expected = expected.replace('      - recharge-egress\n', '      - registration-egress\n', 1)
    require(registration == expected, 'Invalid independent worker compose layout')
    normalized = compose_text.replace(registration, '', 1)
    normalized = normalized.replace(recharge, recharge.replace(image, '', 1).replace(role, '', 1), 1)
    for binding in (
        '      AUTO_REGISTRATION_WORKER_URL: http://auto-registration:8051\n',
        '      - registration-control\n',
        '  registration-control:\n    internal: true\n  registration-egress:\n',
    ):
        require(normalized.count(binding) == 1, 'Invalid independent worker compose layout')
        normalized = normalized.replace(binding, '', 1)
    return normalized


def configure_google_drive_sync(previous, release):
    old_compose = (previous / 'docker-compose.aws-mysql.yml').read_bytes()
    new_compose = (release / 'docker-compose.aws-mysql.yml').read_bytes()
    old_split = has_registration_worker(previous)
    new_split = has_registration_worker(release)
    require(not old_split or new_split, 'Independent registration worker removed')
    if new_split and not old_split:
        new_compose = normalize_worker_isolation(new_compose.decode()).encode()
    mail_binding = b'      VENDURE_MAILBOX_WEBHOOK_SECRET: ${VENDURE_MAILBOX_WEBHOOK_SECRET:-}\n'
    require(old_compose.count(mail_binding) <= 1 and new_compose.count(mail_binding) <= 1,
            'Duplicate mailbox webhook compose binding')
    if new_compose.count(mail_binding) != old_compose.count(mail_binding):
        require(old_compose.count(mail_binding) == 0 and new_compose.count(mail_binding) == 1,
                'Mailbox webhook compose binding removed')
        new_compose = new_compose.replace(mail_binding, b'')
    config = release / 'deploy/aws/google-drive-sync-folder.json'
    if not config.exists():
        require(new_compose == old_compose, 'Production compose definition changed')
        return None
    destination = json.loads(config.read_text())
    require(isinstance(destination, dict) and set(destination) == {'folderId'}
            and isinstance(destination['folderId'], str)
            and re.fullmatch(r'[A-Za-z0-9_-]{10,200}', destination['folderId']),
            'Invalid reviewed Google Drive folder')
    folder_line = b'      GOOGLE_DRIVE_SYNC_FOLDER_ID: ${GOOGLE_DRIVE_SYNC_FOLDER_ID:-}\n'
    require(new_compose.count(folder_line) == 1, 'Google Drive compose binding changed')
    require(new_compose == old_compose or new_compose.replace(folder_line, b'') == old_compose,
            'Production compose definition changed beyond Google Drive folder binding')
    environment = release / '.env.aws.production'
    text = environment.read_text()
    pattern = r'^GOOGLE_DRIVE_SYNC_FOLDER_ID=.*$'
    require(len(re.findall(pattern, text, re.M)) <= 1, 'Duplicate Google Drive folder setting')
    setting = 'GOOGLE_DRIVE_SYNC_FOLDER_ID=' + destination['folderId']
    if re.search(pattern, text, re.M):
        text = re.sub(pattern, setting, text, flags=re.M)
    else:
        text = text.rstrip('\n') + '\n' + setting + '\n'
    environment.write_text(text)
    environment.chmod(0o600)
    return destination['folderId']


def point_current(directory, suffix):
    link = BASE / f'.current-{suffix}'
    require(not link.exists() and not link.is_symlink(), 'Temporary current link exists')
    link.symlink_to(directory)
    os.replace(link, BASE / 'current')


def require_diagnostics_release_arguments(args, image_commit, image_run, image_attempt):
    require(not args.admin_only, 'Historical diagnostics requires Worker publication')
    require((image_commit, image_run, image_attempt) ==
            (args.commit, args.run_id, args.run_attempt),
            'Historical diagnostics forbids image reuse')


def require_diagnostics_migration_scope(additions, edge_changed):
    require(not additions and not edge_changed,
            'Historical diagnostics forbids migrations and edge changes')


def require_diagnostics_source_scope(previous, release):
    require_diagnostics_migration_scope(migration_plan(previous, release),
        (previous / 'deploy/caddy/Caddyfile.aws').read_bytes() !=
        (release / 'deploy/caddy/Caddyfile.aws').read_bytes())


RECHARGE_SCOPE_ID = 'recharge-pro-menu-b8-20261005'
RECHARGE_SCOPE_CURRENT = 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'
RECHARGE_SCOPE_TREE = '410f1db22deb8629ab88da27fc0b93fd32987b2f'
RECHARGE_SCOPE_RUN = 'github-actions-37302661631-1'
RECHARGE_SCOPE_FILE = 'deploy/aws/' + RECHARGE_SCOPE_ID + '.json'
RECHARGE_SCOPE_CANDIDATES = frozenset({
    'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py', 'docs/V2_TASKS.md'})
RECHARGE_SCOPE_CONTROLS = frozenset({
    '.github/workflows/production-release.yml', 'scripts/production-release/build-images.sh',
    'scripts/production-release/push-images.sh', 'scripts/production-release/dispatch.sh',
    'scripts/production-release/remote-deploy.py', 'scripts/production-release/remote-deploy.test.py',
    'scripts/ci-recharge-scope.mjs', 'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-release.test.mjs', 'scripts/ci-recharge-check.mjs', 'docs/PRODUCTION_RELEASE_OIDC.md'})
RECHARGE_SCOPE_CARRIED = frozenset({
    'apps/api/src/id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.ts',
    'apps/api/src/id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.spec.ts',
    'deploy/aws/historical-finance-20261005-mailbox-batch.json',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/production-release/maintain-image-cache.test.py',
    'scripts/v2-release-mailbox-audit.mjs', 'scripts/v2-release-mailbox-audit.test.mjs'})
RECHARGE_SCOPE_EXPECTED = {'servicesUpdated': ['auto-recharge'], 'imageServices': ['auto-recharge'],
    'preservedServices': ['auto-registration', 'api', 'admin', 'media-resolver', 'mysql', 'caddy'],
    **{key: False for key in ('imageReuseAllowed', 'cacheCleanupAllowed', 'migrationDeploymentAllowed',
        'financialWritesAllowed', 'registrationRestartAllowed', 'googleDriveConfigAllowed',
        'databaseGrantSyncAllowed')}}
RECHARGE_SCOPE_FINANCE = {'kind': 'EXISTING_MAINTENANCE_48', 'sourceCommit': RECHARGE_SCOPE_CURRENT,
    'originCommit': HISTORY_MAINTENANCE_BASELINE, 'policyId': HISTORY_MAINTENANCE_POLICY_ID,
    'checkCount': 48, 'executedCheckCount': 48, 'unavailableCheckCount': 0, 'violationCount': 6}

RECHARGE_7F_ID = 'recharge-pro-menu-7f-20261005'
RECHARGE_7F_CURRENT = '7f70688b9bf53a071a0a324ca558aeabc4ced2e3'
RECHARGE_7F_TREE = '1dc54c20227dd713d61d4651882e5d73a47b9010'
RECHARGE_7F_RUN = 'github-actions-37333706418-1'
RECHARGE_7F_FILE = 'deploy/aws/' + RECHARGE_7F_ID + '.json'
RECHARGE_7F_CARRIED = frozenset()

# A separate, closed continuation of the actual order-archive publication.
# Unknown native receipt/image identities belong in a disabled profile, never here.
RECHARGE_MAIN80_ID = 'recharge-pro-main80-20261006'
RECHARGE_MAIN80_CURRENT = 'b91b626a71ed2c7c2473d080551b3b10b693b0cb'
RECHARGE_MAIN80_TREE = '0108ff3dda67337102d96bef08280ee93d8bcb36'
RECHARGE_MAIN80_FINANCE_CURRENT = '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'
RECHARGE_MAIN80_FINANCE_TREE = 'fbf9bd6e903ad8d7b83cf5701fde5c96347d5c1b'
RECHARGE_MAIN80_FILE = 'deploy/aws/' + RECHARGE_MAIN80_ID + '.json'
RECHARGE_MAIN80_CONTROLS = RECHARGE_SCOPE_CONTROLS | {'scripts/production-release/validate-release-selection.sh',
    'scripts/v2-registration-finance-audit.mjs', 'scripts/v2-registration-finance-audit.test.mjs'}
RECHARGE_MAIN80_POLICY_SHA256 = '91096c5c2cf5d6b1a3210794ec3cdf20aef54fe457d11b75df1735416d7c3511'
RECHARGE_MAIN80_PROJECTION_TREE = 'd9c2e534f0e71d5c88ffc4db492c4db2e79a9370'
RECHARGE_MAIN80_MIGRATION = {'name': ORDER_ARCHIVE_MIGRATION,
    'sqlSha256': ORDER_ARCHIVE_MIGRATION_SHA256,
    'mysqlSchemaSha256': 'c70cbcb110bb48c395b7e7284dedc0486a9afc125d940c455c0bafc1cffc701d',
    'baselineMysqlSchemaSha256': '39b9bd4d1bf8a42263e494880c2b047a91628102cc6676abd06dc4aecd2149a0'}
RECHARGE_MAIN80_FINANCE = {'kind': 'EXISTING_ORDER_ARCHIVE_49',
    'sourceCommit': RECHARGE_MAIN80_FINANCE_CURRENT, 'sourceTree': RECHARGE_MAIN80_FINANCE_TREE,
    'originCommit': HISTORY_ORDER_ARCHIVE_BASELINE, 'historicalSourceBaseline': HISTORY_POST_CLEANUP_BASELINE,
    'policyId': HISTORY_ORDER_ARCHIVE_POLICY_ID, 'checkCount': 49, 'executedCheckCount': 49,
    'unavailableCheckCount': 0, 'violationCount': 5, 'policySha256': RECHARGE_MAIN80_POLICY_SHA256,
    'sourceProjectionTree': RECHARGE_MAIN80_PROJECTION_TREE, 'migration': RECHARGE_MAIN80_MIGRATION}
RECHARGE_MAIN80_BUSINESS = {
    'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py':
        '5b5db9c3fa650c1940f26a5685d4601ac2c6b19d3dd9077664d062ed69d74c09',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py':
        '727ead31c878f1d829aae2ef2f6ed6626147ad184615d8a09d52505760414e2c'}
RECHARGE_MAIN80_CARRIED_COMMIT = 'fd173815aac0048011fe1583acfe345575bca286'
RECHARGE_MAIN80_FD_CARRIED_SOURCE = {
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py':
        'ccaa855d4dbc35f98ea22765011ca16e989c04622d911a9410673c6ace92dac5',
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py':
        'a4256d8ac85f17064c29485b16e48888346c88a61abe315c5924622486530ad1',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py':
        '4593b2eaab271dd9c16ab12adac07b42f87c79173b432982cef178c17c9767e0',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py':
        'fa1a98dd51208f9686732f9122b01d1023d7ce5977a08db17c0e86c7d3f5ad06',
    'docs/AUTO_REGISTRATION.md':
        '3cb74e1f7269a5fa8dec5e6ca530147a310b261d43f44a62fbb979ad2aa6b11c'}
RECHARGE_MAIN80_FA_CARRIED_COMMIT = '602f3d1f95f5e2be0605e46223b8703a69cb54a4'
RECHARGE_MAIN80_FA_CARRIED_SOURCE = {
    'deploy/aws/registration-worker-b8-80-20261006.json':
        '3f002d7a8ec945e4d594e3e79ec57d180584cfe8dc7ae7141f68c1bb81ebe568',
    'scripts/production-release/registration-only-transport.test.py':
        '8ff9a7eb48b918b91336239757eef85261c4d7399dcb1a2c4aa2db0d814782ab'}
# Preserve the current registration sources without selecting their release.
RECHARGE_MAIN80_CARRIED_SOURCE = {'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': '704d5c1fb4de91c727453208907ca1c4f98cf10c00235facb2ff73aec68192d4',
 'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py': 'f1878abdf27e6760bd63c602136ae14ff06902d136bbd47cf2d036fd1fb393ae',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py': 'c409f1d4a36fc759aa3bf649d08e93938ff5497b9261b635f28cc02e324bcec0',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py': '680699426cbbf517c4792b5ff6fcf83d692d7a9e084cbbd2b8d8a9eb20ffdf17',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': 'fa57abf5ad8d18b3ea0152dfc544c5a3a38d063ae19208c82d185d7fed7bb3ef',
 'deploy/aws/registration-worker-85-20261006.json': '02fc3375314ee75b6e5b8ec47ce715f1e02f9b744ce77c5a4804d9110ba4daec',
 'deploy/aws/registration-worker-86-20261006.json': '81946a081a13d6787a5a1e16782ef780065c6e81440b8500e55dbca155fef7f2',
 'deploy/aws/registration-worker-87-20261006.json': '3742920452e28992595c7d31d8ea5c03915f3a3218435a7714cf6e2fe1c2aea7',
 'deploy/aws/registration-worker-88-20261006.json': 'cce9a098659ba3bc5bec6e7fd8eb294d3ef075dc4676c86f5b4c38de1ff67d67',
 'deploy/aws/registration-worker-956-20261006.json': '60226df9c51cb222bf8c0cc09a7783b52a8f0082f728189ec3ada9554b6dbfc1',
 'deploy/aws/registration-worker-b8-80-20261006.json': 'd5c023887b22f6a555abe0f8e4627113d5a45dec0668ae2abc1bb8fbf8cbdb28',
 'docs/AUTO_REGISTRATION.md': '3cb74e1f7269a5fa8dec5e6ca530147a310b261d43f44a62fbb979ad2aa6b11c',
 'scripts/production-release/registration-only-transport.test.py': '4fb631b16b5e512a412677ac01f381c154952a26562c57a5d27991a5e4d388b5'}

# Registration published a sealed projection, not the entire current Git tree.
RECHARGE_MAIN80_RUNTIME_SOURCE_OVERRIDES = {'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py': ('9c3c0d7b7d60ae26729486943fb7d4eec15154fb1331646fa755a6a014ebde6a',
                                                                        420),
 'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py': ('2ccb8e3b0e6b3ba9ff2cfc55e1fb96c5352ce6c0767ae7594aab2f5fa30d948f',
                                                                  420),
 'docs/PRODUCTION_RELEASE_OIDC.md': ('c49be28fbf7e88044340ce98fcdff6288dbfe6a2fecd039956d9a9ba1ad437a0',
                                     420),
 'docs/V2_TASKS.md': ('daad8035cf92439caa1e748f8b88444f0a432ad53fd4e707b01b9625547dda97', 420)}

# Exact state snapshot from the controller's independent currentb91 read-only proof.
RECHARGE_MAIN80_RUNTIME_STATES_SHA256 = '09595402901840bb9911c07b520b63b3d4f961024d5676778f47cf0794eb98ab'


def main80_recharge_scope(value, *, require_approved=True):
    message = 'Fixed main80 recharge runtime scope unavailable'
    require(isinstance(value, dict) and set(value) == {'version', 'kind', 'id', 'enabled',
        'approvalStatus', 'expectedCurrent', 'baselineRelease', 'candidateSourceSha256',
        'carriedSourceOnlySha256', 'controlSourceSha256', 'sourceModes', 'scope', 'financeValidator'}, message)
    require(type(value['version']) is int and value['version'] == 1
        and value['kind'] == 'FIXED_RECHARGE_RUNTIME_SCOPE' and value['id'] == RECHARGE_MAIN80_ID
        and type(value['enabled']) is bool and value['approvalStatus'] in ('NOT_APPROVED', 'APPROVED')
        and value['enabled'] == (value['approvalStatus'] == 'APPROVED')
        and value['expectedCurrent'] == RECHARGE_MAIN80_CURRENT, message)
    if require_approved:
        require(value['enabled'], 'Fixed recharge runtime scope is not approved')
    approved = value['enabled']
    digest = lambda item: isinstance(item, str) and re.fullmatch(r'[a-f0-9]{64}', item) is not None
    evidence_digest = lambda item: digest(item) or (not approved and item is None)
    baseline = value['baselineRelease']
    require(isinstance(baseline, dict) and set(baseline) == {'commit', 'sourceTree', 'previousCommit',
        'deploymentRun', 'manifestSha256', 'beforeAuditSha256', 'afterAuditSha256', 'composeSha256',
        'overrideRawSha256', 'overrideCanonicalSha256'}
        and baseline['commit'] == RECHARGE_MAIN80_CURRENT and baseline['sourceTree'] == RECHARGE_MAIN80_TREE
        and baseline['previousCommit'] == REGISTRATION_EMAIL_REQUEST_CURRENT
        and ((isinstance(baseline['deploymentRun'], str) and re.fullmatch(
            r'github-actions-[1-9][0-9]*-[1-9][0-9]*', baseline['deploymentRun']))
            or (not approved and baseline['deploymentRun'] is None))
        and all(evidence_digest(baseline[key]) for key in ('manifestSha256', 'beforeAuditSha256',
            'afterAuditSha256', 'composeSha256', 'overrideRawSha256', 'overrideCanonicalSha256')), message)
    names = set()
    for key, expected in (('candidateSourceSha256', RECHARGE_SCOPE_CANDIDATES),
            ('carriedSourceOnlySha256', set(RECHARGE_MAIN80_CARRIED_SOURCE)), ('controlSourceSha256', RECHARGE_MAIN80_CONTROLS)):
        group = value[key]
        require(isinstance(group, dict) and set(group) == expected and all(digest(item) for item in group.values()), message)
        names.update(group)
    require(all(value['candidateSourceSha256'].get(name) == item for name, item in RECHARGE_MAIN80_BUSINESS.items())
        and historical_fingerprint(value['carriedSourceOnlySha256']) == historical_fingerprint(RECHARGE_MAIN80_CARRIED_SOURCE)
        and isinstance(value['sourceModes'], dict) and set(value['sourceModes']) == names
        and all(type(mode) is int and mode == 0o644 for mode in value['sourceModes'].values())
        and historical_fingerprint(value['scope']) == historical_fingerprint(RECHARGE_SCOPE_EXPECTED), message)
    finance = value['financeValidator']
    extra = {'releaseSealSha256', 'preparedImagesSha256', 'preparationRunId', 'preparationRunAttempt', 'images'}
    require(isinstance(finance, dict) and set(finance) == set(RECHARGE_MAIN80_FINANCE) | extra
        and historical_fingerprint({key: finance[key] for key in RECHARGE_MAIN80_FINANCE})
            == historical_fingerprint(RECHARGE_MAIN80_FINANCE)
        and all(evidence_digest(finance[key]) for key in ('releaseSealSha256', 'preparedImagesSha256'))
        and all((type(finance[key]) is int and 0 < finance[key] <= 9007199254740991)
            or (not approved and finance[key] is None) for key in ('preparationRunId', 'preparationRunAttempt'))
        and ((not approved and finance['images'] is None)
            or (isinstance(finance['images'], dict) and set(finance['images']) == {'api', 'admin', 'migrate'}
                and all(isinstance(item, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', item)
                    for item in finance['images'].values()))), message)
    return value



def main80_recharge_gate(profile, policy, seal, stage):
    """Retain the original order-archive candidate and sealed native gate identity."""
    main80_recharge_scope(profile)
    require(stage in ('before', 'after'), 'Fixed main80 recharge integrity gate failed')
    finance = profile['financeValidator']
    require(historical_fingerprint(policy) == finance['policySha256']
        and policy['candidateBindings']['sourceTree'] == finance['sourceProjectionTree']
        and seal['images'] == finance['images'] and seal['migration'] == finance['migration'],
        'Fixed main80 recharge native finance identity changed')
    return {'accepted': True, 'policyId': HISTORY_ORDER_ARCHIVE_POLICY_ID,
        'status': 'APPROVED_ORDER_ARCHIVE_HISTORICAL_EXCEPTIONS', 'scope': 'API_ADMIN_ORDER_ARCHIVE',
        'stage': stage, 'checkCount': 49, 'executedCheckCount': 49, 'unavailableCheckCount': 0,
        'violationCount': 5, 'candidateCommit': RECHARGE_MAIN80_FINANCE_CURRENT, 'candidateTree': RECHARGE_MAIN80_FINANCE_TREE,
        'sourceTree': finance['sourceProjectionTree'], 'releaseSealSha256': finance['releaseSealSha256'],
        'images': finance['images'], 'expectedCurrent': HISTORY_ORDER_ARCHIVE_BASELINE,
        'historicalSourceBaseline': HISTORY_POST_CLEANUP_BASELINE,
        'sourceAnchorSha256': policy['sourceAnchorSha256'],
        'sources': {name: {'rowCount': group['rowCount'], 'sha256': group['sha256']}
                    for name, group in policy['sources'].items()},
        'metadataSha256': policy['metadataSha256'], 'cleanupReceiptSha256': HISTORY_POST_CLEANUP_RECEIPT_SHA256,
        'migration': finance['migration'], 'preparedImagesSha256': finance['preparedImagesSha256'],
        'preparationRunId': finance['preparationRunId'], 'preparationRunAttempt': finance['preparationRunAttempt']}



def main80_recharge_report(report, profile, policy, seal, stage):
    expected = main80_recharge_gate(profile, policy, seal, stage)
    require(isinstance(report, dict) and report.get('ok') is False
        and type(report.get('checkCount')) is int and report['checkCount'] == 49
        and type(report.get('violationCount')) is int and report['violationCount'] == 5
        and historical_fingerprint(report.get('gate')) == historical_fingerprint(expected),
        'Fixed main80 recharge integrity gate failed')
    rows = report.get('checks')
    exceptions = policy.get('exceptions')
    require(isinstance(exceptions, list) and len(exceptions) == 1
        and all(isinstance(item, dict) and set(item) == {'code', 'entityIds'}
            and isinstance(item['code'], str) and isinstance(item['entityIds'], list)
            and len(item['entityIds']) == len(set(item['entityIds'])) == 5
            and all(isinstance(entity, str) and re.fullmatch(r'[a-f0-9-]{36}:[a-f0-9-]{36}', entity)
                for entity in item['entityIds']) for item in exceptions),
        'Fixed main80 recharge frozen native exceptions changed')
    frozen = {item['code']: sorted(item['entityIds']) for item in exceptions}
    require(isinstance(rows, list) and len(rows) == 49
        and all(isinstance(row, dict) and set(row) == {'code', 'count', 'status', 'samples'}
            and isinstance(row['code'], str) and re.fullmatch(r'[a-z][a-z0-9_]{0,199}', row['code'])
            and type(row['count']) is int and 0 <= row['count'] <= 5 and row['status'] == 'EXECUTED'
            and isinstance(row['samples'], list) and len(row['samples']) == row['count']
            and all(isinstance(sample, dict) and set(sample) == {'entityId', 'detailSha256'}
                and isinstance(sample['entityId'], str)
                and isinstance(sample['detailSha256'], str) and re.fullmatch(r'[a-f0-9]{64}', sample['detailSha256'])
                for sample in row['samples'])
            and row['count'] == len(frozen.get(row['code'], []))
            and sorted(sample['entityId'] for sample in row['samples']) == frozen.get(row['code'], []) for row in rows)
        and len({row['code'] for row in rows}) == 49 and sum(row['count'] for row in rows) == 5,
        'Fixed main80 recharge complete native checks changed')
    return {'checkCount': 49, 'violationCount': 5, 'historicalException': report['gate']}



def main80_recharge_seal(source, profile):
    main80_recharge_scope(profile)
    finance = profile['financeValidator']
    require(hashlib.sha256(fixed_recharge_bytes(ORDER_ARCHIVE_SEAL)).hexdigest() == finance['releaseSealSha256']
        and hashlib.sha256(fixed_recharge_bytes(POST_CLEANUP_RECEIPT)).hexdigest() == HISTORY_POST_CLEANUP_RECEIPT_SHA256,
        'Fixed main80 recharge private native evidence changed')
    return reviewed_order_archive_seal(source, finance['releaseSealSha256'],
        RECHARGE_MAIN80_FINANCE_CURRENT, RECHARGE_MAIN80_FINANCE_TREE, finance['preparedImagesSha256'],
        str(finance['preparationRunId']), str(finance['preparationRunAttempt']))



def main80_recharge_reader_evidence(directory):
    before = directory / 'before-audit.json'
    metadata = before.lstat()
    probe = ("const os=require('node:os'); const user=os.userInfo(); "
             "console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),user:user.username}));")
    identity = fixed_recharge_json(compose(directory, 'exec', '-T', 'api', 'node', '-e', probe, timeout=20).encode())
    require(isinstance(identity, dict) and set(identity) == {'uid', 'gid', 'user'}
        and identity['user'] == 'node' and all(type(identity[key]) is int and 0 < identity[key] <= 2147483647
            for key in ('uid', 'gid')), 'Fixed main80 recharge audit reader identity unavailable')
    owner = (identity['uid'], identity['gid'])
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
        and stat.S_IMODE(metadata.st_mode) in (0o400, 0o600)
        and (metadata.st_uid, metadata.st_gid) in ((0, 0), owner),
        'Fixed main80 recharge original audit ownership unavailable')
    for filename, original in (('order-archive-seal.reader.json', ORDER_ARCHIVE_SEAL),
            ('order-archive-cleanup.reader.json', POST_CLEANUP_RECEIPT)):
        reader = directory / filename
        info = reader.lstat()
        require((info.st_uid, info.st_gid) == owner
            and fixed_recharge_bytes(reader, modes=(0o400,)) == fixed_recharge_bytes(original, modes=(0o600,)),
            'Fixed main80 recharge original reader evidence changed')
        after = reader.lstat()
        require((after.st_uid, after.st_gid) == owner
            and (before.lstat().st_uid, before.lstat().st_gid) == (metadata.st_uid, metadata.st_gid),
            'Fixed main80 recharge original reader ownership changed')


def main80_recharge_public_snapshot(directory, files):
    identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
        value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    observed = {}
    for name, (digest, mode) in files.items():
        path = directory / name
        before = path.lstat()
        require(hashlib.sha256(fixed_recharge_bytes(path, modes=(mode,))).hexdigest() == digest
            and identity(before) == identity(path.lstat()), 'Fixed main80 recharge public source changed during read')
        observed[path] = identity(before)
        for parent in path.parents:
            if parent != directory and directory not in parent.parents:
                break
            info = parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and not parent.is_symlink(), 'Fixed main80 recharge public source unavailable')
            value = identity(info)
            require(parent not in observed or observed[parent] == value, 'Fixed main80 recharge public source changed during read')
            observed[parent] = value
    return observed


def require_main80_recharge_public_snapshot(observed):
    require(all((value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
        value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns) == previous
        for path, previous in observed.items() for value in (path.lstat(),)),
        'Fixed main80 recharge public source changed after read')


def verify_main80_recharge_finance_source(previous, data):
    """Verify the complete sealed registration runtime projection before recharge."""
    main80_recharge_reader_evidence(previous)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        expected = fixed_recharge_archive(archive, profile_id=RECHARGE_MAIN80_ID)
    expected.update(RECHARGE_MAIN80_RUNTIME_SOURCE_OVERRIDES)
    require(expected.pop(RECHARGE_MAIN80_FILE, None) is not None, 'Fixed main80 recharge native source changed')
    generated = ('.env.aws.production', 'compose.release.json', 'release-manifest.json',
        'before-audit.json', 'after-audit.json', 'backup-verification.json',
        'order-archive-seal.reader.json', 'order-archive-cleanup.reader.json')
    actual = fixed_recharge_file_map(previous, allowed=set(expected), omitted=generated)
    def canonical_modes(value):
        require(all(mode in (0o644, 0o664, 0o755, 0o775) for _digest, mode in value.values()),
            'Fixed main80 recharge native source mode changed')
        return {name: (digest, 0o755 if mode & 0o111 else 0o644) for name, (digest, mode) in value.items()}
    require(canonical_modes(actual) == canonical_modes(expected), 'Fixed main80 recharge native source changed')
    return main80_recharge_public_snapshot(previous, actual)



def verify_main80_recharge_candidate_source(release, data, profile):
    main80_recharge_reader_evidence(release)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        names = set(fixed_recharge_archive(archive, profile_id=RECHARGE_MAIN80_ID))
    approved = set(profile['candidateSourceSha256']) | set(profile['carriedSourceOnlySha256']) | set(profile['controlSourceSha256'])
    generated = ('.env.aws.production', 'compose.release.json', 'release-manifest.json', 'before-audit.json',
        'after-audit.json', 'backup-verification.json', 'order-archive-seal.reader.json', 'order-archive-cleanup.reader.json')
    files = fixed_recharge_file_map(release, allowed=names | approved | {RECHARGE_MAIN80_FILE}, omitted=generated)
    actual = set(files)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        verify_fixed_recharge_archive(release, archive, profile, names=actual)
    return main80_recharge_public_snapshot(release, files)


def main80_recharge_preserved_states(states):
    return {service: {key: states[service][key] for key in
        ('image', 'reference', 'status', 'health', 'containerId', 'startedAtSha256', 'environmentSha256')}
        for service in ALL_SERVICES if service != 'auto-recharge'}


def main80_recharge_origin(previous, manifest=None):
    """Read the published registration chain without running an audit or changing it."""
    message = 'Fixed main80 recharge baseline changed'
    manifest = manifest or fixed_recharge_json(fixed_recharge_bytes(previous / 'release-manifest.json'))
    require(manifest.get('commit') == RECHARGE_MAIN80_CURRENT
        and manifest.get('previousCommit') == REGISTRATION_EMAIL_REQUEST_CURRENT, message)
    old, origin = registration_runtime_baseline(Path(manifest['previousRelease']), profile_id=REGISTRATION_EMAIL_REQUEST_ID)
    contract = registration_contract(REGISTRATION_EMAIL_REQUEST_ID)
    raw = fixed_recharge_bytes(previous / contract['file'], modes=(0o644, 0o664), limit=128 * 1024)
    require(hashlib.sha256(raw).hexdigest() == RECHARGE_MAIN80_CARRIED_SOURCE[contract['file']], message)
    profile = registration_profile(fixed_recharge_json(raw), profile_id=REGISTRATION_EMAIL_REQUEST_ID)
    reviewed = {name: (fixed_recharge_bytes(previous / name, modes=(0o644, 0o664, 0o755, 0o775)), '100644')
        for name in profile['registrationSourceSha256'].keys() | profile['controlSourceSha256'].keys()}
    registration_source(profile, reviewed)
    require(manifest.get('fixedRegistrationRelease') == {'id': contract['id'],
        'profileRawSha256': hashlib.sha256(raw).hexdigest(), 'registrationSourceCommit': contract['source'],
        'workerBasisCommit': RECHARGE_SCOPE_CURRENT, 'workerProjectionSha256': contract['projectionSha256'],
        'financeSourceCommit': REGISTRATION_CURRENT, 'financePolicyId': HISTORY_ORDER_ARCHIVE_POLICY_ID,
        'financeMode': REGISTRATION_CLEARANCE['mode'], 'clearanceSealSha256': historical_fingerprint(REGISTRATION_CLEARANCE),
        'environmentUnchanged': True, 'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED', 'cacheStatus': 'SKIPPED'}
        and set(manifest['images']) == set(old['images'])
        and all(manifest['images'][name] == old['images'][name] for name in old['images'] if name != 'auto-registration')
        and (previous / '.env.aws.production').read_bytes() == (Path(manifest['previousRelease']) / '.env.aws.production').read_bytes(), message)
    return origin


def main80_recharge_baseline(previous, profile, manifest, states, *, source_archive=None):
    """Close the actual b91 runtime and the unchanged original 80 finance evidence."""
    main80_recharge_scope(profile)
    message = 'Fixed main80 recharge baseline changed'
    require(previous.is_absolute() and previous.resolve() == previous and previous.parent == BASE / 'releases'
        and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + RECHARGE_MAIN80_CURRENT[:12], previous.name), message)
    observed = {}
    def read(path, **options):
        raw = fixed_recharge_bytes(path, **options)
        observed[path] = (raw, options)
        return raw
    baseline, finance = profile['baselineRelease'], profile['financeValidator']
    stored_manifest = fixed_recharge_json(read(previous / 'release-manifest.json'))
    require(hashlib.sha256(observed[previous / 'release-manifest.json'][0]).hexdigest() == baseline['manifestSha256']
        and historical_fingerprint(stored_manifest) == historical_fingerprint(manifest)
        and all(manifest.get(key) == item for key, item in {'commit': RECHARGE_MAIN80_CURRENT,
            'sourceTree': RECHARGE_MAIN80_TREE, 'previousCommit': REGISTRATION_EMAIL_REQUEST_CURRENT,
            'deploymentRun': baseline['deploymentRun'], 'imageBuildRun': baseline['deploymentRun'],
            'servicesUpdated': ['auto-registration'], 'migrationApplied': False, 'newMigrations': [],
            'databaseGrants': {'status': 'SKIPPED', 'reason': 'FIXED_REGISTRATION_NO_MIGRATIONS'}}.items())
        and manifest.get('migrationApplied') is False, message)
    origin = main80_recharge_origin(previous, manifest)
    policy_raw = read(origin / ('deploy/aws/' + HISTORY_ORDER_ARCHIVE_POLICY_ID + '.json'), modes=(0o644, 0o664))
    require(historical_fingerprint(fixed_recharge_json(policy_raw)) == RECHARGE_MAIN80_POLICY_SHA256, message)
    read(ORDER_ARCHIVE_SEAL); read(POST_CLEANUP_RECEIPT)
    for directory in (origin, previous):
        for filename in ('order-archive-seal.reader.json', 'order-archive-cleanup.reader.json'):
            read(directory / filename, modes=(0o400,))
        main80_recharge_reader_evidence(directory)
    policy, seal = main80_recharge_seal(origin, profile)
    frozen = fixed_recharge_json(read(origin / 'before-audit.json'))['gate']
    facts = []
    for stage in ('before', 'after'):
        historical_raw = read(origin / (stage + '-audit.json'))
        require(hashlib.sha256(historical_raw).hexdigest() == REGISTRATION_BASELINE[stage + 'AuditSha256'], message)
        main80_recharge_report(fixed_recharge_json(historical_raw), profile, policy, seal, stage)
        raw = read(previous / (stage + '-audit.json'))
        require(hashlib.sha256(raw).hexdigest() == baseline[stage + 'AuditSha256'], message)
        report = fixed_recharge_json(raw)
        summary = require_registration_zero_report(report, stage, frozen)
        require(historical_fingerprint(manifest.get('dataAudit' + stage.title())) == historical_fingerprint(summary), message)
        facts.append((report['checks'], report['identity']))
    require(facts[0] == facts[1], message)
    compose_raw = read(previous / 'docker-compose.aws-mysql.yml', modes=(0o400, 0o600, 0o644, 0o664))
    override_raw = read(previous / 'compose.release.json', modes=(0o400, 0o600, 0o644))
    read(previous / '.env.aws.production')
    images = manifest.get('images', {})
    # Historical image records remain pinned; only six overrides declare runtime images.
    require(set(states) == set(ALL_SERVICES) and isinstance(images, dict) and {*SERVICES, 'migrate'} <= set(images)
        and historical_fingerprint(states) == RECHARGE_MAIN80_RUNTIME_STATES_SHA256
        and all(state['status'] == 'running' and (state['health'] is None if service == 'caddy' else state['health'] == 'healthy')
            and all(isinstance(state.get(key), str) and re.fullmatch(r'[a-f0-9]{64}', state[key])
                for key in ('containerId', 'startedAtSha256', 'environmentSha256')) for service, state in states.items())
        and all(states[service]['image'] == images[service]['digest']
            and states[service]['reference'] == images[service]['reference'] for service in SERVICES)
        and has_registration_worker(previous) and hashlib.sha256(compose_raw).hexdigest() == baseline['composeSha256']
        and hashlib.sha256(override_raw).hexdigest() == baseline['overrideRawSha256']
        and historical_fingerprint(fixed_recharge_json(override_raw)) == baseline['overrideCanonicalSha256']
        and fixed_recharge_json(override_raw) == {'services': {service: {'image': images[service]['reference'], 'pull_policy': 'never'}
            for service in (*SERVICES, 'migrate')}}, message)
    for service in ('api', 'admin', 'migrate'):
        image = images[service]
        require(image.get('digest') == finance['images'][service] and image.get('sourceCommit') == RECHARGE_MAIN80_FINANCE_CURRENT
            and isinstance(image.get('reference'), str) and re.fullmatch(
                r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
                + RECHARGE_MAIN80_FINANCE_CURRENT + '-' + str(finance['preparationRunId'])
                + '-' + str(finance['preparationRunAttempt']) + '-' + service, image['reference']), message)
    require(manifest.get('fixedRegistrationPreservedStates') == {'before': registration_preserved_states(states),
        'after': registration_preserved_states(states)} and images['auto-registration']['sourceCommit'] == RECHARGE_MAIN80_CURRENT
        and re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
            + RECHARGE_MAIN80_CURRENT + '-' + baseline['deploymentRun'].removeprefix('github-actions-')
            + '-auto-recharge', images['auto-registration']['reference']), message)
    registration_worker_hashes(previous, registration_profile(fixed_recharge_json(read(previous / REGISTRATION_EMAIL_REQUEST_FILE,
        modes=(0o644, 0o664), limit=128 * 1024)), profile_id=REGISTRATION_EMAIL_REQUEST_ID))
    public_observed = verify_main80_recharge_finance_source(previous, source_archive) if source_archive is not None else None
    require(all(fixed_recharge_bytes(path, **options) == raw for path, (raw, options) in observed.items()), message)
    main80_recharge_origin(previous, manifest)
    for directory in (origin, previous): main80_recharge_reader_evidence(directory)
    if public_observed is not None: require_main80_recharge_public_snapshot(public_observed)
    return origin


def main80_recharge_audit(directory, receipt, *, stage, source, auditor_source, profile, before_receipt=None, control_source=None):
    """Reuse the released zero49 auditor while preserving the sealed original 80 policy."""
    main80_recharge_scope(profile)
    policy, seal = main80_recharge_seal(source, profile)
    for stored_stage in ('before', 'after'):
        main80_recharge_report(fixed_recharge_json(fixed_recharge_bytes(source / (stored_stage + '-audit.json'))),
            profile, policy, seal, stored_stage)
    control_source = control_source or directory
    result = registration_finance_audit(directory, receipt, stage=stage, source=auditor_source,
        before_receipt=before_receipt, control_source=control_source, profile_id=REGISTRATION_EMAIL_REQUEST_ID)
    report = fixed_recharge_json(fixed_recharge_bytes(receipt))
    frozen = fixed_recharge_json(fixed_recharge_bytes(source / 'before-audit.json'))['gate']
    expected = require_registration_zero_report(report, stage, frozen)
    stored = fixed_recharge_json(fixed_recharge_bytes(control_source / (stage + '-audit.json')))
    require_registration_zero_report(stored, stage, frozen)
    require(historical_fingerprint(result) == historical_fingerprint(expected)
        and historical_fingerprint(stored['checks']) == historical_fingerprint(report['checks'])
        and historical_fingerprint(stored['identity']) == historical_fingerprint(report['identity']),
        'Fixed main80 recharge fresh native integrity gate failed')
    return result


def main80_recharge_context(args, profile, before_gate, after_gate):
    main80_recharge_scope(profile)
    require(re.fullmatch(r'[a-f0-9]{40}', args.commit or '') and re.fullmatch(r'[a-f0-9]{40}', args.source_tree or '')
        and args.expected_current == RECHARGE_MAIN80_CURRENT, 'Fixed main80 recharge runtime scope unavailable')
    for stage, gate in (('before', before_gate), ('after', after_gate)):
        require(isinstance(gate, dict) and set(gate) == {'checkCount', 'violationCount', 'registrationFinanceGate'}
            and type(gate['checkCount']) is int and gate['checkCount'] == 49
            and type(gate['violationCount']) is int and gate['violationCount'] == 0
            and gate['registrationFinanceGate'].get('stage') == stage
            and gate['registrationFinanceGate'].get('candidateCommit') == RECHARGE_MAIN80_FINANCE_CURRENT
            and gate['registrationFinanceGate'].get('candidateTree') == RECHARGE_MAIN80_FINANCE_TREE,
            'Fixed main80 recharge fresh integrity gate failed')
    return {'version': 1, 'id': RECHARGE_MAIN80_ID, 'profileSha256': historical_fingerprint(profile),
        'expectedCurrent': RECHARGE_MAIN80_CURRENT, 'sourceCommit': args.commit, 'sourceTree': args.source_tree,
        'servicesUpdated': ['auto-recharge'], 'financeValidator': REGISTRATION_CLEARANCE['mode'],
        'sourceCommitForFinance': RECHARGE_MAIN80_FINANCE_CURRENT, 'originCommitForFinance': HISTORY_ORDER_ARCHIVE_BASELINE,
        'beforeGateSha256': historical_fingerprint(before_gate['registrationFinanceGate']),
        'afterGateSha256': historical_fingerprint(after_gate['registrationFinanceGate']),
        'unchangedServiceContainersPreserved': True, 'environmentUnchanged': True,
        'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED', 'cacheStatus': 'SKIPPED'}


def validate_main80_recharge_readback_projection(value, expected_current, source_tree, profile_sha256):
    try:
        require(isinstance(expected_current, str) and re.fullmatch(r'[a-f0-9]{40}', expected_current)
            and expected_current != RECHARGE_MAIN80_CURRENT
            and isinstance(source_tree, str) and re.fullmatch(r'[a-f0-9]{40}', source_tree)
            and isinstance(profile_sha256, str) and re.fullmatch(r'[a-f0-9]{64}', profile_sha256),
            'Fixed recharge deployment verification unavailable')
        expected = {'version': 1, 'id': RECHARGE_MAIN80_ID, 'status': 'VERIFIED', 'currentCommit': expected_current,
            'sourceTree': source_tree, 'previousCommit': RECHARGE_MAIN80_CURRENT, 'profileSha256': profile_sha256,
            'servicesUpdated': ['auto-recharge'], 'preservedServiceCount': 6, 'checkCount': 49,
            'executedCheckCount': 49, 'unavailableCheckCount': 0, 'violationCount': 0, 'storedGatesMatched': True,
            'unchangedServiceContainersPreserved': True, 'environmentUnchanged': True,
            'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED', 'cacheStatus': 'SKIPPED',
            'liveServicesHealthy': True, 'rechargeImageMatched': True}
        require(isinstance(value, dict) and set(value) == set(expected)
            and historical_fingerprint(value) == historical_fingerprint(expected),
            'Fixed recharge deployment verification unavailable')
        return value
    except Exception:
        raise RuntimeError('Fixed recharge deployment verification unavailable') from None


def fixed_recharge_binding(profile_id=RECHARGE_SCOPE_ID):
    require(type(profile_id) is str and profile_id in (RECHARGE_SCOPE_ID, RECHARGE_7F_ID, RECHARGE_MAIN80_ID, RECHARGE_01CE_ID),
            'Fixed recharge runtime scope unavailable')
    if profile_id == RECHARGE_01CE_ID:
        return {'id': RECHARGE_01CE_ID, 'current': RECHARGE_01CE_CURRENT, 'tree': RECHARGE_01CE_TREE,
            'file': RECHARGE_01CE_FILE, 'previous': RECHARGE_01CE_CHAIN[1][0], 'carried': frozenset(RECHARGE_01CE_CARRIED_SOURCE)}
    if profile_id == RECHARGE_MAIN80_ID:
        return {'id': RECHARGE_MAIN80_ID, 'current': RECHARGE_MAIN80_CURRENT, 'tree': RECHARGE_MAIN80_TREE,
            'file': RECHARGE_MAIN80_FILE, 'previous': REGISTRATION_EMAIL_REQUEST_CURRENT, 'carried': frozenset(RECHARGE_MAIN80_CARRIED_SOURCE)}
    if profile_id == RECHARGE_7F_ID:
        return {'id': RECHARGE_7F_ID, 'current': RECHARGE_7F_CURRENT, 'tree': RECHARGE_7F_TREE,
            'run': RECHARGE_7F_RUN, 'file': RECHARGE_7F_FILE, 'previous': RECHARGE_SCOPE_CURRENT,
            'imageRun': 'github-actions-' + MAILBOX_IMAGE_IDENTITY[1] + '-' + MAILBOX_IMAGE_IDENTITY[2],
            'carried': RECHARGE_7F_CARRIED, 'gate': MAILBOX_EXPECTED_GATE}
    return {'id': RECHARGE_SCOPE_ID, 'current': RECHARGE_SCOPE_CURRENT, 'tree': RECHARGE_SCOPE_TREE,
        'run': RECHARGE_SCOPE_RUN, 'file': RECHARGE_SCOPE_FILE, 'previous': HISTORY_MAINTENANCE_BASELINE,
        'imageRun': RECHARGE_SCOPE_RUN, 'carried': RECHARGE_SCOPE_CARRIED, 'gate': MAINTENANCE_EXPECTED_GATE}



def fixed_recharge_json(raw):
    def unique(items):
        value = {}
        for key, item in items:
            require(key not in value, 'Fixed recharge runtime scope unavailable')
            value[key] = item
        return value
    def invalid(_value):
        raise ValueError()
    require(isinstance(raw, bytes) and 0 < len(raw) <= 8 * 1024 * 1024,
            'Fixed recharge runtime scope unavailable')
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)


def fixed_recharge_scope(value, *, require_approved=True):
    try:
        if isinstance(value, dict) and value.get('id') == RECHARGE_01CE_ID:
            return recharge_01ce_scope(value, require_approved=require_approved)
        if isinstance(value, dict) and value.get('id') == RECHARGE_MAIN80_ID:
            return main80_recharge_scope(value, require_approved=require_approved)
        require(isinstance(value, dict) and set(value) == {'version', 'kind', 'id', 'enabled',
            'approvalStatus', 'expectedCurrent', 'baselineRelease', 'candidateSourceSha256',
            'carriedSourceOnlySha256', 'controlSourceSha256', 'sourceModes', 'scope', 'financeValidator'},
            'Fixed recharge runtime scope unavailable')
        require(type(value['enabled']) is bool and value['approvalStatus'] in ('NOT_APPROVED', 'APPROVED')
            and value['enabled'] == (value['approvalStatus'] == 'APPROVED'),
            'Fixed recharge runtime scope unavailable')
        if require_approved:
            require(value['enabled'] is True and value['approvalStatus'] == 'APPROVED',
                    'Fixed recharge runtime scope is not approved')
        binding = fixed_recharge_binding(value['id'])
        require(type(value['version']) is int and value['version'] == 1
            and value['kind'] == 'FIXED_RECHARGE_RUNTIME_SCOPE'
            and value['expectedCurrent'] == binding['current'],
            'Fixed recharge runtime scope unavailable')
        baseline = value['baselineRelease']
        require(isinstance(baseline, dict) and set(baseline) == {'commit', 'sourceTree', 'previousCommit',
            'deploymentRun', 'manifestSha256', 'beforeAuditSha256', 'afterAuditSha256', 'composeSha256',
            'overrideRawSha256', 'overrideCanonicalSha256'} and baseline['commit'] == binding['current']
            and baseline['sourceTree'] == binding['tree'] and baseline['previousCommit'] == binding['previous']
            and baseline['deploymentRun'] == binding['run'],
            'Fixed recharge runtime scope unavailable')
        hashed = lambda x: isinstance(x, str) and re.fullmatch(r'[a-f0-9]{64}', x) is not None
        require(all(hashed(baseline[key]) for key in ('manifestSha256', 'beforeAuditSha256', 'afterAuditSha256',
            'composeSha256', 'overrideRawSha256', 'overrideCanonicalSha256'))
            and (value['id'] != RECHARGE_SCOPE_ID or baseline['composeSha256'] == DIAGNOSTICS_COMPOSE_SHA256),
            'Fixed recharge runtime scope unavailable')
        names = set()
        for key, expected in (('candidateSourceSha256', RECHARGE_SCOPE_CANDIDATES),
                ('carriedSourceOnlySha256', binding['carried']), ('controlSourceSha256', RECHARGE_SCOPE_CONTROLS)):
            group = value[key]
            require(isinstance(group, dict) and set(group) == expected and all(hashed(x) for x in group.values()),
                    'Fixed recharge runtime scope unavailable')
            names.update(group)
        modes = value['sourceModes']
        require(isinstance(modes, dict) and set(modes) == names
            and all(type(mode) is int and mode == 0o644 for mode in modes.values()),
            'Fixed recharge runtime scope unavailable')
        require(historical_fingerprint(value['scope']) == historical_fingerprint(RECHARGE_SCOPE_EXPECTED)
            and historical_fingerprint(value['financeValidator']) == historical_fingerprint(RECHARGE_SCOPE_FINANCE),
            'Fixed recharge runtime scope unavailable')
        return value
    except (KeyError, TypeError, ValueError):
        raise RuntimeError('Fixed recharge runtime scope unavailable') from None


def parse_fixed_recharge_scope(raw, *, require_approved=True):
    try:
        require(isinstance(raw, bytes) and len(raw) <= 128 * 1024,
                'Fixed recharge runtime scope unavailable')
        return fixed_recharge_scope(fixed_recharge_json(raw), require_approved=require_approved)
    except Exception as error:
        if isinstance(error, RuntimeError) and error.args == ('Fixed recharge runtime scope is not approved',):
            raise
        raise RuntimeError('Fixed recharge runtime scope unavailable') from None


def fixed_recharge_bytes(path, *, modes=(0o400, 0o600), limit=8 * 1024 * 1024):
    descriptor = None
    identity = lambda x: (x.st_dev, x.st_ino, x.st_mode, x.st_nlink, x.st_size, x.st_mtime_ns, x.st_ctime_ns)
    try:
        initial = path.lstat()
        require(stat.S_ISREG(initial.st_mode) and initial.st_nlink == 1
            and stat.S_IMODE(initial.st_mode) in modes and initial.st_size <= limit,
            'Fixed recharge source unavailable')
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        before = os.fstat(descriptor)
        require(identity(initial) == identity(before), 'Fixed recharge source unavailable')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        require(len(data) == before.st_size and identity(before) == identity(os.fstat(descriptor))
            and identity(before) == identity(path.lstat()), 'Fixed recharge source unavailable')
        return data
    except OSError:
        raise RuntimeError('Fixed recharge source unavailable') from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def fixed_recharge_archive(source, *, profile_id=RECHARGE_SCOPE_ID):
    prefix = 'id-business-system-' + fixed_recharge_binding(profile_id)['current'] + '/'
    result = {}
    for member in source.getmembers():
        if member.name == prefix.rstrip('/') and member.isdir():
            continue
        require(member.name.startswith(prefix) and not Path(member.name).is_absolute()
            and '..' not in Path(member.name).parts and (member.isfile() or member.isdir())
            and not member.issym() and not member.islnk(), 'Fixed recharge source unavailable')
        if member.isfile():
            name = member.name[len(prefix):]
            require(name not in result and member.size <= 8 * 1024 * 1024,
                    'Fixed recharge source unavailable')
            result[name] = (hashlib.sha256(source.extractfile(member).read()).hexdigest(), member.mode & 0o7777)
    require(bool(result), 'Fixed recharge source unavailable')
    return result


def fixed_recharge_file_map(directory, *, names=None, omitted=(), allowed=None):
    result = {}
    identity = lambda x: (x.st_dev, x.st_ino, x.st_mode, x.st_nlink, x.st_size, x.st_mtime_ns, x.st_ctime_ns)
    paths = (directory / name for name in names) if names is not None else directory.rglob('*')
    for path in paths:
        name = str(path.relative_to(directory))
        require(not path.is_symlink() and not directory.is_symlink()
            and all(not parent.is_symlink() for parent in path.parents
                if parent != directory and directory in parent.parents), 'Fixed recharge source unavailable')
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            require(allowed is None or any(name + '/' == item[:len(name) + 1] for item in allowed),
                    'Fixed recharge source unavailable')
            continue
        require(stat.S_ISREG(info.st_mode), 'Fixed recharge source unavailable')
        if name in omitted:
            continue
        require(allowed is None or name in allowed, 'Fixed recharge source unavailable')
        raw = fixed_recharge_bytes(path, modes=(0o644, 0o664, 0o755, 0o775))
        after = path.lstat()
        require(identity(info) == identity(after), 'Fixed recharge source unavailable')
        result[name] = (hashlib.sha256(raw).hexdigest(), stat.S_IMODE(after.st_mode))
    return result


def normalize_fixed_recharge_modes(release, profile):
    fixed_recharge_scope(profile)
    approved = {**profile['candidateSourceSha256'], **profile['carriedSourceOnlySha256'], **profile['controlSourceSha256']}
    descriptors = []
    identity = lambda x: (x.st_dev, x.st_ino, x.st_mode, x.st_nlink, x.st_size, x.st_mtime_ns, x.st_ctime_ns)
    try:
        for name, digest in approved.items():
            path = release / name
            require(all(not parent.is_symlink() for parent in path.parents if parent != release.parent),
                    'Fixed recharge source unavailable')
            expected = profile['sourceModes'][name]
            initial = path.lstat()
            raw = fixed_recharge_bytes(path, modes=(expected, expected | 0o020))
            stable = path.lstat()
            require(hashlib.sha256(raw).hexdigest() == digest, 'Fixed recharge source unavailable')
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            descriptors.append((descriptor, expected, path, identity(initial)))
            info = os.fstat(descriptor)
            require(identity(initial) == identity(info) == identity(stable) == identity(path.lstat()),
                    'Fixed recharge source unavailable')
        require(all(identity(os.fstat(descriptor)) == identity(path.lstat()) == original
            for descriptor, _expected, path, original in descriptors), 'Fixed recharge source unavailable')
        for descriptor, expected, _path, _original in descriptors:
            if stat.S_IMODE(os.fstat(descriptor).st_mode) != expected:
                os.fchmod(descriptor, expected)
    except OSError:
        raise RuntimeError('Fixed recharge source unavailable') from None
    finally:
        for descriptor, _mode, _path, _original in descriptors:
            os.close(descriptor)


def verify_fixed_recharge_archive(release, source, profile, *, checkout=False, names=None, require_approved=True):
    fixed_recharge_scope(profile, require_approved=require_approved)
    binding = fixed_recharge_binding(profile['id'])
    approved = {**profile['candidateSourceSha256'], **profile['carriedSourceOnlySha256'], **profile['controlSourceSha256']}
    baseline = fixed_recharge_archive(source, profile_id=profile['id'])
    actual = fixed_recharge_file_map(release, names=names,
        allowed=set(baseline) | set(approved) | {binding['file']})
    expected = {name: item for name, item in baseline.items() if name not in approved and name != binding['file']}
    require({name: item for name, item in actual.items() if name not in approved and name != binding['file']} == expected,
            'Fixed recharge source scope changed')
    require(all(actual.get(name) == (digest, profile['sourceModes'][name]) for name, digest in approved.items())
        and actual.get(binding['file'], (None, None))[1] in (0o644, 0o664),
        'Fixed recharge source scope changed')
    require(parse_fixed_recharge_scope(fixed_recharge_bytes(release / binding['file'],
        modes=(0o644, 0o664), limit=128 * 1024), require_approved=require_approved) == profile,
        'Fixed recharge runtime scope unavailable')


def check_fixed_recharge_scope(*, require_approved=True, profile_id=RECHARGE_SCOPE_ID):
    binding = fixed_recharge_binding(profile_id)
    source = Path(__file__).resolve().parents[2]
    profile = parse_fixed_recharge_scope(fixed_recharge_bytes(source / binding['file'],
        modes=(0o644,), limit=128 * 1024), require_approved=require_approved)
    require(profile['id'] == profile_id, 'Fixed recharge runtime scope unavailable')
    paths = run('git', '-C', str(source), 'ls-files', '-z').split('\x00')
    names = [name for name in paths if name]
    require(not run('git', '-C', str(source), 'ls-files', '--others', '--exclude-standard'),
            'Fixed recharge source scope changed')
    data = subprocess.run(['git', '-C', str(source), '-c', 'tar.umask=0022', 'archive', '--format=tar',
        '--prefix=id-business-system-' + binding['current'] + '/', binding['current']],
        capture_output=True, timeout=60)
    require(data.returncode == 0 and len(data.stdout) <= 64 * 1024 * 1024, 'Fixed recharge source unavailable')
    with tarfile.open(fileobj=io.BytesIO(data.stdout), mode='r:') as archive:
        verify_fixed_recharge_archive(source, archive, profile, checkout=True, names=names,
            require_approved=require_approved)


def fixed_recharge_baseline(previous, profile, manifest, states):
    if isinstance(profile, dict) and profile.get('id') == RECHARGE_MAIN80_ID:
        return main80_recharge_baseline(previous, profile, manifest, states)
    fixed_recharge_scope(profile)
    binding = fixed_recharge_binding(profile['id'])
    baseline = profile['baselineRelease']
    require(previous.resolve() == previous and previous.parent == BASE / 'releases',
            'Fixed recharge baseline changed')
    if profile['id'] == RECHARGE_7F_ID:
        require(re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + RECHARGE_7F_CURRENT[:12], previous.name)
            and manifest.get('servicesUpdated') == ['api'] and manifest.get('migrationApplied') is False
            and manifest.get('newMigrations') == [], 'Fixed recharge baseline changed')
        mailbox = mailbox_policy(previous)
    for name, key in (('release-manifest.json', 'manifestSha256'), ('before-audit.json', 'beforeAuditSha256'),
            ('after-audit.json', 'afterAuditSha256')):
        raw = private_maintenance_receipt(previous / name)
        require(hashlib.sha256(raw).hexdigest() == baseline[key], 'Fixed recharge baseline changed')
        value = fixed_recharge_json(raw)
        if name == 'release-manifest.json':
            require(historical_fingerprint(value) == historical_fingerprint(manifest)
                and all(value.get(key) == expected for key, expected in {
                'commit': binding['current'], 'sourceTree': binding['tree'],
                'previousCommit': binding['previous'], 'deploymentRun': binding['run'],
                'imageBuildRun': binding['imageRun']}.items()), 'Fixed recharge baseline changed')
        else:
            stage = name.split('-', 1)[0]
            require(value.get('ok') is False and type(value.get('checkCount')) is int and value['checkCount'] == 48
                and type(value.get('violationCount')) is int and value['violationCount'] == 6
                and historical_fingerprint(value.get('gate')) == historical_fingerprint({**binding['gate'], 'stage': stage})
                and historical_fingerprint(manifest.get('dataAudit' + stage.title(), {}).get('historicalException'))
                    == historical_fingerprint(value['gate']), 'Fixed recharge baseline changed')
            if profile['id'] == RECHARGE_7F_ID:
                summary = manifest.get('dataAudit' + stage.title())
                require(isinstance(summary, dict) and set(summary) == {'checkCount', 'violationCount', 'historicalException'}
                    and type(summary['checkCount']) is int and summary['checkCount'] == 48
                    and type(summary['violationCount']) is int and summary['violationCount'] == 6
                    and historical_fingerprint(value.get('checks')) == historical_fingerprint(mailbox['snapshot']['checks']),
                        'Fixed recharge baseline changed')
    compose_raw = fixed_recharge_bytes(previous / 'docker-compose.aws-mysql.yml', modes=(0o400, 0o600, 0o644, 0o664))
    override_raw = fixed_recharge_bytes(previous / 'compose.release.json', modes=(0o400, 0o600, 0o644))
    override = fixed_recharge_json(override_raw)
    expected_override = {'services': {service: {'image': manifest['images'][service]['reference'], 'pull_policy': 'never'}
        for service in (*SERVICES, 'migrate')}}
    require(hashlib.sha256(compose_raw).hexdigest() == baseline['composeSha256'] and has_registration_worker(previous)
        and hashlib.sha256(override_raw).hexdigest() == baseline['overrideRawSha256']
        and historical_fingerprint(override) == baseline['overrideCanonicalSha256'] and override == expected_override,
        'Fixed recharge baseline changed')
    require(set(states) == set(ALL_SERVICES) and all(state['status'] == 'running' for state in states.values())
        and all(states[service]['health'] == 'healthy' for service in ALL_SERVICES if service != 'caddy')
        and all(states[service]['image'] == manifest['images'][service]['digest']
            and states[service]['reference'] == manifest['images'][service]['reference'] for service in SERVICES)
        and all(re.fullmatch(r'[a-f0-9]{64}', state.get('containerId', ''))
            and re.fullmatch(r'[a-f0-9]{64}', state.get('startedAtSha256', '')) for state in states.values()),
        'Fixed recharge baseline changed')
    if profile['id'] == RECHARGE_7F_ID:
        preserved = manifest.get('mailboxPreservedStates')
        preserved_names = set(ALL_SERVICES) - {'api'}
        require(isinstance(preserved, dict) and set(preserved) == {'before', 'after'}
            and isinstance(preserved['before'], dict) and set(preserved['before']) == preserved_names
            and historical_fingerprint(preserved['before']) == historical_fingerprint(preserved['after'])
            and all(historical_fingerprint(preserved['after'][service]) == historical_fingerprint(states[service])
                for service in preserved_names), 'Fixed recharge baseline changed')
        for service in (*SERVICES, 'migrate'):
            image = manifest['images'][service]
            image_commit, image_run, image_attempt = (MAILBOX_IMAGE_IDENTITY if service == 'api'
                else (RECHARGE_SCOPE_CURRENT, '37302661631', '1'))
            require(image.get('sourceCommit') == image_commit
                and isinstance(image.get('digest'), str) and re.fullmatch(r'sha256:[a-f0-9]{64}', image['digest'])
                and isinstance(image.get('reference'), str) and re.fullmatch(
                    r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
                    + image_commit + '-' + image_run + '-' + image_attempt + '-' + image_service(service), image['reference']),
                'Fixed recharge baseline changed')
    origin = Path(manifest['previousRelease'])
    if profile['id'] == RECHARGE_7F_ID:
        require(origin.is_absolute() and origin.parent == BASE / 'releases' and origin.resolve() == origin
            and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + RECHARGE_SCOPE_CURRENT[:12], origin.name),
            'Fixed recharge baseline changed')
        raw = private_maintenance_receipt(origin / 'release-manifest.json')
        require(hashlib.sha256(raw).hexdigest() == MAILBOX_MANIFEST_SHA256, 'Fixed recharge baseline changed')
        finance_manifest = fixed_recharge_json(raw)
        require(finance_manifest.get('commit') == RECHARGE_SCOPE_CURRENT
            and finance_manifest.get('sourceTree') == RECHARGE_SCOPE_TREE
            and finance_manifest.get('previousCommit') == HISTORY_MAINTENANCE_BASELINE,
            'Fixed recharge baseline changed')
        policy = maintenance_policy(origin)
        origin = Path(finance_manifest['previousRelease'])
    else:
        policy = maintenance_policy(previous)
    require(origin.is_absolute() and origin.parent == BASE / 'releases' and origin.resolve() == origin
        and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + HISTORY_MAINTENANCE_BASELINE[:12], origin.name),
        'Fixed recharge baseline changed')
    verify_maintenance_baseline(origin, policy)
    return origin


def fixed_recharge_clean_finance_map(source):
    try:
        prefix = 'id-business-system-' + RECHARGE_SCOPE_CURRENT + '/'
        files, directories, seen = {}, set(), set()
        members = source.getmembers()
        require(0 < len(members) <= 10000, 'Fixed recharge source unavailable')
        total = 0
        for member in members:
            require(not member.issym() and not member.islnk() and (member.isfile() or member.isdir())
                and (member.name == prefix.rstrip('/') or member.name.startswith(prefix)),
                'Fixed recharge source unavailable')
            if member.name == prefix.rstrip('/'):
                require(member.isdir() and '' not in seen, 'Fixed recharge source unavailable')
                seen.add('')
                continue
            name = member.name[len(prefix):].rstrip('/') if member.isdir() else member.name[len(prefix):]
            require(name and str(Path(name)) == name and not Path(name).is_absolute()
                and '..' not in Path(name).parts and name not in seen, 'Fixed recharge source unavailable')
            seen.add(name)
            mode = member.mode & 0o7777
            if member.isdir():
                require(mode in (0o755, 0o775), 'Fixed recharge source unavailable')
                directories.add(name)
            else:
                total += member.size
                require(0 <= member.size <= 8 * 1024 * 1024 and total <= 64 * 1024 * 1024
                    and mode in (0o644, 0o664, 0o755, 0o775), 'Fixed recharge source unavailable')
                data = source.extractfile(member).read(8 * 1024 * 1024 + 1)
                require(len(data) == member.size, 'Fixed recharge source unavailable')
                if name in MAINTENANCE_CANDIDATE_FILES:
                    mode = 0o755 if name.endswith('.sh') else 0o644
                files[name] = (data, hashlib.sha256(data).hexdigest(), mode)
        required_directories = {str(parent) for name in files for parent in Path(name).parents if str(parent) != '.'}
        require(files and directories == required_directories and MAINTENANCE_CANDIDATE_FILES <= set(files),
                'Fixed recharge source unavailable')
        policy_name = 'deploy/aws/' + HISTORY_MAINTENANCE_POLICY_ID + '.json'
        require(policy_name in files, 'Fixed recharge finance source changed')
        policy = fixed_recharge_json(files[policy_name][0])
        require(historical_fingerprint(policy) == MAINTENANCE_POLICY_SHA256
            and isinstance(policy.get('candidateSourceSha256'), dict)
            and set(policy['candidateSourceSha256']) == MAINTENANCE_CANDIDATE_FILES
            and all(files[name][1] == digest for name, digest in policy['candidateSourceSha256'].items()),
            'Fixed recharge finance source changed')
        return files, directories
    except Exception as error:
        if isinstance(error, RuntimeError) and error.args in (('Fixed recharge source unavailable',), ('Fixed recharge finance source changed',)):
            raise
        raise RuntimeError('Fixed recharge source unavailable') from None


def verify_fixed_recharge_clean_finance_source(directory, source):
    try:
        require(directory.is_absolute() and directory.resolve() == directory
            and directory.parent.parent == BASE / '.staging'
            and re.fullmatch(r'oidc-[a-f0-9]{40}', directory.parent.name)
            and re.fullmatch(r'fixed-b8-finance-[1-9][0-9]*-[1-9][0-9]*', directory.name),
            'Fixed recharge source unavailable')
        files, directories = fixed_recharge_clean_finance_map(source)
        expected = {name: (digest, mode) for name, (_data, digest, mode) in files.items()}
        require(fixed_recharge_file_map(directory, allowed=set(expected)) == expected,
                'Fixed recharge finance source changed')
        actual_directories = {str(path.relative_to(directory)) for path in directory.rglob('*') if path.is_dir()}
        require(actual_directories == directories, 'Fixed recharge finance source changed')
        verify_fixed_recharge_finance_source(directory, source)
    except Exception as error:
        if isinstance(error, RuntimeError) and error.args in (('Fixed recharge source unavailable',), ('Fixed recharge finance source changed',)):
            raise
        raise RuntimeError('Fixed recharge source unavailable') from None


def prepare_fixed_recharge_finance_source(args, data):
    try:
        require(isinstance(args.commit, str) and re.fullmatch(r'[a-f0-9]{40}', args.commit)
            and isinstance(args.run_id, str) and re.fullmatch(r'[1-9][0-9]*', args.run_id)
            and isinstance(args.run_attempt, str) and re.fullmatch(r'[1-9][0-9]*', args.run_attempt)
            and isinstance(data, bytes) and 0 < len(data) <= 64 * 1024 * 1024,
            'Fixed recharge source unavailable')
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            files, directories = fixed_recharge_clean_finance_map(archive)
        require(BASE.resolve() == BASE and BASE.is_dir(), 'Fixed recharge source unavailable')
        parent = BASE / '.staging' / ('oidc-' + args.commit)
        for path in (BASE / '.staging', parent):
            if not path.exists() and not path.is_symlink():
                path.mkdir(mode=0o700)
            require(path.is_dir() and not path.is_symlink() and path.resolve() == path,
                    'Fixed recharge source unavailable')
        destination = parent / ('fixed-b8-finance-' + args.run_id + '-' + args.run_attempt)
        require(not destination.exists() and not destination.is_symlink(), 'Fixed recharge source unavailable')
        destination.mkdir(mode=0o700)
        for name in sorted(directories, key=lambda item: (len(Path(item).parts), item)):
            path = destination / name
            path.mkdir(mode=0o755)
            path.chmod(0o755)
        for name, (data_bytes, _digest, mode) in files.items():
            path = destination / name
            require(all(not parent_path.is_symlink() for parent_path in path.parents
                if parent_path == destination or destination in parent_path.parents), 'Fixed recharge source unavailable')
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(data_bytes)
                stream.flush()
                os.fchmod(stream.fileno(), mode)
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            verify_fixed_recharge_clean_finance_source(destination, archive)
        return destination
    except Exception as error:
        if isinstance(error, RuntimeError) and error.args in (('Fixed recharge source unavailable',), ('Fixed recharge finance source changed',)):
            raise
        raise RuntimeError('Fixed recharge source unavailable') from None


def verify_fixed_recharge_finance_source(previous, source):
    expected = fixed_recharge_archive(source)
    expected = {name: (digest, (0o755 if name.endswith('.sh') else 0o644)
        if name in MAINTENANCE_CANDIDATE_FILES else mode) for name, (digest, mode) in expected.items()}
    actual = fixed_recharge_file_map(previous, allowed=set(expected), omitted=('.env.aws.production', 'compose.release.json',
        'release-manifest.json', 'before-audit.json', 'after-audit.json', 'backup-verification.json'))
    require(actual == expected, 'Fixed recharge finance source changed')
    policy = maintenance_policy(previous)
    require(all(actual[name][0] == digest for name, digest in policy['candidateSourceSha256'].items()),
            'Fixed recharge finance source changed')


def fixed_recharge_context(args, profile, before_gate, after_gate):
    if isinstance(profile, dict) and profile.get('id') == RECHARGE_MAIN80_ID:
        return main80_recharge_context(args, profile, before_gate, after_gate)
    fixed_recharge_scope(profile)
    binding = fixed_recharge_binding(profile['id'])
    require(re.fullmatch(r'[a-f0-9]{40}', args.commit) and re.fullmatch(r'[a-f0-9]{40}', args.source_tree)
        and args.expected_current == binding['current'], 'Fixed recharge runtime scope unavailable')
    for stage, gate in (('before', before_gate), ('after', after_gate)):
        require(isinstance(gate, dict) and set(gate) == {'checkCount', 'violationCount', 'historicalException'}
            and type(gate['checkCount']) is int and gate['checkCount'] == 48
            and type(gate['violationCount']) is int and gate['violationCount'] == 6
            and historical_fingerprint(gate['historicalException']) == historical_fingerprint({**MAINTENANCE_EXPECTED_GATE, 'stage': stage}),
            'Fixed recharge fresh integrity gate failed')
    return {'version': 1, 'id': binding['id'], 'profileSha256': historical_fingerprint(profile),
        'expectedCurrent': binding['current'], 'sourceCommit': args.commit, 'sourceTree': args.source_tree,
        'servicesUpdated': ['auto-recharge'], 'financeValidator': 'EXISTING_MAINTENANCE_48',
        'sourceCommitForFinance': RECHARGE_SCOPE_CURRENT, 'originCommitForFinance': HISTORY_MAINTENANCE_BASELINE,
        'beforeGateSha256': historical_fingerprint(before_gate['historicalException']),
        'afterGateSha256': historical_fingerprint(after_gate['historicalException']),
        'unchangedServiceContainersPreserved': True, 'environmentUnchanged': True,
        'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED', 'cacheStatus': 'SKIPPED'}


def fixed_recharge_baseline_archive():
    with urllib.request.urlopen('https://github.com/wangchaozhuanyong/id-business-system/archive/'
            + RECHARGE_SCOPE_CURRENT + '.tar.gz', timeout=60) as response:
        data = response.read(64 * 1024 * 1024 + 1)
    require(len(data) <= 64 * 1024 * 1024, 'Fixed recharge source unavailable')
    return data


def fixed_recharge_runtime_archive(profile):
    fixed_recharge_scope(profile)
    binding = fixed_recharge_binding(profile['id'])
    if profile['id'] == RECHARGE_SCOPE_ID:
        return fixed_recharge_baseline_archive()
    with urllib.request.urlopen('https://github.com/wangchaozhuanyong/id-business-system/archive/'
            + binding['current'] + '.tar.gz', timeout=60) as response:
        data = response.read(64 * 1024 * 1024 + 1)
    require(len(data) <= 64 * 1024 * 1024, 'Fixed recharge source unavailable')
    return data


def fixed_recharge_audit(directory, receipt, *, stage, source, origin, before_receipt=None):
    result = maintenance_audit(directory, receipt, stage=stage, source=source,
        origin=origin, before_receipt=before_receipt)
    require(set(result) == {'checkCount', 'violationCount', 'historicalException'}
        and type(result['checkCount']) is int and result['checkCount'] == 48
        and type(result['violationCount']) is int and result['violationCount'] == 6
        and historical_fingerprint(result['historicalException']) == historical_fingerprint({**MAINTENANCE_EXPECTED_GATE, 'stage': stage}),
        'Fixed recharge fresh integrity gate failed')
    report = fixed_recharge_json(private_maintenance_receipt(receipt))
    require(report.get('ok') is False and type(report.get('checkCount')) is int and report['checkCount'] == 48
        and type(report.get('violationCount')) is int and report['violationCount'] == 6
        and historical_fingerprint(report.get('gate')) == historical_fingerprint(result['historicalException']),
        'Fixed recharge fresh integrity gate failed')
    return result


def fixed_recharge_preserved_states(states):
    return {service: {key: states[service][key] for key in
        ('image', 'reference', 'status', 'health', 'containerId', 'startedAtSha256')}
        for service in ALL_SERVICES if service != 'auto-recharge'}


def validate_fixed_recharge_readback_projection(value, expected_current, source_tree, profile_sha256,
        profile_id=RECHARGE_SCOPE_ID):
    if profile_id == RECHARGE_01CE_ID:
        return validate_recharge_01ce_readback_projection(value, expected_current, source_tree, profile_sha256)
    if profile_id == RECHARGE_MAIN80_ID:
        return validate_main80_recharge_readback_projection(value, expected_current, source_tree, profile_sha256)
    try:
        binding = fixed_recharge_binding(profile_id)
        require(isinstance(expected_current, str) and re.fullmatch(r'[a-f0-9]{40}', expected_current)
            and isinstance(source_tree, str) and re.fullmatch(r'[a-f0-9]{40}', source_tree)
            and isinstance(profile_sha256, str) and re.fullmatch(r'[a-f0-9]{64}', profile_sha256),
            'Fixed recharge deployment verification unavailable')
        expected = {'version': 1, 'id': binding['id'], 'status': 'VERIFIED', 'currentCommit': expected_current,
            'sourceTree': source_tree, 'previousCommit': binding['current'], 'profileSha256': profile_sha256,
            'servicesUpdated': ['auto-recharge'], 'preservedServiceCount': 6, 'checkCount': 48,
            'executedCheckCount': 48, 'unavailableCheckCount': 0, 'violationCount': 6, 'storedGatesMatched': True,
            'unchangedServiceContainersPreserved': True, 'environmentUnchanged': True,
            'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED', 'cacheStatus': 'SKIPPED',
            'liveServicesHealthy': True, 'rechargeImageMatched': True}
        require(isinstance(value, dict) and set(value) == set(expected)
            and historical_fingerprint(value) == historical_fingerprint(expected),
            'Fixed recharge deployment verification unavailable')
        return value
    except Exception:
        raise RuntimeError('Fixed recharge deployment verification unavailable') from None


def check_fixed_recharge_deployment(expected_current, source_tree, profile_sha256, profile_id=RECHARGE_SCOPE_ID):
    if profile_id == RECHARGE_01CE_ID:
        return check_recharge_01ce_deployment(expected_current, source_tree, profile_sha256)
    if profile_id == RECHARGE_MAIN80_ID:
        return check_main80_recharge_deployment(expected_current, source_tree, profile_sha256)
    try:
        binding = fixed_recharge_binding(profile_id)
        observed = {}
        def read(path, **kwargs):
            raw = fixed_recharge_bytes(path, **kwargs)
            if profile_id == RECHARGE_7F_ID:
                if path in observed:
                    require(raw == observed[path][0], 'Fixed recharge deployment verification unavailable')
                else:
                    observed[path] = (raw, kwargs)
            return raw
        require(isinstance(expected_current, str) and re.fullmatch(r'[a-f0-9]{40}', expected_current)
            and isinstance(source_tree, str) and re.fullmatch(r'[a-f0-9]{40}', source_tree)
            and isinstance(profile_sha256, str) and re.fullmatch(r'[a-f0-9]{64}', profile_sha256),
            'Fixed recharge deployment verification unavailable')
        current = (BASE / 'current').resolve()
        require(current.parent == BASE / 'releases'
            and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + expected_current[:12], current.name),
            'Fixed recharge deployment verification unavailable')
        profile = parse_fixed_recharge_scope(read(current / binding['file'],
            modes=(0o644, 0o664), limit=128 * 1024))
        require(profile['id'] == profile_id and historical_fingerprint(profile) == profile_sha256,
                'Fixed recharge deployment verification unavailable')
        manifest = fixed_recharge_json(read(current / 'release-manifest.json'))
        require(manifest.get('commit') == expected_current and manifest.get('sourceTree') == source_tree
            and manifest.get('previousCommit') == binding['current']
            and manifest.get('servicesUpdated') == ['auto-recharge']
            and manifest.get('migrationApplied') is False and manifest.get('newMigrations') == []
            and manifest.get('databaseGrants') == {'status': 'SKIPPED', 'reason': 'FIXED_RECHARGE_NO_MIGRATIONS'},
            'Fixed recharge deployment verification unavailable')
        previous = Path(manifest['previousRelease'])
        require(previous.parent == BASE / 'releases' and previous.resolve() == previous
            and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + binding['current'][:12], previous.name)
            and hashlib.sha256(read(previous / 'release-manifest.json')).hexdigest()
                == profile['baselineRelease']['manifestSha256'], 'Fixed recharge deployment verification unavailable')
        require(read(current / '.env.aws.production')
            == read(previous / '.env.aws.production'), 'Fixed recharge deployment verification unavailable')
        gates = {}
        for stage in ('before', 'after'):
            report = fixed_recharge_json(read(current / (stage + '-audit.json')))
            summary = manifest.get('dataAudit' + stage.title())
            require(report.get('ok') is False and type(report.get('checkCount')) is int and report['checkCount'] == 48
                and type(report.get('violationCount')) is int and report['violationCount'] == 6
                and historical_fingerprint(report.get('gate')) == historical_fingerprint({**MAINTENANCE_EXPECTED_GATE, 'stage': stage})
                and isinstance(summary, dict) and set(summary) == {'checkCount', 'violationCount', 'historicalException'}
                and type(summary['checkCount']) is int and summary['checkCount'] == 48
                and type(summary['violationCount']) is int and summary['violationCount'] == 6
                and historical_fingerprint(summary['historicalException']) == historical_fingerprint(report['gate']),
                'Fixed recharge deployment verification unavailable')
            gates[stage] = summary
        expected_context = fixed_recharge_context(argparse.Namespace(commit=expected_current,
            source_tree=source_tree, expected_current=binding['current']), profile, gates['before'], gates['after'])
        require(historical_fingerprint(manifest.get('fixedRechargeRelease')) == historical_fingerprint(expected_context),
                'Fixed recharge deployment verification unavailable')
        approved = {**profile['candidateSourceSha256'], **profile['carriedSourceOnlySha256'], **profile['controlSourceSha256']}
        for name, digest in approved.items():
            path = current / name
            require(all(not (current / Path(*Path(name).parts[:index])).is_symlink()
                    for index in range(1, len(Path(name).parts)))
                and hashlib.sha256(read(path, modes=(profile['sourceModes'][name],))).hexdigest() == digest,
                'Fixed recharge deployment verification unavailable')
        snapshots = manifest.get('fixedRechargePreservedStates')
        preserved = set(ALL_SERVICES) - {'auto-recharge'}
        row_keys = {'image', 'reference', 'status', 'health', 'containerId', 'startedAtSha256'}
        require(isinstance(snapshots, dict) and set(snapshots) == {'before', 'after'}
            and isinstance(snapshots['before'], dict) and set(snapshots['before']) == preserved
            and snapshots['before'] == snapshots['after'], 'Fixed recharge deployment verification unavailable')
        for service, state in snapshots['before'].items():
            require(isinstance(state, dict) and set(state) == row_keys and state['status'] == 'running'
                and (state['health'] is None if service == 'caddy' else state['health'] == 'healthy')
                and isinstance(state['reference'], str) and 0 < len(state['reference']) <= 512
                and isinstance(state['image'], str) and re.fullmatch(r'sha256:[a-f0-9]{64}', state['image'])
                and all(isinstance(state[key], str) and re.fullmatch(r'[a-f0-9]{64}', state[key])
                    for key in ('containerId', 'startedAtSha256')), 'Fixed recharge deployment verification unavailable')
        require(has_registration_worker(current)
            and hashlib.sha256(read(current / 'docker-compose.aws-mysql.yml',
                modes=(0o400, 0o600, 0o644, 0o664))).hexdigest() == profile['baselineRelease']['composeSha256'],
            'Fixed recharge deployment verification unavailable')
        live = {service: service_state(current, service, include_container_id=True) for service in ALL_SERVICES}
        require(fixed_recharge_preserved_states(live) == snapshots['after']
            and all(state['status'] == 'running' for state in live.values())
            and all(live[service]['health'] == 'healthy' for service in ALL_SERVICES if service != 'caddy'),
            'Fixed recharge deployment verification unavailable')
        image = manifest['images']['auto-recharge']
        deployment_run = manifest.get('deploymentRun')
        require(isinstance(deployment_run, str) and re.fullmatch(r'github-actions-[1-9][0-9]*-[1-9][0-9]*', deployment_run)
            and manifest.get('imageBuildRun') == deployment_run and image.get('sourceCommit') == expected_current
            and isinstance(image.get('reference'), str) and re.fullmatch(
                r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
                + expected_current + '-' + deployment_run.removeprefix('github-actions-') + '-auto-recharge', image['reference'])
            and live['auto-recharge']['reference'] == image['reference'] and live['auto-recharge']['image'] == image['digest'],
            'Fixed recharge deployment verification unavailable')
        override = fixed_recharge_json(read(current / 'compose.release.json', modes=(0o400, 0o600, 0o644)))
        require(override == {'services': {service: {'image': manifest['images'][service]['reference'], 'pull_policy': 'never'}
                for service in (*SERVICES, 'migrate')}}
            and all(manifest['images'][service]['reference'] == snapshots['after'][service]['reference']
                and manifest['images'][service]['digest'] == snapshots['after'][service]['image']
                for service in SERVICES if service != 'auto-recharge'), 'Fixed recharge deployment verification unavailable')
        inspected = json.loads(run('docker', 'image', 'inspect', live['auto-recharge']['image']))
        require(isinstance(inspected, list) and len(inspected) == 1
            and inspected[0]['Id'] == live['auto-recharge']['image'] and inspected[0]['Architecture'] == 'amd64'
            and inspected[0]['Config']['Labels'].get('org.opencontainers.image.revision') == expected_current,
            'Fixed recharge deployment verification unavailable')
        require((BASE / 'current').resolve() == current, 'Fixed recharge deployment verification unavailable')
        if profile_id == RECHARGE_7F_ID:
            for name in ('release-manifest.json', 'before-audit.json', 'after-audit.json'):
                read(previous / name)
            read(previous / 'docker-compose.aws-mysql.yml', modes=(0o400, 0o600, 0o644, 0o664))
            read(previous / 'compose.release.json', modes=(0o400, 0o600, 0o644))
            previous_manifest = fixed_recharge_json(read(previous / 'release-manifest.json'))
            baseline_states = dict(snapshots['before'])
            baseline_states['auto-recharge'] = previous_manifest['mailboxPreservedStates']['after']['auto-recharge']
            fixed_recharge_baseline(previous, profile, previous_manifest, baseline_states)
            run_id, run_attempt = deployment_run.removeprefix('github-actions-').split('-')
            finance_source = BASE / '.staging' / ('oidc-' + expected_current) / ('fixed-b8-finance-' + run_id + '-' + run_attempt)
            finance_archive = fixed_recharge_baseline_archive()
            with tarfile.open(fileobj=io.BytesIO(finance_archive), mode='r:gz') as archive:
                verify_fixed_recharge_clean_finance_source(finance_source, archive)
            require(all(fixed_recharge_bytes(path, **options) == raw
                for path, (raw, options) in observed.items()), 'Fixed recharge deployment verification unavailable')
            require({service: service_state(current, service, include_container_id=True)
                for service in ALL_SERVICES} == live, 'Fixed recharge deployment verification unavailable')
            require((BASE / 'current').resolve() == current, 'Fixed recharge deployment verification unavailable')
        return validate_fixed_recharge_readback_projection({'version': 1, 'id': binding['id'], 'status': 'VERIFIED', 'currentCommit': expected_current,
            'sourceTree': source_tree, 'previousCommit': binding['current'], 'profileSha256': profile_sha256,
            'servicesUpdated': ['auto-recharge'], 'preservedServiceCount': 6, 'checkCount': 48,
            'executedCheckCount': 48, 'unavailableCheckCount': 0, 'violationCount': 6, 'storedGatesMatched': True,
            'unchangedServiceContainersPreserved': True, 'environmentUnchanged': True,
            'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED', 'cacheStatus': 'SKIPPED',
            'liveServicesHealthy': True, 'rechargeImageMatched': True}, expected_current, source_tree, profile_sha256, profile_id)
    except Exception:
        raise RuntimeError('Fixed recharge deployment verification unavailable') from None


def check_main80_recharge_deployment(expected_current, source_tree, profile_sha256):
    try:
        message = 'Fixed recharge deployment verification unavailable'
        projection = {'version': 1, 'id': RECHARGE_MAIN80_ID, 'status': 'VERIFIED', 'currentCommit': expected_current,
            'sourceTree': source_tree, 'previousCommit': RECHARGE_MAIN80_CURRENT, 'profileSha256': profile_sha256,
            'servicesUpdated': ['auto-recharge'], 'preservedServiceCount': 6, 'checkCount': 49,
            'executedCheckCount': 49, 'unavailableCheckCount': 0, 'violationCount': 0, 'storedGatesMatched': True,
            'unchangedServiceContainersPreserved': True, 'environmentUnchanged': True,
            'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED', 'cacheStatus': 'SKIPPED',
            'liveServicesHealthy': True, 'rechargeImageMatched': True}
        validate_main80_recharge_readback_projection(projection, expected_current, source_tree, profile_sha256)
        current = (BASE / 'current').resolve()
        require(current.parent == BASE / 'releases' and current.resolve() == current
            and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + expected_current[:12], current.name), message)
        observed = {}
        def read(path, **options):
            raw = fixed_recharge_bytes(path, **options)
            require(path not in observed or observed[path][0] == raw, message)
            observed[path] = (raw, options)
            return raw
        profile = parse_fixed_recharge_scope(read(current / RECHARGE_MAIN80_FILE, modes=(0o644, 0o664), limit=128 * 1024))
        require(profile['id'] == RECHARGE_MAIN80_ID and historical_fingerprint(profile) == profile_sha256, message)
        manifest = fixed_recharge_json(read(current / 'release-manifest.json'))
        require(manifest.get('commit') == expected_current and manifest.get('sourceTree') == source_tree
            and manifest.get('previousCommit') == RECHARGE_MAIN80_CURRENT
            and manifest.get('servicesUpdated') == ['auto-recharge'] and manifest.get('migrationApplied') is False
            and manifest.get('newMigrations') == [] and manifest.get('databaseGrants') == {
                'status': 'SKIPPED', 'reason': 'FIXED_RECHARGE_NO_MIGRATIONS'}, message)
        previous = Path(manifest['previousRelease'])
        require(previous.is_absolute() and previous.resolve() == previous and previous.parent == BASE / 'releases', message)
        baseline_manifest = fixed_recharge_json(read(previous / 'release-manifest.json'))
        read(ORDER_ARCHIVE_SEAL); read(POST_CLEANUP_RECEIPT)
        for filename in ('order-archive-seal.reader.json', 'order-archive-cleanup.reader.json'):
            read(previous / filename, modes=(0o400,))
            read(current / filename, modes=(0o400,))
        main80_recharge_reader_evidence(current)
        read(previous / ('deploy/aws/' + HISTORY_ORDER_ARCHIVE_POLICY_ID + '.json'), modes=(0o644, 0o664))
        read(previous / 'compose.release.json', modes=(0o400, 0o600, 0o644))
        require(read(current / '.env.aws.production') == read(previous / '.env.aws.production'), message)
        snapshots = manifest.get('fixedRechargePreservedStates')
        preserved = set(ALL_SERVICES) - {'auto-recharge'}
        row_keys = {'image', 'reference', 'status', 'health', 'containerId', 'startedAtSha256', 'environmentSha256'}
        require(isinstance(snapshots, dict) and set(snapshots) == {'before', 'after'}
            and isinstance(snapshots['before'], dict) and set(snapshots['before']) == preserved
            and historical_fingerprint(snapshots['before']) == historical_fingerprint(snapshots['after']), message)
        for service, state in snapshots['before'].items():
            require(isinstance(state, dict) and set(state) == row_keys and state['status'] == 'running'
                and (state['health'] is None if service == 'caddy' else state['health'] == 'healthy')
                and isinstance(state['reference'], str) and 0 < len(state['reference']) <= 512
                and isinstance(state['image'], str) and re.fullmatch(r'sha256:[a-f0-9]{64}', state['image'])
                and all(isinstance(state[key], str) and re.fullmatch(r'[a-f0-9]{64}', state[key])
                    for key in ('containerId', 'startedAtSha256', 'environmentSha256')), message)
        baseline_states = {**snapshots['before'], 'auto-recharge':
            baseline_manifest['fixedRegistrationPreservedStates']['after']['auto-recharge']}
        archive_data = fixed_recharge_runtime_archive(profile)
        main80_recharge_baseline(previous, profile, baseline_manifest, baseline_states, source_archive=archive_data)
        origin = main80_recharge_origin(previous, baseline_manifest)
        policy, seal = main80_recharge_seal(origin, profile)
        frozen = fixed_recharge_json(read(origin / 'before-audit.json'))['gate']
        gates = {}
        for stage in ('before', 'after'):
            report = fixed_recharge_json(read(current / (stage + '-audit.json')))
            gates[stage] = require_registration_zero_report(report, stage, frozen)
            require(historical_fingerprint(manifest.get('dataAudit' + stage.title())) == historical_fingerprint(gates[stage]), message)
            original = fixed_recharge_json(read(previous / (stage + '-audit.json')))
            require_registration_zero_report(original, stage, frozen)
            require(historical_fingerprint(report['checks']) == historical_fingerprint(original['checks'])
                and historical_fingerprint(report['identity']) == historical_fingerprint(original['identity']), message)
        context = main80_recharge_context(argparse.Namespace(commit=expected_current, source_tree=source_tree,
            expected_current=RECHARGE_MAIN80_CURRENT), profile, gates['before'], gates['after'])
        require(historical_fingerprint(manifest.get('fixedRechargeRelease')) == historical_fingerprint(context), message)
        approved = {**profile['candidateSourceSha256'], **profile['carriedSourceOnlySha256'], **profile['controlSourceSha256']}
        for name, digest in approved.items():
            require(hashlib.sha256(read(current / name, modes=(profile['sourceModes'][name],))).hexdigest() == digest, message)
        require(read(current / 'docker-compose.aws-mysql.yml', modes=(0o644, 0o664))
            == read(previous / 'docker-compose.aws-mysql.yml', modes=(0o644, 0o664))
            and read(current / 'deploy/caddy/Caddyfile.aws', modes=(0o644, 0o664))
                == read(previous / 'deploy/caddy/Caddyfile.aws', modes=(0o644, 0o664)) and has_registration_worker(current), message)
        override = fixed_recharge_json(read(current / 'compose.release.json', modes=(0o400, 0o600, 0o644)))
        images = manifest['images']
        require(set(images) == set(baseline_manifest['images'])
            and override == {'services': {service: {'image': images[service]['reference'], 'pull_policy': 'never'}
                for service in (*SERVICES, 'migrate')}}
            and all(images[service] == baseline_manifest['images'][service]
                for service in images if service != 'auto-recharge'), message)
        live = {service: service_state(current, service, include_container_id=True, include_environment_hash=True)
            for service in ALL_SERVICES}
        require(main80_recharge_preserved_states(live) == snapshots['after']
            and all(state['status'] == 'running' for state in live.values())
            and all(live[service]['health'] == 'healthy' for service in ALL_SERVICES if service != 'caddy'), message)
        image, deployment_run = images['auto-recharge'], manifest.get('deploymentRun')
        require(isinstance(deployment_run, str) and re.fullmatch(r'github-actions-[1-9][0-9]*-[1-9][0-9]*', deployment_run)
            and manifest.get('imageBuildRun') == deployment_run and image.get('sourceCommit') == expected_current
            and isinstance(image.get('reference'), str) and re.fullmatch(
                r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
                + expected_current + '-' + deployment_run.removeprefix('github-actions-') + '-auto-recharge', image['reference'])
            and live['auto-recharge']['image'] == image['digest'] and live['auto-recharge']['reference'] == image['reference'], message)
        inspected = json.loads(run('docker', 'image', 'inspect', live['auto-recharge']['image']))
        require(isinstance(inspected, list) and len(inspected) == 1 and inspected[0]['Id'] == image['digest']
            and inspected[0]['Architecture'] == 'amd64'
            and inspected[0]['Config']['Labels'].get('org.opencontainers.image.revision') == expected_current, message)
        public_observed = verify_main80_recharge_candidate_source(current, archive_data, profile)
        main80_recharge_baseline(previous, profile, baseline_manifest, baseline_states, source_archive=archive_data)
        verify_main80_recharge_candidate_source(current, archive_data, profile)
        require({service: service_state(current, service, include_container_id=True, include_environment_hash=True)
            for service in ALL_SERVICES} == live and (BASE / 'current').resolve() == current, message)
        require(all(fixed_recharge_bytes(path, **options) == raw for path, (raw, options) in observed.items())
            and (BASE / 'current').resolve() == current, message)
        main80_recharge_reader_evidence(previous); main80_recharge_reader_evidence(current)
        require_main80_recharge_public_snapshot(public_observed)
        return validate_main80_recharge_readback_projection(projection, expected_current, source_tree, profile_sha256)
    except Exception:
        raise RuntimeError('Fixed recharge deployment verification unavailable') from None


def run_release_migrations(release, admin_only, historical_diagnostics=False):
    if not admin_only and not historical_diagnostics:
        compose(release, 'run', '--rm', '--no-deps', 'migrate', timeout=900)


REGISTRATION_SCOPE_ID = 'registration-worker-b8-80-20261006'
REGISTRATION_SCOPE_FILE = 'deploy/aws/' + REGISTRATION_SCOPE_ID + '.json'
REGISTRATION_CURRENT = '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'
REGISTRATION_SOURCE = '8dc096085ddb78fcf23c257257f5dc512fac1cf5'
REGISTRATION_WORKER_PREFIX = 'apps/api/src/id-business-v2/auto-recharge/worker/'
REGISTRATION_PROJECTION_SHA256 = '778547eff19ff80059f8aea605369cbe0820c44bfcb366fbf7fe307533870b83'
REGISTRATION_FILES = frozenset(REGISTRATION_WORKER_PREFIX + name for name in (
    'registration_browser.py', 'registration_job.py', 'test_registration.py',
    'test_registration_browser.py', 'test_registration_builtin.py'))
REGISTRATION_CONTROLS = frozenset({
    '.github/workflows/production-release.yml', 'scripts/production-release/build-images.sh',
    'scripts/production-release/push-images.sh', 'scripts/production-release/dispatch.sh',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/production-release/remote-deploy.py', 'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/registration-only-transport.test.py',
    'scripts/ci-recharge-scope.mjs', 'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.mjs', 'scripts/ci-recharge-release.test.mjs',
    'scripts/v2-registration-finance-audit.mjs', 'scripts/v2-registration-finance-audit.test.mjs'})
REGISTRATION_SOURCE_SHA256 = {'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': '6a484c2bf081a5fea20f650b66e9368c200930882635179e3a25c294faabc53b',
 'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py': '78cc204cc4e4b63494d42019b075a51c3ac4ee7494e6f55aee5d127ef7ce2590',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py': 'b49b874d9cfb5af42c9ddfa3fc348f7dc8470af0e140424c8035b446cd4dc471',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': 'af9778d037be3c7644371173a4a1a8143880ad2f385efd77d0739dae2ff91b53',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_builtin.py': '1d542dbd37870978a2c4b1bc0cd2878df8438d46d3b507684777204418f41bbe',
 'docs/AUTO_REGISTRATION.md': '3cb74e1f7269a5fa8dec5e6ca530147a310b261d43f44a62fbb979ad2aa6b11c'}
REGISTRATION_BASELINE = {'commit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
 'sourceTree': 'fbf9bd6e903ad8d7b83cf5701fde5c96347d5c1b',
 'previousCommit': '3ca300486d0edfadda83c094a48474a63959fce7',
 'deploymentRun': 'github-actions-37364471153-2',
 'manifestSha256': '622ce40b7d1144cb260fc9711773ddf37fb7000784dc3f1d4ec6fdbf6dd38e85',
 'beforeAuditSha256': '9b70752e23052cb18845ff33c7bc19d49f8757f5d15e5b6446fc6468682becf7',
 'afterAuditSha256': 'd9393cdc5ef3b89acf71ab59686f5d689457125b4e8fff59a8732f67be80b07c',
 'composeSha256': '05cd335251b31010af76b6c727927c2ae04158c481cb64186156229a3f6801b8',
 'overrideRawSha256': 'fdaf610856bdfef3983ab57586d67d199cb60552ac5000c142f1c7083cda7560',
 'overrideCanonicalSha256': 'd6448664a8a204e42f5b41cb79df3121874d3d8308925ce17c4c1a89c06f8925',
 'environmentRawSha256': 'a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af',
 'sourceArchiveSha256': '232c1a4c992fc31eb1e6c31011dd1a48e8a20889c57c5298841df509fdc9dd26',
 'runtimeEnvironmentSha256': {'admin': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4',
                              'api': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c',
                              'auto-recharge': '5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae',
                              'auto-registration': 'de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17',
                              'caddy': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181',
                              'media-resolver': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163',
                              'mysql': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'}}
REGISTRATION_FINANCE = {'kind': 'EXISTING_SEALED_ORDER_ARCHIVE_49',
 'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
 'candidateTree': 'fbf9bd6e903ad8d7b83cf5701fde5c96347d5c1b',
 'policyId': 'historical-finance-20261005-order-archive',
 'checkCount': 49,
 'executedCheckCount': 49,
 'unavailableCheckCount': 0,
 'violationCount': 5,
 'policyRawSha256': '243101271c3087f8bc87521972c0d698a2e2e444044268ec5eebf05b93b6e778',
 'policyCanonicalSha256': '91096c5c2cf5d6b1a3210794ec3cdf20aef54fe457d11b75df1735416d7c3511',
 'rulesSha256': 'fb3b0007d8db5a33cea63244cd0dfc17995e986f59c20dc2ea63a5add241e73a',
 'exceptionsSha256': '410340139d3ea77de19103e20d0577946cd920ce9ec229978f0fd3d081644bc9',
 'metadataSha256': '4ddafe1b4870da8e8a99871213e8cfd48282741fd8b977a37cfdb13e2292ddeb',
 'sources': {'accounts': {'rowCount': 2,
                          'sha256': '95e4a89173c5241290875f79cd96ac6c2e68e809b840dac3ff1987afb5bfab82'},
             'cashJournals': {'rowCount': 10,
                              'sha256': '7af63905fa4958871ed5d724ce51fafae336e8317295e5b1bf68a6533070ba26'},
             'cashLines': {'rowCount': 10,
                           'sha256': '0cb3f1804059f9610f81ce015f4e872b5152861a365ce772ee18f13f3151bef1'},
             'expenses': {'rowCount': 5,
                          'sha256': '740c382d78e85a9354083af0100bdbb65a5d6fb32035540387a17bc0e8541f2c'},
             'journals': {'rowCount': 5,
                          'sha256': 'df7e1a47198be81db1d59414d1204e50732cebcf77c8ad9a136bdfbea2e635b3'},
             'lines': {'rowCount': 10,
                       'sha256': 'f6c9e5d8df16ab6e8dc07140f44bd3c8db6bc0c97dd282ee7012f6f222e4a37c'}},
 'checksSha256': 'e1158ece628a1f952fe7cd9ab6c480208b0f3006575405af2cb9393971eefdd1',
 'gateSha256': {'before': '257f88bdc796c62582f9d8f4d8e7dc67b0fe5f46ae8d0370c53dcf16b535fa23',
                'after': 'a312a13b61f5e56a1901f81a2fd0094c7da588e1012fc09dc2b7a8cd55075ab3'},
 'releaseSealSha256': 'a3e241c715ceb01c18427f56d98a4ea173598afb3874e8b4522ce43a07d3fc0c',
 'preparedImagesSha256': '4ed683fae91fc60df43e2b068d4d18782e0d977676320fda5b194de72302f57d',
 'preparationRunId': 37362644900,
 'preparationRunAttempt': 1,
 'sourceProjectionTree': 'd9c2e534f0e71d5c88ffc4db492c4db2e79a9370',
 'sourceAnchorSha256': '39dd801292f081560fdaf7db2feb6cdd6f3c1bc8b730ca9add4d33a472466920',
 'cleanupReceiptSha256': 'f788c9328fd9f8eed17aa058a449d1f427f7ebadce97b2f29a0a321dc792315f'}
REGISTRATION_CLEARANCE = {'version': 1,
 'mode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
 'sourceCommit': '6a82a774f2a65e00d4f260c629f7152bf7935d1d',
 'checkCount': 49,
 'executedCheckCount': 49,
 'unavailableCheckCount': 0,
 'violationCount': 0,
 'rulesSha256': 'fb3b0007d8db5a33cea63244cd0dfc17995e986f59c20dc2ea63a5add241e73a',
 'sources': {'accounts': {'ids': ['02d8080d-68d8-4095-8b60-a30d5cd6c4e0',
                                  'c6866d24-097b-44c5-b3a7-f3a3dcc11b23'],
                          'rowCount': 2,
                          'sha256': '7e3f38a53838c3edc387498e6bb0ea8585af89b3606a0979c6d10441680172fb'},
             'cashJournals': {'ids': ['02d8080d-68d8-4095-8b60-a30d5cd6c4e0',
                                      'c6866d24-097b-44c5-b3a7-f3a3dcc11b23'],
                              'rowCount': 15,
                              'sha256': 'eba994ee593ab87b49e2c9d772e6b81dd5f84a8a5376c0a946e8f9258d61aa96'},
             'cashLines': {'ids': ['02d8080d-68d8-4095-8b60-a30d5cd6c4e0',
                                   'c6866d24-097b-44c5-b3a7-f3a3dcc11b23'],
                           'rowCount': 15,
                           'sha256': '6564164dd9d17c0617120e483ba79fbadeb0148c8c522066d137aa6a79059b79'},
             'expenses': {'ids': ['0e095178-8455-4f1d-8e45-d12b09064702',
                                  '10eb0ed7-3ce4-42a7-93e1-b83a898efe15',
                                  '49ba9779-9ff8-4bb8-8dd2-f587865f2a9e',
                                  '5a9ca0f0-2855-48e6-a50f-690dc64ebb65',
                                  'eb3f0d75-3802-49ab-8f3f-86fae65d8514'],
                          'rowCount': 5,
                          'sha256': '740c382d78e85a9354083af0100bdbb65a5d6fb32035540387a17bc0e8541f2c'},
             'journals': {'ids': ['0e095178-8455-4f1d-8e45-d12b09064702',
                                  '10eb0ed7-3ce4-42a7-93e1-b83a898efe15',
                                  '49ba9779-9ff8-4bb8-8dd2-f587865f2a9e',
                                  '5a9ca0f0-2855-48e6-a50f-690dc64ebb65',
                                  'eb3f0d75-3802-49ab-8f3f-86fae65d8514'],
                          'rowCount': 5,
                          'sha256': '51b7f09183c5cfeb4c107cefde6ce1c652d1f0167dbd7c567c34b7e50964f4fb'},
             'lines': {'ids': ['0e095178-8455-4f1d-8e45-d12b09064702',
                               '10eb0ed7-3ce4-42a7-93e1-b83a898efe15',
                               '49ba9779-9ff8-4bb8-8dd2-f587865f2a9e',
                               '5a9ca0f0-2855-48e6-a50f-690dc64ebb65',
                               'eb3f0d75-3802-49ab-8f3f-86fae65d8514'],
                       'rowCount': 10,
                       'sha256': 'f6c9e5d8df16ab6e8dc07140f44bd3c8db6bc0c97dd282ee7012f6f222e4a37c'}},
 'metadataSha256': '4ddafe1b4870da8e8a99871213e8cfd48282741fd8b977a37cfdb13e2292ddeb',
 'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
 'reversalCount': 5,
 'reversalAuditSha256': 'd90da27ad60e57116ef68f8e9e8a4f2af110cbd0e50b67d06937cf0946d8e3fc',
 'reversalChainSha256': '22b06da04b6aca6af194b7ed1053eb8f5f9851926c0a68478bf0f614a613aea9',
 'scope': {'deletedOrderSha256': ['a2ffdcf9fc09b3731b9b7fbdf41581ba5a810084ffc15172175b3ae67daed82d',
                                  'c06d6d101d1525ffdc8e8fd7790a7a038a20a71f8a833020698ca3010fc9df79'],
           'protectedOrderSha256': '4b95901aeeb2fdd34d0fe8784ebf0d4da58ccf2341bf27469f71bb3114e6332b'},
 'evidence': {'cash-five-clearance-completion-source-index-20261006-v2.json': 'f92fc07094fe7aacdf7762d331b96f5fe1b5cf1ebdb0267df59f7ac7c59cc8a2',
              'cash-five-clearance-inventory-fresh-before-20261006-v4.report.json': 'a458e31568c3810d229c0696a81cc185269bd50d426330837750a632d51cec0d',
              'cash-five-clearance-inventory-after-20261006-v4.report.json': '2921c7d8f81bfdac3f7e8b17a8bba85fe2fc3c3d17fd52b07c482b57c3f7cc1d',
              'cash-five-clearance-real49-after-20261006-v1.report.json': 'b89ed31f7b2f948c441a8d25fc412c0d8278182adec19386ff541bda54669788',
              'cash-five-clearance-five-real-ui-actions-20261006-v1.json': '28a07113cc4f399c885ba66e2afe4d55dbe5a70fe3841749e7fbda99a390dde8',
              'cash-five-clearance-independent-actual-final-review-20261006-v1.json': 'a74b8c4631a36d182eca28266e50f36e62db72518a4a3ea8d4f78f4783e094fe'}}
REGISTRATION_SCOPE = {
    'servicesUpdated': ['auto-registration'], 'imageServices': ['auto-recharge'],
    'preservedServices': ['auto-recharge', 'api', 'admin', 'media-resolver', 'mysql', 'caddy'],
    **{key: False for key in ('imageReuseAllowed', 'cacheCleanupAllowed', 'migrationDeploymentAllowed',
        'financialWritesAllowed', 'googleDriveConfigAllowed', 'databaseGrantSyncAllowed')}}

REGISTRATION_CONTINUATION_ID = 'registration-worker-956-20261006'
REGISTRATION_CONTINUATION_FILE = 'deploy/aws/' + REGISTRATION_CONTINUATION_ID + '.json'
REGISTRATION_CONTINUATION_CURRENT = '9560d8038a39d4ded1e560d484bdcb941a5d9c43'
# Reviewed recovery source; runtime956 and sealed finance80 remain separate.
REGISTRATION_CONTINUATION_SOURCE = '104f9752235d4181a7e0f990aa5cea129521da5d'
REGISTRATION_CONTINUATION_SOURCE_SHA256 = {'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': '7e63151ff07d3a313df7219087707fe1901a32e937253747268cb433b57e5869',
 'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py': '78cc204cc4e4b63494d42019b075a51c3ac4ee7494e6f55aee5d127ef7ce2590',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py': 'b49b874d9cfb5af42c9ddfa3fc348f7dc8470af0e140424c8035b446cd4dc471',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': '37c71e006d5c8d0ce864d1ead17f66897b097219c81c9f85f749cd682ec8fbfe',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_builtin.py': '1d542dbd37870978a2c4b1bc0cd2878df8438d46d3b507684777204418f41bbe',
 'docs/AUTO_REGISTRATION.md': '3cb74e1f7269a5fa8dec5e6ca530147a310b261d43f44a62fbb979ad2aa6b11c'}
REGISTRATION_CONTINUATION_PROJECTION_SHA256 = '987ceb30883b153bdf3336de7fb53f1bbe5abb9692b886bf58cde61e36db4ecc'
REGISTRATION_CONTINUATION_BASELINE = {'current': '/opt/id-business-v2/releases/20261006T080427Z-9560d8038a39',
 'manifest': {'commit': '9560d8038a39d4ded1e560d484bdcb941a5d9c43',
              'sourceTree': 'b91e1881cccb0357c5dcab62aaa6eb8d2147410d',
              'previousCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
              'previousRelease': '/opt/id-business-v2/releases/20261006T045149Z-80bddb1a8d8f',
              'deploymentRun': 'github-actions-37433318237-1',
              'imageBuildRun': 'github-actions-37433318237-1',
              'sourceArchiveSha256': '1a96ba285670c69f2eb73e3dacb44d5e2692c09d05e71394e73f5649da4efb3e',
              'servicesUpdated': ['auto-registration'],
              'migrationApplied': False,
              'newMigrations': [],
              'images': {'admin': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                                   'digest': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                                   'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'caddy': {'digest': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510'},
                         'api': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                                 'digest': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                                 'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'migrate': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-migrate',
                                     'digest': 'sha256:6f2c0d6f71c23ee2ec0565c1dae9a0a79f42dcf5ccb589bf0583c2b9e78414f9',
                                     'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'auto-recharge': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                           'digest': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                           'sourceCommit': '3ca300486d0edfadda83c094a48474a63959fce7'},
                         'media-resolver': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                            'digest': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                            'sourceCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'},
                         'auto-registration': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:9560d8038a39d4ded1e560d484bdcb941a5d9c43-37433318237-1-auto-recharge',
                                               'digest': 'sha256:c06ce21a0af054fc835f01b9ba006994b5eb1eb9c830f5922e5998f621d3fe5e',
                                               'sourceCommit': '9560d8038a39d4ded1e560d484bdcb941a5d9c43'}},
              'fixedRegistrationRelease': {'id': 'registration-worker-b8-80-20261006',
                                           'profileRawSha256': 'd5c023887b22f6a555abe0f8e4627113d5a45dec0668ae2abc1bb8fbf8cbdb28',
                                           'registrationSourceCommit': '8dc096085ddb78fcf23c257257f5dc512fac1cf5',
                                           'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
                                           'workerProjectionSha256': '778547eff19ff80059f8aea605369cbe0820c44bfcb366fbf7fe307533870b83',
                                           'financeSourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
                                           'financePolicyId': 'historical-finance-20261005-order-archive',
                                           'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
                                           'clearanceSealSha256': '46f1b091459ba540af2c26a2fad3136d1ca4b7f269d2a77bd6c97c48976ee520',
                                           'environmentUnchanged': True,
                                           'migrationStatus': 'SKIPPED',
                                           'databaseGrantSyncStatus': 'SKIPPED',
                                           'cacheStatus': 'SKIPPED'}},
 'fileSha256': {'release-manifest.json': 'e5790c0274d87ccb1fb4338af28e000c3434d26dd8f3665131457725710be0b7',
                'before-audit.json': '33a40bc174442a54e4f0c699ba7093d68d8f7851d6f61cc2e2a56818073f5e5f',
                'after-audit.json': 'e14bb2604dc1d68ffd72a48b92ace83e986e26dffd61e7e6180c6645b6a3d595',
                'docker-compose.aws-mysql.yml': '05cd335251b31010af76b6c727927c2ae04158c481cb64186156229a3f6801b8',
                'compose.release.json': 'b026965a0f353cdaabe294acd92d08dcf4a1491ca25edae34d716ac48036f009',
                '.env.aws.production': 'a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af',
                'deploy/aws/registration-worker-b8-80-20261006.json': 'd5c023887b22f6a555abe0f8e4627113d5a45dec0668ae2abc1bb8fbf8cbdb28'},
 'overrideCanonicalSha256': '9c032c2cf23d0d6cd41a209bd8a1f3f3d92d193e2b04db8b2424df495c6e71ec',
 'audits': {'before': {'checkCount': 49,
                       'violationCount': 0,
                       'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                       'gateSha256': 'ec68038c2606fabc6f5408a0e79784a6dc1b142acfc9cc6b78035581f907041f',
                       'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'},
            'after': {'checkCount': 49,
                      'violationCount': 0,
                      'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                      'gateSha256': '80be54958db3f671aca657fe52949f42b36fda1679d88e1fdb0c1655f54c79fb',
                      'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'}},
 'liveServices': {'media-resolver': {'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                     'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                     'status': 'running',
                                     'health': 'healthy',
                                     'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                     'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                     'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163'},
                  'auto-recharge': {'image': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                    'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                    'status': 'running',
                                    'health': 'healthy',
                                    'containerId': '2c7dafce90530efa1f1afbdf031f07ed07e9a6ad3b23a92d418c3cb700deed35',
                                    'startedAtSha256': '6e263adbdd786eb3c27b34deefab967124700b7a6d14d497f65e0e5975b5a45e',
                                    'environmentSha256': '5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae'},
                  'auto-registration': {'image': 'sha256:c06ce21a0af054fc835f01b9ba006994b5eb1eb9c830f5922e5998f621d3fe5e',
                                        'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:9560d8038a39d4ded1e560d484bdcb941a5d9c43-37433318237-1-auto-recharge',
                                        'status': 'running',
                                        'health': 'healthy',
                                        'containerId': 'b63a41f72b8631cd40e86a5a61e9e8676501bfddfb05603cceef67f9cb4fc0a2',
                                        'startedAtSha256': 'b2cf8637bd8bd73f2576a71c0f17bb9d95603a07e78e056cda71fb4a5bb6f506',
                                        'environmentSha256': 'de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17'},
                  'api': {'image': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                          'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                          'status': 'running',
                          'health': 'healthy',
                          'containerId': '8e9f22d9ec615945844d846abca8c34f827d156b13154cf0382c55148407d5ff',
                          'startedAtSha256': '2df79a73b30f3b54252ba0f8d8276815c704037cd19454a56c12074a0d57aa12',
                          'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c'},
                  'admin': {'image': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                            'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '8c34a75da43b9877b1ebf8110c41c726f3f7756473ab91c86fdc4f767dd2f075',
                            'startedAtSha256': '499f832cd2baf51fa672a43d21922953ae003854a1678facee86a6c5f68423b8',
                            'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4'},
                  'mysql': {'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                            'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                            'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                            'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'},
                  'caddy': {'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                            'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                            'status': 'running',
                            'health': None,
                            'containerId': '60d68c4e7c96e46c905d77bc059b3e5e93535d86710dfe19f791587790056cab',
                            'startedAtSha256': '7c0ca0361f561b614aea52e22030becb250582f6b3e87e496c59ccc4d7f081cc',
                            'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181'}},
 'readback': {'version': 1,
              'id': 'registration-worker-b8-80-20261006',
              'status': 'VERIFIED',
              'currentCommit': '9560d8038a39d4ded1e560d484bdcb941a5d9c43',
              'sourceTree': 'b91e1881cccb0357c5dcab62aaa6eb8d2147410d',
              'profileSha256': 'd5c023887b22f6a555abe0f8e4627113d5a45dec0668ae2abc1bb8fbf8cbdb28',
              'previousCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
              'registrationSourceCommit': '8dc096085ddb78fcf23c257257f5dc512fac1cf5',
              'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
              'workerProjectionSha256': '778547eff19ff80059f8aea605369cbe0820c44bfcb366fbf7fe307533870b83',
              'servicesUpdated': ['auto-registration'],
              'preservedServiceCount': 6,
              'checkCount': 49,
              'executedCheckCount': 49,
              'unavailableCheckCount': 0,
              'violationCount': 0,
              'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
              'runningSourceMatched': True,
              'unchangedServiceContainersPreserved': True,
              'environmentUnchanged': True,
              'migrationStatus': 'SKIPPED',
              'databaseGrantSyncStatus': 'SKIPPED',
              'cacheStatus': 'SKIPPED',
              'liveServicesHealthy': True}}


# Fixed initial-form Worker source; older runtime and finance seals remain separate.
REGISTRATION_INITIAL_ID = 'registration-worker-85-20261006'
REGISTRATION_INITIAL_FILE = 'deploy/aws/' + REGISTRATION_INITIAL_ID + '.json'
REGISTRATION_INITIAL_CURRENT = '85e94572cd965dd993743d12d55a3e91d60b6444'
REGISTRATION_INITIAL_SOURCE = 'd9a494cc949b6b9dab0bd4d6fddf70b358b45cec'
REGISTRATION_INITIAL_SOURCE_SHA256 = {'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': '064ae6c4315490317fec00329790b1e85cc484fbf3e2c4d9b01ea9583b45d492', 'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py': '78cc204cc4e4b63494d42019b075a51c3ac4ee7494e6f55aee5d127ef7ce2590', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py': 'b49b874d9cfb5af42c9ddfa3fc348f7dc8470af0e140424c8035b446cd4dc471', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': 'c8ac3e3f82cbf069b641ae704fc6475f90cab97ae18ef92f91589c1382a9cf3b', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_builtin.py': '1d542dbd37870978a2c4b1bc0cd2878df8438d46d3b507684777204418f41bbe', 'docs/AUTO_REGISTRATION.md': '3cb74e1f7269a5fa8dec5e6ca530147a310b261d43f44a62fbb979ad2aa6b11c'}
REGISTRATION_INITIAL_PROJECTION_SHA256 = '8a73f7de0c14ef4412f17aafecb85894fd59e7b435714156d3c8f7ec630bd211'
REGISTRATION_INITIAL_BASELINE = {'current': '/opt/id-business-v2/releases/20261006T092026Z-85e94572cd96',
 'manifest': {'commit': '85e94572cd965dd993743d12d55a3e91d60b6444',
              'sourceTree': '4e6a0414c51531f9e92fa984db3a8337424a7712',
              'previousCommit': '9560d8038a39d4ded1e560d484bdcb941a5d9c43',
              'previousRelease': '/opt/id-business-v2/releases/20261006T080427Z-9560d8038a39',
              'deploymentRun': 'github-actions-37441860321-1',
              'imageBuildRun': 'github-actions-37441860321-1',
              'sourceArchiveSha256': '7b71035a3f908a304803c03fbfa292419196dbc4f4a3194e70b842feb4b6d71b',
              'servicesUpdated': ['auto-registration'],
              'migrationApplied': False,
              'newMigrations': [],
              'images': {'admin': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                                   'digest': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                                   'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'caddy': {'digest': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510'},
                         'api': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                                 'digest': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                                 'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'migrate': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-migrate',
                                     'digest': 'sha256:6f2c0d6f71c23ee2ec0565c1dae9a0a79f42dcf5ccb589bf0583c2b9e78414f9',
                                     'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'auto-recharge': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                           'digest': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                           'sourceCommit': '3ca300486d0edfadda83c094a48474a63959fce7'},
                         'media-resolver': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                            'digest': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                            'sourceCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'},
                         'auto-registration': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:85e94572cd965dd993743d12d55a3e91d60b6444-37441860321-1-auto-recharge',
                                               'digest': 'sha256:1705c4f2ed766887f7f985ce23cf58f5b1b3b2852cd9741b42776cdd8156c504',
                                               'sourceCommit': '85e94572cd965dd993743d12d55a3e91d60b6444'}},
              'fixedRegistrationRelease': {'id': 'registration-worker-956-20261006',
                                           'profileRawSha256': '60226df9c51cb222bf8c0cc09a7783b52a8f0082f728189ec3ada9554b6dbfc1',
                                           'registrationSourceCommit': '104f9752235d4181a7e0f990aa5cea129521da5d',
                                           'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
                                           'workerProjectionSha256': '987ceb30883b153bdf3336de7fb53f1bbe5abb9692b886bf58cde61e36db4ecc',
                                           'financeSourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
                                           'financePolicyId': 'historical-finance-20261005-order-archive',
                                           'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
                                           'clearanceSealSha256': '46f1b091459ba540af2c26a2fad3136d1ca4b7f269d2a77bd6c97c48976ee520',
                                           'environmentUnchanged': True,
                                           'migrationStatus': 'SKIPPED',
                                           'databaseGrantSyncStatus': 'SKIPPED',
                                           'cacheStatus': 'SKIPPED'}},
 'fileSha256': {'release-manifest.json': '19bfd193ab0fa26412e7aafbd1e04de6cd81cdd419845ac0878286483b4f7153',
                'before-audit.json': '3000c588931ca0c53d74cff816832cda2a7668865a7917653b0b154529c2a217',
                'after-audit.json': '8c95dea94e8e01645d8f41a075391f0f7989d8174cff9292e533ac7d71afbdaa',
                'docker-compose.aws-mysql.yml': '05cd335251b31010af76b6c727927c2ae04158c481cb64186156229a3f6801b8',
                'compose.release.json': '9dcaa0612b19d31fc9192957194d3104246a951a91beb86fe60f4f29aec7ba09',
                '.env.aws.production': 'a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af',
                'deploy/aws/registration-worker-956-20261006.json': '60226df9c51cb222bf8c0cc09a7783b52a8f0082f728189ec3ada9554b6dbfc1'},
 'overrideCanonicalSha256': '10611ed37b054f167209ede21a19fa53060f212dedea9e5dd7fe5ed808d3ffae',
 'audits': {'before': {'checkCount': 49,
                       'violationCount': 0,
                       'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                       'gateSha256': 'ec68038c2606fabc6f5408a0e79784a6dc1b142acfc9cc6b78035581f907041f',
                       'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'},
            'after': {'checkCount': 49,
                      'violationCount': 0,
                      'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                      'gateSha256': '80be54958db3f671aca657fe52949f42b36fda1679d88e1fdb0c1655f54c79fb',
                      'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'}},
 'liveServices': {'media-resolver': {'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                     'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                     'status': 'running',
                                     'health': 'healthy',
                                     'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                     'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                     'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163'},
                  'auto-recharge': {'image': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                    'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                    'status': 'running',
                                    'health': 'healthy',
                                    'containerId': '2c7dafce90530efa1f1afbdf031f07ed07e9a6ad3b23a92d418c3cb700deed35',
                                    'startedAtSha256': '6e263adbdd786eb3c27b34deefab967124700b7a6d14d497f65e0e5975b5a45e',
                                    'environmentSha256': '5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae'},
                  'auto-registration': {'image': 'sha256:1705c4f2ed766887f7f985ce23cf58f5b1b3b2852cd9741b42776cdd8156c504',
                                        'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:85e94572cd965dd993743d12d55a3e91d60b6444-37441860321-1-auto-recharge',
                                        'status': 'running',
                                        'health': 'healthy',
                                        'containerId': '66855d42abd61b3b4055bff19af0f05c90a9099c23348f1e2746ad4cefb56896',
                                        'startedAtSha256': '5ff658a197cf9d3926eaa5f8d60b14f0bf65d31db0765d706ddf102a613c7353',
                                        'environmentSha256': 'de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17'},
                  'api': {'image': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                          'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                          'status': 'running',
                          'health': 'healthy',
                          'containerId': '8e9f22d9ec615945844d846abca8c34f827d156b13154cf0382c55148407d5ff',
                          'startedAtSha256': '2df79a73b30f3b54252ba0f8d8276815c704037cd19454a56c12074a0d57aa12',
                          'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c'},
                  'admin': {'image': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                            'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '8c34a75da43b9877b1ebf8110c41c726f3f7756473ab91c86fdc4f767dd2f075',
                            'startedAtSha256': '499f832cd2baf51fa672a43d21922953ae003854a1678facee86a6c5f68423b8',
                            'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4'},
                  'mysql': {'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                            'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                            'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                            'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'},
                  'caddy': {'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                            'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                            'status': 'running',
                            'health': None,
                            'containerId': '60d68c4e7c96e46c905d77bc059b3e5e93535d86710dfe19f791587790056cab',
                            'startedAtSha256': '7c0ca0361f561b614aea52e22030becb250582f6b3e87e496c59ccc4d7f081cc',
                            'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181'}},
 'readback': {'version': 1,
              'id': 'registration-worker-956-20261006',
              'status': 'VERIFIED',
              'currentCommit': '85e94572cd965dd993743d12d55a3e91d60b6444',
              'sourceTree': '4e6a0414c51531f9e92fa984db3a8337424a7712',
              'profileSha256': '60226df9c51cb222bf8c0cc09a7783b52a8f0082f728189ec3ada9554b6dbfc1',
              'previousCommit': '9560d8038a39d4ded1e560d484bdcb941a5d9c43',
              'registrationSourceCommit': '104f9752235d4181a7e0f990aa5cea129521da5d',
              'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
              'workerProjectionSha256': '987ceb30883b153bdf3336de7fb53f1bbe5abb9692b886bf58cde61e36db4ecc',
              'servicesUpdated': ['auto-registration'],
              'preservedServiceCount': 6,
              'checkCount': 49,
              'executedCheckCount': 49,
              'unavailableCheckCount': 0,
              'violationCount': 0,
              'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
              'runningSourceMatched': True,
              'unchangedServiceContainersPreserved': True,
              'environmentUnchanged': True,
              'migrationStatus': 'SKIPPED',
              'databaseGrantSyncStatus': 'SKIPPED',
              'cacheStatus': 'SKIPPED',
              'liveServicesHealthy': True}}


# Fixed email-submit Worker source; all three predecessor and original finance seals remain separate.
REGISTRATION_EMAIL_ID = 'registration-worker-86-20261006'
REGISTRATION_EMAIL_FILE = 'deploy/aws/' + REGISTRATION_EMAIL_ID + '.json'
REGISTRATION_EMAIL_FILES = REGISTRATION_FILES | frozenset({REGISTRATION_WORKER_PREFIX + 'test_registration_auto_code.py'})
REGISTRATION_EMAIL_CURRENT = 'fd3a6da610c505c2b7a51601cf854182991ffd12'
REGISTRATION_EMAIL_SOURCE = '932a03d3c9231c3c28ff295060f9c267e5597831'
REGISTRATION_EMAIL_SOURCE_SHA256 = {'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': '7b3e374c94ab704d3837d92028f857744b7f4188cd597a4a8b3443af58f7dbe9', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': '5f4a5c5e71a65ebf61e3afa2e081a91d0667987f58f601f3ca0875a302513073', 'docs/AUTO_REGISTRATION.md': '3cb74e1f7269a5fa8dec5e6ca530147a310b261d43f44a62fbb979ad2aa6b11c', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py': 'b49b874d9cfb5af42c9ddfa3fc348f7dc8470af0e140424c8035b446cd4dc471', 'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py': '78cc204cc4e4b63494d42019b075a51c3ac4ee7494e6f55aee5d127ef7ce2590', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py': '6e2509a91ec5c96fa8d2d9b874046bb6b16b91aacff3a752395ed50bbbd69d7a', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_builtin.py': '1d542dbd37870978a2c4b1bc0cd2878df8438d46d3b507684777204418f41bbe'}
REGISTRATION_EMAIL_PROJECTION_SHA256 = '2b746ef23153633d2b4032f61cfc210979b72cc19fc8f6f43b66619b6c992d3f'
REGISTRATION_EMAIL_BASELINE = {'current': '/opt/id-business-v2/releases/20261006T103328Z-fd3a6da610c5',
 'manifest': {'commit': 'fd3a6da610c505c2b7a51601cf854182991ffd12',
              'sourceTree': 'bd82ae5a41fba40e9e914b5c91f6b341952b2884',
              'previousCommit': '85e94572cd965dd993743d12d55a3e91d60b6444',
              'previousRelease': '/opt/id-business-v2/releases/20261006T092026Z-85e94572cd96',
              'deploymentRun': 'github-actions-37448091340-2',
              'imageBuildRun': 'github-actions-37448091340-2',
              'sourceArchiveSha256': '9c262e61564f216b36e138ef84ae43fc12b4329f0cbca63f06bcabf033c1e2bd',
              'servicesUpdated': ['auto-registration'],
              'migrationApplied': False,
              'newMigrations': [],
              'images': {'admin': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                                   'digest': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                                   'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'caddy': {'digest': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510'},
                         'api': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                                 'digest': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                                 'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'migrate': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-migrate',
                                     'digest': 'sha256:6f2c0d6f71c23ee2ec0565c1dae9a0a79f42dcf5ccb589bf0583c2b9e78414f9',
                                     'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'auto-recharge': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                           'digest': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                           'sourceCommit': '3ca300486d0edfadda83c094a48474a63959fce7'},
                         'media-resolver': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                            'digest': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                            'sourceCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'},
                         'auto-registration': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:fd3a6da610c505c2b7a51601cf854182991ffd12-37448091340-2-auto-recharge',
                                               'digest': 'sha256:e900edbf53bef6bac5249ef44aafe3fbe34bcde65c182fff3a005c84c61ac37a',
                                               'sourceCommit': 'fd3a6da610c505c2b7a51601cf854182991ffd12'}},
              'fixedRegistrationRelease': {'id': 'registration-worker-85-20261006',
                                           'profileRawSha256': '02fc3375314ee75b6e5b8ec47ce715f1e02f9b744ce77c5a4804d9110ba4daec',
                                           'registrationSourceCommit': 'd9a494cc949b6b9dab0bd4d6fddf70b358b45cec',
                                           'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
                                           'workerProjectionSha256': '8a73f7de0c14ef4412f17aafecb85894fd59e7b435714156d3c8f7ec630bd211',
                                           'financeSourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
                                           'financePolicyId': 'historical-finance-20261005-order-archive',
                                           'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
                                           'clearanceSealSha256': '46f1b091459ba540af2c26a2fad3136d1ca4b7f269d2a77bd6c97c48976ee520',
                                           'environmentUnchanged': True,
                                           'migrationStatus': 'SKIPPED',
                                           'databaseGrantSyncStatus': 'SKIPPED',
                                           'cacheStatus': 'SKIPPED'}},
 'fileSha256': {'release-manifest.json': '435698be282ee4300e45a2018669fe9b6931a09c6315f453f48a050a30a6810d',
                'before-audit.json': '178a06fdbc8c736143212ad4f3f4f1e0299b7b61406f13ff7198922aaa9b423b',
                'after-audit.json': 'c4f75c846d09a3596028296a77d2015e41244542619e81c5c9d21b0341e51d3c',
                'docker-compose.aws-mysql.yml': '05cd335251b31010af76b6c727927c2ae04158c481cb64186156229a3f6801b8',
                'compose.release.json': '2c3c267d6006bbb52ed6e1a3c02836484728f9b78c301ba4344e7d4ebf8a027c',
                '.env.aws.production': 'a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af',
                'deploy/aws/registration-worker-b8-80-20261006.json': 'd5c023887b22f6a555abe0f8e4627113d5a45dec0668ae2abc1bb8fbf8cbdb28',
                'deploy/aws/registration-worker-956-20261006.json': '60226df9c51cb222bf8c0cc09a7783b52a8f0082f728189ec3ada9554b6dbfc1',
                'deploy/aws/registration-worker-85-20261006.json': '02fc3375314ee75b6e5b8ec47ce715f1e02f9b744ce77c5a4804d9110ba4daec'},
 'overrideCanonicalSha256': '2ab142b8a2a6844065ffdeb08c5d869418ab49312290e762710370bf04f105bc',
 'audits': {'before': {'checkCount': 49,
                       'violationCount': 0,
                       'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                       'gateSha256': 'ec68038c2606fabc6f5408a0e79784a6dc1b142acfc9cc6b78035581f907041f',
                       'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'},
            'after': {'checkCount': 49,
                      'violationCount': 0,
                      'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                      'gateSha256': '80be54958db3f671aca657fe52949f42b36fda1679d88e1fdb0c1655f54c79fb',
                      'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'}},
 'liveServices': {'media-resolver': {'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                     'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                     'status': 'running',
                                     'health': 'healthy',
                                     'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                     'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                     'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163'},
                  'auto-recharge': {'image': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                    'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                    'status': 'running',
                                    'health': 'healthy',
                                    'containerId': '2c7dafce90530efa1f1afbdf031f07ed07e9a6ad3b23a92d418c3cb700deed35',
                                    'startedAtSha256': '6e263adbdd786eb3c27b34deefab967124700b7a6d14d497f65e0e5975b5a45e',
                                    'environmentSha256': '5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae'},
                  'auto-registration': {'image': 'sha256:e900edbf53bef6bac5249ef44aafe3fbe34bcde65c182fff3a005c84c61ac37a',
                                        'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:fd3a6da610c505c2b7a51601cf854182991ffd12-37448091340-2-auto-recharge',
                                        'status': 'running',
                                        'health': 'healthy',
                                        'containerId': '3c1c251b0a87167ae116fff3867cd2906347eff30ee248ac39684a865852399b',
                                        'startedAtSha256': 'd193fb43bcafb622e827544286a6bc8510baf44e492078ddc80e07967f0f71a5',
                                        'environmentSha256': 'de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17'},
                  'api': {'image': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                          'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                          'status': 'running',
                          'health': 'healthy',
                          'containerId': '8e9f22d9ec615945844d846abca8c34f827d156b13154cf0382c55148407d5ff',
                          'startedAtSha256': '2df79a73b30f3b54252ba0f8d8276815c704037cd19454a56c12074a0d57aa12',
                          'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c'},
                  'admin': {'image': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                            'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '8c34a75da43b9877b1ebf8110c41c726f3f7756473ab91c86fdc4f767dd2f075',
                            'startedAtSha256': '499f832cd2baf51fa672a43d21922953ae003854a1678facee86a6c5f68423b8',
                            'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4'},
                  'mysql': {'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                            'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                            'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                            'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'},
                  'caddy': {'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                            'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                            'status': 'running',
                            'health': None,
                            'containerId': '60d68c4e7c96e46c905d77bc059b3e5e93535d86710dfe19f791587790056cab',
                            'startedAtSha256': '7c0ca0361f561b614aea52e22030becb250582f6b3e87e496c59ccc4d7f081cc',
                            'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181'}},
 'readback': {'version': 1,
              'id': 'registration-worker-85-20261006',
              'status': 'VERIFIED',
              'currentCommit': 'fd3a6da610c505c2b7a51601cf854182991ffd12',
              'sourceTree': 'bd82ae5a41fba40e9e914b5c91f6b341952b2884',
              'profileSha256': '02fc3375314ee75b6e5b8ec47ce715f1e02f9b744ce77c5a4804d9110ba4daec',
              'previousCommit': '85e94572cd965dd993743d12d55a3e91d60b6444',
              'registrationSourceCommit': 'd9a494cc949b6b9dab0bd4d6fddf70b358b45cec',
              'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
              'workerProjectionSha256': '8a73f7de0c14ef4412f17aafecb85894fd59e7b435714156d3c8f7ec630bd211',
              'servicesUpdated': ['auto-registration'],
              'preservedServiceCount': 6,
              'checkCount': 49,
              'executedCheckCount': 49,
              'unavailableCheckCount': 0,
              'violationCount': 0,
              'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
              'runningSourceMatched': True,
              'unchangedServiceContainersPreserved': True,
              'environmentUnchanged': True,
              'migrationStatus': 'SKIPPED',
              'databaseGrantSyncStatus': 'SKIPPED',
              'cacheStatus': 'SKIPPED',
              'liveServicesHealthy': True}}


# Fixed callback-contract Worker source; all four predecessors and original finance seals remain separate.
REGISTRATION_CALLBACK_ID = 'registration-worker-87-20261006'
REGISTRATION_CALLBACK_FILE = 'deploy/aws/' + REGISTRATION_CALLBACK_ID + '.json'
REGISTRATION_CALLBACK_CURRENT = '651f62902fba74ddd189b34932084573b39d245c'
REGISTRATION_CALLBACK_SOURCE = '8dd12f19b1dc5187facdb070c7b644ca1221ee59'
REGISTRATION_CALLBACK_SOURCE_SHA256 = {'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': '7b3e374c94ab704d3837d92028f857744b7f4188cd597a4a8b3443af58f7dbe9', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': '5f4a5c5e71a65ebf61e3afa2e081a91d0667987f58f601f3ca0875a302513073', 'docs/AUTO_REGISTRATION.md': '3cb74e1f7269a5fa8dec5e6ca530147a310b261d43f44a62fbb979ad2aa6b11c', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py': 'c409f1d4a36fc759aa3bf649d08e93938ff5497b9261b635f28cc02e324bcec0', 'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py': 'f1878abdf27e6760bd63c602136ae14ff06902d136bbd47cf2d036fd1fb393ae', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py': '680699426cbbf517c4792b5ff6fcf83d692d7a9e084cbbd2b8d8a9eb20ffdf17', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_builtin.py': '1d542dbd37870978a2c4b1bc0cd2878df8438d46d3b507684777204418f41bbe'}
REGISTRATION_CALLBACK_PROJECTION_SHA256 = '94be2e8e7094628c69657954f974f1f67eabb00c4a10b0e553684d8177d9b39c'
REGISTRATION_CALLBACK_BASELINE = {'current': '/opt/id-business-v2/releases/20261006T120146Z-651f62902fba',
 'manifest': {'commit': '651f62902fba74ddd189b34932084573b39d245c',
              'sourceTree': 'b8e28b33bc6cc9be899de88fd05aa12a04b4a46e',
              'previousCommit': 'fd3a6da610c505c2b7a51601cf854182991ffd12',
              'previousRelease': '/opt/id-business-v2/releases/20261006T103328Z-fd3a6da610c5',
              'deploymentRun': 'github-actions-37459942600-1',
              'imageBuildRun': 'github-actions-37459942600-1',
              'sourceArchiveSha256': '06c58e2a336054e59e86572b24cc44b92b9c7833635eecb7d15b6ded19fcf38e',
              'servicesUpdated': ['auto-registration'],
              'migrationApplied': False,
              'newMigrations': [],
              'images': {'admin': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                                   'digest': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                                   'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'caddy': {'digest': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510'},
                         'api': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                                 'digest': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                                 'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'migrate': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-migrate',
                                     'digest': 'sha256:6f2c0d6f71c23ee2ec0565c1dae9a0a79f42dcf5ccb589bf0583c2b9e78414f9',
                                     'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'auto-recharge': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                           'digest': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                           'sourceCommit': '3ca300486d0edfadda83c094a48474a63959fce7'},
                         'media-resolver': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                            'digest': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                            'sourceCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'},
                         'auto-registration': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:651f62902fba74ddd189b34932084573b39d245c-37459942600-1-auto-recharge',
                                               'digest': 'sha256:3407c38cb84226022496ce55068180d33f325ad833d180a67cecbefdd3ad447b',
                                               'sourceCommit': '651f62902fba74ddd189b34932084573b39d245c'}},
              'fixedRegistrationRelease': {'id': 'registration-worker-86-20261006',
                                           'profileRawSha256': '81946a081a13d6787a5a1e16782ef780065c6e81440b8500e55dbca155fef7f2',
                                           'registrationSourceCommit': '932a03d3c9231c3c28ff295060f9c267e5597831',
                                           'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
                                           'workerProjectionSha256': '2b746ef23153633d2b4032f61cfc210979b72cc19fc8f6f43b66619b6c992d3f',
                                           'financeSourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
                                           'financePolicyId': 'historical-finance-20261005-order-archive',
                                           'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
                                           'clearanceSealSha256': '46f1b091459ba540af2c26a2fad3136d1ca4b7f269d2a77bd6c97c48976ee520',
                                           'environmentUnchanged': True,
                                           'migrationStatus': 'SKIPPED',
                                           'databaseGrantSyncStatus': 'SKIPPED',
                                           'cacheStatus': 'SKIPPED'}},
 'fileSha256': {'release-manifest.json': '2e9eea6b0954ccf1f33e7918b6d889f9b0aa722c36e961350467cec58169a58a',
                'before-audit.json': '9acb3730c88c91474a983b431780c0828ec6b15f96ed661c1a2dbe592f0b2d50',
                'after-audit.json': '6a62c84c05d04c0fc63ab31900dbe46564880df2a491ec91ba38d554d2495661',
                'docker-compose.aws-mysql.yml': '05cd335251b31010af76b6c727927c2ae04158c481cb64186156229a3f6801b8',
                'compose.release.json': '2483b1eb0da21cf00e4643959748619fb0334b6176b5b4968ec8abc16a04935f',
                '.env.aws.production': 'a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af',
                'deploy/aws/registration-worker-b8-80-20261006.json': 'd5c023887b22f6a555abe0f8e4627113d5a45dec0668ae2abc1bb8fbf8cbdb28',
                'deploy/aws/registration-worker-956-20261006.json': '60226df9c51cb222bf8c0cc09a7783b52a8f0082f728189ec3ada9554b6dbfc1',
                'deploy/aws/registration-worker-85-20261006.json': '02fc3375314ee75b6e5b8ec47ce715f1e02f9b744ce77c5a4804d9110ba4daec',
                'deploy/aws/registration-worker-86-20261006.json': '81946a081a13d6787a5a1e16782ef780065c6e81440b8500e55dbca155fef7f2'},
 'overrideCanonicalSha256': 'a2480420f4005768a8d352170ebee8a0477841b04442a8d53cd107c03bc2c46a',
 'audits': {'before': {'checkCount': 49,
                       'violationCount': 0,
                       'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                       'gateSha256': 'ec68038c2606fabc6f5408a0e79784a6dc1b142acfc9cc6b78035581f907041f',
                       'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'},
            'after': {'checkCount': 49,
                      'violationCount': 0,
                      'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                      'gateSha256': '80be54958db3f671aca657fe52949f42b36fda1679d88e1fdb0c1655f54c79fb',
                      'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'}},
 'liveServices': {'admin': {'image': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                            'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '8c34a75da43b9877b1ebf8110c41c726f3f7756473ab91c86fdc4f767dd2f075',
                            'startedAtSha256': '499f832cd2baf51fa672a43d21922953ae003854a1678facee86a6c5f68423b8',
                            'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4'},
                  'api': {'image': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                          'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                          'status': 'running',
                          'health': 'healthy',
                          'containerId': '8e9f22d9ec615945844d846abca8c34f827d156b13154cf0382c55148407d5ff',
                          'startedAtSha256': '2df79a73b30f3b54252ba0f8d8276815c704037cd19454a56c12074a0d57aa12',
                          'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c'},
                  'auto-recharge': {'image': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                    'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                    'status': 'running',
                                    'health': 'healthy',
                                    'containerId': '2c7dafce90530efa1f1afbdf031f07ed07e9a6ad3b23a92d418c3cb700deed35',
                                    'startedAtSha256': '6e263adbdd786eb3c27b34deefab967124700b7a6d14d497f65e0e5975b5a45e',
                                    'environmentSha256': '5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae'},
                  'auto-registration': {'image': 'sha256:3407c38cb84226022496ce55068180d33f325ad833d180a67cecbefdd3ad447b',
                                        'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:651f62902fba74ddd189b34932084573b39d245c-37459942600-1-auto-recharge',
                                        'status': 'running',
                                        'health': 'healthy',
                                        'containerId': 'b61fdd50596ea906c52c7f10403f6f480109ac8d6b7730675251f3eaf7caa4da',
                                        'startedAtSha256': '0a7132e11752cf3824321c44116badc30d3db00d4a97d4c25558b34ddce148c1',
                                        'environmentSha256': 'de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17'},
                  'caddy': {'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                            'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                            'status': 'running',
                            'health': None,
                            'containerId': '60d68c4e7c96e46c905d77bc059b3e5e93535d86710dfe19f791587790056cab',
                            'startedAtSha256': '7c0ca0361f561b614aea52e22030becb250582f6b3e87e496c59ccc4d7f081cc',
                            'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181'},
                  'media-resolver': {'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                     'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                     'status': 'running',
                                     'health': 'healthy',
                                     'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                     'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                     'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163'},
                  'mysql': {'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                            'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                            'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                            'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'}},
 'readback': {'version': 1,
              'id': 'registration-worker-86-20261006',
              'status': 'VERIFIED',
              'currentCommit': '651f62902fba74ddd189b34932084573b39d245c',
              'sourceTree': 'b8e28b33bc6cc9be899de88fd05aa12a04b4a46e',
              'profileSha256': '81946a081a13d6787a5a1e16782ef780065c6e81440b8500e55dbca155fef7f2',
              'previousCommit': 'fd3a6da610c505c2b7a51601cf854182991ffd12',
              'registrationSourceCommit': '932a03d3c9231c3c28ff295060f9c267e5597831',
              'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
              'workerProjectionSha256': '2b746ef23153633d2b4032f61cfc210979b72cc19fc8f6f43b66619b6c992d3f',
              'servicesUpdated': ['auto-registration'],
              'preservedServiceCount': 6,
              'checkCount': 49,
              'executedCheckCount': 49,
              'unavailableCheckCount': 0,
              'violationCount': 0,
              'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
              'runningSourceMatched': True,
              'unchangedServiceContainersPreserved': True,
              'environmentUnchanged': True,
              'migrationStatus': 'SKIPPED',
              'databaseGrantSyncStatus': 'SKIPPED',
              'cacheStatus': 'SKIPPED',
              'liveServicesHealthy': True}}


# Fixed email-request diagnostic Worker source; all five predecessors and original finance seals remain separate.
REGISTRATION_EMAIL_REQUEST_ID = 'registration-worker-88-20261006'
REGISTRATION_EMAIL_REQUEST_FILE = 'deploy/aws/' + REGISTRATION_EMAIL_REQUEST_ID + '.json'
REGISTRATION_EMAIL_REQUEST_CURRENT = '4c200c4ae08bb8214ff8e0955f8237ce85069cc6'
REGISTRATION_EMAIL_REQUEST_SOURCE = '613419cfd245d3884b856856ed23737f2bbddff1'
REGISTRATION_EMAIL_REQUEST_SOURCE_SHA256 = {'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': '704d5c1fb4de91c727453208907ca1c4f98cf10c00235facb2ff73aec68192d4', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': 'fa57abf5ad8d18b3ea0152dfc544c5a3a38d063ae19208c82d185d7fed7bb3ef', 'docs/AUTO_REGISTRATION.md': '3cb74e1f7269a5fa8dec5e6ca530147a310b261d43f44a62fbb979ad2aa6b11c', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py': 'c409f1d4a36fc759aa3bf649d08e93938ff5497b9261b635f28cc02e324bcec0', 'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py': 'f1878abdf27e6760bd63c602136ae14ff06902d136bbd47cf2d036fd1fb393ae', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py': '680699426cbbf517c4792b5ff6fcf83d692d7a9e084cbbd2b8d8a9eb20ffdf17', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_builtin.py': '1d542dbd37870978a2c4b1bc0cd2878df8438d46d3b507684777204418f41bbe'}
REGISTRATION_EMAIL_REQUEST_PROJECTION_SHA256 = '54a5de8c2a847aee3ba21dc7fa48a46fcb26d67ae8f767bd3478fab430e59a01'
REGISTRATION_EMAIL_REQUEST_BASELINE = {'current': '/opt/id-business-v2/releases/20261006T131747Z-4c200c4ae08b',
 'manifest': {'commit': '4c200c4ae08bb8214ff8e0955f8237ce85069cc6',
              'sourceTree': 'd55e9338f6afa6c2781a9177c40c3e2c7dd7ba05',
              'previousCommit': '651f62902fba74ddd189b34932084573b39d245c',
              'previousRelease': '/opt/id-business-v2/releases/20261006T120146Z-651f62902fba',
              'deploymentRun': 'github-actions-37469256127-1',
              'imageBuildRun': 'github-actions-37469256127-1',
              'sourceArchiveSha256': 'ab8317313c9d1d036b46a2a52bf482a798fc491df041114b5eaa892ee316db98',
              'servicesUpdated': ['auto-registration'],
              'migrationApplied': False,
              'newMigrations': [],
              'images': {'admin': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                                   'digest': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                                   'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'caddy': {'digest': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510'},
                         'api': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                                 'digest': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                                 'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'migrate': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-migrate',
                                     'digest': 'sha256:6f2c0d6f71c23ee2ec0565c1dae9a0a79f42dcf5ccb589bf0583c2b9e78414f9',
                                     'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'auto-recharge': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                           'digest': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                           'sourceCommit': '3ca300486d0edfadda83c094a48474a63959fce7'},
                         'media-resolver': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                            'digest': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                            'sourceCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'},
                         'auto-registration': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:4c200c4ae08bb8214ff8e0955f8237ce85069cc6-37469256127-1-auto-recharge',
                                               'digest': 'sha256:65e9598d1c50336db7b32054d1b2ba41c7123d718176534a30934098c7c3262a',
                                               'sourceCommit': '4c200c4ae08bb8214ff8e0955f8237ce85069cc6'}},
              'fixedRegistrationRelease': {'id': 'registration-worker-87-20261006',
                                           'profileRawSha256': '3742920452e28992595c7d31d8ea5c03915f3a3218435a7714cf6e2fe1c2aea7',
                                           'registrationSourceCommit': '8dd12f19b1dc5187facdb070c7b644ca1221ee59',
                                           'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
                                           'workerProjectionSha256': '94be2e8e7094628c69657954f974f1f67eabb00c4a10b0e553684d8177d9b39c',
                                           'financeSourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
                                           'financePolicyId': 'historical-finance-20261005-order-archive',
                                           'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
                                           'clearanceSealSha256': '46f1b091459ba540af2c26a2fad3136d1ca4b7f269d2a77bd6c97c48976ee520',
                                           'environmentUnchanged': True,
                                           'migrationStatus': 'SKIPPED',
                                           'databaseGrantSyncStatus': 'SKIPPED',
                                           'cacheStatus': 'SKIPPED'}},
 'fileSha256': {'release-manifest.json': '7b67c236cf3d6f93d2b458f9a21309834cc7c8207f59ef924656c0e73fb6b870',
                'before-audit.json': 'c7aa1b99de9764ece88b2236d679c3d2597d3911fb43d93cfc43b2f7ebdeb09e',
                'after-audit.json': '0632cf960428991f44b5acd7c3468f4858496fcc83bd1ae23630fe194c75da80',
                'docker-compose.aws-mysql.yml': '05cd335251b31010af76b6c727927c2ae04158c481cb64186156229a3f6801b8',
                'compose.release.json': '024c17592870740d97d3feb5c695381fc8c51efd40c0fcd2b1e1b89c20089b0d',
                '.env.aws.production': 'a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af',
                'deploy/aws/registration-worker-b8-80-20261006.json': 'd5c023887b22f6a555abe0f8e4627113d5a45dec0668ae2abc1bb8fbf8cbdb28',
                'deploy/aws/registration-worker-956-20261006.json': '60226df9c51cb222bf8c0cc09a7783b52a8f0082f728189ec3ada9554b6dbfc1',
                'deploy/aws/registration-worker-85-20261006.json': '02fc3375314ee75b6e5b8ec47ce715f1e02f9b744ce77c5a4804d9110ba4daec',
                'deploy/aws/registration-worker-86-20261006.json': '81946a081a13d6787a5a1e16782ef780065c6e81440b8500e55dbca155fef7f2',
                'deploy/aws/registration-worker-87-20261006.json': '3742920452e28992595c7d31d8ea5c03915f3a3218435a7714cf6e2fe1c2aea7'},
 'overrideCanonicalSha256': '51840cf205f8276a6f1023dac74d7433259f54aca413e564640de48e43a4548b',
 'audits': {'before': {'checkCount': 49,
                       'violationCount': 0,
                       'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                       'gateSha256': 'ec68038c2606fabc6f5408a0e79784a6dc1b142acfc9cc6b78035581f907041f',
                       'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'},
            'after': {'checkCount': 49,
                      'violationCount': 0,
                      'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                      'gateSha256': '80be54958db3f671aca657fe52949f42b36fda1679d88e1fdb0c1655f54c79fb',
                      'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'}},
 'liveServices': {'admin': {'image': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                            'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '8c34a75da43b9877b1ebf8110c41c726f3f7756473ab91c86fdc4f767dd2f075',
                            'startedAtSha256': '499f832cd2baf51fa672a43d21922953ae003854a1678facee86a6c5f68423b8',
                            'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4'},
                  'api': {'image': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                          'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                          'status': 'running',
                          'health': 'healthy',
                          'containerId': '8e9f22d9ec615945844d846abca8c34f827d156b13154cf0382c55148407d5ff',
                          'startedAtSha256': '2df79a73b30f3b54252ba0f8d8276815c704037cd19454a56c12074a0d57aa12',
                          'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c'},
                  'auto-recharge': {'image': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                    'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                    'status': 'running',
                                    'health': 'healthy',
                                    'containerId': '2c7dafce90530efa1f1afbdf031f07ed07e9a6ad3b23a92d418c3cb700deed35',
                                    'startedAtSha256': '6e263adbdd786eb3c27b34deefab967124700b7a6d14d497f65e0e5975b5a45e',
                                    'environmentSha256': '5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae'},
                  'auto-registration': {'image': 'sha256:65e9598d1c50336db7b32054d1b2ba41c7123d718176534a30934098c7c3262a',
                                        'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:4c200c4ae08bb8214ff8e0955f8237ce85069cc6-37469256127-1-auto-recharge',
                                        'status': 'running',
                                        'health': 'healthy',
                                        'containerId': '1a5b75cf1714a546e512fc80c7f681ac20d23a906d62faffadedeb70871133ac',
                                        'startedAtSha256': 'a06b01a99158a663e0621153c14048dade5c9552407eb256d00266baf011d7ae',
                                        'environmentSha256': 'de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17'},
                  'caddy': {'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                            'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                            'status': 'running',
                            'health': None,
                            'containerId': '60d68c4e7c96e46c905d77bc059b3e5e93535d86710dfe19f791587790056cab',
                            'startedAtSha256': '7c0ca0361f561b614aea52e22030becb250582f6b3e87e496c59ccc4d7f081cc',
                            'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181'},
                  'media-resolver': {'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                     'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                     'status': 'running',
                                     'health': 'healthy',
                                     'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                     'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                     'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163'},
                  'mysql': {'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                            'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                            'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                            'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'}},
 'readback': {'version': 1,
              'id': 'registration-worker-87-20261006',
              'status': 'VERIFIED',
              'currentCommit': '4c200c4ae08bb8214ff8e0955f8237ce85069cc6',
              'sourceTree': 'd55e9338f6afa6c2781a9177c40c3e2c7dd7ba05',
              'profileSha256': '3742920452e28992595c7d31d8ea5c03915f3a3218435a7714cf6e2fe1c2aea7',
              'previousCommit': '651f62902fba74ddd189b34932084573b39d245c',
              'registrationSourceCommit': '8dd12f19b1dc5187facdb070c7b644ca1221ee59',
              'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
              'workerProjectionSha256': '94be2e8e7094628c69657954f974f1f67eabb00c4a10b0e553684d8177d9b39c',
              'servicesUpdated': ['auto-registration'],
              'preservedServiceCount': 6,
              'checkCount': 49,
              'executedCheckCount': 49,
              'unavailableCheckCount': 0,
              'violationCount': 0,
              'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
              'runningSourceMatched': True,
              'unchangedServiceContainersPreserved': True,
              'environmentUnchanged': True,
              'migrationStatus': 'SKIPPED',
              'databaseGrantSyncStatus': 'SKIPPED',
              'cacheStatus': 'SKIPPED',
              'liveServicesHealthy': True}}


# Fixed email-submit observation Worker source; all six predecessors and original finance seals remain separate.
REGISTRATION_EMAIL_OBSERVATION_ID = 'registration-worker-89-20261006'
REGISTRATION_EMAIL_OBSERVATION_FILE = 'deploy/aws/registration-worker-89-20261006.json'
REGISTRATION_EMAIL_OBSERVATION_CURRENT = 'd2e22e623d0e19851c79ffe43396f5f97a99b8d3'
REGISTRATION_EMAIL_OBSERVATION_SOURCE = '83909af3df8655295984c427565731fc8bde0293'
REGISTRATION_EMAIL_OBSERVATION_SOURCE_SHA256 = {'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': '2299a372aada6f356fa45f67e3c55028a476080f4c3bc8015b274df1ec855348', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': '6414b113b27b062598bfabad03ae3bda49640bca1573c0e1e61bebe497d6aa42', 'docs/AUTO_REGISTRATION.md': '3cb74e1f7269a5fa8dec5e6ca530147a310b261d43f44a62fbb979ad2aa6b11c', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py': 'c409f1d4a36fc759aa3bf649d08e93938ff5497b9261b635f28cc02e324bcec0', 'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py': 'f1878abdf27e6760bd63c602136ae14ff06902d136bbd47cf2d036fd1fb393ae', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py': '680699426cbbf517c4792b5ff6fcf83d692d7a9e084cbbd2b8d8a9eb20ffdf17', 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_builtin.py': '1d542dbd37870978a2c4b1bc0cd2878df8438d46d3b507684777204418f41bbe'}
REGISTRATION_EMAIL_OBSERVATION_PROJECTION_SHA256 = 'd40c58deefb8cc5fe39fa2f711f9ca6416adab31ba68602d6910e8d090edde68'
REGISTRATION_EMAIL_OBSERVATION_B91_BASELINE = {'current': '/opt/id-business-v2/releases/20261006T152201Z-b91b626a71ed',
 'manifest': {'commit': 'b91b626a71ed2c7c2473d080551b3b10b693b0cb',
              'sourceTree': '0108ff3dda67337102d96bef08280ee93d8bcb36',
              'previousCommit': '4c200c4ae08bb8214ff8e0955f8237ce85069cc6',
              'previousRelease': '/opt/id-business-v2/releases/20261006T131747Z-4c200c4ae08b',
              'deploymentRun': 'github-actions-37481121792-2',
              'imageBuildRun': 'github-actions-37481121792-2',
              'sourceArchiveSha256': '1fe8ef41e18a520466eae8f3a15314be66bde3a36f33f954a9dbf3aabb15111c',
              'servicesUpdated': ['auto-registration'],
              'migrationApplied': False,
              'newMigrations': [],
              'images': {'admin': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                                   'digest': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                                   'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'caddy': {'digest': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510'},
                         'api': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                                 'digest': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                                 'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'migrate': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-migrate',
                                     'digest': 'sha256:6f2c0d6f71c23ee2ec0565c1dae9a0a79f42dcf5ccb589bf0583c2b9e78414f9',
                                     'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'auto-recharge': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                           'digest': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                           'sourceCommit': '3ca300486d0edfadda83c094a48474a63959fce7'},
                         'media-resolver': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                            'digest': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                            'sourceCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'},
                         'auto-registration': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b91b626a71ed2c7c2473d080551b3b10b693b0cb-37481121792-2-auto-recharge',
                                               'digest': 'sha256:f369dcfc8a59dd5598eb00c857c9ddeba01520d24e3e78585bcd5ce11371491e',
                                               'sourceCommit': 'b91b626a71ed2c7c2473d080551b3b10b693b0cb'}},
              'fixedRegistrationRelease': {'id': 'registration-worker-88-20261006',
                                           'profileRawSha256': 'cce9a098659ba3bc5bec6e7fd8eb294d3ef075dc4676c86f5b4c38de1ff67d67',
                                           'registrationSourceCommit': '613419cfd245d3884b856856ed23737f2bbddff1',
                                           'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
                                           'workerProjectionSha256': '54a5de8c2a847aee3ba21dc7fa48a46fcb26d67ae8f767bd3478fab430e59a01',
                                           'financeSourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
                                           'financePolicyId': 'historical-finance-20261005-order-archive',
                                           'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
                                           'clearanceSealSha256': '46f1b091459ba540af2c26a2fad3136d1ca4b7f269d2a77bd6c97c48976ee520',
                                           'environmentUnchanged': True,
                                           'migrationStatus': 'SKIPPED',
                                           'databaseGrantSyncStatus': 'SKIPPED',
                                           'cacheStatus': 'SKIPPED'}},
 'fileSha256': {'release-manifest.json': '26027a68e3f1ddc6ce71829f8e37c36df8de20f1d2314553513f16969c444682',
                'before-audit.json': 'c32fa0be474b758650676a85c053458e35239ea7d5cea74583f4be0b1a96775d',
                'after-audit.json': 'ac2cdf6150ce3cdec5e0adacada11431626c9f8ab887118dd7d396ff99636513',
                'docker-compose.aws-mysql.yml': '05cd335251b31010af76b6c727927c2ae04158c481cb64186156229a3f6801b8',
                'compose.release.json': '44d98c442473fd54493fe6e3bee4713ef4bef33c935895dcf25ce76842a28386',
                '.env.aws.production': 'a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af',
                'deploy/aws/registration-worker-b8-80-20261006.json': 'd5c023887b22f6a555abe0f8e4627113d5a45dec0668ae2abc1bb8fbf8cbdb28',
                'deploy/aws/registration-worker-956-20261006.json': '60226df9c51cb222bf8c0cc09a7783b52a8f0082f728189ec3ada9554b6dbfc1',
                'deploy/aws/registration-worker-85-20261006.json': '02fc3375314ee75b6e5b8ec47ce715f1e02f9b744ce77c5a4804d9110ba4daec',
                'deploy/aws/registration-worker-86-20261006.json': '81946a081a13d6787a5a1e16782ef780065c6e81440b8500e55dbca155fef7f2',
                'deploy/aws/registration-worker-87-20261006.json': '3742920452e28992595c7d31d8ea5c03915f3a3218435a7714cf6e2fe1c2aea7',
                'deploy/aws/registration-worker-88-20261006.json': 'cce9a098659ba3bc5bec6e7fd8eb294d3ef075dc4676c86f5b4c38de1ff67d67'},
 'overrideCanonicalSha256': '9a40ab66e7433448a0855f62094379b1a5e61da868095ed3a6d128b14879b11c',
 'audits': {'before': {'checkCount': 49,
                       'violationCount': 0,
                       'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                       'gateSha256': 'ec68038c2606fabc6f5408a0e79784a6dc1b142acfc9cc6b78035581f907041f',
                       'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'},
            'after': {'checkCount': 49,
                      'violationCount': 0,
                      'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                      'gateSha256': '80be54958db3f671aca657fe52949f42b36fda1679d88e1fdb0c1655f54c79fb',
                      'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'}},
 'liveServices': {'admin': {'image': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                            'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '8c34a75da43b9877b1ebf8110c41c726f3f7756473ab91c86fdc4f767dd2f075',
                            'startedAtSha256': '499f832cd2baf51fa672a43d21922953ae003854a1678facee86a6c5f68423b8',
                            'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4'},
                  'api': {'image': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                          'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                          'status': 'running',
                          'health': 'healthy',
                          'containerId': '8e9f22d9ec615945844d846abca8c34f827d156b13154cf0382c55148407d5ff',
                          'startedAtSha256': '2df79a73b30f3b54252ba0f8d8276815c704037cd19454a56c12074a0d57aa12',
                          'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c'},
                  'auto-recharge': {'image': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                    'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                    'status': 'running',
                                    'health': 'healthy',
                                    'containerId': '2c7dafce90530efa1f1afbdf031f07ed07e9a6ad3b23a92d418c3cb700deed35',
                                    'startedAtSha256': '6e263adbdd786eb3c27b34deefab967124700b7a6d14d497f65e0e5975b5a45e',
                                    'environmentSha256': '5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae'},
                  'auto-registration': {'image': 'sha256:f369dcfc8a59dd5598eb00c857c9ddeba01520d24e3e78585bcd5ce11371491e',
                                        'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b91b626a71ed2c7c2473d080551b3b10b693b0cb-37481121792-2-auto-recharge',
                                        'status': 'running',
                                        'health': 'healthy',
                                        'containerId': 'a5036814eaa7207ed41ccb0cda8dcaf34a433bba5d7d854d1463bcabda3fc590',
                                        'startedAtSha256': 'ac39959777db37812c6a969a3faf58a91ee0563467eef71e9ace1f698544f3ab',
                                        'environmentSha256': 'de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17'},
                  'caddy': {'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                            'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                            'status': 'running',
                            'health': None,
                            'containerId': '60d68c4e7c96e46c905d77bc059b3e5e93535d86710dfe19f791587790056cab',
                            'startedAtSha256': '7c0ca0361f561b614aea52e22030becb250582f6b3e87e496c59ccc4d7f081cc',
                            'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181'},
                  'media-resolver': {'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                     'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                     'status': 'running',
                                     'health': 'healthy',
                                     'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                     'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                     'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163'},
                  'mysql': {'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                            'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                            'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                            'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'}},
 'readback': {'version': 1,
              'id': 'registration-worker-88-20261006',
              'status': 'VERIFIED',
              'currentCommit': 'b91b626a71ed2c7c2473d080551b3b10b693b0cb',
              'sourceTree': '0108ff3dda67337102d96bef08280ee93d8bcb36',
              'profileSha256': 'cce9a098659ba3bc5bec6e7fd8eb294d3ef075dc4676c86f5b4c38de1ff67d67',
              'previousCommit': '4c200c4ae08bb8214ff8e0955f8237ce85069cc6',
              'registrationSourceCommit': '613419cfd245d3884b856856ed23737f2bbddff1',
              'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
              'workerProjectionSha256': '54a5de8c2a847aee3ba21dc7fa48a46fcb26d67ae8f767bd3478fab430e59a01',
              'servicesUpdated': ['auto-registration'],
              'preservedServiceCount': 6,
              'checkCount': 49,
              'executedCheckCount': 49,
              'unavailableCheckCount': 0,
              'violationCount': 0,
              'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
              'runningSourceMatched': True,
              'unchangedServiceContainersPreserved': True,
              'environmentUnchanged': True,
              'migrationStatus': 'SKIPPED',
              'databaseGrantSyncStatus': 'SKIPPED',
              'cacheStatus': 'SKIPPED',
              'liveServicesHealthy': True}}

REGISTRATION_EMAIL_OBSERVATION_PRO_BASELINE = {'status': 'VERIFIED_PRO_AFTER_88_RUNTIME_BASELINE',
 'current': '/opt/id-business-v2/releases/20261006T163935Z-d2e22e623d0e',
 'controllerSha256': 'f421e37c9c4b9562c8fe6b5fe5ee74643aa612e4a05ed99153a2b2c7643d7d67',
 'profileSha256': '6d10faabd632157233099dfce5d558d89f3a841a0556fc42f91b384f049cbdc0',
 'manifest': {'commit': 'd2e22e623d0e19851c79ffe43396f5f97a99b8d3',
              'sourceTree': 'd2d938a176fab2a99cc1edd1b25c1cd1ffb59357',
              'previousCommit': 'b91b626a71ed2c7c2473d080551b3b10b693b0cb',
              'previousRelease': '/opt/id-business-v2/releases/20261006T152201Z-b91b626a71ed',
              'deploymentRun': 'github-actions-37496968953-1',
              'imageBuildRun': 'github-actions-37496968953-1',
              'sourceArchiveSha256': 'c1fd43663c32c89dd925355b5da1f3b665227e38a967d763a0efcf0cb212582a',
              'servicesUpdated': ['auto-recharge'],
              'migrationApplied': False,
              'newMigrations': [],
              'images': {'admin': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                                   'digest': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                                   'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'caddy': {'digest': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510'},
                         'api': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                                 'digest': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                                 'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'migrate': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-migrate',
                                     'digest': 'sha256:6f2c0d6f71c23ee2ec0565c1dae9a0a79f42dcf5ccb589bf0583c2b9e78414f9',
                                     'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'auto-recharge': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:d2e22e623d0e19851c79ffe43396f5f97a99b8d3-37496968953-1-auto-recharge',
                                           'digest': 'sha256:bd7f4b9b5012cc06f265b2ebf9a1c49c646dfd141695bc51cc1f24a197a3de51',
                                           'sourceCommit': 'd2e22e623d0e19851c79ffe43396f5f97a99b8d3'},
                         'media-resolver': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                            'digest': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                            'sourceCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'},
                         'auto-registration': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b91b626a71ed2c7c2473d080551b3b10b693b0cb-37481121792-2-auto-recharge',
                                               'digest': 'sha256:f369dcfc8a59dd5598eb00c857c9ddeba01520d24e3e78585bcd5ce11371491e',
                                               'sourceCommit': 'b91b626a71ed2c7c2473d080551b3b10b693b0cb'}},
              'fixedRegistrationRelease': {'id': 'registration-worker-88-20261006',
                                           'profileRawSha256': 'cce9a098659ba3bc5bec6e7fd8eb294d3ef075dc4676c86f5b4c38de1ff67d67',
                                           'registrationSourceCommit': '613419cfd245d3884b856856ed23737f2bbddff1',
                                           'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
                                           'workerProjectionSha256': '54a5de8c2a847aee3ba21dc7fa48a46fcb26d67ae8f767bd3478fab430e59a01',
                                           'financeSourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
                                           'financePolicyId': 'historical-finance-20261005-order-archive',
                                           'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
                                           'clearanceSealSha256': '46f1b091459ba540af2c26a2fad3136d1ca4b7f269d2a77bd6c97c48976ee520',
                                           'environmentUnchanged': True,
                                           'migrationStatus': 'SKIPPED',
                                           'databaseGrantSyncStatus': 'SKIPPED',
                                           'cacheStatus': 'SKIPPED'},
              'fixedRechargeRelease': {'version': 1,
                                       'id': 'recharge-pro-main80-20261006',
                                       'profileSha256': '889afca1d21c9af22d95d7ac45f3323e18e793204f7098490c29e70cb627d2f0',
                                       'expectedCurrent': 'b91b626a71ed2c7c2473d080551b3b10b693b0cb',
                                       'sourceCommit': 'd2e22e623d0e19851c79ffe43396f5f97a99b8d3',
                                       'sourceTree': 'd2d938a176fab2a99cc1edd1b25c1cd1ffb59357',
                                       'servicesUpdated': ['auto-recharge'],
                                       'financeValidator': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
                                       'sourceCommitForFinance': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
                                       'originCommitForFinance': '3ca300486d0edfadda83c094a48474a63959fce7',
                                       'beforeGateSha256': 'ec68038c2606fabc6f5408a0e79784a6dc1b142acfc9cc6b78035581f907041f',
                                       'afterGateSha256': '80be54958db3f671aca657fe52949f42b36fda1679d88e1fdb0c1655f54c79fb',
                                       'unchangedServiceContainersPreserved': True,
                                       'environmentUnchanged': True,
                                       'migrationStatus': 'SKIPPED',
                                       'databaseGrantSyncStatus': 'SKIPPED',
                                       'cacheStatus': 'SKIPPED'},
              'fixedRechargePreservedStates': {'before': {'media-resolver': {'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                                                             'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                                                             'status': 'running',
                                                                             'health': 'healthy',
                                                                             'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                                                             'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                                                             'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163'},
                                                          'auto-registration': {'image': 'sha256:f369dcfc8a59dd5598eb00c857c9ddeba01520d24e3e78585bcd5ce11371491e',
                                                                                'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b91b626a71ed2c7c2473d080551b3b10b693b0cb-37481121792-2-auto-recharge',
                                                                                'status': 'running',
                                                                                'health': 'healthy',
                                                                                'containerId': 'a5036814eaa7207ed41ccb0cda8dcaf34a433bba5d7d854d1463bcabda3fc590',
                                                                                'startedAtSha256': 'ac39959777db37812c6a969a3faf58a91ee0563467eef71e9ace1f698544f3ab',
                                                                                'environmentSha256': 'de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17'},
                                                          'api': {'image': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                                                                  'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                                                                  'status': 'running',
                                                                  'health': 'healthy',
                                                                  'containerId': '8e9f22d9ec615945844d846abca8c34f827d156b13154cf0382c55148407d5ff',
                                                                  'startedAtSha256': '2df79a73b30f3b54252ba0f8d8276815c704037cd19454a56c12074a0d57aa12',
                                                                  'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c'},
                                                          'admin': {'image': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                                                                    'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                                                                    'status': 'running',
                                                                    'health': 'healthy',
                                                                    'containerId': '8c34a75da43b9877b1ebf8110c41c726f3f7756473ab91c86fdc4f767dd2f075',
                                                                    'startedAtSha256': '499f832cd2baf51fa672a43d21922953ae003854a1678facee86a6c5f68423b8',
                                                                    'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4'},
                                                          'mysql': {'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                                                                    'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                                                                    'status': 'running',
                                                                    'health': 'healthy',
                                                                    'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                                                                    'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                                                                    'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'},
                                                          'caddy': {'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                                                                    'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                                                                    'status': 'running',
                                                                    'health': None,
                                                                    'containerId': '60d68c4e7c96e46c905d77bc059b3e5e93535d86710dfe19f791587790056cab',
                                                                    'startedAtSha256': '7c0ca0361f561b614aea52e22030becb250582f6b3e87e496c59ccc4d7f081cc',
                                                                    'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181'}},
                                               'after': {'media-resolver': {'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                                                            'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                                                            'status': 'running',
                                                                            'health': 'healthy',
                                                                            'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                                                            'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                                                            'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163'},
                                                         'auto-registration': {'image': 'sha256:f369dcfc8a59dd5598eb00c857c9ddeba01520d24e3e78585bcd5ce11371491e',
                                                                               'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b91b626a71ed2c7c2473d080551b3b10b693b0cb-37481121792-2-auto-recharge',
                                                                               'status': 'running',
                                                                               'health': 'healthy',
                                                                               'containerId': 'a5036814eaa7207ed41ccb0cda8dcaf34a433bba5d7d854d1463bcabda3fc590',
                                                                               'startedAtSha256': 'ac39959777db37812c6a969a3faf58a91ee0563467eef71e9ace1f698544f3ab',
                                                                               'environmentSha256': 'de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17'},
                                                         'api': {'image': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                                                                 'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                                                                 'status': 'running',
                                                                 'health': 'healthy',
                                                                 'containerId': '8e9f22d9ec615945844d846abca8c34f827d156b13154cf0382c55148407d5ff',
                                                                 'startedAtSha256': '2df79a73b30f3b54252ba0f8d8276815c704037cd19454a56c12074a0d57aa12',
                                                                 'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c'},
                                                         'admin': {'image': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                                                                   'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                                                                   'status': 'running',
                                                                   'health': 'healthy',
                                                                   'containerId': '8c34a75da43b9877b1ebf8110c41c726f3f7756473ab91c86fdc4f767dd2f075',
                                                                   'startedAtSha256': '499f832cd2baf51fa672a43d21922953ae003854a1678facee86a6c5f68423b8',
                                                                   'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4'},
                                                         'mysql': {'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                                                                   'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                                                                   'status': 'running',
                                                                   'health': 'healthy',
                                                                   'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                                                                   'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                                                                   'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'},
                                                         'caddy': {'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                                                                   'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                                                                   'status': 'running',
                                                                   'health': None,
                                                                   'containerId': '60d68c4e7c96e46c905d77bc059b3e5e93535d86710dfe19f791587790056cab',
                                                                   'startedAtSha256': '7c0ca0361f561b614aea52e22030becb250582f6b3e87e496c59ccc4d7f081cc',
                                                                   'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181'}}},
              'fixedRegistrationPreservedStates': {'before': {'media-resolver': {'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                                                                 'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                                                                 'status': 'running',
                                                                                 'health': 'healthy',
                                                                                 'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                                                                 'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                                                                 'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163'},
                                                              'auto-recharge': {'image': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                                                                'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                                                                'status': 'running',
                                                                                'health': 'healthy',
                                                                                'containerId': '2c7dafce90530efa1f1afbdf031f07ed07e9a6ad3b23a92d418c3cb700deed35',
                                                                                'startedAtSha256': '6e263adbdd786eb3c27b34deefab967124700b7a6d14d497f65e0e5975b5a45e',
                                                                                'environmentSha256': '5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae'},
                                                              'api': {'image': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                                                                      'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                                                                      'status': 'running',
                                                                      'health': 'healthy',
                                                                      'containerId': '8e9f22d9ec615945844d846abca8c34f827d156b13154cf0382c55148407d5ff',
                                                                      'startedAtSha256': '2df79a73b30f3b54252ba0f8d8276815c704037cd19454a56c12074a0d57aa12',
                                                                      'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c'},
                                                              'admin': {'image': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                                                                        'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                                                                        'status': 'running',
                                                                        'health': 'healthy',
                                                                        'containerId': '8c34a75da43b9877b1ebf8110c41c726f3f7756473ab91c86fdc4f767dd2f075',
                                                                        'startedAtSha256': '499f832cd2baf51fa672a43d21922953ae003854a1678facee86a6c5f68423b8',
                                                                        'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4'},
                                                              'mysql': {'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                                                                        'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                                                                        'status': 'running',
                                                                        'health': 'healthy',
                                                                        'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                                                                        'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                                                                        'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'},
                                                              'caddy': {'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                                                                        'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                                                                        'status': 'running',
                                                                        'health': None,
                                                                        'containerId': '60d68c4e7c96e46c905d77bc059b3e5e93535d86710dfe19f791587790056cab',
                                                                        'startedAtSha256': '7c0ca0361f561b614aea52e22030becb250582f6b3e87e496c59ccc4d7f081cc',
                                                                        'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181'}},
                                                   'after': {'media-resolver': {'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                                                                'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                                                                'status': 'running',
                                                                                'health': 'healthy',
                                                                                'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                                                                'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                                                                'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163'},
                                                             'auto-recharge': {'image': 'sha256:86b5d98fa6e0cb55b89862c4b952362428efc21dc6002ff48ca89c6d9f9f7cdc',
                                                                               'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:3ca300486d0edfadda83c094a48474a63959fce7-37346732072-1-auto-recharge',
                                                                               'status': 'running',
                                                                               'health': 'healthy',
                                                                               'containerId': '2c7dafce90530efa1f1afbdf031f07ed07e9a6ad3b23a92d418c3cb700deed35',
                                                                               'startedAtSha256': '6e263adbdd786eb3c27b34deefab967124700b7a6d14d497f65e0e5975b5a45e',
                                                                               'environmentSha256': '5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae'},
                                                             'api': {'image': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                                                                     'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                                                                     'status': 'running',
                                                                     'health': 'healthy',
                                                                     'containerId': '8e9f22d9ec615945844d846abca8c34f827d156b13154cf0382c55148407d5ff',
                                                                     'startedAtSha256': '2df79a73b30f3b54252ba0f8d8276815c704037cd19454a56c12074a0d57aa12',
                                                                     'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c'},
                                                             'admin': {'image': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                                                                       'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                                                                       'status': 'running',
                                                                       'health': 'healthy',
                                                                       'containerId': '8c34a75da43b9877b1ebf8110c41c726f3f7756473ab91c86fdc4f767dd2f075',
                                                                       'startedAtSha256': '499f832cd2baf51fa672a43d21922953ae003854a1678facee86a6c5f68423b8',
                                                                       'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4'},
                                                             'mysql': {'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                                                                       'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                                                                       'status': 'running',
                                                                       'health': 'healthy',
                                                                       'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                                                                       'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                                                                       'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'},
                                                             'caddy': {'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                                                                       'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                                                                       'status': 'running',
                                                                       'health': None,
                                                                       'containerId': '60d68c4e7c96e46c905d77bc059b3e5e93535d86710dfe19f791587790056cab',
                                                                       'startedAtSha256': '7c0ca0361f561b614aea52e22030becb250582f6b3e87e496c59ccc4d7f081cc',
                                                                       'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181'}}},
              'databaseGrants': {'status': 'SKIPPED', 'reason': 'FIXED_RECHARGE_NO_MIGRATIONS'}},
 'fileSha256': {'release-manifest.json': 'd35ac7ee8c1ed397c1db9478ce5f1eca2166267ec66f5db730634e238a72803e',
                'before-audit.json': 'bd97be325b3bbf0f4e0a3501cf47ce22d2550f3408ab50824fc5aac32ee42d4f',
                'after-audit.json': '9e65ad1000c29620aeeba7f3cea8113784f93ebdfb0fc552d960e6bf49cbee53',
                'docker-compose.aws-mysql.yml': '05cd335251b31010af76b6c727927c2ae04158c481cb64186156229a3f6801b8',
                'compose.release.json': 'c61a9944f1f8691218c4a5c41e3b8d49fe04102533fe51340176838a09b04b9c',
                '.env.aws.production': 'a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af',
                'deploy/aws/registration-worker-b8-80-20261006.json': 'd5c023887b22f6a555abe0f8e4627113d5a45dec0668ae2abc1bb8fbf8cbdb28',
                'deploy/aws/registration-worker-956-20261006.json': '60226df9c51cb222bf8c0cc09a7783b52a8f0082f728189ec3ada9554b6dbfc1',
                'deploy/aws/registration-worker-85-20261006.json': '02fc3375314ee75b6e5b8ec47ce715f1e02f9b744ce77c5a4804d9110ba4daec',
                'deploy/aws/registration-worker-86-20261006.json': '81946a081a13d6787a5a1e16782ef780065c6e81440b8500e55dbca155fef7f2',
                'deploy/aws/registration-worker-87-20261006.json': '3742920452e28992595c7d31d8ea5c03915f3a3218435a7714cf6e2fe1c2aea7',
                'deploy/aws/registration-worker-88-20261006.json': 'cce9a098659ba3bc5bec6e7fd8eb294d3ef075dc4676c86f5b4c38de1ff67d67',
                'deploy/aws/recharge-pro-main80-20261006.json': '6d10faabd632157233099dfce5d558d89f3a841a0556fc42f91b384f049cbdc0'},
 'overrideCanonicalSha256': '1e3129f0d94c00f12e31fbf55216f73439fc7b52525a7faa4538d271e40dc59e',
 'audits': {'before': {'checkCount': 49,
                       'violationCount': 0,
                       'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                       'gateSha256': 'ec68038c2606fabc6f5408a0e79784a6dc1b142acfc9cc6b78035581f907041f',
                       'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'},
            'after': {'checkCount': 49,
                      'violationCount': 0,
                      'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                      'gateSha256': '80be54958db3f671aca657fe52949f42b36fda1679d88e1fdb0c1655f54c79fb',
                      'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'}},
 'liveServices': {'media-resolver': {'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                     'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                     'status': 'running',
                                     'health': 'healthy',
                                     'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                     'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                     'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163'},
                  'auto-recharge': {'image': 'sha256:bd7f4b9b5012cc06f265b2ebf9a1c49c646dfd141695bc51cc1f24a197a3de51',
                                    'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:d2e22e623d0e19851c79ffe43396f5f97a99b8d3-37496968953-1-auto-recharge',
                                    'status': 'running',
                                    'health': 'healthy',
                                    'containerId': 'b221d3c3d23a2aba49f2e0ffa02365aa368e17d7efd55171da6f5e7a40102f53',
                                    'startedAtSha256': '5a50f0b801c6069121648ab0cf3965b779eb9a18861b20f1a9995724455d61a7',
                                    'environmentSha256': '5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae'},
                  'auto-registration': {'image': 'sha256:f369dcfc8a59dd5598eb00c857c9ddeba01520d24e3e78585bcd5ce11371491e',
                                        'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b91b626a71ed2c7c2473d080551b3b10b693b0cb-37481121792-2-auto-recharge',
                                        'status': 'running',
                                        'health': 'healthy',
                                        'containerId': 'a5036814eaa7207ed41ccb0cda8dcaf34a433bba5d7d854d1463bcabda3fc590',
                                        'startedAtSha256': 'ac39959777db37812c6a969a3faf58a91ee0563467eef71e9ace1f698544f3ab',
                                        'environmentSha256': 'de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17'},
                  'api': {'image': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                          'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                          'status': 'running',
                          'health': 'healthy',
                          'containerId': '8e9f22d9ec615945844d846abca8c34f827d156b13154cf0382c55148407d5ff',
                          'startedAtSha256': '2df79a73b30f3b54252ba0f8d8276815c704037cd19454a56c12074a0d57aa12',
                          'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c'},
                  'admin': {'image': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                            'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '8c34a75da43b9877b1ebf8110c41c726f3f7756473ab91c86fdc4f767dd2f075',
                            'startedAtSha256': '499f832cd2baf51fa672a43d21922953ae003854a1678facee86a6c5f68423b8',
                            'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4'},
                  'mysql': {'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                            'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                            'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                            'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'},
                  'caddy': {'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                            'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                            'status': 'running',
                            'health': None,
                            'containerId': '60d68c4e7c96e46c905d77bc059b3e5e93535d86710dfe19f791587790056cab',
                            'startedAtSha256': '7c0ca0361f561b614aea52e22030becb250582f6b3e87e496c59ccc4d7f081cc',
                            'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181'}},
 'readback': {'version': 1,
              'id': 'recharge-pro-main80-20261006',
              'status': 'VERIFIED',
              'currentCommit': 'd2e22e623d0e19851c79ffe43396f5f97a99b8d3',
              'sourceTree': 'd2d938a176fab2a99cc1edd1b25c1cd1ffb59357',
              'previousCommit': 'b91b626a71ed2c7c2473d080551b3b10b693b0cb',
              'profileSha256': '889afca1d21c9af22d95d7ac45f3323e18e793204f7098490c29e70cb627d2f0',
              'servicesUpdated': ['auto-recharge'],
              'preservedServiceCount': 6,
              'checkCount': 49,
              'executedCheckCount': 49,
              'unavailableCheckCount': 0,
              'violationCount': 0,
              'storedGatesMatched': True,
              'unchangedServiceContainersPreserved': True,
              'environmentUnchanged': True,
              'migrationStatus': 'SKIPPED',
              'databaseGrantSyncStatus': 'SKIPPED',
              'cacheStatus': 'SKIPPED',
              'liveServicesHealthy': True,
              'rechargeImageMatched': True},
 'actualWorkerSourceSha256': {'browser_password_login.py': '39a7d789098ed167c0b3e6e4b592553487bddf9e3d43bf64c1ff3a2667913ef6',
                              'registration_browser.py': '704d5c1fb4de91c727453208907ca1c4f98cf10c00235facb2ff73aec68192d4',
                              'registration_builtin.py': 'bf646db25d342c1ce1c8cbfebf74ec1b8f470f837f98a097d9c20cea1fbb5def',
                              'registration_job.py': 'f1878abdf27e6760bd63c602136ae14ff06902d136bbd47cf2d036fd1fb393ae'},
 'original80SealMatched': True,
 'databaseWrites': 0,
 'windowRestarted': False}
# Enabled only after the independently collected Pro runtime is frozen.
REGISTRATION_EMAIL_OBSERVATION_BASELINE = {key: REGISTRATION_EMAIL_OBSERVATION_PRO_BASELINE[key]
    for key in REGISTRATION_EMAIL_OBSERVATION_B91_BASELINE}
REGISTRATION_EMAIL_OBSERVATION_PRO_PROFILE_MODE = 0o664

# Release 90 is disabled until the reviewed Worker and Admin source is frozen.
REGISTRATION_HYDRATION_ID = 'registration-worker-90-20261007'
REGISTRATION_HYDRATION_FILE = 'deploy/aws/' + REGISTRATION_HYDRATION_ID + '.json'
REGISTRATION_HYDRATION_CURRENT = 'c3cad767b372738b2193e60584b0a53daa53b65f'
REGISTRATION_HYDRATION_SOURCE = '7560c66c4da503dbd420fba286e539abb47412f5'
REGISTRATION_HYDRATION_SOURCE_SHA256 = {'apps/admin/src/api/requestPolicy.spec.ts': 'f92e5a3e5ceabc331bf3ece3a2ca10dd303269db0ffeadf11eb04a4cdcc31882',
 'apps/admin/src/api/requestPolicy.ts': '9b02d2ec4cb7f32bbb7bdd1595721594ce4ad4a1d520b591a26e8cdef58d14ca',
 'apps/admin/src/v2/features/auto-registration/useRegistrationPage.spec.ts': 'c3f5b6ab5869e2a285e265241cdb5ef984e725d43bde905c79cc85f9f1f3d598',
 'apps/admin/src/v2/features/auto-registration/useRegistrationStart.ts': '003ac8282011ad36fe6fe0c02e4b9f1d52e8f79a36194a4e5843c4ea9b0c2525',
 'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': '59bc72963092c929fbf9352117aa17fa8409c7ada1d113ada27563431d2368a4',
 'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py': 'f1878abdf27e6760bd63c602136ae14ff06902d136bbd47cf2d036fd1fb393ae',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py': 'c409f1d4a36fc759aa3bf649d08e93938ff5497b9261b635f28cc02e324bcec0',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py': 'b9115e2d6f91bc0b847380b763d4bdd88391268bbfa7bb5ad1c1e3e4c8c82ed6',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': '112f00645205c2bd3b2b44c94c73b9de49e2f74022c4c52f7e20bee1b6000a35',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_builtin.py': '1d542dbd37870978a2c4b1bc0cd2878df8438d46d3b507684777204418f41bbe',
 'docs/AUTO_REGISTRATION.md': '3cb74e1f7269a5fa8dec5e6ca530147a310b261d43f44a62fbb979ad2aa6b11c'}
REGISTRATION_HYDRATION_WORKER_DELTA_SHA256 = {'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': '59bc72963092c929fbf9352117aa17fa8409c7ada1d113ada27563431d2368a4',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py': 'b9115e2d6f91bc0b847380b763d4bdd88391268bbfa7bb5ad1c1e3e4c8c82ed6',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': '112f00645205c2bd3b2b44c94c73b9de49e2f74022c4c52f7e20bee1b6000a35'}
REGISTRATION_HYDRATION_PROJECTION_SHA256 = '49bbfbd331e8d5a93bb18da61a56ef374c0a9b5d64e5866eb56771112336d1bc'
REGISTRATION_HYDRATION_ADMIN_SOURCE = '7560c66c4da503dbd420fba286e539abb47412f5'
REGISTRATION_HYDRATION_ADMIN_SOURCE_SHA256 = {'apps/admin/src/api/requestPolicy.spec.ts': 'f92e5a3e5ceabc331bf3ece3a2ca10dd303269db0ffeadf11eb04a4cdcc31882',
 'apps/admin/src/api/requestPolicy.ts': '9b02d2ec4cb7f32bbb7bdd1595721594ce4ad4a1d520b591a26e8cdef58d14ca',
 'apps/admin/src/v2/features/auto-registration/useRegistrationPage.spec.ts': 'c3f5b6ab5869e2a285e265241cdb5ef984e725d43bde905c79cc85f9f1f3d598',
 'apps/admin/src/v2/features/auto-registration/useRegistrationStart.ts': '003ac8282011ad36fe6fe0c02e4b9f1d52e8f79a36194a4e5843c4ea9b0c2525'}
REGISTRATION_HYDRATION_ADMIN_FILES = frozenset({
    'apps/admin/src/api/requestPolicy.ts', 'apps/admin/src/api/requestPolicy.spec.ts',
    'apps/admin/src/v2/features/auto-registration/useRegistrationStart.ts',
    'apps/admin/src/v2/features/auto-registration/useRegistrationPage.spec.ts'})
REGISTRATION_HYDRATION_ADMIN_PROJECTION_SHA256 = '6588af4e1d4f84dc512e2866db3d5b70875804fd82c536c82e88e80b38dd6ed3'
REGISTRATION_HYDRATION_BASELINE_RAW_SHA256 = '7da81a86049632418f4ffc1ac6b131fefac894f77971cb02d52f26a2e32b2418'
REGISTRATION_HYDRATION_SCOPE = {
    **REGISTRATION_SCOPE, 'servicesUpdated': ['admin', 'auto-registration'],
    'imageServices': ['admin', 'auto-recharge'],
    'preservedServices': ['auto-recharge', 'api', 'media-resolver', 'mysql', 'caddy']}
REGISTRATION_HYDRATION_BASELINE = {'status': 'VERIFIED_89_RUNTIME_BASELINE',
 'current': '/opt/id-business-v2/releases/20261006T210335Z-c3cad767b372',
 'controllerSha256': '641a76554f3926d1eda0ffe8d0dc66c7be3b09635daac70c219a8b1867c42b50',
 'profileSha256': '4113a45f2f50c3952172942005ba2ee6e4d4d8b64c62513d232cbe844c01dec5',
 'manifest': {'commit': 'c3cad767b372738b2193e60584b0a53daa53b65f',
              'sourceTree': '424d7c5812e0be9feba42f133639523571c9a056',
              'previousCommit': 'd2e22e623d0e19851c79ffe43396f5f97a99b8d3',
              'previousRelease': '/opt/id-business-v2/releases/20261006T163935Z-d2e22e623d0e',
              'deploymentRun': 'github-actions-37530616528-1',
              'imageBuildRun': 'github-actions-37530616528-1',
              'sourceArchiveSha256': '0b59863686debb24b9ecbb9b3a4042dd4b70629606d1cce44375f38dd12839ee',
              'servicesUpdated': ['auto-registration'],
              'migrationApplied': False,
              'newMigrations': [],
              'images': {'admin': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                                   'digest': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                                   'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'caddy': {'digest': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510'},
                         'api': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                                 'digest': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                                 'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'migrate': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-migrate',
                                     'digest': 'sha256:6f2c0d6f71c23ee2ec0565c1dae9a0a79f42dcf5ccb589bf0583c2b9e78414f9',
                                     'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'auto-recharge': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:d2e22e623d0e19851c79ffe43396f5f97a99b8d3-37496968953-1-auto-recharge',
                                           'digest': 'sha256:bd7f4b9b5012cc06f265b2ebf9a1c49c646dfd141695bc51cc1f24a197a3de51',
                                           'sourceCommit': 'd2e22e623d0e19851c79ffe43396f5f97a99b8d3'},
                         'media-resolver': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                            'digest': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                            'sourceCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'},
                         'auto-registration': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:c3cad767b372738b2193e60584b0a53daa53b65f-37530616528-1-auto-recharge',
                                               'digest': 'sha256:e17cb407c00591425a00f7e2583c42364d1b29f2c59d1d043b821a468216cea7',
                                               'sourceCommit': 'c3cad767b372738b2193e60584b0a53daa53b65f'}},
              'fixedRegistrationRelease': {'id': 'registration-worker-89-20261006',
                                           'profileRawSha256': '4113a45f2f50c3952172942005ba2ee6e4d4d8b64c62513d232cbe844c01dec5',
                                           'registrationSourceCommit': '83909af3df8655295984c427565731fc8bde0293',
                                           'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
                                           'workerProjectionSha256': 'd40c58deefb8cc5fe39fa2f711f9ca6416adab31ba68602d6910e8d090edde68',
                                           'financeSourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
                                           'financePolicyId': 'historical-finance-20261005-order-archive',
                                           'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
                                           'clearanceSealSha256': '46f1b091459ba540af2c26a2fad3136d1ca4b7f269d2a77bd6c97c48976ee520',
                                           'environmentUnchanged': True,
                                           'migrationStatus': 'SKIPPED',
                                           'databaseGrantSyncStatus': 'SKIPPED',
                                           'cacheStatus': 'SKIPPED'}},
 'fileSha256': {'release-manifest.json': 'f47a7918ec7cca8f2f516d21acc262e63e05a70e29a5496fe7b30aae370a23c0',
                'before-audit.json': '1d2a8e68aa91dc47abca5e733679dff16fd1eba9a3b561cf385fa1b32201f935',
                'after-audit.json': '2abd3eb8f3e732c0d238a4c484638800722bae77b192da65f5ab879071b0a829',
                'docker-compose.aws-mysql.yml': '05cd335251b31010af76b6c727927c2ae04158c481cb64186156229a3f6801b8',
                'compose.release.json': 'bb88076c5bf66a9253472298082e4ca872c40d569c8096a3b5286c8bc48f5e0f',
                '.env.aws.production': 'a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af',
                'deploy/aws/registration-worker-b8-80-20261006.json': 'd5c023887b22f6a555abe0f8e4627113d5a45dec0668ae2abc1bb8fbf8cbdb28',
                'deploy/aws/registration-worker-956-20261006.json': '60226df9c51cb222bf8c0cc09a7783b52a8f0082f728189ec3ada9554b6dbfc1',
                'deploy/aws/registration-worker-85-20261006.json': '02fc3375314ee75b6e5b8ec47ce715f1e02f9b744ce77c5a4804d9110ba4daec',
                'deploy/aws/registration-worker-86-20261006.json': '81946a081a13d6787a5a1e16782ef780065c6e81440b8500e55dbca155fef7f2',
                'deploy/aws/registration-worker-87-20261006.json': '3742920452e28992595c7d31d8ea5c03915f3a3218435a7714cf6e2fe1c2aea7',
                'deploy/aws/registration-worker-88-20261006.json': 'cce9a098659ba3bc5bec6e7fd8eb294d3ef075dc4676c86f5b4c38de1ff67d67',
                'deploy/aws/registration-worker-89-20261006.json': '4113a45f2f50c3952172942005ba2ee6e4d4d8b64c62513d232cbe844c01dec5'},
 'overrideCanonicalSha256': 'a61eb26ec2bf617e013f8658814151279d1854f25b5fe17a47d3deff199bfe55',
 'audits': {'before': {'checkCount': 49,
                       'violationCount': 0,
                       'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                       'gateSha256': 'ec68038c2606fabc6f5408a0e79784a6dc1b142acfc9cc6b78035581f907041f',
                       'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'},
            'after': {'checkCount': 49,
                      'violationCount': 0,
                      'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                      'gateSha256': '80be54958db3f671aca657fe52949f42b36fda1679d88e1fdb0c1655f54c79fb',
                      'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'}},
 'liveServices': {'media-resolver': {'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                     'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                     'status': 'running',
                                     'health': 'healthy',
                                     'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                     'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                     'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163'},
                  'auto-recharge': {'image': 'sha256:bd7f4b9b5012cc06f265b2ebf9a1c49c646dfd141695bc51cc1f24a197a3de51',
                                    'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:d2e22e623d0e19851c79ffe43396f5f97a99b8d3-37496968953-1-auto-recharge',
                                    'status': 'running',
                                    'health': 'healthy',
                                    'containerId': 'b221d3c3d23a2aba49f2e0ffa02365aa368e17d7efd55171da6f5e7a40102f53',
                                    'startedAtSha256': '5a50f0b801c6069121648ab0cf3965b779eb9a18861b20f1a9995724455d61a7',
                                    'environmentSha256': '5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae'},
                  'auto-registration': {'image': 'sha256:e17cb407c00591425a00f7e2583c42364d1b29f2c59d1d043b821a468216cea7',
                                        'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:c3cad767b372738b2193e60584b0a53daa53b65f-37530616528-1-auto-recharge',
                                        'status': 'running',
                                        'health': 'healthy',
                                        'containerId': '596785cecdeb9ca755247539a35c11fa6d8b522fe04968d554c7068d70eaba31',
                                        'startedAtSha256': '6bb00ade19eb86388d9c4601b4e3cce9d617ea301632fec268a55c5847631516',
                                        'environmentSha256': 'de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17'},
                  'api': {'image': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                          'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                          'status': 'running',
                          'health': 'healthy',
                          'containerId': '8e9f22d9ec615945844d846abca8c34f827d156b13154cf0382c55148407d5ff',
                          'startedAtSha256': '2df79a73b30f3b54252ba0f8d8276815c704037cd19454a56c12074a0d57aa12',
                          'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c'},
                  'admin': {'image': 'sha256:9e7420702d1a2995efb16206a8736f94490ab60bc10d2156135ee09610ca3693',
                            'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-admin',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '8c34a75da43b9877b1ebf8110c41c726f3f7756473ab91c86fdc4f767dd2f075',
                            'startedAtSha256': '499f832cd2baf51fa672a43d21922953ae003854a1678facee86a6c5f68423b8',
                            'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4'},
                  'mysql': {'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                            'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                            'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                            'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'},
                  'caddy': {'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                            'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                            'status': 'running',
                            'health': None,
                            'containerId': '60d68c4e7c96e46c905d77bc059b3e5e93535d86710dfe19f791587790056cab',
                            'startedAtSha256': '7c0ca0361f561b614aea52e22030becb250582f6b3e87e496c59ccc4d7f081cc',
                            'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181'}},
 'readback': {'version': 1,
              'id': 'registration-worker-89-20261006',
              'status': 'VERIFIED',
              'currentCommit': 'c3cad767b372738b2193e60584b0a53daa53b65f',
              'sourceTree': '424d7c5812e0be9feba42f133639523571c9a056',
              'profileSha256': '4113a45f2f50c3952172942005ba2ee6e4d4d8b64c62513d232cbe844c01dec5',
              'previousCommit': 'd2e22e623d0e19851c79ffe43396f5f97a99b8d3',
              'registrationSourceCommit': '83909af3df8655295984c427565731fc8bde0293',
              'workerBasisCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
              'workerProjectionSha256': 'd40c58deefb8cc5fe39fa2f711f9ca6416adab31ba68602d6910e8d090edde68',
              'servicesUpdated': ['auto-registration'],
              'preservedServiceCount': 6,
              'checkCount': 49,
              'executedCheckCount': 49,
              'unavailableCheckCount': 0,
              'violationCount': 0,
              'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
              'runningSourceMatched': True,
              'unchangedServiceContainersPreserved': True,
              'environmentUnchanged': True,
              'migrationStatus': 'SKIPPED',
              'databaseGrantSyncStatus': 'SKIPPED',
              'cacheStatus': 'SKIPPED',
              'liveServicesHealthy': True},
 'actualWorkerSourceSha256': {'browser_password_login.py': '39a7d789098ed167c0b3e6e4b592553487bddf9e3d43bf64c1ff3a2667913ef6',
                              'registration_browser.py': '2299a372aada6f356fa45f67e3c55028a476080f4c3bc8015b274df1ec855348',
                              'registration_builtin.py': 'bf646db25d342c1ce1c8cbfebf74ec1b8f470f837f98a097d9c20cea1fbb5def',
                              'registration_job.py': 'f1878abdf27e6760bd63c602136ae14ff06902d136bbd47cf2d036fd1fb393ae'},
 'original80SealMatched': True,
 'databaseWrites': 0,
 'windowRestarted': False}

REGISTRATION_PROFILE_OBSERVATION_ID = 'registration-worker-91-20261007'
REGISTRATION_PROFILE_OBSERVATION_FILE = 'deploy/aws/' + REGISTRATION_PROFILE_OBSERVATION_ID + '.json'
REGISTRATION_PROFILE_OBSERVATION_CURRENT = '01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af'
REGISTRATION_PROFILE_OBSERVATION_SOURCE = 'd6dbea1759d8d5ac9d3850067aadeb0d515eb545'
REGISTRATION_PROFILE_OBSERVATION_SOURCE_SHA256 = {'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': '0695a7ab960a07407ed16fbfce3368878b9e9c5c3ae4aef137ffbd7553495f9f',
 'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py': 'f1878abdf27e6760bd63c602136ae14ff06902d136bbd47cf2d036fd1fb393ae',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py': 'c409f1d4a36fc759aa3bf649d08e93938ff5497b9261b635f28cc02e324bcec0',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py': 'b9115e2d6f91bc0b847380b763d4bdd88391268bbfa7bb5ad1c1e3e4c8c82ed6',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': 'f49b7939de402db79b81d17069728a87ada29aa30bc9a12e0753267362f80382',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_builtin.py': '1d542dbd37870978a2c4b1bc0cd2878df8438d46d3b507684777204418f41bbe',
 'docs/AUTO_REGISTRATION.md': '3cb74e1f7269a5fa8dec5e6ca530147a310b261d43f44a62fbb979ad2aa6b11c'}
REGISTRATION_PROFILE_OBSERVATION_WORKER_DELTA_SHA256 = {'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': '0695a7ab960a07407ed16fbfce3368878b9e9c5c3ae4aef137ffbd7553495f9f',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': 'f49b7939de402db79b81d17069728a87ada29aa30bc9a12e0753267362f80382'}
REGISTRATION_PROFILE_OBSERVATION_PROJECTION_SHA256 = '196e41d26653963cbd0a2e2d168af09999c8eb6a31044a98124b29c48edf3b88'
REGISTRATION_PROFILE_OBSERVATION_BASELINE = {'status': 'VERIFIED_90_RUNTIME_BASELINE',
 'current': '/opt/id-business-v2/releases/20261006T225956Z-01cec5190b9f',
 'controllerSha256': '5f5244183c327e1b037e0c3bcf8098cbff04cbbd34328d133a4d0a220ba39f8f',
 'profileSha256': '56adb736e6081eeaeb31f14bba1ccb22f1a218c3f22abefcd1a9dcdae6625eed',
 'manifest': {'commit': '01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af',
              'sourceTree': '1f55cc743d48fdc5f7379c6d136e026d5ebfd558',
              'previousCommit': 'c3cad767b372738b2193e60584b0a53daa53b65f',
              'previousRelease': '/opt/id-business-v2/releases/20261006T210335Z-c3cad767b372',
              'deploymentRun': 'github-actions-37543606799-1',
              'imageBuildRun': 'github-actions-37543606799-1',
              'sourceArchiveSha256': '136fd9623f75fc1ec34f72b2d6068801d3160143a0bd66ad8c791d38767ecb4c',
              'servicesUpdated': ['admin', 'auto-registration'],
              'migrationApplied': False,
              'newMigrations': [],
              'images': {'admin': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af-37543606799-1-admin',
                                   'digest': 'sha256:dfd6c15ad3add1349fa797fceb6d75808dc032dbe0d4a09a15658dc04345525c',
                                   'sourceCommit': '01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af'},
                         'caddy': {'digest': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510'},
                         'api': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                                 'digest': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                                 'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'migrate': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-migrate',
                                     'digest': 'sha256:6f2c0d6f71c23ee2ec0565c1dae9a0a79f42dcf5ccb589bf0583c2b9e78414f9',
                                     'sourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'},
                         'auto-recharge': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:d2e22e623d0e19851c79ffe43396f5f97a99b8d3-37496968953-1-auto-recharge',
                                           'digest': 'sha256:bd7f4b9b5012cc06f265b2ebf9a1c49c646dfd141695bc51cc1f24a197a3de51',
                                           'sourceCommit': 'd2e22e623d0e19851c79ffe43396f5f97a99b8d3'},
                         'media-resolver': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                            'digest': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                            'sourceCommit': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'},
                         'auto-registration': {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af-37543606799-1-auto-recharge',
                                               'digest': 'sha256:985feea36d7d265df3bf50749be11944b019979e776061b28a4a84243723daeb',
                                               'sourceCommit': '01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af'}},
              'fixedRegistrationRelease': {'id': 'registration-worker-90-20261007',
                                           'profileRawSha256': '56adb736e6081eeaeb31f14bba1ccb22f1a218c3f22abefcd1a9dcdae6625eed',
                                           'registrationSourceCommit': '7560c66c4da503dbd420fba286e539abb47412f5',
                                           'workerBasisCommit': 'c3cad767b372738b2193e60584b0a53daa53b65f',
                                           'workerProjectionSha256': '49bbfbd331e8d5a93bb18da61a56ef374c0a9b5d64e5866eb56771112336d1bc',
                                           'financeSourceCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
                                           'financePolicyId': 'historical-finance-20261005-order-archive',
                                           'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
                                           'clearanceSealSha256': '46f1b091459ba540af2c26a2fad3136d1ca4b7f269d2a77bd6c97c48976ee520',
                                           'environmentUnchanged': True,
                                           'migrationStatus': 'SKIPPED',
                                           'databaseGrantSyncStatus': 'SKIPPED',
                                           'cacheStatus': 'SKIPPED',
                                           'adminSourceCommit': '7560c66c4da503dbd420fba286e539abb47412f5',
                                           'adminBasisCommit': '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b',
                                           'adminProjectionSha256': '6588af4e1d4f84dc512e2866db3d5b70875804fd82c536c82e88e80b38dd6ed3'}},
 'fileSha256': {'release-manifest.json': '1dd29bd5fd09dd63001fdccce066433423b2de4644440cac35fe7987937ea086',
                'before-audit.json': 'f4900ff62726712e248204ffb8d8ff70690fd6ad3736c22910315996a055628a',
                'after-audit.json': 'bc84b9ed955f3b2ff06b75167381a6806e722b114167d4d0f0f22e16ddf0eb34',
                'docker-compose.aws-mysql.yml': '05cd335251b31010af76b6c727927c2ae04158c481cb64186156229a3f6801b8',
                'compose.release.json': 'eec01cb77c7359ef4e01d5454dc352aeac1e38feabace19f78f97e35f8436cc1',
                '.env.aws.production': 'a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af',
                'deploy/aws/registration-worker-b8-80-20261006.json': 'd5c023887b22f6a555abe0f8e4627113d5a45dec0668ae2abc1bb8fbf8cbdb28',
                'deploy/aws/registration-worker-956-20261006.json': '60226df9c51cb222bf8c0cc09a7783b52a8f0082f728189ec3ada9554b6dbfc1',
                'deploy/aws/registration-worker-85-20261006.json': '02fc3375314ee75b6e5b8ec47ce715f1e02f9b744ce77c5a4804d9110ba4daec',
                'deploy/aws/registration-worker-86-20261006.json': '81946a081a13d6787a5a1e16782ef780065c6e81440b8500e55dbca155fef7f2',
                'deploy/aws/registration-worker-87-20261006.json': '3742920452e28992595c7d31d8ea5c03915f3a3218435a7714cf6e2fe1c2aea7',
                'deploy/aws/registration-worker-88-20261006.json': 'cce9a098659ba3bc5bec6e7fd8eb294d3ef075dc4676c86f5b4c38de1ff67d67',
                'deploy/aws/registration-worker-89-20261006.json': '4113a45f2f50c3952172942005ba2ee6e4d4d8b64c62513d232cbe844c01dec5',
                'deploy/aws/registration-worker-90-20261007.json': '56adb736e6081eeaeb31f14bba1ccb22f1a218c3f22abefcd1a9dcdae6625eed'},
 'overrideCanonicalSha256': 'f36bdb7063cbdf048f05f2ca0e7b34fab641971bad08d6b40da7bfad7ab08a7a',
 'audits': {'before': {'checkCount': 49,
                       'violationCount': 0,
                       'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                       'gateSha256': 'ec68038c2606fabc6f5408a0e79784a6dc1b142acfc9cc6b78035581f907041f',
                       'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'},
            'after': {'checkCount': 49,
                      'violationCount': 0,
                      'checksSha256': '94ca7901c5aed650f4d6c8856af86f9a0928f1660ea806372a1b1f41479288f2',
                      'gateSha256': '80be54958db3f671aca657fe52949f42b36fda1679d88e1fdb0c1655f54c79fb',
                      'identitySha256': '6458d529956db12370d7c9339a73e597b187aa0ef3a5fb475591b311ec9fdee1'}},
 'liveServices': {'media-resolver': {'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                     'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                     'status': 'running',
                                     'health': 'healthy',
                                     'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                     'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                     'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163'},
                  'auto-recharge': {'image': 'sha256:bd7f4b9b5012cc06f265b2ebf9a1c49c646dfd141695bc51cc1f24a197a3de51',
                                    'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:d2e22e623d0e19851c79ffe43396f5f97a99b8d3-37496968953-1-auto-recharge',
                                    'status': 'running',
                                    'health': 'healthy',
                                    'containerId': 'b221d3c3d23a2aba49f2e0ffa02365aa368e17d7efd55171da6f5e7a40102f53',
                                    'startedAtSha256': '5a50f0b801c6069121648ab0cf3965b779eb9a18861b20f1a9995724455d61a7',
                                    'environmentSha256': '5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae'},
                  'auto-registration': {'image': 'sha256:985feea36d7d265df3bf50749be11944b019979e776061b28a4a84243723daeb',
                                        'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af-37543606799-1-auto-recharge',
                                        'status': 'running',
                                        'health': 'healthy',
                                        'containerId': 'f61baaccea0630566694b5fb8837bbfddd7f6d24d5a6e8fb34e367d932c89daa',
                                        'startedAtSha256': '6042571b4241d50275c02c901c0da84b23ec844d660be88d9cff06ba83054b71',
                                        'environmentSha256': 'de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17'},
                  'api': {'image': 'sha256:3bb6b2d19432e327b258953900e7029d7bb56bfc7eb42ee26b611c1e1decf8f0',
                          'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b-37362644900-1-api',
                          'status': 'running',
                          'health': 'healthy',
                          'containerId': '8e9f22d9ec615945844d846abca8c34f827d156b13154cf0382c55148407d5ff',
                          'startedAtSha256': '2df79a73b30f3b54252ba0f8d8276815c704037cd19454a56c12074a0d57aa12',
                          'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c'},
                  'admin': {'image': 'sha256:dfd6c15ad3add1349fa797fceb6d75808dc032dbe0d4a09a15658dc04345525c',
                            'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af-37543606799-1-admin',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '7737ca8d5cd4613298df71f78177a4bf8f94fd6ca7a96d8afcfd8a30fd6fabf6',
                            'startedAtSha256': 'a23f08d872f054c445021de21df8adc34d397d4794eb8751a851c17f26ae66d7',
                            'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4'},
                  'mysql': {'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                            'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                            'status': 'running',
                            'health': 'healthy',
                            'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                            'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                            'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299'},
                  'caddy': {'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                            'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                            'status': 'running',
                            'health': None,
                            'containerId': '60d68c4e7c96e46c905d77bc059b3e5e93535d86710dfe19f791587790056cab',
                            'startedAtSha256': '7c0ca0361f561b614aea52e22030becb250582f6b3e87e496c59ccc4d7f081cc',
                            'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181'}},
 'readback': {'version': 1,
              'id': 'registration-worker-90-20261007',
              'status': 'VERIFIED',
              'currentCommit': '01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af',
              'sourceTree': '1f55cc743d48fdc5f7379c6d136e026d5ebfd558',
              'profileSha256': '56adb736e6081eeaeb31f14bba1ccb22f1a218c3f22abefcd1a9dcdae6625eed',
              'previousCommit': 'c3cad767b372738b2193e60584b0a53daa53b65f',
              'registrationSourceCommit': '7560c66c4da503dbd420fba286e539abb47412f5',
              'workerBasisCommit': 'c3cad767b372738b2193e60584b0a53daa53b65f',
              'workerProjectionSha256': '49bbfbd331e8d5a93bb18da61a56ef374c0a9b5d64e5866eb56771112336d1bc',
              'servicesUpdated': ['admin', 'auto-registration'],
              'preservedServiceCount': 5,
              'checkCount': 49,
              'executedCheckCount': 49,
              'unavailableCheckCount': 0,
              'violationCount': 0,
              'financeMode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49',
              'runningSourceMatched': True,
              'unchangedServiceContainersPreserved': True,
              'environmentUnchanged': True,
              'migrationStatus': 'SKIPPED',
              'databaseGrantSyncStatus': 'SKIPPED',
              'cacheStatus': 'SKIPPED',
              'liveServicesHealthy': True},
 'actualWorkerSourceSha256': {'browser_password_login.py': '39a7d789098ed167c0b3e6e4b592553487bddf9e3d43bf64c1ff3a2667913ef6',
                              'registration_browser.py': '59bc72963092c929fbf9352117aa17fa8409c7ada1d113ada27563431d2368a4',
                              'registration_builtin.py': 'bf646db25d342c1ce1c8cbfebf74ec1b8f470f837f98a097d9c20cea1fbb5def',
                              'registration_job.py': 'f1878abdf27e6760bd63c602136ae14ff06902d136bbd47cf2d036fd1fb393ae'},
 'original80SealMatched': True,
 'databaseWrites': 0,
 'windowRestarted': False}

def registration_contract(profile_id=REGISTRATION_SCOPE_ID):
    if profile_id == REGISTRATION_PROFILE_OBSERVATION_ID:
        return {'id': profile_id, 'file': REGISTRATION_PROFILE_OBSERVATION_FILE,
            'current': REGISTRATION_PROFILE_OBSERVATION_CURRENT,
            'source': REGISTRATION_PROFILE_OBSERVATION_SOURCE,
            'sourceSha256': REGISTRATION_PROFILE_OBSERVATION_SOURCE_SHA256,
            'projectionSha256': REGISTRATION_PROFILE_OBSERVATION_PROJECTION_SHA256,
            'runtimeBaseline': REGISTRATION_PROFILE_OBSERVATION_BASELINE}
    if profile_id == REGISTRATION_HYDRATION_ID:
        return {'id': profile_id, 'file': REGISTRATION_HYDRATION_FILE, 'current': REGISTRATION_HYDRATION_CURRENT,
            'source': REGISTRATION_HYDRATION_SOURCE, 'sourceSha256': REGISTRATION_HYDRATION_SOURCE_SHA256,
            'projectionSha256': REGISTRATION_HYDRATION_PROJECTION_SHA256,
            'runtimeBaseline': REGISTRATION_HYDRATION_BASELINE,
            'servicesUpdated': ['admin', 'auto-registration']}
    require(profile_id in (REGISTRATION_SCOPE_ID, REGISTRATION_CONTINUATION_ID, REGISTRATION_INITIAL_ID, REGISTRATION_EMAIL_ID, REGISTRATION_CALLBACK_ID, REGISTRATION_EMAIL_REQUEST_ID, REGISTRATION_EMAIL_OBSERVATION_ID),
            'Fixed registration selection changed')
    if profile_id == REGISTRATION_EMAIL_OBSERVATION_ID:
        return {'id': profile_id, 'file': REGISTRATION_EMAIL_OBSERVATION_FILE, 'current': REGISTRATION_EMAIL_OBSERVATION_CURRENT,
            'source': REGISTRATION_EMAIL_OBSERVATION_SOURCE, 'sourceSha256': REGISTRATION_EMAIL_OBSERVATION_SOURCE_SHA256,
            'projectionSha256': REGISTRATION_EMAIL_OBSERVATION_PROJECTION_SHA256, 'runtimeBaseline': REGISTRATION_EMAIL_OBSERVATION_BASELINE}
    if profile_id == REGISTRATION_EMAIL_REQUEST_ID:
        return {'id': profile_id, 'file': REGISTRATION_EMAIL_REQUEST_FILE, 'current': REGISTRATION_EMAIL_REQUEST_CURRENT,
            'source': REGISTRATION_EMAIL_REQUEST_SOURCE, 'sourceSha256': REGISTRATION_EMAIL_REQUEST_SOURCE_SHA256,
            'projectionSha256': REGISTRATION_EMAIL_REQUEST_PROJECTION_SHA256, 'runtimeBaseline': REGISTRATION_EMAIL_REQUEST_BASELINE}
    if profile_id == REGISTRATION_CALLBACK_ID:
        return {'id': profile_id, 'file': REGISTRATION_CALLBACK_FILE, 'current': REGISTRATION_CALLBACK_CURRENT,
            'source': REGISTRATION_CALLBACK_SOURCE, 'sourceSha256': REGISTRATION_CALLBACK_SOURCE_SHA256,
            'projectionSha256': REGISTRATION_CALLBACK_PROJECTION_SHA256, 'runtimeBaseline': REGISTRATION_CALLBACK_BASELINE}
    if profile_id == REGISTRATION_EMAIL_ID:
        return {'id': profile_id, 'file': REGISTRATION_EMAIL_FILE, 'current': REGISTRATION_EMAIL_CURRENT,
            'source': REGISTRATION_EMAIL_SOURCE, 'sourceSha256': REGISTRATION_EMAIL_SOURCE_SHA256,
            'projectionSha256': REGISTRATION_EMAIL_PROJECTION_SHA256, 'runtimeBaseline': REGISTRATION_EMAIL_BASELINE}
    if profile_id == REGISTRATION_INITIAL_ID:
        return {'id': profile_id, 'file': REGISTRATION_INITIAL_FILE, 'current': REGISTRATION_INITIAL_CURRENT,
            'source': REGISTRATION_INITIAL_SOURCE, 'sourceSha256': REGISTRATION_INITIAL_SOURCE_SHA256,
            'projectionSha256': REGISTRATION_INITIAL_PROJECTION_SHA256, 'runtimeBaseline': REGISTRATION_INITIAL_BASELINE}
    continued = profile_id == REGISTRATION_CONTINUATION_ID
    return {'id': profile_id, 'file': REGISTRATION_CONTINUATION_FILE if continued else REGISTRATION_SCOPE_FILE,
        'current': REGISTRATION_CONTINUATION_CURRENT if continued else REGISTRATION_CURRENT,
        'source': REGISTRATION_CONTINUATION_SOURCE if continued else REGISTRATION_SOURCE,
        'sourceSha256': REGISTRATION_CONTINUATION_SOURCE_SHA256 if continued else REGISTRATION_SOURCE_SHA256,
        'projectionSha256': REGISTRATION_CONTINUATION_PROJECTION_SHA256 if continued else REGISTRATION_PROJECTION_SHA256,
        'runtimeBaseline': REGISTRATION_CONTINUATION_BASELINE if continued else None}


def registration_profile(value, *, profile_id=REGISTRATION_SCOPE_ID):
    if profile_id == REGISTRATION_PROFILE_OBSERVATION_ID:
        return registration_profile_observation_profile(value)
    if profile_id == REGISTRATION_HYDRATION_ID:
        return registration_hydration_profile(value)
    contract = registration_contract(profile_id)
    extra = {'runtimeBaseline'} if contract['runtimeBaseline'] is not None else set()
    """A fixed runtime selection; it cannot create or enlarge a finance exception."""
    require(isinstance(value, dict) and set(value) == {'version', 'kind', 'id', 'enabled',
        'expectedCurrent', 'baselineRelease', 'registrationSourceCommit', 'workerBasisCommit',
        'registrationSourceSha256', 'workerProjection', 'workerProjectionSha256',
        'buildInputSha256', 'controlSourceSha256', 'scope', 'financeValidator', 'financeClearance'} | extra,
        'Fixed registration scope changed')
    require(type(value['version']) is int and value['version'] == 1 and value['enabled'] is True
        and value['kind'] == 'FIXED_REGISTRATION_RUNTIME_SCOPE' and value['id'] == contract['id']
        and value['expectedCurrent'] == contract['current']
        and value['registrationSourceCommit'] == contract['source']
        and value['workerBasisCommit'] == RECHARGE_SCOPE_CURRENT
        and value['baselineRelease'] == REGISTRATION_BASELINE
        and (not extra or historical_fingerprint(value['runtimeBaseline'])
            == historical_fingerprint(contract['runtimeBaseline']))
        and historical_fingerprint(value['scope']) == historical_fingerprint(REGISTRATION_SCOPE)
        and historical_fingerprint(value['financeValidator']) == historical_fingerprint(REGISTRATION_FINANCE)
        and historical_fingerprint(value['financeClearance']) == historical_fingerprint(REGISTRATION_CLEARANCE),
        'Fixed registration scope changed')
    digest = lambda x: isinstance(x, str) and re.fullmatch(r'[a-f0-9]{64}', x) is not None
    worker_files = REGISTRATION_EMAIL_FILES if profile_id in (REGISTRATION_EMAIL_ID, REGISTRATION_CALLBACK_ID, REGISTRATION_EMAIL_REQUEST_ID, REGISTRATION_EMAIL_OBSERVATION_ID) else REGISTRATION_FILES
    names = worker_files | {'docs/AUTO_REGISTRATION.md'}
    require(isinstance(value['registrationSourceSha256'], dict)
        and set(value['registrationSourceSha256']) == names
        and value['registrationSourceSha256'] == contract['sourceSha256']
        and set(value['buildInputSha256']) == {'.dockerignore', 'scripts/audit-python-dependencies.py'}
        and all(digest(x) for x in value['buildInputSha256'].values())
        and value['buildInputSha256'] == {
            '.dockerignore': '9f69c1f476e723f1d8de9892058c34abc3817481b6d8259da4175c3f6293c05d',
            'scripts/audit-python-dependencies.py': '99b90a53943699d44c3fca8642db0ef7917ce618d2f3e09a4e30f31c127ee41c'}
        and set(value['controlSourceSha256']) == REGISTRATION_CONTROLS
        and all(digest(x) for x in value['controlSourceSha256'].values()), 'Fixed registration source changed')
    projection = value['workerProjection']
    require(isinstance(projection, dict) and len(projection) == 60
        and all(isinstance(name, str) and name.startswith(REGISTRATION_WORKER_PREFIX)
                and '..' not in Path(name).parts and isinstance(row, dict)
                and set(row) == {'mode', 'sha256'} and row['mode'] in ('100644', '100755')
                and digest(row['sha256']) for name, row in projection.items())
        and value['workerProjectionSha256'] == contract['projectionSha256']
        and historical_fingerprint(projection) == contract['projectionSha256']
        and all(projection[name]['sha256'] == value['registrationSourceSha256'][name]
                for name in worker_files), 'Fixed registration projection changed')
    return value


def registration_archive(raw, commit):
    require(re.fullmatch(r'[a-f0-9]{40}', commit) and isinstance(raw, bytes)
        and 0 < len(raw) <= 64 * 1024 * 1024, 'Fixed registration archive unavailable')
    result = {}; total = 0; prefix = 'id-business-system-' + commit + '/'
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:*') as archive:
        for member in archive:
            require((member.name.startswith(prefix) or member.isdir() and member.name.rstrip('/') == prefix.rstrip('/'))
                and '\\' not in member.name
                and '..' not in Path(member.name).parts, 'Fixed registration archive unavailable')
            if member.isdir():
                continue
            name = member.name[len(prefix):]
            total += member.size
            require(member.isfile() and name and name not in result
                and member.mode in (0o644, 0o664, 0o755, 0o775)
                and 0 <= member.size <= 8 * 1024 * 1024 and total <= 64 * 1024 * 1024,
                'Fixed registration archive unavailable')
            data = archive.extractfile(member).read(8 * 1024 * 1024 + 1)
            require(len(data) == member.size, 'Fixed registration archive unavailable')
            result[name] = (data, '100755' if member.mode & 0o111 else '100644')
    require(result, 'Fixed registration archive unavailable')
    return result


def registration_download(commit):
    require(re.fullmatch(r'[a-f0-9]{40}', commit), 'Fixed registration archive unavailable')
    with urllib.request.urlopen('https://github.com/wangchaozhuanyong/id-business-system/archive/'
            + commit + '.tar.gz', timeout=60) as response:
        raw = response.read(64 * 1024 * 1024 + 1)
    require(0 < len(raw) <= 64 * 1024 * 1024, 'Fixed registration archive unavailable')
    return raw


def registration_source(profile, files):
    for name, digest in {**profile['registrationSourceSha256'], **profile['controlSourceSha256']}.items():
        require(name in files and hashlib.sha256(files[name][0]).hexdigest() == digest,
                'Fixed registration reviewed source changed')


def registration_worker_projection(profile, basis, candidate):
    if profile['id'] == REGISTRATION_PROFILE_OBSERVATION_ID:
        return registration_profile_observation_worker_projection(profile, basis, candidate)
    if profile['id'] == REGISTRATION_HYDRATION_ID:
        return registration_hydration_worker_projection(profile, basis, candidate)
    registration_source(profile, candidate)
    result = {name: row for name, row in basis.items() if name.startswith(REGISTRATION_WORKER_PREFIX)}
    worker_files = REGISTRATION_EMAIL_FILES if profile['id'] in (REGISTRATION_EMAIL_ID, REGISTRATION_CALLBACK_ID, REGISTRATION_EMAIL_REQUEST_ID, REGISTRATION_EMAIL_OBSERVATION_ID) else REGISTRATION_FILES
    result.update({name: candidate[name] for name in worker_files})
    actual = {name: {'mode': mode, 'sha256': hashlib.sha256(data).hexdigest()}
              for name, (data, mode) in result.items()}
    require(actual == profile['workerProjection'], 'Fixed registration projection changed')
    for name, digest in profile['buildInputSha256'].items():
        require(name in basis and hashlib.sha256(basis[name][0]).hexdigest() == digest,
                'Fixed registration build input changed')
        result[name] = basis[name]
    return result


def check_fixed_registration_scope(profile_id=REGISTRATION_SCOPE_ID):
    contract = registration_contract(profile_id)
    root = Path(__file__).resolve().parents[2]
    profile = registration_profile(fixed_recharge_json(fixed_recharge_bytes(
        root / contract['file'], modes=(0o644, 0o664), limit=128 * 1024)), profile_id=profile_id)
    for name, digest in {**profile['registrationSourceSha256'], **profile['controlSourceSha256']}.items():
        require(hashlib.sha256(fixed_recharge_bytes(root / name,
            modes=(0o644, 0o664, 0o755, 0o775))).hexdigest() == digest,
            'Fixed registration reviewed source changed')
    return root, profile


def write_registration_files(root, files):
    require(root.is_absolute() and root.resolve() == root and not root.exists(),
            'Fixed registration output already exists')
    root.mkdir(mode=0o700)
    for name, (data, mode) in files.items():
        require(name and not Path(name).is_absolute() and '..' not in Path(name).parts,
                'Fixed registration output changed')
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        # Public Git subdirectories are bound read-only into non-root audit containers.
        # Keep the outer staging directory private and restore traversal under umask 077.
        for parent in path.parents:
            if parent == root:
                break
            parent.chmod(0o755)
        path.write_bytes(data)
        path.chmod(0o755 if mode == '100755' else 0o644)


def prepare_fixed_registration_build(profile_id=REGISTRATION_SCOPE_ID):
    if profile_id == REGISTRATION_HYDRATION_ID:
        return prepare_registration_hydration_build()
    contract = registration_contract(profile_id)
    root, profile = check_fixed_registration_scope(profile_id)
    candidate = {name: (fixed_recharge_bytes(root / name, modes=(0o644, 0o664, 0o755, 0o775)),
                        '100755' if (root / name).stat().st_mode & 0o111 else '100644')
                 for name in profile['registrationSourceSha256'].keys() | profile['controlSourceSha256'].keys()}
    basis = registration_archive(registration_download(RECHARGE_SCOPE_CURRENT), RECHARGE_SCOPE_CURRENT)
    files = registration_worker_projection(profile, basis, candidate)
    output = root / '.deploy/production-release'
    require(not output.is_symlink() and not (root / '.deploy').is_symlink(),
            'Fixed registration output changed')
    output.mkdir(parents=True, exist_ok=True)
    write_registration_files(output / 'registration-build-context', files)
    manifest = {'version': 1, 'id': contract['id'],
        'sourceCommit': run('git', '-C', str(root), 'rev-parse', 'HEAD'),
        'sourceTree': run('git', '-C', str(root), 'rev-parse', 'HEAD^{tree}'),
        'registrationSourceCommit': contract['source'], 'workerBasisCommit': registration_worker_basis(profile_id),
        'workerProjectionSha256': contract['projectionSha256'],
        'registrationSourceSha256': profile['registrationSourceSha256'],
        'contextPath': '.deploy/production-release/registration-build-context'}
    target = output / 'registration-build-projection.json'
    require(not target.exists() and not target.is_symlink(), 'Fixed registration output already exists')
    target.write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def registration_audit_receipts(previous, manifest):
    reports = {}
    for stage in ('before', 'after'):
        raw = private_maintenance_receipt(previous / (stage + '-audit.json'))
        require(hashlib.sha256(raw).hexdigest() == REGISTRATION_BASELINE[stage + 'AuditSha256'],
                'Fixed registration baseline changed')
        report = fixed_recharge_json(raw)
        require(report.get('ok') is False and type(report.get('checkCount')) is int
            and report['checkCount'] == 49 and type(report.get('violationCount')) is int
            and report['violationCount'] == 5
            and historical_fingerprint(report.get('gate')) == REGISTRATION_FINANCE['gateSha256'][stage]
            and historical_fingerprint(report.get('checks')) == REGISTRATION_FINANCE['checksSha256']
            and manifest.get('dataAudit' + stage.title(), {}).get('historicalException') == report['gate'],
            'Fixed registration baseline audit changed')
        reports[stage] = report
    require(reports['before'].get('checks') == reports['after'].get('checks'),
            'Fixed registration baseline audit changed')


def registration_baseline(previous, states=None):
    require(previous.resolve() == previous and previous.parent == BASE / 'releases',
            'Fixed registration baseline changed')
    raw = private_maintenance_receipt(previous / 'release-manifest.json')
    require(hashlib.sha256(raw).hexdigest() == REGISTRATION_BASELINE['manifestSha256'],
            'Fixed registration baseline changed')
    manifest = fixed_recharge_json(raw)
    require(all(manifest.get(key) == REGISTRATION_BASELINE[key]
        for key in ('commit', 'sourceTree', 'previousCommit', 'deploymentRun', 'sourceArchiveSha256'))
        and manifest.get('servicesUpdated') == ['api', 'admin']
        and manifest.get('newMigrations') == [ORDER_ARCHIVE_MIGRATION + '/migration.sql']
        and manifest.get('migrationApplied') is True,
        'Fixed registration baseline changed')
    registration_audit_receipts(previous, manifest)
    for name, key in (('docker-compose.aws-mysql.yml', 'composeSha256'),
                      ('compose.release.json', 'overrideRawSha256')):
        require(hashlib.sha256(fixed_recharge_bytes(previous / name,
            modes=(0o400, 0o600, 0o644, 0o664))).hexdigest() == REGISTRATION_BASELINE[key],
            'Fixed registration baseline changed')
    override = fixed_recharge_json((previous / 'compose.release.json').read_bytes())
    require(historical_fingerprint(override) == REGISTRATION_BASELINE['overrideCanonicalSha256']
        and override == {'services': {name: {'image': manifest['images'][name]['reference'], 'pull_policy': 'never'}
            for name in (*SERVICES, 'migrate')}}, 'Fixed registration baseline changed')
    require(hashlib.sha256(fixed_recharge_bytes(previous / '.env.aws.production')).hexdigest()
        == REGISTRATION_BASELINE['environmentRawSha256'], 'Fixed registration environment changed')
    require(manifest['images']['auto-registration']['sourceCommit'] == RECHARGE_SCOPE_CURRENT,
        'Fixed registration baseline changed')
    if states is not None:
        require(set(states) == set(ALL_SERVICES) and all(row['status'] == 'running' for row in states.values())
            and all(states[name]['health'] == 'healthy' for name in ALL_SERVICES if name != 'caddy')
            and all(states[name].get('environmentSha256') == REGISTRATION_BASELINE['runtimeEnvironmentSha256'][name]
                    for name in ALL_SERVICES)
            and all(states[name]['image'] == manifest['images'][name]['digest']
                and states[name]['reference'] == manifest['images'][name]['reference'] for name in SERVICES),
            'Fixed registration baseline changed')
    return manifest, previous


def registration_observation_pro_profile(directory):
    fixed = REGISTRATION_EMAIL_OBSERVATION_PRO_BASELINE
    require(isinstance(fixed, dict) and isinstance(fixed.get('fileSha256'), dict)
        and RECHARGE_MAIN80_FILE in fixed['fileSha256'], 'Fixed registration Pro bridge unavailable')
    pinned_mode = REGISTRATION_EMAIL_OBSERVATION_PRO_PROFILE_MODE
    require(type(pinned_mode) is int and pinned_mode in (0o644, 0o664), 'Fixed registration Pro profile mode unavailable')
    mode = pinned_mode if str(directory) == fixed['current'] else 0o644
    raw = fixed_recharge_bytes(directory / RECHARGE_MAIN80_FILE, modes=(mode,), limit=128 * 1024)
    require(hashlib.sha256(raw).hexdigest() == fixed['fileSha256'][RECHARGE_MAIN80_FILE]
        == fixed['profileSha256'], 'Fixed registration Pro profile changed')
    profile = parse_fixed_recharge_scope(raw)
    validate_fixed_recharge_readback_projection(fixed['readback'], fixed['manifest']['commit'],
        fixed['manifest']['sourceTree'], historical_fingerprint(profile), profile_id=RECHARGE_MAIN80_ID)
    return raw


def registration_observation_pro_baseline(previous, states=None):
    """Verify the fixed Pro predecessor without applying its old worker checks to worker 89."""
    message = 'Fixed registration Pro bridge changed'
    fixed, anchor = REGISTRATION_EMAIL_OBSERVATION_PRO_BASELINE, REGISTRATION_EMAIL_OBSERVATION_B91_BASELINE
    require(isinstance(fixed, dict) and set(fixed) == {'status', 'current', 'controllerSha256', 'profileSha256',
        'manifest', 'fileSha256', 'overrideCanonicalSha256', 'audits', 'liveServices', 'readback',
        'actualWorkerSourceSha256', 'original80SealMatched', 'databaseWrites', 'windowRestarted'}
        and fixed['status'] == 'VERIFIED_PRO_AFTER_88_RUNTIME_BASELINE' and fixed['original80SealMatched'] is True
        and type(fixed['databaseWrites']) is int and fixed['databaseWrites'] == 0 and fixed['windowRestarted'] is False,
        message)
    contract = registration_contract(REGISTRATION_EMAIL_OBSERVATION_ID)
    require(contract['runtimeBaseline'] == {key: fixed[key] for key in anchor}
        and fixed['manifest']['commit'] == contract['current'] and contract['current'] != RECHARGE_MAIN80_CURRENT
        and previous.is_absolute() and previous.resolve() == previous and previous.parent == BASE / 'releases'
        and str(previous) == fixed['current'] and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + contract['current'][:12], previous.name)
        and set(fixed['fileSha256']) == set(anchor['fileSha256']) | {RECHARGE_MAIN80_FILE}, message)
    pointer = (BASE / 'current').resolve()
    live = {name: service_state(pointer, name, include_container_id=True, include_environment_hash=True)
        for name in ALL_SERVICES}
    require(set(fixed['liveServices']) == set(ALL_SERVICES)
        and registration_preserved_states(live) == registration_preserved_states(fixed['liveServices'])
        and all(row['status'] == 'running' for row in live.values())
        and all(live[name]['health'] == 'healthy' for name in ALL_SERVICES if name != 'caddy'), message)
    observed = {}
    def read(path, **options):
        raw = fixed_recharge_bytes(path, **options)
        require(path not in observed or observed[path][0] == raw, message)
        observed[path] = (raw, options)
        return raw
    def frozen_files(directory, hashes):
        for name, digest in hashes.items():
            modes = (0o400, 0o600) if name in ('.env.aws.production', 'release-manifest.json', 'before-audit.json', 'after-audit.json') else (0o400, 0o600, 0o644, 0o664)
            require(hashlib.sha256(read(directory / name, modes=modes, limit=128 * 1024)).hexdigest() == digest, message)
    frozen_files(previous, fixed['fileSha256'])
    require(hashlib.sha256(read(previous / 'scripts/production-release/remote-deploy.py', modes=(0o644, 0o664))).hexdigest()
        == fixed['controllerSha256'], message)
    manifest = fixed_recharge_json(read(previous / 'release-manifest.json'))
    require(set(fixed['manifest']) == set(anchor['manifest']) | {'databaseGrants', 'fixedRegistrationPreservedStates',
        'fixedRechargeRelease', 'fixedRechargePreservedStates'}
        and {key: manifest.get(key) for key in fixed['manifest']} == fixed['manifest']
        and manifest['previousCommit'] == RECHARGE_MAIN80_CURRENT and manifest['servicesUpdated'] == ['auto-recharge']
        and manifest['migrationApplied'] is False and manifest['newMigrations'] == []
        and manifest['databaseGrants'] == {'status': 'SKIPPED', 'reason': 'FIXED_RECHARGE_NO_MIGRATIONS'}, message)
    pro_raw = registration_observation_pro_profile(previous)
    profile = parse_fixed_recharge_scope(pro_raw)
    before = Path(manifest['previousRelease'])
    require(str(before) == anchor['current'] and before.resolve() == before and before.parent == BASE / 'releases', message)
    frozen_files(before, anchor['fileSha256'])
    old = fixed_recharge_json(read(before / 'release-manifest.json'))
    require({key: old.get(key) for key in anchor['manifest']} == anchor['manifest']
        and old['commit'] == RECHARGE_MAIN80_CURRENT and manifest['fixedRegistrationRelease'] == old['fixedRegistrationRelease']
        and set(manifest['images']) == set(old['images'])
        and all(manifest['images'][name] == old['images'][name] for name in old['images'] if name != 'auto-recharge')
        and manifest['fixedRechargePreservedStates'] == {'before': main80_recharge_preserved_states(fixed['liveServices']),
            'after': main80_recharge_preserved_states(fixed['liveServices'])}
        and main80_recharge_preserved_states(fixed['liveServices']) == main80_recharge_preserved_states(anchor['liveServices']), message)
    origin = main80_recharge_origin(before, old)
    for path in (ORDER_ARCHIVE_SEAL, POST_CLEANUP_RECEIPT): read(path)
    for directory in (origin, before, previous):
        for name in ('order-archive-seal.reader.json', 'order-archive-cleanup.reader.json'):
            read(directory / name, modes=(0o400,))
        main80_recharge_reader_evidence(directory)
    policy, seal = main80_recharge_seal(origin, profile)
    frozen = fixed_recharge_json(read(origin / 'before-audit.json'))['gate']
    gates, facts = {}, []
    for stage in ('before', 'after'):
        main80_recharge_report(fixed_recharge_json(read(origin / (stage + '-audit.json'))), profile, policy, seal, stage)
        for directory, baseline, saved in ((before, anchor, old), (previous, fixed, manifest)):
            report = fixed_recharge_json(read(directory / (stage + '-audit.json')))
            summary = require_registration_zero_report(report, stage, frozen)
            measured = {'checkCount': report['checkCount'], 'violationCount': report['violationCount'],
                'checksSha256': historical_fingerprint(report['checks']), 'gateSha256': historical_fingerprint(report['gate']),
                'identitySha256': historical_fingerprint(report['identity'])}
            require(summary == saved['dataAudit' + stage.title()] and measured == baseline['audits'][stage], message)
            facts.append((report['checks'], report['identity']))
            if directory == previous: gates[stage] = summary
    require(all(value == facts[0] for value in facts), message)
    context = main80_recharge_context(argparse.Namespace(commit=contract['current'], source_tree=manifest['sourceTree'],
        expected_current=RECHARGE_MAIN80_CURRENT), profile, gates['before'], gates['after'])
    require(manifest['fixedRechargeRelease'] == context and read(previous / '.env.aws.production') == read(before / '.env.aws.production')
        and read(previous / 'docker-compose.aws-mysql.yml', modes=(0o644, 0o664)) == read(before / 'docker-compose.aws-mysql.yml', modes=(0o644, 0o664)), message)
    override = fixed_recharge_json(read(previous / 'compose.release.json', modes=(0o400, 0o600, 0o644)))
    require(historical_fingerprint(override) == fixed['overrideCanonicalSha256']
        and override == {'services': {name: {'image': manifest['images'][name]['reference'], 'pull_policy': 'never'}
            for name in (*SERVICES, 'migrate')}}, message)
    worker_profile = registration_profile(fixed_recharge_json(read(before / REGISTRATION_EMAIL_REQUEST_FILE,
        modes=(0o644, 0o664), limit=128 * 1024)), profile_id=REGISTRATION_EMAIL_REQUEST_ID)
    require(fixed['actualWorkerSourceSha256'] == {name: worker_profile['workerProjection'][REGISTRATION_WORKER_PREFIX + name]['sha256']
        for name in ('browser_password_login.py', 'registration_browser.py', 'registration_builtin.py', 'registration_job.py')}, message)
    for name, digest in fixed['actualWorkerSourceSha256'].items():
        require(hashlib.sha256(read(previous / (REGISTRATION_WORKER_PREFIX + name), modes=(0o644, 0o664))).hexdigest() == digest, message)
    archive = fixed_recharge_runtime_archive(profile)
    native = verify_main80_recharge_finance_source(before, archive)
    public = verify_main80_recharge_candidate_source(previous, archive, profile)
    pro_image = manifest['images']['auto-recharge']
    require(fixed['liveServices']['auto-recharge']['image'] == pro_image['digest']
        and fixed['liveServices']['auto-recharge']['reference'] == pro_image['reference']
        and pro_image['sourceCommit'] == contract['current'] and manifest['imageBuildRun'] == manifest['deploymentRun']
        and re.fullmatch(r'github-actions-[1-9][0-9]*-[1-9][0-9]*', manifest['deploymentRun'])
        and pro_image['reference'].endswith(':' + contract['current'] + '-' + manifest['deploymentRun'].removeprefix('github-actions-') + '-auto-recharge'), message)
    metadata = json.loads(run('docker', 'image', 'inspect', pro_image['digest']))
    require(isinstance(metadata, list) and len(metadata) == 1 and metadata[0]['Id'] == pro_image['digest']
        and metadata[0]['Architecture'] == 'amd64'
        and metadata[0]['Config']['Labels'].get('org.opencontainers.image.revision') == contract['current'], message)
    if pointer == previous:
        require(live == fixed['liveServices'] and (states is None or states == live), message)
        require(check_fixed_recharge_deployment(contract['current'], manifest['sourceTree'], historical_fingerprint(profile),
            profile_id=RECHARGE_MAIN80_ID) == fixed['readback'], message)
    else:
        require(states is None, message)
        current_manifest = fixed_recharge_json(read(pointer / 'release-manifest.json', modes=(0o600,)))
        require(current_manifest.get('previousRelease') == str(previous) and current_manifest.get('previousCommit') == contract['current']
            and current_manifest.get('servicesUpdated') == ['auto-registration']
            and current_manifest.get('fixedRegistrationRelease', {}).get('id') == REGISTRATION_EMAIL_OBSERVATION_ID
            and current_manifest['fixedRegistrationRelease'].get('registrationSourceCommit') == REGISTRATION_EMAIL_OBSERVATION_SOURCE
            and current_manifest['fixedRegistrationRelease'].get('workerProjectionSha256') == REGISTRATION_EMAIL_OBSERVATION_PROJECTION_SHA256, message)
    require((BASE / 'current').resolve() == pointer and {name: service_state(pointer, name,
        include_container_id=True, include_environment_hash=True) for name in ALL_SERVICES} == live, message)
    require(all(fixed_recharge_bytes(path, **options) == raw for path, (raw, options) in observed.items()), message)
    require_main80_recharge_public_snapshot(native); require_main80_recharge_public_snapshot(public)
    registration_observation_pro_profile(previous)
    return manifest, origin


def registration_runtime_baseline(previous, states=None, *, profile_id=REGISTRATION_SCOPE_ID):
    if profile_id == REGISTRATION_PROFILE_OBSERVATION_ID:
        return registration_profile_observation_baseline(previous, states)
    if profile_id == REGISTRATION_HYDRATION_ID:
        return registration_hydration_baseline(previous, states)
    contract = registration_contract(profile_id)
    if profile_id == REGISTRATION_EMAIL_OBSERVATION_ID and REGISTRATION_EMAIL_OBSERVATION_PRO_BASELINE is not None:
        return registration_observation_pro_baseline(previous, states)
    if contract['runtimeBaseline'] is None:
        return registration_baseline(previous, states)
    fixed = contract['runtimeBaseline']
    require(previous.resolve() == previous and previous.parent == BASE / 'releases'
        and str(previous) == fixed['current'], 'Fixed registration continuation baseline changed')
    for name, digest in fixed['fileSha256'].items():
        raw = (private_maintenance_receipt(previous / name) if name.endswith('-audit.json')
            or name == 'release-manifest.json' else fixed_recharge_bytes(previous / name)
            if name == '.env.aws.production' else fixed_recharge_bytes(previous / name,
                modes=(0o400, 0o600, 0o644, 0o664), limit=128 * 1024))
        require(hashlib.sha256(raw).hexdigest() == digest,
            'Fixed registration continuation baseline changed')
    manifest = fixed_recharge_json(private_maintenance_receipt(previous / 'release-manifest.json'))
    require({key: manifest.get(key) for key in fixed['manifest']} == fixed['manifest'],
        'Fixed registration continuation manifest changed')
    predecessor_id = (REGISTRATION_EMAIL_REQUEST_ID if profile_id == REGISTRATION_EMAIL_OBSERVATION_ID else
        REGISTRATION_CALLBACK_ID if profile_id == REGISTRATION_EMAIL_REQUEST_ID else
        REGISTRATION_EMAIL_ID if profile_id == REGISTRATION_CALLBACK_ID else
        REGISTRATION_INITIAL_ID if profile_id == REGISTRATION_EMAIL_ID else
        REGISTRATION_CONTINUATION_ID if profile_id == REGISTRATION_INITIAL_ID else REGISTRATION_SCOPE_ID)
    predecessor = registration_contract(predecessor_id)
    original, origin = (registration_runtime_baseline(Path(manifest['previousRelease']), profile_id=predecessor_id)
        if profile_id in (REGISTRATION_INITIAL_ID, REGISTRATION_EMAIL_ID, REGISTRATION_CALLBACK_ID, REGISTRATION_EMAIL_REQUEST_ID, REGISTRATION_EMAIL_OBSERVATION_ID) else registration_baseline(Path(manifest['previousRelease'])))
    require(manifest['previousCommit'] == predecessor['current']
        and manifest['commit'] == contract['current']
        and manifest['servicesUpdated'] == ['auto-registration'] and manifest['migrationApplied'] is False
        and manifest['newMigrations'] == []
        and manifest['databaseGrants'] == {'status': 'SKIPPED', 'reason': 'FIXED_REGISTRATION_NO_MIGRATIONS'}
        and all(manifest['images'][name] == original['images'][name]
            for name in original['images'] if name != 'auto-registration'),
        'Fixed registration continuation provenance changed')
    old_raw = fixed_recharge_bytes(previous / predecessor['file'], modes=(0o644, 0o664), limit=128 * 1024)
    old_profile = registration_profile(fixed_recharge_json(old_raw), profile_id=predecessor_id)
    if profile_id == REGISTRATION_INITIAL_ID:
        original_raw = fixed_recharge_bytes(previous / REGISTRATION_SCOPE_FILE, modes=(0o644, 0o664), limit=128 * 1024)
        require(hashlib.sha256(original_raw).hexdigest()
            == REGISTRATION_CONTINUATION_BASELINE['fileSha256'][REGISTRATION_SCOPE_FILE],
            'Fixed registration original profile changed')
    if profile_id == REGISTRATION_EMAIL_ID:
        for name in (REGISTRATION_SCOPE_FILE, REGISTRATION_CONTINUATION_FILE, REGISTRATION_INITIAL_FILE):
            raw = fixed_recharge_bytes(previous / name, modes=(0o644, 0o664), limit=128 * 1024)
            require(hashlib.sha256(raw).hexdigest() == fixed['fileSha256'][name],
                'Fixed registration original profile changed')
    if profile_id == REGISTRATION_CALLBACK_ID:
        for name in (REGISTRATION_SCOPE_FILE, REGISTRATION_CONTINUATION_FILE, REGISTRATION_INITIAL_FILE, REGISTRATION_EMAIL_FILE):
            raw = fixed_recharge_bytes(previous / name, modes=(0o644, 0o664), limit=128 * 1024)
            require(hashlib.sha256(raw).hexdigest() == fixed['fileSha256'][name],
                'Fixed registration original profile changed')
    if profile_id == REGISTRATION_EMAIL_REQUEST_ID:
        for name in (REGISTRATION_SCOPE_FILE, REGISTRATION_CONTINUATION_FILE, REGISTRATION_INITIAL_FILE, REGISTRATION_EMAIL_FILE, REGISTRATION_CALLBACK_FILE):
            raw = fixed_recharge_bytes(previous / name, modes=(0o644, 0o664), limit=128 * 1024)
            require(hashlib.sha256(raw).hexdigest() == fixed['fileSha256'][name],
                'Fixed registration original profile changed')
    if profile_id == REGISTRATION_EMAIL_OBSERVATION_ID:
        for name in (REGISTRATION_SCOPE_FILE, REGISTRATION_CONTINUATION_FILE, REGISTRATION_INITIAL_FILE, REGISTRATION_EMAIL_FILE, REGISTRATION_CALLBACK_FILE, REGISTRATION_EMAIL_REQUEST_FILE):
            raw = fixed_recharge_bytes(previous / name, modes=(0o644, 0o664), limit=128 * 1024)
            require(hashlib.sha256(raw).hexdigest() == fixed['fileSha256'][name],
                'Fixed registration original profile changed')
    reviewed = {name: (fixed_recharge_bytes(previous / name,
        modes=(0o644, 0o664, 0o755, 0o775)), '100644')
        for name in old_profile['registrationSourceSha256'].keys() | old_profile['controlSourceSha256'].keys()}
    registration_source(old_profile, reviewed)
    require(manifest['fixedRegistrationRelease'] == {
        'id': predecessor_id, 'profileRawSha256': hashlib.sha256(old_raw).hexdigest(),
        'registrationSourceCommit': predecessor['source'], 'workerBasisCommit': RECHARGE_SCOPE_CURRENT,
        'workerProjectionSha256': predecessor['projectionSha256'], 'financeSourceCommit': REGISTRATION_CURRENT,
        'financePolicyId': HISTORY_ORDER_ARCHIVE_POLICY_ID, 'financeMode': REGISTRATION_CLEARANCE['mode'],
        'clearanceSealSha256': historical_fingerprint(REGISTRATION_CLEARANCE),
        'environmentUnchanged': True, 'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED',
        'cacheStatus': 'SKIPPED'}, 'Fixed registration continuation provenance changed')
    override = fixed_recharge_json((previous / 'compose.release.json').read_bytes())
    require(historical_fingerprint(override) == fixed['overrideCanonicalSha256']
        and override == {'services': {name: {'image': manifest['images'][name]['reference'], 'pull_policy': 'never'}
            for name in (*SERVICES, 'migrate')}}, 'Fixed registration continuation configuration changed')
    frozen = fixed_recharge_json(private_maintenance_receipt(origin / 'before-audit.json'))['gate']
    facts = []
    for stage in ('before', 'after'):
        report = fixed_recharge_json(private_maintenance_receipt(previous / (stage + '-audit.json')))
        summary = require_registration_zero_report(report, stage, frozen)
        measured = {'checkCount': report['checkCount'], 'violationCount': report['violationCount'],
            'checksSha256': historical_fingerprint(report['checks']), 'gateSha256': historical_fingerprint(report['gate']),
            'identitySha256': historical_fingerprint(report['identity'])}
        require(summary == manifest['dataAudit' + stage.title()] and measured == fixed['audits'][stage],
            'Fixed registration continuation audit changed')
        facts.append((report['checks'], report['identity']))
    require(facts[0] == facts[1], 'Fixed registration continuation audit changed')
    saved = manifest['fixedRegistrationPreservedStates']
    require(set(saved) == {'before', 'after'} and saved['before'] == saved['after']
        == registration_preserved_states(fixed['liveServices']),
        'Fixed registration continuation preserved service changed')
    if states is not None:
        require(states == fixed['liveServices'], 'Fixed registration continuation running baseline changed')
        registration_worker_hashes(previous, old_profile)
    return manifest, origin


def prepare_registration_finance_source(args, raw):
    require(hashlib.sha256(raw).hexdigest() == REGISTRATION_BASELINE['sourceArchiveSha256'],
            'Fixed registration finance archive changed')
    files = registration_archive(raw, REGISTRATION_CURRENT)
    root = BASE / '.staging' / ('oidc-' + args.commit)
    require(root.resolve() == root, 'Fixed registration finance source changed')
    root.mkdir(parents=True, exist_ok=True)
    target = root / ('fixed-80-finance-' + args.run_id + '-' + args.run_attempt)
    write_registration_files(target, files)
    require_registration_finance_source(target)
    return target


def require_registration_finance_source(source):
    raw = fixed_recharge_bytes(source / 'deploy/aws/historical-finance-20261005-order-archive.json',
                              modes=(0o644, 0o664))
    policy = fixed_recharge_json(raw)
    require(hashlib.sha256(raw).hexdigest() == REGISTRATION_FINANCE['policyRawSha256']
        and historical_fingerprint(policy) == REGISTRATION_FINANCE['policyCanonicalSha256']
        and historical_fingerprint(policy.get('exceptions')) == REGISTRATION_FINANCE['exceptionsSha256']
        and policy.get('rulesSha256') == REGISTRATION_FINANCE['rulesSha256']
        and policy.get('metadataSha256') == REGISTRATION_FINANCE['metadataSha256'],
        'Fixed registration finance policy changed')
    require_order_archive_source_scope(source, policy)


def registration_zero_gate(stage, frozen):
    require(stage in ('before', 'after'), 'Fixed registration audit stage changed')
    keys = ('releaseSealSha256', 'candidateCommit', 'candidateTree', 'sourceTree', 'images', 'migration',
            'preparedImagesSha256', 'preparationRunId', 'preparationRunAttempt')
    return {**{name: frozen[name] for name in keys}, 'accepted': True,
        'status': REGISTRATION_CLEARANCE['mode'], 'stage': stage, 'checkCount': 49,
        'executedCheckCount': 49, 'unavailableCheckCount': 0, 'violationCount': 0,
        'sourceCommit': REGISTRATION_CLEARANCE['sourceCommit'], 'sourcePolicyId': REGISTRATION_FINANCE['policyId'],
        'clearanceSealSha256': historical_fingerprint(REGISTRATION_CLEARANCE),
        **{name: REGISTRATION_CLEARANCE[name] for name in ('rulesSha256', 'checksSha256', 'sources',
            'metadataSha256', 'reversalCount', 'reversalAuditSha256', 'reversalChainSha256')},
        'scope': {'targetOrdersCount': 0, 'protectedThirdOrderCount': 1}}


def require_registration_zero_report(report, stage, frozen):
    gate = registration_zero_gate(stage, frozen)
    identity = report.get('identity', {})
    require(isinstance(identity, dict) and set(identity) == {'currentUser', 'databaseName', 'transactionIsolation',
        'foreignKeyChecks', 'readOnly', 'superReadOnly', 'sessionReadOnly'}
        and re.fullmatch(r'id_business_audit@[^\r\n]{1,255}', identity.get('currentUser', ''))
        and identity.get('databaseName') == MAINTENANCE_DATABASE
        and identity.get('transactionIsolation') == 'REPEATABLE-READ'
        and str(identity.get('foreignKeyChecks')) == str(identity.get('sessionReadOnly')) == '1'
        and str(identity.get('readOnly')) == str(identity.get('superReadOnly')) == '0',
        'Fixed registration approved reversal audit identity changed')
    require(set(report) == {'ok', 'checkCount', 'violationCount', 'failedChecks', 'identity', 'checks', 'gate', 'generatedAt'}
        and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,20}Z', report.get('generatedAt', '')) is not None
        and report.get('ok') is True and type(report.get('checkCount')) is int and report['checkCount'] == 49
        and type(report.get('violationCount')) is int and report['violationCount'] == 0
        and report.get('failedChecks') == []
        and historical_fingerprint(report.get('gate')) == historical_fingerprint(gate)
        and historical_fingerprint(report.get('checks')) == REGISTRATION_CLEARANCE['checksSha256'],
        'Fixed registration approved reversal integrity gate changed')
    return {'checkCount': 49, 'violationCount': 0, 'registrationFinanceGate': gate}


def registration_finance_audit(directory, receipt, *, stage, source, before_receipt=None, control_source=None, profile_id=REGISTRATION_SCOPE_ID):
    contract = registration_contract(profile_id)
    require(stage in ('before', 'after'), 'Fixed registration audit stage changed')
    require_registration_finance_source(source)
    policy, seal = reviewed_order_archive_seal(source, REGISTRATION_FINANCE['releaseSealSha256'],
        REGISTRATION_CURRENT, REGISTRATION_BASELINE['sourceTree'], REGISTRATION_FINANCE['preparedImagesSha256'],
        str(REGISTRATION_FINANCE['preparationRunId']), str(REGISTRATION_FINANCE['preparationRunAttempt']))
    frozen = {**REGISTRATION_FINANCE, 'sourceTree': policy['candidateBindings']['sourceTree'],
        'candidateCommit': REGISTRATION_CURRENT, 'candidateTree': REGISTRATION_BASELINE['sourceTree'],
        'images': seal['images'], 'migration': seal['migration']}
    control_source = control_source or Path(__file__).resolve().parents[2]
    profile_raw = fixed_recharge_bytes(control_source / contract['file'], modes=(0o644, 0o664), limit=128 * 1024)
    profile = registration_profile(fixed_recharge_json(profile_raw), profile_id=profile_id)
    auditor = control_source / 'scripts/v2-registration-finance-audit.mjs'
    require(hashlib.sha256(fixed_recharge_bytes(auditor, modes=(0o644, 0o664))).hexdigest()
        == profile['controlSourceSha256']['scripts/v2-registration-finance-audit.mjs'],
        'Fixed registration reviewed source changed')
    override = fixed_recharge_json((directory / 'compose.release.json').read_bytes())
    image = json.loads(run('docker', 'image', 'inspect', override['services']['api']['image']))[0]
    require(image['Id'] == seal['images']['api'], 'Order archive audit image changed')
    env = os.environ.copy(); env['V2_DATA_INTEGRITY_DATABASE_URL'] = maintenance_container_audit_url(
        environment_values(directory / '.env.aws.production'))
    identity = historical_audit_reader(directory, 'api')
    seal_reader = prepare_post_cleanup_reader_copy(directory, ORDER_ARCHIVE_SEAL,
        REGISTRATION_FINANCE['releaseSealSha256'], 'order-archive-seal.reader.json', identity)
    cleanup_reader = prepare_post_cleanup_reader_copy(directory, POST_CLEANUP_RECEIPT,
        HISTORY_POST_CLEANUP_RECEIPT_SHA256, 'order-archive-cleanup.reader.json', identity)
    mounts = ['-v', f'{source / "scripts"}:/app/scripts:ro', '-v', f'{source / "deploy/aws"}:/release-policy:ro',
        '-v', f'{auditor}:/registration-control/audit.mjs:ro',
        '-v', f'{control_source / contract["file"]}:/registration-control/profile.json:ro',
        '-v', f'{seal_reader}:/release-order-archive-seal.json:ro',
        '-v', f'{cleanup_reader}:/release-cleanup-receipt.json:ro']
    arguments = ['node', '/registration-control/audit.mjs', '--profile=/registration-control/profile.json',
        f'--policy=/release-policy/{HISTORY_ORDER_ARCHIVE_POLICY_ID}.json', f'--stage={stage}',
        '--seal=/release-order-archive-seal.json', '--cleanup-receipt=/release-cleanup-receipt.json']
    if stage == 'after':
        require(before_receipt is not None, 'Fixed registration before audit missing')
        require_registration_zero_report(fixed_recharge_json(private_maintenance_receipt(before_receipt)), 'before', frozen)
        prepare_historical_before_receipt(directory, before_receipt, 'api')
        mounts.extend(['-v', f'{before_receipt}:/release-before-audit.json:ro'])
        arguments.append('--before-receipt=/release-before-audit.json')
    else:
        require(before_receipt is None, 'Fixed registration audit stage changed')
    report = fixed_recharge_json(compose(directory, 'run', '--rm', '--no-deps', '--pull', 'never',
        *mounts, '-e', 'V2_DATA_INTEGRITY_DATABASE_URL', 'api', *arguments, env=env, timeout=240).encode())
    summary = require_registration_zero_report(report, stage, frozen)
    if stage == 'after':
        before = fixed_recharge_json(private_maintenance_receipt(before_receipt))
        require(before['checks'] == report['checks'] and before['identity'] == report['identity'],
                'Fixed registration integrity facts changed')
    receipt.write_text(json.dumps(report, indent=2) + '\n'); receipt.chmod(0o600)
    return summary


def registration_worker_basis(profile_id):
    return (registration_contract(profile_id)['current'] if profile_id in
        (REGISTRATION_HYDRATION_ID, REGISTRATION_PROFILE_OBSERVATION_ID) else RECHARGE_SCOPE_CURRENT)


def registration_profile_observation_profile(value):
    """A new Worker-only lane remains unavailable until its exact two-file source is frozen."""
    contract = registration_contract(REGISTRATION_PROFILE_OBSERVATION_ID)
    digest = lambda x: isinstance(x, str) and re.fullmatch(r'[a-f0-9]{64}', x) is not None
    keys = {'version', 'kind', 'id', 'enabled', 'expectedCurrent', 'baselineRelease',
        'registrationSourceCommit', 'workerBasisCommit', 'registrationSourceSha256',
        'workerProjection', 'workerProjectionSha256', 'buildInputSha256', 'controlSourceSha256',
        'scope', 'financeValidator', 'financeClearance', 'runtimeBaseline'}
    require(isinstance(value, dict) and set(value) == keys and type(value['version']) is int
        and value['version'] == 1 and value['enabled'] is True
        and value['kind'] == 'FIXED_REGISTRATION_RUNTIME_SCOPE' and value['id'] == contract['id']
        and value['expectedCurrent'] == contract['current']
        and isinstance(contract['source'], str) and re.fullmatch(r'[a-f0-9]{40}', contract['source'])
        and value['registrationSourceCommit'] == contract['source']
        and value['workerBasisCommit'] == contract['current']
        and value['baselineRelease'] == REGISTRATION_BASELINE and value['runtimeBaseline'] == contract['runtimeBaseline']
        and value['scope'] == REGISTRATION_SCOPE and value['financeValidator'] == REGISTRATION_FINANCE
        and value['financeClearance'] == REGISTRATION_CLEARANCE, 'Fixed profile observation scope unavailable')
    delta = REGISTRATION_PROFILE_OBSERVATION_WORKER_DELTA_SHA256
    require(isinstance(delta, dict) and set(delta) == {REGISTRATION_WORKER_PREFIX + name
        for name in ('registration_browser.py', 'test_registration_browser.py')}
        and all(digest(x) for x in delta.values()), 'Fixed profile observation source unavailable')
    sources = value['registrationSourceSha256']
    require(isinstance(sources, dict) and sources == contract['sourceSha256']
        and set(sources) == REGISTRATION_EMAIL_FILES | {'docs/AUTO_REGISTRATION.md'}
        and all(digest(x) for x in sources.values()) and all(sources[name] == x for name, x in delta.items())
        and value['buildInputSha256'] == {
            '.dockerignore': '9f69c1f476e723f1d8de9892058c34abc3817481b6d8259da4175c3f6293c05d',
            'scripts/audit-python-dependencies.py': '99b90a53943699d44c3fca8642db0ef7917ce618d2f3e09a4e30f31c127ee41c'}
        and isinstance(value['controlSourceSha256'], dict)
        and set(value['controlSourceSha256']) == REGISTRATION_CONTROLS
        and all(digest(x) for x in value['controlSourceSha256'].values()), 'Fixed profile observation reviewed source changed')
    projection = value['workerProjection']
    require(isinstance(projection, dict) and len(projection) == 60
        and all(isinstance(name, str) and name.startswith(REGISTRATION_WORKER_PREFIX)
            and '..' not in Path(name).parts and isinstance(row, dict)
            and set(row) == {'mode', 'sha256'} and row['mode'] in ('100644', '100755')
            and digest(row['sha256']) for name, row in projection.items())
        and digest(contract['projectionSha256'])
        and value['workerProjectionSha256'] == contract['projectionSha256'] == historical_fingerprint(projection)
        and all(projection[name]['sha256'] == sources[name] for name in REGISTRATION_EMAIL_FILES),
        'Fixed profile observation projection changed')
    return value


def registration_profile_observation_old_profile(directory):
    fixed = REGISTRATION_PROFILE_OBSERVATION_BASELINE
    raw = fixed_recharge_bytes(directory / REGISTRATION_HYDRATION_FILE, modes=(0o644,), limit=128 * 1024)
    require(hashlib.sha256(raw).hexdigest() == fixed['profileSha256']
        == fixed['fileSha256'][REGISTRATION_HYDRATION_FILE], 'Fixed profile observation predecessor profile changed')
    return raw, registration_profile(fixed_recharge_json(raw), profile_id=REGISTRATION_HYDRATION_ID)


def registration_profile_observation_worker_projection(profile, basis, candidate):
    registration_source(profile, candidate)
    previous_raw = registration_download(REGISTRATION_PROFILE_OBSERVATION_CURRENT)
    require(hashlib.sha256(previous_raw).hexdigest()
        == REGISTRATION_PROFILE_OBSERVATION_BASELINE['manifest']['sourceArchiveSha256'],
        'Fixed profile observation predecessor archive changed')
    previous = registration_archive(previous_raw, REGISTRATION_PROFILE_OBSERVATION_CURRENT)
    raw = previous[REGISTRATION_HYDRATION_FILE][0]
    require(hashlib.sha256(raw).hexdigest() == REGISTRATION_PROFILE_OBSERVATION_BASELINE['profileSha256'],
        'Fixed profile observation predecessor profile changed')
    old_profile = registration_profile(fixed_recharge_json(raw), profile_id=REGISTRATION_HYDRATION_ID)
    result = registration_worker_projection(old_profile, basis, previous)
    old = {name: row for name, row in result.items() if name.startswith(REGISTRATION_WORKER_PREFIX)}
    delta = REGISTRATION_PROFILE_OBSERVATION_WORKER_DELTA_SHA256
    require(set(delta) <= set(old), 'Fixed profile observation Worker file set changed')
    result.update({name: candidate[name] for name in delta})
    actual = {name: {'mode': mode, 'sha256': hashlib.sha256(data).hexdigest()}
        for name, (data, mode) in result.items() if name.startswith(REGISTRATION_WORKER_PREFIX)}
    require(actual == profile['workerProjection'] and len(actual) == 60
        and {name for name in old if old[name] != result[name]} == set(delta)
        and all(result[name] == old[name] for name in old if name not in delta),
        'Fixed profile observation Worker projection changed')
    return result


def registration_profile_observation_carry(previous, candidate, runtime):
    """Carry eight historical profiles, the preserved Admin source and the private Pro proof."""
    _raw, old = registration_profile_observation_old_profile(previous)
    names = {name: digest for name, digest in REGISTRATION_PROFILE_OBSERVATION_BASELINE['fileSha256'].items()
        if name.startswith('deploy/aws/registration-worker-')}
    require(len(names) == 8, 'Fixed profile observation historical profile set changed')
    for name, digest in {**names, **old['adminSourceSha256']}.items():
        raw = fixed_recharge_bytes(previous / name, modes=(0o644,), limit=128 * 1024)
        require(hashlib.sha256(raw).hexdigest() == digest and candidate.get(name) == (raw, '100644'),
            'Fixed profile observation preserved source changed')
        runtime[name] = (raw, '100644')
    runtime[RECHARGE_MAIN80_FILE] = (registration_observation_pro_profile(previous), '100644')


def registration_profile_observation_carried(directory):
    """The new runtime keeps historical profiles and Admin source private to its preserved proof."""
    _raw, old = registration_profile_observation_old_profile(directory)
    names = {name: digest for name, digest in REGISTRATION_PROFILE_OBSERVATION_BASELINE['fileSha256'].items()
        if name.startswith('deploy/aws/registration-worker-')}
    require(len(names) == 8, 'Fixed profile observation historical profile set changed')
    for name, digest in {**names, **old['adminSourceSha256']}.items():
        raw = fixed_recharge_bytes(directory / name, modes=(0o644,), limit=128 * 1024)
        require(hashlib.sha256(raw).hexdigest() == digest, 'Fixed profile observation carried source changed')
    registration_observation_pro_profile(directory)


def registration_profile_observation_history(previous):
    """Validate actual 90 and its sealed dual-service ancestry without old live Worker checks."""
    fixed = REGISTRATION_PROFILE_OBSERVATION_BASELINE
    message = 'Fixed profile observation predecessor history changed'
    require(set(fixed) == {'status', 'current', 'controllerSha256', 'profileSha256', 'manifest',
        'fileSha256', 'overrideCanonicalSha256', 'audits', 'liveServices', 'readback',
        'actualWorkerSourceSha256', 'original80SealMatched', 'databaseWrites', 'windowRestarted'}
        and fixed['status'] == 'VERIFIED_90_RUNTIME_BASELINE' and fixed['original80SealMatched'] is True
        and type(fixed['databaseWrites']) is int and fixed['databaseWrites'] == 0 and fixed['windowRestarted'] is False
        and previous.is_absolute() and previous.resolve() == previous and previous.parent == BASE / 'releases'
        and str(previous) == fixed['current'] and fixed['manifest']['commit'] == REGISTRATION_PROFILE_OBSERVATION_CURRENT,
        message)
    observed = {}
    def read(path, **options):
        raw = fixed_recharge_bytes(path, **options)
        require(path not in observed or observed[path][0] == raw, message)
        observed[path] = (raw, options)
        return raw
    for name, digest in fixed['fileSha256'].items():
        modes = (0o400, 0o600) if name in ('.env.aws.production', 'release-manifest.json', 'before-audit.json', 'after-audit.json') else (0o400, 0o600, 0o644, 0o664)
        require(hashlib.sha256(read(previous / name, modes=modes, limit=128 * 1024)).hexdigest() == digest, message)
    require(hashlib.sha256(read(previous / 'scripts/production-release/remote-deploy.py', modes=(0o644, 0o664))).hexdigest()
        == fixed['controllerSha256'], message)
    raw, profile = registration_profile_observation_old_profile(previous)
    pro_raw = registration_observation_pro_profile(previous)
    require(read(previous / RECHARGE_MAIN80_FILE, modes=(0o644,), limit=128 * 1024) == pro_raw, message)
    manifest = fixed_recharge_json(read(previous / 'release-manifest.json', modes=(0o400, 0o600)))
    require({key: manifest.get(key) for key in fixed['manifest']} == fixed['manifest']
        and manifest['servicesUpdated'] == ['admin', 'auto-registration'] and manifest['migrationApplied'] is False
        and manifest['newMigrations'] == []
        and manifest['databaseGrants'] == {'status': 'SKIPPED', 'reason': 'FIXED_REGISTRATION_NO_MIGRATIONS'}, message)
    original, origin = registration_hydration_history(Path(manifest['previousRelease']))
    require(manifest['previousCommit'] == REGISTRATION_HYDRATION_CURRENT
        and all(manifest['images'][name] == original['images'][name]
            for name in original['images'] if name not in ('admin', 'auto-registration')), message)
    require(manifest['fixedRegistrationRelease'] == fixed['manifest']['fixedRegistrationRelease']
        and manifest['fixedRegistrationRelease']['adminProjectionSha256'] == profile['adminProjectionSha256']
        and manifest['fixedRegistrationRelease']['adminSourceCommit'] == profile['adminSourceCommit']
        and manifest['fixedRegistrationRelease']['workerProjectionSha256'] == profile['workerProjectionSha256']
        and manifest['fixedRegistrationRelease']['registrationSourceCommit'] == profile['registrationSourceCommit'], message)
    reviewed = {name: (read(previous / name, modes=(0o644, 0o664, 0o755, 0o775)), '100644')
        for name in profile['registrationSourceSha256'].keys() | profile['controlSourceSha256'].keys()}
    registration_source(profile, reviewed)
    for name, row in profile['workerProjection'].items():
        path = previous / name
        require(hashlib.sha256(read(path, modes=(0o644, 0o664, 0o755, 0o775))).hexdigest() == row['sha256']
            and ('100755' if path.stat().st_mode & 0o111 else '100644') == row['mode'], message)
    require(fixed['actualWorkerSourceSha256'] == {name: profile['workerProjection'][REGISTRATION_WORKER_PREFIX + name]['sha256']
        for name in ('browser_password_login.py', 'registration_browser.py', 'registration_builtin.py', 'registration_job.py')}, message)
    validate_fixed_registration_readback_projection(fixed['readback'], REGISTRATION_PROFILE_OBSERVATION_CURRENT,
        manifest['sourceTree'], hashlib.sha256(raw).hexdigest(), profile_id=REGISTRATION_HYDRATION_ID)
    override = fixed_recharge_json(read(previous / 'compose.release.json', modes=(0o400, 0o600, 0o644)))
    require(historical_fingerprint(override) == fixed['overrideCanonicalSha256']
        and override == {'services': {name: {'image': manifest['images'][name]['reference'], 'pull_policy': 'never'}
            for name in (*SERVICES, 'migrate')}}, message)
    frozen = fixed_recharge_json(read(origin / 'before-audit.json', modes=(0o400, 0o600)))['gate']
    facts = []
    for stage in ('before', 'after'):
        report = fixed_recharge_json(read(previous / (stage + '-audit.json'), modes=(0o400, 0o600)))
        summary = require_registration_zero_report(report, stage, frozen)
        measured = {'checkCount': report['checkCount'], 'violationCount': report['violationCount'],
            'checksSha256': historical_fingerprint(report['checks']), 'gateSha256': historical_fingerprint(report['gate']),
            'identitySha256': historical_fingerprint(report['identity'])}
        require(summary == manifest['dataAudit' + stage.title()] and measured == fixed['audits'][stage], message)
        facts.append((report['checks'], report['identity']))
    require(facts[0] == facts[1] and manifest['fixedRegistrationPreservedStates'] == {
        'before': registration_hydration_preserved_states(fixed['liveServices']),
        'after': registration_hydration_preserved_states(fixed['liveServices'])}, message)
    registration_observation_pro_profile(previous)
    require(all(fixed_recharge_bytes(path, **options) == data for path, (data, options) in observed.items()), message)
    return manifest, origin


def registration_profile_observation_baseline(previous, states=None):
    """Keep live Admin 90 and five other services fixed while 90 Worker metadata becomes historical."""
    message = 'Fixed profile observation running baseline changed'
    current_raw = None
    pointer = (BASE / 'current').resolve()
    live = {name: service_state(pointer, name, include_container_id=True, include_environment_hash=True)
        for name in ALL_SERVICES}
    manifest, origin = registration_profile_observation_history(previous)
    fixed = REGISTRATION_PROFILE_OBSERVATION_BASELINE
    require(all(row['status'] == 'running' for row in live.values())
        and all(live[name]['health'] == 'healthy' for name in ALL_SERVICES if name != 'caddy')
        and registration_preserved_states(live) == registration_preserved_states(fixed['liveServices']), message)
    if states is not None:
        require(pointer == previous and states == live == fixed['liveServices'], message)
        registration_worker_hashes(previous, registration_profile_observation_old_profile(previous)[1])
    elif pointer != previous:
        current_raw = fixed_recharge_bytes(pointer / 'release-manifest.json', modes=(0o600,))
        current = fixed_recharge_json(current_raw)
        require(current.get('previousRelease') == str(previous)
            and current.get('previousCommit') == REGISTRATION_PROFILE_OBSERVATION_CURRENT
            and current.get('servicesUpdated') == ['auto-registration']
            and current.get('fixedRegistrationRelease', {}).get('id') == REGISTRATION_PROFILE_OBSERVATION_ID, message)
        require(fixed_recharge_bytes(pointer / 'release-manifest.json', modes=(0o600,)) == current_raw, message)
    else:
        require(live == fixed['liveServices'], message)
    old = registration_profile_observation_old_profile(previous)[1]
    metadata = json.loads(run('docker', 'image', 'inspect', live['admin']['image']))[0]
    require(metadata['Id'] == fixed['liveServices']['admin']['image'] and metadata['Architecture'] == 'amd64'
        and metadata['Config']['Labels'].get('org.opencontainers.image.revision') == REGISTRATION_PROFILE_OBSERVATION_CURRENT
        and metadata['Config']['Labels'].get('id-business-v2.admin-projection-sha256') == old['adminProjectionSha256'], message)
    require(registration_profile_observation_history(previous) == (manifest, origin), message)
    require((BASE / 'current').resolve() == pointer and {name: service_state(pointer, name,
        include_container_id=True, include_environment_hash=True) for name in ALL_SERVICES} == live, message)
    if current_raw is not None:
        require(fixed_recharge_bytes(pointer / 'release-manifest.json', modes=(0o600,)) == current_raw, message)
    return manifest, origin


def registration_hydration_profile(value):
    """The dual-service lane has no effect while any reviewed source pin is missing."""
    contract = registration_contract(REGISTRATION_HYDRATION_ID)
    digest = lambda x: isinstance(x, str) and re.fullmatch(r'[a-f0-9]{64}', x) is not None
    commit = lambda x: isinstance(x, str) and re.fullmatch(r'[a-f0-9]{40}', x) is not None
    keys = {'version', 'kind', 'id', 'enabled', 'expectedCurrent', 'baselineRelease',
        'registrationSourceCommit', 'workerBasisCommit', 'registrationSourceSha256',
        'workerProjection', 'workerProjectionSha256', 'buildInputSha256', 'controlSourceSha256',
        'scope', 'financeValidator', 'financeClearance', 'runtimeBaseline',
        'adminSourceCommit', 'adminSourceSha256', 'adminProjectionSha256'}
    require(isinstance(value, dict) and set(value) == keys and type(value['version']) is int
        and value['version'] == 1 and value['enabled'] is True
        and value['kind'] == 'FIXED_REGISTRATION_RUNTIME_SCOPE' and value['id'] == contract['id']
        and value['expectedCurrent'] == contract['current'] and commit(contract['source'])
        and value['registrationSourceCommit'] == contract['source']
        and value['workerBasisCommit'] == contract['current']
        and value['baselineRelease'] == REGISTRATION_BASELINE
        and value['runtimeBaseline'] == contract['runtimeBaseline']
        and value['scope'] == REGISTRATION_HYDRATION_SCOPE
        and value['financeValidator'] == REGISTRATION_FINANCE
        and value['financeClearance'] == REGISTRATION_CLEARANCE,
        'Fixed hydration scope unavailable')
    delta, admin = REGISTRATION_HYDRATION_WORKER_DELTA_SHA256, REGISTRATION_HYDRATION_ADMIN_SOURCE_SHA256
    require(isinstance(delta, dict) and len(delta) == 3
        and all(name.startswith(REGISTRATION_WORKER_PREFIX) and name.endswith('.py')
            and '..' not in Path(name).parts and digest(x) for name, x in delta.items())
        and isinstance(admin, dict) and set(admin) == REGISTRATION_HYDRATION_ADMIN_FILES
        and all(digest(x) for x in admin.values())
        and commit(REGISTRATION_HYDRATION_ADMIN_SOURCE)
        and value['adminSourceCommit'] == REGISTRATION_HYDRATION_ADMIN_SOURCE == contract['source']
        and value['adminSourceSha256'] == admin
        and digest(REGISTRATION_HYDRATION_ADMIN_PROJECTION_SHA256)
        and value['adminProjectionSha256'] == REGISTRATION_HYDRATION_ADMIN_PROJECTION_SHA256,
        'Fixed hydration source unavailable')
    sources = value['registrationSourceSha256']
    require(isinstance(sources, dict) and sources == contract['sourceSha256']
        and set(sources) == REGISTRATION_EMAIL_FILES | {'docs/AUTO_REGISTRATION.md'} | set(delta) | set(admin)
        and all(digest(x) for x in sources.values())
        and all(sources[name] == x for name, x in {**delta, **admin}.items())
        and value['buildInputSha256'] == {
            '.dockerignore': '9f69c1f476e723f1d8de9892058c34abc3817481b6d8259da4175c3f6293c05d',
            'scripts/audit-python-dependencies.py': '99b90a53943699d44c3fca8642db0ef7917ce618d2f3e09a4e30f31c127ee41c'}
        and isinstance(value['controlSourceSha256'], dict)
        and set(value['controlSourceSha256']) == REGISTRATION_CONTROLS
        and all(digest(x) for x in value['controlSourceSha256'].values()),
        'Fixed hydration reviewed source changed')
    projection = value['workerProjection']
    require(isinstance(projection, dict) and len(projection) == 60
        and all(isinstance(name, str) and name.startswith(REGISTRATION_WORKER_PREFIX)
            and '..' not in Path(name).parts and isinstance(row, dict)
            and set(row) == {'mode', 'sha256'} and row['mode'] in ('100644', '100755')
            and digest(row['sha256']) for name, row in projection.items())
        and digest(contract['projectionSha256'])
        and value['workerProjectionSha256'] == contract['projectionSha256'] == historical_fingerprint(projection)
        and all(projection[name]['sha256'] == sources[name] for name in REGISTRATION_EMAIL_FILES | set(delta)),
        'Fixed hydration projection changed')
    return value


def registration_hydration_old_profile(directory):
    fixed = REGISTRATION_HYDRATION_BASELINE
    raw = fixed_recharge_bytes(directory / REGISTRATION_EMAIL_OBSERVATION_FILE, modes=(0o644,), limit=128 * 1024)
    require(hashlib.sha256(raw).hexdigest() == fixed['profileSha256']
        == fixed['fileSha256'][REGISTRATION_EMAIL_OBSERVATION_FILE], 'Fixed hydration predecessor profile changed')
    return raw, registration_profile(fixed_recharge_json(raw), profile_id=REGISTRATION_EMAIL_OBSERVATION_ID)


def registration_hydration_worker_projection(profile, basis, candidate):
    registration_source(profile, candidate)
    previous_raw = registration_download(REGISTRATION_HYDRATION_CURRENT)
    require(hashlib.sha256(previous_raw).hexdigest() == REGISTRATION_HYDRATION_BASELINE['manifest']['sourceArchiveSha256'],
        'Fixed hydration predecessor archive changed')
    previous = registration_archive(previous_raw, REGISTRATION_HYDRATION_CURRENT)
    raw = previous[REGISTRATION_EMAIL_OBSERVATION_FILE][0]
    require(hashlib.sha256(raw).hexdigest() == REGISTRATION_HYDRATION_BASELINE['profileSha256'],
        'Fixed hydration predecessor profile changed')
    old_profile = registration_profile(fixed_recharge_json(raw), profile_id=REGISTRATION_EMAIL_OBSERVATION_ID)
    result = registration_worker_projection(old_profile, basis, previous)
    delta = REGISTRATION_HYDRATION_WORKER_DELTA_SHA256
    old = {name: row for name, row in result.items() if name.startswith(REGISTRATION_WORKER_PREFIX)}
    require(set(delta) <= set(old), 'Fixed hydration Worker file set changed')
    result.update({name: candidate[name] for name in delta})
    actual = {name: {'mode': mode, 'sha256': hashlib.sha256(data).hexdigest()}
        for name, (data, mode) in result.items() if name.startswith(REGISTRATION_WORKER_PREFIX)}
    require(actual == profile['workerProjection'] and len(actual) == 60
        and {name for name in old if old[name] != result[name]} == set(delta)
        and all(result[name] == old[name] for name in old if name not in delta),
        'Fixed hydration Worker projection changed')
    return result


def registration_hydration_admin_projection(profile, original, candidate):
    """Build Admin from its original 80 inputs, with only the four reviewed UI files."""
    registration_source(profile, candidate)
    files = dict(original)
    delta = profile['adminSourceSha256']
    require(set(delta) <= set(files), 'Fixed hydration Admin file set changed')
    require(all(candidate[name] != files[name] for name in delta), 'Fixed hydration Admin delta changed')
    files.update({name: candidate[name] for name in delta})
    require(historical_fingerprint({name: {'mode': mode, 'sha256': hashlib.sha256(data).hexdigest()}
        for name, (data, mode) in files.items()}) == profile['adminProjectionSha256'],
        'Fixed hydration Admin projection changed')
    return files


def prepare_registration_hydration_build():
    root, profile = check_fixed_registration_scope(REGISTRATION_HYDRATION_ID)
    candidate = {name: (fixed_recharge_bytes(root / name, modes=(0o644, 0o664, 0o755, 0o775)),
        '100755' if (root / name).stat().st_mode & 0o111 else '100644')
        for name in profile['registrationSourceSha256'].keys() | profile['controlSourceSha256'].keys()}
    basis = registration_archive(registration_download(RECHARGE_SCOPE_CURRENT), RECHARGE_SCOPE_CURRENT)
    worker = registration_hydration_worker_projection(profile, basis, candidate)
    raw = registration_download(REGISTRATION_CURRENT)
    require(hashlib.sha256(raw).hexdigest() == REGISTRATION_BASELINE['sourceArchiveSha256'],
        'Fixed hydration Admin basis archive changed')
    admin = registration_hydration_admin_projection(profile, registration_archive(raw, REGISTRATION_CURRENT), candidate)
    output = root / '.deploy/production-release'
    require(not output.is_symlink() and not (root / '.deploy').is_symlink(), 'Fixed registration output changed')
    output.mkdir(parents=True, exist_ok=True)
    target = output / 'registration-build-projection.json'
    require(not target.exists() and not target.is_symlink(), 'Fixed registration output already exists')
    write_registration_files(output / 'registration-build-context', worker)
    write_registration_files(output / 'registration-admin-build-context', admin)
    manifest = {'version': 1, 'id': REGISTRATION_HYDRATION_ID,
        'sourceCommit': run('git', '-C', str(root), 'rev-parse', 'HEAD'),
        'sourceTree': run('git', '-C', str(root), 'rev-parse', 'HEAD^{tree}'),
        'registrationSourceCommit': profile['registrationSourceCommit'],
        'workerBasisCommit': REGISTRATION_HYDRATION_CURRENT,
        'workerProjectionSha256': profile['workerProjectionSha256'],
        'registrationSourceSha256': profile['registrationSourceSha256'],
        'contextPath': '.deploy/production-release/registration-build-context',
        'adminSourceCommit': profile['adminSourceCommit'], 'adminBasisCommit': REGISTRATION_CURRENT,
        'adminSourceSha256': profile['adminSourceSha256'], 'adminProjectionSha256': profile['adminProjectionSha256'],
        'adminContextPath': '.deploy/production-release/registration-admin-build-context'}
    target.write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def registration_hydration_pro_history(previous):
    """Read sealed D2/B91 ancestry without claiming its old containers are still live."""
    message = 'Fixed registration Pro bridge changed'
    fixed, anchor = REGISTRATION_EMAIL_OBSERVATION_PRO_BASELINE, REGISTRATION_EMAIL_OBSERVATION_B91_BASELINE
    require(isinstance(fixed, dict) and set(fixed) == {'status', 'current', 'controllerSha256', 'profileSha256',
        'manifest', 'fileSha256', 'overrideCanonicalSha256', 'audits', 'liveServices', 'readback',
        'actualWorkerSourceSha256', 'original80SealMatched', 'databaseWrites', 'windowRestarted'}
        and fixed['status'] == 'VERIFIED_PRO_AFTER_88_RUNTIME_BASELINE' and fixed['original80SealMatched'] is True
        and type(fixed['databaseWrites']) is int and fixed['databaseWrites'] == 0 and fixed['windowRestarted'] is False,
        message)
    contract = registration_contract(REGISTRATION_EMAIL_OBSERVATION_ID)
    require(contract['runtimeBaseline'] == {key: fixed[key] for key in anchor}
        and fixed['manifest']['commit'] == contract['current'] and contract['current'] != RECHARGE_MAIN80_CURRENT
        and previous.is_absolute() and previous.resolve() == previous and previous.parent == BASE / 'releases'
        and str(previous) == fixed['current'] and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + contract['current'][:12], previous.name)
        and set(fixed['fileSha256']) == set(anchor['fileSha256']) | {RECHARGE_MAIN80_FILE}, message)
    observed = {}
    def read(path, **options):
        raw = fixed_recharge_bytes(path, **options)
        require(path not in observed or observed[path][0] == raw, message)
        observed[path] = (raw, options)
        return raw
    def frozen_files(directory, hashes):
        for name, digest in hashes.items():
            modes = (0o400, 0o600) if name in ('.env.aws.production', 'release-manifest.json', 'before-audit.json', 'after-audit.json') else (0o400, 0o600, 0o644, 0o664)
            require(hashlib.sha256(read(directory / name, modes=modes, limit=128 * 1024)).hexdigest() == digest, message)
    frozen_files(previous, fixed['fileSha256'])
    require(hashlib.sha256(read(previous / 'scripts/production-release/remote-deploy.py', modes=(0o644, 0o664))).hexdigest()
        == fixed['controllerSha256'], message)
    manifest = fixed_recharge_json(read(previous / 'release-manifest.json'))
    require(set(fixed['manifest']) == set(anchor['manifest']) | {'databaseGrants', 'fixedRegistrationPreservedStates',
        'fixedRechargeRelease', 'fixedRechargePreservedStates'}
        and {key: manifest.get(key) for key in fixed['manifest']} == fixed['manifest']
        and manifest['previousCommit'] == RECHARGE_MAIN80_CURRENT and manifest['servicesUpdated'] == ['auto-recharge']
        and manifest['migrationApplied'] is False and manifest['newMigrations'] == []
        and manifest['databaseGrants'] == {'status': 'SKIPPED', 'reason': 'FIXED_RECHARGE_NO_MIGRATIONS'}, message)
    pro_raw = registration_observation_pro_profile(previous)
    profile = parse_fixed_recharge_scope(pro_raw)
    before = Path(manifest['previousRelease'])
    require(str(before) == anchor['current'] and before.resolve() == before and before.parent == BASE / 'releases', message)
    frozen_files(before, anchor['fileSha256'])
    old = fixed_recharge_json(read(before / 'release-manifest.json'))
    require({key: old.get(key) for key in anchor['manifest']} == anchor['manifest']
        and old['commit'] == RECHARGE_MAIN80_CURRENT and manifest['fixedRegistrationRelease'] == old['fixedRegistrationRelease']
        and set(manifest['images']) == set(old['images'])
        and all(manifest['images'][name] == old['images'][name] for name in old['images'] if name != 'auto-recharge')
        and manifest['fixedRechargePreservedStates'] == {'before': main80_recharge_preserved_states(fixed['liveServices']),
            'after': main80_recharge_preserved_states(fixed['liveServices'])}
        and main80_recharge_preserved_states(fixed['liveServices']) == main80_recharge_preserved_states(anchor['liveServices']), message)
    origin = main80_recharge_origin(before, old)
    for path in (ORDER_ARCHIVE_SEAL, POST_CLEANUP_RECEIPT): read(path)
    for directory in (origin, before, previous):
        for name in ('order-archive-seal.reader.json', 'order-archive-cleanup.reader.json'):
            read(directory / name, modes=(0o400,))
        main80_recharge_reader_evidence(directory)
    policy, seal = main80_recharge_seal(origin, profile)
    frozen = fixed_recharge_json(read(origin / 'before-audit.json'))['gate']
    gates, facts = {}, []
    for stage in ('before', 'after'):
        main80_recharge_report(fixed_recharge_json(read(origin / (stage + '-audit.json'))), profile, policy, seal, stage)
        for directory, baseline, saved in ((before, anchor, old), (previous, fixed, manifest)):
            report = fixed_recharge_json(read(directory / (stage + '-audit.json')))
            summary = require_registration_zero_report(report, stage, frozen)
            measured = {'checkCount': report['checkCount'], 'violationCount': report['violationCount'],
                'checksSha256': historical_fingerprint(report['checks']), 'gateSha256': historical_fingerprint(report['gate']),
                'identitySha256': historical_fingerprint(report['identity'])}
            require(summary == saved['dataAudit' + stage.title()] and measured == baseline['audits'][stage], message)
            facts.append((report['checks'], report['identity']))
            if directory == previous: gates[stage] = summary
    require(all(value == facts[0] for value in facts), message)
    context = main80_recharge_context(argparse.Namespace(commit=contract['current'], source_tree=manifest['sourceTree'],
        expected_current=RECHARGE_MAIN80_CURRENT), profile, gates['before'], gates['after'])
    require(manifest['fixedRechargeRelease'] == context and read(previous / '.env.aws.production') == read(before / '.env.aws.production')
        and read(previous / 'docker-compose.aws-mysql.yml', modes=(0o644, 0o664)) == read(before / 'docker-compose.aws-mysql.yml', modes=(0o644, 0o664)), message)
    override = fixed_recharge_json(read(previous / 'compose.release.json', modes=(0o400, 0o600, 0o644)))
    require(historical_fingerprint(override) == fixed['overrideCanonicalSha256']
        and override == {'services': {name: {'image': manifest['images'][name]['reference'], 'pull_policy': 'never'}
            for name in (*SERVICES, 'migrate')}}, message)
    worker_profile = registration_profile(fixed_recharge_json(read(before / REGISTRATION_EMAIL_REQUEST_FILE,
        modes=(0o644, 0o664), limit=128 * 1024)), profile_id=REGISTRATION_EMAIL_REQUEST_ID)
    require(fixed['actualWorkerSourceSha256'] == {name: worker_profile['workerProjection'][REGISTRATION_WORKER_PREFIX + name]['sha256']
        for name in ('browser_password_login.py', 'registration_browser.py', 'registration_builtin.py', 'registration_job.py')}, message)
    for name, digest in fixed['actualWorkerSourceSha256'].items():
        require(hashlib.sha256(read(previous / (REGISTRATION_WORKER_PREFIX + name), modes=(0o644, 0o664))).hexdigest() == digest, message)
    archive = fixed_recharge_runtime_archive(profile)
    native = verify_main80_recharge_finance_source(before, archive)
    public = verify_main80_recharge_candidate_source(previous, archive, profile)
    pro_image = manifest['images']['auto-recharge']
    require(fixed['liveServices']['auto-recharge']['image'] == pro_image['digest']
        and fixed['liveServices']['auto-recharge']['reference'] == pro_image['reference']
        and pro_image['sourceCommit'] == contract['current'] and manifest['imageBuildRun'] == manifest['deploymentRun']
        and re.fullmatch(r'github-actions-[1-9][0-9]*-[1-9][0-9]*', manifest['deploymentRun'])
        and pro_image['reference'].endswith(':' + contract['current'] + '-' + manifest['deploymentRun'].removeprefix('github-actions-') + '-auto-recharge'), message)
    require(all(fixed_recharge_bytes(path, **options) == raw for path, (raw, options) in observed.items()), message)
    require_main80_recharge_public_snapshot(native); require_main80_recharge_public_snapshot(public)
    registration_observation_pro_profile(previous)
    return manifest, origin


def registration_hydration_history(previous):
    """Validate actual 89 and its sealed ancestry; old service records remain historical."""
    fixed = REGISTRATION_HYDRATION_BASELINE
    message = 'Fixed hydration predecessor history changed'
    require(set(fixed) == {'status', 'current', 'controllerSha256', 'profileSha256', 'manifest',
        'fileSha256', 'overrideCanonicalSha256', 'audits', 'liveServices', 'readback',
        'actualWorkerSourceSha256', 'original80SealMatched', 'databaseWrites', 'windowRestarted'}
        and fixed['status'] == 'VERIFIED_89_RUNTIME_BASELINE' and fixed['original80SealMatched'] is True
        and type(fixed['databaseWrites']) is int and fixed['databaseWrites'] == 0 and fixed['windowRestarted'] is False
        and previous.is_absolute() and previous.resolve() == previous and previous.parent == BASE / 'releases'
        and str(previous) == fixed['current'] and fixed['manifest']['commit'] == REGISTRATION_HYDRATION_CURRENT,
        message)
    observed = {}
    def read(path, **options):
        raw = fixed_recharge_bytes(path, **options)
        require(path not in observed or observed[path][0] == raw, message)
        observed[path] = (raw, options)
        return raw
    for name, digest in fixed['fileSha256'].items():
        modes = (0o400, 0o600) if name in ('.env.aws.production', 'release-manifest.json', 'before-audit.json', 'after-audit.json') else (0o400, 0o600, 0o644, 0o664)
        require(hashlib.sha256(read(previous / name, modes=modes, limit=128 * 1024)).hexdigest() == digest, message)
    require(hashlib.sha256(read(previous / 'scripts/production-release/remote-deploy.py', modes=(0o644, 0o664))).hexdigest()
        == fixed['controllerSha256'], message)
    raw, profile = registration_hydration_old_profile(previous)
    manifest = fixed_recharge_json(read(previous / 'release-manifest.json', modes=(0o400, 0o600)))
    require({key: manifest.get(key) for key in fixed['manifest']} == fixed['manifest']
        and manifest['servicesUpdated'] == ['auto-registration'] and manifest['migrationApplied'] is False
        and manifest['newMigrations'] == []
        and manifest['databaseGrants'] == {'status': 'SKIPPED', 'reason': 'FIXED_REGISTRATION_NO_MIGRATIONS'}, message)
    original, origin = registration_hydration_pro_history(Path(manifest['previousRelease']))
    require(manifest['previousCommit'] == REGISTRATION_EMAIL_OBSERVATION_CURRENT
        and all(manifest['images'][name] == original['images'][name]
            for name in original['images'] if name != 'auto-registration'), message)
    reviewed = {name: (read(previous / name, modes=(0o644, 0o664, 0o755, 0o775)), '100644')
        for name in profile['registrationSourceSha256'].keys() | profile['controlSourceSha256'].keys()}
    registration_source(profile, reviewed)
    for name, row in profile['workerProjection'].items():
        path = previous / name
        require(hashlib.sha256(read(path, modes=(0o644, 0o664, 0o755, 0o775))).hexdigest() == row['sha256']
            and ('100755' if path.stat().st_mode & 0o111 else '100644') == row['mode'], message)
    require(fixed['actualWorkerSourceSha256'] == {name: profile['workerProjection'][REGISTRATION_WORKER_PREFIX + name]['sha256']
        for name in ('browser_password_login.py', 'registration_browser.py', 'registration_builtin.py', 'registration_job.py')}, message)
    validate_fixed_registration_readback_projection(fixed['readback'], REGISTRATION_HYDRATION_CURRENT,
        manifest['sourceTree'], hashlib.sha256(raw).hexdigest(), profile_id=REGISTRATION_EMAIL_OBSERVATION_ID)
    override = fixed_recharge_json(read(previous / 'compose.release.json', modes=(0o400, 0o600, 0o644)))
    require(historical_fingerprint(override) == fixed['overrideCanonicalSha256']
        and override == {'services': {name: {'image': manifest['images'][name]['reference'], 'pull_policy': 'never'}
            for name in (*SERVICES, 'migrate')}}, message)
    frozen = fixed_recharge_json(read(origin / 'before-audit.json', modes=(0o400, 0o600)))['gate']
    facts = []
    for stage in ('before', 'after'):
        report = fixed_recharge_json(read(previous / (stage + '-audit.json'), modes=(0o400, 0o600)))
        summary = require_registration_zero_report(report, stage, frozen)
        measured = {'checkCount': report['checkCount'], 'violationCount': report['violationCount'],
            'checksSha256': historical_fingerprint(report['checks']), 'gateSha256': historical_fingerprint(report['gate']),
            'identitySha256': historical_fingerprint(report['identity'])}
        require(summary == manifest['dataAudit' + stage.title()] and measured == fixed['audits'][stage], message)
        facts.append((report['checks'], report['identity']))
    require(facts[0] == facts[1] and manifest['fixedRegistrationPreservedStates'] == {
        'before': registration_preserved_states(fixed['liveServices']),
        'after': registration_preserved_states(fixed['liveServices'])}, message)
    registration_observation_pro_profile(previous)
    require(all(fixed_recharge_bytes(path, **options) == data for path, (data, options) in observed.items()), message)
    return manifest, origin


def registration_hydration_baseline(previous, states=None):
    """Keep the real current pointer and live five separate from sealed 89 metadata."""
    pointer = (BASE / 'current').resolve()
    live = {name: service_state(pointer, name, include_container_id=True, include_environment_hash=True)
        for name in ALL_SERVICES}
    manifest, origin = registration_hydration_history(previous)
    fixed = REGISTRATION_HYDRATION_BASELINE
    require(all(row['status'] == 'running' for row in live.values())
        and all(live[name]['health'] == 'healthy' for name in ALL_SERVICES if name != 'caddy')
        and registration_hydration_preserved_states(live) == registration_hydration_preserved_states(fixed['liveServices']),
        'Fixed hydration preserved baseline changed')
    if states is not None:
        require(pointer == previous and states == live == fixed['liveServices'], 'Fixed hydration live baseline changed')
        registration_worker_hashes(previous, registration_hydration_old_profile(previous)[1])
    elif pointer != previous:
        current = fixed_recharge_json(private_maintenance_receipt(pointer / 'release-manifest.json'))
        require(current.get('previousRelease') == str(previous)
            and current.get('previousCommit') == REGISTRATION_HYDRATION_CURRENT
            and current.get('servicesUpdated') == ['admin', 'auto-registration']
            and current.get('fixedRegistrationRelease', {}).get('id') == REGISTRATION_HYDRATION_ID,
            'Fixed hydration current provenance changed')
    else:
        require(live == fixed['liveServices'], 'Fixed hydration live baseline changed')
    require((BASE / 'current').resolve() == pointer and {name: service_state(pointer, name,
        include_container_id=True, include_environment_hash=True) for name in ALL_SERVICES} == live,
        'Fixed hydration baseline changed during verification')
    return manifest, origin


def registration_hydration_preserved_states(states):
    return {name: states[name] for name in ALL_SERVICES if name not in ('admin', 'auto-registration')}


def registration_updated_services(profile_id):
    return ('admin', 'auto-registration') if profile_id == REGISTRATION_HYDRATION_ID else ('auto-registration',)


def registration_selected_preserved_states(states, profile_id):
    return (registration_hydration_preserved_states(states) if profile_id == REGISTRATION_HYDRATION_ID
        else registration_preserved_states(states))


def registration_hydration_rollback(previous, release, before):
    # A fresh rollback receipt is required afterwards: Admin is a recreated container.
    assert_no_active_registration(release)
    for name in ('auto-registration', 'admin'):
        rollback_service(previous, release, name, before)


def registration_preserved_states(states):
    return {name: states[name] for name in ALL_SERVICES if name != 'auto-registration'}


def registration_rollback(previous, release, before):
    # Check the live new Worker, not the old image receipt, before a destructive restart.
    assert_no_active_registration(release)
    rollback_service(previous, release, 'auto-registration', before)


def registration_worker_hashes(directory, profile):
    expected = {name.removeprefix(REGISTRATION_WORKER_PREFIX): row['sha256']
                for name, row in profile['workerProjection'].items()}
    probe = ('import hashlib,json\nfrom pathlib import Path\nnames=' + repr(sorted(expected))
        + '\nprint(json.dumps({n:hashlib.sha256((Path("/app")/n).read_bytes()).hexdigest() for n in names}))')
    value = fixed_recharge_json(compose(directory, 'exec', '-T', 'auto-registration',
        'python', '-B', '-c', probe, timeout=20).encode())
    require(value == expected, 'Fixed registration running source changed')


def registration_release(args):
    profile_observation = getattr(args, 'registration_worker_91', False)
    hydration = getattr(args, 'registration_worker_90', False)
    continuation = getattr(args, 'registration_worker_956', False)
    initial = getattr(args, 'registration_worker_85', False)
    email = getattr(args, 'registration_worker_86', False)
    callback = getattr(args, 'registration_worker_87', False)
    email_request = getattr(args, 'registration_worker_88', False)
    email_observation = getattr(args, 'registration_worker_89', False)
    profile_id = REGISTRATION_PROFILE_OBSERVATION_ID if profile_observation else REGISTRATION_HYDRATION_ID if hydration else REGISTRATION_EMAIL_OBSERVATION_ID if email_observation else REGISTRATION_EMAIL_REQUEST_ID if email_request else REGISTRATION_CALLBACK_ID if callback else REGISTRATION_EMAIL_ID if email else REGISTRATION_INITIAL_ID if initial else REGISTRATION_CONTINUATION_ID if continuation else REGISTRATION_SCOPE_ID
    contract = registration_contract(profile_id)
    updated_services = registration_updated_services(profile_id)
    require(sum((profile_observation, hydration, email_observation, email_request, callback, email, initial, continuation, getattr(args, 'registration_worker_b8_80', False))) <= 1,
        'Fixed registration selection changed')
    require(args.expected_current == contract['current'] and not args.admin_only
        and not getattr(args, 'recharge_pro_main80', False)
        and all(not getattr(args, name) for name in (
            'historical_finance_exception', 'historical_finance_continuation', 'historical_finance_recharge_diagnostics',
            'historical_finance_maintenance_continuation', 'historical_finance_mailbox_batch',
            'recharge_pro_menu_b8', 'recharge_pro_menu_7f', 'historical_finance_post_cleanup',
            'historical_finance_order_archive', 'post_cleanup_seal_sha256', 'order_archive_seal_sha256',
            'order_archive_prepared_images_sha256'))
        and (args.image_commit or args.commit) == args.commit
        and (args.image_run_id or args.run_id) == args.run_id
        and (args.image_run_attempt or args.run_attempt) == args.run_attempt,
        'Fixed registration selection changed')
    require(all(re.fullmatch(r'[a-f0-9]{40}', value or '') for value in (args.commit, args.source_tree))
        and all(re.fullmatch(r'[1-9][0-9]*', value or '') for value in (args.run_id, args.run_attempt, args.ci_run_id))
        and re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release', args.repository),
        'Fixed registration selection changed')
    os.umask(0o077)
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = (BASE / 'current').resolve()
        states = {name: service_state(previous, name, include_container_id=True, include_environment_hash=True)
                  for name in ALL_SERVICES}
        old_manifest, origin = registration_runtime_baseline(previous, states, profile_id=profile_id)
        assert_release_jobs_idle(previous, ('auto-registration',))
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        release = BASE / 'releases' / (stamp + '-' + args.commit[:12])
        step = 'source'; changed = False
        try:
            candidate_raw = registration_download(args.commit)
            candidate = registration_archive(candidate_raw, args.commit)
            profile_raw = candidate[contract['file']][0]
            profile = registration_profile(fixed_recharge_json(profile_raw), profile_id=profile_id)
            basis_raw = registration_download(RECHARGE_SCOPE_CURRENT)
            basis = registration_archive(basis_raw, RECHARGE_SCOPE_CURRENT)
            worker = registration_worker_projection(profile, basis, candidate)
            finance_raw = registration_download(REGISTRATION_CURRENT)
            require(hashlib.sha256(finance_raw).hexdigest() == REGISTRATION_BASELINE['sourceArchiveSha256'],
                    'Fixed registration finance archive changed')
            runtime = registration_archive(finance_raw, REGISTRATION_CURRENT)
            runtime = {name: row for name, row in runtime.items() if not name.startswith(REGISTRATION_WORKER_PREFIX)}
            runtime.update({name: row for name, row in worker.items() if name.startswith(REGISTRATION_WORKER_PREFIX)})
            runtime.update({name: candidate[name] for name in REGISTRATION_CONTROLS | {contract['file']}})
            runtime.update({name: candidate[name] for name in profile['registrationSourceSha256']})
            if profile_observation:
                registration_profile_observation_carry(previous, candidate, runtime)
            if hydration:
                admin = registration_hydration_admin_projection(profile,
                    registration_archive(finance_raw, REGISTRATION_CURRENT), candidate)
                for name in profile['adminSourceSha256']:
                    require(runtime[name] == admin[name], 'Fixed hydration Admin runtime source changed')
                for name, digest in contract['runtimeBaseline']['fileSha256'].items():
                    if name.startswith('deploy/aws/registration-worker-'):
                        raw = fixed_recharge_bytes(previous / name, modes=(0o644, 0o664), limit=128 * 1024)
                        require(hashlib.sha256(raw).hexdigest() == digest, 'Fixed hydration original profile changed')
                        runtime[name] = (raw, '100644')
                runtime[RECHARGE_MAIN80_FILE] = (registration_observation_pro_profile(previous), '100644')
            if continuation or initial or email or callback or email_request or email_observation:
                prior_profiles = ({name: contract['runtimeBaseline']['fileSha256'][name]
                    for name in (REGISTRATION_SCOPE_FILE, REGISTRATION_CONTINUATION_FILE, REGISTRATION_INITIAL_FILE, REGISTRATION_EMAIL_FILE, REGISTRATION_CALLBACK_FILE, REGISTRATION_EMAIL_REQUEST_FILE)}
                    if email_observation else {name: contract['runtimeBaseline']['fileSha256'][name]
                    for name in (REGISTRATION_SCOPE_FILE, REGISTRATION_CONTINUATION_FILE, REGISTRATION_INITIAL_FILE, REGISTRATION_EMAIL_FILE, REGISTRATION_CALLBACK_FILE)}
                    if email_request else {name: contract['runtimeBaseline']['fileSha256'][name]
                    for name in (REGISTRATION_SCOPE_FILE, REGISTRATION_CONTINUATION_FILE, REGISTRATION_INITIAL_FILE, REGISTRATION_EMAIL_FILE)}
                    if callback else {name: contract['runtimeBaseline']['fileSha256'][name]
                    for name in (REGISTRATION_SCOPE_FILE, REGISTRATION_CONTINUATION_FILE, REGISTRATION_INITIAL_FILE)}
                    if email else {REGISTRATION_SCOPE_FILE: REGISTRATION_CONTINUATION_BASELINE['fileSha256'][REGISTRATION_SCOPE_FILE],
                    REGISTRATION_CONTINUATION_FILE: contract['runtimeBaseline']['fileSha256'][REGISTRATION_CONTINUATION_FILE]}
                    if initial else {REGISTRATION_SCOPE_FILE: contract['runtimeBaseline']['fileSha256'][REGISTRATION_SCOPE_FILE]})
                for name, digest in prior_profiles.items():
                    require(hashlib.sha256(candidate[name][0]).hexdigest() == digest,
                        'Fixed registration original profile changed')
                    runtime[name] = candidate[name]
            if email_observation and REGISTRATION_EMAIL_OBSERVATION_PRO_BASELINE is not None:
                runtime[RECHARGE_MAIN80_FILE] = (registration_observation_pro_profile(previous), '100644')
            write_registration_files(release, runtime)
            # Only the running baseline's Compose and secrets determine the new service configuration.
            for name in ('docker-compose.aws-mysql.yml', '.env.aws.production'):
                shutil.copy2(previous / name, release / name)
            (release / '.env.aws.production').chmod(0o600)
            environment = fixed_recharge_bytes(previous / '.env.aws.production')
            finance_source = prepare_registration_finance_source(args, finance_raw)
            require(shutil.disk_usage(BASE).free > 6 * 1024**3, 'Insufficient free disk before pull')
            step = 'audit-before'
            before_audit = registration_finance_audit(previous, release / 'before-audit.json',
                stage='before', source=finance_source, control_source=release, profile_id=profile_id)
            step = 'images'
            references = {name: args.repository + ':' + args.commit + '-' + args.run_id + '-' + args.run_attempt
                + '-' + ('auto-recharge' if name == 'auto-registration' else name) for name in updated_services}
            images = {}
            registry = args.repository.split('/')[0]
            password = run('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1')
            logged = subprocess.run(['docker', 'login', '--username', 'AWS', '--password-stdin', registry],
                                    input=password, capture_output=True, text=True)
            require(logged.returncode == 0, 'ECR login failed')
            try:
                for name, reference in references.items():
                    run('docker', 'pull', reference, timeout=900)
                    image = json.loads(run('docker', 'image', 'inspect', reference))[0]
                    require(image['Architecture'] == 'amd64'
                        and image['Config']['Labels'].get('org.opencontainers.image.revision') == args.commit
                        and (not hydration or name != 'admin'
                            or image['Config']['Labels'].get('id-business-v2.admin-projection-sha256')
                                == profile['adminProjectionSha256']),
                        'Fixed registration image changed')
                    images[name] = image
            finally:
                subprocess.run(['docker', 'logout', registry], capture_output=True, text=True)
            override = fixed_recharge_json((previous / 'compose.release.json').read_bytes())
            for name, reference in references.items():
                override['services'][name]['image'] = reference
            (release / 'compose.release.json').write_text(json.dumps(override, indent=2) + '\n')
            require(shutil.disk_usage(BASE).free > 2 * 1024**3, 'Insufficient free disk after pull')
            step = 'backup'
            backup = fresh_backup(previous)
            (release / 'backup-verification.json').write_text(json.dumps(backup, indent=2) + '\n')
            (release / 'backup-verification.json').chmod(0o600)
            require((BASE / 'current').resolve() == previous, 'Fixed registration baseline changed')
            require({name: service_state(previous, name, include_container_id=True, include_environment_hash=True)
                for name in ALL_SERVICES} == states, 'Fixed registration baseline changed')
            require_diagnostics_environment_unchanged(previous, release, environment)
            registration_runtime_baseline(previous, states, profile_id=profile_id)
            assert_release_jobs_idle(previous, ('auto-registration',))
            step = 'switch'
            assert_no_active_registration(previous)
            changed = True
            compose(release, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                '--force-recreate', *updated_services, timeout=300)
            for name in updated_services:
                wait_healthy(release, name)
            registration_worker_hashes(release, profile)
            step = 'audit-after'
            after_audit = registration_finance_audit(release, release / 'after-audit.json', stage='after',
                source=finance_source, before_receipt=release / 'before-audit.json', control_source=release, profile_id=profile_id)
            after = {name: service_state(release, name, include_container_id=True, include_environment_hash=True)
                     for name in ALL_SERVICES}
            require(registration_selected_preserved_states(after, profile_id) == registration_selected_preserved_states(states, profile_id)
                and all(after[name]['image'] == images[name]['Id']
                    and after[name]['reference'] == references[name] for name in updated_services)
                and (not (hydration or profile_observation) or all(after[name]['environmentSha256'] == states[name]['environmentSha256']
                    for name in updated_services)),
                'Fixed registration preserved service changed')
            require_diagnostics_environment_unchanged(previous, release, environment)
            registration_worker_hashes(release, profile)
            require_registration_finance_source(finance_source)
            manifest = dict(old_manifest)
            manifest.pop('fixedRechargeRelease', None); manifest.pop('fixedRechargePreservedStates', None)
            manifest.update(commit=args.commit, sourceBranch='main', sourceTree=args.source_tree,
                previousCommit=contract['current'], previousRelease=str(previous),
                deploymentRun='github-actions-' + args.run_id + '-' + args.run_attempt,
                imageBuildRun='github-actions-' + args.run_id + '-' + args.run_attempt,
                ciWorkflow='Quality Gate', ciWorkflowRunId=int(args.ci_run_id),
                releaseTag='v2-production-' + stamp, sourceArchiveSha256=hashlib.sha256(candidate_raw).hexdigest(),
                servicesUpdated=list(updated_services), migrationApplied=False, newMigrations=[],
                databaseGrants={'status': 'SKIPPED', 'reason': 'FIXED_REGISTRATION_NO_MIGRATIONS'},
                dataAuditBefore=before_audit, dataAuditAfter=after_audit, backupBeforeRelease=backup['name'],
                deployedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
            manifest['images'] = {**old_manifest['images'], **{name: {
                'reference': references[name], 'digest': images[name]['Id'], 'sourceCommit': args.commit}
                for name in updated_services}}
            manifest['fixedRegistrationRelease'] = {'id': contract['id'],
                'profileRawSha256': hashlib.sha256(profile_raw).hexdigest(),
                'registrationSourceCommit': contract['source'],
                'workerBasisCommit': registration_worker_basis(profile_id),
                'workerProjectionSha256': contract['projectionSha256'],
                'financeSourceCommit': REGISTRATION_CURRENT,
                'financePolicyId': HISTORY_ORDER_ARCHIVE_POLICY_ID,
                'financeMode': REGISTRATION_CLEARANCE['mode'],
                'clearanceSealSha256': historical_fingerprint(REGISTRATION_CLEARANCE),
                'environmentUnchanged': True, 'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED',
                'cacheStatus': 'SKIPPED'}
            if hydration:
                manifest['fixedRegistrationRelease'].update(adminSourceCommit=profile['adminSourceCommit'],
                    adminBasisCommit=REGISTRATION_CURRENT, adminProjectionSha256=profile['adminProjectionSha256'])
            manifest['fixedRegistrationPreservedStates'] = {
                'before': registration_selected_preserved_states(states, profile_id),
                'after': registration_selected_preserved_states(after, profile_id)}
            manifest['rollback'] = {'release': str(previous), 'images': {name: states[name]['image'] for name in updated_services},
                                    'servicesAdded': []}
            (release / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            require((BASE / 'current').resolve() == previous, 'Fixed registration baseline changed')
            point_current(release, stamp + '-publish')
            print(json.dumps({'status': 'DEPLOYED', 'commit': args.commit,
                'servicesUpdated': list(updated_services), 'migrationApplied': False,
                'auditViolations': 0, 'unchangedServiceContainersPreserved': True}), flush=True)
            return 0
        except Exception as error:
            rollback_ok = True
            if changed:
                try:
                    if hydration:
                        registration_hydration_rollback(previous, release, states)
                    else:
                        registration_rollback(previous, release, states)
                    if (BASE / 'current').resolve() == release:
                        point_current(previous, stamp + '-recover')
                except Exception:
                    rollback_ok = False
            print(json.dumps({'status': 'DEPLOY_FAILED', 'step': step, 'errorType': type(error).__name__,
                'rollbackOk': rollback_ok, 'servicesStarted': list(updated_services) if changed else []}), flush=True)
            return 1


def registration_readback_receipt(expected_current, source_tree, profile_raw_sha256, *, profile_id=REGISTRATION_SCOPE_ID):
    contract = registration_contract(profile_id)
    if profile_id == REGISTRATION_PROFILE_OBSERVATION_ID:
        require(isinstance(contract['source'], str) and re.fullmatch(r'[a-f0-9]{40}', contract['source'])
            and isinstance(contract['projectionSha256'], str) and re.fullmatch(r'[a-f0-9]{64}', contract['projectionSha256']),
            'Fixed profile observation source unavailable')
    if profile_id == REGISTRATION_HYDRATION_ID:
        require(re.fullmatch(r'[a-f0-9]{40}', contract['source'] or '')
            and REGISTRATION_HYDRATION_ADMIN_SOURCE == contract['source']
            and re.fullmatch(r'[a-f0-9]{64}', contract['projectionSha256'] or '')
            and re.fullmatch(r'[a-f0-9]{64}', REGISTRATION_HYDRATION_ADMIN_PROJECTION_SHA256 or ''),
            'Fixed hydration source unavailable')
    return {'version': 1, 'id': contract['id'], 'status': 'VERIFIED',
        'currentCommit': expected_current, 'sourceTree': source_tree, 'profileSha256': profile_raw_sha256,
        'previousCommit': contract['current'], 'registrationSourceCommit': contract['source'],
        'workerBasisCommit': registration_worker_basis(profile_id), 'workerProjectionSha256': contract['projectionSha256'],
        'servicesUpdated': list(registration_updated_services(profile_id)),
        'preservedServiceCount': 5 if profile_id == REGISTRATION_HYDRATION_ID else 6,
        'checkCount': 49, 'executedCheckCount': 49, 'unavailableCheckCount': 0, 'violationCount': 0,
        'financeMode': REGISTRATION_CLEARANCE['mode'],
        'runningSourceMatched': True, 'unchangedServiceContainersPreserved': True,
        'environmentUnchanged': True, 'migrationStatus': 'SKIPPED',
        'databaseGrantSyncStatus': 'SKIPPED', 'cacheStatus': 'SKIPPED', 'liveServicesHealthy': True}


def validate_fixed_registration_readback_projection(value, expected_current, source_tree, profile_raw_sha256, *, profile_id=REGISTRATION_SCOPE_ID):
    require(re.fullmatch(r'[a-f0-9]{40}', expected_current or '')
        and re.fullmatch(r'[a-f0-9]{40}', source_tree or '')
        and re.fullmatch(r'[a-f0-9]{64}', profile_raw_sha256 or ''),
        'Fixed registration readback unavailable')
    expected = registration_readback_receipt(expected_current, source_tree, profile_raw_sha256, profile_id=profile_id)
    require(isinstance(value, dict) and set(value) == set(expected)
        and historical_fingerprint(value) == historical_fingerprint(expected),
        'Fixed registration readback unavailable')
    return value


def check_fixed_registration_deployment(expected_current, source_tree, profile_raw_sha256, *, profile_id=REGISTRATION_SCOPE_ID):
    contract = registration_contract(profile_id)
    updated_services = registration_updated_services(profile_id)
    receipt = registration_readback_receipt(expected_current, source_tree, profile_raw_sha256, profile_id=profile_id)
    validate_fixed_registration_readback_projection(receipt, expected_current, source_tree, profile_raw_sha256, profile_id=profile_id)
    current = (BASE / 'current').resolve()
    require(current.parent == BASE / 'releases'
        and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + expected_current[:12], current.name),
        'Fixed registration readback unavailable')
    profile_raw = fixed_recharge_bytes(current / contract['file'], modes=(0o644, 0o664), limit=128 * 1024)
    require(hashlib.sha256(profile_raw).hexdigest() == profile_raw_sha256, 'Fixed registration profile changed')
    profile = registration_profile(fixed_recharge_json(profile_raw), profile_id=profile_id)
    if profile_id == REGISTRATION_PROFILE_OBSERVATION_ID:
        registration_profile_observation_carried(current)
    if profile_id == REGISTRATION_EMAIL_OBSERVATION_ID and REGISTRATION_EMAIL_OBSERVATION_PRO_BASELINE is not None:
        registration_observation_pro_profile(current)
    reviewed = {name: (fixed_recharge_bytes(current / name, modes=(0o644, 0o664, 0o755, 0o775)), '100644')
                for name in profile['registrationSourceSha256'].keys() | profile['controlSourceSha256'].keys()}
    registration_source(profile, reviewed)
    manifest = fixed_recharge_json(private_maintenance_receipt(current / 'release-manifest.json'))
    require(manifest.get('commit') == expected_current and manifest.get('sourceTree') == source_tree
        and manifest.get('previousCommit') == contract['current']
        and manifest.get('servicesUpdated') == list(updated_services) and manifest.get('migrationApplied') is False
        and manifest.get('newMigrations') == []
        and manifest.get('databaseGrants') == {'status': 'SKIPPED', 'reason': 'FIXED_REGISTRATION_NO_MIGRATIONS'},
        'Fixed registration manifest changed')
    provenance = {'id': contract['id'],
        'profileRawSha256': profile_raw_sha256, 'registrationSourceCommit': contract['source'],
        'workerBasisCommit': registration_worker_basis(profile_id), 'workerProjectionSha256': contract['projectionSha256'],
        'financeSourceCommit': REGISTRATION_CURRENT, 'financePolicyId': HISTORY_ORDER_ARCHIVE_POLICY_ID,
        'financeMode': REGISTRATION_CLEARANCE['mode'],
        'clearanceSealSha256': historical_fingerprint(REGISTRATION_CLEARANCE),
        'environmentUnchanged': True, 'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED',
        'cacheStatus': 'SKIPPED'}
    if profile_id == REGISTRATION_HYDRATION_ID:
        provenance.update(adminSourceCommit=profile['adminSourceCommit'], adminBasisCommit=REGISTRATION_CURRENT,
            adminProjectionSha256=profile['adminProjectionSha256'])
    require(manifest.get('fixedRegistrationRelease') == provenance, 'Fixed registration manifest provenance changed')
    previous = Path(manifest['previousRelease'])
    old_manifest, _origin = registration_runtime_baseline(previous, profile_id=profile_id)
    images = manifest['images']
    require(set(images) == set(old_manifest['images'])
        and all(images[name] == old_manifest['images'][name] for name in images if name not in updated_services),
        'Fixed registration preserved image changed')
    live = {name: service_state(current, name, include_container_id=True, include_environment_hash=True)
            for name in ALL_SERVICES}
    saved = manifest['fixedRegistrationPreservedStates']
    require(set(saved) == {'before', 'after'} and saved['before'] == saved['after']
        == registration_selected_preserved_states(live, profile_id)
        and all(row['status'] == 'running' for row in live.values())
        and all(live[name]['health'] == 'healthy' for name in ALL_SERVICES if name != 'caddy'),
        'Fixed registration preserved service changed')
    if contract['runtimeBaseline'] is not None:
        require(registration_selected_preserved_states(live, profile_id) == registration_selected_preserved_states(
            contract['runtimeBaseline']['liveServices'], profile_id), 'Fixed registration continuation preserved service changed')
    if profile_id in (REGISTRATION_HYDRATION_ID, REGISTRATION_PROFILE_OBSERVATION_ID):
        require(all(live[name]['environmentSha256'] == contract['runtimeBaseline']['liveServices'][name]['environmentSha256']
            for name in updated_services), 'Fixed hydration updated service environment changed')
    run_id = manifest['deploymentRun']
    require(re.fullmatch(r'github-actions-[1-9][0-9]*-[1-9][0-9]*', run_id)
        and manifest['imageBuildRun'] == run_id, 'Fixed registration image provenance changed')
    for service in updated_services:
        reference = images[service]['reference']
        require(re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
            + expected_current + '-' + run_id.removeprefix('github-actions-') + '-' + ('auto-recharge' if service == 'auto-registration' else service), reference)
            and images[service]['sourceCommit'] == expected_current
            and live[service]['reference'] == reference
            and live[service]['image'] == images[service]['digest'],
            'Fixed registration image provenance changed')
        metadata = json.loads(run('docker', 'image', 'inspect', live[service]['image']))[0]
        require(metadata['Architecture'] == 'amd64' and metadata['Id'] == live[service]['image']
            and metadata['Config']['Labels'].get('org.opencontainers.image.revision') == expected_current
            and (profile_id != REGISTRATION_HYDRATION_ID or service != 'admin'
                or metadata['Config']['Labels'].get('id-business-v2.admin-projection-sha256')
                    == profile['adminProjectionSha256']),
            'Fixed registration image provenance changed')
    require((current / 'docker-compose.aws-mysql.yml').read_bytes() == (previous / 'docker-compose.aws-mysql.yml').read_bytes()
        and (current / '.env.aws.production').read_bytes() == (previous / '.env.aws.production').read_bytes()
        and fixed_recharge_json((current / 'compose.release.json').read_bytes()) == {
            'services': {name: {'image': images[name]['reference'], 'pull_policy': 'never'}
                         for name in (*SERVICES, 'migrate')}}, 'Fixed registration configuration changed')
    original = fixed_recharge_json(private_maintenance_receipt(_origin / 'before-audit.json'))['gate']
    audit_facts = []
    for stage in ('before', 'after'):
        report = fixed_recharge_json(private_maintenance_receipt(current / (stage + '-audit.json')))
        summary = require_registration_zero_report(report, stage, original)
        require(manifest['dataAudit' + stage.title()] == summary, 'Fixed registration audit changed')
        audit_facts.append((report['checks'], report['identity']))
    require(audit_facts[0] == audit_facts[1], 'Fixed registration audit facts changed')
    registration_worker_hashes(current, profile)
    require((BASE / 'current').resolve() == current, 'Fixed registration current changed')
    require({name: service_state(current, name, include_container_id=True, include_environment_hash=True)
             for name in ALL_SERVICES} == live, 'Fixed registration current service changed')
    if profile_id == REGISTRATION_PROFILE_OBSERVATION_ID:
        registration_profile_observation_carried(current)
    if profile_id == REGISTRATION_EMAIL_OBSERVATION_ID and REGISTRATION_EMAIL_OBSERVATION_PRO_BASELINE is not None:
        registration_observation_pro_profile(current)
    return validate_fixed_registration_readback_projection(receipt, expected_current, source_tree, profile_raw_sha256, profile_id=profile_id)


# The 01ce branch is independent. Historical profiles and their current guards remain fixed.
RECHARGE_01CE_ID = 'recharge-pro-01ce-20261007'
RECHARGE_01CE_FILE = 'deploy/aws/' + RECHARGE_01CE_ID + '.json'
RECHARGE_01CE_CURRENT = '01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af'
RECHARGE_01CE_TREE = '1f55cc743d48fdc5f7379c6d136e026d5ebfd558'
RECHARGE_01CE_PRODUCER = '5f5244183c327e1b037e0c3bcf8098cbff04cbbd34328d133a4d0a220ba39f8f'
RECHARGE_01CE_CHAIN = (
    (RECHARGE_01CE_CURRENT, RECHARGE_01CE_TREE),
    ('c3cad767b372738b2193e60584b0a53daa53b65f', '424d7c5812e0be9feba42f133639523571c9a056'),
    ('d2e22e623d0e19851c79ffe43396f5f97a99b8d3', 'd2d938a176fab2a99cc1edd1b25c1cd1ffb59357'),
    (RECHARGE_MAIN80_CURRENT, RECHARGE_MAIN80_TREE),
    ('4c200c4ae08bb8214ff8e0955f8237ce85069cc6', 'd55e9338f6afa6c2781a9177c40c3e2c7dd7ba05'),
    ('651f62902fba74ddd189b34932084573b39d245c', 'b8e28b33bc6cc9be899de88fd05aa12a04b4a46e'),
    ('fd3a6da610c505c2b7a51601cf854182991ffd12', 'bd82ae5a41fba40e9e914b5c91f6b341952b2884'),
    ('85e94572cd965dd993743d12d55a3e91d60b6444', '4e6a0414c51531f9e92fa984db3a8337424a7712'),
    ('9560d8038a39d4ded1e560d484bdcb941a5d9c43', 'b91e1881cccb0357c5dcab62aaa6eb8d2147410d'),
    (RECHARGE_MAIN80_FINANCE_CURRENT, RECHARGE_MAIN80_FINANCE_TREE))
RECHARGE_01CE_CANDIDATES = RECHARGE_SCOPE_CANDIDATES | frozenset(REGISTRATION_WORKER_PREFIX + name
    for name in ('server.py', 'test_server.py', 'test_worker_isolation.py'))
RECHARGE_01CE_CONTROLS = RECHARGE_SCOPE_CONTROLS | {'scripts/production-release/validate-release-selection.sh'}
RECHARGE_01CE_CARRIED_COMMIT = '974c62cc1681012ecff897aefc90d2cd9900004a'
RECHARGE_01CE_CARRIED_SOURCE = {'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': '0695a7ab960a07407ed16fbfce3368878b9e9c5c3ae4aef137ffbd7553495f9f',
 'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py': 'f1878abdf27e6760bd63c602136ae14ff06902d136bbd47cf2d036fd1fb393ae',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py': 'c409f1d4a36fc759aa3bf649d08e93938ff5497b9261b635f28cc02e324bcec0',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py': 'b9115e2d6f91bc0b847380b763d4bdd88391268bbfa7bb5ad1c1e3e4c8c82ed6',
 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': 'f49b7939de402db79b81d17069728a87ada29aa30bc9a12e0753267362f80382',
 'deploy/aws/recharge-pro-main80-20261006.json': '6d10faabd632157233099dfce5d558d89f3a841a0556fc42f91b384f049cbdc0',
 'deploy/aws/registration-worker-85-20261006.json': '02fc3375314ee75b6e5b8ec47ce715f1e02f9b744ce77c5a4804d9110ba4daec',
 'deploy/aws/registration-worker-86-20261006.json': '81946a081a13d6787a5a1e16782ef780065c6e81440b8500e55dbca155fef7f2',
 'deploy/aws/registration-worker-87-20261006.json': '3742920452e28992595c7d31d8ea5c03915f3a3218435a7714cf6e2fe1c2aea7',
 'deploy/aws/registration-worker-88-20261006.json': 'cce9a098659ba3bc5bec6e7fd8eb294d3ef075dc4676c86f5b4c38de1ff67d67',
 'deploy/aws/registration-worker-89-20261006.json': '4113a45f2f50c3952172942005ba2ee6e4d4d8b64c62513d232cbe844c01dec5',
 'deploy/aws/registration-worker-90-20261007.json': '56adb736e6081eeaeb31f14bba1ccb22f1a218c3f22abefcd1a9dcdae6625eed',
 'deploy/aws/registration-worker-91-20261007.json': 'c5b886a1d6b1a9f5bd34868d298274c1651b2576a22e3f414fab185526f5fa5d',
 'deploy/aws/registration-worker-956-20261006.json': '60226df9c51cb222bf8c0cc09a7783b52a8f0082f728189ec3ada9554b6dbfc1',
 'deploy/aws/registration-worker-b8-80-20261006.json': 'd5c023887b22f6a555abe0f8e4627113d5a45dec0668ae2abc1bb8fbf8cbdb28',
 'docs/AUTO_REGISTRATION.md': '3cb74e1f7269a5fa8dec5e6ca530147a310b261d43f44a62fbb979ad2aa6b11c',
 'scripts/production-release/registration-only-transport.test.py': 'ab3d8b5f03a2dec838b802ad719bc994ab534e4000d02fd401f3ccdb9d7eb11c',
 'scripts/v2-registration-finance-audit.mjs': '4d0726ba795569bc70e256141847cfe8ee57354d2936f35341c6e8a599ed8e67',
 'scripts/v2-registration-finance-audit.test.mjs': 'b9b32f040ad062f978d447d7f08b7d5dccdc1fd65e10297519f2a6e9fc063470'}
RECHARGE_01CE_NATIVE_KEYS = frozenset(('producerSha256', 'registrationProfileRawSha256',
    'registrationReadbackSha256', 'nativeChainSha256', 'runtimeStatesSha256', 'preservedStatesSha256',
    'nativeFileCount', 'nativeDirectoryCount'))


def recharge_01ce_scope(value, *, require_approved=True):
    message = 'Fixed 01ce recharge scope unavailable'
    require(isinstance(value, dict) and set(value) == {'version', 'kind', 'id', 'enabled', 'approvalStatus',
        'expectedCurrent', 'baselineRelease', 'nativeBaseline', 'candidateSourceSha256',
        'carriedSourceOnlySha256', 'controlSourceSha256', 'sourceModes', 'scope', 'financeValidator'}, message)
    require(type(value['version']) is int and value['version'] == 1
        and value['kind'] == 'FIXED_RECHARGE_RUNTIME_SCOPE' and value['id'] == RECHARGE_01CE_ID
        and type(value['enabled']) is bool and value['approvalStatus'] in ('NOT_APPROVED', 'APPROVED')
        and value['enabled'] == (value['approvalStatus'] == 'APPROVED')
        and value['expectedCurrent'] == RECHARGE_01CE_CURRENT, message)
    if require_approved: require(value['enabled'], 'Fixed recharge runtime scope is not approved')
    approved = value['enabled']
    digest = lambda item: isinstance(item, str) and re.fullmatch(r'[a-f0-9]{64}', item) is not None
    evidence = lambda item: digest(item) or (not approved and item is None)
    baseline = value['baselineRelease']
    require(isinstance(baseline, dict) and set(baseline) == {'commit', 'sourceTree', 'previousCommit',
        'deploymentRun', 'manifestSha256', 'beforeAuditSha256', 'afterAuditSha256', 'composeSha256',
        'overrideRawSha256', 'overrideCanonicalSha256'} and baseline['commit'] == RECHARGE_01CE_CURRENT
        and baseline['sourceTree'] == RECHARGE_01CE_TREE and baseline['previousCommit'] == RECHARGE_01CE_CHAIN[1][0]
        and ((isinstance(baseline['deploymentRun'], str) and re.fullmatch(
            r'github-actions-[1-9][0-9]*-[1-9][0-9]*', baseline['deploymentRun']))
            or (not approved and baseline['deploymentRun'] is None))
        and all(evidence(baseline[key]) for key in ('manifestSha256', 'beforeAuditSha256', 'afterAuditSha256',
            'composeSha256', 'overrideRawSha256', 'overrideCanonicalSha256')), message)
    native = value['nativeBaseline']
    require(isinstance(native, dict) and set(native) == RECHARGE_01CE_NATIVE_KEYS
        and native['producerSha256'] == RECHARGE_01CE_PRODUCER
        and all(evidence(native[key]) for key in RECHARGE_01CE_NATIVE_KEYS
            - {'producerSha256', 'nativeFileCount', 'nativeDirectoryCount'})
        and all((type(native[key]) is int and 0 < native[key] <= 100000)
            or (not approved and native[key] is None) for key in ('nativeFileCount', 'nativeDirectoryCount')), message)
    names = set()
    for key, expected in (('candidateSourceSha256', RECHARGE_01CE_CANDIDATES),
            ('carriedSourceOnlySha256', set(RECHARGE_01CE_CARRIED_SOURCE)), ('controlSourceSha256', RECHARGE_01CE_CONTROLS)):
        require(isinstance(value[key], dict) and set(value[key]) == expected
            and all(digest(item) for item in value[key].values()), message)
        names.update(expected)
    require(value['carriedSourceOnlySha256'] == RECHARGE_01CE_CARRIED_SOURCE
        and isinstance(value['sourceModes'], dict) and set(value['sourceModes']) == names
        and all(type(mode) is int and mode == 0o644 for mode in value['sourceModes'].values())
        and historical_fingerprint(value['scope']) == historical_fingerprint(RECHARGE_SCOPE_EXPECTED), message)
    finance = value['financeValidator']
    extra = {'releaseSealSha256', 'preparedImagesSha256', 'preparationRunId', 'preparationRunAttempt', 'images'}
    require(isinstance(finance, dict) and set(finance) == set(RECHARGE_MAIN80_FINANCE) | extra
        and {key: finance[key] for key in RECHARGE_MAIN80_FINANCE} == RECHARGE_MAIN80_FINANCE
        and all(evidence(finance[key]) for key in ('releaseSealSha256', 'preparedImagesSha256'))
        and all((type(finance[key]) is int and 0 < finance[key] <= 9007199254740991)
            or (not approved and finance[key] is None) for key in ('preparationRunId', 'preparationRunAttempt'))
        and ((not approved and finance['images'] is None) or (isinstance(finance['images'], dict)
            and set(finance['images']) == {'api', 'admin', 'migrate'} and all(isinstance(item, str)
                and re.fullmatch(r'sha256:[a-f0-9]{64}', item) for item in finance['images'].values()))), message)
    return value


def recharge_01ce_native_chain(previous):
    """Snapshot all ten fixed immutable releases; no private content escapes."""
    message = 'Fixed 01ce native chain changed'
    rows, directories, files = [], 0, 0
    identity = lambda x: (x.st_dev, x.st_ino, x.st_mode, x.st_uid, x.st_gid, x.st_nlink,
        x.st_size, x.st_mtime_ns, x.st_ctime_ns)
    directory = previous
    for index, (commit, tree) in enumerate(RECHARGE_01CE_CHAIN):
        require(directory.is_absolute() and directory.resolve() == directory and not directory.is_symlink()
            and directory.parent == BASE / 'releases'
            and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + commit[:12], directory.name), message)
        manifest = fixed_recharge_json(fixed_recharge_bytes(directory / 'release-manifest.json'))
        require(manifest.get('commit') == commit and manifest.get('sourceTree') == tree, message)
        entries, folders, before = {}, {}, {}
        for path in (directory, *sorted(directory.rglob('*'))):
            info = path.lstat(); before[path] = identity(info)
            name = '.' if path == directory else str(path.relative_to(directory))
            require(not path.is_symlink() and not any(parent.is_symlink() for parent in path.parents
                if parent == directory or directory in parent.parents), message)
            mode = stat.S_IMODE(info.st_mode)
            if stat.S_ISDIR(info.st_mode):
                require(mode in (0o700, 0o750, 0o755, 0o775), message)
                folders[name] = [mode, info.st_uid, info.st_gid]; directories += 1
            else:
                raw = fixed_recharge_bytes(path, modes=(0o400, 0o600, 0o644, 0o664, 0o755, 0o775))
                entries[name] = [hashlib.sha256(raw).hexdigest(), mode, info.st_uid, info.st_gid]; files += 1
            require(identity(path.lstat()) == before[path], message)
        require(all(identity(path.lstat()) == original for path, original in before.items()), message)
        rows.append({'commit': commit, 'tree': tree, 'release': str(directory), 'files': entries, 'directories': folders})
        if index + 1 < len(RECHARGE_01CE_CHAIN):
            require(manifest.get('previousCommit') == RECHARGE_01CE_CHAIN[index + 1][0], message)
            directory = Path(manifest['previousRelease'])
    external = {}
    for path in (ORDER_ARCHIVE_SEAL, POST_CLEANUP_RECEIPT):
        info = path.lstat(); raw = fixed_recharge_bytes(path, modes=(0o600,))
        external[str(path)] = [hashlib.sha256(raw).hexdigest(), stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid]
        require(identity(info) == identity(path.lstat()), message)
    return {'sha256': historical_fingerprint({'releases': rows, 'external': external}),
        'fileCount': files, 'directoryCount': directories, 'origin': directory}


def recharge_01ce_baseline_fields(previous):
    manifest = fixed_recharge_json(fixed_recharge_bytes(previous / 'release-manifest.json'))
    require(manifest.get('commit') == RECHARGE_01CE_CURRENT and manifest.get('sourceTree') == RECHARGE_01CE_TREE
        and manifest.get('previousCommit') == RECHARGE_01CE_CHAIN[1][0]
        and manifest.get('servicesUpdated') == ['admin', 'auto-registration'] and manifest.get('migrationApplied') is False
        and manifest.get('newMigrations') == [] and manifest.get('databaseGrants') == {
            'status': 'SKIPPED', 'reason': 'FIXED_REGISTRATION_NO_MIGRATIONS'}, 'Fixed 01ce native baseline changed')
    result = {key: manifest[key] for key in ('commit', 'sourceTree', 'previousCommit', 'deploymentRun')}
    for name, key, modes in (('release-manifest.json', 'manifestSha256', (0o600,)),
            ('before-audit.json', 'beforeAuditSha256', (0o400, 0o600)), ('after-audit.json', 'afterAuditSha256', (0o400, 0o600)),
            ('docker-compose.aws-mysql.yml', 'composeSha256', (0o644, 0o664)),
            ('compose.release.json', 'overrideRawSha256', (0o400, 0o600, 0o644))):
        result[key] = hashlib.sha256(fixed_recharge_bytes(previous / name, modes=modes)).hexdigest()
    result['overrideCanonicalSha256'] = historical_fingerprint(fixed_recharge_json(fixed_recharge_bytes(
        previous / 'compose.release.json', modes=(0o400, 0o600, 0o644))))
    return result


def recharge_01ce_observe_native(previous=None):
    """Before-only original producer proof. Never run this global-current entry after publication."""
    previous = previous or (BASE / 'current').resolve()
    require((BASE / 'current').resolve() == previous, 'Fixed 01ce native current changed')
    baseline = recharge_01ce_baseline_fields(previous)
    producer = fixed_recharge_bytes(previous / 'scripts/production-release/remote-deploy.py', modes=(0o644, 0o664))
    require(hashlib.sha256(producer).hexdigest() == RECHARGE_01CE_PRODUCER, 'Fixed 01ce native producer changed')
    profile_raw = fixed_recharge_bytes(previous / REGISTRATION_HYDRATION_FILE, modes=(0o644, 0o664), limit=128 * 1024)
    raw_hash = hashlib.sha256(profile_raw).hexdigest()
    namespace = {'__name__': 'fixed_01ce_native_producer', '__file__': str(previous / 'scripts/production-release/remote-deploy.py')}
    exec(compile(producer, namespace['__file__'], 'exec'), namespace)
    namespace['BASE'] = BASE
    native_readback = namespace['check_fixed_registration_deployment'](RECHARGE_01CE_CURRENT,
        RECHARGE_01CE_TREE, raw_hash, profile_id=REGISTRATION_HYDRATION_ID)
    validate_fixed_registration_readback_projection(native_readback, RECHARGE_01CE_CURRENT,
        RECHARGE_01CE_TREE, raw_hash, profile_id=REGISTRATION_HYDRATION_ID)
    states = {name: service_state(previous, name, include_container_id=True, include_environment_hash=True) for name in ALL_SERVICES}
    chain = recharge_01ce_native_chain(previous)
    result = {'producerSha256': RECHARGE_01CE_PRODUCER, 'registrationProfileRawSha256': raw_hash,
        'registrationReadbackSha256': historical_fingerprint(native_readback), 'nativeChainSha256': chain['sha256'],
        'runtimeStatesSha256': historical_fingerprint(states), 'preservedStatesSha256': historical_fingerprint(main80_recharge_preserved_states(states)),
        'nativeFileCount': chain['fileCount'], 'nativeDirectoryCount': chain['directoryCount']}
    require(recharge_01ce_baseline_fields(previous) == baseline and recharge_01ce_native_chain(previous) == chain
        and (BASE / 'current').resolve() == previous and {name: service_state(previous, name,
            include_container_id=True, include_environment_hash=True) for name in ALL_SERVICES} == states,
        'Fixed 01ce native observation changed')
    return {'baselineRelease': baseline, 'nativeBaseline': result}


def recharge_01ce_baseline(previous, profile, manifest, *, verify_native=False):
    recharge_01ce_scope(profile)
    message = 'Fixed 01ce native baseline changed'
    require(recharge_01ce_baseline_fields(previous) == profile['baselineRelease']
        and fixed_recharge_json(fixed_recharge_bytes(previous / 'release-manifest.json')) == manifest, message)
    chain = recharge_01ce_native_chain(previous)
    native = profile['nativeBaseline']
    require(chain['sha256'] == native['nativeChainSha256'] and chain['fileCount'] == native['nativeFileCount']
        and chain['directoryCount'] == native['nativeDirectoryCount'], message)
    raw = fixed_recharge_bytes(previous / REGISTRATION_HYDRATION_FILE, modes=(0o644, 0o664), limit=128 * 1024)
    require(hashlib.sha256(raw).hexdigest() == native['registrationProfileRawSha256']
        and hashlib.sha256(fixed_recharge_bytes(previous / 'scripts/production-release/remote-deploy.py',
            modes=(0o644, 0o664))).hexdigest() == RECHARGE_01CE_PRODUCER, message)
    receipt = registration_readback_receipt(RECHARGE_01CE_CURRENT, RECHARGE_01CE_TREE,
        native['registrationProfileRawSha256'], profile_id=REGISTRATION_HYDRATION_ID)
    require(historical_fingerprint(receipt) == native['registrationReadbackSha256'], message)
    if verify_native:
        require(recharge_01ce_observe_native(previous) == {'baselineRelease': profile['baselineRelease'], 'nativeBaseline': native}, message)
    old_profile = parse_fixed_recharge_scope(fixed_recharge_bytes(previous / RECHARGE_MAIN80_FILE,
        modes=(0o644, 0o664), limit=128 * 1024))
    require(old_profile['id'] == RECHARGE_MAIN80_ID and old_profile['financeValidator'] == profile['financeValidator'], message)
    main80_recharge_reader_evidence(previous)
    return chain['origin'], old_profile


def recharge_01ce_context(args, profile, before_gate, after_gate):
    recharge_01ce_scope(profile)
    require(args.expected_current == RECHARGE_01CE_CURRENT and re.fullmatch(r'[a-f0-9]{40}', args.commit or '')
        and args.commit != RECHARGE_01CE_CURRENT and re.fullmatch(r'[a-f0-9]{40}', args.source_tree or ''), 'Fixed 01ce recharge context changed')
    for stage, gate in (('before', before_gate), ('after', after_gate)):
        require(isinstance(gate, dict) and set(gate) == {'checkCount', 'violationCount', 'registrationFinanceGate'}
            and type(gate['checkCount']) is int and gate['checkCount'] == 49
            and type(gate['violationCount']) is int and gate['violationCount'] == 0
            and gate['registrationFinanceGate'].get('stage') == stage
            and gate['registrationFinanceGate'].get('candidateCommit') == RECHARGE_MAIN80_FINANCE_CURRENT
            and gate['registrationFinanceGate'].get('candidateTree') == RECHARGE_MAIN80_FINANCE_TREE,
            'Fixed 01ce fresh integrity gate failed')
    return {'version': 1, 'id': RECHARGE_01CE_ID, 'profileSha256': historical_fingerprint(profile),
        'expectedCurrent': RECHARGE_01CE_CURRENT, 'sourceCommit': args.commit, 'sourceTree': args.source_tree,
        'servicesUpdated': ['auto-recharge'], 'financeValidator': REGISTRATION_CLEARANCE['mode'],
        'sourceCommitForFinance': RECHARGE_MAIN80_FINANCE_CURRENT, 'originCommitForFinance': HISTORY_ORDER_ARCHIVE_BASELINE,
        'nativeChainSha256': profile['nativeBaseline']['nativeChainSha256'],
        'beforeGateSha256': historical_fingerprint(before_gate['registrationFinanceGate']),
        'afterGateSha256': historical_fingerprint(after_gate['registrationFinanceGate']),
        'unchangedServiceContainersPreserved': True, 'environmentUnchanged': True,
        'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED', 'cacheStatus': 'SKIPPED'}


def recharge_01ce_readback_receipt(expected_current, source_tree, profile_sha256):
    require(re.fullmatch(r'[a-f0-9]{40}', expected_current or '') and expected_current != RECHARGE_01CE_CURRENT
        and re.fullmatch(r'[a-f0-9]{40}', source_tree or '') and re.fullmatch(r'[a-f0-9]{64}', profile_sha256 or ''),
        'Fixed recharge deployment verification unavailable')
    return {'version': 1, 'id': RECHARGE_01CE_ID, 'status': 'VERIFIED', 'currentCommit': expected_current,
        'sourceTree': source_tree, 'previousCommit': RECHARGE_01CE_CURRENT, 'profileSha256': profile_sha256,
        'servicesUpdated': ['auto-recharge'], 'preservedServiceCount': 6, 'checkCount': 49,
        'executedCheckCount': 49, 'unavailableCheckCount': 0, 'violationCount': 0, 'storedGatesMatched': True,
        'unchangedServiceContainersPreserved': True, 'environmentUnchanged': True,
        'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED', 'cacheStatus': 'SKIPPED',
        'liveServicesHealthy': True, 'rechargeImageMatched': True}


def validate_recharge_01ce_readback_projection(value, expected_current, source_tree, profile_sha256):
    expected = recharge_01ce_readback_receipt(expected_current, source_tree, profile_sha256)
    require(isinstance(value, dict) and set(value) == set(expected)
        and historical_fingerprint(value) == historical_fingerprint(expected), 'Fixed recharge deployment verification unavailable')
    return value


def verify_recharge_01ce_candidate_source(directory, archive_data, profile):
    recharge_01ce_scope(profile)
    with tarfile.open(fileobj=io.BytesIO(archive_data), mode='r:gz') as archive:
        names = set(fixed_recharge_archive(archive, profile_id=RECHARGE_01CE_ID))
    approved = set(profile['candidateSourceSha256']) | set(profile['carriedSourceOnlySha256']) | set(profile['controlSourceSha256'])
    generated = ('.env.aws.production', 'compose.release.json', 'release-manifest.json', 'before-audit.json',
        'after-audit.json', 'backup-verification.json', 'order-archive-seal.reader.json', 'order-archive-cleanup.reader.json')
    files = fixed_recharge_file_map(directory, allowed=names | approved | {RECHARGE_01CE_FILE}, omitted=generated)
    with tarfile.open(fileobj=io.BytesIO(archive_data), mode='r:gz') as archive:
        verify_fixed_recharge_archive(directory, archive, profile, names=list(files))
    return main80_recharge_public_snapshot(directory, files)


def recharge_01ce_audit(directory, receipt, *, stage, source, auditor_source, profile, previous, before_receipt=None):
    recharge_01ce_scope(profile)
    _, finance_profile = recharge_01ce_baseline(previous, profile,
        fixed_recharge_json(fixed_recharge_bytes(previous / 'release-manifest.json')))
    result = main80_recharge_audit(directory, receipt, stage=stage, source=source, auditor_source=auditor_source,
        profile=finance_profile, before_receipt=before_receipt, control_source=previous)
    recharge_01ce_baseline(previous, profile, fixed_recharge_json(fixed_recharge_bytes(previous / 'release-manifest.json')))
    return result


def recharge_01ce_candidate_link(current, previous, manifest, expected_current, source_tree, profile):
    message = 'Fixed 01ce candidate link changed'
    require(current.is_absolute() and current.resolve() == current and current.parent == BASE / 'releases'
        and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + expected_current[:12], current.name)
        and (BASE / 'current').resolve() == current and manifest.get('commit') == expected_current
        and manifest.get('sourceTree') == source_tree and manifest.get('previousCommit') == RECHARGE_01CE_CURRENT
        and manifest.get('previousRelease') == str(previous) and manifest.get('servicesUpdated') == ['auto-recharge']
        and manifest.get('migrationApplied') is False and manifest.get('newMigrations') == []
        and manifest.get('databaseGrants') == {'status': 'SKIPPED', 'reason': 'FIXED_RECHARGE_NO_MIGRATIONS'}, message)
    baseline = fixed_recharge_json(fixed_recharge_bytes(previous / 'release-manifest.json'))
    require(manifest.get('fixedRegistrationRelease') == baseline.get('fixedRegistrationRelease')
        and manifest.get('fixedRegistrationPreservedStates') == baseline.get('fixedRegistrationPreservedStates')
        and manifest.get('googleDriveSyncFolderId') == baseline.get('googleDriveSyncFolderId'), message)
    require(fixed_recharge_bytes(current / '.env.aws.production') == fixed_recharge_bytes(previous / '.env.aws.production')
        and fixed_recharge_bytes(current / 'docker-compose.aws-mysql.yml', modes=(0o644, 0o664))
            == fixed_recharge_bytes(previous / 'docker-compose.aws-mysql.yml', modes=(0o644, 0o664))
        and fixed_recharge_bytes(current / 'deploy/caddy/Caddyfile.aws', modes=(0o644, 0o664))
            == fixed_recharge_bytes(previous / 'deploy/caddy/Caddyfile.aws', modes=(0o644, 0o664)), message)
    snapshots = manifest.get('fixedRechargePreservedStates')
    live = {name: service_state(current, name, include_container_id=True, include_environment_hash=True) for name in ALL_SERVICES}
    require(isinstance(snapshots, dict) and set(snapshots) == {'before', 'after'}
        and snapshots['before'] == snapshots['after'] == main80_recharge_preserved_states(live)
        and historical_fingerprint(snapshots['before']) == profile['nativeBaseline']['preservedStatesSha256']
        and all(row['status'] == 'running' for row in live.values())
        and all(live[name]['health'] == 'healthy' for name in ALL_SERVICES if name != 'caddy'), message)
    images = manifest['images']
    require(set(images) == set(baseline['images']) and all(images[name] == baseline['images'][name]
        for name in images if name != 'auto-recharge'), message)
    override = fixed_recharge_json(fixed_recharge_bytes(current / 'compose.release.json', modes=(0o400, 0o600, 0o644)))
    require(override == {'services': {name: {'image': images[name]['reference'], 'pull_policy': 'never'}
        for name in (*SERVICES, 'migrate')}}, message)
    image, run_id = images['auto-recharge'], manifest['deploymentRun']
    require(re.fullmatch(r'github-actions-[1-9][0-9]*-[1-9][0-9]*', run_id or '')
        and manifest.get('imageBuildRun') == run_id and image.get('sourceCommit') == expected_current
        and re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
            + expected_current + '-' + run_id.removeprefix('github-actions-') + '-auto-recharge', image.get('reference', ''))
        and live['auto-recharge']['reference'] == image['reference'] and live['auto-recharge']['image'] == image['digest'], message)
    metadata = json.loads(run('docker', 'image', 'inspect', image['digest']))
    require(isinstance(metadata, list) and len(metadata) == 1 and metadata[0]['Id'] == image['digest']
        and metadata[0]['Architecture'] == 'amd64'
        and metadata[0]['Config']['Labels'].get('org.opencontainers.image.revision') == expected_current, message)
    return live


def check_recharge_01ce_deployment(expected_current, source_tree, profile_sha256):
    try:
        projection = recharge_01ce_readback_receipt(expected_current, source_tree, profile_sha256)
        current = (BASE / 'current').resolve()
        profile = parse_fixed_recharge_scope(fixed_recharge_bytes(current / RECHARGE_01CE_FILE,
            modes=(0o644, 0o664), limit=128 * 1024))
        require(profile['id'] == RECHARGE_01CE_ID and historical_fingerprint(profile) == profile_sha256,
            'Fixed 01ce candidate profile changed')
        manifest = fixed_recharge_json(fixed_recharge_bytes(current / 'release-manifest.json'))
        previous = Path(manifest['previousRelease'])
        baseline = fixed_recharge_json(fixed_recharge_bytes(previous / 'release-manifest.json'))
        origin, _finance_profile = recharge_01ce_baseline(previous, profile, baseline)
        live = recharge_01ce_candidate_link(current, previous, manifest, expected_current, source_tree, profile)
        archive_data = fixed_recharge_runtime_archive(profile)
        public = verify_recharge_01ce_candidate_source(current, archive_data, profile)
        frozen = fixed_recharge_json(fixed_recharge_bytes(origin / 'before-audit.json'))['gate']
        gates, facts = {}, []
        for stage in ('before', 'after'):
            report = fixed_recharge_json(fixed_recharge_bytes(current / (stage + '-audit.json')))
            original = fixed_recharge_json(fixed_recharge_bytes(previous / (stage + '-audit.json')))
            gates[stage] = require_registration_zero_report(report, stage, frozen)
            require_registration_zero_report(original, stage, frozen)
            require(gates[stage] == manifest['dataAudit' + stage.title()]
                and report['checks'] == original['checks'] and report['identity'] == original['identity'],
                'Fixed 01ce complete audit facts changed')
            facts.append((report['checks'], report['identity']))
        require(facts[0] == facts[1] and manifest['fixedRechargeRelease'] == recharge_01ce_context(
            argparse.Namespace(commit=expected_current, source_tree=source_tree, expected_current=RECHARGE_01CE_CURRENT),
            profile, gates['before'], gates['after']), 'Fixed 01ce stored gate changed')
        main80_recharge_reader_evidence(current)
        # No original global-current producer entry is invoked after the 01ce successor is current.
        recharge_01ce_baseline(previous, profile, baseline)
        require(recharge_01ce_candidate_link(current, previous, fixed_recharge_json(fixed_recharge_bytes(
            current / 'release-manifest.json')), expected_current, source_tree, profile) == live, 'Fixed 01ce readback tail changed')
        require_main80_recharge_public_snapshot(public)
        require(parse_fixed_recharge_scope(fixed_recharge_bytes(current / RECHARGE_01CE_FILE,
            modes=(0o644, 0o664), limit=128 * 1024)) == profile, 'Fixed 01ce readback profile changed')
        return validate_recharge_01ce_readback_projection(projection, expected_current, source_tree, profile_sha256)
    except Exception:
        raise RuntimeError('Fixed recharge deployment verification unavailable') from None


def recharge_01ce_pull_image(repository, commit, run_id, run_attempt):
    """Use the Docker Unix API; registry authentication never enters a file or argv."""
    import http.client
    import socket
    registry = repository.split('/')[0]
    require(re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release', repository),
        'Fixed 01ce image repository changed')
    version = run('docker', 'version', '--format', '{{.Server.APIVersion}}')
    require(re.fullmatch(r'[0-9]+\.[0-9]+', version), 'Fixed 01ce Docker API unavailable')
    context = json.loads(run('docker', 'context', 'inspect'))
    endpoint = context[0]['Endpoints']['docker']['Host']
    require(len(context) == 1 and endpoint.startswith('unix://') and not context[0]['Endpoints']['docker'].get('SkipTLSVerify'),
        'Fixed 01ce Docker endpoint unavailable')
    password = run('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1')
    auth = base64.urlsafe_b64encode(json.dumps({'username': 'AWS', 'password': password,
        'serveraddress': registry}, separators=(',', ':')).encode()).decode()
    password = None
    class UnixConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(self.timeout); self.sock.connect(endpoint.removeprefix('unix://'))
    connection = UnixConnection('localhost', timeout=900)
    tag = commit + '-' + run_id + '-' + run_attempt + '-auto-recharge'
    try:
        connection.request('POST', '/v' + version + '/images/create?' + urlencode({
            'fromImage': repository, 'tag': tag, 'platform': 'linux/amd64'}), body=b'',
            headers={'X-Registry-Auth': auth, 'Content-Length': '0'})
        auth = None
        response = connection.getresponse()
        require(response.status == 200, 'Fixed 01ce recharge image pull failed')
        while True:
            line = response.readline(1024 * 1024 + 1)
            if not line: break
            require(len(line) <= 1024 * 1024, 'Fixed 01ce recharge image pull failed')
            record = json.loads(line)
            require(isinstance(record, dict) and not record.get('error') and not record.get('errorDetail'),
                'Fixed 01ce recharge image pull failed')
        reference = repository + ':' + tag
        metadata = json.loads(run('docker', 'image', 'inspect', reference))
        require(len(metadata) == 1 and metadata[0]['Architecture'] == 'amd64'
            and metadata[0]['Config']['Labels'].get('org.opencontainers.image.revision') == commit,
            'Fixed 01ce recharge image provenance changed')
        return reference, metadata[0]['Id']
    except Exception:
        raise RuntimeError('Fixed 01ce recharge image pull unavailable') from None
    finally:
        auth = None; connection.close()


def recharge_01ce_release(args):
    message = 'Fixed 01ce recharge release unavailable'
    require(getattr(args, 'recharge_pro_01ce', False) is True and not args.admin_only
        and all(not getattr(args, key, False) for key in ('historical_finance_exception', 'historical_finance_continuation',
            'historical_finance_recharge_diagnostics', 'historical_finance_maintenance_continuation',
            'historical_finance_mailbox_batch', 'historical_finance_post_cleanup', 'historical_finance_order_archive',
            'recharge_pro_menu_b8', 'recharge_pro_menu_7f', 'recharge_pro_main80', 'registration_worker_b8_80',
            'registration_worker_956', 'registration_worker_85', 'registration_worker_86', 'registration_worker_87',
            'registration_worker_88', 'registration_worker_89', 'registration_worker_90', 'registration_worker_91', 'post_cleanup_seal_sha256', 'order_archive_seal_sha256',
            'order_archive_prepared_images_sha256')) and args.expected_current == RECHARGE_01CE_CURRENT, message)
    require(re.fullmatch(r'[a-f0-9]{40}', args.commit or '') and args.commit != RECHARGE_01CE_CURRENT
        and re.fullmatch(r'[a-f0-9]{40}', args.source_tree or '')
        and re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release', args.repository or '')
        and all(re.fullmatch(r'[1-9][0-9]*', item or '') for item in (args.run_id, args.run_attempt, args.ci_run_id)), message)
    require_diagnostics_release_arguments(args, args.image_commit or args.commit,
        args.image_run_id or args.run_id, args.image_run_attempt or args.run_attempt)
    os.umask(0o077)
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = (BASE / 'current').resolve()
        old_manifest = fixed_recharge_json(fixed_recharge_bytes(previous / 'release-manifest.json'))
        with urllib.request.urlopen('https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/'
                + args.commit + '/' + RECHARGE_01CE_FILE, timeout=30) as response:
            profile_raw = response.read(128 * 1024 + 1)
        profile = parse_fixed_recharge_scope(profile_raw)
        require(profile['id'] == RECHARGE_01CE_ID, message)
        origin, _finance_profile = recharge_01ce_baseline(previous, profile, old_manifest, verify_native=True)
        states = {name: service_state(previous, name, include_container_id=True, include_environment_hash=True) for name in ALL_SERVICES}
        require(historical_fingerprint(states) == profile['nativeBaseline']['runtimeStatesSha256'], message)
        assert_release_jobs_idle(previous, ('auto-recharge',))
        baseline_archive = fixed_recharge_runtime_archive(profile)
        finance_source = prepare_registration_finance_source(args, registration_download(REGISTRATION_CURRENT))
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        release = BASE / 'releases' / (stamp + '-' + args.commit[:12])
        require(not release.exists(), message); release.mkdir(mode=0o700)
        changed = False; step = 'source'
        try:
            candidate_raw = registration_download(args.commit)
            candidate = registration_archive(candidate_raw, args.commit)
            write_registration_files(release, candidate)
            require(fixed_recharge_bytes(release / RECHARGE_01CE_FILE, modes=(0o644, 0o664), limit=128 * 1024) == profile_raw, message)
            normalize_fixed_recharge_modes(release, profile)
            with tarfile.open(fileobj=io.BytesIO(baseline_archive), mode='r:gz') as archive:
                verify_fixed_recharge_archive(release, archive, profile)
            for name in ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws'):
                require(fixed_recharge_bytes(release / name, modes=(0o644, 0o664))
                    == fixed_recharge_bytes(previous / name, modes=(0o644, 0o664)), message)
            shutil.copy2(previous / '.env.aws.production', release / '.env.aws.production'); (release / '.env.aws.production').chmod(0o600)
            environment = fixed_recharge_bytes(previous / '.env.aws.production')
            require_diagnostics_environment_unchanged(previous, release, environment)
            require_diagnostics_migration_scope(migration_plan(previous, release), False)
            require(shutil.disk_usage(BASE).free > 6 * 1024**3, 'Insufficient free disk before pull')
            step = 'audit-before'
            before_audit = recharge_01ce_audit(previous, release / 'before-audit.json', stage='before', source=origin,
                auditor_source=finance_source, profile=profile, previous=previous)
            step = 'images'
            reference, image_id = recharge_01ce_pull_image(args.repository, args.commit, args.run_id, args.run_attempt)
            override = fixed_recharge_json(fixed_recharge_bytes(previous / 'compose.release.json', modes=(0o400, 0o600, 0o644)))
            override['services']['auto-recharge'] = {'image': reference, 'pull_policy': 'never'}
            (release / 'compose.release.json').write_text(json.dumps(override, indent=2) + '\n')
            require(fixed_recharge_json(compose(release, 'config', '--format', 'json').encode())['name']
                == fixed_recharge_json(compose(previous, 'config', '--format', 'json').encode())['name'], message)
            require(shutil.disk_usage(BASE).free > 2 * 1024**3, 'Insufficient free disk after pull')
            step = 'backup'; backup = fresh_backup(previous)
            (release / 'backup-verification.json').write_text(json.dumps(backup, indent=2) + '\n'); (release / 'backup-verification.json').chmod(0o600)
            require((BASE / 'current').resolve() == previous and {name: service_state(previous, name,
                include_container_id=True, include_environment_hash=True) for name in ALL_SERVICES} == states, message)
            recharge_01ce_baseline(previous, profile, old_manifest)
            assert_release_jobs_idle(previous, ('auto-recharge',)); assert_no_active_recharge(previous)
            step = 'switch'; changed = True
            compose(release, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'auto-recharge', timeout=300)
            wait_healthy(release, 'auto-recharge')
            step = 'audit-after'
            after_audit = recharge_01ce_audit(release, release / 'after-audit.json', stage='after', source=origin,
                auditor_source=finance_source, profile=profile, previous=previous, before_receipt=release / 'before-audit.json')
            after = {name: service_state(release, name, include_container_id=True, include_environment_hash=True) for name in ALL_SERVICES}
            require(main80_recharge_preserved_states(after) == main80_recharge_preserved_states(states)
                and after['auto-recharge']['image'] == image_id and after['auto-recharge']['reference'] == reference
                and all(row['status'] == 'running' for row in after.values())
                and all(after[name]['health'] == 'healthy' for name in ALL_SERVICES if name != 'caddy'), message)
            require_diagnostics_environment_unchanged(previous, release, environment)
            recharge_01ce_baseline(previous, profile, old_manifest)
            public_url = environment_values(release / '.env.aws.production')['APP_PUBLIC_URL'].rstrip('/')
            for suffix in ('/api/health/ready', '/'):
                with urllib.request.urlopen(public_url + suffix, timeout=20) as response:
                    require(response.status == 200, 'Public readiness failed')
            public = verify_recharge_01ce_candidate_source(release, baseline_archive, profile)
            recharge_01ce_baseline(previous, profile, old_manifest)
            require((BASE / 'current').resolve() == previous and {name: service_state(release, name,
                include_container_id=True, include_environment_hash=True) for name in ALL_SERVICES} == after, message)
            require_main80_recharge_public_snapshot(public)
            manifest = dict(old_manifest)
            manifest.pop('mailboxPreservedStates', None)
            manifest.update(commit=args.commit, sourceBranch='main', sourceTree=args.source_tree,
                previousCommit=RECHARGE_01CE_CURRENT, previousRelease=str(previous), deploymentRun='github-actions-' + args.run_id + '-' + args.run_attempt,
                imageBuildRun='github-actions-' + args.run_id + '-' + args.run_attempt, ciWorkflow='Quality Gate', ciWorkflowRunId=int(args.ci_run_id),
                releaseTag='v2-production-' + stamp, deployedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                sourceArchiveSha256=hashlib.sha256(candidate_raw).hexdigest(), servicesUpdated=['auto-recharge'], migrationApplied=False,
                newMigrations=[], databaseGrants={'status': 'SKIPPED', 'reason': 'FIXED_RECHARGE_NO_MIGRATIONS'},
                dataAuditBefore=before_audit, dataAuditAfter=after_audit, backupBeforeRelease=backup['name'],
                rollback={'release': str(previous), 'images': {'auto-recharge': states['auto-recharge']['image']}, 'servicesAdded': []})
            manifest['images'] = {**old_manifest['images'], 'auto-recharge': {'reference': reference, 'digest': image_id, 'sourceCommit': args.commit}}
            manifest['fixedRechargeRelease'] = recharge_01ce_context(args, profile, before_audit, after_audit)
            manifest['fixedRechargePreservedStates'] = {'before': main80_recharge_preserved_states(states), 'after': main80_recharge_preserved_states(after)}
            manifest.pop('prCiRunId', None)
            (release / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n'); (release / 'release-manifest.json').chmod(0o600)
            point_current(release, stamp + '-publish')
            check_recharge_01ce_deployment(args.commit, args.source_tree, historical_fingerprint(profile))
            print(json.dumps({'status': 'DEPLOYED', 'commit': args.commit, 'releaseTag': manifest['releaseTag'],
                'servicesUpdated': ['auto-recharge'], 'migrationApplied': False, 'backupVerified': True,
                'auditViolations': 0, 'unchangedServiceContainersPreserved': True}), flush=True)
            return 0
        except Exception:
            rollback_ok = True
            if (BASE / 'current').resolve() == release:
                try: point_current(previous, stamp + '-recover')
                except Exception: rollback_ok = False
            if changed:
                try: rollback_service(previous, release, 'auto-recharge', states)
                except Exception: rollback_ok = False
            print(json.dumps({'status': 'FAILED_ROLLED_BACK' if rollback_ok else 'FAILED_ROLLBACK_INCOMPLETE',
                'step': step, 'commit': args.commit, 'previousCommit': RECHARGE_01CE_CURRENT,
                'error': 'Fixed 01ce recharge release check failed; raw output suppressed'}), file=sys.stderr, flush=True)
            return 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--commit', required=True)
    parser.add_argument('--source-tree', required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--expected-current', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--run-attempt', required=True)
    parser.add_argument('--ci-run-id', required=True)
    parser.add_argument('--image-commit')
    parser.add_argument('--image-run-id')
    parser.add_argument('--image-run-attempt')
    parser.add_argument('--admin-only', action='store_true')
    parser.add_argument('--historical-finance-exception', action='store_true')
    parser.add_argument('--historical-finance-continuation', action='store_true')
    parser.add_argument('--historical-finance-recharge-diagnostics', action='store_true')
    parser.add_argument('--historical-finance-maintenance-continuation', action='store_true')
    parser.add_argument('--historical-finance-mailbox-batch', action='store_true')
    parser.add_argument('--recharge-pro-menu-b8', action='store_true')
    parser.add_argument('--historical-finance-post-cleanup', action='store_true')
    parser.add_argument('--post-cleanup-seal-sha256')
    parser.add_argument('--historical-finance-order-archive', action='store_true')
    parser.add_argument('--order-archive-seal-sha256')
    parser.add_argument('--order-archive-prepared-images-sha256')
    parser.add_argument('--recharge-pro-menu-7f', action='store_true')
    parser.add_argument('--recharge-pro-main80', action='store_true')
    parser.add_argument('--recharge-pro-01ce', action='store_true')
    parser.add_argument('--registration-worker-b8-80', action='store_true')
    parser.add_argument('--registration-worker-956', action='store_true')
    parser.add_argument('--registration-worker-85', action='store_true')
    parser.add_argument('--registration-worker-86', action='store_true')
    parser.add_argument('--registration-worker-87', action='store_true')
    parser.add_argument('--registration-worker-88', action='store_true')
    parser.add_argument('--registration-worker-89', action='store_true')
    parser.add_argument('--registration-worker-90', action='store_true')
    parser.add_argument('--registration-worker-91', action='store_true')
    args = parser.parse_args()
    if args.recharge_pro_01ce:
        return recharge_01ce_release(args)
    recharge_requested = args.recharge_pro_menu_b8 or args.recharge_pro_menu_7f or args.recharge_pro_main80
    require(not ((args.registration_worker_b8_80 or args.registration_worker_956 or args.registration_worker_85 or args.registration_worker_86 or args.registration_worker_87 or args.registration_worker_88 or args.registration_worker_89 or args.registration_worker_90 or args.registration_worker_91) and recharge_requested),
            'Historical release selection is ambiguous')
    if args.registration_worker_b8_80 or args.registration_worker_956 or args.registration_worker_85 or args.registration_worker_86 or args.registration_worker_87 or args.registration_worker_88 or args.registration_worker_89 or args.registration_worker_90 or args.registration_worker_91:
        return registration_release(args)
    recharge_profile_id = (RECHARGE_MAIN80_ID if args.recharge_pro_main80 else
        RECHARGE_7F_ID if args.recharge_pro_menu_7f else RECHARGE_SCOPE_ID)
    recharge_binding = fixed_recharge_binding(recharge_profile_id) if recharge_requested else None
    require(re.fullmatch(r'[0-9a-f]{40}', args.commit), 'Invalid commit')
    require(re.fullmatch(r'[0-9a-f]{40}', args.source_tree), 'Invalid source tree')
    require(re.fullmatch(r'[0-9a-f]{40}', args.expected_current), 'Invalid current commit')
    require(sum((args.historical_finance_exception, args.historical_finance_continuation,
                 args.historical_finance_recharge_diagnostics,
                 args.historical_finance_maintenance_continuation, args.historical_finance_mailbox_batch,
                 args.recharge_pro_menu_b8, args.recharge_pro_menu_7f, args.recharge_pro_main80, args.historical_finance_post_cleanup,
                 args.historical_finance_order_archive)) <= 1,
            'Historical release selection is ambiguous')
    require(bool(args.post_cleanup_seal_sha256) == args.historical_finance_post_cleanup,
            'Post-cleanup publication requires an explicit reviewed seal')
    require(bool(args.order_archive_seal_sha256) == args.historical_finance_order_archive
            and bool(args.order_archive_prepared_images_sha256) == args.historical_finance_order_archive,
            'Order archive publication requires independent reviewed seal and prepared image evidence')
    historical_policy_id = (HISTORY_MAINTENANCE_POLICY_ID if args.historical_finance_maintenance_continuation else
        HISTORY_ORDER_ARCHIVE_POLICY_ID if args.historical_finance_order_archive else
        HISTORY_POST_CLEANUP_POLICY_ID if args.historical_finance_post_cleanup else
        HISTORY_DIAGNOSTICS_POLICY_ID if args.historical_finance_recharge_diagnostics else
        HISTORY_CONTINUATION_POLICY_ID if args.historical_finance_continuation else HISTORY_POLICY_ID)
    if (args.historical_finance_exception or args.historical_finance_continuation
            or args.historical_finance_recharge_diagnostics
            or args.historical_finance_maintenance_continuation or args.historical_finance_post_cleanup
            or args.historical_finance_order_archive):
        require_historical_baseline(historical_policy_id, args.expected_current)
    require(not (args.historical_finance_continuation and args.admin_only),
            'Historical registration continuation requires Worker publication')
    require(re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release', args.repository), 'Invalid image repository')
    require(re.fullmatch(r'[0-9]+', args.run_id), 'Invalid workflow run')
    require(re.fullmatch(r'[1-9][0-9]*', args.run_attempt), 'Invalid workflow attempt')
    require(re.fullmatch(r'[1-9][0-9]*', args.ci_run_id), 'Invalid Quality Gate run')
    image_commit = args.image_commit or args.commit
    image_run = args.image_run_id or args.run_id
    image_attempt = args.image_run_attempt or args.run_attempt
    require(re.fullmatch(r'[0-9a-f]{40}', image_commit), 'Invalid image commit')
    require(re.fullmatch(r'[1-9][0-9]*', image_run), 'Invalid image workflow run')
    require(re.fullmatch(r'[1-9][0-9]*', image_attempt), 'Invalid image workflow attempt')
    if args.historical_finance_mailbox_batch:
        require_mailbox_release_arguments(args, image_commit, image_run, image_attempt)
    if args.historical_finance_maintenance_continuation:
        require_maintenance_release_arguments(args, image_commit, image_run, image_attempt)
    if args.historical_finance_recharge_diagnostics:
        require_diagnostics_release_arguments(args, image_commit, image_run, image_attempt)
    recharge_profile = None
    baseline_archive = None
    finance_archive = None
    finance_source = None
    auditor_source = None
    if recharge_requested:
        require(args.expected_current == recharge_binding['current'], 'Fixed recharge baseline changed')
        require_diagnostics_release_arguments(args, image_commit, image_run, image_attempt)
        with urllib.request.urlopen('https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/'
                + args.commit + '/' + recharge_binding['file'], timeout=30) as response:
            profile_raw = response.read(128 * 1024 + 1)
        recharge_profile = parse_fixed_recharge_scope(profile_raw)
        require(recharge_profile['id'] == recharge_profile_id, 'Fixed recharge runtime scope unavailable')
    if args.historical_finance_post_cleanup:
        require(not args.admin_only and image_commit == args.commit,
                'Post-cleanup publication requires exact candidate API images')
    if args.historical_finance_order_archive:
        require(not args.admin_only and image_commit == args.commit
                and args.image_commit == args.commit and args.image_run_id is not None
                and args.image_run_attempt is not None
                and re.fullmatch(r'[a-f0-9]{64}', args.order_archive_seal_sha256 or '') is not None
                and re.fullmatch(r'[a-f0-9]{64}', args.order_archive_prepared_images_sha256 or '') is not None,
                'Order archive publication requires exact independently prepared API and Admin images')
    os.umask(0o077)
    lock = (BASE / '.deploy.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    previous = (BASE / 'current').resolve()
    require(previous.parent == BASE / 'releases', 'Invalid current release path')
    old_manifest = json.loads((previous / 'release-manifest.json').read_text())
    require(old_manifest['commit'] == args.expected_current, 'Production baseline changed')
    if args.historical_finance_mailbox_batch:
        verify_mailbox_baseline(previous)
    before = {service: service_state(previous, service,
        include_container_id=args.historical_finance_recharge_diagnostics or recharge_requested
                             or args.historical_finance_mailbox_batch or args.historical_finance_post_cleanup
                             or args.historical_finance_order_archive,
        **({'include_environment_hash': True} if args.historical_finance_post_cleanup or args.historical_finance_order_archive or args.recharge_pro_main80 else {}))
        for service in production_services(previous)}
    require(all(state['status'] == 'running' for state in before.values()),
            'A production service is not running')
    require(all(state['health'] == 'healthy' for service, state in before.items()
                if service != 'caddy'), 'A production service is not healthy')
    initial_services, _ = release_services(args.admin_only, [],
        historical_diagnostics=args.historical_finance_recharge_diagnostics or recharge_requested,
        historical_mailbox=args.historical_finance_mailbox_batch,
        historical_post_cleanup=args.historical_finance_post_cleanup,
        historical_order_archive=args.historical_finance_order_archive)
    if recharge_requested:
        baseline_archive = fixed_recharge_runtime_archive(recharge_profile)
        finance_origin = (main80_recharge_baseline(previous, recharge_profile, old_manifest, before, source_archive=baseline_archive)
            if args.recharge_pro_main80 else fixed_recharge_baseline(previous, recharge_profile, old_manifest, before))
        finance_source = finance_origin if args.recharge_pro_main80 else previous
        if args.recharge_pro_menu_7f:
            finance_archive = fixed_recharge_baseline_archive()
        elif not args.recharge_pro_main80:
            with tarfile.open(fileobj=io.BytesIO(baseline_archive), mode='r:gz') as source:
                verify_fixed_recharge_finance_source(previous, source)
        original_environment = fixed_recharge_bytes(previous / '.env.aws.production')
    if args.historical_finance_recharge_diagnostics or args.historical_finance_post_cleanup:
        require_diagnostics_registration_isolation(previous, old_manifest, before)
        original_environment = (previous / '.env.aws.production').read_bytes()
    if args.historical_finance_order_archive:
        require_order_archive_baseline(previous, old_manifest, before)
        original_environment = (previous / '.env.aws.production').read_bytes()
    if args.historical_finance_maintenance_continuation or args.historical_finance_mailbox_batch:
        original_environment = (previous / '.env.aws.production').read_bytes()
    assert_release_jobs_idle(previous, initial_services, mailbox_only=args.historical_finance_mailbox_batch)

    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    release = BASE / 'releases' / f'{stamp}-{args.commit[:12]}'
    require(not release.exists(), 'Release directory already exists')
    release.mkdir(mode=0o700)
    step = 'source'
    changed = []
    try:
        if args.recharge_pro_main80:
            step = 'finance-source'
            auditor_source = prepare_registration_finance_source(args, registration_download(REGISTRATION_CURRENT))
            step = 'source'
        if args.recharge_pro_menu_7f:
            step = 'finance-source'
            finance_source = prepare_fixed_recharge_finance_source(args, finance_archive)
            verify_maintenance_baseline(finance_origin, maintenance_policy(finance_source))
            step = 'source'
        archive = release / '.source.tar.gz'
        url = f'https://github.com/wangchaozhuanyong/id-business-system/archive/{args.commit}.tar.gz'
        with urllib.request.urlopen(url, timeout=60) as response, archive.open('wb') as target:
            shutil.copyfileobj(response, target)
        source_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        with tarfile.open(archive, 'r:gz') as source:
            prefix = f'id-business-system-{args.commit}/'
            members = source.getmembers()
            require(all(
                (member.name == prefix[:-1] or member.name.startswith(prefix))
                and '..' not in Path(member.name).parts
                and not member.issym() and not member.islnk()
                for member in members), 'Unsafe source archive entry')
            source.extractall(release)
        extracted = release / f'id-business-system-{args.commit}'
        require(extracted.is_dir(), 'Source archive layout changed')
        for item in extracted.iterdir():
            item.rename(release / item.name)
        extracted.rmdir()
        archive.unlink()
        if args.historical_finance_continuation or args.historical_finance_recharge_diagnostics:
            policy = continuation_policy(release, historical_policy_id)
            verified_manifest = verify_continuation_baseline(previous, policy, historical_policy_id)
            require(verified_manifest == old_manifest, 'Historical continuation manifest changed')
            verify_continuation_running_images(before, old_manifest)
            if args.historical_finance_recharge_diagnostics:
                normalize_diagnostics_candidate_modes(release, policy)
            url = (f'https://github.com/wangchaozhuanyong/id-business-system/archive/'
                   f'{fixed_continuation(historical_policy_id)[0]}.tar.gz')
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read(64 * 1024 * 1024 + 1)
            require(len(data) <= 64 * 1024 * 1024, 'Continuation source archive is too large')
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as source:
                verify_continuation_archive(release, source, policy, historical_policy_id)
        if args.historical_finance_maintenance_continuation:
            policy = maintenance_policy(release)
            require(verify_maintenance_baseline(previous, policy) == old_manifest,
                    'Maintenance continuation manifest changed')
            verify_continuation_running_images(before, old_manifest)
            url = (f'https://github.com/wangchaozhuanyong/id-business-system/archive/'
                   f'{HISTORY_MAINTENANCE_BASELINE}.tar.gz')
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read(64 * 1024 * 1024 + 1)
            require(len(data) <= 64 * 1024 * 1024, 'Maintenance source archive is too large')
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as source:
                normalize_maintenance_candidate_modes(release, policy)
                verify_maintenance_archive(release, source, policy)
        if args.historical_finance_mailbox_batch:
            mailbox_policy(release)
        if recharge_requested:
            require(fixed_recharge_bytes(release / recharge_binding['file'], modes=(0o644, 0o664),
                limit=128 * 1024) == profile_raw, 'Fixed recharge runtime scope unavailable')
            normalize_fixed_recharge_modes(release, recharge_profile)
            with tarfile.open(fileobj=io.BytesIO(baseline_archive), mode='r:gz') as source:
                verify_fixed_recharge_archive(release, source, recharge_profile)
            if args.recharge_pro_menu_7f:
                require(hashlib.sha256(fixed_recharge_bytes(release / 'docker-compose.aws-mysql.yml',
                    modes=(0o644, 0o664))).hexdigest() == recharge_profile['baselineRelease']['composeSha256'],
                    'Fixed recharge baseline changed')
        if args.historical_finance_recharge_diagnostics:
            require_diagnostics_source_scope(previous, release)
        if args.historical_finance_post_cleanup:
            policy, post_cleanup_release_seal = reviewed_post_cleanup_seal(release, args.post_cleanup_seal_sha256,
                                                                        args.commit, args.source_tree)
            pending_worker_source = require_post_cleanup_source_scope(previous, release, policy)
        if args.historical_finance_order_archive:
            policy, order_archive_release_seal = reviewed_order_archive_seal(release,
                args.order_archive_seal_sha256, args.commit, args.source_tree,
                args.order_archive_prepared_images_sha256, image_run, image_attempt)
            require_order_archive_source_scope(release, policy)
            require_order_archive_schema_change(previous, release, policy)
        if image_commit != args.commit:
            url = f'https://github.com/wangchaozhuanyong/id-business-system/archive/{image_commit}.tar.gz'
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read(64 * 1024 * 1024 + 1)
            require(len(data) <= 64 * 1024 * 1024, 'Reusable source archive is too large')
            reusable = io.BytesIO(data)
            with tarfile.open(fileobj=reusable, mode='r:gz') as source:
                verify_reusable_archive(release, source, image_commit,
                    mailbox_only=args.historical_finance_mailbox_batch)
        shutil.copy2(previous / '.env.aws.production', release / '.env.aws.production')
        (release / '.env.aws.production').chmod(0o600)
        if recharge_requested:
            require_diagnostics_environment_unchanged(previous, release, original_environment)
            google_drive_folder = old_manifest.get('googleDriveSyncFolderId')
        elif args.historical_finance_mailbox_batch:
            require_mailbox_scope(previous, release, [], False, original_environment)
            google_drive_folder = old_manifest.get('googleDriveSyncFolderId')
        elif args.historical_finance_maintenance_continuation:
            require_maintenance_environment_unchanged(previous, release, original_environment)
            google_drive_folder = old_manifest.get('googleDriveSyncFolderId')
        elif args.historical_finance_recharge_diagnostics or args.historical_finance_post_cleanup or args.historical_finance_order_archive:
            require_diagnostics_environment_unchanged(previous, release, original_environment)
            google_drive_folder = old_manifest.get('googleDriveSyncFolderId')
        else:
            google_drive_folder = configure_google_drive_sync(previous, release)
        additions = migration_plan(previous, release)
        edge_changed = ((previous / 'deploy/caddy/Caddyfile.aws').read_bytes()
                        != (release / 'deploy/caddy/Caddyfile.aws').read_bytes())
        if args.historical_finance_mailbox_batch:
            require_mailbox_scope(previous, release, additions, edge_changed, original_environment)
        if args.historical_finance_maintenance_continuation:
            require_maintenance_scope(additions, edge_changed)
        if args.historical_finance_recharge_diagnostics:
            require_diagnostics_migration_scope(additions, edge_changed)
        if recharge_requested:
            require_diagnostics_migration_scope(additions, edge_changed)
        if args.historical_finance_order_archive:
            require(additions == [ORDER_ARCHIVE_MIGRATION + '/migration.sql'] and not edge_changed,
                    'Order archive publication requires its unique unapplied migration')
            require_order_archive_preservation(previous, release, original_environment, before)
        updated_services, image_services = release_services(args.admin_only, additions, edge_changed,
            historical_diagnostics=args.historical_finance_recharge_diagnostics or recharge_requested,
            historical_mailbox=args.historical_finance_mailbox_batch,
            historical_post_cleanup=args.historical_finance_post_cleanup,
            historical_order_archive=args.historical_finance_order_archive)
        override = json.loads((previous / 'compose.release.json').read_text())
        image_tags = {service: f'{image_commit}-{image_run}-{image_attempt}-{service}'
                      for service in image_services}
        image_references = release_image_references(
            updated_services, image_services, args.repository, image_tags)
        for service, reference in image_references.items():
            override['services'].setdefault(service, {})['image'] = reference
            override['services'][service]['pull_policy'] = 'never'
        (release / 'compose.release.json').write_text(json.dumps(override, indent=2) + '\n')
        require(json.loads(compose(release, 'config', '--format', 'json'))['name'] ==
                json.loads(compose(previous, 'config', '--format', 'json'))['name'],
                'Compose project changed')

        if edge_changed:
            step = 'edge-validation'
            compose(release, 'run', '--rm', '--no-deps', '--pull', 'never',
                    '--entrypoint', 'caddy', 'caddy', 'validate',
                    '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')

        step = 'audit-before'
        before_audit = (None if args.historical_finance_order_archive else
                       main80_recharge_audit(previous, release / 'before-audit.json',
                           stage='before', source=finance_source, auditor_source=auditor_source,
                           profile=recharge_profile, control_source=previous)
                       if args.recharge_pro_main80 else fixed_recharge_audit(previous, release / 'before-audit.json',
                             stage='before', source=finance_source, origin=finance_origin)
                       if recharge_requested else audit(previous, release / 'before-audit.json',
                             historical_exception=args.historical_finance_exception,
                             historical_continuation=args.historical_finance_continuation,
                             historical_diagnostics=args.historical_finance_recharge_diagnostics,
                             historical_post_cleanup=args.historical_finance_post_cleanup,
                             post_cleanup_seal_sha256=args.post_cleanup_seal_sha256,
                             candidate_commit=args.commit, candidate_tree=args.source_tree,
                             stage='before', source=release,
                             **({'historical_maintenance': True, 'origin': previous}
                                if args.historical_finance_maintenance_continuation else {}),
                             **({'historical_mailbox': True, 'origin': previous}
                                if args.historical_finance_mailbox_batch else {})))
        step = 'images'
        pulled_images = {}
        registry = args.repository.split('/')[0]
        password = run('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1')
        result = subprocess.run(['docker', 'login', '--username', 'AWS', '--password-stdin', registry],
                                input=password, capture_output=True, text=True)
        require(result.returncode == 0, 'ECR login failed')
        try:
            for service in image_services:
                run('docker', 'pull', f'{args.repository}:{image_tags[service]}', timeout=900)
                image = json.loads(run('docker', 'image', 'inspect',
                                       f'{args.repository}:{image_tags[service]}'))[0]
                require(image['Architecture'] == 'amd64'
                        and image['Config']['Labels'].get('org.opencontainers.image.revision') == image_commit,
                        f'{service} image provenance mismatch')
                pulled_images[service] = image['Id']
        finally:
            subprocess.run(['docker', 'logout', registry], capture_output=True, text=True)
        if args.historical_finance_post_cleanup:
            require(pulled_images.get('api') == post_cleanup_release_seal['apiImage'],
                    'Post-cleanup prepared API image differs from reviewed seal')
        if args.historical_finance_order_archive:
            require(pulled_images == order_archive_release_seal['images'],
                    'Order archive prepared images differ from reviewed seal')
            admin_build = verify_order_archive_admin_build(release, policy)
            step = 'audit-before'
            before_audit = audit(release, release / 'before-audit.json', historical_order_archive=True,
                order_archive_seal_sha256=args.order_archive_seal_sha256,
                order_archive_prepared_sha256=args.order_archive_prepared_images_sha256,
                candidate_commit=args.commit, candidate_tree=args.source_tree,
                image_run=image_run, image_attempt=image_attempt, stage='before', source=release)
        require(shutil.disk_usage(BASE).free > 2 * 1024**3, 'Insufficient free disk after pull')

        step = 'backup'
        backup = fresh_backup(previous)
        (release / 'backup-verification.json').write_text(json.dumps(backup, indent=2) + '\n')
        (release / 'backup-verification.json').chmod(0o600)
        require((BASE / 'current').resolve() == previous, 'Production changed before switch')
        if recharge_requested:
            if args.recharge_pro_main80:
                main80_recharge_baseline(previous, recharge_profile, old_manifest, before, source_archive=baseline_archive)
            else:
                fixed_recharge_baseline(previous, recharge_profile, old_manifest, before)
            require_diagnostics_environment_unchanged(previous, release, original_environment)
            require({service: service_state(previous, service, include_container_id=True,
                    **({'include_environment_hash': True} if args.recharge_pro_main80 else {}))
                for service in ALL_SERVICES} == before, 'Fixed recharge baseline changed')
            if args.recharge_pro_menu_7f:
                with tarfile.open(fileobj=io.BytesIO(finance_archive), mode='r:gz') as source:
                    verify_fixed_recharge_clean_finance_source(finance_source, source)
        if args.historical_finance_recharge_diagnostics:
            require_diagnostics_registration_isolation(previous, old_manifest, before)
            require_diagnostics_environment_unchanged(previous, release, original_environment)
        if args.historical_finance_maintenance_continuation:
            require_maintenance_environment_unchanged(previous, release, original_environment)
        if args.historical_finance_post_cleanup:
            require_post_cleanup_preservation(previous, release, original_environment, before)
        if args.historical_finance_order_archive:
            require_order_archive_preservation(previous, release, original_environment, before)
        assert_release_jobs_idle(previous, updated_services, mailbox_only=args.historical_finance_mailbox_batch)

        step = 'migration'
        if args.historical_finance_mailbox_batch:
            require_mailbox_scope(previous, release, additions, edge_changed, original_environment)
        if not args.historical_finance_post_cleanup:
            run_release_migrations(release, args.admin_only,
                args.historical_finance_recharge_diagnostics or args.historical_finance_mailbox_batch or recharge_requested)
        step = 'database-grants'
        database_grants = ({'status': 'SKIPPED', 'reason': 'FIXED_RECHARGE_NO_MIGRATIONS'}
            if recharge_requested else
            {'ok': True, 'skipped': True, 'reason': 'API_ONLY_UNCHANGED_SCHEMA'}
            if args.historical_finance_post_cleanup else sync_new_table_grants(release, additions))
        step = 'switch'
        if args.historical_finance_order_archive:
            require_order_archive_preservation(previous, release, original_environment, before)
        registration_runtime_service = ('auto-registration' if has_registration_worker(previous)
                                        else 'auto-recharge')
        for service in updated_services:
            if service == registration_runtime_service:
                # Migration/grants and earlier service health waits may outlast
                # the pre-migration guard. Preserve any newly retained window.
                assert_no_active_registration(previous)
            changed.append(service)
            compose(release, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                    '--force-recreate', service, timeout=300)
            wait_healthy(release, service)
            print(f'HEALTHY {service}', flush=True)

        step = 'audit-after'
        after_audit = (main80_recharge_audit(release, release / 'after-audit.json',
                            stage='after', source=finance_source, auditor_source=auditor_source, profile=recharge_profile,
                            before_receipt=release / 'before-audit.json', control_source=previous)
                      if args.recharge_pro_main80 else fixed_recharge_audit(release, release / 'after-audit.json',
                            stage='after', source=finance_source, origin=finance_origin,
                            before_receipt=release / 'before-audit.json')
                      if recharge_requested else audit(release, release / 'after-audit.json',
                            historical_exception=args.historical_finance_exception,
                            historical_continuation=args.historical_finance_continuation,
                            historical_diagnostics=args.historical_finance_recharge_diagnostics,
                            historical_post_cleanup=args.historical_finance_post_cleanup,
                            **({'historical_order_archive': True,
                                'order_archive_seal_sha256': args.order_archive_seal_sha256,
                                'order_archive_prepared_sha256': args.order_archive_prepared_images_sha256,
                                'image_run': image_run, 'image_attempt': image_attempt}
                               if args.historical_finance_order_archive else {}),
                            post_cleanup_seal_sha256=args.post_cleanup_seal_sha256,
                            candidate_commit=args.commit, candidate_tree=args.source_tree,
                            stage='after', source=release,
                            before_receipt=release / 'before-audit.json',
                            **({'historical_maintenance': True, 'origin': previous}
                               if args.historical_finance_maintenance_continuation else {}),
                             **({'historical_mailbox': True, 'origin': previous}
                                if args.historical_finance_mailbox_batch else {})))
        if args.historical_finance_mailbox_batch:
            require_mailbox_scope(previous, release, additions, edge_changed, original_environment)
        after = {service: service_state(release, service,
            include_container_id=args.historical_finance_recharge_diagnostics or recharge_requested
                                 or args.historical_finance_mailbox_batch or args.historical_finance_post_cleanup
                                 or args.historical_finance_order_archive,
            **({'include_environment_hash': True} if args.historical_finance_post_cleanup or args.historical_finance_order_archive or args.recharge_pro_main80 else {}))
            for service in production_services(release)}
        require(all(after[s] == before[s] for s in before if s not in updated_services),
                'Unrelated service changed')
        if args.historical_finance_recharge_diagnostics or args.historical_finance_post_cleanup or args.historical_finance_order_archive:
            require_diagnostics_environment_unchanged(previous, release, original_environment)
        if args.historical_finance_maintenance_continuation:
            require_maintenance_environment_unchanged(previous, release, original_environment)
        if recharge_requested:
            if args.recharge_pro_main80:
                main80_recharge_baseline(previous, recharge_profile, old_manifest, before, source_archive=baseline_archive)
            else:
                fixed_recharge_baseline(previous, recharge_profile, old_manifest, before)
            require_diagnostics_environment_unchanged(previous, release, original_environment)
            if args.recharge_pro_menu_7f:
                with tarfile.open(fileobj=io.BytesIO(finance_archive), mode='r:gz') as source:
                    verify_fixed_recharge_clean_finance_source(finance_source, source)
            elif not args.recharge_pro_main80:
                with tarfile.open(fileobj=io.BytesIO(baseline_archive), mode='r:gz') as source:
                    verify_fixed_recharge_finance_source(previous, source)
        if args.historical_finance_order_archive:
            require_order_archive_preservation(previous, release, original_environment, before)
            require(verify_order_archive_admin_build(release, policy) == admin_build,
                    'Order archive Admin image evidence changed during publication')
        require(all(after[s]['image'] == pulled_images[image_service(s)]
                    for s in updated_services if s in SERVICES), 'Running image differs from release')
        public_url = environment_values(release / '.env.aws.production')['APP_PUBLIC_URL'].rstrip('/')
        with urllib.request.urlopen(public_url + '/api/health/ready', timeout=20) as response:
            require(response.status == 200, 'Public API readiness failed')
        with urllib.request.urlopen(public_url + '/', timeout=20) as response:
            require(response.status == 200, 'Public admin readiness failed')
            if edge_changed:
                config = (release / 'deploy/caddy/Caddyfile.aws').read_text()
                expected_policy = re.search(r'Content-Security-Policy \"([^\"]+)\"', config)
                require(expected_policy is not None
                        and response.headers.get('Content-Security-Policy') == expected_policy.group(1),
                        'Public edge policy differs from release configuration')

        maintenance = None
        if args.historical_finance_post_cleanup:
            step = 'post-cleanup-retention-maintenance'
            maintenance = post_cleanup_retention_maintenance(release)
            (release / 'retention-maintenance-result.json').write_text(json.dumps(maintenance, indent=2) + '\n')
            (release / 'retention-maintenance-result.json').chmod(0o600)

        if args.recharge_pro_main80:
            # Readiness probes can outlast the previous preservation check.
            main80_recharge_baseline(previous, recharge_profile, old_manifest, before, source_archive=baseline_archive)
            verify_main80_recharge_candidate_source(release, baseline_archive, recharge_profile)
            require_diagnostics_environment_unchanged(previous, release, original_environment)
            require({service: service_state(release, service, include_container_id=True, include_environment_hash=True)
                for service in ALL_SERVICES} == after and (BASE / 'current').resolve() == previous,
                'Fixed main80 recharge publication tail changed')

        manifest = dict(old_manifest)
        if args.historical_finance_mailbox_batch:
            for name in ('fixedRechargeRelease', 'fixedRechargePreservedStates'):
                manifest.pop(name, None)
            preserved = set(before) - {'api'}
            manifest['mailboxPreservedStates'] = {
                'before': {name: before[name] for name in sorted(preserved)},
                'after': {name: after[name] for name in sorted(preserved)}}
        manifest.update({
            'commit': args.commit, 'sourceBranch': 'main', 'sourceTree': args.source_tree,
            'releaseTag': f'v2-production-{stamp}',
            'ciWorkflow': 'Quality Gate', 'ciWorkflowRunId': int(args.ci_run_id),
            'deployedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'deploymentRun': f'github-actions-{args.run_id}-{args.run_attempt}',
            'imageBuildRun': f'github-actions-{image_run}-{image_attempt}',
            'previousCommit': args.expected_current, 'previousRelease': str(previous),
            'googleDriveSyncFolderId': google_drive_folder,
            'servicesUpdated': list(updated_services), 'sourceArchiveSha256': source_digest,
            'images': {**old_manifest.get('images', {}), **{
                service: {'reference': reference,
                          'digest': after[service]['image'] if service in SERVICES
                          else pulled_images[service], 'sourceCommit': image_commit}
                for service, reference in image_references.items()}},
            'backupBeforeRelease': backup['name'],
            'migrationApplied': bool(additions), 'newMigrations': additions,
            'dataAuditBefore': before_audit, 'dataAuditAfter': after_audit,
            'databaseGrants': database_grants,
            'rollback': {'release': str(previous),
                         'images': {s: before[s]['image'] for s in updated_services if s in before},
                         'servicesAdded': [s for s in updated_services if s not in before]},
        })
        manifest.pop('prCiRunId', None)
        if recharge_requested:
            if args.recharge_pro_menu_7f or args.recharge_pro_main80:
                manifest.pop('mailboxPreservedStates', None)
            manifest['fixedRechargeRelease'] = fixed_recharge_context(args, recharge_profile, before_audit, after_audit)
            preserved_state = main80_recharge_preserved_states if args.recharge_pro_main80 else fixed_recharge_preserved_states
            manifest['fixedRechargePreservedStates'] = {
                'before': preserved_state(before), 'after': preserved_state(after)}
        if args.historical_finance_post_cleanup:
            manifest['postCleanupFinancialPublication'] = {
                'scope': 'API_ONLY', 'workersPublished': False,
                'pendingWorkerSource': pending_worker_source,
                'preservedServiceContainers': {service: before[service] for service in before if service != 'api'},
                'releaseSealSha256': args.post_cleanup_seal_sha256,
                'retentionMaintenance': maintenance}
        if args.historical_finance_order_archive:
            manifest['orderArchivePublication'] = {
                'scope': 'API_ADMIN_ORDER_ARCHIVE', 'workersPublished': False,
                'releaseSealSha256': args.order_archive_seal_sha256,
                'sourceProjectionTree': policy['candidateBindings']['sourceTree'],
                'preparedImagesSha256': args.order_archive_prepared_images_sha256,
                'migration': order_archive_release_seal['migration'], 'adminBuild': admin_build,
                'preservedServiceContainers': {service: before[service] for service in before
                                             if service not in ('api', 'admin')}}
        (release / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        point_current(release, f'{stamp}-publish')
        print(json.dumps({'status': 'DEPLOYED', 'commit': args.commit,
                          'releaseTag': manifest['releaseTag'],
                          'servicesUpdated': list(updated_services),
                          'migrationApplied': bool(additions),
                          'backupVerified': True,
                          'auditViolations': after_audit['violationCount'],
                          **({'unchangedServiceContainersPreserved': True}
                             if args.historical_finance_recharge_diagnostics or recharge_requested
                                or args.historical_finance_post_cleanup or args.historical_finance_order_archive else {})}), flush=True)
    except Exception as error:
        rollback_ok = True
        if (BASE / 'current').resolve() == release:
            try:
                point_current(previous, f'{stamp}-recover')
            except Exception:
                rollback_ok = False
        for service in reversed(changed):
            try:
                rollback_service(previous, release, service, before)
            except Exception:
                rollback_ok = False
        print(json.dumps({'status': 'DEPLOY_FAILED', 'step': step,
                          'errorType': type(error).__name__, 'rollbackOk': rollback_ok,
                          'servicesStarted': changed}), flush=True)
        return 1
    return 0


if __name__ == '__main__':
    if sys.argv[1:] == ['--summarize-command-result']:
        print('RELEASE_FAILURE_DIAGNOSTIC ' + json.dumps(command_failure_summary(json.load(sys.stdin))))
    elif sys.argv[1:2] in (['--check-fixed-registration-scope'], ['--prepare-fixed-registration-build']):
        try:
            tokens = sys.argv[2:]
            require(not tokens or len(tokens) == 2 and tokens[0] == '--registration-profile'
                and tokens[1] in (REGISTRATION_CONTINUATION_ID, REGISTRATION_INITIAL_ID, REGISTRATION_EMAIL_ID, REGISTRATION_CALLBACK_ID, REGISTRATION_EMAIL_REQUEST_ID, REGISTRATION_EMAIL_OBSERVATION_ID, REGISTRATION_HYDRATION_ID, REGISTRATION_PROFILE_OBSERVATION_ID),
                'Fixed registration selection changed')
            profile_id = tokens[1] if tokens else REGISTRATION_SCOPE_ID
            if sys.argv[1] == '--prepare-fixed-registration-build':
                result = prepare_fixed_registration_build(profile_id)
                print('REGISTRATION_PROJECTION_PREPARED ' + json.dumps(result, sort_keys=True, separators=(',', ':')))
            else:
                check_fixed_registration_scope(profile_id)
                print('REGISTRATION_PROFILE_VERIFIED')
        except Exception:
            raise SystemExit('Fixed registration scope unavailable; raw output suppressed') from None
    elif sys.argv[1:2] == ['--check-fixed-registration-deployment']:
        try:
            tokens = sys.argv[2:]
            profile_id = REGISTRATION_SCOPE_ID
            if len(tokens) == 8:
                require(tokens[-2] == '--registration-profile'
                    and tokens[-1] in (REGISTRATION_CONTINUATION_ID, REGISTRATION_INITIAL_ID, REGISTRATION_EMAIL_ID, REGISTRATION_CALLBACK_ID, REGISTRATION_EMAIL_REQUEST_ID, REGISTRATION_EMAIL_OBSERVATION_ID, REGISTRATION_HYDRATION_ID, REGISTRATION_PROFILE_OBSERVATION_ID),
                    'Fixed registration readback unavailable')
                profile_id = tokens[-1]
                tokens = tokens[:-2]
            require(len(tokens) == 6 and set(tokens[::2]) == {
                '--expected-current', '--source-tree', '--registration-profile-sha256'},
                'Fixed registration readback unavailable')
            values = dict(zip(tokens[::2], tokens[1::2]))
            result = check_fixed_registration_deployment(values['--expected-current'], values['--source-tree'],
                values['--registration-profile-sha256'], profile_id=profile_id)
        except Exception:
            raise SystemExit('Fixed registration readback unavailable; raw output suppressed') from None
        print('FIXED_REGISTRATION_RELEASE_VERIFIED ' + json.dumps(result, sort_keys=True, separators=(',', ':')))
    elif sys.argv[1:2] == ['--check-fixed-recharge-scope']:
        try:
            tokens = sys.argv[2:]
            if tokens:
                require(len(tokens) == 2 and tokens[0] == '--fixed-recharge-profile'
                    and tokens[1] in (RECHARGE_SCOPE_ID, RECHARGE_7F_ID, RECHARGE_MAIN80_ID, RECHARGE_01CE_ID),
                    'Fixed recharge runtime scope unavailable')
                check_fixed_recharge_scope(profile_id=tokens[1])
            else:
                check_fixed_recharge_scope()
        except Exception:
            raise SystemExit('Fixed recharge runtime scope unavailable; raw output suppressed') from None
        print('PROFILE_APPROVED')
    elif sys.argv[1:2] == ['--check-fixed-recharge-deployment']:
        try:
            tokens = sys.argv[2:]
            required = {'--expected-current', '--source-tree', '--profile-sha256'}
            require((len(tokens) == 6 and set(tokens[::2]) == required)
                or (len(tokens) == 8 and set(tokens[::2]) == required | {'--fixed-recharge-profile'}),
                    'Fixed recharge deployment verification unavailable')
            values = dict(zip(tokens[::2], tokens[1::2]))
            if '--fixed-recharge-profile' in values:
                require(values['--fixed-recharge-profile'] in (RECHARGE_SCOPE_ID, RECHARGE_7F_ID, RECHARGE_MAIN80_ID, RECHARGE_01CE_ID),
                        'Fixed recharge deployment verification unavailable')
                result = check_fixed_recharge_deployment(values['--expected-current'], values['--source-tree'],
                    values['--profile-sha256'], profile_id=values['--fixed-recharge-profile'])
            else:
                result = check_fixed_recharge_deployment(values['--expected-current'], values['--source-tree'], values['--profile-sha256'])
        except Exception:
            raise SystemExit('Fixed recharge deployment verification unavailable; raw output suppressed') from None
        print('FIXED_RECHARGE_RELEASE_VERIFIED ' + json.dumps(result, sort_keys=True, separators=(',', ':')))
    else:
        sys.exit(main())
