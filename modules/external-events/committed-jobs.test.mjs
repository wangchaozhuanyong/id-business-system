import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeCommittedJobs } from './committed-jobs.mjs';
const event = jobs => ({ version: 1, receipt: 'a'.repeat(64), jobs, scopes: ['task_logs'], reconcile: false });

test('committed jobs retain all batches and wait through a busy writer before acknowledgment', async () => {
  const jobs = Array.from({ length: 19 }, (_, i) => 'job-' + i), applied = [], trace = [];
  let busy = true;
  await consumeCommittedJobs([event(jobs)], {
    run: async ({ jobKeys }) => {
      assert(jobKeys.length <= 6);
      if (busy) { busy = false; throw Object.assign(new Error(), { status: 409 }); }
      applied.push(...jobKeys); trace.push('apply');
    },
    changed: async () => trace.push('change'), pendingJobs: async () => [],
    acknowledge: async () => trace.push('ack'), wait: async () => trace.push('wait')
  });
  assert.deepEqual(applied, jobs);
  assert.deepEqual(trace, ['wait', 'apply', 'apply', 'apply', 'apply', 'change', 'ack']);
});

test('late bill and ownership commits revisit incomplete jobs; failure never advances the source', async () => {
  let ack = false, applied;
  await consumeCommittedJobs([{ ...event(['known']), scopes: ['billing_records'], reconcile: true }], {
    pendingJobs: async () => ['known', 'late-bill'], run: async command => { applied = command.jobKeys; },
    changed: async () => {}, acknowledge: async () => { ack = true; }
  });
  assert.deepEqual(applied, ['known', 'late-bill']); assert(ack);
  ack = false;
  await assert.rejects(consumeCommittedJobs([event(['retry'])], {
    run: async () => { throw new Error('synthetic failure'); }, pendingJobs: async () => [], changed: async () => {},
    acknowledge: async () => { ack = true; }
  }), /not_applied/);
  assert.equal(ack, false);
});

test('idle streams do not read or write and malformed events fail closed', async () => {
  const fail = async () => assert.fail('idle must do nothing');
  const handlers = { run: fail, pendingJobs: fail, changed: fail, acknowledge: fail };
  await consumeCommittedJobs([], handlers);
  await assert.rejects(consumeCommittedJobs([event(['invalid key'])], handlers), /invalid_committed_event/);
});
