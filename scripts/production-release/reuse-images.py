"""Reuse a completed immutable build only when application source is unchanged."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess

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


def main():
    run_id = os.environ['REUSE_IMAGE_RUN']
    deployment.require(re.fullmatch(r'[1-9][0-9]*', run_id), 'Invalid reusable image run')
    repository = os.environ['GITHUB_REPOSITORY']
    run = json.loads(command('gh', 'api', f'repos/{repository}/actions/runs/{run_id}'))
    jobs = json.loads(command('gh', 'api',
        f'repos/{repository}/actions/runs/{run_id}/attempts/{run["run_attempt"]}/jobs?per_page=100'))
    commit, attempt = build_source(run, jobs)
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
    main()
