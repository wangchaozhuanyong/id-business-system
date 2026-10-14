import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { load } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const text = readFileSync(
  resolve(root, '.github/workflows/online-recharge-diagnostic.yml'),
  'utf8'
);
const workflow = load(text);

test('failure diagnostic is explicit, serial, main-only, with read-only repository access', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    'evidence_run_id',
    'evidence_run_attempt'
  ]);
  assert.deepEqual(workflow.permissions, {
    actions: 'read',
    contents: 'read',
    'id-token': 'write'
  });
  assert.equal(workflow.concurrency.group, 'id-business-v2-production-release');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.diagnostic.if, "github.ref == 'refs/heads/main'");
});

test('the workflow only queries an original run and uploads the safe typed summary', () => {
  const steps = workflow.jobs.diagnostic.steps;
  const execution = steps.filter((step) => step.run);
  assert.equal(execution.length, 1);
  assert.match(execution[0].run, /online-recharge-component-diagnostic\.py/);
  assert.match(execution[0].run, /--evidence-run-id "\$EVIDENCE_RUN_ID"/);
  assert.match(execution[0].run, /--evidence-run-attempt "\$EVIDENCE_RUN_ATTEMPT"/);
  assert.doesNotMatch(
    text,
    /send-command|docker |push-images|build-images|dispatch\.sh|remote-deploy|preflight|release_online_recharge/
  );
  const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.if, 'always()');
  assert.equal(
    upload.with.path,
    '.deploy/production-release/online-recharge-component-evidence-diagnostic.json'
  );
  assert.equal(upload.with['include-hidden-files'], true);
});

test('the AWS action matches the established release action and fixed production target', () => {
  const release = load(
    readFileSync(resolve(root, '.github/workflows/production-release.yml'), 'utf8')
  );
  const established = release.jobs.release.steps.find((step) =>
    step.uses?.startsWith('aws-actions/configure-aws-credentials@')
  );
  const credentialStep = workflow.jobs.diagnostic.steps.find((step) =>
    step.uses?.startsWith('aws-actions/configure-aws-credentials@')
  );
  assert.equal(credentialStep.uses, established.uses);
  assert.equal(credentialStep.with['role-to-assume'], release.jobs.release.env.RELEASE_ROLE_ARN);
  assert.equal(workflow.jobs.diagnostic.env.AWS_REGION, release.jobs.release.env.AWS_REGION);
  assert.equal(
    workflow.jobs.diagnostic.env.PRODUCTION_INSTANCE_ID,
    release.jobs.release.env.PRODUCTION_INSTANCE_ID
  );
});
