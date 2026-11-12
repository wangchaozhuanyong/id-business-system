import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';
import { actor as codeOwner, call, setup } from './helpers/recharge-return-fixture.mjs';

const actor = { id: 'fixture-admin', role: 'admin', name: '合成管理员' };
const rows = [
  { id: 'first', time: '2026-11-12 14:36:47', actor: '合成管理员', action: '查看订单资料', subject: '订单管理', result: '查看订单资料' }
];
const tableCell = 'th.table-actions, td.table-actions';
const nativeCell = 'th:last-child, td:last-child:not([colspan])';

async function geometry(table, selector = tableCell) {
  return table.evaluate((node, selector) => {
    const cells = [...node.querySelectorAll(selector)].filter(cell => cell.checkVisibility());
    const measurements = cells.map(cell => {
      const rect = cell.getBoundingClientRect(), style = getComputedStyle(cell);
      const controls = [...cell.querySelectorAll('button, a[href]')]
        .filter(button => button.checkVisibility() && !button.closest('[popover]'))
        .map(button => button.getBoundingClientRect());
      if (cell.tagName === 'TH') {
        const text = document.createRange();
        text.selectNodeContents(cell);
        controls.push(text.getBoundingClientRect());
      }
      const content = controls.length ? Math.max(...controls.map(box => box.right)) - Math.min(...controls.map(box => box.left)) : 0;
      const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) +
        parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      return {
        width: rect.width, count: controls.length, content, required: content + padding,
        contained: controls.every(box => box.left >= rect.left - 1 && box.right <= rect.right + 1)
      };
    });
    return {
      width: measurements[0]?.width, required: Math.max(...measurements.map(cell => cell.required)),
      controls: measurements.slice(1).map(cell => cell.count),
      contained: measurements.every(cell => cell.contained && Math.abs(cell.width - measurements[0].width) <= 1),
      pageFits: document.documentElement.scrollWidth <= innerWidth + 1
    };
  }, selector);
}

async function assertFits(table, selector, name) {
  const result = await geometry(table, selector);
  assert(result.contained && result.pageFits, name + ' controls must fit ' + JSON.stringify(result));
  assert(Math.abs(result.width - result.required) <= 2, name + ' column should fit its contents ' + JSON.stringify(result));
  return result;
}

test('action columns shrink to the widest visible group and keep controls usable across table layouts', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());

  await t.test('audit, shared row actions and mobile cards', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      await interceptDesign(context, { actor, localFixtures: {}, skipRechargeAssets: true });
      await context.route('**/api/local/audit/page?*', route => {
        const query = new URL(route.request().url()).searchParams.get('query');
        return route.fulfill({ json: { items: query ? [] : rows, page: 1, pageSize: 20, total: query ? 0 : 1 } });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(6000);
      await page.goto(origin + '/#/settings/audit');
      const audit = page.locator('table[data-table="运营审计日志"]');
      await audit.locator('tbody button[data-action="ops-audit-detail"]').waitFor();
      const single = await assertFits(audit, tableCell, 'audit');
      assert.deepEqual(single.controls, [1]);
      assert(single.width < 100);
      await audit.getByRole('button', { name: '查看详情' }).click();
      await page.locator('#drawer[open]').getByRole('button', { name: '关闭抽屉' }).click();
      const search = page.getByRole('textbox', { name: '搜索当前列表' });
      await search.fill('合成空结果');
      await audit.getByText('暂无符合条件的记录').waitFor();
      const empty = await assertFits(audit, tableCell, 'empty audit');
      assert(empty.width < single.width);
      await search.fill('');
      await audit.getByRole('button', { name: '查看详情' }).waitFor();

      await page.evaluate(() => {
        const A = window.IDDesignAPI;
        const slot = document.createElement('div');
        slot.id = 'test-action-columns';
        const columns = [
          { id: 'name', label: '名称' },
          { id: 'status', label: '状态' },
          { id: 'actions', label: '操作', action: true, render: row =>
            '<div class="action-links">' + A.textAction('详情', 'fixture-detail') +
            (row.multiple ? ['查看历史记录', '复制完整资料', '检查当前状态', '编辑关联资料'].map(
              label => A.textAction(label, 'fixture-other')).join('') : '') +
            '<button type="button" hidden>隐藏的超长操作按钮名称</button></div>' }
        ];
        slot.innerHTML = A.table(columns, [
          { id: 'a', name: '合成条目 A', status: '正常' },
          { id: 'b', name: '合成条目 B', status: '正常', multiple: true }
        ], '', '操作列尺寸合成资料');
        document.querySelector('#main').append(slot);
      });
      const mixed = page.locator('#test-action-columns table');
      for (const width of [1920, 1440, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        const result = await assertFits(mixed, tableCell, 'shared table ' + width);
        assert.deepEqual(result.controls, [1, 5]);
        assert(result.width > single.width);
      }
      await toggleDesignTheme(page);
      await assertFits(mixed, tableCell, 'shared table dark');
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const actions = mixed.locator('tr[data-row-id="b"] .table-actions');
        const wrapped = await actions.evaluate(cell => {
          const bounds = cell.getBoundingClientRect();
          const controls = [...cell.querySelectorAll('button:not([hidden])')].map(button => button.getBoundingClientRect());
          return new Set(controls.map(control => control.top)).size > 1 &&
            controls.every(control => control.left >= bounds.left - 1 && control.right <= bounds.right + 1 && control.height >= 44);
        });
        assert(wrapped, 'mobile actions wrap with usable touch targets at ' + width);
      }
    } finally { await context.close(); }
  });

  await t.test('mailbox authorization rows and their overflow menu', async () => {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    try {
      const pending = { id: 'waiting', email: 'waiting@example.test', provider: 'microsoft', authorizationPending: true };
      const active = { id: 'ready', email: 'ready@example.test', provider: 'google', active: true,
        label: '很长的合成备注'.repeat(25), expiresAt: '2099-01-01T00:00:00Z' };
      await interceptDesign(context, { actor, localFixtures: {}, skipRechargeAssets: true });
      await context.route('**/api/local/tools/mailbox-pool', route => route.fulfill({ json: route.request().method() === 'GET'
        ? { version: 1, defaultValidDays: 30, items: [pending, active] }
        : { version: 1, items: [{ id: active.id, code: 'SYNTHETIC-LONG-MAILBOX-CODE' }] } }));
      const page = await context.newPage();
      page.setDefaultTimeout(6000);
      await page.goto(origin + '/#/plugins/mailboxes');
      const pool = page.locator('.mailbox-pool-table');
      const more = pool.getByRole('button', { name: '更多操作：' + active.email, exact: true });
      await more.waitFor();
      const all = await assertFits(pool, tableCell, 'mixed mailbox pool');
      assert.deepEqual(all.controls.toSorted((left, right) => left - right), [1, 2]);
      await more.click();
      const menu = page.getByRole('menu', { name: '邮箱操作', exact: true });
      await menu.waitFor();
      assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['更新授权', '重置查询码', '停用']);
      assert.equal((await geometry(pool)).width, all.width);
      await more.press('Escape');
      await page.locator('#ops-mailbox-pool-search').fill(pending.email);
      await more.waitFor({ state: 'detached' });
      const filtered = await assertFits(pool, tableCell, 'mailbox pending authorization');
      assert.deepEqual(filtered.controls, [1]);
      assert(filtered.width < all.width);
    } finally { await context.close(); }
  });

  await t.test('embedded recharge task and manual review tables', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      await interceptDesign(context, { localFixtures: {} });
      const task = { id: 'fixture-task', jobKey: 'fixture-task', cdk: 'KC-FIXTURE', token: 'test@example.test',
        time: '2026-11-12 14:36:47', status: 'failed', progress: 20, message: '合成任务资料'.repeat(35) };
      await context.route('**/integrations/codexdaichong/api/admin/**', route => {
        const resource = new URL(route.request().url()).pathname.split('/').at(-1);
        if (resource === 'task-logs') return route.fulfill({ json: { tasks: [task] } });
        if (resource === 'activation-manual-holds') return route.fulfill({ json: { success: true, holds: [{
          id: 1, accountEmail: 'test@example.test', reason: task.message, failedJobKey: task.jobKey, cdkCode: task.cdk
        }] } });
        if (resource === 'sessions') return route.fulfill({ json: { items: [{
          job_key: task.jobKey, cdk_code: task.cdk, token_preview: task.token, message: task.message,
          status: task.status, time: task.time, has_session: true
        }], total: 1 } });
        return route.fallback();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(6000);
      await page.goto(origin + '/#/online-recharge/chatgpt');
      const frame = page.frameLocator('#main iframe[data-view-group="admin"]:not([hidden])');
      await page.locator('button[data-view="logs"]').click();
      const tasks = frame.locator('.task-records-table');
      await tasks.locator('tbody td:last-child button').first().waitFor();
      await assertFits(tasks, nativeCell, 'embedded recharge tasks');
      await frame.getByRole('tab', { name: '待人工确认', exact: true }).click();
      const review = frame.locator('.manual-holds-table');
      await review.locator('tbody td:last-child button').first().waitFor();
      await assertFits(review, nativeCell, 'embedded manual review');
      await page.setViewportSize({ width: 390, height: 900 });
      await settle(page);
      await assertFits(review, nativeCell, 'mobile embedded manual review');
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('button[data-view="sessions"]').click();
      const sessions = frame.locator('.session-table');
      await sessions.locator('tbody td:last-child button').first().waitFor();
      assert((await assertFits(sessions, nativeCell, 'embedded Session records')).controls[0] >= 2);
    } finally { await context.close(); }
  });

  await t.test('issued recharge code actions fit on one line in the table and cards', async () => {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
    try {
      await interceptDesign(context, { actor: codeOwner, localFixtures: {}, skipRechargeAssets: true });
      const handler = setup().start();
      await context.route(origin + '/api/local/recharge-codes*', async route => {
        const { status, ...json } = await call(handler, undefined, codeOwner, new URL(route.request().url()).search);
        return route.fulfill({ status, json });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(6000);
      await page.goto(origin + '/#/workspace/recharge-codes');
      const table = page.locator('table[data-table="my-recharge-codes"]');
      const verifyRows = async (list, width) => {
        const groups = list.locator('td.table-actions > .recharge-record-actions');
        await groups.first().waitFor();
        const rows = await groups.evaluateAll(groups => groups.map(group => {
          const cell = group.parentElement.getBoundingClientRect();
          const viewport = group.closest('.table-viewport').getBoundingClientRect();
          const buttons = [...group.querySelectorAll('button')].map(button => button.getBoundingClientRect());
          const center = box => box.top + box.height / 2;
          return {
            count: buttons.length,
            aligned: buttons.every(box => Math.abs(center(box) - center(buttons[0])) <= 1),
            contained: buttons.every(box => box.left >= Math.max(cell.left, viewport.left) - 1 &&
              box.right <= Math.min(cell.right, viewport.right) + 1),
            touchTargets: buttons.every(box => box.height >= 44)
          };
        }));
        assert(rows.some(row => row.count === 3), '应覆盖复制、详情及归还同时显示');
        assert(rows.every(row => row.aligned && row.contained && (width > 900 || row.touchTargets)),
          `${width}px 充值码操作应同排且完整可见 ${JSON.stringify(rows)}`);
      };
      for (const [width, dark] of [[1920, false], [1440, true], [901, false], [390, true], [320, false]]) {
        await page.setViewportSize({ width, height: 1000 });
        if (dark !== await page.locator('html').evaluate(node => node.dataset.theme === 'dark'))
          await toggleDesignTheme(page);
        await settle(page);
        await verifyRows(table, width);
        if (width === 1920) await assertFits(table, tableCell, 'issued recharge codes');
      }
      await page.getByRole('button', { name: '批次明细', exact: true }).click();
      await verifyRows(page.locator('#drawer[open] .recharge-batch-detail'), 320);
    } finally { await context.close(); }
  });
});
