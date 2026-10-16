"""Replay only the verified GPT module delta above the independently published mailbox image."""
import ast
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import types

BASE = Path('/opt/id-business-v2')
APP = 'b0d80c7f8cea818361d06873e3e432ee2c3b3229'
NATIVE_RUN = '38922620650'
OVERRIDES = {'current', 'expectedCurrent', 'manifestSha256', 'configurationSha256',
             'runtimeConfigurationSha256', 'services'}


def need(value, code):
    if not value:
        raise RuntimeError('GPT_REBASE_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def compose_contract(native, rebase):
    need(rebase['version'] == 1 and rebase['scope'] == 'GPT_RECHARGE_MAILBOX_BASELINE_REBASE'
         and rebase['nativeApplicationCommit'] == APP and rebase['businessActions'] == 0
         and rebase['migrationPerformed'] is False, 'SCOPE')
    changes = rebase['baseApiJsDelta']
    mailbox = rebase['mailboxNative']
    need(set(rebase['baseOverrides']) == OVERRIDES and len(changes) == 1
         and set(changes) == {'common/prisma/bump-v2-scope-versions.js'}
         and not set(changes).intersection(native['apiModules']), 'FINITE_BASE_DELTA')
    need(mailbox['commit'] == rebase['baseOverrides']['expectedCurrent']
         and mailbox['scope'] == 'MAILBOX_SCOPE_VERSION_RECOVERY'
         and mailbox['workflowRunId'] == '38925995056'
         and set(mailbox['sources']) == {'apps/api/src/common/prisma/bump-v2-scope-versions.ts'},
         'MAILBOX_PROVENANCE')
    signature = 'common/prisma/bump-v2-scope-versions.d.ts'
    need(rebase['mailboxBaselineModules'][signature] == mailbox['modules'][signature],
         'MAILBOX_SIGNATURE_CHANGED')
    merged = copy.deepcopy(native)
    merged.update(copy.deepcopy(rebase['baseOverrides']))
    for name, delta in changes.items():
        need(set(delta) == {'old', 'current'} and native['baselineApiJs'][name] == delta['old']
             and mailbox['modules'][name] == delta['current'] and re.fullmatch('[a-f0-9]{64}', delta['current']),
             'BASE_MODULE_PROOF')
        merged['baselineApiJs'][name] = delta['current']
    need(len(merged['baselineApiJs']) == 595 and merged['sources'] == native['sources']
         and merged['apiModules'] == native['apiModules'], 'APPLICATION_CHANGED')
    return merged


def publisher_tree(source):
    """Retain the reviewed COW publisher behavior; insert provenance before serialization."""
    tree = ast.parse(source)
    release = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'release')
    count = {'receipt': 0, 'manifest': 0}

    class Annotate(ast.NodeTransformer):
        def visit_Assign(self, node):
            if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                name = node.targets[0].id
                if name == 'receipt':
                    count[name] += 1
                    return [node, *ast.parse("receipt['nativeDeltaRebase'] = REBASE_PROVENANCE").body]
                if name == 'manifest' and ast.unparse(node.value) == 'json.loads(raw_manifest)':
                    count[name] += 1
                    return [node, *ast.parse("manifest['applicationCommit'] = REBASE_PROVENANCE['nativeApplicationCommit']\nmanifest['controlCommit'] = plan['commit']\nmanifest['gptNativeDeltaRebase'] = REBASE_PROVENANCE").body]
            return node

    Annotate().visit(release)
    need(count == {'receipt': 1, 'manifest': 1}, 'PUBLISHER_ANNOTATION_SHAPE')
    return ast.fix_missing_locations(tree)


def publisher_module(source, controls, provenance):
    tree = publisher_tree(source)
    module = types.ModuleType('gpt_native_delta_rebase')
    module.__dict__.update(__file__=str(controls / 'gpt-recharge-release.py'), REBASE_PROVENANCE=provenance)
    exec(compile(ast.fix_missing_locations(tree), '<verified-gpt-cow-publisher>', 'exec'), module.__dict__)
    return module


def release(plan, rebase, source):
    controls = BASE / '.staging' / ('gpt-controls-' + APP)
    raw = (controls / 'gpt-recharge-contract.json').read_bytes()
    need(sha(raw) == rebase['nativeContractSha256'] and sha(source.encode()) == rebase['cowPublisherSha256'],
         'IMMUTABLE_NATIVE_CONTROL')
    native = json.loads(raw)
    c = compose_contract(native, rebase)
    old_plan = rebase['nativePlan']
    for name in ('contractSha256', 'artifactSha256', 'buildProofSha256', 'buildCommit', 'buildTree',
                 'workflowRunId', 'workflowRunAttempt', 'controlSources'):
        need(plan[name] == old_plan[name], 'NATIVE_PLAN_CHANGED_' + name)
    need(plan['workflowRunId'] == NATIVE_RUN and plan['commit'] != APP
         and plan['rebaseContractSha256'] == sha(Path(__file__).with_name('gpt-recharge-rebase-contract.json').read_bytes()),
         'PLAN_REBASE_IDENTITY')
    for name, expected in native['controlSources'].items():
        need(sha((controls / name).read_bytes()) == expected, 'FROZEN_CONTROL_CHANGED')
    key = BASE / '.secrets/gpt-recharge-vendure.key'
    need(key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0, 'EXISTING_KEY_REQUIRED')
    origin_stage = BASE / '.staging' / ('gpt-recharge-' + APP + '-' + NATIVE_RUN)
    need(not (origin_stage / 'forward-continuation.json').exists(), 'OLD_CANDIDATE_SWITCHED')
    provenance = {'nativeApplicationCommit': APP, 'controlCommit': plan['commit'],
                  'nativeWorkflowRunId': NATIVE_RUN, 'nativeBuildCommit': plan['buildCommit'],
                  'controlValidationRun': plan['controlValidationRun'],
                  'baselineCaptureCommand': rebase['baselineCaptureCommand'],
                  'nativeContractSha256': rebase['nativeContractSha256'],
                  'rebaseContractSha256': plan['rebaseContractSha256'],
                  'baselineCommit': c['expectedCurrent'], 'baselineRelease': c['current'],
                  'baselineManifestSha256': c['manifestSha256'], 'baselineApiJsDelta': rebase['baseApiJsDelta'],
                  'supersededFailedCommand': rebase['supersededFailedCommand'],
                  'unstartedSuffixCommand': rebase['unstartedSuffixCommand'],
                  'applicationRecompiled': False, 'migrationPerformed': False, 'businessActions': 0}
    g = publisher_module(source, controls, provenance)
    h = g.load('recharge-record-release.py', plan['controlSources'])
    d = h.load_utilities(controls / 'remote-deploy.py', plan['controlSources']['remote-deploy.py'])
    if plan['mode'] != 'readback':
        previous, _, states = g.baseline(d, h, c)
        need(str(previous) == c['current'], 'BASELINE')
        g.read_modules(d, states['api'], rebase['mailboxNative']['modules'])
        for name, expected in rebase['mailboxNative']['sources'].items():
            need(sha((previous / name).read_bytes()) == expected, 'MAILBOX_SOURCE_CHANGED')
        need(not (BASE / 'maintenance.json').exists(), 'OTHER_MAINTENANCE')
    result = g.release(plan, c)
    if plan['mode'] == 'release':
        (origin_stage / 'superseded-by-new-baseline.json').write_text(json.dumps({
            'status': 'UNSWITCHED_CANDIDATE_SUPERSEDED', **provenance}, sort_keys=True) + '\n')
    return {**result, 'nativeApplicationCommit': APP, 'baselineCommit': c['expectedCurrent']}
