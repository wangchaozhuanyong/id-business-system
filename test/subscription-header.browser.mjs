import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

const views = [['all', '全部订阅'], ['bank-cards', '按银行卡'], ['apple-ids', '按苹果 ID']];
const actor = { id: 'header-admin', name: '合成管理员', role: 'admin' };
const at = Date.now();
const record = { source: 'order', sourceId: 'header-bank', orderNo: 'SYNTHETIC-HEADER', plan: 'Plus',
  start: new Date(at - 86_400_000).toISOString(), expiry: new Date(at + 30 * 86_400_000).toISOString(),
  status: 'active', confirmed: true, remainingDays: 30, payment: '银行卡' };
function fixtures(empty) {
  const order = { id: record.sourceId, orderNo: record.orderNo, customerId: 'header-customer',
    email: 'subscriber@example.test', product: 'GPT', plan: 'Plus', source: '管理员手工',
    payment: '银行卡', cardId: 'recharge:7', paymentId: '4242', paidAmount: '20', paidCurrency: 'USD',
    saleAmount: '190', saleCurrency: 'CNY', paidConfirmed: true, receiptConfirmed: true,
    start: record.start, expiry: record.expiry, entitlementStatus: 'active', businessType: '首次开通',
    version: 1, corrections: [], financialEvidence: [] };
  return {
    inventory: { version: 1, data: { mailboxes: empty ? [] : [{ id: 'header-apple', type: 'apple',
      email: 'wallet@example.test', country: '马来西亚', appStoreRegion: 'US', status: '正常', health: 'normal' }],
      accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: [] } },
    commerce: { version: 1, data: { customers: empty ? [] : [{ id: 'header-customer', name: '合成客户' }],
      orders: empty ? [] : [order], tenants: [], operating: [], rentBatches: [], logs: [] } },
    settings: { version: 1, data: {} },
    appleBalance: { version: 1, data: { wallets: empty ? [] : [{ id: 'header-apple', balance: '250', currency: 'USD', version: 1 }],
      allocations: [], refunds: [], movements: [] } },
    'card-types': { version: 1, items: [], assignments: {} },
    'subscription-card-estimates': { items: [] }
  };
}
function subscriptions(empty) {
  return { items: empty ? [] : [{ id: 'header-account', product: 'GPT', account: 'subscriber@example.test',
    registrationEmail: 'subscriber@example.test', status: 'active', conflict: false, accountId: '',
    operatorName: actor.name, ownerEligible: false, series: [{ ...record, key: 'GPT' }], history: [record],
    contacts: {}, queryCode: { status: 'missing', remainingDays: null } }], total: empty ? 0 : 36,
    page: 1, pageSize: 20, counts: empty ? { active: 0, expired: 0, pending: 0, ended: 0 }
      : { active: 21, expired: 12, pending: 2, ended: 1 },
    scopeCounts: { all: empty ? 0 : 36 }, revision: 'synthetic-header-1', now: new Date(at).toISOString() };
}
function geometry() {
  const rect = el => el.getBoundingClientRect().toJSON();
  const bar = document.querySelector('.subscription-center-bar');
  const nav = bar.querySelector('.subscription-center-nav'), content = bar.querySelector('.subscription-center-content');
  const textRect = el => { const range = document.createRange(); range.selectNodeContents(el); return rect(range); };
  return { bar: rect(bar), nav: rect(nav), content: rect(content),
    links: [...nav.children].map(rect), overflow: document.documentElement.scrollWidth > innerWidth,
    items: [...content.querySelectorAll('.summary-item')].map(item => ({ ...rect(item),
      label: textRect(item.querySelector('.summary-label')), value: textRect(item.querySelector('.summary-number')) })) };
}

test('订阅导航与当前内容共用一行，覆盖三种视图、宽窄屏、主题与读取状态', { timeout: 180_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const width of [1920, 1440, 1024, 901, 900, 768, 390, 320]) {
    for (const theme of ['light', 'dark']) for (const empty of [false, true]) {
      await t.test(`${width}px ${theme} ${empty ? '空列表' : '有数据'}`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
        try {
          const traffic = await interceptDesign(context, { localFixtures: fixtures(empty), actor, skipRechargeAssets: true });
          let fail = false, delay = 0;
          await context.route(origin + '/api/local/subscriptions/list', async route => {
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            return route.fulfill(fail ? { status: 503, json: { error: '合成读取失败' } } : { json: subscriptions(empty) });
          });
          const page = await context.newPage(), errors = [], writes = [];
          page.setDefaultTimeout(6500);
          page.on('pageerror', error => errors.push(error.message));
          page.on('request', request => {
            if (!['GET', 'HEAD'].includes(request.method()) && /\/api\/local\/(commerce|inventory|appleBalance)$/.test(request.url()))
              writes.push(request.url());
          });
          await page.goto(origin + '/#/subscriptions/all');
          await page.waitForFunction(total => document.querySelector('#subscription-overview .summary-number')?.textContent.startsWith(total), empty ? '0' : '36');
          if (theme === 'dark') await toggleDesignTheme(page);
          const heights = [];
          for (const [view, label] of views) {
            await page.getByRole('navigation', { name: '订阅管理视图' }).getByRole('link', { name: label, exact: true }).click();
            await page.locator(`#main[data-layout-route="subscriptions/${view}"]`).waitFor();
            const tableName = { all: 'subscription-accounts', 'bank-cards': 'commerce-bank-card-groups', 'apple-ids': '苹果 ID 管理' }[view];
            const rows = page.locator(`table[data-table="${tableName}"] tbody tr[data-row-id]`);
            if (!empty) await rows.first().waitFor({ state: 'attached' });
            assert.equal(await rows.count(), empty ? 0 : 1, '保留当前视图的实际记录与空态');
            if (view === 'apple-ids') await page.waitForFunction(total =>
              document.querySelector('.subscription-center-content .summary-number')?.textContent.startsWith(total), empty ? '0' : '1');
            await settle(page);
            assert.equal(await page.locator('.subscription-center-bar').count(), 1);
            assert.equal(await page.getByRole('navigation', { name: '订阅管理视图' }).getByRole('link', { name: label, exact: true }).getAttribute('aria-current'), 'page');
            const size = await page.evaluate(geometry);
            heights.push(size.bar.height);
            results.push({ width, theme, empty, view, ...size });
            assert.equal(size.overflow, false);
            assert(size.links.every(link => link.left >= size.bar.left && link.right <= size.bar.right && link.top - size.bar.top >= 8 && size.bar.bottom - link.bottom >= 8));
            if (width >= 1440) {
              assert(size.content.left > size.nav.right, '宽屏主导航在左、当前内容在右');
              assert(Math.abs(size.nav.y + size.nav.height / 2 - size.content.y - size.content.height / 2) <= 1, '导航与内容垂直居中');
            } else assert(size.content.top >= size.nav.bottom + 8, '不足一行时整组换行并保留间距');
            if (view !== 'bank-cards') {
              assert.equal(size.items.length, view === 'all' ? 5 : 4, '所有统计项仍然存在');
              for (const item of size.items) {
                assert(Math.abs(item.y - size.items[0].y) <= 1, '统计不再拆成上下两行');
                assert(Math.abs(item.label.y - size.items[0].label.y) <= 1, '标签真实文字对齐');
                assert(Math.abs(item.value.y - size.items[0].value.y) <= 1, '数字真实文字对齐');
                assert(item.value.left >= item.label.right, '数字在标签右侧且不重叠');
              }
              if (width <= 390) {
                const scroll = page.getByRole('group', { name: '当前视图统计' });
                await scroll.focus();
                const steps = await scroll.evaluate(node => Math.ceil((node.scrollWidth - node.clientWidth) / 20) + 2);
                for (let step = 0; step < steps; step++) await scroll.press('ArrowRight', { delay: 40 });
                await page.waitForFunction(() => {
                  const node = document.querySelector('.subscription-center-content');
                  return node.scrollLeft >= node.scrollWidth - node.clientWidth - 1;
                });
                const last = await page.locator('.subscription-center-content .summary-item').last().boundingBox();
                assert(last.x + last.width <= size.content.right + 1, '键盘可查看最右侧统计');
                for (let step = 0; step < steps; step++) await scroll.press('ArrowLeft', { delay: 40 });
                await page.waitForFunction(() => document.querySelector('.subscription-center-content').scrollLeft <= 1);
              }
            } else {
              if (!empty) {
                await rows.getByRole('button', { name: '查看关联订单', exact: true }).click();
                await page.locator('#drawer[open]').getByText(record.orderNo, { exact: true }).waitFor();
                await page.locator('#drawer[open]').getByRole('button', { name: '关闭', exact: true }).click();
              }
              for (const tab of ['订阅用卡明细', '冻结银行卡', '按卡汇总']) {
                await page.getByRole('tab', { name: tab, exact: true }).click();
                assert.equal(await page.getByRole('tab', { name: tab, exact: true }).getAttribute('aria-selected'), 'true');
                assert(Math.abs((await page.locator('.subscription-center-bar').boundingBox()).height - size.bar.height) <= 1);
              }
            }
            if (output && [1440, 390].includes(width) && !empty) {
              await settle(page);
              await page.locator('.subscription-center-bar').screenshot({ path: join(output, `${view}-${width}-${theme}.png`) });
            }
          }
          assert(Math.max(...heights) - Math.min(...heights) <= 1, '三个视图的顶部栏高一致');
          if (!empty && theme === 'light' && [1440, 390].includes(width)) {
            await page.evaluate(() => {
              window.headerFrames = []; window.headerRecording = true;
              const frame = () => {
                const bar = document.querySelector('.subscription-center-bar');
                window.headerFrames.push({ route: location.hash, height: bar?.getBoundingClientRect().height ?? null });
                if (window.headerRecording) requestAnimationFrame(frame);
              };
              requestAnimationFrame(frame);
            });
            delay = 300;
            for (const [, label] of [views[1], views[2], views[0]])
              await page.getByRole('navigation', { name: '订阅管理视图' }).getByRole('link', { name: label, exact: true }).click();
            await page.waitForFunction(() => document.querySelector('#subscription-overview .summary-number')?.textContent.startsWith('36'));
            const frames = await page.evaluate(() => { window.headerRecording = false; return window.headerFrames; });
            assert(frames.length > 0 && frames.every(frame => frame.height !== null && Math.abs(frame.height - heights[0]) <= 1), '慢读取与连续切换期间栏高稳定');
            if (output) await writeFile(join(output, `frames-${width}.json`), JSON.stringify(frames, null, 2));
            delay = 0; fail = true;
            await page.getByRole('button', { name: '刷新', exact: true }).click();
            await page.getByText('读取订阅资料失败，请刷新重试，已保留上次读取的资料。', { exact: true }).waitFor();
            assert.match(await page.locator('#subscription-overview').innerText(), /36/);
            assert.equal((await page.locator('.subscription-center-bar').boundingBox()).height, heights[0]);
          }
          assert.deepEqual(errors, []); assert.deepEqual(writes, []);
          assert.deepEqual(traffic.external, []); assert.deepEqual(traffic.unavailable, []);
        } finally { await context.close(); }
      });
    }
  }
  if (output) await writeFile(join(output, 'geometry.json'), JSON.stringify(results, null, 2));
});
