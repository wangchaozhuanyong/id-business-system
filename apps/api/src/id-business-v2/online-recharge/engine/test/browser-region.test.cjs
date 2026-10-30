'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const { getTaskBrowserContextOptions } = require('../upstream/browser-runtime');

function runtime() {
  const file = path.join(__dirname, '../upstream/browser-runtime.js');
  const localRequire = createRequire(file);
  const effects = { launches: [], pools: [], closes: 0, logs: [] };
  const module = { exports: {} };
  runInNewContext(fs.readFileSync(file, 'utf8'), {
    module,
    process: { env: {} },
    console: { log: (...args) => effects.logs.push(args) },
    require(name) {
      if (name === './browser-standalone')
        return {
          connectStandaloneBrowser: async (options) => {
            effects.launches.push(options);
            return {
              mode: 'persistent',
              context: {},
              close: async () => {
                effects.closes++;
              }
            };
          }
        };
      if (name === './browser-pool-client')
        return {
          connectPoolBrowser: async (options) => {
            effects.pools.push(options);
            return { mode: 'pool' };
          }
        };
      return localRequire(name);
    }
  });
  return { api: module.exports, effects };
}

const regions = [
  ['PH', 'en-PH', 'Asia/Manila'],
  ['CL', 'en-CL', 'America/Santiago'],
  ['MY', 'en-MY', 'Asia/Kuala_Lumpur'],
  ['SG', 'en-SG', 'Asia/Singapore'],
  ['US', 'en-US', 'America/New_York']
];
for (const [region, locale, timezoneId] of regions) {
  test(`${region}: query and recharge launch with the same frozen region, even with stale caller settings`, async () => {
    const f = runtime();
    const env = {
      ONLINE_RECHARGE_PROFILE_ROOT: 'synthetic-root',
      PAYMENT_REGION_OVERRIDE: region,
      CHATGPT_SESSION_JSON: 'synthetic-session',
      PROXY: 'http://127.0.0.1:8080',
      BROWSER_RUNTIME_MODE: 'pool',
      CDP_PORT: '43123'
    };
    const stale = { locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1920, height: 1080 } };
    for (const contextOptions of [undefined, stale]) {
      const session = await f.api.connectTaskBrowser({ env, contextOptions, headful: true });
      await f.api.closeTaskBrowser(session, session.browser);
    }
    assert.equal(f.effects.pools.length, 0);
    assert.equal(f.effects.closes, 2);
    assert.equal(f.effects.launches.length, 2);
    for (const options of f.effects.launches) {
      assert.equal(options.contextOptions.locale, locale);
      assert.equal(options.contextOptions.timezoneId, timezoneId);
      assert.equal(options.contextOptions.viewport.width, 1920);
      assert.equal(options.contextOptions.viewport.height, 1080);
      assert.equal(options.contextOptions.userAgent, undefined);
      assert.equal(options.contextOptions.extraHTTPHeaders, undefined);
      assert.equal(options.proxyBinding, env.PROXY);
      assert.equal(options.cdpPort, '43123');
      assert.equal(options.headful, true);
    }
    assert.equal(stale.locale, 'en-US');
    assert.equal(stale.timezoneId, 'UTC');
    assert.ok(!JSON.stringify(f.effects.logs).includes(env.CHATGPT_SESSION_JSON));
    assert.ok(!JSON.stringify(f.effects.logs).includes(env.PROXY));
  });
}

test('missing task region keeps the existing PH default; context options and proxy are not mutated', () => {
  const options = {
    locale: 'en-US',
    timezoneId: 'UTC',
    proxy: { server: 'http://127.0.0.1:8080' }
  };
  const resolved = getTaskBrowserContextOptions(options, {});
  assert.equal(resolved.locale, 'en-PH');
  assert.equal(resolved.timezoneId, 'Asia/Manila');
  assert.equal(resolved.proxy, options.proxy);
  assert.equal(options.locale, 'en-US');
  assert.equal(options.timezoneId, 'UTC');
});

test('generic pool connection remains borrowed and does not launch an account context', async () => {
  const f = runtime();
  const result = await f.api.connectTaskBrowser({
    env: {
      BROWSER_RUNTIME_MODE: 'pool',
      BROWSER_POOL_CDP_URL: 'http://127.0.0.1:43210',
      BROWSER_POOL_SLOT: 'synthetic-slot',
      PAYMENT_REGION_OVERRIDE: 'CL'
    }
  });
  assert.equal(result.mode, 'pool');
  assert.equal(f.effects.launches.length, 0);
  assert.equal(f.effects.logs.length, 0);
  assert.equal(f.effects.pools.length, 1);
});
