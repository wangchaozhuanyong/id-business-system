"""Finite no-migration successor of the registration-closure publication channel."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / '.deploy/registration-flow-evidence'
CONTRACT = HERE / 'registration-flow-evidence-contract.json'
SCOPE = 'REGISTRATION_FLOW_EVIDENCE'
BASE = '69eba563895bf083b24c8214a088454d5df34922'
SOURCE_BASE = '88bce5ab09d20cd303f1fdd5fe310cb0b42e1451'
API = 'apps/api/src/id-business-v2/auto-registration/'
ADMIN = 'apps/admin/src/v2/features/auto-registration/'
WORKER = API + 'worker/'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'


def need(value, code):
    if not value:
        raise RuntimeError('REGISTRATION_FLOW_EVIDENCE_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location('flow_build_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def inventory(directory):
    result = load('recharge-record-release.py').file_inventory(directory)
    return {name: value for name, value in result.items()
            if name not in ('tsconfig.tsbuildinfo', 'tsconfig.build.tsbuildinfo')}


def verify_sources(contract):
    need(contract.get('version') == 1 and contract.get('frozen') is True and contract.get('scope') == SCOPE
         and contract.get('expectedCurrent') == BASE and contract.get('sourceBaseline') == SOURCE_BASE
         and contract.get('migration') is None,
         'CONTRACT_NOT_FROZEN')
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    need(git('rev-parse', SOURCE_BASE + '^{tree}').decode().strip() == contract['sourceBaselineTree'], 'BASE_TREE_CHANGED')
    changed = set(git('diff', '--name-only', SOURCE_BASE, 'HEAD').decode().splitlines())
    sources = contract['sources']
    need(sources and changed == set(sources) | set(contract['validationSources']) | set(contract['controlPaths']),
         'SOURCE_SCOPE_CHANGED')
    need(all((name.startswith(API) or name.startswith(ADMIN)) and '/upstream/' not in name
             and name in contract['allowedApplicationPaths'] for name in sources), 'BUSINESS_SCOPE_CHANGED')
    for name, expected in {**sources, **contract['validationSources'], **contract['buildSupportHashes']}.items():
        need(re.fullmatch('[a-f0-9]{64}', expected) and digest((ROOT / name).read_bytes()) == expected,
             'SOURCE_CHANGED')
    for name, expected in contract['unchangedInputs'].items():
        need(digest((ROOT / name).read_bytes()) == expected == digest(git('show', SOURCE_BASE + ':' + name)),
             'IMMUTABLE_INPUT_CHANGED')
    need(contract['validationBaselineSources'] and all(name.startswith(WORKER)
         and Path(name).name.startswith('test_') and name.endswith('.py')
         and contract['unchangedInputs'].get(name) == value
         for name, value in contract['validationBaselineSources'].items()), 'VALIDATION_BASELINE_CHANGED')
    worker_files = {name.removeprefix(WORKER): value for name, value in sources.items()
                    if name.startswith(WORKER) and not Path(name).name.startswith('test_')}
    need(worker_files == contract['workerFiles'] and 'flow_evidence.py' in worker_files
         and all('/' not in name and re.fullmatch(r'[a-z0-9_-]+\.(?:py|js|css)', name) for name in worker_files),
         'WORKER_SCOPE_CHANGED')
    need(contract['apiModules'] and all(name.startswith('id-business-v2/auto-registration/')
         and name.endswith('.js') for name in contract['apiModules']), 'API_MODULE_SCOPE_CHANGED')


def native_proof(binding):
    prefix = 'repos/wangchaozhuanyong/id-business-system/'
    meta = json.loads(subprocess.check_output(['gh', 'api', prefix + 'actions/runs/' + binding['runId']], cwd=ROOT))
    need(meta['head_sha'] == binding['commit'] and meta['conclusion'] == 'success'
         and meta['path'] == binding['workflowPath'] and meta['run_attempt'] == binding['runAttempt'],
         'PUBLISHED_NATIVE_CHANGED')
    artifacts = json.loads(subprocess.check_output(['gh', 'api', prefix + 'actions/runs/'
        + binding['runId'] + '/artifacts?per_page=100'], cwd=ROOT))['artifacts']
    selected = [row for row in artifacts if row['id'] == binding['artifactId'] and not row['expired']
                and row['digest'] == binding['artifactDigest'] and row['workflow_run']['head_sha'] == binding['commit']]
    need(len(selected) == 1 and selected[0]['size_in_bytes'] <= 64 * 1024**2, 'PUBLISHED_ARTIFACT_CHANGED')
    raw = subprocess.check_output(['gh', 'api', prefix + 'actions/artifacts/' + str(binding['artifactId']) + '/zip'], cwd=ROOT)
    need(len(raw) <= 64 * 1024**2 and 'sha256:' + digest(raw) == binding['artifactDigest'], 'PUBLISHED_ARTIFACT_BYTES_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = [name for name in archive.namelist() if name.endswith(binding['bundleName'])]
        need(len(names) == 1 and archive.getinfo(names[0]).file_size <= 64 * 1024**2, 'PUBLISHED_BUNDLE_INVALID')
        bundle = archive.read(names[0])
    need(digest(bundle) == binding['bundleSha256'], 'PUBLISHED_BUNDLE_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        proof_raw = archive.extractfile('payload/build-proof.json').read()
    need(digest(proof_raw) == binding['proofSha256'], 'PUBLISHED_PROOF_CHANGED')
    proof = json.loads(proof_raw)
    need(proof['commit'] == binding['commit'] and proof['tree'] == binding['tree'], 'PUBLISHED_PROOF_IDENTITY_CHANGED')
    return proof


def reconstruct(context, contract):
    binding = contract['reconstruction']
    raw = git('show', binding['registrationCommit'] + ':scripts/production-release/registration-closure-contract.json')
    need(digest(raw) == binding['recipeSha256'], 'PUBLISHED_RECIPE_CHANGED')
    recipe = json.loads(raw)
    old = load('registration-closure-build.py')
    old.ensure_published_objects(recipe)
    load('recharge-record-build.py').extract_source(git('archive', recipe['sourceBaseline']), context)
    for name, source in recipe['publishedSources'].items():
        raw = git('show', source['commit'] + ':' + name)
        need(digest(raw) == source['sha256'], 'PUBLISHED_SOURCE_CHANGED')
        path = context / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    for name, source in recipe.get('publishedFileContents', {}).items():
        need(name.startswith(ENGINE) and digest(source['content'].encode()) == source['sha256'], 'PUBLISHED_RAW_CHANGED')
        (context / name).write_bytes(source['content'].encode())
    for name, expected in recipe['changedSources'].items():
        raw = git('show', binding['registrationCommit'] + ':' + name)
        need(digest(raw) == expected, 'PUBLISHED_REGISTRATION_SOURCE_CHANGED')
        path = context / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    old.apply_engine_projection(recipe, context)
    patch = json.loads(git('show', BASE + ':scripts/production-release/proxy-result-identity-contract.json'))
    need(digest(git('show', BASE + ':scripts/production-release/proxy-result-identity-contract.json'))
         == binding['identityRecipeSha256'], 'PUBLISHED_IDENTITY_RECIPE_CHANGED')
    for name, expected in patch['sources'].items():
        raw = git('show', BASE + ':' + name)
        need(digest(raw) == expected, 'PUBLISHED_IDENTITY_SOURCE_CHANGED')
        path = context / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    # Old images contain three unchanged tests from the preceding worker layer.
    # Reproduce those bytes independently of the newer validation source tree.
    for name, source in binding['runtimeSources'].items():
        need(name.startswith(WORKER) and Path(name).name.startswith('test_'), 'PUBLISHED_TEST_PATH_CHANGED')
        raw = git('show', source['commit'] + ':' + name)
        need(digest(raw) == source['sha256'], 'PUBLISHED_TEST_SOURCE_CHANGED')
        (context / name).write_bytes(raw)
    for name, expected in contract['baselineWorkerFiles'].items():
        need(digest((context / WORKER / name).read_bytes()) == expected, 'BASE_WORKER_NOT_REPRODUCED')
    need(inventory(context / ENGINE) == contract['baselineEngineFiles'], 'BASE_ENGINE_NOT_REPRODUCED')


def prepare():
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
    proof = native_proof(contract['registrationNative'])
    patch = native_proof(contract['identityNative'])
    need(proof['adminFiles'] == contract['baselineAdminFiles']
         and proof['prismaClientFiles'] == contract['baselinePrismaClientFiles']
         and {**json.loads(git('show', contract['reconstruction']['registrationCommit']
                + ':scripts/production-release/registration-closure-contract.json'))['baselineApiFiles'],
              **{n: value for n, value in proof['apiModules'].items() if n.endswith('.js')}} == contract['baselineApiFiles']
         and patch['afterEngineFiles'] == contract['baselineEngineFiles'], 'PUBLISHED_INVENTORY_CHANGED')
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True, mode=0o700)
    for role in ('baseline', 'candidate'):
        context = OUTPUT / role
        reconstruct(context, contract)
        if role == 'candidate':
            for name in {**contract['sources'], **contract['validationSources'], **contract['validationBaselineSources']}:
                path = context / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((ROOT / name).read_bytes())
        run('npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context)
        run('npm', 'run', 'prisma:mysql:generate', '--workspace', 'apps/api', cwd=context)
        run('npm', 'run', 'build', '--workspace', 'packages/shared', cwd=context)
    print(json.dumps({'status': SCOPE + '_PREPARED', 'separatePrismaClients': True, 'migrationPerformed': False}))


def api_delta(before, after, approved):
    allowed = {name.removesuffix('.js') + suffix for name in approved for suffix in ('.js', '.js.map', '.d.ts')}
    changed = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
    need(changed and changed <= allowed and not (before.keys() - after.keys()), 'API_OUTPUT_SCOPE_CHANGED')
    need(all(before.get(name) == expected for name, expected in approved.items()), 'BASE_APPROVED_MODULE_NOT_REPRODUCED')
    return {name: after[name] for name in sorted(changed)}


def unchanged_client(context, contract):
    """Compare all runtime bytes, rewriting only two known generated metadata fields."""
    directory = context / 'node_modules/.prisma/client'
    values = load('recharge-record-release.py').file_inventory(directory)
    metadata = contract['prismaPathMetadata']
    need(metadata['files'] == ['index.js', 'edge.js', 'wasm.js']
         and metadata['publishedContext'] == '/home/runner/work/id-business-system/id-business-system/.deploy/registration-closure-release/candidate',
         'CLIENT_METADATA_SCOPE_CHANGED')
    for name in metadata['files']:
        raw = (directory / name).read_bytes().decode('utf-8')
        for field, suffix in [('"output": {\n      "value": ', 'node_modules/@prisma/client'),
                              ('"sourceFilePath": ', 'apps/api/prisma-mysql/schema.prisma')]:
            before = field + json.dumps(str(context / suffix), ensure_ascii=False)
            after = field + json.dumps(metadata['publishedContext'] + '/' + suffix)
            need(raw.count(before) == 1, 'CLIENT_METADATA_FIELD_CHANGED')
            raw = raw.replace(before, after, 1)
        values[name] = digest(raw.encode())
    need(values == contract['baselinePrismaClientFiles'], 'UNCHANGED_CLIENT_NOT_REPRODUCED')
    return values


def build():
    contract_raw = CONTRACT.read_bytes()
    contract = json.loads(contract_raw)
    verify_sources(contract)
    baseline, candidate = OUTPUT / 'baseline', OUTPUT / 'candidate'
    for context in (baseline, candidate):
        run('npm', 'run', 'build', '--workspace', 'apps/api', cwd=context)
    before, after = inventory(baseline / 'apps/api/dist'), inventory(candidate / 'apps/api/dist')
    need({n: value for n, value in before.items() if n.endswith('.js')} == contract['baselineApiFiles'], 'BASE_API_NOT_REPRODUCED')
    modules = api_delta(before, after, contract['apiModules'])
    need(unchanged_client(baseline, contract) == unchanged_client(candidate, contract),
         'UNCHANGED_CLIENT_NOT_REPRODUCED')
    commit, tree = (git('rev-parse', ref).decode().strip() for ref in ('HEAD', 'HEAD^{tree}'))
    for context, build_id in [(baseline, contract['baselineAdminBuildId']), (candidate, 'v2-' + commit)]:
        run('npm', 'run', 'build', '--workspace', 'apps/admin', cwd=context,
            env={**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': build_id})
    need(inventory(baseline / 'apps/admin/dist') == contract['baselineAdminFiles'], 'BASE_ADMIN_NOT_REPRODUCED')
    payload = OUTPUT / 'payload'
    payload.mkdir(mode=0o700)
    for name in modules:
        path = payload / 'api/modules' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(candidate / 'apps/api/dist' / name, path)
    for name, expected in contract['workerFiles'].items():
        path = payload / 'api/worker' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = (candidate / WORKER / name).read_bytes()
        need(digest(raw) == expected, 'WORKER_SOURCE_CHANGED')
        path.write_bytes(raw)
    shutil.copytree(candidate / 'apps/admin/dist', payload / 'admin/html')
    for name, expected in contract['sources'].items():
        raw = (candidate / name).read_bytes()
        need(digest(raw) == expected, 'SOURCE_CHANGED_AFTER_TESTS')
        path = payload / 'source' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    proof = {'version': 1, 'scope': SCOPE, 'commit': commit, 'tree': tree,
             'sourceBaseline': contract['sourceBaseline'], 'sourceBaselineTree': contract['sourceBaselineTree'],
             'runtimeBaselineCommit': BASE, 'sourceProjection': 'PUBLISHED_RUNTIME_PLUS_TASK_DELTA',
             'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': digest(contract_raw), 'sources': contract['sources'], 'validationSources': contract['validationSources'],
             'apiModules': modules, 'workerFiles': contract['workerFiles'], 'adminFiles': inventory(payload / 'admin/html'),
             'baselineApiReproduced': True, 'baselineAdminReproduced': True, 'unchangedClientReproduced': True,
             'baselinePrismaClientFiles': contract['baselinePrismaClientFiles'], 'schemaSha256': contract['schemaSha256'],
             'prismaPathMetadata': contract['prismaPathMetadata'],
             'independentlyGeneratedClientFiles': {role: load('recharge-record-release.py').file_inventory(context / 'node_modules/.prisma/client')
                 for role, context in [('baseline', baseline), ('candidate', candidate)]},
             'baselineEngineFiles': contract['baselineEngineFiles'], 'registrationNative': contract['registrationNative'],
             'identityNative': contract['identityNative'], 'updatedServices': ['api', 'admin'],
             'reboundServices': ['online-recharge'], 'migrationPerformed': False, 'businessActions': 0,
             'files': inventory(payload),
             'controlSources': {name: digest((HERE / name).read_bytes()) for name in contract['controlFiles']}}
    (OUTPUT / 'prepared-build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': SCOPE + '_COMPILED', 'apiFiles': len(modules), 'workerFiles': len(contract['workerFiles']),
                      'adminFiles': len(proof['adminFiles']), 'migrationPerformed': False}))


def package():
    contract_raw = CONTRACT.read_bytes()
    contract = json.loads(contract_raw)
    verify_sources(contract)
    payload = OUTPUT / 'payload'
    proof = json.loads((OUTPUT / 'prepared-build-proof.json').read_bytes())
    need(proof['commit'] == git('rev-parse', 'HEAD').decode().strip()
         and proof['tree'] == git('rev-parse', 'HEAD^{tree}').decode().strip()
         and proof['contractSha256'] == digest(contract_raw)
         and proof['controlSources'] == {name: digest((HERE / name).read_bytes()) for name in contract['controlFiles']}
         and inventory(payload) == proof['files'], 'COMPILED_INPUT_MOVED')
    validation = json.loads((OUTPUT / 'validation-receipt.json').read_bytes())
    need(validation == {'scope': SCOPE, 'sources': contract['sources'], 'validationSources': contract['validationSources'],
                       'businessActions': 0, 'externalRequests': 0, 'status': 'PASS'}, 'VALIDATION_RECEIPT_MISSING')
    proof['validation'] = validation
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUTPUT / 'registration-flow-evidence-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': SCOPE + '_ARTIFACT_BUILT', 'apiFiles': len(proof['apiModules']), 'workerFiles': len(contract['workerFiles']),
                      'adminFiles': len(proof['adminFiles']), 'migrationPerformed': False}))


def validate():
    """The same finite commands run against the isolated reconstructed candidate."""
    contract = json.loads(CONTRACT.read_bytes())
    context = OUTPUT / 'candidate'
    python = OUTPUT / 'python/bin/python'
    (context / '.runtime').mkdir(parents=True, exist_ok=True)
    for module in contract['pythonTests']:
        need(re.fullmatch('test_[a-z0-9_]+', module), 'PYTHON_TEST_PATH_INVALID')
        run(str(python), '-B', '-m', 'unittest', module, cwd=context / WORKER)
    for workspace, tests in [('apps/api', contract['apiTests']), ('apps/admin', contract['adminTests'])]:
        run('npm', 'run', 'test', '--workspace', workspace, '--', *tests, cwd=context)
    for guard in ('admin-ui', 'v2-ui-language', 'v2-color-contrast', 'v2-table-standard',
                  'v2-loading-standard', 'v2-module-architecture', 'v2-isolation'):
        run('npm', 'run', 'check:' + guard, cwd=context)
    for workspace in ('apps/api', 'apps/admin'):
        run('npm', 'run', 'typecheck', '--workspace', workspace, cwd=context)
    for script in contract['browserAcceptances']:
        need(script in contract['validationSources'] and script.startswith('scripts/acceptance-v2-'), 'BROWSER_TEST_PATH_INVALID')
        run('node', script, '--python=' + str(python), cwd=context)
    (OUTPUT / 'validation-receipt.json').write_text(json.dumps({'scope': SCOPE, 'sources': contract['sources'],
        'validationSources': contract['validationSources'], 'businessActions': 0, 'externalRequests': 0, 'status': 'PASS'}, sort_keys=True) + '\n')


def main(arguments):
    need(arguments in (['prepare'], ['validate'], ['build'], ['package']), 'BUILD_MODE_INVALID')
    globals()[arguments[0]]()
