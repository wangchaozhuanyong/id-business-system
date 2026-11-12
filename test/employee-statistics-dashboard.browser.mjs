import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

const route = 'data-management/employee-statistics';
const actor = { id: 'dashboard-test-admin', name: '测试管理员', role: 'admin', active: true };
// Isolated browser fixtures; these records are never sent to a business server.
const longName = '测试员工超长姓名及部门说明ABCDEFGHIJKLMN';
const people = Array.from({ length: 26 }, (_, i) => ({
  id: 'employee-' + i, name: i ? '测试员工 ' + (i + 1) : longName, active: i === 25 ? null : true,
  counts: { orders: 26 - i, issuedCodes: 2 * i + 5, cancelledOrders: 1, customers: 1, unusedCodes: i + 1, openMail: 1, overdue: 1 }
}));
const items = [...people,
  { id: 'empty-employee', name: '暂无记录员工', active: true, counts: {} },
  { id: 'system', name: '系统自动同步', active: null, counts: { syncedOrders: 7 } },
  { id: 'unattributed', name: '归属未记录', active: null, counts: { orders: 3 } }
];

async function install(page) {
  await interceptDesign(page.context(), { actor, localFixtures: { 'auth/session': { actor } }, skipRechargeAssets: true });
  const controls = { items: [...items].reverse(), requests: [], unavailable: false };
  await page.route('**/api/local/employee-statistics?*', async request => {
    const query = new URL(request.request().url()).searchParams;
    controls.requests.push(Object.fromEntries(query));
    assert.equal(request.request().method(), 'GET');
    const meta = { today: '2026-11-12', date: query.get('date') || '2026-11-12',
      asOf: '2026-11-12T09:12:00Z', codeSourceAvailable: !controls.unavailable };
    await request.fulfill({ json: query.has('metric') ? { ...meta, page: 1, pageSize: 20, total: 1,
      items: [{ id: 'fixture-record', kind: 'order', reference: 'TEST-READ-ONLY', subject: 't***@example.test', status: '已提交' }] }
      : { ...meta, items: controls.items } });
  });
  await page.goto(origin + '/#/' + route);
  await page.locator('[data-employee-total="orders"] strong').waitFor();
  await settle(page);
  return controls;
}

async function geometry(page) {
  await settle(page);
  return page.locator('#employee-statistics').evaluate(panel => {
    const region = panel.querySelector('.employee-statistics-distribution');
    const scroller = region.querySelector('.employee-statistics-chart-scroll');
    const series = [...region.querySelectorAll('[data-employee-series]')];
    const bars = series.map(chart => [...chart.querySelectorAll('.employee-statistics-column')]);
    const twoColumns = getComputedStyle(region).gridTemplateColumns.split(' ').length === 2;
    const columnOffset = bars[0].map((bar, i) => Math.abs(bar.getBoundingClientRect().left - bars[1][i].getBoundingClientRect().left));
    const clipped = [...region.querySelectorAll('td, th, .employee-statistics-column-name, .employee-statistics-column-value')].filter(node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const text = range.getBoundingClientRect(), box = node.getBoundingClientRect();
      return text.width && (text.left < box.left - 1 || text.right > box.right + 1 || text.bottom > box.bottom + 1);
    }).map(node => node.textContent);
    const heading = panel.querySelector('.employee-statistics-section-heading').getBoundingClientRect();
    const controls = [...panel.querySelectorAll('.employee-statistics-chart-controls button, .employee-statistics-chart-controls select')]
      .map(node => { const box = node.getBoundingClientRect(); return { top: box.top - heading.top, bottom: heading.bottom - box.bottom }; });
    return { twoColumns, columnOffset, clipped, controls, regionHeight: region.getBoundingClientRect().height,
      rows: region.querySelectorAll('table[aria-label="员工数量速查"] tbody tr').length,
      proportions: [...region.querySelectorAll('.employee-statistics-column-slot')].map(node => ({
        expected: Number(node.dataset.employeePosition),
        actual: node.firstElementChild.getBoundingClientRect().height * 100 / node.getBoundingClientRect().height
      })),
      touch: [...region.querySelectorAll('button')].map(node => ({
        width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height
      })),
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      regionOverflow: region.scrollWidth > region.clientWidth + 1,
      chartScroll: scroller.scrollWidth > scroller.clientWidth + 1,
      barPaint: getComputedStyle(bars[0][0].querySelector('.employee-statistics-column-fill')).backgroundColor };
  });
}

test('双图和速查使用同一顺序、完整合计及独立分页', { timeout: 50_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const controls = await install(page);
  const panel = page.locator('#employee-statistics');
  const details = panel.locator('.employee-statistics-details');
  const series = key => panel.locator(`[data-employee-series="${key}"] .employee-statistics-column`);
  const total = key => panel.locator(`[data-employee-total="${key}"] strong`);
  const quick = panel.getByRole('table', { name: '员工数量速查', exact: true });
  const chartPager = panel.locator('[data-pagination="employee-statistics-chart"]');
  const listed = locator => locator.evaluateAll(nodes => nodes.map(node => node.dataset.employee));
  const checked = id => panel.locator(`.employee-statistics-column[data-employee="${id}"][aria-pressed="true"]`);
  const initialHeight = (await geometry(page)).regionHeight;
  assert.equal(await total('orders').textContent(), '354');
  assert.equal(await total('issuedCodes').textContent(), '780');
  assert.deepEqual(await listed(series('orders')), await listed(series('issuedCodes')));
  assert.equal(await series('orders').count(), 20);
  assert.equal(await quick.locator('tbody tr').count(), 10);
  assert.equal(await checked('employee-0').count(), 2);
  assert.equal(await panel.getByRole('table', { name: '系统与归属待核对' }).locator('tbody tr').count(), 2);
  assert.equal(await details.locator('table').count(), 0, '业务明细默认收起');

  const reads = controls.requests.length;
  await series('issuedCodes').nth(3).click();
  assert.equal(await checked('employee-3').count(), 2);
  assert.equal(await quick.locator('[data-employee-quick-cell="employee-3"][data-selected]').count(), 3);
  await series('issuedCodes').nth(3).press('ArrowRight');
  assert.equal(await checked('employee-4').count(), 2);
  await quick.getByRole('button', { name: '选择' + longName, exact: true }).press('Enter');
  assert.equal(await checked('employee-0').count(), 2);
  assert.match(await panel.locator('[data-employee-selected]').textContent(), /26 笔/);
  assert.equal(await total('orders').textContent(), '354');

  await panel.getByRole('button', { name: '数量降序', exact: true }).click();
  assert.equal((await listed(series('orders')))[0], 'empty-employee');
  await panel.getByRole('button', { name: '员工顺序', exact: true }).click();
  assert.equal((await listed(series('orders')))[0], 'employee-0');
  const axis = panel.locator('[data-employee-series="orders"] .employee-statistics-axis');
  const ticks = await axis.textContent();
  await chartPager.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await series('orders').count(), 7);
  assert.equal(await quick.locator('tbody tr').count(), 4);
  assert.match(await quick.textContent(), /历史员工/);
  assert.equal(await total('orders').textContent(), '354');
  assert.equal(await axis.textContent(), ticks, '同一筛选范围内翻页保持刻度');
  await panel.getByRole('button', { name: '展开明细', exact: true }).click();
  await details.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await details.locator('tbody tr').count(), 9);
  assert.equal(await chartPager.getAttribute('data-page'), '2');
  assert.equal(await total('issuedCodes').textContent(), '780', '明细翻页不改变完整合计');
  await chartPager.getByRole('button', { name: '上一页', exact: true }).click();
  assert.equal(await details.locator('nav[data-pagination]').getAttribute('data-page'), '2');

  await panel.getByRole('combobox', { name: '统计指标', exact: true }).selectOption('customers');
  assert.equal(await total('customers').textContent(), '26');
  assert.deepEqual(await listed(series('customers')), await listed(series('orders')));
  await panel.getByRole('combobox', { name: '统计指标', exact: true }).selectOption('orders');
  assert.equal(controls.requests.length, reads, '选人、排序、分页及指标切换复用同一快照');
  await quick.getByRole('button', { name: '从速查查看' + longName + '的提交订单明细', exact: true }).click();
  await page.locator('#employee-statistics-detail').getByText('TEST-READ-ONLY', { exact: true }).waitFor();
  assert.equal(controls.requests.at(-1).employee, 'employee-0');
  assert.equal(controls.requests.at(-1).metric, 'orders');
  await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  await panel.getByRole('combobox', { name: '员工', exact: true }).selectOption('employee-0');
  assert.equal(await total('orders').textContent(), '26');
  assert.equal(await series('orders').count(), 1);
  assert((await geometry(page)).regionHeight < initialHeight - 60, '单员工时两张柱图均收矮');
  await panel.getByRole('combobox', { name: '员工', exact: true }).selectOption('');

  controls.unavailable = true;
  controls.items = [
    { id: 'unknown', name: '待核对员工', active: true, counts: { review: 1 }, unverifiedCodes: 1 },
    { id: 'partial', name: '部分确认员工', active: true, counts: { review: 1, unusedCodes: 2 }, unverifiedCodes: 1 }
  ];
  await panel.getByRole('button', { name: '待处理资产', exact: true }).click();
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await panel.getByText('代充码池暂不可读，涉及的使用和未归还状态待核对。', { exact: true }).waitFor();
  assert.equal(await total('unusedCodes').textContent(), '2');
  assert.match(await panel.locator('[data-employee-total="unusedCodes"]').textContent(), /已确认/);
  assert.equal(await series('unusedCodes').locator('.is-unknown .employee-statistics-column-value').textContent(), '待核对');
  assert.equal(await quick.getByRole('button', { name: '从速查查看部分确认员工的未用未还充值码明细' }).textContent(), '2 已确认');
  controls.items = [];
  controls.unavailable = false;
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await panel.getByText('当前条件暂无员工记录', { exact: true }).waitFor();
  assert.equal(await total('unusedCodes').textContent(), '0');
  assert.equal(await series('unusedCodes').count(), 0);
  assert.deepEqual(errors, []);
});

test('双柱图纵向对齐，宽窄屏的长姓名和速查数值可读', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const results = [];
  for (const width of [2062, 1440, 1024, 900, 390, 320]) for (const dark of [false, true]) {
    await t.test(width + (dark ? ' 深色' : ' 浅色'), async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.setDefaultTimeout(6000);
      try {
        await install(page);
        if (dark) await toggleDesignTheme(page);
        const measured = await geometry(page);
        results.push({ width, dark, ...measured });
        assert.equal(measured.twoColumns, width >= 1440);
        assert.equal(measured.rows, 10);
        assert(measured.columnOffset.every(offset => offset <= 1), '两张图的员工在同一纵线上');
        assert.deepEqual(measured.clipped, []);
        assert(!measured.documentOverflow && !measured.regionOverflow, '图表或页面不能横向溢出');
        assert(measured.controls.every(control => control.top >= 8 && control.bottom >= 8), '图表控件应与分隔线留出间距');
        assert.notEqual(measured.barPaint, 'rgba(0, 0, 0, 0)');
        assert(measured.proportions.every(bar => Math.abs(bar.expected - bar.actual) < 0.1), '柱子的实际高度必须与数量成比例');
        if (width >= 1440) assert(!measured.chartScroll, '桌面同时显示 20 人');
        if (width <= 900) assert(measured.touch.every(control => control.height >= 44 && control.width >= 44), '手机触控目标不足');
        const help = page.locator('#employee-statistics-chart-help');
        const trigger = page.locator('[aria-controls="employee-statistics-chart-help"]');
        assert(!(await help.isVisible()), '说明默认收起');
        const before = await page.locator('.employee-statistics-distribution').boundingBox();
        await trigger.click();
        assert(await help.isVisible());
        assert.deepEqual(await page.locator('.employee-statistics-distribution').boundingBox(), before, '说明浮层不推动正文');
        await page.keyboard.press('Escape');
        assert(!(await help.isVisible()));
        if (process.env.ID_LAYOUT_QA_OUTPUT) {
          await mkdir(process.env.ID_LAYOUT_QA_OUTPUT, { recursive: true });
          await page.locator('#employee-statistics').screenshot({ path: process.env.ID_LAYOUT_QA_OUTPUT + '/dashboard-' +
            width + '-' + (dark ? 'dark' : 'light') + '.png', animations: 'disabled' });
        }
        await page.getByRole('combobox', { name: '业务类型', exact: true }).selectOption('customer');
        await page.locator('[data-employee-series="customers"]').waitFor();
        assert.equal(await page.locator('[data-employee-series="orders"]').count(), 0);
        assert.equal(await page.locator('[data-employee-series="undated"]').count(), 1);
      } finally { await page.close(); }
    });
  }
  if (process.env.ID_LAYOUT_QA_OUTPUT) await writeFile(process.env.ID_LAYOUT_QA_OUTPUT + '/dashboard-geometry.json', JSON.stringify(results, null, 2));
});
