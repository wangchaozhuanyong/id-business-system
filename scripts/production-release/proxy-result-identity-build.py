"""Reproduce the published engine; package three files and one API static asset."""
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
OUTPUT = ROOT / '.deploy/proxy-result-identity'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
SCOPE = 'PROXY_RESULT_IDENTITY_AND_REGISTRATION_DRAFT'
CONTRACT = Path(__file__).with_name('proxy-result-identity-contract.json')


def need(value, code):
    if not value:
        raise RuntimeError('PROXY_RESULT_IDENTITY_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def load(name):
    spec = importlib.util.spec_from_file_location('engine_patch_' + name.replace('-', '_'), Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_sources(contract):
    need(contract['scope'] == SCOPE and contract['expectedCurrent'] == '7c3c102c98539d33cb379ef018427371ba750cb7', 'SCOPE_CHANGED')
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    changed = set(git('diff', '--name-only', contract['expectedCurrent'], 'HEAD').decode().splitlines())
    need(changed <= set(contract['allowedPaths']) and set(contract['sources']) <= changed, 'SOURCE_SCOPE_CHANGED')
    need(len(contract['sources']) == 4 and set(contract['engineFiles']) == {'security.cjs', contract['testFile'], 'SOURCE_MANIFEST.json'}
         and set(contract['sources']) == {ENGINE + name for name in contract['engineFiles']} | {contract['apiStaticPath']}
         and contract['apiStaticPath'] == 'apps/api/src/id-business-v2/auto-registration/worker/id-workspace.js'
         and contract['beforeApiStaticSha256'] == 'cad8c63221b3f4bdf6e824bc03c1d0e5fa4ebc588501eca1ae12ec7eb219cc93'
         and all(name.startswith('test/') and re.fullmatch(r'test/[a-z0-9.-]+\.cjs', name) for name in [contract['testFile']]),
         'ENGINE_SCOPE_CHANGED')
    for name, expected in contract['sources'].items():
        need(digest((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
        if name.startswith(ENGINE):
            need(expected == contract['engineFiles'][name.removeprefix(ENGINE)], 'ENGINE_SOURCE_CHANGED')
    for name, expected in {**contract['validationSources'], **contract['buildSupportHashes']}.items():
        need(digest((ROOT / name).read_bytes()) == expected, 'VALIDATION_INPUT_CHANGED')
    need(contract['beforeEngineFiles'].get('security.cjs') == 'a80307ac306cc5e1186a153622e06881a998e4284e5bff7fbc224d88b6bb278b'
         and contract['beforeEngineFiles'].get('SOURCE_MANIFEST.json') == '92312ac5e98a3ce4a0aec22390cb589352f317142ca87912d0509a378f94a081'
         and contract['testFile'] not in contract['beforeEngineFiles'] and len(contract['beforeEngineFiles']) == 82, 'BASE_ENGINE_CHANGED')


def extract_api_fixtures(contract, destination):
    """Reusable by Quality: authenticated unchanged consumer JS, never compiled or deployed."""
    binding = contract['baselineNative']
    prefix = 'repos/wangchaozhuanyong/id-business-system/'
    meta = json.loads(subprocess.check_output(['gh', 'api', prefix + 'actions/runs/' + binding['runId']], cwd=ROOT))
    need(meta['head_sha'] == contract['expectedCurrent'] and meta['conclusion'] == 'success'
         and meta['path'] == '.github/workflows/registration-closure-validation.yml', 'BASE_NATIVE_CHANGED')
    artifacts = json.loads(subprocess.check_output(['gh', 'api', prefix + 'actions/runs/' + binding['runId'] + '/artifacts'], cwd=ROOT))['artifacts']
    matches = [value for value in artifacts if value['id'] == binding['artifactId'] and value['digest'] == binding['artifactDigest']
               and not value['expired'] and value['workflow_run']['head_sha'] == contract['expectedCurrent']]
    need(len(matches) == 1 and matches[0]['size_in_bytes'] <= 32 * 1024**2, 'BASE_NATIVE_ARTIFACT_CHANGED')
    zipped = subprocess.check_output(['gh', 'api', prefix + 'actions/artifacts/' + str(binding['artifactId']) + '/zip'], cwd=ROOT)
    need(len(zipped) <= 32 * 1024**2 and 'sha256:' + digest(zipped) == binding['artifactDigest'], 'BASE_NATIVE_BYTES_CHANGED')
    with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
        names = [name for name in archive.namelist() if name.endswith('registration-closure-artifact.tar.gz')]
        need(len(names) == 1 and archive.getinfo(names[0]).file_size <= 32 * 1024**2, 'BASE_BUNDLE_INVALID')
        raw = archive.read(names[0])
    need(digest(raw) == binding['bundleSha256'], 'BASE_BUNDLE_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        proof_raw = archive.extractfile('payload/build-proof.json').read()
        need(digest(proof_raw) == binding['buildProofSha256'], 'BASE_PROOF_CHANGED')
        proof = json.loads(proof_raw)
        need(proof['commit'] == contract['expectedCurrent'] and proof['tree'] == contract['baselineTree']
             and proof['controlSources']['registration-closure-release.py'] == '0d2daaeff0a35e1e11666ace39560273fdc83ff9e5718cb244337c8b0f851274'
             and proof['engineFiles']['SOURCE_MANIFEST.json'] == contract['beforeEngineFiles']['SOURCE_MANIFEST.json'], 'BASE_PROOF_IDENTITY_CHANGED')
        for name, expected in contract['fixtureFiles'].items():
            raw = archive.extractfile('payload/api/modules/' + name).read()
            need(digest(raw) == expected == proof['apiModules'][name], 'API_FIXTURE_CHANGED')
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
    return contract['fixtureFiles']


def reconstruct_engine(contract, destination):
    recipe_raw = git('show', contract['expectedCurrent'] + ':scripts/production-release/registration-closure-contract.json')
    need(digest(recipe_raw) == contract['baselineRecipeSha256'], 'BASE_RECIPE_CHANGED')
    recipe = json.loads(recipe_raw)
    old = load('registration-closure-build.py')
    old.ensure_published_objects(recipe)
    work = OUTPUT / 'reconstruction'
    need(not work.exists(), 'RECONSTRUCTION_EXISTS')
    work.mkdir(parents=True)
    raw = git('archive', recipe['sourceBaseline'], ENGINE.rstrip('/'))
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for item in archive.getmembers():
            inside = item.name == ENGINE.rstrip('/') or item.name.startswith(ENGINE)
            ancestor = item.isdir() and ENGINE.startswith(item.name.rstrip('/') + '/')
            need((item.isfile() or item.isdir()) and (inside or ancestor) and '..' not in Path(item.name).parts,
                 'BASE_SOURCE_ARCHIVE_INVALID')
            path = work / item.name
            if item.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.extractfile(item).read())
    for name, binding in recipe['publishedSources'].items():
        if name.startswith(ENGINE):
            raw = git('show', binding['commit'] + ':' + name)
            need(digest(raw) == binding['sha256'], 'BASE_PUBLISHED_SOURCE_CHANGED')
            (work / name).write_bytes(raw)
    for name, binding in recipe.get('publishedFileContents', {}).items():
        need(name.startswith(ENGINE) and digest(binding['content'].encode()) == binding['sha256'], 'BASE_PUBLISHED_CONTENT_CHANGED')
        (work / name).parent.mkdir(parents=True, exist_ok=True)
        (work / name).write_bytes(binding['content'].encode())
    for name, expected in recipe['changedSources'].items():
        if name.startswith(ENGINE):
            raw = git('show', contract['expectedCurrent'] + ':' + name)
            need(digest(raw) == expected, 'BASE_APPROVED_SOURCE_CHANGED')
            (work / name).parent.mkdir(parents=True, exist_ok=True)
            (work / name).write_bytes(raw)
    old.apply_engine_projection(recipe, work)
    for name, expected in contract['beforeEngineFiles'].items():
        raw = (work / ENGINE / name).read_bytes()
        need(digest(raw) == expected, 'BASE_ENGINE_NOT_REPRODUCED')
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    return contract['beforeEngineFiles']


def verify_manifest(directory, expected):
    rows = json.loads((directory / 'SOURCE_MANIFEST.json').read_bytes())['files']
    entries = {row['path']: row['adaptedSha256'] for row in rows}
    need(len(entries) == len(rows) and entries == {name: value for name, value in expected.items() if name != 'SOURCE_MANIFEST.json'},
         'ENGINE_MANIFEST_CHANGED')
    actual = {str(path.relative_to(directory)): digest(path.read_bytes()) for path in directory.rglob('*') if path.is_file()}
    need(actual == expected, 'ENGINE_INVENTORY_CHANGED')
    return entries


def prepare():
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True, mode=0o700)
    reconstruct_engine(contract, OUTPUT / 'before-engine')
    verify_manifest(OUTPUT / 'before-engine', contract['beforeEngineFiles'])
    shutil.copytree(OUTPUT / 'before-engine', OUTPUT / 'candidate-engine')
    for name in contract['engineFiles']:
        path = OUTPUT / 'candidate-engine' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((ROOT / ENGINE / name).read_bytes())
    verify_manifest(OUTPUT / 'candidate-engine', {**contract['beforeEngineFiles'], **contract['engineFiles']})
    extract_api_fixtures(contract, OUTPUT / 'fixtures/api')
    (OUTPUT / 'api-static').mkdir()
    (OUTPUT / 'api-static/id-workspace.js').write_bytes((ROOT / contract['apiStaticPath']).read_bytes())
    print(json.dumps({'status': 'PROXY_RESULT_IDENTITY_BASE_REPRODUCED', 'beforeFiles': 82, 'afterFiles': 83,
                      'apiFixtures': 2, 'businessActions': 0}))


def package():
    contract_raw = CONTRACT.read_bytes()
    contract = json.loads(contract_raw)
    verify_sources(contract)
    after = {**contract['beforeEngineFiles'], **contract['engineFiles']}
    # npm's private dependency directory is excluded; all tracked engine files stay exact.
    for name, expected in after.items():
        need(digest((OUTPUT / 'candidate-engine' / name).read_bytes()) == expected, 'ENGINE_CHANGED_AFTER_TESTS')
    payload = OUTPUT / 'payload'
    payload.mkdir(mode=0o700)
    for name in contract['engineFiles']:
        path = payload / 'engine' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((OUTPUT / 'candidate-engine' / name).read_bytes())
    shutil.copytree(OUTPUT / 'fixtures', payload / 'fixtures')
    need(digest((OUTPUT / 'api-static/id-workspace.js').read_bytes()) == contract['sources'][contract['apiStaticPath']],
         'API_STATIC_CHANGED_AFTER_TESTS')
    shutil.copytree(OUTPUT / 'api-static', payload / 'api-static')
    proof = {'version': 1, 'scope': SCOPE, 'commit': git('rev-parse', 'HEAD').decode().strip(),
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'workflowRunId': os.environ['GITHUB_RUN_ID'],
             'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'contractSha256': digest(contract_raw),
             'controlSources': {name: digest(Path(__file__).with_name(name).read_bytes()) for name in contract['controlFiles']},
             'sources': contract['sources'], 'validationSources': contract['validationSources'],
             'beforeEngineFiles': contract['beforeEngineFiles'], 'afterEngineFiles': after,
             'fixtureFiles': contract['fixtureFiles'], 'baselineNative': contract['baselineNative'],
             'updatedServices': ['api', 'online-recharge'], 'migrationPerformed': False, 'businessActions': 0}
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    path = OUTPUT / 'proxy-result-identity-artifact.tar.gz'
    with tarfile.open(path, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest(path.read_bytes()) + '\n')
    print(json.dumps({'status': 'PROXY_RESULT_IDENTITY_ARTIFACT_BUILT', 'engineFiles': 3, 'apiStaticAssets': 1,
                      'apiCompiledModulesUpdated': False, 'businessActions': 0}))


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['prepare']:
        prepare()
    elif sys.argv[1:] == ['package']:
        package()
    elif len(sys.argv) == 3 and sys.argv[1] == 'fixtures':
        extract_api_fixtures(json.loads(CONTRACT.read_bytes()), Path(sys.argv[2]).resolve())
    else:
        raise SystemExit('Expected prepare, package, or fixtures <owned-output>')
