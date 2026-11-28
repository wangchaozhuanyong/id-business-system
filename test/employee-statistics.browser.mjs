import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createEmployeeStatisticsHandler, employeeStatisticsRoute } from '../server/employee-statistics.mjs';
import { toggleDesignTheme, interceptDesign, origin, separatorSnapshot } from './helpers/offline-design.mjs';
import { mkdir } from 'node:fs/promises';

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
  await interceptDesign(page.context(), { actor, localFixtures: { 'auth/session': { actor } }, skipRechargeAssets: true,
    scrollbarSelector: '.employee-statistics-scroll' });
  const controls = { requests: 0, queries: [], now, codeUnavailable: false, httpError: false };
  const handler = createEmployeeStatisticsHandler({
    clock: () => controls.now, publicOrigin: origin, readEmployees: () => [manager, operator],
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
    const dates = new URL(intercepted.request().url()).searchParams;
    controls.queries.push(dates.has('from') ? dates.get('from') + '/' + dates.get('to') : dates.get('date'));
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

function dateControls(statistics) {
  const group = statistics.locator('[data-date-filter="employee-statistics-period"]');
  const compact = group.locator('[data-date-select]');
  const action = value => group.locator(`[data-date-choice="${value}"]`);
  return {
    group,
    async choose(value, keyboard = false) {
      if (await compact.isVisible()) await compact.selectOption(value);
      else if (keyboard) await action(value).press('Enter');
      else await action(value).click();
    },
    async selected(value) {
      return await compact.isVisible() ? await compact.inputValue() === value :
        await action(value === 'custom' ? 'choose-custom' : value).getAttribute('aria-pressed') === 'true';
    }
  };
}

async function enterDateRange(page, from, to) {
  const drawer = page.getByRole('dialog', { name: '选择统计日期' });
  await drawer.getByLabel('开始日期', { exact: true }).fill(from);
  await drawer.getByLabel('结束日期', { exact: true }).fill(to);
  await drawer.getByRole('button', { name: '应用日期', exact: true }).press('Enter');
}

test('员工统计从数据管理进入，工作量、当前资产与权限独立显示', { timeout: 100_000 }, async t => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL, ignoreDefaultArgs: ['--hide-scrollbars'] });
  t.after(() => browser.close());
  for (const width of [2062, 1440, 1024, 901, 900, 768, 390, 320]) for (const dark of [false, true]) {
    await t.test(width + (dark ? ' 深色' : ' 浅色'), async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(6000);
      try {
        const controls = await install(page, manager);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/#/mailboxes/google');
        if (dark) await toggleDesignTheme(page);
        if (width <= 900) await page.locator('#nav-toggle').click();
        const group = page.locator('#sidebar .nav-group:has(> [data-group="数据管理"])');
        await group.getByRole('button', { name: '数据管理', exact: true }).click();
        await group.getByRole('link', { name: '员工数据统计', exact: true }).click();
        await page.getByRole('heading', { name: '员工数据统计', exact: true }).waitFor();
        const statistics = page.locator('#employee-statistics');
        const dateLoaded = date => statistics.locator(`[data-statistics-date="${date}"]`).waitFor();
        const header = label => statistics.locator('.employee-statistics-details thead th').getByText(label, { exact: true });
        const employee = statistics.getByRole('combobox', { name: '员工', exact: true });
        const orderCount = statistics.getByRole('button', { name: '查看测试员工的提交订单明细', exact: true });
        await statistics.getByRole('button', { name: '展开明细', exact: true }).click();
        await orderCount.waitFor();
        assert.equal(await orderCount.textContent(), '13');
        const toolbar = statistics.getByRole('group', { name: '员工统计筛选', exact: true });
        const shortcuts = dateControls(statistics);
        assert(await shortcuts.selected('today'));
        const geometry = await toolbar.evaluate(node => {
          const bounds = node.getBoundingClientRect();
          const heading = node.closest('.employee-statistics-header');
          const row = heading.getBoundingClientRect();
          const refresh = heading.querySelector('[data-action="employee-statistics-refresh"]').getBoundingClientRect();
          const centers = [...heading.querySelectorAll('.tabs > .tab, .toolbar input, .toolbar select, .toolbar button, .employee-statistics-scope'),
            heading.querySelector('[data-action="employee-statistics-refresh"]')].filter(control => control.checkVisibility()).map(control => {
            const box = control.getBoundingClientRect();
            return (box.top + box.bottom) / 2;
          });
          const controls = [...node.querySelectorAll('input, select, button')].filter(control => control.checkVisibility()).map(control => {
            const rect = control.getBoundingClientRect();
            return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
          });
          const paired = [...node.querySelectorAll('.toolbar-select-filters select')].map(control => control.getBoundingClientRect().top);
          return { controls, top: bounds.top, bottom: bounds.bottom,
            scrollbar: heading.querySelector('.employee-statistics-scroll').offsetHeight - heading.querySelector('.employee-statistics-scroll').clientHeight,
            scrollportWidth: heading.querySelector('.employee-statistics-scroll').clientWidth,
            scrollWidth: heading.querySelector('.employee-statistics-scroll').scrollWidth,
            centerDeviation: Math.max(...centers) - Math.min(...centers),
            refreshVisible: refresh.left >= row.left && refresh.right <= row.right && refresh.right <= innerWidth,
            refreshInsets: [refresh.top - row.top, row.bottom - refresh.bottom], paired };
        });
        const [dateBox] = geometry.controls;
        assert(dateBox.width > 0, '日期选择器应可见');
        assert(geometry.controls.every(box => box.y - geometry.top >= 8 && geometry.bottom - box.bottom >= 8), '筛选控件贴边');
        assert(geometry.controls.every(box => box.height >= (width <= 900 ? 44 : 36)), '控件触控高度不足');
        if (width <= 900) assert(geometry.scrollWidth <= geometry.scrollportWidth + 1, '手机筛选全部可见');
        else assert(geometry.centerDeviation <= 1, '页签、筛选、数据时间和刷新必须同排居中');
        if (geometry.scrollWidth > geometry.scrollportWidth + 1)
          assert(geometry.scrollbar >= 10, '实际需要横滑时应覆盖占用布局高度的滚动条');
        assert(geometry.scrollportWidth >= 140, '单行滚动区必须保留可见的操作空间');
        assert(geometry.refreshVisible && geometry.refreshInsets.every(value => value >= 8), '刷新必须始终可见且与分隔线保持间距');
        for (let i = 0; i < geometry.controls.length; i++) for (let j = i + 1; j < geometry.controls.length; j++) {
          const a = geometry.controls[i], b = geometry.controls[j];
          assert(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y, '筛选控件重叠');
        }
        if (width >= 1440) assert(geometry.controls.every(box => Math.abs(box.y - dateBox.y) <= 1), '宽屏筛选必须完整同排');
        if (width >= 390) assert.equal(geometry.paired[0], geometry.paired[1], '员工与业务筛选应成组排列');
        else assert(geometry.paired[1] >= geometry.paired[0], '窄屏保持筛选顺序');
        if (process.env.ID_LAYOUT_QA_OUTPUT && [2062, 1440, 390, 320].includes(width)) {
          await mkdir(process.env.ID_LAYOUT_QA_OUTPUT, { recursive: true });
          await page.screenshot({ path: `${process.env.ID_LAYOUT_QA_OUTPUT}/employee-statistics-${width}-${dark ? 'dark' : 'light'}.png` });
          await statistics.locator('.employee-statistics-header').screenshot({ path: `${process.env.ID_LAYOUT_QA_OUTPUT}/toolbar-${width}-${dark ? 'dark' : 'light'}.png` });
        }
        assert(await statistics.evaluate(panel => {
          const scroll = panel.querySelector('.employee-statistics-scroll');
          const bounds = scroll.getBoundingClientRect();
          const controls = [...panel.querySelectorAll('.toolbar input, .toolbar select, .toolbar button')].filter(control => control.checkVisibility())
            .map(control => control.getBoundingClientRect());
          const textFits = [...panel.querySelectorAll('th')].every(heading => {
            const range = document.createRange();
            range.selectNodeContents(heading);
            const text = range.getBoundingClientRect();
            const cell = heading.getBoundingClientRect();
            return !text.width || (text.left >= cell.left - 1 && text.right <= cell.right + 1 && text.bottom <= cell.bottom + 1);
          });
          return textFits && controls.every(control => control.left + scroll.scrollLeft >= bounds.left - 1 &&
            control.right + scroll.scrollLeft <= bounds.left + scroll.scrollWidth + 1);
        }), '统计表头文字或筛选控件超出可滚动范围');
        const scroll = statistics.locator('.employee-statistics-scroll');
        const previousScroll = await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth; return node.scrollLeft; });
        await employee.selectOption(operator.id);
        assert.equal(await statistics.locator('.employee-statistics-details tbody tr').count(), 1);
        assert.equal(await scroll.evaluate(node => node.scrollLeft), previousScroll, '筛选重绘应保留横向位置');
        await orderCount.press('Enter');
        const details = page.locator('#employee-statistics-detail');
        const firstDetail = details.locator('tbody tr[data-row-id]').first();
        await firstDetail.waitFor();
        const account = firstDetail.getByText('p***@example.test', { exact: true });
        if (!(await account.isVisible())) await firstDetail.getByRole('button', { name: '更多资料', exact: true }).click();
        await account.waitFor();
        assert.equal(await details.locator('nav[data-pagination]').getAttribute('data-page-size'), '20');
        assert.equal(await details.locator('tbody tr').count(), 13);
        await details.getByLabel('每页条数').selectOption('10');
        await details.locator('nav[data-pagination][data-page-size="10"]').waitFor();
        assert.equal(await details.locator('tbody tr').count(), 10);
        await details.getByRole('button', { name: '下一页' }).click();
        await page.waitForFunction(() => document.querySelector('#employee-statistics-detail nav[data-pagination]').dataset.page === '2');
        assert.equal(await details.locator('tbody tr').count(), 3);
        await page.getByRole('button', { name: '关闭抽屉' }).click();
        await shortcuts.choose('yesterday');
        await dateLoaded('2026-11-08');
        assert(await shortcuts.selected('yesterday'));
        assert.equal(await orderCount.textContent(), '1');
        await shortcuts.choose('three', true);
        await statistics.locator('[data-statistics-date="2026-11-07"][data-statistics-to="2026-11-09"]').waitFor();
        assert(await shortcuts.selected('three'));
        assert.equal(await employee.inputValue(), operator.id);
        assert.equal(await orderCount.textContent(), '14');
        await shortcuts.choose('choose-custom', true);
        await enterDateRange(page, '2026-09-06', '2026-09-06');
        await dateLoaded('2026-09-06');
        assert(await shortcuts.selected('custom'));
        assert.deepEqual(controls.queries.slice(-3), ['2026-11-08', '2026-11-07/2026-11-09', '2026-09-06']);
        await shortcuts.choose('today');
        await dateLoaded('2026-11-09');
        await statistics.getByRole('combobox', { name: '业务类型' }).selectOption('mail');
        await header('邮箱提交').waitFor({ state: 'attached' });
        assert.equal(await header('提交订单').count(), 0);
        await statistics.getByRole('button', { name: '待处理资产' }).click();
        assert.equal(await shortcuts.group.count(), 0, '待处理资产不使用历史日期筛选');
        const unused = statistics.getByRole('button', { name: '查看测试员工的未用未还充值码明细', exact: true });
        await statistics.getByRole('button', { name: '展开明细', exact: true }).click();
        await unused.waitFor();
        assert.equal(await unused.textContent(), '1');
        await employee.selectOption('');
        const kinds = toolbar.getByRole('group', { name: '业务类型', exact: true });
        assert.equal(await toolbar.getByRole('combobox', { name: '业务类型' }).count(), 0);
        assert.deepEqual(await kinds.getByRole('button').allTextContents(), ['全部业务', '充值码', '邮箱', '账号']);
        assert.equal(await kinds.getByRole('button', { name: '全部业务', exact: true }).getAttribute('aria-pressed'), 'true');
        const pendingGeometry = await toolbar.evaluate(node => {
          const bounds = node.getBoundingClientRect();
          const controls = [...node.querySelectorAll('select, button, .checkbox-label')].map(control => {
            const rect = control.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, center: (rect.top + rect.bottom) / 2 };
          });
          return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, controls };
        });
        assert(pendingGeometry.controls.every(box => box.left >= pendingGeometry.left && box.right <= pendingGeometry.right &&
          box.top - pendingGeometry.top >= 8 && pendingGeometry.bottom - box.bottom >= 8), '待处理资产筛选越界或贴边');
        if (width >= 1024)
          assert(pendingGeometry.controls.every(box => Math.abs(box.center - pendingGeometry.controls[0].center) <= 1), '待处理资产筛选应完整同排');
        for (let i = 0; i < pendingGeometry.controls.length; i++) for (let j = i + 1; j < pendingGeometry.controls.length; j++) {
          const a = pendingGeometry.controls[i], b = pendingGeometry.controls[j];
          assert(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, '待处理资产筛选控件重叠');
        }
        if (process.env.ID_LAYOUT_QA_OUTPUT && [1440, 390, 320].includes(width)) {
          await statistics.locator('.employee-statistics-header').screenshot({ path: `${process.env.ID_LAYOUT_QA_OUTPUT}/pending-toolbar-${width}-${dark ? 'dark' : 'light'}.png` });
        }
        for (const [label, column, excluded] of [
          ['充值码', '未用未还充值码', '未结邮箱'],
          ['邮箱', '未结邮箱', '未结账号'],
          ['账号', '未结账号', '未用未还充值码'],
          ['全部业务', '未用未还充值码', '提交订单']
        ]) {
          await kinds.getByRole('button', { name: label, exact: true }).press('Enter');
          await header(column).waitFor({ state: 'attached' });
          assert.equal(await header(excluded).count(), 0);
          assert.equal(await kinds.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'), 'true');
          assert.equal(await kinds.locator('[aria-pressed="true"]').count(), 1);
        }
        await statistics.getByRole('checkbox', { name: '只看异常' }).check();
        assert.equal(await statistics.locator('.employee-statistics-details tbody tr').count(), 2);
        await kinds.getByRole('button', { name: '账号', exact: true }).click();
        await statistics.getByRole('heading', { name: '暂无符合条件的待处理资产' }).waitFor();
        assert(await statistics.getByRole('checkbox', { name: '只看异常' }).isChecked());
        await employee.selectOption(operator.id);
        await statistics.getByRole('button', { name: '工作量', exact: true }).click();
        await dateLoaded('2026-11-09');
        assert.equal(await statistics.getByRole('combobox', { name: '业务类型' }).inputValue(), 'mail');
        await statistics.getByRole('button', { name: '待处理资产', exact: true }).click();
        await statistics.getByRole('heading', { name: '暂无符合条件的待处理资产' }).waitFor();
        assert.equal(await kinds.getByRole('button', { name: '账号', exact: true }).getAttribute('aria-pressed'), 'true');
        assert.equal(await employee.inputValue(), operator.id);
        assert(await statistics.getByRole('checkbox', { name: '只看异常' }).isChecked());
        await kinds.getByRole('button', { name: '全部业务', exact: true }).click();
        await unused.waitFor();
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
          assert.equal(await statistics.locator('.employee-statistics-details tbody tr').count(), 1);
          controls.httpError = false;
          await statistics.getByRole('button', { name: '刷新', exact: true }).click();
          await unused.waitFor();
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.deepEqual((await separatorSnapshot(page)).findings, []);
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
  await t.test('快捷日期使用服务端北京时间，跨年、跨月和闰年正确且保留筛选', async () => {
    for (const timezoneId of ['America/Los_Angeles', 'Pacific/Auckland']) {
      for (const [date, yesterday, beforeYesterday] of [
        ['2027-01-01', '2026-12-31', '2026-12-30'],
        ['2028-03-01', '2028-02-29', '2028-02-28'],
        ['2026-03-01', '2026-02-28', '2026-02-27']
      ]) {
        const page = await browser.newPage({ timezoneId });
        page.setDefaultTimeout(6000);
        try {
          const controls = await install(page, manager);
          controls.now = Date.parse(date + 'T00:30:00+08:00');
          await page.goto(origin + '/#/' + route);
          const statistics = page.locator('#employee-statistics');
          const dateLoaded = value => statistics.locator(`[data-statistics-date="${value}"]`).waitFor();
          const shortcuts = dateControls(statistics);
          await dateLoaded(date);
          assert(await shortcuts.selected('today'));
          await statistics.getByRole('combobox', { name: '员工', exact: true }).selectOption(operator.id);
          await statistics.getByRole('combobox', { name: '业务类型' }).selectOption('mail');
          await shortcuts.choose('yesterday');
          await dateLoaded(yesterday);
          assert(await shortcuts.selected('yesterday'));
          await shortcuts.choose('three');
          const rangeLoaded = () => statistics.locator(`[data-statistics-date="${beforeYesterday}"][data-statistics-to="${date}"]`).waitFor();
          await rangeLoaded();
          await statistics.getByRole('button', { name: '待处理资产', exact: true }).click();
          await statistics.getByText('当前资产截至', { exact: false }).waitFor();
          await statistics.getByRole('button', { name: '工作量', exact: true }).click();
          await rangeLoaded();
          await page.evaluate(() => { location.hash = '#/overview'; });
          await page.locator('#main[data-layout-route="overview"]').waitFor();
          await page.evaluate(route => { location.hash = '#/' + route; }, route);
          await rangeLoaded();
          assert.equal(await statistics.getByRole('combobox', { name: '员工', exact: true }).inputValue(), operator.id);
          assert.equal(await statistics.getByRole('combobox', { name: '业务类型' }).inputValue(), 'mail');
          assert(await shortcuts.selected('three'));
          await shortcuts.choose('choose-custom');
          assert.equal(await page.getByLabel('结束日期', { exact: true }).getAttribute('max'), date);
          await page.keyboard.press('Escape');
          assert(await shortcuts.selected('three'));
          await shortcuts.choose('today');
          await dateLoaded(date);
          assert(await shortcuts.selected('today'));
        } finally { await page.close(); }
      }
    }
  });
});
