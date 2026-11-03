"""Use native main OIDC/SSM publication, with parent reproduction and exact source receipts."""
import argparse
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PREFIX = 'window-bitbrowser'
WORKFLOW = '.github/workflows/' + PREFIX + '-publication.yml'
OUT = ROOT / '.deploy' / PREFIX


def load(name):
    spec = importlib.util.spec_from_file_location('window_publication_' + name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


R = load(PREFIX + '-release.py')
F = load('financial-closure-publication.py')
F.WORKFLOW = WORKFLOW
need, sha = R.need, R.sha


def check(c):
    R.validate(c)
    need(F.git('merge-base', '--is-ancestor', c['reviewBase'], 'HEAD') is not None, 'REVIEW_BASE')
    names = set(F.git('diff', '--name-only', c['reviewBase'], 'HEAD').decode().splitlines())
    need(names <= set(c['candidateFiles']), 'UNREVIEWED_EXTENSION')
    for name, digest in {**c['sources'], **c['validationSources']}.items():
        need(sha((ROOT / name).read_bytes()) == digest, 'SOURCE_CHANGED')
    need(sha((ROOT / 'package-lock.json').read_bytes()) == c['packageLockSha256'], 'DEPENDENCY_CHANGED')
    need(sha((ROOT / WORKFLOW).read_bytes()) == c['workflowSha256'], 'WORKFLOW_CHANGED')


def quality(native):
    qa = load('permission-loading-publication.py').quality(native)
    head = qa['review']['head']
    rows = F.github('actions/workflows/window-bitbrowser-validation.yml/runs?head_sha=' + head)['workflow_runs']
    rows = [r for r in rows if r['head_sha'] == head and r['event'] == 'pull_request' and r['conclusion'] == 'success']
    need(bool(rows), 'ISOLATED_DATABASE_VALIDATION_REQUIRED')
    return {**qa, 'isolatedDatabase': {'head': head, 'runId': rows[0]['id'], 'attempt': rows[0]['run_attempt']}}


def transport(plan, mode):
    source = inspect.getsource(F.transport)
    changes = {"directory/'financial-closure-release.py'": "directory/'window-bitbrowser-release.py'",
        'financial-entry-': 'window-bitbrowser-entry-',
        'FINANCIAL_PUBLICATION|BITBROWSER_HISTORY': 'WINDOW_BITBROWSER|RECHARGE_PLAN_BILLING|FINANCIAL_PUBLICATION|BITBROWSER_HISTORY'}
    for before, after in changes.items():
        need(source.count(before) == 1, 'TRANSPORT_RECIPE_CHANGED')
        source = source.replace(before, after)
    values = {**F.__dict__}
    exec(compile(source, '<window-bitbrowser-transport>', 'exec'), values)
    return values['transport'](plan, mode, OUT)


def archive_source(ref, folder):
    with tarfile.open(fileobj=io.BytesIO(F.git('archive', ref))) as archive:
        archive.extractall(folder, filter='data')


def migration_archive_image_id(path, reference):
    need(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= 512 * 1024**2, 'MIGRATION_ARCHIVE')
    import re
    with tarfile.open(path, 'r:*') as archive:
        members = {m.name: m for m in archive.getmembers()}
        manifest = members.get('manifest.json')
        need(manifest is not None and manifest.isfile() and manifest.size < 2 * 1024**2, 'MIGRATION_ARCHIVE_LAYOUT')
        rows = [row for row in json.load(archive.extractfile(manifest)) if reference in (row.get('RepoTags') or [])]
        need(len(rows) == 1, 'MIGRATION_ARCHIVE_REFERENCE')
        name = rows[0]['Config']
        match = re.fullmatch(r'(?:blobs/sha256/([a-f0-9]{64})|([a-f0-9]{64})\.json)', name)
        member = members.get(name)
        need(match is not None and member is not None and member.isfile() and member.size < 2 * 1024**2, 'MIGRATION_CONFIG_PATH')
        raw = archive.extractfile(member).read()
        digest = match.group(1) or match.group(2)
        need(sha(raw) == digest, 'MIGRATION_CONFIG_HASH')
        config = json.loads(raw)
        need(config.get('os') == 'linux' and config.get('architecture') == 'amd64', 'MIGRATION_CONFIG_PLATFORM')
        return 'sha256:' + digest


def reproduce_parent_client(context, baseline, receipt):
    parent_root = baseline['clientGenerationRoot']
    need(isinstance(parent_root, str) and Path(parent_root).is_absolute()
         and '..' not in Path(parent_root).parts and len(parent_root) < 1024, 'CLIENT_GENERATION_PATH')
    inventory = load('recharge-plan-billing-build.py').inventory
    directory = context / 'node_modules/.prisma/client'
    rewritten = []
    for name in inventory(directory):
        path = directory / name
        if path.suffix in ('.js', '.mjs', '.json', '.ts'):
            raw = path.read_bytes()
            normalized = raw.replace(str(context.resolve()).encode(), parent_root.encode())
            if normalized != raw:
                path.write_bytes(normalized)
                rewritten.append(name)
    actual, complete = inventory(directory), baseline['clientFiles']
    preserved = baseline.get('preservedClientFiles', {})
    need(all(complete.get(n) == v for n, v in preserved.items()), 'PRESERVED_CLIENT_CHANGED')
    expected = {n: v for n, v in complete.items() if n not in preserved}
    differences = sorted(n for n in actual.keys() | expected.keys() if actual.get(n) != expected.get(n))
    receipt.write_text(json.dumps({'kind': 'READONLY_PARENT_CLIENT_REPRODUCTION',
        'actualCount': len(actual), 'expectedCount': len(expected), 'preservedCount': len(preserved), 'generationPathFiles': sorted(rewritten),
        'differingFiles': differences, 'expected': expected, 'actual': actual, 'businessActions': 0},
        sort_keys=True, indent=2) + '\n')
    need(actual == expected and {'count': len(complete), 'sha256': sha(R.canonical(complete))}
         == baseline['runtime']['clientInventory'], 'PRISMA_PARENT_NOT_REPRODUCED')


def build(c, plan):
    B = load('recharge-plan-billing-build.py')
    B.OUT, B.PREFIX, B.CONTRACT = OUT / 'build', PREFIX, HERE / R.CONTRACT_FILE
    resolved = {**c, 'baseline': plan['nativeParentCapture']['baseline'], 'baselineAdminBuildCommit': c['expectedCurrent']}
    def reconstruct(_c):
        folders = [B.OUT / 'api-baseline', B.OUT / 'admin-baseline']
        for path in folders:
            archive_source(c['reviewBase'], path)
        return tuple(folders)
    B.reconstruct, B.check = reconstruct, lambda _c: check(c)
    source = inspect.getsource(B.build)
    source = source.replace('c = json.loads(CONTRACT.read_bytes())', 'c = RESOLVED')
    source = source.replace("if n.startswith('apps/api/src/') and not n.endswith('.spec.ts')", "if n.startswith('apps/api/src/') and n.endswith('.ts') and not n.endswith('.spec.ts')")
    needle="    need(not (set(before_api) - set(after_api))"
    need(source.count(needle) == 1, 'BUILD_RECIPE_CHANGED')
    source = source.replace(needle,"    selected |= {n for n in delta if n.endswith('.d.ts')}\n"+needle)
    start = source.index('    controls = [')
    end = source.index('    for name in controls:', start)
    source = source[:start]+"    controls = sorted(set(c['helperPins']) | {PREFIX + '-release.py', PREFIX + '-contract.json'})\n"+source[end:]
    values = {**B.__dict__, 'RESOLVED': resolved}
    exec(compile(source, '<window-bitbrowser-build>', 'exec'), values)
    values['build']()
    payload = B.OUT / 'payload'
    proof_file = payload / 'build-proof.json'
    proof = json.loads(proof_file.read_bytes())
    reproduce_parent_client(B.OUT / 'api-baseline', resolved['baseline'], OUT / 'parent-client-comparison.json')
    for name in ('credentials.cjs', 'SOURCE_MANIFEST.json'):
        engine = payload / 'online-recharge/engine' / name
        engine.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'apps/api/src/id-business-v2/online-recharge/engine' / name, engine)
    proof.update(nativeParentCapture=plan['nativeParentCapture'], qualitySourceEvidence=plan['qualitySourceEvidence'],
        preservedClientFiles=resolved['baseline']['preservedClientFiles'],
        sourceLayout='PUBLISHED_PREDECESSOR_WITH_REVIEWED_MAIN_WINDOW_OVERLAY')
    proof_file.unlink()
    proof['files'] = B.inventory(payload)
    R.verify_proof(proof, plan, resolved, proof['files'])
    proof_file.write_text(json.dumps(proof, sort_keys=True, indent=2)+'\n')
    bundle = OUT / (PREFIX + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    shutil.copyfile(B.OUT / (PREFIX + '-migration.tar.gz'), OUT / (PREFIX + '-migration.tar.gz'))
    (OUT / 'artifact-sha256.txt').write_text(sha(bundle.read_bytes())+'\n')
    return proof


def main(operation):
    c = json.loads((HERE / R.CONTRACT_FILE).read_bytes())
    check(c)
    native = F.native_identity()
    need(os.environ.get('EXPECTED_CURRENT') == c['expectedCurrent'], 'EXPECTED_CURRENT')
    need(json.loads(F.execute('aws', 'sts', 'get-caller-identity', '--output', 'json'))['Account'] == c['awsAccount'], 'AWS_ACCOUNT')
    need(F.git('ls-remote', 'origin', 'refs/heads/main').decode().split()[0] == native['commit'], 'MAIN_MOVED')
    qa = quality(native)
    OUT.mkdir(parents=True, exist_ok=False)
    controls = {**c['helperPins'], PREFIX + '-release.py': sha((HERE / (PREFIX + '-release.py')).read_bytes()),
        R.CONTRACT_FILE: sha((HERE / R.CONTRACT_FILE).read_bytes())}
    plan = {**native, 'contractSha256': sha((HERE / R.CONTRACT_FILE).read_bytes()), 'controlSources': controls, 'qualitySourceEvidence': qa}
    capture = transport(plan, 'capture')
    need(capture['status'] == 'WINDOW_BITBROWSER_PARENT_VERIFIED', 'PARENT_CAPTURE')
    plan['nativeParentCapture'] = capture
    (OUT / 'parent-capture.json').write_text(json.dumps(capture, sort_keys=True, indent=2)+'\n')
    if operation == 'observe':
        context = OUT / 'parent-client-source'
        archive_source(c['reviewBase'], context)
        load('recharge-plan-billing-build.py').compile(context, 'api', c['expectedCurrent'])
        reproduce_parent_client(context, capture['baseline'], OUT / 'parent-client-comparison.json')
        print(json.dumps({'status': capture['status'], 'commit': native['commit'], 'parentClientReproduced': True, 'businessActions': 0}))
        return
    proof = build(c, plan)
    bundle = OUT / (PREFIX + '-artifact.tar.gz')
    tag = PREFIX + '-' + native['commit']
    exists = subprocess.run(['gh', 'release', 'view', tag, '--repo', F.REPO], cwd=ROOT, capture_output=True)
    need(exists.returncode != 0, 'ARTIFACT_ALREADY_ACCEPTED')
    F.execute('gh', 'release', 'create', tag, str(bundle), str(OUT / (PREFIX + '-migration.tar.gz')),
        '--repo', F.REPO, '--target', native['commit'], '--title', '本窗口业务资料与比特派单 '+native['commit'][:12],
        '--notes', '从确定的 main 提交构建；仅包含本窗口审查范围，业务动作数为零。')
    plan.update(artifactUrl='https://github.com/'+F.REPO+'/releases/download/'+tag+'/'+bundle.name,
        artifactSha256=sha(bundle.read_bytes()), buildProofSha256=sha((OUT / 'build/payload/build-proof.json').read_bytes()))
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2)+'\n')
    need(transport(plan, 'preflight')['status'] == 'BILLING_PREFLIGHT_VERIFIED', 'PREFLIGHT')
    need(F.git('ls-remote', 'origin', 'refs/heads/main').decode().split()[0] == native['commit'], 'MAIN_MOVED')
    result = transport(plan, 'release')
    need(result['status'] == 'BILLING_DEPLOYED', 'DEPLOYMENT')
    readback = transport(plan, 'readback')
    need(readback['status'] == 'BILLING_INDEPENDENT_READBACK_VERIFIED', 'INDEPENDENT_READBACK')
    print(json.dumps({'status': 'WINDOW_BITBROWSER_PUBLISHED_AND_VERIFIED', 'commit': native['commit'], 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['observe', 'publish'])
    main(parser.parse_args().operation)
