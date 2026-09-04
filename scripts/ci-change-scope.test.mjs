import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyChangedPaths, decideCiScope } from './ci-change-scope.mjs';

test('ordinary application changes do not rebuild production images or repeat dependency audit', () => {
  assert.deepEqual(
    classifyChangedPaths([
      'apps/admin/src/v2/components/orders/V2OrderPanel.vue',
      'apps/api/src/id-business-v2/orders/id-business-v2-orders.service.ts'
    ]),
    { dependencyAudit: false, productionImages: false }
  );
});

test('container and dependency boundary changes select the required expensive checks', () => {
  assert.deepEqual(classifyChangedPaths(['apps/api/Dockerfile.mysql']), {
    dependencyAudit: false,
    productionImages: true
  });
  assert.deepEqual(classifyChangedPaths(['package-lock.json']), {
    dependencyAudit: true,
    productionImages: true
  });
  assert.deepEqual(classifyChangedPaths(['scripts/npm-audit-high.mjs']), {
    dependencyAudit: true,
    productionImages: true
  });
});

test('production tags always run audit and build the one immutable artifact', () => {
  assert.deepEqual(
    decideCiScope({
      eventName: 'push',
      ref: 'refs/tags/v2-production-20260904T120000Z',
      changedPaths: []
    }),
    {
      dependencyAudit: true,
      productionImages: true,
      reason: 'production_tag'
    }
  );
});

test('main validates dependency changes without rebuilding disposable production images', () => {
  assert.deepEqual(
    decideCiScope({
      eventName: 'push',
      ref: 'refs/heads/main',
      changedPaths: ['package-lock.json', 'apps/api/Dockerfile.mysql']
    }),
    {
      dependencyAudit: true,
      productionImages: false,
      reason: 'main_quality_only'
    }
  );
});

test('manual quality runs build production images only when explicitly requested', () => {
  assert.equal(
    decideCiScope({
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/main'
    }).productionImages,
    false
  );
  assert.equal(
    decideCiScope({
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/main',
      manualBuildProductionImages: true
    }).productionImages,
    true
  );
});
