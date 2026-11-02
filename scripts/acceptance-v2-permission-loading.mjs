#!/usr/bin/env node
/* global window, document, innerWidth, MutationObserver */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { chromium } from 'playwright';

// Builds actual components and intercepts every browser request. No server or database starts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.runtime/permission-loading-20261102');
const outDir = join(output, 'browser-build');
await mkdir(output, { recursive: true });
await writeFile(
  join(output, 'index.html'),
  '<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>'
);
await writeFile(
  join(output, 'fixture.js'),
  String.raw`
import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import '@/v2/styles/records.css';
import { createApp, h, reactive } from 'vue';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import VendureMailboxManager from '@/v2/features/auto-recharge/VendureMailboxManager.vue';
import V2TopupSupplierPaymentAccountField from '@/v2/features/topup-records/components/V2TopupSupplierPaymentAccountField.vue';
import V2ProxyPoolView from '@/v2/features/proxy-pool/V2ProxyPoolView.vue';
import { vendureMailboxApi } from '@/v2/features/auto-recharge/vendure-mailbox-api';
import { idBusinessV2TopupSupplierFundsApi } from '@/v2/features/topup-records/api';
import { clearV2QueryCache } from '@/v2/composables/useV2Query';
import { applyV2Theme } from '@/v2/theme';
import { v2PaginationLabel } from '@/v2/directives/paginationLabel';
import { v2TableColumnVisibility } from '@/v2/directives/tableColumnVisibility';

const now = '2026-11-02T10:00:00.000Z';
const controls = reactive({
  mode: 'mailbox', visible: true, phase: 'disabled', forbidden: false,
  fieldEnabled: false, configured: true, connected: true, failStatus: false,
  holdStatus: true, holdHealth: true, holdField: true,
  statusReads: 0, healthReads: 0, fieldReads: 0,
  releaseStatus: () => {}, releaseHealth: () => {}, releaseField: () => {},
  clear: clearV2QueryCache, theme: applyV2Theme
});
window.permissionFixture = controls;
const page = (items) => ({ items, total: items.length, page: 1, pageSize: 20 });
Object.assign(vendureMailboxApi, {
  status: async () => {
    controls.statusReads++;
    if (controls.holdStatus) await new Promise(resolve => { controls.releaseStatus = resolve; });
    if (controls.failStatus) throw new Error('模拟连接检查失败');
    return { configured: controls.configured, connected: controls.connected, message: null };
  },
  health: async () => {
    controls.healthReads++;
    if (controls.holdHealth) await new Promise(resolve => { controls.releaseHealth = resolve; });
    return { status: 'unsupported', checkedAt: now, listeners: [], delivery: null };
  },
  primaryAccounts: async () => page([{
    id: 'primary-fixture', email: 'fixture@example.invalid', note: '合成资料', status: 'ACTIVE',
    createdAt: now, updatedAt: now, imapHost: 'imap.example.invalid', imapPort: 993,
    masterQueryCode: 'MSTR-FIXTURE', codeExpiresAt: '2026-12-02T10:00:00Z',
    codeResetIntervalDays: 30, remainingDays: 30, lastQueriedAt: null, lastQueriedIp: null,
    lastSyncedAt: null, lastSyncError: null, virtualEmailCount: 0
  }]),
  aliases: async () => page([]),
  mails: async () => page([])
});
Object.assign(idBusinessV2TopupSupplierFundsApi, {
  listPaymentAccounts: async () => {
    controls.fieldReads++;
    if (controls.holdField) await new Promise(resolve => { controls.releaseField = resolve; });
    return { items: [] };
  }
});
const app = createApp({
  setup: () => () => h('main', { class: 'v2-page-layout', style: 'padding:16px;min-width:0' }, [
    !controls.visible ? null :
    controls.mode === 'mailbox' ? h(VendureMailboxManager) :
    controls.mode === 'proxy' ? h(V2ProxyPoolView) :
    controls.mode === 'field' ? h(V2TopupSupplierPaymentAccountField, {
      enabled: controls.fieldEnabled, modelValue: ''
    }) : h(V2AsyncRegion, {
      phase: controls.phase, forbidden: controls.forbidden, loadingTitle: '正在读取模拟资料',
      skeleton: 'table', error: controls.phase.endsWith('error') ? '模拟读取失败' : '',
      onRetry: () => { controls.phase = 'ready'; }
    }, {
      default: () => h('p', { 'data-content': true }, '上次成功资料'),
      'error-action': () => h('button', { onClick: () => { controls.phase = 'ready'; } }, '重试读取')
    })
  ])
});
app.use(createPinia());
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/', component: { render: () => null } }]
});
app.use(router);
await router.isReady();
app.directive('pagination-label', v2PaginationLabel);
app.directive('v2-column-visibility', v2TableColumnVisibility);
app.mount('#app');
`
);
await build({
  configFile: false,
  root: output,
  logLevel: 'error',
  define: { __V2_BUILD_ID__: JSON.stringify('permission-loading-fixture') },
  resolve: { alias: { '@': join(root, 'apps/admin/src') } },
  plugins: [
    AutoImport({ dts: false, resolvers: [ElementPlusResolver({ importStyle: 'css' })] }),
    Components({ dts: false, resolvers: [ElementPlusResolver({ importStyle: 'css' })] }),
    vue()
  ],
  build: { outDir, emptyOutDir: true }
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const checks = [];
const errors = [];
const unexpectedRequests = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(10_000);
await page.addInitScript(() => {
  globalThis.permissionDenials = [];
  new MutationObserver((records) => {
    for (const record of records) {
      for (const element of record.addedNodes) {
        if (element.nodeType !== 1) continue;
        if (
          element.matches('.v2-page-state--forbidden') ||
          element.querySelector('.v2-page-state--forbidden')
        ) {
          globalThis.permissionDenials.push(element.textContent);
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
});
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== 'https://permission-loading.test' || url.pathname.startsWith('/api')) {
    unexpectedRequests.push(url.pathname);
    await route.abort();
    return;
  }
  const file = join(outDir, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  try {
    await route.fulfill({
      body: await readFile(file),
      contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[
        extname(file)
      ]
    });
  } catch {
    await route.fulfill({ status: 404, body: '' });
  }
});
const control = (input) =>
  page.evaluate((value) => Object.assign(window.permissionFixture, value), input);
const wait = (predicate) => page.waitForFunction(predicate);
const mark = (name) => checks.push(name);
const noDenial = async () =>
  assert.deepEqual(await page.evaluate(() => window.permissionDenials), []);
try {
  await page.goto('https://permission-loading.test/');
  await wait(() => window.permissionFixture.statusReads === 1);
  assert.equal(await page.evaluate(() => window.permissionFixture.healthReads), 0);
  assert.equal(await page.locator('.v2-page-state--loading').count(), 1);
  await noDenial();
  mark('慢速配置检查：下游健康查询未启用，仅主查询加载，无权限误报');
  await page.evaluate(() => window.permissionFixture.releaseStatus());
  await wait(() => window.permissionFixture.healthReads === 1);
  await page.getByText('fixture@example.invalid', { exact: true }).first().waitFor();
  await noDenial();
  await page.evaluate(() => {
    window.permissionFixture.holdHealth = false;
    window.permissionFixture.releaseHealth();
  });
  await page.getByText('自动收信状态', { exact: true }).first().waitFor();
  mark('配置成功后启用健康查询，列表与健康信息正常显示');

  for (let index = 0; index < 5; index++) {
    await control({ visible: false });
    await page.locator('.vendure-mailbox-page').waitFor({ state: 'detached' });
    await control({ visible: true });
    await page.getByText('fixture@example.invalid', { exact: true }).first().waitFor();
    assert.equal(await page.locator('.v2-page-state--loading').count(), 0);
  }
  assert.equal(await page.evaluate(() => window.permissionFixture.statusReads), 1);
  assert.equal(await page.evaluate(() => window.permissionFixture.healthReads), 1);
  await noDenial();
  mark('连续离开返回五次：复用连接与健康缓存，无权限闪现及重复读取');
  for (const name of ['虚拟邮箱管理', '收件记录', '主邮箱管理']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    await noDenial();
  }
  mark('主邮箱、虚拟邮箱及收件记录切换无权限闪现');

  for (const [configured, connected, failStatus, expected] of [
    [false, false, false, '邮箱互通尚未配置'],
    [true, false, false, '邮箱互通连接异常'],
    [true, true, true, '邮箱互通配置检查失败']
  ]) {
    await control({ visible: false });
    await page.locator('.vendure-mailbox-page').waitFor({ state: 'detached' });
    await page.evaluate(() => window.permissionFixture.clear());
    await control({
      configured,
      connected,
      failStatus,
      holdStatus: false,
      holdHealth: false,
      visible: true
    });
    await page.getByText(expected, { exact: true }).waitFor();
    assert.equal(await page.locator('.v2-page-state--forbidden').count(), 0);
    assert.equal(await page.locator('.v2-page-state--loading').count(), 0);
    await noDenial();
    mark(expected + '：保留真实反馈，无权限误报或下游持续加载');
  }
  await control({ failStatus: false });
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await page.getByText('fixture@example.invalid', { exact: true }).first().waitFor();
  await noDenial();
  mark('连接检查失败后可原地重试恢复');

  await control({ mode: 'field' });
  await page.locator('.vendure-mailbox-page').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.v2-async-region').count(), 0);
  assert.equal(await page.evaluate(() => window.permissionFixture.fieldReads), 0);
  await control({ fieldEnabled: true });
  await wait(() => window.permissionFixture.fieldReads === 1);
  await page.evaluate(() => window.permissionFixture.releaseField());
  await page.getByText('请先在财务记账建立启用的 USDT 资金账户。', { exact: true }).waitFor();
  await noDenial();
  mark('加卡付款账户字段：条件未满足时不读取、不误报，启用后正确显示空状态');

  await control({ mode: 'shared', phase: 'ready' });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => window.permissionFixture.theme(value), theme);
    for (const width of [1440, 1024, 901, 900, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const phase of [
        'disabled',
        'idle',
        'initial-loading',
        'ready',
        'refreshing',
        'transitioning',
        'refresh-error'
      ]) {
        await control({ phase });
        await page.waitForFunction((value) => {
          const element = document.querySelector('.v2-async-region');
          return value === 'disabled' ? !element : element?.dataset.v2QueryPhase === value;
        }, phase);
        assert.equal(
          await page.locator('[data-content]').count(),
          ['ready', 'refreshing', 'transitioning', 'refresh-error'].includes(phase) ? 1 : 0
        );
        const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
        assert.ok(fits, theme + '/' + width + '/' + phase + ' 不得横向溢出');
      }
      await page.screenshot({ path: join(output, theme + '-' + width + '.png'), fullPage: true });
    }
  }
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.locator('[data-content]').waitFor();
  await noDenial();
  mark('共享区域两主题六尺寸：等待、加载、刷新、参数过渡、失败保留及重试，无内容泄漏或溢出');

  await control({ mode: 'proxy' });
  await page.getByText('权限不足', { exact: true }).waitFor();
  assert.equal(await page.locator('.v2-records-table').count(), 0);
  mark('实际代理池页面无读取权限时明确拒绝，业务表格不渲染');
  await control({ mode: 'shared', phase: 'disabled', forbidden: true });
  await page.getByText('权限不足', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-content]').count(), 0);
  mark('显式拒绝优先于查询未启用，受限内容不渲染');
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      { ok: true, checks, errors, unexpectedRequests, businessWrites: 0, localServers: 0 },
      null,
      2
    )
  );
  console.log(JSON.stringify({ ok: true, checks: checks.length, output }));
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify({ checks, errors, unexpectedRequests, error: error.message }, null, 2)
  );
  throw error;
} finally {
  await browser.close();
}
