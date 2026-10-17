"""Build only the reviewed API and embedded-checkout engine delta in native CI."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / '.deploy/online-checkout-cs'
CONTRACT_FILE = 'online-checkout-cs-contract.json'


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def need(ok, code):
    if not ok:
        raise RuntimeError('ONLINE_CHECKOUT_CS_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, env={**os.environ, 'NODE_ENV': 'production'}, check=True)


def reconstruct(context, contract):
    # Retain the already published 055b engine and the later audited 8df closure.
    raw = (HERE / 'online-legacy-close-contract.json').read_bytes()
    need(sha(raw) == contract['predecessorContractSha256'], 'PREDECESSOR_RECIPE_CHANGED')
    previous = json.loads(raw)
    builder = load('online-legacy-close-build.py')
    builder.OUT = OUT
    builder.reconstruct(context, previous)
    for name, expected in previous['sources'].items():
        raw = git('show', contract['publishedSourceCommit'] + ':' + name)
        need(sha(raw) == expected, 'PUBLISHED_CLOSURE_SOURCE_CHANGED')
        target = context / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    inventory = load('recharge-record-release.py').file_inventory
    need(inventory(context / contract['engineRoot']) == contract['beforeEngineFiles'],
         'PUBLISHED_ENGINE_CHANGED')


def engine_manifest(context, contract):
    engine = context / contract['engineRoot']
    rows = json.loads((engine / 'SOURCE_MANIFEST.json').read_bytes())['files']
    entries = {row['path']: row['adaptedSha256'] for row in rows}
    need(len(entries) == len(rows) and entries == {
        name: digest for name, digest in contract['afterEngineFiles'].items()
        if name != 'SOURCE_MANIFEST.json'
    } and all(sha((engine / name).read_bytes()) == digest for name, digest in entries.items()),
        'ENGINE_MANIFEST_CHANGED')


def validation_sources(context, contract):
    need(contract.get('validationOnlySources') == load('online-checkout-cs-release.py').VALIDATION_ONLY_SOURCES,
         'VALIDATION_SOURCE_CHANGED')
    for name, pin in contract['validationOnlySources'].items():
        raw = git('show', pin['commit'] + ':' + name)
        need(sha(raw) == pin['sha256'], 'VALIDATION_SOURCE_CHANGED')
        target = context / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)


def main():
    raw_contract = (HERE / CONTRACT_FILE).read_bytes()
    contract = json.loads(raw_contract)
    publisher = load('online-checkout-cs-release.py')
    publisher.validate_contract(contract)
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and not OUT.exists(), 'NATIVE_BUILD_REQUIRED')
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    changes = set(git('diff', '--name-only', contract['reviewBase'], contract['sourceReviewCommit'],
                      '--', 'apps/', 'docs/').decode().splitlines())
    need(changes == set(contract['sources']), 'REVIEW_SCOPE_CHANGED')
    for name, expected in contract['sources'].items():
        need(sha((ROOT / name).read_bytes()) == expected
             == sha(git('show', contract['sourceReviewCommit'] + ':' + name)), 'SOURCE_CHANGED')
    OUT.mkdir(parents=True, mode=0o700)
    os.environ['GIT_DIR'] = git('rev-parse', '--absolute-git-dir').decode().strip()
    inventory = load('recharge-record-release.py').file_inventory
    for role in ('baseline', 'candidate'):
        context = OUT / role
        reconstruct(context, contract)
        if role == 'candidate':
            for name in contract['sources']:
                target = context / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
            validation_sources(context, contract)
        for command in [('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                        ('npm', 'run', 'prisma:mysql:generate'),
                        ('npm', 'run', 'build', '--workspace', '@apple-business/shared'),
                        ('npm', 'run', 'build', '--workspace', '@apple-business/api')]:
            run(*command, cwd=context)
    before = inventory(OUT / 'baseline/apps/api/dist')
    after = inventory(OUT / 'candidate/apps/api/dist')
    need({name: digest for name, digest in before.items()
          if name.startswith('id-business-v2/online-recharge/') and '/engine/' not in name}
         == contract['beforeApiOnlineFiles'],
         'BASE_API_NOT_REPRODUCED')
    modules = load('online-checkout-build.py').module_delta(
        before, after, contract['apiModules'], contract['apiDeclarationOnly'])
    need(inventory(OUT / 'candidate' / contract['engineRoot']) == contract['afterEngineFiles'],
         'CANDIDATE_ENGINE_CHANGED')
    engine_manifest(OUT / 'candidate', contract)
    payload = OUT / 'payload'
    for name in modules:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUT / 'candidate/apps/api/dist' / name, target)
    for name in publisher.ENGINE_DELTA:
        target = payload / 'engine' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUT / 'candidate' / contract['engineRoot'] / name, target)
    for name in contract['sources']:
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    proof = {'version': 1, 'scope': contract['scope'],
             'commit': git('rev-parse', 'HEAD').decode().strip(),
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
             'workflowRunId': os.environ['GITHUB_RUN_ID'],
             'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': sha(raw_contract),
             'controlSources': {name: sha((HERE / name).read_bytes()) for name in contract['controlFiles']},
             'runtimeBaselineCommit': contract['expectedCurrent'],
             'publishedSourceCommit': contract['publishedSourceCommit'],
             'predecessorContractSha256': contract['predecessorContractSha256'],
             'sources': contract['sources'], 'validationOnlySources': contract['validationOnlySources'],
             'apiModules': modules,
             'beforeEngineFiles': contract['beforeEngineFiles'],
             'afterEngineFiles': contract['afterEngineFiles'],
             'preservedAdminFiles': contract['publicFiles'],
             'baselineApiReproduced': True, 'files': inventory(payload),
             'updatedServices': list(publisher.UPDATED), 'preservedServices': list(publisher.PRESERVED),
             'migrationPerformed': False, 'businessActions': 0}
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    archive = OUT / 'online-checkout-cs-artifact.tar.gz'
    with tarfile.open(archive, 'w:gz') as bundle:
        bundle.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(sha(archive.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_CHECKOUT_CS_NATIVE_BUILT', 'apiFiles': len(modules),
                      'engineFiles': len(publisher.ENGINE_DELTA), 'businessActions': 0}))


if __name__ == '__main__':
    main()
