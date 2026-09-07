import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyChangedPaths, decideCiScope } from './ci-change-scope.mjs';

test('ordinary application changes do not repeat dependency audit', () => {
  assert.deepEqual(
    classifyChangedPaths([
      'apps/admin/src/v2/components/orders/V2OrderPanel.vue',
      'apps/api/src/id-business-v2/orders/id-business-v2-orders.service.ts'
    ]),
    { dependencyAudit: false }
  );
});

test('only dependency manifests select dependency audit', () => {
  assert.deepEqual(classifyChangedPaths(['apps/api/Dockerfile.mysql']), {
    dependencyAudit: false
  });
  assert.deepEqual(classifyChangedPaths(['package-lock.json']), {
    dependencyAudit: true
  });
  assert.deepEqual(classifyChangedPaths(['scripts/npm-audit-high.mjs']), {
    dependencyAudit: true
  });
});

test('changed paths determine dependency audit', () => {
  assert.deepEqual(
    decideCiScope({
      eventName: 'push',
      changedPaths: ['package-lock.json', 'apps/api/Dockerfile.mysql']
    }),
    {
      dependencyAudit: true,
      reason: 'changed_paths'
    }
  );
});

test('manual quality runs dependency audit', () => {
  assert.deepEqual(decideCiScope({ eventName: 'workflow_dispatch' }), {
    dependencyAudit: true,
    reason: 'manual'
  });
});
