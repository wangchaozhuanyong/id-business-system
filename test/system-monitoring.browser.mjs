import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, settle, spacingSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';
import { monitorChannels, monitorRules, monitorCheckDetail } from '../server/monitoring-policy.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const route = '/#/settings/monitoring';
const at = Date.parse('2026-11-10T02:00:00Z');
const config = () => ({
  version: 1, enabled: false, tokenConfigured: true,
  channels: Object.fromEntries(Object.entries(monitorChannels).map(([key, label]) =>
    [key, { label, configured: key === 'operations', verified: key === 'operations' }])),
  rules: Object.entries(monitorRules).map(([code, rule]) => ({ code, ...rule, recipient:
    rule.channel === 'legacy' ? '已接管的代充接收人' : monitorChannels[rule.channel === 'recharge' ? 'rechargeAdmin' : rule.channel] })),
  legacy: { available: true, phase: 'native', imported: false, recipients: [] }
});
const fixtures = Array.from({ length: 24 }, (_, index) => ({
  id: 'monitor-fixture-' + (index + 1), label: index === 0 ? '代充付款待核实' : '业务接口异常',
  category: '运行', priority: 'P1', kind: 'incident', at, count: 5, accepted: index === 0,
  deliveryStatus: index === 0 ? 'accepted' : 'no_record',
  taskId: index === 0 ? 'synthetic-job-4821' : undefined,
  taskTail: index === 0 ? '4821' : undefined
}));
const output = process.env.ID_MONITORING_QA_OUTPUT;
const checkStates = {
  public_site: 'unknown', external_probe: 'disabled', tls_expiry: 'unknown', api_errors: 'unknown',
  disk_space: 'ok', login_abuse: 'ok', sensitive_reads: 'ok', recharge_runtime: 'ok',
  recharge_review: 'unknown', recharge_stuck: 'unknown', recharge_burst: 'ok', order_sync: 'disabled',
  exchange_rates: 'ok', mailbox: 'unknown', backup: 'disabled', sheets: 'disabled'
};
const checkFixtures = () => Object.entries(checkStates).map(([code, status]) => ({
  code, status, label: monitorRules[code].label, category: monitorRules[code].category, at,
  ...monitorCheckDetail(code, status, { status,
    reason: ['public_site', 'external_probe', 'tls_expiry'].includes(code) ? 'probe_disabled' :
      ['backup', 'sheets'].includes(code) ? 'receipt_disabled' : code === 'api_errors' ? 'insufficient_requests' : undefined })
}));

async function prepare(browser, width, role = 'super', phase = 'native', changeEvents = false) {
  const context = await browser.newContext({ viewport: { width, height: 940 }, locale: 'zh-CN' });
  const offline = await interceptDesign(context, { localFixtures: {}, changeEvents,
    actor: { id: 'fixture-monitor-' + role, name: '合成管理员', role } });
  const records = structuredClone(fixtures), settings = config(), writes = [], reads = [];
  let readings = checkFixtures();
  settings.legacy.phase = phase;
  let failSave = false, failRead = false;
  await context.route('**/api/local/system-monitoring*', async request => {
    const req = request.request(), url = new URL(req.url());
    if (req.method() === 'POST') {
      const body = req.postDataJSON();
      writes.push(body);
      if (body.action === 'test') return request.fulfill({ status: 202, json: { queued: true } });
      if (body.action === 'acknowledge') {
        const row = records.find(row => row.id === body.id);
        if (row) { row.ackAt = at; row.ackBy = '合成管理员'; }
        return request.fulfill({ json: { acknowledged: true } });
      }
      if (failSave) return request.fulfill({ status: 409, json: { error: '合成版本冲突，请重新读取' } });
      if (body.action === 'settings') {
        settings.version++;
        settings.enabled = body.settings.enabled;
        for (const rule of settings.rules) if (rule.code in body.settings.rules) rule.enabled = body.settings.rules[rule.code];
        return request.fulfill({ json: settings });
      }
      return request.fulfill({ status: 400, json: { error: '离线操作不可用' } });
    }
    reads.push(url.searchParams.get('tab'));
    if (failRead) return request.fulfill({ status: 503, json: { error: '合成读取失败' } });
    const tab = url.searchParams.get('tab'), requestedPage = Number(url.searchParams.get('page') || 1);
    const pageSize = Number(url.searchParams.get('pageSize') || 20);
    if (tab === 'config') return request.fulfill({ json: settings });
    if (tab === 'legacy') return request.fulfill({ json: { phase } });
    if (tab === 'deliveries') return request.fulfill({ json: { page: 1, total: 1, pageSize,
      items: [{ id: 'receipt-fixture', label: '渠道测试', status: 'accepted', target: '运维接收人', at, attempts: 1, messageId: 421 }] } });
    const query = (url.searchParams.get('q') || '').toLowerCase();
    const matched = url.searchParams.get('status') === 'resolved' ? [] : records.filter(row =>
      (!url.searchParams.get('priority') || row.priority === url.searchParams.get('priority')) &&
      (!query || [row.label, row.id, row.taskTail].some(value => String(value || '').toLowerCase().includes(query))));
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(matched.length / pageSize)));
    return request.fulfill({ json: { checks: readings, generatedAt: at,
      notifications: { status: 'disabled', configured: 1, verified: 1, total: 4,
        missingChannels: ['安全管理员', '代充管理员'], legacyPhase: phase },
      page, total: matched.length, pageSize, items: matched.slice((page - 1) * pageSize, page * pageSize) } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  return { page, context, offline, errors, writes, reads, setChecks(value) { readings = value; }, setLegacyStatus(value) { phase = value; },
    setFailSave(value) { failSave = value; }, setFailRead(value) { failRead = value; } };
}

async function pageGeometry(page) {
  await settle(page);
  const geometry = await page.locator('#main').evaluate(root => {
    const textBox = node => {
      const range = document.createRange();
      range.selectNodeContents(node.firstChild);
      return range.getBoundingClientRect().toJSON();
    };
    return {
    documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    width: innerWidth,
    overflowing: [...root.querySelectorAll('*')].filter(node =>
      node.getBoundingClientRect().right > innerWidth + 1 && node.getClientRects().length)
      .slice(0, 12).map(node => ({ tag: node.tagName, className: String(node.className),
        right: Math.round(node.getBoundingClientRect().right), parent: String(node.parentElement.className) })),
    clippedActions: [...root.querySelectorAll('[data-action="system-monitor-detail"]')].filter(node => node.checkVisibility())
      .some(node => { const box = node.getBoundingClientRect(); return box.left < 0 || box.right > innerWidth + 1; }),
    controls: [...root.querySelectorAll('.field')].filter(row => row.checkVisibility()).map(row => {
      const label = row.querySelector(':scope > label');
      const control = row.querySelector('input,select');
      if (!label || !control) return null;
      const a = label.getBoundingClientRect(), b = control.getBoundingClientRect();
      return { label: label.textContent, before: a.left < b.left, overlap: a.right > b.left + 1,
        row: Math.min(a.bottom, b.bottom) >= Math.max(a.top, b.top) - 1 };
    }).filter(Boolean),
    metricHeadings: [...root.querySelectorAll('.summary-label')].map(node => textBox(node).top),
    groupHeadings: [...root.querySelectorAll('.system-monitor-group h3')].map(textBox)
  }; });
  assert.equal(geometry.documentOverflow, false, JSON.stringify({ width: geometry.width, overflowing: geometry.overflowing }));
  assert.equal(geometry.clippedActions, false);
  assert(geometry.controls.every(row => row.before && !row.overlap && row.row), JSON.stringify(geometry.controls));
  if (page.viewportSize().width >= 1024 && geometry.metricHeadings.length)
    assert(Math.max(...geometry.metricHeadings) - Math.min(...geometry.metricHeadings) < 1);
  if (geometry.groupHeadings.length > 1 && geometry.groupHeadings[0].left !== geometry.groupHeadings[1].left)
    assert(Math.abs(geometry.groupHeadings[0].top - geometry.groupHeadings[1].top) < 1);
  const spacing = await spacingSnapshot(page);
  assert.deepEqual(spacing.findings, []);
}

test('监控配置和告警使用实际路由并兼容桌面、手机及深浅主题', { timeout: 90_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1440, 1024, 901, 900, 768, 390, 320]) for (const theme of ['light', 'dark']) {
    const { page, context, offline, errors } = await prepare(browser, width);
    await page.goto(origin + route);
    if (theme === 'dark') await toggleDesignTheme(page);
    await page.getByRole('button', { name: '保存渠道', exact: true }).waitFor();
    await pageGeometry(page);
    if (output && [1440, 390].includes(width)) await page.screenshot({ path: join(output, 'channels-' + width + '-' + theme + '.png') });
    await page.getByRole('tab', { name: '通知规则' }).click();
    await page.getByRole('button', { name: '保存通知规则' }).waitFor();
    await pageGeometry(page);
    if (width > 900) {
      const save = await page.getByRole('button', { name: '保存通知规则', exact: true }).boundingBox();
      assert(save.y + save.height < 940, '规则保存按钮在桌面首屏内');
    }
    if (output && [1440, 390].includes(width)) await page.screenshot({ path: join(output, 'rules-' + width + '-' + theme + '.png'), fullPage: true });
    await page.getByRole('tab', { name: '投递记录' }).click();
    const receipt = page.locator('[data-monitor-card="receipt-fixture"]:visible, [data-row-id="receipt-fixture"]:visible');
    await receipt.getByText('Telegram 已接收', { exact: true }).waitFor();
    assert.equal(await receipt.count(), 1);
    await pageGeometry(page);
    if (output && [1440, 390].includes(width)) await page.screenshot({ path: join(output, 'deliveries-' + width + '-' + theme + '.png') });
    await page.evaluate(() => { location.hash = '#/monitor'; });
    await page.locator('[data-monitor-check]').first().waitFor();
    await pageGeometry(page);
    if (output && [1440, 390].includes(width)) await page.screenshot({ path: join(output, 'checks-' + width + '-' + theme + '.png') });
    await page.getByRole('tab', { name: '告警记录', exact: true }).click();
    const incident = page.locator('[data-monitor-card="monitor-fixture-1"]:visible, [data-row-id="monitor-fixture-1"]:visible');
    await incident.getByText('代充付款待核实', { exact: true }).waitFor();
    assert.equal(await incident.count(), 1);
    await pageGeometry(page);
    if (output && [1440, 390].includes(width)) {
      await page.screenshot({ path: join(output, 'incidents-' + width + '-' + theme + '.png') });
      if (width === 1440) await page.screenshot({ path: join(output, 'incidents-full-' + theme + '.png'), fullPage: true });
    }
    const pager = page.locator('[data-pagination="system-monitoring"]');
    const frameHeight = () => page.locator('.system-monitor-incidents').evaluate(node => node.getBoundingClientRect().height);
    const firstHeight = await frameHeight();
    const size = pager.getByRole('combobox', { name: '每页条数' });
    assert.equal(await size.inputValue(), '20');
    await pager.getByRole('button', { name: '下一页' }).click();
    await page.locator('[data-row-id="monitor-fixture-21"]:visible, [data-monitor-card="monitor-fixture-21"]:visible').waitFor();
    await settle(page);
    assert(Math.abs(await frameHeight() - firstHeight) <= 1, '末页告警框架不应缩小');
    await size.selectOption('10');
    await page.locator('[data-pagination="system-monitoring"][data-page="1"][data-page-size="10"]').waitFor();
    await pageGeometry(page);
    const filteredHeight = await frameHeight();
    await page.locator('#system-monitor-filter').selectOption('resolved');
    await page.getByRole('heading', { name: '暂无符合条件的告警' }).waitFor();
    await pageGeometry(page);
    assert(Math.abs(await frameHeight() - filteredHeight) <= 1, '空结果告警框架不应缩小');
    assert.deepEqual(errors, []);
    assert.deepEqual(offline.external, []);
    await context.close();
  }
});

test('监控概览显示完整状态、检查依据和通知缺口，筛选及处理入口可用', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const f = await prepare(browser, 1440);
  t.after(() => f.context.close());
  const { page } = f;
  await page.goto(origin + '/#/monitor');
  await page.locator('[data-monitor-metric="1"] .summary-number').filter({ hasText: '6' }).waitFor();
  assert.equal(await page.locator('[data-monitor-metric="2"] .summary-number').innerText(), '10');
  assert.equal(await page.locator('[data-monitor-check]').count(), 10);
  await page.getByRole('tab', { name: '告警记录', exact: true }).click();
  assert.match(await page.locator('[data-row-id="monitor-fixture-2"]').innerText(), /无投递记录/);
  await page.getByRole('tab', { name: '运行状态', exact: true }).click();
  await page.locator('#system-monitor-check-filter').selectOption('all');
  assert.equal(await page.locator('[data-monitor-check]').count(), 16);
  await page.locator('[data-action="system-monitor-check"][data-code="backup"]').click();
  const drawer = page.locator('#drawer[open]');
  await drawer.getByText('尚未接入专用工作进程回执，无法判断任务运行结果。', { exact: true }).waitFor();
  await drawer.getByText(checkFixtures().find(row => row.code === 'backup').source, { exact: true }).waitFor();
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '查看接通情况' }).click();
  await drawer.getByText('安全管理员、代充管理员', { exact: true }).waitFor();
  await drawer.getByRole('button', { name: '打开监控通知' }).click();
  await page.waitForURL(origin + route);
  assert.equal(await drawer.count(), 0);
  await page.getByRole('link', { name: '网站监控', exact: true }).click();
  await page.getByRole('tab', { name: '运行状态', exact: true }).click();
  await page.locator('#system-monitor-check-filter').waitFor();
  assert.equal(await page.locator('#system-monitor-check-filter').inputValue(), 'all');
  const syncCommands = [];
  await f.context.route(url => url.pathname === '/api/local/order-sync', async route => {
    syncCommands.push(route.request().postDataJSON());
    f.setChecks(checkFixtures().map(row => row.code === 'order_sync' ? { ...row, status: 'ok' } : row));
    await route.fulfill({ json: { rows: [{ jobKey: 'synthetic-job', orderNo: 'OD-SYNTHETIC' }], pending: 0 } });
  });
  f.setChecks(checkFixtures().map(row => row.code === 'order_sync' ? { ...row, status: 'bad' } : row));
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  const orderSync = page.locator('[data-monitor-check="order_sync"]');
  await orderSync.getByText('异常', { exact: true }).waitFor();
  await orderSync.getByRole('button', { name: '查看订单同步与处理' }).click();
  await drawer.getByRole('button', { name: '重试入单', exact: true }).click();
  await orderSync.getByText('正常', { exact: true }).waitFor();
  assert.deepEqual(syncCommands, [{ mode: 'retry' }]);
  await page.getByRole('button', { name: '查看汇率采集与处理', exact: true }).click();
  await drawer.getByRole('button', { name: '查看汇率采集', exact: true }).click();
  await page.waitForURL(origin + '/#/settings/exchange-rates');
  assert.equal(await drawer.count(), 0);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.offline.external, []);
  assert.deepEqual(f.errors, []);
});

test('缺少监控资料时显示读取失败，不渲染虚构的零值概览', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const f = await prepare(browser, 1440);
  t.after(() => f.context.close());
  f.setChecks(null);
  await f.page.goto(origin + '/#/monitor');
  await f.page.getByRole('alert').filter({ hasText: '监控状态响应不完整' }).waitFor();
  assert.equal(await f.page.locator('[data-monitor-metric]').count(), 0);
  f.setChecks(checkFixtures());
  await f.page.getByRole('button', { name: '刷新', exact: true }).click();
  await f.page.locator('[data-monitor-metric="1"] .summary-number').filter({ hasText: '6' }).waitFor();
  assert.deepEqual(f.errors, []);
});

test('监控仅在新版本时更新，保留抽屉和失败内容，无变更不定时读取', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const f = await prepare(browser, 1440, 'super', 'native', true);
  t.after(() => f.context.close());
  const { page } = f;
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const frame = (version, type = 'change') => `event: ${type}\ndata: ${JSON.stringify({ schema: 1, versions: { 'system-monitoring': version } })}\n\n`;
    window.emitMonitoring = version => window.monitoringStream.enqueue(new TextEncoder().encode(frame(version)));
    window.fetch = (input, options) => {
      if (new URL(String(input), location.href).pathname !== '/api/local/change-events') return original(input, options);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.monitoringStream = controller;
        controller.enqueue(new TextEncoder().encode(frame('1', 'snapshot')));
        const heartbeat = setInterval(() => controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 20_000);
        options.signal.addEventListener('abort', () => {
          clearInterval(heartbeat);
          controller.error(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } }));
    };
  });
  await page.clock.install();
  await page.goto(origin + '/#/monitor');
  await page.locator('[data-monitor-check="backup"]').waitFor();
  await page.waitForFunction(() => window.monitoringStream && !window.IDChangeSync.status().refreshing);
  const initial = f.reads.length;
  await page.clock.runFor(120_000);
  assert.equal(f.reads.length, initial, 'no periodic business read');
  f.setChecks(checkFixtures().map(row => row.code === 'disk_space'
    ? { ...row, status: 'bad', detail: '合成磁盘可用比例低于阈值。' } : row));
  await page.evaluate(() => window.emitMonitoring('2'));
  await page.locator('[data-monitor-check="disk_space"]').getByText('异常', { exact: true }).waitFor();
  assert.equal(f.reads.length, initial + 1);
  await page.evaluate(() => window.emitMonitoring('2'));
  await page.clock.runFor(120_000);
  assert.equal(f.reads.length, initial + 1, 'same revision cannot re-read');
  await page.locator('[data-action="system-monitor-check"][data-code="backup"]').click();
  await page.evaluate(() => { window.monitorDrawer = document.querySelector('#drawer'); window.emitMonitoring('3'); });
  await page.waitForFunction(() => !window.IDChangeSync.status().refreshing && window.IDChangeSync.status().pending === 0);
  assert(await page.evaluate(() => window.monitorDrawer === document.querySelector('#drawer') && window.monitorDrawer.open));
  await page.locator('#drawer').getByRole('button', { name: '关闭', exact: true }).click();
  f.setFailRead(true);
  await page.evaluate(() => window.emitMonitoring('4'));
  await page.getByRole('alert').filter({ hasText: '已保留上次读取' }).waitFor();
  await page.locator('[data-monitor-check="disk_space"]').getByText('异常', { exact: true }).waitFor();
  f.setFailRead(false);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '已保留上次读取' }).waitFor({ state: 'hidden' });
  await page.evaluate(() => window.IDDesignAPI.go('customers/list'));
  const afterLeave = f.reads.length;
  await page.evaluate(() => window.emitMonitoring('5'));
  await page.clock.runFor(120_000);
  assert.equal(f.reads.length, afterLeave, 'inactive pages do not fetch new data');
  assert.deepEqual(f.writes, []); assert.deepEqual(f.offline.external, []); assert.deepEqual(f.errors, []);
});

test('监控设置保留普通草稿、清除离页密钥并分开投递和人工确认', { timeout: 45_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const { page, context, offline, errors, writes, setFailSave, setFailRead } = await prepare(browser, 1440);
  t.after(() => context.close());
  await page.goto(origin + route);
  const enabled = page.locator('#system-monitor-enabled'), token = page.locator('#system-monitor-token');
  await enabled.check();
  await token.fill('offline-only-secret');
  setFailSave(true);
  await page.getByRole('button', { name: '保存渠道', exact: true }).click();
  await page.locator('[data-system-monitor-error]').filter({ hasText: '合成版本冲突' }).waitFor();
  assert.equal(await token.inputValue(), 'offline-only-secret');
  setFailSave(false);
  await page.getByRole('tab', { name: '通知规则' }).click();
  const apiErrors = page.locator('#system-monitor-rule-api_errors');
  await apiErrors.uncheck();
  const ruleList = page.locator('.system-monitor-rules-list > .table-viewport');
  await ruleList.evaluate(node => { node.scrollTop = 200; });
  const ruleScroll = await ruleList.evaluate(node => node.scrollTop);
  assert(ruleScroll > 0);
  await Promise.all([page.waitForResponse(response => response.url().includes('system-monitoring?') && response.request().method() === 'GET'),
    page.getByRole('button', { name: '刷新', exact: true }).click()]);
  await settle(page);
  assert.equal(await ruleList.evaluate(node => node.scrollTop), ruleScroll, '刷新保持规则阅读位置');
  assert.equal(await apiErrors.isChecked(), false, '刷新保留未保存规则');
  await page.locator('#system-monitor-rule-category').selectOption('安全');
  assert.equal(await apiErrors.count(), 0);
  await page.locator('#system-monitor-rule-category').selectOption('运行');
  assert.equal(await apiErrors.isChecked(), false);
  await page.getByRole('tab', { name: 'Telegram 渠道' }).click();
  assert.equal(await enabled.isChecked(), true);
  assert.equal(await token.inputValue(), '');
  const drafts = await page.evaluate(() => JSON.stringify([...window.IDDesignAPI.state.drafts]));
  assert.equal(drafts.includes('offline-only-secret'), false);
  await page.getByRole('button', { name: '保存渠道', exact: true }).click();
  await page.getByText('已保存监控设置', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '通知规则' }).click();
  assert.equal(await apiErrors.isChecked(), false);
  await page.getByRole('button', { name: '使用最新版本继续编辑' }).waitFor();
  await page.getByRole('tab', { name: 'Telegram 渠道' }).click();
  await page.getByRole('button', { name: '测试运维接收人' }).click();
  await page.locator('#confirm-dialog').getByRole('button', { name: '确认操作' }).click();
  await page.getByText('测试已排队，请到投递记录核对', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '投递记录' }).click();
  await page.getByRole('cell', { name: 'Telegram 已接收', exact: true }).waitFor();
  await page.evaluate(() => { location.hash = '#/monitor'; });
  await page.getByRole('tab', { name: '告警记录', exact: true }).click();
  const first = page.locator('[data-row-id="monitor-fixture-1"]');
  await first.getByRole('button', { name: '查看详情' }).click();
  const drawer = page.locator('#drawer[open]');
  await drawer.getByText('尚无恢复证据', { exact: true }).waitFor();
  await drawer.getByRole('button', { name: '查看原任务' }).click();
  assert.match(await drawer.locator('iframe').getAttribute('src'), /admin\?taskLog=synthetic-job-4821$/);
  await page.keyboard.press('Escape');
  await first.getByRole('button', { name: '查看详情' }).click();
  await drawer.getByRole('button', { name: '确认已知悉' }).click();
  await page.locator('#confirm-dialog').getByRole('button', { name: '确认操作' }).click();
  await first.getByText('已确认', { exact: true }).waitFor();
  setFailRead(true);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '已保留上次读取' }).waitFor();
  await first.waitFor();
  assert.equal(writes.filter(row => row.action === 'acknowledge').length, 1);
  assert.equal(writes.filter(row => row.action === 'test').length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(offline.external, []);
});

async function assertNoRechargeTelegram(frame) {
  await frame.getByRole('button', { name: '保存全局配置', exact: true }).waitFor();
  assert.equal(await frame.locator('#telegram_bot_token').count(), 0);
  assert.equal(await frame.getByRole('heading', { name: 'Telegram 通知', exact: true }).count(), 0);
  assert.equal(await frame.getByRole('link', { name: '打开监控通知' }).count(), 0);
}

test('接管后代充配置没有 Telegram 区块，普通管理员仍可查看监控', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const { page, context, offline } = await prepare(browser, 1440, 'super', 'managed');
  await page.goto(origin + '/#/online-recharge/chatgpt');
  await page.getByRole('button', { name: '系统配置', exact: true }).click();
  const frame = page.frameLocator('iframe[data-view="config"]:not([hidden])');
  await assertNoRechargeTelegram(frame);
  await page.goto(origin + route);
  await page.locator('#system-monitor-legacy-admin').waitFor();
  await pageGeometry(page);
  await page.setViewportSize({ width: 390, height: 940 });
  await pageGeometry(page);
  assert.deepEqual(offline.external, []);
  await context.close();

  const limited = await prepare(browser, 390, 'admin');
  t.after(() => limited.context.close());
  await limited.page.goto(origin + route);
  assert.equal(await limited.page.getByRole('button', { name: '保存渠道' }).count(), 0);
  await limited.page.evaluate(() => { location.hash = '#/monitor'; });
  await limited.page.getByRole('tab', { name: '告警记录', exact: true }).click();
  await limited.page.getByRole('heading', { name: '代充付款待核实' }).waitFor();
  assert.equal(await limited.page.getByRole('button', { name: '登记已核实事件' }).count(), 0);
  assert.deepEqual(limited.errors, []);
});

test('接管前从监控通知打开原代充表单，沿用保存、测试及草稿', { timeout: 45_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    const { page, context, offline, errors, writes, setLegacyStatus } = await prepare(browser, width);
    t.after(() => context.close());
    const api = '/integrations/codexdaichong/api/admin/';
    const original = {
      bot_token: 'fixture-mask', admin_chat_id: '123456789', group_chat_id: '-1001234567890',
      notify_admin: true, notify_group: false, on_success: false, on_failure: true, on_card_pool_empty: true
    };
    let native = { ...original };
    const nativeWrites = [];
    await context.route('**' + api + 'data', request => request.fulfill({
      json: { success: true, stats: { total: 0, success: 0, failed: 0 }, config: {}, logs: [], telegram: native }
    }));
    await context.route(/\/integrations\/codexdaichong\/api\/admin\/telegram(?:\/test)?$/, async request => {
      const req = request.request();
      assert.equal(req.method(), 'POST');
      const testMessage = new URL(req.url()).pathname.endsWith('/test');
      const data = req.postDataJSON();
      nativeWrites.push({ testMessage, data });
      if (!testMessage) native = { ...data, bot_token: native.bot_token };
      return request.fulfill({ json: { success: true, message: testMessage ? '离线测试回执' : '离线保存回执' } });
    });

    await page.goto(origin + '/#/online-recharge/chatgpt');
    if (theme === 'dark') await toggleDesignTheme(page);
    await page.getByRole('button', { name: '系统配置', exact: true }).click();
    await assertNoRechargeTelegram(page.frameLocator('iframe[data-view="config"]:not([hidden])'));
    if (width <= 900) await page.locator('#nav-toggle').click();
    const sidebar = page.locator('#sidebar');
    const link = sidebar.getByRole('link', { name: '监控通知', exact: true });
    if (!await link.count()) await sidebar.getByRole('button', { name: '监控中心', exact: true }).click();
    await link.click();
    await page.waitForURL(origin + route);
    const open = page.getByRole('button', { name: '原代充 Telegram 设置' });
    const openLegacy = async () => {
      await page.locator('#system-monitor-channel-form').waitFor();
      await settle(page);
      if (await open.isVisible()) return open.click();
      await page.locator('.system-monitor-legacy').getByRole('button', { name: '更多操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '原代充 Telegram 设置', exact: true }).click();
    };
    const drawer = page.locator('#drawer');
    const frame = drawer.frameLocator('iframe');
    const token = frame.getByLabel('Bot Token');
    const chat = frame.getByLabel('管理员 Chat ID');
    const failure = frame.getByRole('checkbox', { name: '开通失败时通知' });
    const save = frame.getByRole('button', { name: '保存 Telegram 配置' });
    const send = frame.getByRole('button', { name: '发送测试消息' });
    const close = async () => {
      await drawer.getByRole('button', { name: '关闭抽屉' }).click();
      await drawer.locator('iframe').waitFor({ state: 'detached' });
    };
    await openLegacy();
    await save.waitFor();
    assert.equal(await token.inputValue(), '');
    assert.match(await token.getAttribute('placeholder'), /已保存/);
    assert.equal(await chat.inputValue(), original.admin_chat_id);
    assert.equal(await frame.getByLabel('群组 Chat ID').inputValue(), original.group_chat_id);
    assert.equal(await failure.isChecked(), true);
    assert.equal(await frame.locator('.page-view:visible').count(), 0);
    assert.equal(await save.evaluate(node => {
      const doc = node.ownerDocument, { right, left } = node.getBoundingClientRect();
      return doc.documentElement.scrollWidth <= doc.defaultView.innerWidth + 1 &&
        left >= 0 && right <= doc.defaultView.innerWidth + 1 && doc.documentElement.dataset.idTheme ===
        doc.defaultView.parent.document.documentElement.dataset.theme;
    }), true);
    assert.deepEqual(nativeWrites, []);

    await chat.fill('123456790');
    await token.fill('synthetic-secret');
    await failure.uncheck();
    await close();
    await openLegacy();
    await save.waitFor();
    assert.equal(await chat.inputValue(), '123456790');
    assert.equal(await failure.isChecked(), false);
    assert.equal(await token.inputValue(), '');
    await save.click();
    await frame.getByText('离线保存回执').waitFor();
    await send.click();
    await frame.getByText('离线测试回执').waitFor();
    assert.deepEqual(nativeWrites, [
      { testMessage: false, data: { ...original, bot_token: '', admin_chat_id: '123456790', on_failure: false } },
      { testMessage: true, data: {} }
    ]);
    assert.deepEqual(writes, []);
    await close();

    setLegacyStatus('switching');
    await openLegacy();
    await frame.getByText('代充通知已进入统一接管，请在监控与通知核对。').waitFor();
    assert.equal(await save.isVisible(), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(offline.external, []);
    await context.close();
  }
});


test('监控中心入口、全量筛选、键盘和大表格视口保持可用', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const f = await prepare(browser, 1440);
  t.after(() => f.context.close());
  const { page } = f;
  await page.goto(origin + '/#/monitor');
  await page.locator('[data-monitor-check]').first().waitFor();
  const navigation = await page.evaluate(() => window.IDDesignAPI.navigation);
  assert.deepEqual(navigation.find(group => group[0] === '监控中心')[2].map(item => item[0]), ['网站监控', '监控通知']);
  assert(!navigation.find(group => group[0] === '插件管理')[2].some(item => item[1] === 'plugins/websites'));
  assert(!navigation.find(group => group[0] === '系统设置')[2].some(item => item[1] === 'settings/monitoring'));
  assert.equal(await page.locator('#breadcrumbs').innerText(), '监控中心');
  assert.equal(await page.locator('#page-title h1').innerText(), '网站监控');
  assert.equal(await page.getByRole('link', { name: '网站监控', exact: true }).getAttribute('href'), '#/monitor');
  await page.getByRole('tab', { name: '运行状态', exact: true }).press('ArrowRight');
  await page.getByRole('tab', { name: '告警记录', exact: true, selected: true }).waitFor();
  await page.locator('[data-row-id="monitor-fixture-1"]').waitFor();
  const geometry = await page.locator('.system-monitor-list > .table-viewport').evaluate(view => {
    const box = view.getBoundingClientRect(), header = view.querySelector('thead').getBoundingClientRect();
    const pager = document.querySelector('[data-pagination="system-monitoring"]').getBoundingClientRect();
    return { top: box.top, height: box.height, bottom: box.bottom, pagerBottom: pager.bottom, viewport: innerHeight,
      visibleRows: [...view.querySelectorAll('tbody tr')].filter(row => {
        const item = row.getBoundingClientRect(); return item.top >= header.bottom && item.bottom <= box.bottom;
      }).length };
  });
  assert(geometry.height >= 500 && geometry.visibleRows >= 9 && geometry.pagerBottom < geometry.viewport, JSON.stringify(geometry));
  if (output) await writeFile(join(output, 'record-viewport.json'), JSON.stringify(geometry, null, 2));
  const help = page.getByLabel('查看告警记录说明');
  const table = page.locator('.system-monitor-list');
  const initialBox = await table.boundingBox();
  await help.press('Enter');
  await page.getByText(/关键词可查告警名称/).waitFor();
  assert.deepEqual(await table.boundingBox(), initialBox);
  await page.keyboard.press('Escape');
  await page.getByText(/关键词可查告警名称/).waitFor({ state: 'hidden' });
  await page.locator('#system-monitor-search').fill('付款');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.locator('[data-pagination="system-monitoring"]').getByText('共 1 条 · 第 1–1 条', { exact: true }).waitFor();
  assert.equal(await page.locator('.system-monitor-list tbody tr').count(), 1);
  await page.locator('#system-monitor-priority').selectOption('P0');
  await page.getByRole('heading', { name: '暂无符合条件的告警' }).waitFor();
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await page.locator('[data-row-id="monitor-fixture-2"]').waitFor();
  assert.equal(await page.locator('#system-monitor-search').inputValue(), '');
  await page.locator('#system-monitor-days').selectOption('7');
  await page.getByRole('tab', { name: '运行状态', exact: true }).click();
  await page.getByRole('tab', { name: '告警记录', exact: true }).click();
  assert.equal(await page.locator('#system-monitor-days').inputValue(), '7');
  await page.getByRole('tab', { name: '告警记录', exact: true }).press('End');
  await page.locator('#ops-monitor-url').waitFor();
  assert.equal(await page.locator('#sidebar a[aria-current="page"]').innerText(), '网站监控');
  await page.getByRole('tab', { name: '网站检测', exact: true }).press('Home');
  await page.locator('[data-monitor-check]').first().waitFor();
  await settle(page);
  assert(await page.getByRole('tab', { name: '运行状态', exact: true }).evaluate(node => document.activeElement === node));
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.offline.external, []);
});


test('员工保留网站检测入口，不呈现管理监控和通知配置', { timeout: 15_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const f = await prepare(browser, 390, 'employee');
  t.after(() => f.context.close());
  await f.page.goto(origin + '/#/plugins/websites');
  await f.page.locator('#ops-monitor-url').waitFor();
  assert.equal(await f.page.locator('.monitor-navigation [role="tab"]').count(), 1);
  await f.page.locator('#nav-toggle').click();
  assert.equal(await f.page.getByRole('link', { name: '网站监控', exact: true }).getAttribute('href'), '#/plugins/websites');
  assert.equal(await f.page.getByRole('link', { name: '监控通知', exact: true }).count(), 0);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.errors, []);
});
