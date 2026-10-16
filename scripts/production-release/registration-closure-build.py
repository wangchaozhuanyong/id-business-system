"""Build only the reviewed registration/inventory/proxy delta over reproduced roles."""
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
CONTRACT = HERE / 'registration-closure-contract.json'
OUTPUT = ROOT / '.deploy/registration-closure-release'
SCOPE = 'REGISTRATION_INVENTORY_AND_PROXY_CLOSURE'


def need(value, code):
    if not value:
        raise RuntimeError('REGISTRATION_CLOSURE_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location('registration_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def inventory(path):
    return {name: value for name, value in load('recharge-record-release.py').file_inventory(path).items()
            if name not in ('tsconfig.tsbuildinfo', 'tsconfig.build.tsbuildinfo')}


def permitted_source(name):
    prefixes = ('apps/admin/src/v2/features/auto-registration/',
                'apps/admin/src/v2/features/proxy-pool/',
                'apps/api/src/id-business-v2/auto-registration/',
                'apps/api/src/id-business-v2/proxy-pool/')
    exact = ('apps/api/prisma-mysql/schema.prisma', 'apps/admin/src/v2/features/tableSchemas.ts',
             'packages/shared/src/v2/auto-recharge.ts')
    return (name.startswith(prefixes) or name in exact
            or name.startswith(('apps/admin/src/v2/features/auto-recharge/',
                                'apps/api/src/id-business-v2/auto-recharge/',
                                'apps/api/src/id-business-v2/online-recharge/engine/',
                                'apps/api/src/id-business-v2/online-recharge/'))
            or name.startswith('apps/api/prisma-mysql/migrations/'))


def admitted_source(name, protection):
    return (permitted_source(name) or name in protection['sources']
            or name in protection.get('validationSources', {}))


def ensure_published_objects(contract):
    commits = {contract['sourceBaseline'], contract['reviewBase']}
    commits.update(binding['commit'] for binding in contract['publishedSources'].values())
    commits.update(binding['baselineCommit'] for binding in contract.get('engineSourceProjection', {}).values()
                   if 'baselineCommit' in binding)
    for commit in sorted(commits):
        need(re.fullmatch('[a-f0-9]{40}', commit), 'PUBLISHED_COMMIT_INVALID')
        exists = subprocess.run(['git', 'cat-file', '-e', commit + '^{commit}'], cwd=ROOT,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        if not exists:
            run('git', 'fetch', '--no-tags', '--depth=1', 'origin', commit)
        need(git('rev-parse', commit + '^{commit}').decode().strip() == commit, 'PUBLISHED_COMMIT_CHANGED')


def verify_protected_recovery(contract):
    protection = contract.get('protectedPublishedRecovery')
    path = ROOT / 'scripts/ci-registration-closure-published.json'
    need(protection == json.loads(path.read_bytes()), 'PUBLISHED_RECOVERY_BINDING_CHANGED')
    names = list(protection['sources']) + ['scripts/ci-registration-closure-published.json']
    command = ("import{registrationPublishedRecoveryProof as valid}from'./scripts/ci-registration-closure-scope.mjs';"
               + 'if(!valid(' + json.dumps(names) + '))process.exit(2);')
    run('node', '--input-type=module', '-e', command)
    layers = [protection['sources'], *[layer['sources'] for layer in protection.get('publishedSuccessorLayers', [])]]
    for sources in layers:
        for name, binding in sources.items():
            need(digest(git('show', binding['sourceCommit'] + ':' + name)) == binding['publishedSha256'],
                 'PUBLISHED_RECOVERY_SOURCE_CHANGED')
    source = (ROOT / 'apps/api/prisma-mysql/schema.prisma').read_text()
    model = re.search(r'model IdBusinessV2ChatgptAccount \{[\s\S]*?\n\}', source)
    need(model is not None, 'PUBLISHED_SCHEMA_MISSING')
    original = model.group(0)
    restored = re.sub(r'^  (?:registrationIpEncrypted|registeredAt) +[^\n]+\n', '', original, flags=re.M)
    need(restored != original and digest(source.replace(original, restored, 1).encode())
         == protection['schemaSha256'], 'PUBLISHED_SCHEMA_CHANGED')
    return protection


def verify_published_native(contract):
    protection = contract['protectedPublishedRecovery']
    prefix = 'repos/wangchaozhuanyong/id-business-system/'
    meta = json.loads(subprocess.check_output(['gh', 'api', prefix + 'actions/runs/' + protection['nativeRunId']], cwd=ROOT))
    need(meta['head_sha'] == protection['publicationCommit'] and meta['conclusion'] == 'success'
         and meta['path'] == '.github/workflows/online-recharge-audit-validation.yml', 'PUBLISHED_NATIVE_CHANGED')
    artifacts = json.loads(subprocess.check_output(['gh', 'api', prefix + 'actions/runs/'
                           + protection['nativeRunId'] + '/artifacts'], cwd=ROOT))['artifacts']
    matches = [a for a in artifacts if a['digest'] == protection['nativeArtifactDigest'] and not a['expired']]
    need(len(matches) == 1 and matches[0]['workflow_run']['head_sha'] == protection['publicationCommit'],
         'PUBLISHED_NATIVE_ARTIFACT_CHANGED')
    observed = contract['observedAdminNativeBuild']
    latest = json.loads(subprocess.check_output(['gh', 'api', prefix + 'actions/runs/' + observed['runId']], cwd=ROOT))
    latest_artifacts = json.loads(subprocess.check_output(['gh', 'api', prefix + 'actions/runs/' + observed['runId'] + '/artifacts'], cwd=ROOT))['artifacts']
    latest_matches = [a for a in latest_artifacts if a['digest'] == observed['artifactDigest'] and not a['expired']
                      and a['name'] == 'recharge-checkout-' + observed['commit'] + '-' + str(observed['runAttempt'])
                      and a['workflow_run']['head_sha'] == observed['commit']]
    need(latest['head_sha'] == observed['commit'] == contract['expectedCurrent']
         and latest['conclusion'] == 'success' and latest['run_attempt'] == observed['runAttempt']
         and latest['path'] == observed['workflowPath'] == '.github/workflows/recharge-checkout-validation.yml'
         and len(latest_matches) == 1 and observed['runtimeExactMatch'] is True
         and observed['nodeEnv'] == contract['adminBuildNodeEnv'] == 'production'
         and observed['nativeAdminFileCount'] == observed['runtimeAdminFileCount'] == len(contract['baselineAdminFiles']),
         'OBSERVED_ADMIN_NATIVE_CHANGED')
    return {'runId': protection['nativeRunId'], 'artifactDigest': protection['nativeArtifactDigest'], 'verified': True}


def verify_sources(contract):
    need(contract['scope'] == SCOPE, 'SCOPE_INVALID')
    protection = verify_protected_recovery(contract)
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    need(git('rev-parse', contract['sourceBaseline'] + '^{tree}').decode().strip()
         == contract['sourceBaselineTree'], 'BASE_TREE_CHANGED')
    changed = set(git('diff', '--name-only', contract['reviewBase'], 'HEAD', '--', 'apps/', 'packages/').decode().splitlines())
    need(changed == set(contract['changedSources']), 'SOURCE_SCOPE_CHANGED')
    for name, expected in contract['changedSources'].items():
        need(admitted_source(name, protection) and digest((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    for name, expected in contract.get('validationSources', {}).items():
        need((name.startswith(('scripts/acceptance-v2-', 'scripts/fixtures/'))
              or name in ('scripts/check-v2-decimal-standard.mjs', 'scripts/check-v2-decimal-standard.test.mjs',
                          'scripts/check-v2-table-standard.mjs', 'scripts/lib/v2-table-schema-alias.mjs',
                          'scripts/v2-table-schema-alias.test.mjs'))
             and digest((ROOT / name).read_bytes()) == expected, 'VALIDATION_SOURCE_CHANGED')
    for name, binding in contract['publishedSources'].items():
        need((permitted_source(name) or name in protection['sources']) and digest(git('show', binding['commit'] + ':' + name))
             == binding['sha256'], 'PUBLISHED_SOURCE_CHANGED')
    # No dependency, compiler, runtime configuration, frozen upstream, or unrelated migration admission.
    protected = ('package.json', 'package-lock.json', 'tsconfig.base.json', '.npmrc',
                 'apps/api/package.json', 'apps/admin/package.json', 'apps/api/tsconfig.json',
                 'apps/api/tsconfig.build.json', 'docker-compose.aws-mysql.yml')
    need(not git('diff', '--name-only', contract['reviewBase'], 'HEAD', '--', *protected).strip(), 'BUILD_INPUT_CHANGED')
    need(not any('/worker/upstream/' in n for n in contract['changedSources']), 'FROZEN_UPSTREAM_CHANGED')


def projected_source_hashes(contract):
    result = dict(contract['changedSources'])
    for name, binding in contract.get('engineSourceProjection', {}).items():
        result['apps/api/src/id-business-v2/online-recharge/engine/' + name] = binding['candidateSha256']
    return result


def apply_engine_projection(contract, context):
    for name, binding in contract.get('engineSourceProjection', {}).items():
        path = 'apps/api/src/id-business-v2/online-recharge/engine/' + name
        need(path in contract['changedSources'] and name in contract['engineFiles']
             and name in ('worker.cjs', 'task-runner.cjs', 'SOURCE_MANIFEST.json'), 'ENGINE_PROJECTION_SCOPE_CHANGED')
        raw = (context / path).read_bytes()
        if 'baselineCommit' in binding:
            raw = git('show', binding['baselineCommit'] + ':' + path)
        elif path in contract.get('publishedFileContents', {}):
            raw = contract['publishedFileContents'][path]['content'].encode()
        need(digest(raw) == binding['baselineSha256'] == contract['engineFiles'][name], 'ENGINE_PROJECTION_BASE_CHANGED')
        value = raw.decode()
        for replacement in binding['replacements']:
            need(value.count(replacement['before']) == 1 and replacement['before'], 'ENGINE_PROJECTION_CONTEXT_CHANGED')
            value = value.replace(replacement['before'], replacement['after'], 1)
        need(digest(value.encode()) == binding['candidateSha256'], 'ENGINE_PROJECTION_CANDIDATE_CHANGED')
        (context / path).write_text(value)


def prepare():
    contract = json.loads(CONTRACT.read_bytes())
    ensure_published_objects(contract)
    verify_sources(contract)
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True, mode=0o700)
    helper = load('recharge-record-build.py')
    raw = git('archive', contract['sourceBaseline'])
    for role in ('baseline', 'candidate'):
        context = OUTPUT / role
        helper.extract_source(raw, context)
        for name, binding in contract['publishedSources'].items():
            path = context / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(git('show', binding['commit'] + ':' + name))
        for name, binding in contract.get('publishedFileContents', {}).items():
            relative = name.removeprefix('apps/api/src/id-business-v2/online-recharge/engine/')
            need(name.startswith('apps/api/src/id-business-v2/online-recharge/engine/')
                 and digest(binding['content'].encode()) == binding['sha256']
                 == contract['baselineEngineInventory'][relative], 'PUBLISHED_CONTENT_CHANGED')
            (context / name).write_text(binding['content'])
        engine_root = context / 'apps/api/src/id-business-v2/online-recharge/engine'
        need(all((engine_root / name).is_file() and digest((engine_root / name).read_bytes()) == expected
                 for name, expected in contract['baselineEngineInventory'].items()), 'PUBLISHED_ENGINE_COMBINATION_CHANGED')
        if role == 'candidate':
            for name in {**contract['changedSources'], **contract.get('validationSources', {})}:
                path = context / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((ROOT / name).read_bytes())
            apply_engine_projection(contract, context)
        run('npm', 'ci', '--no-audit', cwd=context)
        run('npm', 'run', 'prisma:mysql:generate', '--workspace', 'apps/api', cwd=context)
        run('npm', 'run', 'build', '--workspace', 'packages/shared', cwd=context)


def api_delta(before, after, approved):
    changed = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
    allowed = {name.removesuffix('.js') + suffix for name in approved for suffix in ('.js', '.js.map', '.d.ts')}
    need(changed <= allowed and changed and not (before.keys() - after.keys()), 'API_OUTPUT_SCOPE_CHANGED')
    need(all(before.get(name) == expected for name, expected in approved.items()), 'BASE_API_NOT_REPRODUCED')
    return {name: after[name] for name in sorted(changed)}


def build_admin(context, contract, build_id):
    # The latest served Admin uses production output; do not substitute the older test build.
    need(contract['adminBuildNodeEnv'] == 'production', 'ADMIN_BUILD_ENVIRONMENT_CHANGED')
    run('npm', 'run', 'build', '--workspace', 'apps/admin', cwd=context,
        env={**os.environ, 'NODE_ENV': contract['adminBuildNodeEnv'], 'V2_BUILD_ID': build_id})
    return {'nodeEnv': contract['adminBuildNodeEnv'], 'buildId': build_id,
            'configuration': 'TRACKED_UNCHANGED', 'artifactPostProcessing': False}


def verify_engine_manifest(context):
    root = context / 'apps/api/src/id-business-v2/online-recharge/engine'
    manifest = json.loads((root / 'SOURCE_MANIFEST.json').read_bytes())
    entries = {item['path']: item['adaptedSha256'] for item in manifest['files']}
    need(len(entries) == len(manifest['files']) and entries and all(not name.startswith('/') and '..' not in Path(name).parts
         and (root / name).is_file() and digest((root / name).read_bytes()) == expected
         for name, expected in entries.items()), 'ENGINE_MANIFEST_CHANGED')
    return entries


def build():
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
    native = verify_published_native(contract)
    baseline, candidate = OUTPUT / 'baseline', OUTPUT / 'candidate'
    for context in (baseline, candidate):
        run('npm', 'run', 'build', '--workspace', 'apps/api', cwd=context)
    before = inventory(baseline / 'apps/api/dist')
    after = inventory(candidate / 'apps/api/dist')
    need({n: value for n, value in before.items() if n.endswith('.js')}
         == contract['baselineApiFiles'], 'BASE_API_ROLE_NOT_REPRODUCED')
    modules = api_delta(before, after, contract['apiModules'])
    engine_root = baseline / 'apps/api/src/id-business-v2/online-recharge/engine'
    need(all((digest((engine_root / name).read_bytes()) if (engine_root / name).exists() else None) == expected
             for name, expected in contract['engineFiles'].items()), 'BASE_ENGINE_NOT_REPRODUCED')
    # The full frontend is admitted only after reproducing the exact served predecessor.
    metadata_before = build_admin(baseline, contract, contract['baselineBuildId'])
    need(inventory(baseline / 'apps/admin/dist') == contract['baselineAdminFiles'], 'BASE_ADMIN_NOT_REPRODUCED')
    commit, tree = (git('rev-parse', ref).decode().strip() for ref in ('HEAD', 'HEAD^{tree}'))
    metadata_after = build_admin(candidate, contract, 'v2-' + commit)
    engine_manifest = verify_engine_manifest(candidate)
    database = json.loads((OUTPUT / 'database-verification.json').read_bytes())
    need(database == {'isolated': True, 'registrationMysqlSqlite': 'PASS', 'proxyMysql': 'PASS',
                      'externalRequests': 0, 'businessActions': 0}, 'DATABASE_EVIDENCE_MISSING')
    payload = OUTPUT / 'payload'
    payload.mkdir()
    for name in modules:
        path = payload / 'api/modules' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(candidate / 'apps/api/dist' / name, path)
    shutil.copytree(candidate / 'node_modules/.prisma/client', payload / 'api/prisma-client')
    schema = (candidate / 'apps/api/prisma-mysql/schema.prisma').read_bytes()
    need(digest(schema) == contract['changedSources']['apps/api/prisma-mysql/schema.prisma'], 'PRISMA_SCHEMA_CHANGED')
    (payload / 'api/schema.prisma').write_bytes(schema)
    shutil.copytree(candidate / 'apps/admin/dist', payload / 'admin/html')
    for name, expected in contract['changedSources'].items():
        need(digest((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
        raw = (candidate / name).read_bytes()
        need(digest(raw) == projected_source_hashes(contract)[name], 'RUNTIME_SOURCE_CHANGED')
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        if name.startswith('apps/api/src/id-business-v2/auto-registration/worker/') and not Path(name).name.startswith('test_'):
            worker = payload / 'api/worker' / Path(name).name
            worker.parent.mkdir(parents=True, exist_ok=True)
            worker.write_bytes(raw)
        engine_prefix = 'apps/api/src/id-business-v2/online-recharge/engine/'
        if name.startswith(engine_prefix) and name.removeprefix(engine_prefix) in contract['engineFiles']:
            engine = payload / 'online-recharge/engine' / name.removeprefix(engine_prefix)
            engine.parent.mkdir(parents=True, exist_ok=True)
            engine.write_bytes(raw)
    proof = {'version': 1, 'scope': SCOPE, 'commit': commit, 'tree': tree,
             'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': digest(CONTRACT.read_bytes()), 'baselineApiReproduced': True,
             'baselineAdminReproduced': True, 'adminBuildEnvironment': {'baseline': metadata_before, 'candidate': metadata_after},
             'engineManifestFiles': engine_manifest, 'observedAdminNativeBuild': contract['observedAdminNativeBuild'], 'baselinePublishedRecoveryNativeVerified': native, 'databaseVerification': database,
             'files': inventory(payload), 'apiModules': modules,
             'prismaClientFiles': inventory(payload / 'api/prisma-client'),
             'adminFiles': inventory(payload / 'admin/html'),
             'engineFiles': inventory(payload / 'online-recharge/engine'),
             'workerFiles': inventory(payload / 'api/worker'),
             'engineSourceProjection': contract.get('engineSourceProjection', {}),
             'updatedServices': ['api', 'admin', 'online-recharge'],
             'plannedMigration': contract['migration'], 'migrationPerformed': False, 'businessActions': 0}
    for name in contract['controlFiles']:
        proof.setdefault('controlSources', {})[name] = digest((HERE / name).read_bytes())
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUTPUT / 'registration-closure-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'REGISTRATION_CLOSURE_ARTIFACT_BUILT', 'apiFiles': len(modules),
                      'adminFiles': len(proof['adminFiles']), 'businessActions': 0}))


if __name__ == '__main__':
    if os.environ.get('REGISTRATION_FLOW_EVIDENCE') == '1':
        load('registration-flow-evidence-build.py').main(sys.argv[1:])
        raise SystemExit(0)
    need(len(sys.argv) == 2 and sys.argv[1] in ('prepare', 'build'), 'BUILD_MODE_INVALID')
    globals()[sys.argv[1]]()
