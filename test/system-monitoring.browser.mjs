import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, settle, spacingSnapshot } from './helpers/offline-design.mjs';
import { monitorChannels, monitorRules } from '../server/monitoring-policy.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const route = '/#/settings/monitoring';
const at = Date.parse('2026-11-10T02:00:00Z');
const config = () => ({
  version: 1, enabled: false, tokenConfigured: true,
  channels: Object.fromEntries(Object.entries(monitorChannels).map(([key, label]) =>
    [key, { label, configured: key === 'operations', verified: key === 'operations' }])),
  rules: Object.entries(monitorRules).map(([code, rule]) => ({ code, ...rule })),
  legacy: { available: true, phase: 'native', imported: false, recipients: [] }
});
const fixtures = Array.from({ length: 12 }, (_, index) => ({
  id: 'monitor-fixture-' + (index + 1), label: index === 0 ? '代充付款待核实' : '业务接口异常',
  category: '运行', priority: 'P1', kind: 'incident', at, count: 5, accepted: index === 0,
  taskId: index === 0 ? 'synthetic-job-4821' : undefined,
  taskTail: index === 0 ? '4821' : undefined
}));
const output = process.env.ID_MONITORING_QA_OUTPUT;

async function prepare(browser, width, role = 'super') {
  const context = await browser.newContext({ viewport: { width, height: 940 }, locale: 'zh-CN' });
  const offline = await interceptDesign(context, { localFixtures: {},
    actor: { id: 'fixture-monitor-' + role, name: '合成管理员', role } });
  const records = structuredClone(fixtures), settings = config(), writes = [];
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
    if (failRead) return request.fulfill({ status: 503, json: { error: '合成读取失败' } });
    const tab = url.searchParams.get('tab'), page = Number(url.searchParams.get('page') || 1);
    if (tab === 'config') return request.fulfill({ json: settings });
    if (tab === 'legacy') return request.fulfill({ json: { phase: 'managed' } });
    if (tab === 'deliveries') return request.fulfill({ json: { page: 1, total: 1, pageSize: 10,
      items: [{ id: 'receipt-fixture', label: '渠道测试', status: 'accepted', target: '运维接收人', at, attempts: 1, messageId: 421 }] } });
    const matched = url.searchParams.get('status') === 'resolved' ? [] : records;
    return request.fulfill({ json: { checks: [{ label: '站外探针', status: 'unknown' }, { label: '执行器', status: 'ok' }],
      page: matched.length ? page : 1, total: matched.length, pageSize: 10, items: matched.slice((page - 1) * 10, page * 10) } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  return { page, context, offline, errors, writes, setFailSave(value) { failSave = value; }, setFailRead(value) { failRead = value; } };
}

async function pageGeometry(page) {
  await settle(page);
  const geometry = await page.locator('#main').evaluate(root => ({
    documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    clippedActions: [...root.querySelectorAll('[data-action="system-monitor-detail"]')].filter(node => node.checkVisibility())
      .some(node => { const box = node.getBoundingClientRect(); return box.left < 0 || box.right > innerWidth + 1; }),
    controls: [...root.querySelectorAll('.field')].filter(row => row.checkVisibility()).map(row => {
      const label = row.querySelector(':scope > label');
      const control = row.querySelector('input,select');
      if (!label || !control) return null;
      const a = label.getBoundingClientRect(), b = control.getBoundingClientRect();
      return { label: label.textContent, before: a.left < b.left, overlap: a.right > b.left + 1,
        row: Math.min(a.bottom, b.bottom) >= Math.max(a.top, b.top) - 1 };
    }).filter(Boolean)
  }));
  assert.equal(geometry.documentOverflow, false);
  assert.equal(geometry.clippedActions, false);
  assert(geometry.controls.every(row => row.before && !row.overlap && row.row), JSON.stringify(geometry.controls));
  const spacing = await spacingSnapshot(page);
  assert.deepEqual(spacing.findings, []);
}

test('监控配置和告警使用实际路由并兼容桌面、手机及深浅主题', { timeout: 90_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    const { page, context, offline, errors } = await prepare(browser, width);
    await page.goto(origin + route);
    if (theme === 'dark') await page.locator('#theme-toggle').click();
    await page.getByRole('button', { name: '保存渠道', exact: true }).waitFor();
    await pageGeometry(page);
    if (output && width !== 320) await page.screenshot({ path: join(output, 'channels-' + width + '-' + theme + '.png') });
    await page.getByRole('tab', { name: '通知规则' }).click();
    await page.getByRole('button', { name: '保存通知规则' }).waitFor();
    await pageGeometry(page);
    await page.getByRole('tab', { name: '投递记录' }).click();
    await (width <= 760 ? page.locator('[data-monitor-card="receipt-fixture"]') :
      page.getByRole('cell', { name: 'Telegram 已接收', exact: true })).waitFor();
    await pageGeometry(page);
    await page.evaluate(() => { location.hash = '#/monitor'; });
    await (width <= 760 ? page.getByRole('heading', { name: '代充付款待核实' }) :
      page.getByRole('cell', { name: '代充付款待核实' })).waitFor();
    await pageGeometry(page);
    if (output && width !== 320) await page.screenshot({ path: join(output, 'incidents-' + width + '-' + theme + '.png') });
    await page.getByRole('button', { name: '下一页' }).click();
    await page.locator('[data-row-id="monitor-fixture-11"]:visible, [data-monitor-card="monitor-fixture-11"]:visible').waitFor();
    await pageGeometry(page);
    await page.locator('#system-monitor-filter').selectOption('resolved');
    await page.getByRole('heading', { name: '暂无符合条件的告警' }).waitFor();
    await pageGeometry(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(offline.external, []);
    await context.close();
  }
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

test('接管后的原代充配置只提供统一设置入口，普通管理员仍可查看监控', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const { page, context, offline } = await prepare(browser, 1440);
  await page.goto(origin + '/#/online-recharge/chatgpt');
  await page.getByRole('button', { name: '系统配置', exact: true }).click();
  const frame = page.frameLocator('iframe[data-view="config"]:not([hidden])');
  const link = frame.getByRole('link', { name: '打开监控与通知' });
  await link.waitFor();
  assert.equal(await link.getAttribute('href'), route);
  assert.equal(await frame.locator('#telegram_bot_token').count(), 0);
  assert.deepEqual(offline.external, []);
  await context.close();

  const limited = await prepare(browser, 390, 'admin');
  t.after(() => limited.context.close());
  await limited.page.goto(origin + route);
  assert.equal(await limited.page.getByRole('button', { name: '保存渠道' }).count(), 0);
  await limited.page.evaluate(() => { location.hash = '#/monitor'; });
  await limited.page.getByRole('heading', { name: '代充付款待核实' }).waitFor();
  assert.equal(await limited.page.getByRole('button', { name: '登记已核实事件' }).count(), 0);
  assert.deepEqual(limited.errors, []);
});
