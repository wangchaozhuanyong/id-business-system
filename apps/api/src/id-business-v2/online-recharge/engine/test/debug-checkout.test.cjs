'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');

// Evaluate the actual readonly helper without importing the payment executor.
const source = fs.readFileSync(path.join(__dirname, '../upstream/index.js'), 'utf8');
const start = source.indexOf('const DEBUG_PAYMENT_BUTTON_PATTERNS =');
const end = source.indexOf('\nfunction buildDebugScreenshotPath', start);
assert.ok(start >= 0 && end > start);

function fixture(labels) {
  let now = 0;
  const effects = { click: 0, fill: 0 };
  const click = async () => {
    effects.click++;
    throw new Error('Debug must not click');
  };
  const fill = async () => {
    effects.fill++;
    throw new Error('Debug must not fill');
  };
  const wait = runInNewContext(source.slice(start, end) + '\nwaitForDebugPaymentStep;', {
    Date: { now: () => now },
    console: { log() {} }
  });
  const page = {
    click,
    fill,
    getByRole(role, { name }) {
      assert.equal(role, 'button');
      return {
        count: async () => labels.filter((label) => name.test(label)).length,
        isVisible: async () => true,
        click,
        fill
      };
    },
    waitForTimeout: async (milliseconds) => {
      now += milliseconds;
    }
  };
  return { page, wait, effects, elapsed: () => now };
}

for (const label of ['Subscribe', '订阅', '立即支付', 'Pay now', 'Upgrade to Pro']) {
  test(`debug recognizes ${label} without clicking or filling`, async () => {
    const f = fixture([label]);
    await f.wait(f.page);
    assert.equal(f.elapsed(), 0);
    assert.deepEqual(f.effects, { click: 0, fill: 0 });
  });
}

test('debug keeps its 60 second timeout when no supported final button is present', async () => {
  const f = fixture(['Cancel', 'Upgrade to Plus']);
  await assert.rejects(f.wait(f.page), /未检测到订阅\/支付提交按钮/);
  assert.equal(f.elapsed(), 60000);
  assert.deepEqual(f.effects, { click: 0, fill: 0 });
});
