"""PR-only reproducibility check; produces no production authority or access."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent


def validate_context(env):
    if not (env.get('GITHUB_ACTIONS') == 'true'
            and env.get('GITHUB_EVENT_NAME') == 'pull_request'
            and env.get('GITHUB_REPOSITORY') == 'wangchaozhuanyong/id-business-system'
            and env.get('GITHUB_HEAD_REF') == 'codex/interaction-release-20261104'
            and re.fullmatch('[a-f0-9]{40}', env.get('GITHUB_SHA', ''))
            and not any(env.get(k) for k in ['DATABASE_URL', 'AWS_ACCESS_KEY_ID',
                        'AWS_SECRET_ACCESS_KEY', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'DOCKER_HOST'])):
        raise RuntimeError('INTERACTION_VALIDATION_CONTEXT_REJECTED')


def main():
    validate_context(os.environ)
    spec = importlib.util.spec_from_file_location('interaction_validation_pub', HERE / 'interaction-flow-publication.py')
    pub = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pub)
    c = pub.contract()
    pub.check(c)
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=pub.ROOT, text=True).strip()
    pub.need(commit == os.environ['GITHUB_SHA'], 'VALIDATION_SOURCE_CHANGED')
    native = {'commit': commit, 'tree': subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=pub.ROOT, text=True).strip(),
              'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT']}
    out = pub.ROOT / '.runtime/interaction-flow-validation'
    pub.need(not out.exists(), 'VALIDATION_OUTPUT_EXISTS')
    out.mkdir(parents=True)
    plan = pub.P.plan_for(c, native)
    proof = pub.load('interaction-flow-build.py').build(c, plan, {'validationOnly': True},
              {'validationOnly': True, 'businessActions': 0}, out, pub.R)
    result = {'status': 'PR_PARENT_AND_CANDIDATE_REPRODUCED', 'source': commit,
              'baseline': c['expectedCurrent'], 'baselineFiles': len(proof['baselineAdminFiles']),
              'candidateFiles': len(proof['adminFiles']), 'productionAccess': False, 'businessActions': 0}
    (out / 'result.json').write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
