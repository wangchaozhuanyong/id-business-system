import assert from 'node:assert/strict';
import test from 'node:test';
import { getSoleActiveVersionId } from './lib/cloudflare-deployment.mjs';

const stableVersionId = '10000000-0000-4000-8000-000000000000';

test('captures the sole production version before deployment', () => {
  assert.equal(
    getSoleActiveVersionId({
      versions: [{ version_id: stableVersionId, percentage: 100 }]
    }),
    stableVersionId
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
    /单一版本承载 100% 流量/
  );
});
