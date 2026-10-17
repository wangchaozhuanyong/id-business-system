"""Validate a one-file Worker overlay; inherit the exact published API and Admin."""
import copy
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
spec = importlib.util.spec_from_file_location('terminal_release', HERE / 'registration-terminal-stop-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
OUT = ROOT / '.deploy' / r.NAME
need, digest = r.need, r.digest


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, check=True)


def admitted():
    need(os.environ.get('GITHUB_ACTIONS') == 'true', 'ISOLATED_CI_REQUIRED')
    c = json.loads((HERE / 'registration-terminal-stop-contract.json').read_bytes())
    r.verify_contract(c)
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    need(git('rev-parse', c['sourceBaseline'] + '^{tree}').decode().strip() == c['sourceBaselineTree']
         and set(git('diff', '--name-only', c['sourceBaseline'], 'HEAD').decode().splitlines()) == set(r.TASK_PATHS),
         'SOURCE_SCOPE_CHANGED')
    contract = 'scripts/production-release/registration-terminal-stop-contract.json'
    need(set(c['reviewedFileHashes']) == set(r.TASK_PATHS) - {contract}, 'REVIEW_SCOPE_CHANGED')
    for name, expected in {**c['reviewedFileHashes'], **c['sources']}.items():
        path = ROOT / name
        need(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(ROOT)
             and digest(path.read_bytes()) == expected, 'REVIEWED_SOURCE_CHANGED')
    return c


def verify_previous_bundle(raw, c):
    binding = r.PUBLISHED_PREVIOUS
    need(digest(raw) == binding['artifactSha256'], 'PUBLISHED_ARTIFACT_CHANGED')
    files, members, proof_raw = {}, set(), None
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        total = 0
        for item in archive:
            total += item.size
            need(item.name not in members and not item.name.startswith('/')
                 and '..' not in Path(item.name).parts and Path(item.name).parts[0] == 'payload'
                 and (item.isdir() or item.isfile()) and item.size <= 8 * 1024**2
                 and total <= 64 * 1024**2, 'PUBLISHED_ARCHIVE_INVALID')
            members.add(item.name)
            if item.isfile():
                data = archive.extractfile(item).read()
                files[item.name.removeprefix('payload/')] = digest(data)
                if item.name == 'payload/build-proof.json':
                    proof_raw = data
    need(proof_raw is not None and digest(proof_raw) == binding['proofSha256'], 'PUBLISHED_PROOF_CHANGED')
    proof = json.loads(proof_raw)
    need(all(proof.get(k) == binding[n] for k, n in (
        ('commit', 'commit'), ('tree', 'tree'), ('workflowRunId', 'runId'), ('contractSha256', 'contractSha256')))
        and proof.get('workflowRunAttempt') == str(binding['attempt'])
        and proof.get('scope') == 'REGISTRATION_FLOW_V4_20261017'
        and proof.get('validation') == {'status': 'PASS', 'api': True, 'admin': True,
                                      'offlineBrowser': True, 'isolatedPersistence': True}
        and proof.get('migrationPerformed') is False and type(proof.get('businessActions')) is int
        and proof['businessActions'] == 0, 'PUBLISHED_IDENTITY_CHANGED')
    files.pop('build-proof.json')
    old = r.prior_contract()
    need(files == proof['files'] and proof['sources'] == old['sources']
         and proof['afterInventory'] == c['baseline']['inventory'] == c['publishedInventory']
         and proof['adminFiles']['index.html'] == c['publicIndexSha256'], 'PUBLISHED_CONTENT_CHANGED')
    for name, expected in proof['sources'].items():
        need(digest(git('show', binding['commit'] + ':' + name)) == expected, 'PUBLISHED_SOURCE_CHANGED')
    for name, expected in proof['controlSources'].items():
        need(digest(git('show', binding['commit'] + ':scripts/production-release/' + name)) == expected,
             'PUBLISHED_CONTROL_CHANGED')
    return proof


def previous_artifact(c):
    binding = r.PUBLISHED_PREVIOUS
    prefix = 'repos/wangchaozhuanyong/id-business-system/'
    request = lambda path: subprocess.check_output(['gh', 'api', prefix + path], cwd=ROOT)
    run_value = json.loads(request('actions/runs/' + binding['runId']))
    need(run_value['head_sha'] == binding['commit'] and run_value['head_branch'] == 'main'
         and run_value['event'] == 'workflow_dispatch' and run_value['path'] == binding['workflowPath']
         and run_value['status'] == 'completed' and run_value['conclusion'] == 'success'
         and run_value['run_attempt'] == binding['attempt'], 'PUBLISHED_NATIVE_RUN_CHANGED')
    value = json.loads(request('actions/artifacts/' + str(binding['artifactId'])))
    need(value['id'] == binding['artifactId'] and value['name'] == binding['artifactName']
         and value['digest'] == binding['artifactDigest'] and value['size_in_bytes'] == binding['artifactSize']
         and value['expired'] is False and value['workflow_run']['id'] == int(binding['runId'])
         and value['workflow_run']['head_sha'] == binding['commit'], 'PUBLISHED_NATIVE_ARTIFACT_CHANGED')
    zipped = request('actions/artifacts/' + str(binding['artifactId']) + '/zip')
    need(len(zipped) == binding['artifactSize'] and 'sha256:' + digest(zipped) == binding['artifactDigest'],
         'PUBLISHED_NATIVE_DIGEST_CHANGED')
    with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
        names = archive.namelist()
        name = 'registration-flow-v4-20261017-artifact.tar.gz'
        need(len(names) == 2 and set(names) == {name, 'artifact-sha256.txt'}
             and all(archive.getinfo(n).file_size <= 16 * 1024**2 for n in names), 'PUBLISHED_ZIP_INVALID')
        raw = archive.read(name)
        need(archive.read('artifact-sha256.txt').decode().strip() == digest(raw), 'PUBLISHED_BUNDLE_CHANGED')
    return verify_previous_bundle(raw, c)


def prepare():
    c = admitted()
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    previous_artifact(c)
    OUT.mkdir(parents=True, mode=0o700)
    candidate = OUT / 'candidate'
    with tarfile.open(fileobj=io.BytesIO(git('archive', r.SOURCE_BASE))) as archive:
        for item in archive:
            need(not item.name.startswith('/') and '..' not in Path(item.name).parts
                 and (item.isdir() or item.isfile()), 'SOURCE_ARCHIVE_INVALID')
        archive.extractall(candidate)
    for name, expected in c['sources'].items():
        path = candidate / name
        need(path.is_file() and not path.is_symlink() and digest((ROOT / name).read_bytes()) == expected,
             'CANDIDATE_SOURCE_CHANGED')
        path.write_bytes((ROOT / name).read_bytes())
    (OUT / 'prepared.json').write_bytes(r.canonical({'contractSha256': digest(
        (HERE / 'registration-terminal-stop-contract.json').read_bytes()), 'sources': c['sources'],
        'inheritedValidation': r.PUBLISHED_PREVIOUS}))


def prepared():
    c = admitted()
    value = json.loads((OUT / 'prepared.json').read_bytes())
    need(value == {'contractSha256': digest((HERE / 'registration-terminal-stop-contract.json').read_bytes()),
                   'sources': c['sources'], 'inheritedValidation': r.PUBLISHED_PREVIOUS}, 'PREPARED_INPUT_CHANGED')
    for name, expected in c['sources'].items():
        need(digest((OUT / 'candidate' / name).read_bytes()) == expected, 'PREPARED_SOURCE_CHANGED')
    return c


def check_worker():
    if not OUT.exists():
        prepare()
    c = prepared()
    python = OUT / 'python/bin/python'
    if not python.exists():
        run('python3', '-m', 'venv', str(OUT / 'python'))
        run(str(python), '-m', 'pip', 'install', '--disable-pip-version-check', '-r',
            str(OUT / 'candidate' / r.WORKER / 'requirements.lock.txt'))
        run(str(python), '-m', 'pip', 'check')
    for name in c['pythonTests']:
        run(str(python), '-B', '-m', 'unittest', name, cwd=OUT / 'candidate' / r.WORKER)
    value = {'status': 'PASS', 'worker': True, 'isolatedPersistence': True, 'pythonTests': list(r.PYTHON_TESTS)}
    (OUT / 'worker-validation.json').write_bytes(r.canonical(value))


def package():
    c = prepared()
    validation = json.loads((OUT / 'worker-validation.json').read_bytes())
    need(validation == {'status': 'PASS', 'worker': True, 'isolatedPersistence': True,
                        'pythonTests': list(r.PYTHON_TESTS)}, 'WORKER_VALIDATION_MISSING')
    payload = OUT / 'payload'
    need(not payload.exists(), 'PACKAGE_EXISTS')
    for name, expected in {**{'source/' + n: v for n, v in c['sources'].items()},
                           **{'api/worker/' + n: v for n, v in c['workerFiles'].items()}}.items():
        source = ROOT / (name.removeprefix('source/') if name.startswith('source/') else
                         r.WORKER + name.removeprefix('api/worker/'))
        need(digest(source.read_bytes()) == expected, 'PACKAGE_SOURCE_MOVED')
        path = payload / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, path)
    after = copy.deepcopy(c['baseline']['inventory'])
    after['worker'] = r.signature({**c['baselineWorkerFiles'], **c['workerFiles']})
    h = r.helper('recharge-record-release.py')
    proof = {'version': 1, 'scope': r.SCOPE, 'commit': git('rev-parse', 'HEAD').decode().strip(),
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'workflowRunId': os.environ['GITHUB_RUN_ID'],
             'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': digest((HERE / 'registration-terminal-stop-contract.json').read_bytes()),
             'controlSources': c['controlHashes'], 'sources': c['sources'], 'validationSources': {},
             'workerFiles': c['workerFiles'], 'apiModules': {}, 'apiJavascriptDelta': [], 'adminFiles': {},
             'baselineInventory': c['baseline']['inventory'], 'afterInventory': after, 'validation': validation,
             'inheritedValidation': r.PUBLISHED_PREVIOUS, 'files': h.file_inventory(payload),
             'migrationPerformed': False, 'businessActions': 0}
    r.verify_proof(proof, proof, c, payload, h)
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / (r.NAME + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(digest(bundle.read_bytes()) + '\n')


if __name__ == '__main__':
    import sys
    mode = sys.argv[1] if len(sys.argv) == 2 else 'invalid'
    need(mode in {'prepare', 'check-worker', 'package'} and len(sys.argv) == 2, 'MODE_INVALID')
    {'prepare': prepare, 'check-worker': check_worker, 'package': package}[mode]()
