"""Reuse a completed immutable build only when application source is unchanged."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import hashlib
import tempfile
import sys

spec = importlib.util.spec_from_file_location('deployment', Path(__file__).with_name('remote-deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def build_source(run, jobs):
    deployment.require(run.get('event') == 'workflow_dispatch'
                       and run.get('path') == '.github/workflows/production-release.yml'
                       and run.get('head_branch') == 'main'
                       and run.get('status') == 'completed', 'Unverified previous image build run')
    steps = [step for job in jobs['jobs'] if job.get('name') == 'release'
             for step in job.get('steps', [])]
    for name in ('Verify exact source and passing Quality Gate',
                 'Build images on the GitHub runner', 'Push immutable images'):
        matches = [step for step in steps if step.get('name') == name]
        deployment.require(len(matches) == 1 and matches[0].get('conclusion') == 'success',
                           'Previous build or immutable image push did not succeed')
    commit = run.get('head_sha', '')
    deployment.require(re.fullmatch(r'[0-9a-f]{40}', commit), 'Invalid previous image source')
    attempt = str(run.get('run_attempt', ''))
    deployment.require(re.fullmatch(r'[1-9][0-9]*', attempt), 'Invalid previous image build attempt')
    return commit, attempt


POST_CLEANUP_POLICY = 'historical-finance-20261005-post-cleanup'
POST_CLEANUP_BASELINE = '6a82a774f2a65e00d4f260c629f7152bf7935d1d'
PREPARE_OPERATION = 'prepare_post_cleanup_release'
ORDER_ARCHIVE_POLICY = 'historical-finance-20261005-order-archive'
ORDER_ARCHIVE_PREPARE_OPERATION = 'prepare_order_archive_release'
ORDER_ARCHIVE_SERVICES = ('api', 'migrate', 'admin')
ORDER_ARCHIVE_BASELINE = '7f70688b9bf53a071a0a324ca558aeabc4ced2e3'


def validate_prepared_source(run, jobs, manifest, release, source_tree, quality_run, run_id, repository,
                             *, order_archive=False):
    commit, attempt = build_source(run, jobs)
    deployment.require(run.get('conclusion') == 'success' and str(run.get('id')) == run_id
                       and commit == release, 'Preparation must be a successful run of the same commit')
    steps = [step for job in jobs['jobs'] if job.get('name') == 'release'
             for step in job.get('steps', [])]
    record = 'Record prepared order archive image source' if order_archive else 'Record prepared API image source'
    save = 'Save prepared order archive image source' if order_archive else 'Save prepared API image source'
    for name in ('Validate release policy and reviewed seal selection',
                 'Verify build-only ECR target', record, save):
        matches = [step for step in steps if step.get('name') == name]
        deployment.require(len(matches) == 1 and matches[0].get('conclusion') == 'success',
                           'Incomplete API image preparation evidence')
    for name in ('Check AWS identity and production target', 'Verify read-only SSM command access',
                 'Deploy through the production instance',
                 'Verify or maintain recoverable unused project image cache'):
        matches = [step for step in steps if step.get('name') == name]
        deployment.require(len(matches) == 1 and matches[0].get('conclusion') == 'skipped',
                           'Preparation must not access SSM, deploy or clean production cache')
    expected = {
        'formatVersion': 1,
        'operation': ORDER_ARCHIVE_PREPARE_OPERATION if order_archive else PREPARE_OPERATION,
        'policyId': ORDER_ARCHIVE_POLICY if order_archive else POST_CLEANUP_POLICY,
        'sourceCommit': release, 'sourceTree': source_tree, 'qualityRunId': quality_run,
        'expectedCurrent': ORDER_ARCHIVE_BASELINE if order_archive else POST_CLEANUP_BASELINE,
        'runId': run_id, 'runAttempt': attempt,
        'repository': repository
    }
    deployment.require(set(manifest) == {*expected, 'images'}
                       and all(manifest.get(key) == value for key, value in expected.items()),
                       'Preparation operation, policy or source proof mismatch')
    deployment.require(re.fullmatch(r'[0-9a-f]{40}', source_tree)
                       and re.fullmatch(r'[1-9][0-9]*', quality_run), 'Invalid preparation source or CI evidence')
    services = set(ORDER_ARCHIVE_SERVICES) if order_archive else {'api', 'migrate'}
    deployment.require(isinstance(manifest['images'], dict)
                       and set(manifest['images']) == services, 'Preparation image scope changed')
    for service, image in manifest['images'].items():
        reference = f'{repository}:{release}-{run_id}-{attempt}-{service}'
        deployment.require(isinstance(image, dict)
                           and set(image) == {'reference', 'revision', 'imageId', 'digest'}
                           and image['reference'] == reference and image['revision'] == release
                           and re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('imageId', ''))
                           and re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('digest', '')),
                           'Invalid prepared image identity')
    return commit, attempt


def prepared_artifact(artifacts, run_id, attempt, release, *, order_archive=False):
    prefix = 'order-archive' if order_archive else 'post-cleanup'
    name = f'{prefix}-prepared-images-{run_id}-{attempt}'
    matches = [artifact for artifact in artifacts.get('artifacts', []) if artifact.get('name') == name]
    deployment.require(len(matches) == 1, 'Exact preparation artifact required')
    artifact = matches[0]
    origin = artifact.get('workflow_run', {})
    deployment.require(artifact.get('expired') is False
                       and isinstance(artifact.get('size_in_bytes'), int)
                       and 0 < artifact['size_in_bytes'] <= 65536
                       and str(origin.get('id')) == run_id and origin.get('head_branch') == 'main'
                       and origin.get('head_sha') == release, 'Untrusted or expired preparation artifact')
    return name


def write_prepared_manifest():
    command('bash', 'scripts/production-release/validate-release-selection.sh')
    order_archive = os.environ.get('HISTORICAL_EXCEPTION') == ORDER_ARCHIVE_POLICY
    operation = ORDER_ARCHIVE_PREPARE_OPERATION if order_archive else PREPARE_OPERATION
    policy = ORDER_ARCHIVE_POLICY if order_archive else POST_CLEANUP_POLICY
    services = ORDER_ARCHIVE_SERVICES if order_archive else ('api', 'migrate')
    deployment.require(os.environ['RELEASE_OPERATION'] == operation,
                       'Preparation manifest is build-only')
    release = os.environ['RELEASE_COMMIT']
    source_tree = os.environ['SOURCE_TREE']
    quality_run = os.environ['QUALITY_RUN_ID']
    run_id, attempt = os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT']
    repository = os.environ['RELEASE_REPOSITORY']
    deployment.require(re.fullmatch(r'[0-9a-f]{40}', release)
                       and command('git', 'rev-parse', 'HEAD') == release
                       and command('git', 'rev-parse', 'HEAD^{tree}') == source_tree
                       and re.fullmatch(r'[0-9a-f]{40}', source_tree)
                       and all(re.fullmatch(r'[1-9][0-9]*', value) for value in (run_id, attempt, quality_run)),
                       'Preparation source and CI evidence unavailable')
    manifest = {'formatVersion': 1, 'operation': operation, 'policyId': policy,
                'sourceCommit': release, 'sourceTree': source_tree, 'qualityRunId': quality_run,
                'expectedCurrent': ORDER_ARCHIVE_BASELINE if order_archive else POST_CLEANUP_BASELINE,
                'runId': run_id, 'runAttempt': attempt,
                'repository': repository, 'images': {}}
    for service in services:
        tag = f'{release}-{run_id}-{attempt}-{service}'
        reference = f'{repository}:{tag}'
        revision = command('docker', 'image', 'inspect', reference, '--format',
                           '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
        image_id = command('docker', 'image', 'inspect', reference, '--format', '{{.Id}}')
        digest = command('aws', 'ecr', 'describe-images', '--repository-name', 'id-business-v2-release',
                         '--image-ids', 'imageTag=' + tag, '--query', 'imageDetails[0].imageDigest', '--output', 'text')
        deployment.require(revision == release and re.fullmatch(r'sha256:[0-9a-f]{64}', image_id)
                           and re.fullmatch(r'sha256:[0-9a-f]{64}', digest), 'Prepared image identity is unavailable')
        manifest['images'][service] = {'reference': reference, 'revision': revision,
                                       'imageId': image_id, 'digest': digest}
    path = Path('.deploy/production-release/prepared-images.json')
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as output:
        json.dump(manifest, output, sort_keys=True, separators=(',', ':'))
    print(json.dumps({'operation': operation, 'preparedServices': list(services),
                      'sourceCommit': release, 'apiImageId': manifest['images']['api']['imageId'],
                      'manifestSha256': hashlib.sha256(path.read_bytes()).hexdigest()}))


def reuse_post_cleanup(run, jobs, repository, run_id, *, order_archive=False):
    command('bash', 'scripts/production-release/validate-release-selection.sh')
    release = os.environ['RELEASE_COMMIT']
    deployment.require(os.environ.get('RELEASE_OPERATION', 'release') == 'release',
                       'Preparation images can be reused only for release')
    # Reject other commits or incomplete preparation before downloading any artifact.
    commit, attempt = build_source(run, jobs)
    deployment.require(commit == release and run.get('conclusion') == 'success',
                       'Preparation must be a successful run of the same commit')
    artifacts = json.loads(command('gh', 'api', f'repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100'))
    name = prepared_artifact(artifacts, run_id, attempt, release, order_archive=order_archive)
    runtime = Path('.deploy/production-release')
    runtime.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='prepared-image-source-', dir=runtime) as temporary:
        command('gh', 'run', 'download', run_id, '--repo', repository, '--name', name, '--dir', temporary)
        directory = Path(temporary)
        path = directory / 'prepared-images.json'
        deployment.require(list(directory.iterdir()) == [path] and path.is_file()
                           and not path.is_symlink() and path.stat().st_size <= 16384,
                           'Preparation artifact must contain one bounded manifest')
        raw = path.read_bytes()
        manifest = json.loads(raw)
        validate_prepared_source(run, jobs, manifest, release, os.environ['SOURCE_TREE'],
                                 os.environ['QUALITY_RUN_ID'], run_id, os.environ['RELEASE_REPOSITORY'],
                                 order_archive=order_archive)
    with Path(os.environ['GITHUB_ENV']).open('a') as env:
        env.write(f'REUSE_IMAGE_COMMIT={commit}\nREUSE_IMAGE_RUN_ID={run_id}\n'
                  f'REUSE_IMAGE_RUN_ATTEMPT={attempt}\nRELEASE_ADMIN_ONLY=false\n')
        if order_archive:
            env.write('ORDER_ARCHIVE_PREPARED_IMAGES_SHA256=' + hashlib.sha256(raw).hexdigest() + '\n')
    print(json.dumps({'imageCommit': commit, 'imageBuildRun': run_id, 'imageBuildAttempt': attempt,
                      'preparedServices': list(ORDER_ARCHIVE_SERVICES) if order_archive else ['api', 'migrate'],
                      'apiImageId': manifest['images']['api']['imageId'],
                      'manifestSha256': hashlib.sha256(raw).hexdigest(), 'adminOnly': False}))


def main():
    run_id = os.environ['REUSE_IMAGE_RUN']
    deployment.require(re.fullmatch(r'[1-9][0-9]*', run_id), 'Invalid reusable image run')
    repository = os.environ['GITHUB_REPOSITORY']
    run = json.loads(command('gh', 'api', f'repos/{repository}/actions/runs/{run_id}'))
    jobs = json.loads(command('gh', 'api',
        f'repos/{repository}/actions/runs/{run_id}/attempts/{run["run_attempt"]}/jobs?per_page=100'))
    commit, attempt = build_source(run, jobs)
    if os.environ.get('HISTORICAL_EXCEPTION') == POST_CLEANUP_POLICY:
        return reuse_post_cleanup(run, jobs, repository, run_id)
    if os.environ.get('HISTORICAL_EXCEPTION') == ORDER_ARCHIVE_POLICY:
        return reuse_post_cleanup(run, jobs, repository, run_id, order_archive=True)
    release = os.environ['RELEASE_COMMIT']
    command('git', 'merge-base', '--is-ancestor', commit, release)
    paths = command('git', 'diff', '--name-only', commit, release).splitlines()
    mailbox_only = os.environ.get('HISTORICAL_EXCEPTION') == deployment.MAILBOX_POLICY_ID
    deployment.require_reusable_paths(paths, mailbox_only=mailbox_only)
    if mailbox_only:
        deployment.verify_mailbox_carried_sources(Path('.'))
    scope = command('node', '--input-type=module', '-e',
        "import {execFileSync} from 'node:child_process';"
        "import {isAdminOnly} from './scripts/ci-recharge-scope.mjs';"
        "console.log(isAdminOnly(execFileSync('git',['diff','--name-only',"
        "process.env.EXPECTED_CURRENT,process.env.RELEASE_COMMIT],{encoding:'utf8'})"
        ".trim().split('\\n').filter(Boolean)));" )
    deployment.require(scope in ('true', 'false'), 'Invalid release scope')
    with Path(os.environ['GITHUB_ENV']).open('a') as env:
        env.write(f'REUSE_IMAGE_COMMIT={commit}\nREUSE_IMAGE_RUN_ID={run_id}\n'
                  f'REUSE_IMAGE_RUN_ATTEMPT={attempt}\nRELEASE_ADMIN_ONLY={scope}\n')
    print(json.dumps({'imageCommit': commit, 'imageBuildRun': run_id,
                      'imageBuildAttempt': attempt, 'releaseCommit': release,
                      'applicationSourceUnchanged': not mailbox_only, 'apiSourceUnchanged': True,
                      'servicesUpdated': ['api'] if mailbox_only else None, 'adminOnly': scope == 'true'}))


if __name__ == '__main__':
    if sys.argv[1:] == ['--write-prepared-manifest']:
        write_prepared_manifest()
    elif not sys.argv[1:]:
        main()
    else:
        raise SystemExit('Unknown image preparation operation')
