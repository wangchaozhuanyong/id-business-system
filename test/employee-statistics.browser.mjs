import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createEmployeeStatisticsHandler, employeeStatisticsRoute } from '../server/employee-statistics.mjs';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const route = 'data-management/employee-statistics';
const manager = { id: 'manager', name: '测试管理员', role: 'admin', active: true };
const operator = { id: 'operator', name: '测试员工', role: 'employee', active: true };
const prior = { id: 'former', name: '历史员工', role: 'employee', active: false };
const now = Date.parse('2026-11-09T04:00:00Z');
const today = '2026-11-09 10:00';
const yesterday = '2026-11-08 10:00';
const sampleCode = 'KC-' + 'A'.repeat(28);
const fixtures = {
  commerce: {
    orders: Array.from({ length: 14 }, (_, index) => ({
      id: 'order-' + index, orderNo: 'ORDER-' + index, createdById: operator.id,
      createdAt: index === 13 ? yesterday : today, email: 'private@example.test'
    })),
    customers: [{ id: 'customer-one', createdById: operator.id, createdAt: today }]
  },
  inventory: {
    mailboxes: [{ id: 'mail-one', createdById: operator.id, createdAt: today, email: 'private@example.test',
      password: 'fixture-only-password', claimBatchId: 'mail-batch', claimId: 'mail-claim' }],
    accounts: [{ id: 'account-one', createdById: operator.id, createdAt: today, email: 'account@example.test',
      claimBatchId: 'account-batch', claimId: 'account-claim' }],
    batches: [
      { id: 'mail-batch', kind: 'mail', actorId: prior.id, actorName: prior.name, time: yesterday,
        items: [{ id: 'mail-claim', assetId: 'mail-one', claimedAt: yesterday, status: 'pending' }] },
      { id: 'account-batch', kind: 'account', actorId: operator.id, time: today,
        items: [{ id: 'account-claim', assetId: 'account-one', claimedAt: today, status: 'pending' }] }
    ]
  },
  'recharge-codes': { requests: [{ id: 'code-batch', applicantId: operator.id, plan: 'plus', status: 'issued',
    issuedAt: '2026-11-08T02:00:00Z', codes: [sampleCode] }] }
};

async function install(page, actor) {
  await interceptDesign(page.context(), { actor, localFixtures: { 'auth/session': { actor } } });
  const controls = { requests: 0, codeUnavailable: false, httpError: false };
  const handler = createEmployeeStatisticsHandler({
    clock: () => now, publicOrigin: origin, readEmployees: () => [manager, operator],
    store: { load: key => ({ data: fixtures[key] }), featureDocument: key => ({ data: fixtures[key] }) },
    client: {
      listCodes() {
        if (controls.codeUnavailable) throw new Error('synthetic unavailable');
        return [{ code: sampleCode, plan_type: 'plus', type: '自助', status: 'unused', shipped: false }];
      }
    }
  });
  await page.route('**/api/local/employee-statistics?*', async intercepted => {
    controls.requests++;
    if (controls.httpError) return intercepted.fulfill({ status: 503, json: { error: '暂时不可读' } });
    const request = intercepted.request();
    assert.equal(new URL(request.url()).pathname, employeeStatisticsRoute);
    const result = {};
    await handler({ url: request.url(), method: request.method(), headers: request.headers() }, {
      writeHead(status, headers) { Object.assign(result, { status, headers }); },
      end(body) { result.body = body; }
    }, actor);
    assert(!result.body.includes(sampleCode));
    assert(!result.body.includes('fixture-only-password'));
    await intercepted.fulfill(result);
  });
  return controls;
}

test('员工统计从数据管理进入，工作量、当前资产与权限独立显示', { timeout: 100_000 }, async t => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const width of [1440, 1024, 901, 900, 768, 390]) for (const dark of [false, true]) {
    await t.test(width + (dark ? ' 深色' : ' 浅色'), async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(6000);
      try {
        const controls = await install(page, manager);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/#/mailboxes/google');
        if (dark) await page.locator('#theme-toggle').click();
        if (width <= 900) await page.locator('#nav-toggle').click();
        const group = page.locator('#sidebar .nav-group:has(> [data-group="数据管理"])');
        await group.getByRole('button', { name: '数据管理', exact: true }).click();
        await group.getByRole('link', { name: '银行卡管理', exact: true }).waitFor();
        await group.getByRole('link', { name: 'Claude 谷歌订阅管理', exact: true }).waitFor();
        await group.getByRole('link', { name: '员工数据统计', exact: true }).click();
        await page.getByRole('heading', { name: '员工数据统计', exact: true }).waitFor();
        const statistics = page.locator('#employee-statistics');
        const employee = statistics.getByRole('combobox', { name: '员工', exact: true });
        const orderCount = statistics.getByRole('button', { name: '查看测试员工的提交订单明细' });
        await orderCount.waitFor();
        assert.equal(await orderCount.textContent(), '13');
        assert(await statistics.evaluate(panel => {
          const bounds = panel.getBoundingClientRect();
          const controls = [...panel.querySelectorAll('.toolbar input, .toolbar select, .toolbar button')]
            .map(control => control.getBoundingClientRect());
          const textFits = [...panel.querySelectorAll('th')].every(heading => {
            const range = document.createRange();
            range.selectNodeContents(heading);
            const text = range.getBoundingClientRect();
            const cell = heading.getBoundingClientRect();
            return text.left >= cell.left && text.right <= cell.right && text.bottom <= cell.bottom;
          });
          return textFits && controls.every(control => control.left >= bounds.left && control.right <= bounds.right);
        }), '统计表头文字或筛选控件超出边界');
        await employee.selectOption(operator.id);
        assert.equal(await statistics.locator('tbody tr').count(), 1);
        await orderCount.press('Enter');
        const details = page.locator('#employee-statistics-detail');
        await details.getByText('p***@example.test', { exact: true }).first().waitFor();
        assert.equal(await details.locator('tbody tr').count(), 10);
        await details.getByRole('button', { name: '下一页' }).click();
        await page.waitForFunction(() => document.querySelector('#employee-statistics-detail nav[data-pagination]').dataset.page === '2');
        assert.equal(await details.locator('tbody tr').count(), 3);
        await page.getByRole('button', { name: '关闭抽屉' }).click();
        await statistics.getByLabel('统计日期').fill('2026-11-08');
        await statistics.getByText('2026-11-08 · 北京时间', { exact: false }).waitFor();
        assert.equal(await orderCount.textContent(), '1');
        await statistics.getByRole('button', { name: '今天', exact: true }).click();
        await statistics.getByText('2026-11-09 · 北京时间', { exact: false }).waitFor();
        await statistics.getByRole('combobox', { name: '业务类型' }).selectOption('mail');
        await statistics.getByRole('columnheader', { name: '邮箱提交', exact: true }).waitFor();
        assert.equal(await statistics.getByRole('columnheader', { name: '提交订单', exact: true }).count(), 0);
        await statistics.getByRole('button', { name: '待处理资产' }).click();
        const unused = statistics.getByRole('button', { name: '查看测试员工的未用未还充值码明细' });
        await unused.waitFor();
        assert.equal(await unused.textContent(), '1');
        await employee.selectOption('');
        await statistics.getByRole('checkbox', { name: '只看异常' }).check();
        assert.equal(await statistics.locator('tbody tr').count(), 2);
        await employee.selectOption(manager.id);
        await statistics.getByRole('heading', { name: '暂无符合条件的待处理资产' }).waitFor();
        await employee.selectOption(operator.id);
        if (width === 1440 && !dark) {
          controls.codeUnavailable = true;
          await statistics.getByRole('button', { name: '刷新', exact: true }).click();
          await statistics.getByText('代充码池暂不可读', { exact: false }).waitFor();
          assert.equal(await statistics.locator('[data-column="unusedCodes"]').textContent(), '待核对');
          controls.codeUnavailable = false;
          controls.httpError = true;
          await statistics.getByRole('button', { name: '刷新', exact: true }).click();
          await statistics.getByText('刷新失败，已保留上次统计。', { exact: true }).waitFor();
          assert.equal(await statistics.locator('tbody tr').count(), 1);
          controls.httpError = false;
          await statistics.getByRole('button', { name: '刷新', exact: true }).click();
          await unused.waitFor();
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
  await t.test('普通员工通过直达地址也不能读取', async () => {
    const page = await browser.newPage();
    try {
      const controls = await install(page, operator);
      await page.goto(origin + '/#/' + route);
      await page.getByRole('heading', { name: '访问受限', exact: true }).waitFor();
      assert.equal(await page.locator('#sidebar a[href="#/' + route + '"]').count(), 0);
      assert.equal(controls.requests, 0);
    } finally { await page.close(); }
  });
});
