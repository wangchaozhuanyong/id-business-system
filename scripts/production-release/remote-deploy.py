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
                     historical_mailbox=False, historical_post_cleanup=False, historical_order_archive=False):
    require(sum((historical_diagnostics, historical_mailbox, historical_post_cleanup, historical_order_archive)) <= 1,
            'Historical release selection is ambiguous')
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
RECHARGE_MAIN80_CURRENT = '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'
RECHARGE_MAIN80_TREE = 'fbf9bd6e903ad8d7b83cf5701fde5c96347d5c1b'
RECHARGE_MAIN80_FILE = 'deploy/aws/' + RECHARGE_MAIN80_ID + '.json'
RECHARGE_MAIN80_CONTROLS = RECHARGE_SCOPE_CONTROLS | {'scripts/production-release/validate-release-selection.sh'}
RECHARGE_MAIN80_POLICY_SHA256 = '91096c5c2cf5d6b1a3210794ec3cdf20aef54fe457d11b75df1735416d7c3511'
RECHARGE_MAIN80_PROJECTION_TREE = 'd9c2e534f0e71d5c88ffc4db492c4db2e79a9370'
RECHARGE_MAIN80_MIGRATION = {'name': ORDER_ARCHIVE_MIGRATION,
    'sqlSha256': ORDER_ARCHIVE_MIGRATION_SHA256,
    'mysqlSchemaSha256': 'c70cbcb110bb48c395b7e7284dedc0486a9afc125d940c455c0bafc1cffc701d',
    'baselineMysqlSchemaSha256': '39b9bd4d1bf8a42263e494880c2b047a91628102cc6676abd06dc4aecd2149a0'}
RECHARGE_MAIN80_FINANCE = {'kind': 'EXISTING_ORDER_ARCHIVE_49',
    'sourceCommit': RECHARGE_MAIN80_CURRENT, 'sourceTree': RECHARGE_MAIN80_TREE,
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
RECHARGE_MAIN80_CARRIED_SOURCE = {
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
        and baseline['previousCommit'] == HISTORY_ORDER_ARCHIVE_BASELINE
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
        'violationCount': 5, 'candidateCommit': RECHARGE_MAIN80_CURRENT, 'candidateTree': RECHARGE_MAIN80_TREE,
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
        RECHARGE_MAIN80_CURRENT, RECHARGE_MAIN80_TREE, finance['preparedImagesSha256'],
        str(finance['preparationRunId']), str(finance['preparationRunAttempt']))


def main80_recharge_reader_evidence(directory):
    before = directory / 'before-audit.json'
    metadata = before.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
        and stat.S_IMODE(metadata.st_mode) in (0o400, 0o600),
        'Fixed main80 recharge original audit ownership unavailable')
    for filename, original in (('order-archive-seal.reader.json', ORDER_ARCHIVE_SEAL),
            ('order-archive-cleanup.reader.json', POST_CLEANUP_RECEIPT)):
        reader = directory / filename
        info = reader.lstat()
        require((info.st_uid, info.st_gid) == (metadata.st_uid, metadata.st_gid)
            and fixed_recharge_bytes(reader, modes=(0o400,)) == fixed_recharge_bytes(original, modes=(0o600,)),
            'Fixed main80 recharge original reader evidence changed')
        after = reader.lstat()
        require((after.st_uid, after.st_gid) == (metadata.st_uid, metadata.st_gid)
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
    """Compare the exact published main80 public source, excluding only native outputs."""
    main80_recharge_reader_evidence(previous)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        expected = fixed_recharge_archive(archive, profile_id=RECHARGE_MAIN80_ID)
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


def main80_recharge_baseline(previous, profile, manifest, states, *, source_archive=None):
    """Verify actual native receipts; a disabled preview is never native evidence."""
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
            'sourceTree': RECHARGE_MAIN80_TREE, 'previousCommit': HISTORY_ORDER_ARCHIVE_BASELINE,
            'deploymentRun': baseline['deploymentRun'], 'servicesUpdated': ['api', 'admin'],
            'migrationApplied': True, 'newMigrations': [ORDER_ARCHIVE_MIGRATION + '/migration.sql']}.items())
        and manifest.get('migrationApplied') is True
        and manifest.get('imageBuildRun') == 'github-actions-' + str(finance['preparationRunId'])
            + '-' + str(finance['preparationRunAttempt']), message)
    policy_raw = read(previous / ('deploy/aws/' + HISTORY_ORDER_ARCHIVE_POLICY_ID + '.json'), modes=(0o644, 0o664))
    require(historical_fingerprint(fixed_recharge_json(policy_raw)) == RECHARGE_MAIN80_POLICY_SHA256, message)
    read(ORDER_ARCHIVE_SEAL); read(POST_CLEANUP_RECEIPT)
    for filename in ('order-archive-seal.reader.json', 'order-archive-cleanup.reader.json'):
        read(previous / filename, modes=(0o400,))
    main80_recharge_reader_evidence(previous)
    policy, seal = main80_recharge_seal(previous, profile)
    receipts = {}
    for stage in ('before', 'after'):
        raw = read(previous / (stage + '-audit.json'))
        require(hashlib.sha256(raw).hexdigest() == baseline[stage + 'AuditSha256'], message)
        report = fixed_recharge_json(raw)
        summary = main80_recharge_report(report, profile, policy, seal, stage)
        require(historical_fingerprint(manifest.get('dataAudit' + stage.title())) == historical_fingerprint(summary), message)
        receipts[stage] = report
    require(historical_fingerprint(receipts['before']['checks']) == historical_fingerprint(receipts['after']['checks']), message)
    compose_raw = read(previous / 'docker-compose.aws-mysql.yml', modes=(0o400, 0o600, 0o644, 0o664))
    override_raw = read(previous / 'compose.release.json', modes=(0o400, 0o600, 0o644))
    read(previous / '.env.aws.production')
    images = manifest.get('images', {})
    require(set(states) == set(ALL_SERVICES) and isinstance(images, dict) and set(images) == {*SERVICES, 'migrate'}
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
        require(image.get('digest') == finance['images'][service] and image.get('sourceCommit') == RECHARGE_MAIN80_CURRENT
            and isinstance(image.get('reference'), str) and re.fullmatch(
                r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
                + RECHARGE_MAIN80_CURRENT + '-' + str(finance['preparationRunId'])
                + '-' + str(finance['preparationRunAttempt']) + '-' + service, image['reference']), message)
    publication = manifest.get('orderArchivePublication')
    require(isinstance(publication, dict) and set(publication) == {'scope', 'workersPublished', 'releaseSealSha256',
        'sourceProjectionTree', 'preparedImagesSha256', 'migration', 'adminBuild', 'preservedServiceContainers'}
        and publication['scope'] == 'API_ADMIN_ORDER_ARCHIVE' and publication['workersPublished'] is False
        and all(publication[key] == finance[key] for key in ('releaseSealSha256', 'preparedImagesSha256', 'migration'))
        and publication['sourceProjectionTree'] == finance['sourceProjectionTree']
        and publication['adminBuild'] == {'verifiedFiles': len(policy['candidateBindings']['adminBuildHashes']),
            'sha256': historical_fingerprint(policy['candidateBindings']['adminBuildHashes'])}
        and publication['preservedServiceContainers'] == {service: states[service] for service in ALL_SERVICES
            if service not in ('api', 'admin')}, message)
    public_observed = verify_main80_recharge_finance_source(previous, source_archive) if source_archive is not None else None
    require(all(fixed_recharge_bytes(path, **options) == raw for path, (raw, options) in observed.items()), message)
    main80_recharge_reader_evidence(previous)
    if public_observed is not None:
        require_main80_recharge_public_snapshot(public_observed)
    return previous


def main80_recharge_audit(directory, receipt, *, stage, source, profile, before_receipt=None):
    """Run the unchanged, original 49-rule native audit through its retained API image."""
    finance = main80_recharge_scope(profile)['financeValidator']
    policy, seal = main80_recharge_seal(source, profile)
    result = order_archive_audit(directory, receipt, stage=stage, source=source, before_receipt=before_receipt,
        seal_sha=finance['releaseSealSha256'], candidate_commit=RECHARGE_MAIN80_CURRENT,
        candidate_tree=RECHARGE_MAIN80_TREE, prepared_sha=finance['preparedImagesSha256'],
        image_run=str(finance['preparationRunId']), image_attempt=str(finance['preparationRunAttempt']))
    report = fixed_recharge_json(fixed_recharge_bytes(receipt))
    expected = main80_recharge_report(report, profile, policy, seal, stage)
    stored = fixed_recharge_json(fixed_recharge_bytes(source / (stage + '-audit.json')))
    main80_recharge_report(stored, profile, policy, seal, stage)
    require(historical_fingerprint(result) == historical_fingerprint(expected)
        and historical_fingerprint(stored['checks']) == historical_fingerprint(report['checks']),
        'Fixed main80 recharge fresh native integrity gate failed')
    return result


def main80_recharge_context(args, profile, before_gate, after_gate):
    main80_recharge_scope(profile)
    require(re.fullmatch(r'[a-f0-9]{40}', args.commit or '') and re.fullmatch(r'[a-f0-9]{40}', args.source_tree or '')
        and args.expected_current == RECHARGE_MAIN80_CURRENT, 'Fixed main80 recharge runtime scope unavailable')
    for stage, gate in (('before', before_gate), ('after', after_gate)):
        require(isinstance(gate, dict) and set(gate) == {'checkCount', 'violationCount', 'historicalException'}
            and type(gate['checkCount']) is int and gate['checkCount'] == 49
            and type(gate['violationCount']) is int and gate['violationCount'] == 5
            and gate['historicalException'].get('stage') == stage
            and gate['historicalException'].get('candidateCommit') == RECHARGE_MAIN80_CURRENT
            and gate['historicalException'].get('candidateTree') == RECHARGE_MAIN80_TREE,
            'Fixed main80 recharge fresh integrity gate failed')
    return {'version': 1, 'id': RECHARGE_MAIN80_ID, 'profileSha256': historical_fingerprint(profile),
        'expectedCurrent': RECHARGE_MAIN80_CURRENT, 'sourceCommit': args.commit, 'sourceTree': args.source_tree,
        'servicesUpdated': ['auto-recharge'], 'financeValidator': 'EXISTING_ORDER_ARCHIVE_49',
        'sourceCommitForFinance': RECHARGE_MAIN80_CURRENT, 'originCommitForFinance': HISTORY_ORDER_ARCHIVE_BASELINE,
        'beforeGateSha256': historical_fingerprint(before_gate['historicalException']),
        'afterGateSha256': historical_fingerprint(after_gate['historicalException']),
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
            'executedCheckCount': 49, 'unavailableCheckCount': 0, 'violationCount': 5, 'storedGatesMatched': True,
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
    require(type(profile_id) is str and profile_id in (RECHARGE_SCOPE_ID, RECHARGE_7F_ID, RECHARGE_MAIN80_ID),
            'Fixed recharge runtime scope unavailable')
    if profile_id == RECHARGE_MAIN80_ID:
        return {'id': RECHARGE_MAIN80_ID, 'current': RECHARGE_MAIN80_CURRENT, 'tree': RECHARGE_MAIN80_TREE,
            'file': RECHARGE_MAIN80_FILE, 'previous': HISTORY_ORDER_ARCHIVE_BASELINE, 'carried': frozenset(RECHARGE_MAIN80_CARRIED_SOURCE)}
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
            'executedCheckCount': 49, 'unavailableCheckCount': 0, 'violationCount': 5, 'storedGatesMatched': True,
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
            baseline_manifest['orderArchivePublication']['preservedServiceContainers']['auto-recharge']}
        archive_data = fixed_recharge_runtime_archive(profile)
        main80_recharge_baseline(previous, profile, baseline_manifest, baseline_states, source_archive=archive_data)
        policy, seal = main80_recharge_seal(previous, profile)
        gates = {}
        for stage in ('before', 'after'):
            report = fixed_recharge_json(read(current / (stage + '-audit.json')))
            gates[stage] = main80_recharge_report(report, profile, policy, seal, stage)
            require(historical_fingerprint(manifest.get('dataAudit' + stage.title())) == historical_fingerprint(gates[stage]), message)
            original = fixed_recharge_json(read(previous / (stage + '-audit.json')))
            main80_recharge_report(original, profile, policy, seal, stage)
            require(historical_fingerprint(report['checks']) == historical_fingerprint(original['checks']), message)
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
        require(set(images) == {*SERVICES, 'migrate'}
            and override == {'services': {service: {'image': images[service]['reference'], 'pull_policy': 'never'}
                for service in (*SERVICES, 'migrate')}}
            and all(images[service] == baseline_manifest['images'][service]
                for service in (*SERVICES, 'migrate') if service != 'auto-recharge'), message)
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
    args = parser.parse_args()
    recharge_requested = args.recharge_pro_menu_b8 or args.recharge_pro_menu_7f or args.recharge_pro_main80
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
        finance_source = previous
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
    if args.recharge_pro_main80:
        assert_no_active_jobs(previous, worker_changes=True)
    else:
        assert_release_jobs_idle(previous, initial_services, mailbox_only=args.historical_finance_mailbox_batch)

    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    release = BASE / 'releases' / f'{stamp}-{args.commit[:12]}'
    require(not release.exists(), 'Release directory already exists')
    release.mkdir(mode=0o700)
    step = 'source'
    changed = []
    try:
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
                           stage='before', source=finance_source, profile=recharge_profile)
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
        if args.recharge_pro_main80:
            assert_no_active_jobs(previous, worker_changes=True)
        else:
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
                            stage='after', source=finance_source, profile=recharge_profile,
                            before_receipt=release / 'before-audit.json')
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
    elif sys.argv[1:2] == ['--check-fixed-recharge-scope']:
        try:
            tokens = sys.argv[2:]
            if tokens:
                require(len(tokens) == 2 and tokens[0] == '--fixed-recharge-profile'
                    and tokens[1] in (RECHARGE_SCOPE_ID, RECHARGE_7F_ID, RECHARGE_MAIN80_ID),
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
                require(values['--fixed-recharge-profile'] in (RECHARGE_SCOPE_ID, RECHARGE_7F_ID, RECHARGE_MAIN80_ID),
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
