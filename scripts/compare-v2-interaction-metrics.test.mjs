import test from 'node:test';
import assert from 'node:assert/strict';
import { compareInteractionMetrics } from './compare-v2-interaction-metrics.mjs';
const report = (patch = {}) => ({
  conditions: { viewport: '1440x900', network: 'fixed', fixture: 'synthetic-v1' },
  samples: Array.from({ length: 20 }, () => ({
    path: '/v2/orders',
    dataSource: 'memory-cache',
    paintMs: 100,
    feedbackMs: 50,
    tableMeasurements: [4],
    ...patch
  }))
});
test('accepts comparable samples and rejects incomplete or slower measurements', () => {
  assert.equal(compareInteractionMetrics(report(), report()).length, 1);
  assert.throws(() => compareInteractionMetrics({ ...report(), samples: [] }, report()), /样本/);
  assert.throws(() => compareInteractionMetrics(report({ paintMs: 201 }), report()), /200ms/);
  assert.throws(() => compareInteractionMetrics(report({ paintMs: 115 }), report()), /10%/);
  assert.throws(() => compareInteractionMetrics(report({ feedbackMs: 201 }), report()), /反馈/);
  assert.throws(
    () => compareInteractionMetrics(report({ tableMeasurements: [51] }), report()),
    /50ms/
  );
  assert.throws(() => compareInteractionMetrics(report(), undefined), /基线/);
  assert.throws(
    () => compareInteractionMetrics({ ...report(), conditions: {} }, report()),
    /不能比较/
  );
});
