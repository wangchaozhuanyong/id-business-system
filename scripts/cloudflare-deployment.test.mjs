import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRODUCTION_RELEASE_LOCK_REF,
  assertReleaseStillOwnsActiveVersion,
  createProductionReleaseLockAcquireArguments,
  createProductionReleaseLockReleaseArguments,
  createWranglerRollbackArguments,
  fetchWithReleasePolicy,
  getDeploymentGitCommit,
  getReleaseFailureRecovery,
  getRemoteProductionReleaseLockCommit,
  getWranglerDeployVersionId,
  getSoleActiveVersionId
} from './lib/cloudflare-deployment.mjs';

const stableVersionId = '10000000-0000-4000-8000-000000000000';
const releaseCommit = '1'.repeat(40);

test('captures the sole production version before deployment', () => {
  assert.equal(
    getSoleActiveVersionId({
      versions: [{ version_id: stableVersionId, percentage: 100 }]
    }),
    stableVersionId
  );
});

test('requires an exact Git commit annotation on the active deployment', () => {
  assert.equal(
    getDeploymentGitCommit({
      annotations: {
        'workers/message': `git:${releaseCommit} branch:main`
      }
    }),
    releaseCommit
  );
  assert.throws(
    () =>
      getDeploymentGitCommit({
        annotations: {
          'workers/message': `git:${releaseCommit.slice(0, 12)} branch:main`
        }
      }),
    /完整 Git commit/
  );
  assert.throws(
    () =>
      getDeploymentGitCommit({
        annotations: {
          'workers/message': `git:${releaseCommit} branch:other`
        }
      }),
    /完整 Git commit/
  );
});

test('uses compare-and-swap arguments for the remote production release lock', () => {
  const leaseCommit = '2'.repeat(40);
  assert.deepEqual(createProductionReleaseLockAcquireArguments(leaseCommit), [
    'push',
    '--porcelain',
    `--force-with-lease=${PRODUCTION_RELEASE_LOCK_REF}:`,
    'origin',
    `${leaseCommit}:${PRODUCTION_RELEASE_LOCK_REF}`
  ]);
  assert.deepEqual(createProductionReleaseLockReleaseArguments(leaseCommit), [
    'push',
    '--porcelain',
    `--force-with-lease=${PRODUCTION_RELEASE_LOCK_REF}:${leaseCommit}`,
    'origin',
    `:${PRODUCTION_RELEASE_LOCK_REF}`
  ]);
  assert.equal(
    getRemoteProductionReleaseLockCommit(`${leaseCommit}\t${PRODUCTION_RELEASE_LOCK_REF}\n`),
    leaseCommit
  );
  assert.equal(getRemoteProductionReleaseLockCommit(''), '');
  assert.throws(
    () =>
      getRemoteProductionReleaseLockCommit(
        `${leaseCommit}\t${PRODUCTION_RELEASE_LOCK_REF}\n${'3'.repeat(40)}\trefs/tags/other\n`
      ),
    /不唯一/
  );
});

test('rejects a gradual deployment because one rollback target is ambiguous', () => {
  assert.throws(
    () =>
      getSoleActiveVersionId({
        versions: [
          { version_id: stableVersionId, percentage: 90 },
          {
            version_id: '20000000-0000-4000-8000-000000000000',
            percentage: 10
          }
        ]
      }),
    /单一版本承载 100% 流量/
  );
});

test('rejects malformed deployment status output', () => {
  assert.throws(
    () =>
      getSoleActiveVersionId({
        versions: [{ version_id: 'bad version id', percentage: 100 }]
      }),
    /无效版本 ID/
  );
});

test('rejects malformed active entries instead of filtering them out', () => {
  assert.throws(
    () =>
      getSoleActiveVersionId({
        versions: [
          { version_id: stableVersionId, percentage: 100 },
          { version_id: 'bad version id', percentage: 25 }
        ]
      }),
    /无效版本 ID/
  );
  assert.throws(
    () =>
      getSoleActiveVersionId({
        versions: [{ version_id: stableVersionId, percentage: 'not-a-number' }]
      }),
    /无效流量比例/
  );
});

test('builds a non-interactive rollback command for unattended recovery', () => {
  assert.deepEqual(
    createWranglerRollbackArguments(
      stableVersionId,
      'wrangler.cloudflare-free.jsonc',
      'Automatic rollback after smoke failure'
    ),
    [
      'rollback',
      stableVersionId,
      '--config',
      'wrangler.cloudflare-free.jsonc',
      '--message',
      'Automatic rollback after smoke failure',
      '--yes'
    ]
  );
});

test('retries transient GET requests with a fresh timeout signal', async () => {
  let calls = 0;
  let cancelledBodies = 0;
  const response = await fetchWithReleasePolicy('https://example.test/health', undefined, {
    fetchImpl: async (_input, init) => {
      calls += 1;
      assert.ok(init.signal instanceof AbortSignal);
      if (calls < 3) {
        return {
          status: 503,
          body: {
            async cancel() {
              cancelledBodies += 1;
            }
          }
        };
      }
      return { status: 200, body: null };
    },
    retryDelayMs: 0,
    sleepImpl: async () => undefined,
    timeoutMs: 50
  });

  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  assert.equal(cancelledBodies, 2);
});

test('does not retry writes or non-transient GET responses', async () => {
  let writeCalls = 0;
  await assert.rejects(
    fetchWithReleasePolicy(
      'https://example.test/login',
      { method: 'POST' },
      {
        fetchImpl: async () => {
          writeCalls += 1;
          throw new Error('network failure');
        },
        retryDelayMs: 0,
        sleepImpl: async () => undefined,
        timeoutMs: 50
      }
    ),
    /network failure/
  );
  assert.equal(writeCalls, 1);

  let readCalls = 0;
  const response = await fetchWithReleasePolicy('https://example.test/private', undefined, {
    fetchImpl: async () => {
      readCalls += 1;
      return { status: 401, body: null };
    },
    retryDelayMs: 0,
    sleepImpl: async () => undefined,
    timeoutMs: 50
  });
  assert.equal(response.status, 401);
  assert.equal(readCalls, 1);
});

test('failed releases only produce manual recovery decisions', () => {
  const deployedVersionId = '20000000-0000-4000-8000-000000000000';
  assert.deepEqual(
    getReleaseFailureRecovery(deployedVersionId, deployedVersionId, stableVersionId),
    {
      action: 'manual-rollback',
      activeVersionId: deployedVersionId,
      rollbackVersionId: stableVersionId
    }
  );
  assert.deepEqual(
    getReleaseFailureRecovery(
      '30000000-0000-4000-8000-000000000000',
      deployedVersionId,
      stableVersionId
    ),
    {
      action: 'manual-investigation',
      activeVersionId: '30000000-0000-4000-8000-000000000000',
      rollbackVersionId: null
    }
  );
});

test('reads the exact deployed version from Wrangler structured output', () => {
  assert.equal(
    getWranglerDeployVersionId(
      `${JSON.stringify({
        type: 'deploy',
        version: 1,
        version_id: stableVersionId,
        worker_name: 'worker'
      })}\n`
    ),
    stableVersionId
  );
  assert.throws(
    () =>
      getWranglerDeployVersionId(
        `${JSON.stringify({ type: 'deploy', version: 1, version_id: stableVersionId })}\n${JSON.stringify(
          {
            type: 'deploy',
            version: 1,
            version_id: '20000000-0000-4000-8000-000000000000'
          }
        )}\n`
      ),
    /唯一有效/
  );
});

test('refuses to roll back a version replaced by another release', () => {
  assert.doesNotThrow(() => assertReleaseStillOwnsActiveVersion(stableVersionId, stableVersionId));
  assert.throws(
    () =>
      assertReleaseStillOwnsActiveVersion('20000000-0000-4000-8000-000000000000', stableVersionId),
    /其他发布替换/
  );
});
