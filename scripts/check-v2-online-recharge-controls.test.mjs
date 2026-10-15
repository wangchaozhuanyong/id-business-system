import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const acceptanceSource = () =>
  readFileSync(new URL('./acceptance-v2-online-recharge-ui.mjs', import.meta.url), 'utf8');

test('合成页面夹具按当前会话协议恢复账号并拦截全部外部连接', async () => {
  const source = acceptanceSource();
  const start = source.indexOf('async function fixture(context, state) {');
  const end = source.indexOf('\ntry {\n  await wait(', start);
  assert.ok(start >= 0 && end > start, '未找到实际页面请求夹具');
  const origin = 'http://127.0.0.1:5409';
  const actor = { id: 'fixture-admin', roles: ['admin'] };
  const fixture = runInNewContext(source.slice(start, end) + '\nfixture;', {
    URL,
    origin,
    date: '2026-10-15T00:00:00Z',
    task: {},
    settings: {},
    rows: {},
    setTimeout
  });
  let handler;
  let socketClosed = false;
  const network = await fixture(
    {
      routeWebSocket: async (_pattern, callback) =>
        callback({ close: () => (socketClosed = true) }),
      route: async (_pattern, callback) => (handler = callback)
    },
    { actor }
  );
  async function request(path, authorization = 'Bearer synthetic-access') {
    let result;
    await handler({
      request: () => ({
        url: () => new URL(path, origin).href,
        method: () => 'GET',
        headers: () => (authorization ? { authorization } : {})
      }),
      fulfill: async (value) => (result = JSON.parse(value.body)),
      abort: async () => (result = 'ABORTED'),
      continue: async () => (result = 'CONTINUED')
    });
    return result;
  }
  assert.deepEqual(await request('/api/auth/session'), {
    success: true,
    data: { accessToken: 'synthetic-access', user: actor }
  });
  assert.equal((await request('/api/id-business-v2/online-recharge/public/config')).success, true);
  assert.deepEqual(Array.from(network.credentialHeaders), ['Bearer synthetic-access']);
  assert.equal(
    (await request('/api/id-business-v2/online-recharge/public/config', null)).success,
    false
  );
  assert.equal(await request('https://outside.example.invalid/checkout'), 'ABORTED');
  assert.deepEqual(Array.from(network.unexpected), ['https://outside.example.invalid']);
  assert.equal(socketClosed, true);
});

test('合成兑换验收跟随已发布后台路由而不再等待旧匿名页面', () => {
  const source = acceptanceSource();
  const router = readFileSync(new URL('../apps/admin/src/v2-router.ts', import.meta.url), 'utf8');
  const match = source.match(/const legacyRoutes = (\{[\s\S]*?\n\});/);
  assert.ok(match, '验收缺少旧入口到后台的跳转契约');
  const routes = runInNewContext('(' + match[1] + ')');
  assert.equal(routes['/online-recharge'], '/v2/online-recharge/redeem');
  assert.equal(routes['/online-recharge/subscription'], '/v2/online-recharge/renewal');
  for (const [path, target] of Object.entries(routes)) {
    const entry = router.slice(router.indexOf(`path: '${path}'`));
    assert.ok(entry.slice(0, entry.indexOf('\n    }')).includes(`redirect: '${target}'`));
  }
  assert.ok(source.includes('await page.waitForURL(origin + legacyRoutes[path])'));
  assert.ok(source.includes('await page.waitForURL(origin + (legacyRoutes[path] ?? path))'));
  assert.ok(!source.includes("page.locator('.online-public').waitFor()"));
  assert.ok(!source.includes('network.publicHeaders'));
  assert.ok(
    source.includes("'internal-session-volatile-capability-no-browser-storage-authenticated'")
  );
});

function checkMutation(checker, file, from, to, expectedStatus = 1) {
  const runner = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.readFileSync;
    const target = path.resolve(process.env.ONLINE_CONTROL_FILE);
    fs.readFileSync = (file, ...args) => {
      const source = original(file, ...args);
      return typeof file === 'string' && path.resolve(file) === target
        ? source.replaceAll(process.env.ONLINE_CONTROL_FROM, process.env.ONLINE_CONTROL_TO) : source;
    };
    syncBuiltinESMExports();
    await import('./scripts/' + process.env.ONLINE_CONTROL_CHECKER);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', runner], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ONLINE_CONTROL_CHECKER: checker,
      ONLINE_CONTROL_FILE: file,
      ONLINE_CONTROL_FROM: from,
      ONLINE_CONTROL_TO: to
    }
  });
  assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
  return result.stdout + result.stderr;
}
test('共享动态表不能丢掉 schema 列约束', () => {
  assert.match(
    checkMutation(
      'check-v2-table-standard.mjs',
      'apps/admin/src/v2/features/online-recharge/OnlineResourceView.vue',
      '.filter(isV2TableDataColumn)',
      '.slice(1)'
    ),
    /动态表必须从登记 schema 原样派生列/
  );
});
test('动态表不能用页面宽度覆盖公共列契约', () => {
  assert.match(
    checkMutation(
      'check-v2-table-standard.mjs',
      'apps/admin/src/v2/features/online-recharge/OnlineResourceView.vue',
      ':definition="column"',
      ':definition="column" width="60"'
    ),
    /禁止页面级 width/
  );
});
test('新增次级路由必须登记其实际加载模块', () => {
  assert.match(
    checkMutation(
      'check-v2-loading-standard.mjs',
      'apps/admin/src/v2/features/online-recharge/V2OnlineCardsView.vue',
      "moduleKey: 'online-recharge-cards'",
      "moduleKey: 'online-recharge-unknown'"
    ),
    /统一模块查询入口缺少有效 moduleKey/
  );
});
test('后台兑换 Session 临时边界必须在离页清除', () => {
  assert.match(
    checkMutation(
      'check-v2-input-retention.mjs',
      'apps/admin/src/v2/features/online-recharge/V2OnlineRedeemView.vue',
      "session.value = '';",
      "session.value = 'retained';"
    ),
    /临时敏感输入必须在离页时清除/
  );
});
test('后台兑换 Session 临时边界不能写浏览器存储', () => {
  assert.match(
    checkMutation(
      'check-v2-input-retention.mjs',
      'apps/admin/src/v2/features/online-recharge/V2OnlineRedeemView.vue',
      "const session = ref('');",
      "const session = ref(''); sessionStorage.setItem('session', session.value);"
    ),
    /临时敏感输入不得进入浏览器存储/
  );
});
test('公开订阅 Session 仍必须在离页清除', () => {
  assert.match(
    checkMutation(
      'check-v2-input-retention.mjs',
      'apps/admin/src/v2/features/online-recharge/PublicOnlineSubscriptionView.vue',
      "session.value = '';",
      "session.value = 'retained';"
    ),
    /临时敏感输入必须在离页时清除/
  );
});
test('客户 Session 临时边界不能写浏览器存储', () => {
  assert.match(
    checkMutation(
      'check-v2-input-retention.mjs',
      'apps/admin/src/v2/features/online-recharge/PublicOnlineSubscriptionView.vue',
      "const session = ref('');",
      "const session = ref(''); sessionStorage.setItem('session', session.value);"
    ),
    /临时敏感输入不得进入浏览器存储/
  );
});
test('金额规则允许十四位整数，但仍拒绝五位小数', () => {
  const file = 'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts';
  assert.match(
    checkMutation('check-v2-decimal-standard.mjs', file, '\\d{1,14}', '\\d{1,14}', 0),
    /检查通过/
  );
  assert.match(
    checkMutation('check-v2-decimal-standard.mjs', file, '\\.\\d{1,4}', '\\.\\d{1,5}'),
    /不允许接受超过 4 位小数/
  );
});
