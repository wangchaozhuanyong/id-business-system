import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { CODEXDAICHONG_PREFIX } from '../modules/recharge/codexdaichong/gateway.mjs';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const fixtureRows = (count, build) => Array.from({ length: count }, (_, index) => build(index + 1));
const padded = (value) => String(value).padStart(3, '0');
const base = origin + CODEXDAICHONG_PREFIX;
const cdks = fixtureRows(125, (id) => ({
  code: `KC-FIXTURE-${padded(id)}`,
  status: 'unused',
  plan_type: 'plus'
}));
const cards = fixtureRows(27, (id) => ({ id, last4: padded(id), card_holder: `合成卡片 ${id}` }));
const logs = fixtureRows(24, (id) => ({
  id: `fixture-${id}`,
  cdk: `任务码 ${id}`,
  message: `合成任务 ${id}`,
  progress: 35,
  status: 'running'
}));
const holds = fixtureRows(13, (id) => ({
  id,
  accountEmail: `hold-${id}@example.test`,
  reason: `合成原因 ${id}`
}));

async function openFixture(browser, t, view, { embedded = false, ...options } = {}) {
  const context = await browser.newContext(options);
  t.after(() => context.close());
  const offline = await interceptDesign(context);
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => {
    assert.deepEqual(errors, []);
    assert.deepEqual(offline.external, []);
  });
  const reads = [];
  const failure = new Set();
  await page.route(base + '/api/admin/**', (route) => {
    const url = new URL(route.request().url());
    const key = url.pathname.slice((CODEXDAICHONG_PREFIX + '/api/admin/').length);
    const query = Object.fromEntries(url.searchParams);
    reads.push({ key, query });
    const send = (json, status = 200) => route.fulfill({ json, status });
    if (failure.has(key)) return send({ message: '离线模拟读取失败' }, 503);
    if (key === 'cdks') return send(cdks);
    if (key === 'cards') return send({ cards });
    if (key === 'task-logs') return send({ tasks: logs });
    if (key === 'activation-manual-holds') return send({ holds });
    if (key === 'data') return send({ stats: {}, config: {}, logs, manual_holds: holds });
    if (key === 'proxies')
      return send({
        success: true,
        proxies: fixtureRows(12, (id) => ({
          id,
          protocol: 'http',
          proxy_url_masked: `proxy-${id}.example.test`
        }))
      });
    if (key === 'addresses')
      return send({
        success: true,
        addresses: fixtureRows(12, (id) => ({ id, line1: `合成地址 ${id}`, country: 'US' }))
      });
    if (key === 'login-logs')
      return send({
        success: true,
        logs: fixtureRows(12, (id) => ({ admin_email: `login-${id}@example.test` }))
      });
    if (key === 'ip-bans')
      return send({
        success: true,
        bans: fixtureRows(12, (id) => ({ id, cidr: `192.0.2.${id}/32`, reason: `合成封禁 ${id}` }))
      });
    if (key === 'sessions') {
      const all = fixtureRows(query.search ? 16 : 62, (id) => ({
        job_key: `session-fixture-${id}`,
        cdk_code: `Session码 ${id}`,
        has_session: false,
        status: 'failed',
        message: `Session记录 ${id}`
      }));
      const offset = Number(query.offset);
      return send({ total: all.length, items: all.slice(offset, offset + Number(query.limit)) });
    }
    if (key === 'orbitcard/usage') {
      const start = (Number(query.page) - 1) * Number(query.page_size);
      const all = fixtureRows(63, (cardId) => ({ cardId, cardLast4: padded(cardId) }));
      return send({
        success: true,
        total: all.length,
        page: Number(query.page),
        cards: all.slice(start, start + Number(query.page_size))
      });
    }
    if (key === 'runtime-logs')
      return send({
        success: true,
        nextAfter: query.tail ? 8 : 9,
        entries:
          query.tail || query.after === '8'
            ? [{ text: query.tail ? '合成日志尾部' : '合成增量日志' }]
            : []
      });
    return route.fallback();
  });
  if (embedded) {
    await page.goto(origin + '/#/online-recharge/chatgpt');
    await page
      .getByRole('navigation', { name: 'ChatGPT 充值功能' })
      .getByRole('button', { name: 'CDK 管理' })
      .tap();
  } else {
    await page.goto(base + '/admin?view=' + view);
  }
  return { page, reads, failure };
}

const pager = (page, key) => page.locator(`nav[data-pagination="recharge-${key}"]`);
const current = (page, key, number, size) =>
  page
    .locator(
      `nav[data-pagination="recharge-${key}"][data-page="${number}"][data-page-size="${size}"]`
    )
    .waitFor();

test(
  'recharge admin uses shared pagination with original API and selection boundaries',
  { timeout: 60_000 },
  async (t) => {
    const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
    assert(playwright, '请通过 ID_RECHARGE_QA_PLAYWRIGHT 指定已有 Playwright 模块入口');
    const { chromium } = await import(pathToFileURL(playwright).href);
    const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
    t.after(() => browser.close());

    await t.test(
      'desktop CDK limits numeric pages and selection uses the actual visible page',
      async (t) => {
        const { page } = await openFixture(browser, t, 'cdks', {
          viewport: { width: 1440, height: 900 }
        });
        const nav = pager(page, 'cdk');
        await current(page, 'cdk', 1, 10);
        const nums = nav.locator('.pagination-pages button');
        assert((await nums.count()) <= 7);
        assert.equal(await nums.first().textContent(), '1');
        assert.equal(await nums.last().textContent(), '13');
        await nav.getByRole('button', { name: '下一页' }).click();
        await current(page, 'cdk', 2, 10);
        const rows = page.locator('#cdk_body tr');
        assert.equal(await rows.count(), 10);
        assert.match(await rows.first().textContent(), /KC-FIXTURE-011/);
        await page.getByRole('button', { name: '本页全选/取消' }).click();
        assert.equal(await page.locator('#cdk_body input:checked').count(), 10);
        await nav.getByRole('button', { name: '上一页' }).click();
        assert.equal(await page.locator('#cdk_body input:checked').count(), 0);
        await nav.getByLabel('每页条数').selectOption('50');
        await current(page, 'cdk', 1, 50);
        assert.equal(await rows.count(), 50);
        assert.equal(await page.locator('#cdk_body input:checked').count(), 10);
        await page.locator('#cdk_search').fill('KC-FIXTURE-119');
        await current(page, 'cdk', 1, 50);
        assert.equal(await rows.count(), 1);
        assert.match(await rows.first().textContent(), /KC-FIXTURE-119/);
      }
    );

    await t.test(
      'touch layout exposes next and jump without a horizontally scrolling page strip',
      async (t) => {
        const { page } = await openFixture(browser, t, 'cdks', {
          viewport: { width: 390, height: 844 },
          hasTouch: true,
          isMobile: true,
          embedded: true
        });
        const frame = page.frameLocator('.recharge-integration__content iframe:not([hidden])');
        const nav = pager(frame, 'cdk');
        await current(frame, 'cdk', 1, 10);
        assert.equal(await nav.locator('.pagination-pages').isVisible(), false);
        assert(await nav.getByRole('button', { name: '下一页' }).isVisible());
        await nav.locator('.pagination-jump summary').tap();
        await nav.getByLabel('跳至页码').fill('13');
        await nav.getByRole('button', { name: '跳转' }).tap();
        await current(frame, 'cdk', 13, 10);
        assert.equal(await frame.locator('#cdk_body tr').count(), 5);
        assert.equal(await nav.getByRole('button', { name: '下一页' }).isDisabled(), true);
        assert(await nav.evaluate((node) => node.scrollWidth <= node.clientWidth));
      }
    );

    await t.test(
      'Session uses original limit, offset and search, and keeps its confirmed page on failure',
      async (t) => {
        const { page, reads, failure } = await openFixture(browser, t, 'sessions');
        const nav = pager(page, 'session');
        await current(page, 'session', 1, 10);
        const queries = () =>
          reads.filter(({ key }) => key === 'sessions').map(({ query }) => query);
        assert.deepEqual(queries().at(-1), { limit: '10', offset: '0' });
        await nav.getByRole('button', { name: '下一页' }).click();
        await current(page, 'session', 2, 10);
        assert.deepEqual(queries().at(-1), { limit: '10', offset: '10' });
        assert.match(await page.locator('#session_body tr').first().textContent(), /Session码 11/);
        failure.add('sessions');
        const rejected = page.waitForResponse(
          (response) => response.url().includes('/api/admin/sessions?') && response.status() === 503
        );
        await nav.getByLabel('每页条数').selectOption('50');
        await rejected;
        await current(page, 'session', 2, 10);
        assert.equal(await nav.getByLabel('每页条数').inputValue(), '10');
        assert.match(await page.locator('#session_body tr').first().textContent(), /Session码 11/);
        failure.delete('sessions');
        await nav.getByLabel('每页条数').selectOption('20');
        await current(page, 'session', 1, 20);
        assert.deepEqual(queries().at(-1), { limit: '20', offset: '0' });
        await page.locator('#session_search').fill('离线查询');
        await page.locator('#session_search').press('Enter');
        await page.locator('nav[data-pagination="recharge-session"][data-total="16"]').waitFor();
        assert.deepEqual(queries().at(-1), { limit: '20', offset: '0', search: '离线查询' });
        assert.equal(await page.locator('#session_body tr.session-record').count(), 16);
      }
    );

    await t.test(
      'local card rows do not refetch and Orbitcard rows are not sliced again',
      async (t) => {
        const { page, reads } = await openFixture(browser, t, 'cards');
        const local = pager(page, 'card_pool');
        await current(page, 'card_pool', 1, 10);
        const cardReads = () => reads.filter(({ key }) => key === 'cards').length;
        const before = cardReads();
        await local.getByLabel('每页条数').selectOption('20');
        await local.getByRole('button', { name: '下一页' }).click();
        await current(page, 'card_pool', 2, 20);
        assert.equal(await page.locator('#card_pool_list_body tr').count(), 7);
        assert.equal(cardReads(), before);
        await page.getByRole('tab', { name: 'Orbitcard 用卡记录' }).click();
        const orbitcard = pager(page, 'orbitcard');
        await current(page, 'orbitcard', 1, 10);
        await orbitcard.getByLabel('每页条数').selectOption('50');
        await current(page, 'orbitcard', 1, 50);
        await orbitcard.getByRole('button', { name: '下一页' }).click();
        await current(page, 'orbitcard', 2, 50);
        const last = reads.filter(({ key }) => key === 'orbitcard/usage').at(-1).query;
        assert.equal(last.page, '2');
        assert.equal(last.page_size, '50');
        assert.equal(last.refresh, undefined);
        assert.equal(await page.locator('#orbitcard_usage_body tr').count(), 13);
        assert.equal(await page.locator('#orbitcard_usage_body tr td').first().textContent(), '51');
      }
    );

    await t.test(
      'proxy, address, login and ban collections keep their original requests and row actions',
      async (t) => {
        const { page, reads } = await openFixture(browser, t, 'proxies');
        for (const [view, key, tbody, resource, text] of [
          ['proxies', 'proxy_pool', '#proxy_pool_body', 'proxies', 'proxy-11.example.test'],
          ['tax_addresses', 'address', '#address_list_body', 'addresses', '合成地址 11'],
          [
            'admin_login_logs',
            'admin_login',
            '#admin_login_logs_body',
            'login-logs',
            'login-11@example.test'
          ],
          ['admin_login_logs', 'ip_ban', '#ip_ban_body', 'ip-bans', '192.0.2.11/32']
        ]) {
          if (view !== 'proxies' && key !== 'ip_ban')
            await page.evaluate((id) => window.idRechargeSelect(id), view);
          await current(page, key, 1, 10);
          const count = () => reads.filter((read) => read.key === resource).length;
          const before = count();
          await pager(page, key).getByRole('button', { name: '下一页' }).click();
          assert.equal(count(), before);
          assert.equal(await page.locator(`${tbody} tr`).count(), 2);
          assert((await page.locator(`${tbody} tr`).first().textContent()).includes(text));
        }
        assert.deepEqual(reads.find((read) => read.key === 'addresses').query, { region: 'US' });
        assert.deepEqual(reads.find((read) => read.key === 'login-logs').query, { limit: '100' });
        assert.equal(await page.locator('#ip_ban_body button[data-unban-id="11"]').count(), 1);
      }
    );

    await t.test(
      'task and manual hold snapshots use local paging while runtime log keeps its cursor stream',
      async (t) => {
        const { page } = await openFixture(browser, t, 'logs');
        await current(page, 'log', 1, 10);
        assert(await page.locator('#log_pagination .recharge-pagination-note').isVisible());
        await pager(page, 'log').getByRole('button', { name: '下一页' }).click();
        await current(page, 'log', 2, 10);
        assert.match(await page.locator('#log_body tr').first().textContent(), /合成任务 11/);
        await page.getByRole('tab', { name: '待人工确认' }).click();
        await current(page, 'manual_hold', 1, 10);
        await pager(page, 'manual_hold').getByRole('button', { name: '下一页' }).click();
        assert.equal(await page.locator('#activation_manual_hold_body tr').count(), 3);
        const runtime = await openFixture(browser, t, 'runtime_logs');
        await runtime.page
          .locator('#runtime_log_pre')
          .getByText(/合成增量日志/)
          .waitFor();
        assert.match(await runtime.page.locator('#runtime_log_pre').textContent(), /合成日志尾部/);
        assert(
          runtime.reads.some(({ key, query }) => key === 'runtime-logs' && query.after === '8')
        );
        assert.equal(await runtime.page.locator('#runtime_logs nav[data-pagination]').count(), 0);
      }
    );
  }
);
