"""Compile a finite API delta over the independently published browser baseline."""
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
OUT = ROOT / '.deploy/gpt-recharge-build'


def need(value, code):
    if not value:
        raise RuntimeError('GPT_RECHARGE_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, check=True)


def main():
    contract_raw = (HERE / 'gpt-recharge-contract.json').read_bytes()
    c = json.loads(contract_raw)
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    for name, expected in c['sources'].items():
        need(sha((ROOT / name).read_bytes()) == expected, 'REVIEWED_SOURCE_CHANGED')
    spec = importlib.util.spec_from_file_location('published_browser_build', HERE / 'registration-browser-build.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    predecessor = json.loads((HERE / 'registration-browser-contract.json').read_bytes())
    OUT.mkdir(parents=True, mode=0o700)
    for role in ('baseline', 'candidate'):
        context = OUT / role
        builder.reconstruct(context, predecessor)
        for name, expected in predecessor['sources'].items():
            raw = git('show', c['expectedCurrent'] + ':' + name)
            need(sha(raw) == expected, 'PREDECESSOR_SOURCE_CHANGED')
            target = context / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        if role == 'candidate':
            for name in c['sources']:
                target = context / name
                raw = (ROOT / name).read_bytes()
                prior = subprocess.run(['git', 'show', c['reviewBase'] + ':' + name], cwd=ROOT, capture_output=True)
                if prior.returncode == 0:
                    base, after = OUT / 'merge-base', OUT / 'merge-after'
                    base.write_bytes(prior.stdout)
                    after.write_bytes(raw)
                    run('git', 'merge-file', str(target), str(base), str(after))
                else:
                    need(not target.exists(), 'NEW_SOURCE_ALREADY_PRESENT')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(raw)
            # Tests use the actual reconstructed service and repository, without a DB.
            tests = ['vendure-integration.spec.ts', 'worker-body-parser.spec.ts']
            prefix = 'apps/api/src/id-business-v2/online-recharge/'
            for name in tests:
                shutil.copyfile(ROOT / prefix / name, context / prefix / name)
        run('npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context)
        builder.r.helper(builder.r.OLD_NAME + '-build.py').generate_unchanged_client(context)
        run('npm', 'run', 'build', '--workspace', '@apple-business/shared', cwd=context)
        run('npm', 'run', 'build', '--workspace', '@apple-business/api', cwd=context)
        if role == 'candidate':
            run('npm', 'run', 'typecheck', '--workspace', '@apple-business/api', cwd=context)
            run('npm', 'run', 'test', '--workspace', '@apple-business/api', '--',
                *(prefix.removeprefix('apps/api/') + name for name in tests), cwd=context)
    package(builder, c, contract_raw)


def package(builder, c, contract_raw):
    for name, expected in c['sources'].items():
        need(sha((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    h = builder.r.helper('recharge-record-release.py')
    runtime_files = lambda files: {n: v for n, v in files.items() if n.endswith(('.js', '.js.map', '.d.ts'))}
    before = runtime_files(h.file_inventory(OUT / 'baseline/apps/api/dist'))
    after = runtime_files(h.file_inventory(OUT / 'candidate/apps/api/dist'))
    need({n: v for n, v in before.items() if n.endswith('.js')} == c['baselineApiJs'], 'BASELINE_NOT_REPRODUCED')
    changed = {n for n in before.keys() | after.keys() if before.get(n) != after.get(n)}
    modules = set(c['apiModules'])
    allowed = {n.removesuffix('.js') + ext for n in modules for ext in ('.js', '.js.map', '.d.ts')}
    need({n for n in changed if n.endswith('.js')} == modules and changed <= allowed, 'COMPILED_SCOPE_CHANGED')
    payload = OUT / 'payload'
    hashes = {}
    for name in sorted(changed):
        need(name in after, 'MODULE_REMOVAL_FORBIDDEN')
        dst = payload / 'api/modules' / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUT / 'candidate/apps/api/dist' / name, dst)
        hashes[name] = after[name]
    source_hashes = {}
    for name in c['sources']:
        dst = payload / 'source' / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUT / 'candidate' / name, dst)
        source_hashes[name] = sha(dst.read_bytes())
    proof = {'version': 1, 'scope': c['scope'], 'commit': git('rev-parse', 'HEAD').decode().strip(),
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
             'workflowRunId': os.environ.get('GITHUB_RUN_ID', 'local'),
             'contractSha256': sha(contract_raw), 'baselineApiJs': c['baselineApiJs'],
             'apiModules': hashes, 'sources': source_hashes, 'reviewedSources': c['sources'],
             'migrationPerformed': False, 'businessActions': 0, 'baselineApiReproduced': True}
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    archive = OUT / 'gpt-recharge-artifact.tar.gz'
    with tarfile.open(archive, 'w:gz') as bundle:
        bundle.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(sha(archive.read_bytes()) + '\n')
    print(json.dumps({'status': 'GPT_RECHARGE_PACKAGE_VERIFIED', 'apiModules': len(hashes), 'businessActions': 0}))


if __name__ == '__main__':
    main()
