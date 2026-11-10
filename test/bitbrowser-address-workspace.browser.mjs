import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listBitBrowserAddresses } from '../server/bitbrowser-addresses.mjs';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

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
      assert.equal(await pager.locator('[data-pagination-size]').inputValue(), '20');
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

test('左右顶部栏、文字和内容起点对齐，页签切换和窄屏保持一致', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 2040, height: 1100 }, locale: 'zh-CN' });
  const actor = { id: 'heading-qa', name: '离线验收员', role: 'admin' };
  const requests = await interceptDesign(context, { actor, localFixtures: {} });
  await context.route('**/api/local/bitbrowser-addresses*', route => {
    assert.equal(route.request().method(), 'GET', '对齐验收只读取隔离资料');
    return route.fulfill({ json: { version: 1, page: 1, pageSize: 10, items: [], total: 0, totals: { unused: 0, used: 0 } } });
  });
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const page = await context.newPage();
  const errors = [], measurements = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/recharge/start');
  const frame = page.frameLocator('.recharge-integration__frame--bit-local');
  await frame.locator('.bit-local--embedded').waitFor();
  await frame.locator('#bit-window-name').fill('布局验收草稿');
  await page.locator('#bit-address-heading').waitFor();
  const measure = () => page.evaluate(() => {
    const iframe = document.querySelector('.recharge-integration__frame--bit-local');
    const inner = iframe.contentDocument;
    const read = (heading, label, offset, content) => {
      const box = heading.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(label.firstChild);
      const text = range.getBoundingClientRect(), style = getComputedStyle(label);
      return { top: box.top + offset, bottom: box.bottom + offset, height: box.height,
        textTop: text.top + offset, textHeight: text.height, lineHeight: style.lineHeight, fontSize: style.fontSize,
        textInset: text.left - box.left, contentTop: content.getBoundingClientRect().top + offset };
    };
    const tab = inner.querySelector('.bit-local__workspace-bar [aria-selected="true"]');
    const left = read(inner.querySelector('.bit-workspace-heading'), tab, iframe.getBoundingClientRect().top,
      inner.querySelector('#bit-login-panel:not([hidden]) .bit-local__section, #bit-library-panel:not([hidden])'));
    const right = read(document.querySelector('#bit-addresses-panel .bit-workspace-heading'),
      document.querySelector('#bit-address-heading'), 0, document.querySelector('.bit-address-source-toolbar'));
    return { left, right, hostOverflow: document.documentElement.scrollWidth - innerWidth,
      frameOverflow: inner.documentElement.scrollWidth - iframe.clientWidth };
  });
  for (const width of [2040, 1440, 1180, 1024, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const theme of ['light', 'dark']) {
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await page.locator('#theme-toggle').click();
      for (const view of ['login', 'library', 'login']) {
        await frame.locator('#bit-tab-' + view).click();
        await settle(page);
        const result = await measure();
        const { left, right } = result;
        assert.equal(left.height, right.height, '顶部栏高度一致');
        assert.equal(left.fontSize, right.fontSize, '字号一致');
        assert.equal(left.lineHeight, right.lineHeight, '行高一致');
        assert(Math.abs((left.textTop - left.top) - (right.textTop - right.top)) <= 1, '真实文字顶边一致');
        if (view === 'login') assert(Math.abs(left.textInset - right.textInset) <= 1, '首个标题左右内距一致');
        assert(Math.abs((left.contentTop - left.bottom) - (right.contentTop - right.bottom)) <= 1, '内容区起始留白一致');
        if (width >= 1180) {
          assert(Math.abs(left.bottom - right.bottom) <= 1, '左右分隔线对齐');
          assert(Math.abs(left.textTop - right.textTop) <= 1, '左右实际文字对齐');
        }
        assert(result.hostOverflow <= 0 && result.frameOverflow <= 0,
          `${width}px ${theme} ${view} 横向溢出，宿主 ${result.hostOverflow}px，嵌入页 ${result.frameOverflow}px`);
        measurements.push({ width, theme, view, ...result });
      }
      assert.equal(await frame.locator('#bit-window-name').inputValue(), '布局验收草稿');
      if (output && [2040, 390].includes(width)) {
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: join(output, `bit-workspace-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
      }
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
  assert.deepEqual(requests.unavailable, []);
  if (output) await writeFile(join(output, 'heading-geometry.json'), JSON.stringify(measurements, null, 2));
});

test('地址生成收到保存回执后提示成功并自动消失，写入失败及刷新失败不混淆', async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const width of [1440, 390]) await t.test(width + 'px', { timeout: 30_000 }, async (t) => {
    const context = await browser.newContext({ viewport: { width, height: 920 } });
    t.after(() => context.close());
    const traffic = await interceptDesign(context, { actor: { id: 'address-qa', name: '离线管理员', role: 'admin' }, localFixtures: {} });
    let rows = [sample], version = 1, writes = 0, failWrite = false, failRead = false;
    const writeStarted = Promise.withResolvers(), releaseWrite = Promise.withResolvers();
    const refreshStarted = Promise.withResolvers(), releaseRefresh = Promise.withResolvers();
    t.after(() => { releaseWrite.resolve(); releaseRefresh.resolve(); });
    await context.route('**/api/local/bitbrowser-addresses*', async (route) => {
      if (route.request().method() === 'GET') {
        if (version === 2) { refreshStarted.resolve(); await releaseRefresh.promise; }
        if (failRead) return route.fulfill({ status: 503, json: { error: '列表读取失败' } });
        return route.fulfill({ json: { ...listBitBrowserAddresses(rows, new URL(route.request().url()).searchParams), version } });
      }
      assert.equal(route.request().method(), 'PUT');
      assert.deepEqual(route.request().postDataJSON(), { count: 3 });
      writes++;
      if (writes === 1) { writeStarted.resolve(); await releaseWrite.promise; }
      if (failWrite) return route.fulfill({ status: 503, json: { error: '地址保存失败，请重试' } });
      version++;
      const items = Array.from({ length: 3 }, (_, index) => ({ ...sample, id: `generated-${version}-${index}`, line1: `${version}${index} Fixture Lane` }));
      rows.push(...items);
      return route.fulfill({ json: { count: items.length, items } });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.clock.install();
    await page.goto(origin + '/#/recharge/start');
    if (width === 390) await page.locator('#theme-toggle').click();
    const generate = page.locator('#bit-address-generate-button'), toast = page.locator('#toast');
    const notice = page.locator('#bit-address-feedback');
    await page.locator('#bit-address-list').getByText(sample.line1, { exact: true }).waitFor();
    await page.locator('#bit-address-generate-count').fill('3');
    await generate.click();
    await writeStarted.promise;
    assert(await generate.isDisabled());
    assert(await toast.isHidden(), '保存尚未确认时不能提示成功');
    await page.locator('#bit-address-generate').dispatchEvent('submit');
    assert.equal(writes, 1, '保存中不能重复生成');
    releaseWrite.resolve();
    await refreshStarted.promise;
    await toast.getByText('已成功生成 3 条地址', { exact: true }).waitFor();
    assert.equal(await toast.getAttribute('data-kind'), 'success');
    assert.equal(await toast.getAttribute('role'), 'status');
    assert(await notice.isHidden(), '保存完成后不应残留正在保存');
    const box = await toast.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width && box.y >= 0);
    await page.clock.fastForward(2000);
    assert(await toast.isVisible(), '成功提示应留出阅读时间');
    releaseRefresh.resolve();
    await page.waitForFunction(() => !document.querySelector('#bit-address-generate-button').disabled);
    assert(await notice.isHidden(), '列表刷新后不应留下重复成功提示');
    if (process.env.ID_LAYOUT_QA_OUTPUT) {
      await mkdir(process.env.ID_LAYOUT_QA_OUTPUT, { recursive: true });
      await page.screenshot({ path: join(process.env.ID_LAYOUT_QA_OUTPUT, `generation-success-${width}.png`) });
    }
    await page.clock.fastForward(2500);
    assert(await toast.isHidden(), '成功提示应自动消失');

    failWrite = true;
    await generate.click();
    await notice.getByText('地址保存失败，请重试', { exact: true }).waitFor();
    await page.clock.fastForward(5000);
    assert(await toast.isHidden(), '写入失败不得弹出成功提示');
    assert(await notice.isVisible(), '失败原因应保留以便重试');
    assert.equal(await page.locator('#bit-address-generate-count').inputValue(), '3');
    failWrite = false;
    failRead = true;
    await generate.click();
    await toast.getByText('已成功生成 3 条地址', { exact: true }).waitFor();
    await notice.getByText(/已成功生成 3 条地址.*列表读取失败/).waitFor();
    await page.clock.fastForward(4500);
    assert(await toast.isHidden());
    assert(await notice.isVisible(), '生成成功但列表读取失败的说明应保留');
    assert.deepEqual(errors, []);
    assert.deepEqual(traffic.external, []);
    assert.deepEqual(traffic.unavailable, []);
  });
});
