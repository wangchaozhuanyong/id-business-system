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
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / '.deploy/registration-parity-diagnostics'
CONTRACT = HERE / 'registration-parity-diagnostics-contract.json'
SCOPE = 'REGISTRATION_PARITY_DIAGNOSTICS'
CURRENT = 'd44393c5bee8c30c82737fc3e00fa89785a95667'
SALES_COMMIT = '034f6cad0bc58f3c6025912096df312e07bbd85e'
SALES_TREE = '1f351c9e04171ea3523e5163774c869c0de97557'
DRAG_PROOF = '77e0abe68b486c15c0fe724dacd1885982a7ed054296514e874b67cf1f3f2d8b'
ANCESTOR = 'e3e1360f977e003987573f2d2e042b883a2f5ac8'
SUCCESSOR_PROOF = '2cb761e7d3073814125d3a7cbfe3b0c2cd9258cc6f2684c75fb8317bb2016448'
SOURCE_BASE = 'd44393c5bee8c30c82737fc3e00fa89785a95667'
SOURCE_TREE = '7bf8dc7a4702272adcec2979025233300db5df95'
SCHEMA = 'apps/api/prisma-mysql/schema.prisma'
API = 'apps/api/src/id-business-v2/auto-registration/'
ADMIN = 'apps/admin/src/v2/features/auto-registration/'
WORKER = API + 'worker/'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
PARENT_CONTROLS = {'registration-flow-evidence-build.py': '0c6b8a100faa02019003daa037acbae55fc5d80891ffb9ce13ef373d8b4a7925', 'registration-flow-evidence-contract.json': '9d5f34916800fb885cb8aabd98bb550900775f47f17d666c8ad40a26f65215ae', 'registration-flow-evidence-dispatch.py': '8801f3de8d6749121ab60c7d8a108e9cb293e383c415114decdc92f4f7078f82', 'registration-flow-evidence-release.py': 'f6243432411f637a648e19a728dc4e1744a9682553aecb252b15991c42e1a3f3'}
SUCCESSOR_CONTROLS = {'chatgpt-sales-build.py': 'a55db7b0f04729d6f15d50ef3d7ae81a0746dceb2e95cd77408d0de74b9b7590', 'chatgpt-sales-contract.json': '7bcbfb2b3a5ec288c8a10e1a3d7b7a57abd95363fb37297bf50a017607be300a', 'chatgpt-sales-release.py': '16c27d9093fd2f0e2d8882f51f7584f3d68da3c6a714ee48d83b8cfee29979a5'}
DRAG_CONTROLS = {'workspace-drag-build.py': 'e2dba4371c53a4ad53b5c6ee96a1ddea5f5a7c455b8985a16540f89f410e17a7', 'workspace-drag-release.py': '28bcfed29eb45d66ece16b943e63b97f5f5500dacfc345cb23642bb4f9931fb0', 'workspace-drag-contract.json': '577497d7a7ec82ab540062738e44f1ee024a1c026469880706c4f37b45585e08'}


def need(value, code):
    if not value:
        raise RuntimeError('REGISTRATION_PARITY_DIAGNOSTICS_' + code)


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


def verify_immutable_inputs(contract):
    source_inputs = contract.get('sourceTreeInputs')
    need(isinstance(source_inputs, dict) and set(source_inputs) == {SCHEMA}
         and contract['unchangedInputs'].get(SCHEMA) == contract['schemaSha256']
         and re.fullmatch('[a-f0-9]{64}', source_inputs[SCHEMA]), 'SOURCE_TREE_INPUT_SCOPE_CHANGED')
    for name, expected in contract['unchangedInputs'].items():
        source_expected = source_inputs.get(name, expected)
        need(digest((ROOT / name).read_bytes()) == source_expected
             == digest(git('show', SOURCE_BASE + ':' + name)), 'IMMUTABLE_INPUT_CHANGED')


def verify_runtime_schema(context, contract):
    need(digest((context / SCHEMA).read_bytes()) == contract['schemaSha256']
         == contract['unchangedInputs'][SCHEMA], 'RUNTIME_SCHEMA_CHANGED')


def verify_sources(contract):
    need(contract.get('version') == 1 and contract.get('frozen') is True and contract.get('scope') == SCOPE
         and contract.get('expectedCurrent') == CURRENT and contract.get('sourceBaseline') == SOURCE_BASE
         and contract.get('sourceBaselineTree') == SOURCE_TREE and contract.get('migration') is None,
         'CONTRACT_NOT_FROZEN')
    load('registration-parity-diagnostics-release.py').verify_contract(contract)
    need(contract.get('parentControls') == PARENT_CONTROLS and all(
         digest((HERE / name).read_bytes()) == value == digest(git('show', ANCESTOR + ':scripts/production-release/' + name))
         for name, value in PARENT_CONTROLS.items()), 'PARENT_CONTROL_CHANGED')
    need(contract.get('parentContractSha256') == PARENT_CONTROLS['registration-flow-evidence-contract.json']
         and contract.get('parentProofSha256') == 'd62d44ea46a7cdae7b2e4a481d3821e869a3a1696e213a8fbc963a252d24c3cf'
         and contract['parentNative']['proofSha256'] == contract['parentProofSha256']
         and contract['parentNative']['commit'] == ANCESTOR
         and contract['parentNative']['tree'] == 'c08b181234ef15a07950cc9e3e1f334524d29c88',
         'PARENT_EVIDENCE_CHANGED')
    need(contract.get('successorControls') == SUCCESSOR_CONTROLS and all(
         digest((HERE / name).read_bytes()) == value == digest(git('show', SALES_COMMIT + ':scripts/production-release/' + name))
         for name, value in SUCCESSOR_CONTROLS.items())
         and contract.get('successorContractSha256') == SUCCESSOR_CONTROLS['chatgpt-sales-contract.json']
         and isinstance(contract.get('successorNative'), dict)
         and contract['successorNative'].get('commit') == SALES_COMMIT
         and contract['successorNative'].get('tree') == SALES_TREE
         and contract.get('successorProofSha256') == SUCCESSOR_PROOF
         and contract['successorNative'].get('proofSha256') == contract['successorProofSha256'],
         'PUBLISHED_SUCCESSOR_EVIDENCE_CHANGED')
    need(contract.get('dragControls') == DRAG_CONTROLS and all(
         digest((HERE / name).read_bytes()) == value == digest(git('show', CURRENT + ':scripts/production-release/' + name))
         for name, value in DRAG_CONTROLS.items())
         and contract.get('dragContractSha256') == DRAG_CONTROLS['workspace-drag-contract.json']
         and contract.get('dragProofSha256') == DRAG_PROOF
         and isinstance(contract.get('dragNative'), dict) and contract['dragNative'].get('commit') == CURRENT
         and contract['dragNative'].get('tree') == SOURCE_TREE
         and contract['dragNative'].get('proofSha256') == DRAG_PROOF, 'PUBLISHED_ADMIN_SUCCESSOR_EVIDENCE_CHANGED')
    need(isinstance(contract.get('reviewedApplicationCommit'), str)
         and re.fullmatch('[a-f0-9]{40}', contract['reviewedApplicationCommit'])
         and isinstance(contract.get('runtimeEvidence'), dict)
         and contract['runtimeEvidence'].get('status') == 'VERIFIED'
         and contract['runtimeEvidence'].get('commit') == CURRENT
         and isinstance(contract.get('current'), str) and contract['current'].startswith('/opt/id-business-v2/releases/')
         and re.fullmatch('[a-f0-9]{64}', contract.get('manifestSha256') or '')
         and isinstance(contract.get('services'), dict) and len(contract['services']) == 8
         and isinstance(contract.get('sqliteReviewPolicy'), dict), 'RUNTIME_BASELINE_MISSING')
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    need(git('rev-parse', SOURCE_BASE + '^{tree}').decode().strip() == SOURCE_TREE, 'BASE_TREE_CHANGED')
    changed = set(git('diff', '--name-only', SOURCE_BASE, 'HEAD').decode().splitlines())
    expected = contract.get('expectedGitChanges')
    need(isinstance(expected, list) and len(expected) == len(set(expected)) and changed == set(expected)
         and changed == set(contract['sources']) | set(contract['validationSources']) | set(contract['controlPaths']),
         'SOURCE_SCOPE_CHANGED')
    # The JS predicate independently closes the file list, source base/tree and every reviewed digest.
    command = "import {isRegistrationParityDiagnosticsOnly as check} from './scripts/ci-registration-parity-diagnostics-scope.mjs';" +         'if(!check(' + json.dumps(sorted(changed)) + ',{base:' + json.dumps(SOURCE_BASE) + ',baseTree:' + json.dumps(SOURCE_TREE) + '}))process.exit(2);'
    run('node', '--input-type=module', '-e', command)
    sources = contract['sources']
    need(sources and all((name.startswith(API) or name.startswith(ADMIN)) and '/upstream/' not in name
         and name in contract['allowedApplicationPaths'] for name in sources), 'BUSINESS_SCOPE_CHANGED')
    for name, expected_hash in {**sources, **contract['validationSources'], **contract['buildSupportHashes']}.items():
        need(re.fullmatch('[a-f0-9]{64}', expected_hash) and digest((ROOT / name).read_bytes()) == expected_hash, 'SOURCE_CHANGED')
    need(all(digest(git('show', contract['reviewedApplicationCommit'] + ':' + name)) == expected_hash
         for name, expected_hash in sources.items()), 'REVIEWED_APPLICATION_CHANGED')
    verify_immutable_inputs(contract)
    need(all(name.startswith(WORKER) and Path(name).name.startswith('test_') and name.endswith('.py')
         and contract['unchangedInputs'].get(name) == value
         for name, value in contract['validationBaselineSources'].items()), 'VALIDATION_BASELINE_CHANGED')
    worker_files = {name.removeprefix(WORKER): value for name, value in sources.items()
                    if name.startswith(WORKER) and not Path(name).name.startswith('test_')}
    need(worker_files == contract['workerFiles'] and 'flow_evidence.py' in worker_files
         and all('/' not in name and re.fullmatch(r'[a-z0-9_-]+\.(?:py|js|css)', name) for name in worker_files),
         'WORKER_SCOPE_CHANGED')
    need(contract['apiModules'] and all(name.startswith('id-business-v2/auto-registration/')
         and name.endswith('.js') for name in contract['apiModules']), 'API_MODULE_SCOPE_CHANGED')
    need(len(contract['baselinePrismaClientFiles']) == 18 and len(contract['runtimePrismaClientFiles']) == 27
         and all(contract['runtimePrismaClientFiles'].get(n) == value
         for n, value in contract['baselinePrismaClientFiles'].items()), 'CLIENT_CORE_CHANGED')


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
    parent = json.loads((HERE / 'registration-flow-evidence-contract.json').read_bytes())
    need(digest((HERE / 'registration-flow-evidence-contract.json').read_bytes()) == contract['parentContractSha256'],
         'PARENT_CONTRACT_CHANGED')
    # Reuse only the historical reconstruction recipe, never its source admission or publisher.
    load('registration-flow-evidence-build.py').reconstruct(context, parent)
    for name, expected in {**parent['sources'], **parent['validationSources']}.items():
        raw = git('show', ANCESTOR + ':' + name)
        need(digest(raw) == expected, 'PARENT_PUBLISHED_SOURCE_CHANGED')
        path = context / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    sales = json.loads((HERE / 'chatgpt-sales-contract.json').read_bytes())
    need(digest((HERE / 'chatgpt-sales-contract.json').read_bytes()) == contract['successorContractSha256']
         and contract['publishedSuccessorSources'] == sales['sources'], 'PUBLISHED_SUCCESSOR_RECIPE_CHANGED')
    # Published Sales is inheritance, not permission to include any newer Sales changes.
    for name, expected in sales['sources'].items():
        raw = git('show', SALES_COMMIT + ':' + name)
        need(digest(raw) == expected, 'PUBLISHED_SUCCESSOR_SOURCE_CHANGED')
        path = context / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    for name, entry in sales['adminPublishedSources'].items():
        need(digest((context / name).read_bytes()) == entry['sha256'], 'PUBLISHED_ADMIN_INHERITANCE_CHANGED')
    drag_recipe = json.loads((HERE / 'workspace-drag-contract.json').read_bytes())
    need(digest((HERE / 'workspace-drag-contract.json').read_bytes()) == contract['dragContractSha256']
         and contract['dragSources'] == drag_recipe['sources'], 'PUBLISHED_ADMIN_SUCCESSOR_RECIPE_CHANGED')
    # The Admin-only successor inherits the Sales compilation before these three sources.
    for name, expected in drag_recipe['sources'].items():
        raw = git('show', CURRENT + ':' + name)
        need(digest(raw) == expected, 'PUBLISHED_ADMIN_SUCCESSOR_SOURCE_CHANGED')
        path = context / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    need(inventory(context / ENGINE) == contract['baselineEngineFiles'], 'BASE_ENGINE_NOT_REPRODUCED')
    expected_worker = {n: parent['sources'].get(WORKER + n, value) if n.startswith('test_') else value
                       for n, value in contract['baselineWorkerFiles'].items()}
    need({n: digest((context / WORKER / n).read_bytes()) for n in expected_worker}
         == expected_worker, 'BASE_WORKER_NOT_REPRODUCED')
    verify_runtime_schema(context, contract)



def verify_drag_proof(proof, sales, contract):
    raw = (HERE / 'workspace-drag-contract.json').read_bytes()
    recipe = json.loads(raw)
    need(digest(raw) == contract['dragContractSha256'] == DRAG_CONTROLS['workspace-drag-contract.json']
         and proof.get('version') == 1 and proof.get('scope') == recipe['scope']
         and proof.get('commit') == CURRENT and proof.get('tree') == SOURCE_TREE
         and proof.get('contractSha256') == contract['dragContractSha256']
         and proof.get('controllerSha256') == DRAG_CONTROLS['workspace-drag-release.py']
         and proof.get('publishedProofSha256') == SUCCESSOR_PROOF
         and recipe['publishedProofSha256'] == SUCCESSOR_PROOF
         and proof.get('sources') == contract['dragSources'] == recipe['sources']
         and len(recipe['sources']) == 3 and proof.get('baselineAdminFiles') == sales['adminFiles']
         and proof.get('updatedServices') == ['admin'] and proof.get('migrationPerformed') is False
         and type(proof.get('businessActions')) is int and proof['businessActions'] == 0
         and proof.get('browserChecks') == 13, 'PUBLISHED_ADMIN_SUCCESSOR_NATIVE_CHANGED')
    need(proof.get('files') == {**{'source/' + n: v for n, v in recipe['sources'].items()},
         **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()}}, 'PUBLISHED_ADMIN_SUCCESSOR_PAYLOAD_CHANGED')
    return proof


def prepare():
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
    proof = native_proof(contract['parentNative'])
    parent = json.loads((HERE / 'registration-flow-evidence-contract.json').read_bytes())
    ancestor = {
        'baselineApiFiles': {**parent['baselineApiFiles'], **{n:v for n,v in proof['apiModules'].items() if n.endswith('.js')}},
        'baselineWorkerFiles': {**parent['baselineWorkerFiles'], **proof['workerFiles']},
        'runtimeAdminFiles': {**parent['runtimeAdminFiles'], **proof['adminFiles']}
    }
    need(proof['scope'] == 'REGISTRATION_FLOW_EVIDENCE'
         and proof['contractSha256'] == contract['parentContractSha256']
         and proof['sources'] == parent['sources'] and proof['workerFiles'] == parent['workerFiles']
         and proof['baselineApiReproduced'] is True and proof['baselineAdminReproduced'] is True
         and {**parent['baselineApiFiles'], **{n:v for n,v in proof['apiModules'].items() if n.endswith('.js')}} == ancestor['baselineApiFiles']
         and {**parent['baselineWorkerFiles'], **proof['workerFiles']} == ancestor['baselineWorkerFiles']
         and {**parent['runtimeAdminFiles'], **proof['adminFiles']} == ancestor['runtimeAdminFiles']
         and proof['baselinePrismaClientFiles'] == parent['baselinePrismaClientFiles']
         and proof['runtimePrismaClientFiles'] == parent['runtimePrismaClientFiles']
         and proof['schemaSha256'] == parent['schemaSha256']
         and proof['baselineEngineFiles'] == contract['baselineEngineFiles'], 'PARENT_NATIVE_PROOF_CHANGED')
    successor = native_proof(contract['successorNative'])
    sales = json.loads((HERE / 'chatgpt-sales-contract.json').read_bytes())
    drag = verify_drag_proof(native_proof(contract['dragNative']), successor, contract)
    need(successor['scope'] == sales['scope'] and successor['contractSha256'] == contract['successorContractSha256']
         and successor['controllerSha256'] == SUCCESSOR_CONTROLS['chatgpt-sales-release.py']
         and {n.removeprefix('source/'):v for n,v in successor['files'].items() if n.startswith('source/')} == sales['sources']
         and successor['adminPublishedSources'] == sales['adminPublishedSources']
         and successor['migration'] == sales['migration']
         and successor['generatedSchemaSha256'] == contract['baselinePrismaClientFiles']['schema.prisma']
         and successor['adminFiles'] == drag['baselineAdminFiles']
         and drag['adminFiles'] == contract['baselineAdminFiles']
         and {**ancestor['baselineApiFiles'], **{n:v for n,v in successor['apiModules'].items() if n.endswith('.js')}} == contract['baselineApiFiles']
         and contract['baselineWorkerFiles'] == ancestor['baselineWorkerFiles']
         and {**ancestor['runtimeAdminFiles'], **successor['adminFiles'], **drag['adminFiles']} == contract['runtimeAdminFiles']
         and contract['schemaSha256'] == sales['sources'][SCHEMA], 'PUBLISHED_SUCCESSOR_NATIVE_CHANGED')
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
        verify_runtime_schema(context, contract)
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
         and metadata['publishedContext'] == '/app',
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
             'sourceTreeInputs': contract['sourceTreeInputs'],
             'runtimeBaselineCommit': contract['expectedCurrent'], 'roleSourceCommits': contract['roleSourceCommits'],
             'reviewedApplicationCommit': contract['reviewedApplicationCommit'], 'sourceProjection': 'PUBLISHED_RUNTIME_PLUS_TASK_DELTA',
             'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': digest(contract_raw), 'sources': contract['sources'], 'validationSources': contract['validationSources'],
             'apiModules': modules, 'workerFiles': contract['workerFiles'], 'adminFiles': inventory(payload / 'admin/html'),
             'baselineApiReproduced': True, 'baselineAdminReproduced': True, 'unchangedClientReproduced': True,
             'baselinePrismaClientFiles': contract['baselinePrismaClientFiles'], 'schemaSha256': contract['schemaSha256'],
             'runtimePrismaClientFiles': contract['runtimePrismaClientFiles'],
             'runtimeAdminFiles': contract['runtimeAdminFiles'],
             'sourceProjectionSha256': contract['sourceProjectionSha256'],
             'runtimePythonDependencies': contract['runtimePythonDependencies'],
             'parentProofSha256': contract['parentProofSha256'], 'parentControls': contract['parentControls'],
             'successorProofSha256': contract['successorProofSha256'], 'successorControls': contract['successorControls'],
             'dragProofSha256': contract['dragProofSha256'], 'dragControls': contract['dragControls'],
             'hostSourceInheritance': contract['hostSourceInheritance'],
             'sqliteReviewPolicy': contract['sqliteReviewPolicy'],
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
    bundle = OUTPUT / 'registration-parity-diagnostics-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': SCOPE + '_ARTIFACT_BUILT', 'apiFiles': len(proof['apiModules']), 'workerFiles': len(contract['workerFiles']),
                      'adminFiles': len(proof['adminFiles']), 'migrationPerformed': False}))


def validate():
    """The same finite commands run against the isolated reconstructed candidate."""
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
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


if __name__ == '__main__':
    main(sys.argv[1:])
