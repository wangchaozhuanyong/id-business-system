"""Rebuild the published Admin source; add only the fresh Session query entry."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / '.deploy/online-session-preflight'
CONTRACT = HERE / 'online-session-preflight-contract.json'
RECONSTRUCTION_FILES = ('online-pending-features-build.py', 'online-pending-features-release.py',
    'online-pending-features-contract.json', 'recharge-checkout-build.py', 'recharge-checkout-contract.json',
    'recharge-record-build.py', 'registration-flow-v4-build.py', 'registration-flow-v4-contract.json',
    'registration-flow-v4-release.py')


def load(name):
    spec = importlib.util.spec_from_file_location('session_preflight_builder_' + name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def publisher():
    return load('online-session-preflight-release.py')


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def freeze(baseline_path, proof_path):
    p = publisher()
    prior = json.loads((HERE / 'online-pending-features-contract.json').read_bytes())
    proof_raw = Path(proof_path).read_bytes()
    p.need(p.sha(proof_raw) == p.PREDECESSOR_PROOF_SHA256, 'PREDECESSOR_PROOF_CHANGED')
    proof = json.loads(proof_raw)
    p.need(proof['commit'] == p.SOURCE_BASE and proof['sources'] == prior['sources'], 'PREDECESSOR_IDENTITY_CHANGED')
    observed = json.loads(Path(baseline_path).read_bytes())
    old = prior['baseline']
    # No new runtime inventory is inferred from today's source tree. Combine only
    # the authenticated predecessor content and its exact finite overlay proof.
    b = {key: observed[key] for key in ('commit', 'current', 'manifestSha256', 'services',
        'runtimeConfigurationSha256', 'configurationSha256', 'nginxSha256')}
    p.need(observed.get('businessActions') == 0 and observed.get('databaseWrites') == 0
           and observed['preservationAfter'] == b['services']
           and observed['preservationBefore'] == old['services'], 'BASELINE_OBSERVATION_CHANGED')
    b.update(adminFiles={**old['adminFiles'], **proof['adminFiles']},
        apiOnlineFiles={**old['apiOnlineFiles'], **{name.removeprefix('id-business-v2/online-recharge/'): digest
            for name, digest in proof['apiModules'].items()}}, engineFiles=proof['afterEngineFiles'],
        engineHealth=p.HEALTH, backupNormalizerPath=old['backupNormalizerPath'],
        backupNormalizerSha256=old['backupNormalizerSha256'])
    c = {'version': 1, 'scope': p.SCOPE, 'reviewBase': p.SOURCE_BASE, 'expectedCurrent': p.SOURCE_BASE,
        'sourceReviewCommit': git('rev-parse', 'HEAD').decode().strip(),
        'sourceReviewTag': 'online-session-preflight-source-review-' + git('rev-parse', 'HEAD').decode().strip()[:12],
        'reviewedControlSources': {name: p.sha((ROOT / name).read_bytes()) for name in sorted(p.SCOPE_CONTROLS)},
        'sources': {name: p.sha((ROOT / name).read_bytes()) for name in sorted(p.APPLICATION)},
        'controlPins': {name: p.sha((HERE / name).read_bytes()) for name in sorted(p.CONTROLS)},
        'workflowSha256': p.sha((ROOT / p.WORKFLOW).read_bytes()), 'requiredQualityParts': list(p.QUALITY_PARTS),
        'updatedServices': list(p.UPDATED), 'preservedServices': list(p.PRESERVED),
        'reconstruction': {'publishedAdminCommit': p.SOURCE_BASE, 'reviewCommit': p.PREDECESSOR_REVIEW,
            'predecessorProofSha256': p.PREDECESSOR_PROOF_SHA256,
            'pins': {name: p.sha((HERE / name).read_bytes()) for name in sorted(RECONSTRUCTION_FILES)},
            'publishedAdminSources': {name: digest for name, digest in prior['sources'].items() if name.startswith('apps/admin/')},
            'publishedAdminFiles': proof['adminFiles']},
        'baseline': b, 'migrationPerformed': False, 'businessActions': 0}
    p.validate_contract(c)
    CONTRACT.write_text(json.dumps(c, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': 'ONLINE_SESSION_PREFLIGHT_SOURCE_FROZEN', 'sources': len(c['sources']),
        'preservedServices': list(p.PRESERVED), 'adminFiles': len(b['adminFiles']), 'businessActions': 0}))



def check_reviewed_source(c):
    p = publisher()
    # main is protected by squash-only history. The annotated immutable review
    # object remains available without requiring it to be an ancestor of main.
    tag = 'refs/tags/' + c['sourceReviewTag']
    p.need(git('cat-file', '-t', tag).decode().strip() == 'tag'
           and git('rev-parse', tag + '^{commit}').decode().strip() == c['sourceReviewCommit'], 'REVIEW_TAG_CHANGED')
    p.need(set(git('diff', '--name-only', p.SOURCE_BASE, c['sourceReviewCommit']).decode().splitlines())
           == set(p.APPLICATION) | set(p.SCOPE_CONTROLS), 'REVIEW_SCOPE_CHANGED')
    for name, digest in {**c['sources'], **c['reviewedControlSources']}.items():
        p.need(p.sha(git('show', c['sourceReviewCommit'] + ':' + name)) == digest
               and p.sha((ROOT / name).read_bytes()) == digest, 'REVIEWED_SOURCE_CHANGED')


def check(c):
    p = publisher()
    p.validate_contract(c)
    p.need(p.sha((ROOT / p.WORKFLOW).read_bytes()) == c['workflowSha256'], 'WORKFLOW_CHANGED')
    check_reviewed_source(c)
    for name, digest in c['sources'].items():
        target = ROOT / name
        p.need(not target.is_symlink() and p.sha(target.read_bytes()) == digest, 'SOURCE_CHANGED')
    for name, digest in {**c['controlPins'], **c['reconstruction']['pins']}.items():
        target = HERE / name
        p.need(not target.is_symlink() and p.sha(target.read_bytes()) == digest, 'CONTROL_CHANGED')
    old = json.loads((HERE / 'online-pending-features-contract.json').read_bytes())
    p.need(c['reconstruction']['publishedAdminSources'] == {
        name: digest for name, digest in old['sources'].items() if name.startswith('apps/admin/')}, 'PUBLISHED_SOURCE_SCOPE_CHANGED')
    for name, digest in c['reconstruction']['publishedAdminSources'].items():
        p.need(p.sha(git('show', p.PREDECESSOR_REVIEW + ':' + name)) == digest, 'PUBLISHED_SOURCE_CHANGED')
    return p


def reconstruct(c):
    p = publisher()
    previous = load('online-pending-features-build.py')
    previous.OUT = OUT / 'reconstruction'
    previous.OUT.mkdir(mode=0o700, parents=True)
    old = json.loads((HERE / 'online-pending-features-contract.json').read_bytes())
    context = previous.reconstruct_admin(old)
    previous.overlay(context, c['reconstruction']['publishedAdminSources'], p.PREDECESSOR_REVIEW)
    return context


def quality_evidence(commit, tree):
    p = publisher()
    helper = load('registration-closure-dispatch.py')
    def parts(evidence):
        value = helper.github('repos/' + helper.REPOSITORY + '/actions/runs/' + evidence['runId']
            + '/attempts/' + str(evidence['runAttempt']) + '/jobs?per_page=100')
        p.need(value.get('total_count') == len(value.get('jobs', [])) <= 100, 'QUALITY_JOBS_PAGINATED')
        selected = {}
        for part in p.QUALITY_PARTS:
            rows = [row for row in value['jobs'] if row.get('name') == 'recharge (' + part + ')']
            if len(rows) != 1 or rows[0].get('status') != 'completed' or rows[0].get('conclusion') != 'success':
                return None
            selected[part] = rows[0]['id']
        return {'runId': evidence['runId'], 'runAttempt': evidence['runAttempt'], 'testedTree': tree,
                'parts': list(p.QUALITY_PARTS), 'jobs': selected}
    evidence = helper.quality_source_evidence(commit, tree)
    covered = parts(evidence)
    if covered is None and evidence['kind'] == 'EXACT_MAIN_SUCCESS':
        original = helper.github
        prefix = 'repos/' + helper.REPOSITORY + '/actions/workflows/quality.yml/runs?head_sha=' + commit
        helper.github = lambda path: {'workflow_runs': []} if path.startswith(prefix) else original(path)
        evidence = helper.quality_source_evidence(commit, tree)
        covered = parts(evidence)
    p.need(covered is not None, 'QUALITY_PARTS_MISSING')
    p.validate_quality(evidence, commit, tree)
    return evidence, covered


def run(*args, cwd, env):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def main():
    c = json.loads(CONTRACT.read_bytes())
    p = check(c)
    commit, tree = git('rev-parse', 'HEAD').decode().strip(), git('rev-parse', 'HEAD^{tree}').decode().strip()
    p.need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
           and os.environ.get('GITHUB_SHA') == commit and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
           and os.environ.get('GITHUB_REPOSITORY') == 'wangchaozhuanyong/id-business-system' and not OUT.exists()
           and not git('status', '--porcelain', '--untracked-files=no').strip(), 'NATIVE_BUILD_REQUIRED')
    p.need(set(git('diff', '--name-only', p.SOURCE_BASE, 'HEAD').decode().splitlines())
           == set(p.APPLICATION) | set(p.SELECTION_CONTROLS), 'FINITE_SELECTION_CHANGED')
    quality, quality_parts = quality_evidence(commit, tree)
    OUT.mkdir(mode=0o700, parents=True)
    baseline = reconstruct(c)
    candidate = OUT / 'admin-candidate'
    shutil.copytree(baseline, candidate)
    # Source hashes cover four reviewed files, but one runtime file enters Admin.
    source = candidate / p.RUNTIME_SOURCE
    source.write_bytes((ROOT / p.RUNTIME_SOURCE).read_bytes())
    h = load('recharge-record-release.py')
    outputs = {}
    for variant, context in (('baseline', baseline), ('candidate', candidate)):
        env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + (p.SOURCE_BASE if variant == 'baseline' else commit)}
        run('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context, env=env)
        run('npm', 'run', 'build', '--workspace', '@apple-business/shared', cwd=context, env=env)
        run('npm', 'run', 'build', '--workspace', '@apple-business/admin', cwd=context, env=env)
        outputs[variant] = h.file_inventory(context / 'apps/admin/dist')
    # Native Linux build must match all currently served entry assets byte-for-byte.
    p.need(outputs['baseline'] == c['reconstruction']['publishedAdminFiles'], 'PUBLISHED_ADMIN_NOT_REPRODUCED')
    payload = OUT / 'payload'
    shutil.copytree(candidate / 'apps/admin/dist', payload / 'admin/html')
    for name, digest in c['sources'].items():
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
        p.need(p.sha(target.read_bytes()) == digest, 'SOURCE_CHANGED')
    proof = {'version': 1, 'scope': p.SCOPE, 'commit': commit, 'tree': tree,
        'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
        'contractSha256': p.sha(CONTRACT.read_bytes()), 'controlSources': c['controlPins'],
        'workflow': p.WORKFLOW, 'workflowSha256': c['workflowSha256'], 'sources': c['sources'],
        'qualitySourceEvidence': quality, 'qualityPartEvidence': quality_parts,
        'baselineAdminSourceReproduced': True, 'baselineAdminFiles': outputs['baseline'], 'adminFiles': outputs['candidate'],
        'updatedServices': list(p.UPDATED), 'preservedServices': list(p.PRESERVED),
        'migrationPerformed': False, 'businessActions': 0, 'files': h.file_inventory(payload)}
    p.verify_proof(proof, proof, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'online-session-preflight-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_SESSION_PREFLIGHT_NATIVE_BUILT', 'commit': commit,
        'updatedServices': list(p.UPDATED), 'preservedServices': list(p.PRESERVED), 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze', action='store_true')
    parser.add_argument('--baseline')
    parser.add_argument('--predecessor-proof')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.freeze:
        publisher().need(args.baseline and args.predecessor_proof and not args.check, 'FREEZE_ARGUMENTS_INVALID')
        freeze(args.baseline, args.predecessor_proof)
    elif args.check:
        check(json.loads(CONTRACT.read_bytes()))
        print(json.dumps({'status': 'ONLINE_SESSION_PREFLIGHT_SOURCE_VERIFIED', 'businessActions': 0}))
    else:
        publisher().need(args.baseline is None and args.predecessor_proof is None, 'ARGUMENTS_INVALID')
        main()
