import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const sample = {
  id: '00000000-0000-4000-8000-000000000001',
  country: 'US',
  line1: '3825 Cedar Ln',
  city: 'Salem',
  state: 'Oregon',
  postalCode: '97302',
  status: 'unused',
  usedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z'
};
const another = {
  ...sample,
  id: '00000000-0000-4000-8000-000000000002',
  line1: '4028 Maple Dr'
};
const addressText = [
  '国家：United States',
  '街道地址：3825 Cedar Ln',
  '州：Oregon',
  '城市：Salem',
  '邮编：97302'
].join('\n');

async function mockAddresses(context) {
  let version = 1;
  let rows = [
    sample,
    another,
    ...Array.from({ length: 21 }, (_, index) => ({
      ...sample,
      id: '00000000-0000-4000-9000-' + String(index).padStart(12, '0'),
      line1: `${1100 + index} Synthetic St`,
      status: 'used',
      usedAt: '2026-11-02T00:00:00.000Z'
    }))
  ];
  const writes = [];
  let failMark = true;
  await context.route('**/api/local/bitbrowser-addresses*', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      const search = new URL(req.url()).searchParams;
      const page = Number(search.get('page'));
      const pageSize = Number(search.get('pageSize'));
      const status = search.get('status');
      const keyword = search.get('keyword');
      const matches = rows.filter((item) => item.status === status && item.line1.includes(keyword));
      if (status === 'used') matches.sort((a, b) => b.usedAt.localeCompare(a.usedAt));
      return route.fulfill({
        json: {
          version, page, pageSize,
          items: matches.slice((page - 1) * pageSize, page * pageSize),
          total: matches.length,
          totals: {
            unused: rows.filter((item) => item.status === 'unused').length,
            used: rows.filter((item) => item.status === 'used').length
          }
        }
      });
    }
    assert.equal(req.method(), 'PUT');
    const payload = req.postDataJSON();
    writes.push(payload);
    if (payload.deleteUsed) {
      if (payload.version !== version)
        return route.fulfill({ status: 409, json: { error: '地址列表已更新，请重新确认' } });
      const previous = rows.length;
      rows = rows.filter((item) => item.status !== 'used');
      version++;
      return route.fulfill({ json: { deleted: previous - rows.length } });
    }
    assert.deepEqual(payload, { id: sample.id, status: 'used', expectedStatus: 'unused' });
    if (failMark) {
      failMark = false;
      return route.fulfill({ status: 503, json: { error: '合成写入失败' } });
    }
    const used = { ...sample, status: 'used', usedAt: '2026-11-09T00:00:00.000Z' };
    rows = rows.map((item) => item.id === used.id ? used : item);
    version++;
    return route.fulfill({ json: used });
  });
  return { writes, changeVersion: () => version++, rows: () => rows };
}

test('比特登录右侧地址库支持复制、重试标记和按快照批量删除', async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());

  for (const width of [1440, 390]) {
    await t.test(width + 'px', { timeout: 30_000 }, async (t) => {
      const context = await browser.newContext({ viewport: { width, height: 920 }, locale: 'zh-CN' });
      t.after(() => context.close());
      const actor = { id: 'address-qa', name: '合成管理员', role: 'admin' };
      await interceptDesign(context, { actor, localFixtures: {} });
      const server = await mockAddresses(context);
      await context.addInitScript(() => {
        window.addressClipboard = { fail: true, copied: [] };
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            async writeText(text) {
              if (window.addressClipboard.fail) throw new DOMException('Synthetic clipboard refusal', 'NotAllowedError');
              window.addressClipboard.copied.push(text);
            }
          }
        });
      });

      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin + '/#/recharge/start');
      const frame = page.frameLocator('.recharge-integration__frame--bit-local');
      const login = page.locator('[data-recharge-module="bit"]');
      const panel = page.getByRole('complementary', { name: '地址管理' });
      await panel.getByRole('heading', { name: '地址管理' }).waitFor();
      await frame.locator('#bit-window-name').waitFor();
      if (width === 1440) await page.locator('#theme-toggle').click();
      const formBox = await login.boundingBox();
      const addressBox = await panel.boundingBox();
      if (width === 1440) {
        assert(addressBox.x >= formBox.x + formBox.width);
        assert(Math.abs(addressBox.y - formBox.y) <= 1);
      } else {
        assert(addressBox.y >= formBox.y + formBox.height);
        await page.getByRole('button', { name: '前往地址管理' }).click();
        assert.equal(await panel.evaluate((node) => node === document.activeElement), true);
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await frame.locator('#bit-window-name').fill('保留的测试窗口名称');

      const tabs = panel.getByRole('tablist', { name: '地址状态' });
      const unused = tabs.getByRole('tab', { name: /^未使用/ });
      const used = tabs.getByRole('tab', { name: /^已使用/ });
      assert.equal(await tabs.getByRole('tab').count(), 2);
      const row = panel.getByRole('row').filter({ hasText: sample.line1 });
      await row.getByRole('button', { name: '复制地址' }).click();
      const fallback = page.getByRole('dialog', { name: '复制内容' });
      assert.equal(await fallback.getByRole('textbox').inputValue(), addressText);
      await fallback.getByRole('button', { name: '关闭抽屉' }).click();
      assert.deepEqual(server.writes, []);
      await page.evaluate(() => { window.addressClipboard.fail = false; });

      await row.getByRole('button', { name: '复制地址' }).click();
      await panel.getByText(/地址已复制，标记暂未完成/).waitFor();
      assert.equal(server.writes.length, 1);
      assert.deepEqual(await page.evaluate(() => window.addressClipboard.copied), [addressText]);
      await row.getByRole('button', { name: '重试标记' }).click();
      await panel.getByText('地址已复制并移入已使用。', { exact: true }).waitFor();
      await row.waitFor({ state: 'hidden' });
      assert.equal(server.writes.length, 2);
      assert.deepEqual(await page.evaluate(() => window.addressClipboard.copied), [addressText]);
      assert.equal(await frame.locator('#bit-window-name').inputValue(), '保留的测试窗口名称');

      await unused.focus();
      await unused.press('ArrowRight');
      await row.waitFor();
      assert.equal(await used.getAttribute('aria-selected'), 'true');
      const pager = panel.locator('[data-pagination="bitbrowser-addresses"]');
      assert.equal(await pager.locator('[data-pagination-size]').inputValue(), '10');
      await pager.getByRole('button', { name: '下一页', exact: true }).click();
      await panel.locator('[data-pagination="bitbrowser-addresses"][data-page="2"][data-total="22"]').waitFor();
      const remove = panel.getByRole('button', { name: '一键删除已使用' });
      const dialog = page.getByRole('dialog', { name: '删除已使用地址' });
      await remove.click();
      await dialog.getByText(/22 条已使用地址，包含所有分页/).waitFor();
      await dialog.getByRole('button', { name: '取消' }).click();
      assert.equal(server.writes.length, 2);

      await remove.click();
      server.changeVersion();
      await dialog.getByRole('button', { name: '确认删除' }).click();
      await panel.getByText(/地址列表已更新，请重新确认/).waitFor();
      assert.equal(server.rows().length, 23);
      await remove.click();
      await dialog.getByRole('button', { name: '确认删除' }).click();
      await panel.getByText('已删除 22 条已使用地址。', { exact: true }).waitFor();
      await panel.getByText('暂无已使用地址', { exact: true }).waitFor();
      assert.deepEqual(server.rows(), [another]);
      assert.equal(await remove.isDisabled(), true);
      await unused.click();
      await panel.getByText(another.line1, { exact: true }).waitFor();
      assert.equal(await panel.getByRole('button', { name: /停用|启用|标记已使用/ }).count(), 0);
      assert.deepEqual(errors, []);
    });
  }
});
