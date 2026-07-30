import assert from 'node:assert/strict';
import test from 'node:test';

test('loads the compiled shared package with standard Node ESM resolution', async () => {
  const shared = await import('../dist/index.js');

  assert.equal(typeof shared.multiplyDecimalStrings, 'function');
  assert.deepEqual(shared.V2_FINANCE_CURRENCIES, ['CNY', 'MYR', 'USDT']);
});
