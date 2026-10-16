"""Reproduce the live helper with unchanged compiler inputs, then package one module."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / '.deploy/mailbox-version'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load():
    spec = importlib.util.spec_from_file_location('mailbox_version_build_runtime', HERE / 'mailbox-version-release.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(*args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, check=True)


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def main():
    r = load()
    raw = (HERE / 'mailbox-version-contract.json').read_bytes()
    c = json.loads(raw)
    r.verify_contract(c)
    r.need(os.environ.get('GITHUB_ACTIONS') == 'true' and not OUTPUT.exists(), 'ISOLATED_NATIVE_BUILD_REQUIRED')
    r.need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    for name, expected in {**c['sources'], **c['buildInputs']}.items():
        r.need(sha((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    result = json.loads((ROOT / '.deploy/mailbox-version-mysql/results.json').read_bytes())
    r.need(result['success'] is True and result['numPassedTests'] == 4 and result['numFailedTests'] == 0 and result['numPendingTests'] == 0, 'MYSQL_EVIDENCE_MISSING')
    OUTPUT.mkdir(parents=True)
    inventories = []
    for role in ('baseline', 'candidate'):
        context = OUTPUT / role
        (context / 'apps/api').mkdir(parents=True)
        for name in ('tsconfig.base.json', 'apps/api/tsconfig.json'):
            shutil.copyfile(ROOT / name, context / name)
        (context / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        source = context / r.SOURCE
        source.parent.mkdir(parents=True)
        source.write_bytes(git('show', c['expectedCurrent'] + ':' + r.SOURCE) if role == 'baseline' else (ROOT / r.SOURCE).read_bytes())
        if role == 'baseline':
            r.need(sha(source.read_bytes()) == c['baselineSourceSha256'], 'BASE_SOURCE_CHANGED')
        config = {'extends': './tsconfig.json', 'compilerOptions': {'rootDir': 'src', 'incremental': False},
                  'include': ['src/common/prisma/bump-v2-scope-versions.ts'], 'exclude': []}
        (context / 'apps/api/tsconfig.build.json').write_text(json.dumps(config))
        run(str(ROOT / 'node_modules/.bin/tsc'), '-p', 'tsconfig.build.json', cwd=context / 'apps/api')
        files = {n: sha((context / 'apps/api/dist' / n).read_bytes()) for n in r.MODULES}
        inventories.append(files)
    before, after = inventories
    r.need(before == c['baseline']['runtime']['modules'], 'LIVE_MODULE_NOT_REPRODUCED')
    r.need(before[r.MODULES[0]] != after[r.MODULES[0]] and before[r.MODULES[2]] == after[r.MODULES[2]], 'COMPILED_DELTA_CHANGED')
    payload = OUTPUT / 'payload'
    for name in after:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUTPUT / 'candidate/apps/api/dist' / name, target)
    target = payload / 'source' / r.SOURCE
    target.parent.mkdir(parents=True)
    shutil.copyfile(ROOT / r.SOURCE, target)
    h = r.load('recharge-record-release.py')
    proof = {'version': 1, 'scope': r.SCOPE, 'commit': git('rev-parse', 'HEAD').decode().strip(),
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'workflowRunId': os.environ['GITHUB_RUN_ID'],
             'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'contractSha256': sha(raw),
             'controlSources': {n: sha((HERE / n).read_bytes()) for n in c['controlFiles']},
             'sources': c['sources'], 'baselineModulesReproduced': before, 'modules': after,
             'databaseVerification': {'isolated': True, 'passed': 4}, 'files': h.file_inventory(payload),
             'migrationPerformed': False, 'businessActions': 0}
    r.verify_proof(proof, proof, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    with tarfile.open(OUTPUT / 'mailbox-version-artifact.tar.gz', 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(sha((OUTPUT / 'mailbox-version-artifact.tar.gz').read_bytes()) + '\n')


if __name__ == '__main__':
    main()
