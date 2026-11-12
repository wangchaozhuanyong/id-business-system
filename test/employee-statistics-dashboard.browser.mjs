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
  id: 'employee-' + i, name: i ? '测试员工 ' + (i + 1) : longName, active: true,
  counts: { orders: 26 - i, cancelledOrders: 1, customers: 1, unusedCodes: i + 1, openMail: 1, overdue: 1 }
}));
const items = [...people,
  { id: 'empty-employee', name: '暂无记录员工', active: true, counts: {} },
  { id: 'system', name: '系统自动同步', active: null, counts: { orders: 7, syncedOrders: 7 } },
  { id: 'unattributed', name: '归属未记录', active: null, counts: { orders: 3 } }
];

async function install(page) {
  await interceptDesign(page.context(), { actor, localFixtures: { 'auth/session': { actor } }, skipRechargeAssets: true });
  const controls = { items, requests: [], unavailable: false };
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
  await page.locator('[data-employee-kpi="orders"] strong').waitFor();
  await settle(page);
  return controls;
}

async function geometry(page) {
  await settle(page);
  return page.locator('#employee-statistics').evaluate(panel => {
    const region = panel.querySelector('.employee-statistics-distribution');
    const bars = [...region.querySelectorAll('[data-employee-chart-row]')];
    const rows = [...region.querySelectorAll('[data-employee-report-row]')];
    const twoColumns = getComputedStyle(region).gridTemplateColumns.split(' ').length === 2;
    const deviations = twoColumns ? bars.map((bar, i) => {
      const a = bar.getBoundingClientRect(), b = rows[i].getBoundingClientRect();
      return { top: Math.abs(a.top - b.top), height: Math.abs(a.height - b.height) };
    }) : [];
    const clipped = [...region.querySelectorAll('td, th, .employee-statistics-identity')].filter(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const text = range.getBoundingClientRect(), box = node.getBoundingClientRect();
      return text.width && (text.left < box.left - 1 || text.right > box.right + 1 || text.bottom > box.bottom + 1);
    }).map(node => node.textContent);
    const heading = panel.querySelector('.employee-statistics-section-heading').getBoundingClientRect();
    const controls = [...panel.querySelectorAll('.employee-statistics-chart-controls button, .employee-statistics-chart-controls select')]
      .map(node => { const box = node.getBoundingClientRect(); return { top: box.top - heading.top, bottom: heading.bottom - box.bottom }; });
    return { twoColumns, deviations, clipped, controls, regionHeight: region.getBoundingClientRect().height,
      proportions: [...region.querySelectorAll('[data-employee-bar-percent]')].map(node => ({
        expected: Number(node.dataset.employeeBarPercent),
        actual: node.getBoundingClientRect().width * 100 / node.parentElement.getBoundingClientRect().width
      })),
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      regionOverflow: region.scrollWidth > region.clientWidth + 1,
      barPaint: getComputedStyle(bars[0]?.querySelector('.employee-statistics-track > div') || region).backgroundColor };
  });
}

test('员工统计图表覆盖完整筛选、明细回查及未知状态', { timeout: 50_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const controls = await install(page);
  const panel = page.locator('#employee-statistics');
  const details = panel.locator('.employee-statistics-details');
  const chartTotal = panel.locator('[data-employee-chart-total]');
  assert.equal(await panel.locator('[data-employee-kpi="orders"] strong').textContent(), '361');
  assert.equal(await panel.locator('[data-employee-kpi="people"] strong').textContent(), '26');
  assert.equal(await chartTotal.textContent(), '361 笔');
  assert.equal(await panel.locator('[data-employee-report-row]').count(), 6);
  assert.match(await panel.locator('.employee-statistics-other').textContent(), /其余 23 项统计对象/);
  await details.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await details.locator('tbody tr').count(), 9);
  assert.equal(await chartTotal.textContent(), '361 笔', '表格翻页不能改变合计');
  const requests = controls.requests.length;
  await panel.getByRole('combobox', { name: '统计指标', exact: true }).selectOption('customers');
  assert.equal(await chartTotal.textContent(), '26 位');
  assert.equal(controls.requests.length, requests, '图表指标切换复用已读取的统计快照');
  await panel.getByRole('combobox', { name: '统计指标', exact: true }).selectOption('orders');
  await panel.getByRole('button', { name: '查看全部 29 项', exact: true }).click();
  assert.equal(await panel.locator('[data-employee-report-row]').count(), 29);
  assert.equal(await panel.locator('.employee-statistics-other').count(), 0);
  assert.match(await panel.locator('[data-employee-report-row]').last().textContent(), /归属未记录/);
  await panel.getByRole('button', { name: '收起', exact: true }).click();
  await panel.getByRole('button', { name: `从分布图查看${longName}的提交订单明细`, exact: true }).click();
  await page.locator('#employee-statistics-detail').getByText('TEST-READ-ONLY', { exact: true }).waitFor();
  assert.equal(controls.requests.at(-1).employee, 'employee-0');
  assert.equal(controls.requests.at(-1).metric, 'orders');
  await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  await panel.getByRole('combobox', { name: '员工', exact: true }).selectOption('employee-0');
  assert.equal(await chartTotal.textContent(), '26 笔');
  assert.equal(await panel.locator('[data-employee-kpi="people"] strong').textContent(), '1');
  assert((await geometry(page)).regionHeight < 300, '单员工不应保留巨大空白图表');
  await panel.getByRole('combobox', { name: '员工', exact: true }).selectOption('');
  controls.unavailable = true;
  controls.items = [
    { id: 'unknown', name: '待核对员工', active: true, counts: { review: 1 }, unverifiedCodes: 1 },
    { id: 'partial', name: '部分确认员工', active: true, counts: { review: 1, unusedCodes: 2 }, unverifiedCodes: 1 }
  ];
  await panel.getByRole('button', { name: '待处理资产', exact: true }).click();
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await panel.getByText('代充码池暂不可读，涉及的使用和未归还状态待核对。', { exact: true }).waitFor();
  assert.match(await panel.locator('[data-employee-kpi="unusedCodes"]').textContent(), /已确认/);
  assert.match(await panel.locator('[data-employee-report-row]').filter({ hasText: '待核对员工' }).textContent(), /待核对/);
  assert.match(await panel.locator('[data-employee-report-row]').filter({ hasText: '部分确认员工' }).textContent(), /2 枚 已确认/);
  assert.deepEqual(await panel.locator('[data-employee-report-row] td:nth-child(3)').allTextContents(), ['—', '—']);
  assert.equal(await chartTotal.textContent(), '2 枚');
  controls.items = [];
  controls.unavailable = false;
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await panel.getByRole('heading', { name: '暂无符合条件的待处理资产', exact: true }).waitFor();
  assert.equal(await panel.locator('[data-employee-report-row]').count(), 0);
  assert.equal(await chartTotal.textContent(), '0 枚');
  assert.deepEqual(errors, []);
});

test('员工统计长姓名逐行对齐，宽窄屏和深浅主题均可读', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const results = [];
  for (const width of [2062, 1440, 1024, 900, 390, 320]) for (const dark of [false, true]) {
    await t.test(`${width} ${dark ? '深色' : '浅色'}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.setDefaultTimeout(6000);
      try {
        await install(page);
        if (dark) await toggleDesignTheme(page);
        const measured = await geometry(page);
        results.push({ width, dark, ...measured });
        assert.equal(measured.twoColumns, width >= 1440);
        assert(measured.deviations.every(value => value.top <= 1 && value.height <= 1), JSON.stringify(measured.deviations));
        assert.deepEqual(measured.clipped, []);
        assert(!measured.documentOverflow && !measured.regionOverflow, '图表或页面不能横向溢出');
        assert(measured.controls.every(control => control.top >= 8 && control.bottom >= 8), '图表控件必须与分隔线留出间距');
        assert.notEqual(measured.barPaint, 'rgba(0, 0, 0, 0)', '图表必须显示真实条形');
        assert(measured.proportions.every(bar => Math.abs(bar.expected - bar.actual) < 0.1), '条形实际长度必须与数量成比例');
        const help = page.locator('#employee-statistics-chart-help');
        const helpTrigger = page.locator('[aria-controls="employee-statistics-chart-help"]');
        assert(!(await help.isVisible()), '说明默认收起');
        const before = await page.locator('.employee-statistics-distribution').boundingBox();
        await helpTrigger.click();
        assert(await help.isVisible());
        const after = await page.locator('.employee-statistics-distribution').boundingBox();
        assert.equal(before.y, after.y, '说明浮层不能推动正文');
        await page.keyboard.press('Escape');
        assert(!(await help.isVisible()));
        if (process.env.ID_LAYOUT_QA_OUTPUT) {
          await mkdir(process.env.ID_LAYOUT_QA_OUTPUT, { recursive: true });
          await page.screenshot({ path: `${process.env.ID_LAYOUT_QA_OUTPUT}/dashboard-${width}-${dark ? 'dark' : 'light'}.png`, fullPage: true });
        }
      } finally { await page.close(); }
    });
  }
  if (process.env.ID_LAYOUT_QA_OUTPUT) await writeFile(`${process.env.ID_LAYOUT_QA_OUTPUT}/dashboard-geometry.json`, JSON.stringify(results, null, 2));
});
