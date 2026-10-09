import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
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
test('客户 Session 临时边界必须在离页清除', () => {
  assert.match(
    checkMutation(
      'check-v2-input-retention.mjs',
      'apps/admin/src/v2/features/online-recharge/PublicOnlineRechargeView.vue',
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
