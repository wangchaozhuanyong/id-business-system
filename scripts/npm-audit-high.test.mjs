import assert from 'node:assert/strict';
import test from 'node:test';

import { isTransientNpmAuditFailure, runAuditWithRetry } from './npm-audit-high.mjs';

test('recognizes only known npm audit infrastructure failures as transient', () => {
  assert.equal(isTransientNpmAuditFailure('npm warn audit 503 Service Unavailable'), true);
  assert.equal(
    isTransientNpmAuditFailure('npm warn audit network timeout at registry.npmjs.org'),
    true
  );
  assert.equal(isTransientNpmAuditFailure('found 1 high severity vulnerability'), false);
});

test('returns immediately when npm audit succeeds', async () => {
  let attempts = 0;
  const code = await runAuditWithRetry({
    runAttempt: async () => {
      attempts += 1;
      return { code: 0, output: 'found 0 vulnerabilities' };
    },
    waitForRetry: async () => assert.fail('success must not retry')
  });

  assert.equal(code, 0);
  assert.equal(attempts, 1);
});

test('does not retry a real vulnerability failure', async () => {
  let attempts = 0;
  const code = await runAuditWithRetry({
    runAttempt: async () => {
      attempts += 1;
      return { code: 1, output: 'found 1 high severity vulnerability' };
    },
    waitForRetry: async () => assert.fail('vulnerability failure must not retry')
  });

  assert.equal(code, 1);
  assert.equal(attempts, 1);
});

test('retries transient failures and preserves the final failure', async () => {
  const waits = [];
  const warnings = [];
  let attempts = 0;
  const code = await runAuditWithRetry({
    runAttempt: async () => {
      attempts += 1;
      return {
        code: 1,
        output: 'npm error audit endpoint returned an error'
      };
    },
    waitForRetry: async (delayMs) => waits.push(delayMs),
    warn: (message) => warnings.push(message)
  });

  assert.equal(code, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [15_000]);
  assert.equal(warnings.length, 1);
});

test('passes when a transient failure recovers', async () => {
  let attempts = 0;
  const code = await runAuditWithRetry({
    runAttempt: async () => {
      attempts += 1;
      if (attempts === 1) {
        return { code: 1, output: 'npm warn audit network timeout' };
      }
      return { code: 0, output: 'found 0 vulnerabilities' };
    },
    waitForRetry: async () => {},
    warn: () => {}
  });

  assert.equal(code, 0);
  assert.equal(attempts, 2);
});
