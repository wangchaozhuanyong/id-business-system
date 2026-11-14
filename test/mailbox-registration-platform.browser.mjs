import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { interceptDesign, origin, root, settle } from './helpers/offline-design.mjs';
import { prepareMailboxPlatformMarks } from '../server/mailbox-registration-platform.mjs';
import { checkInventoryHistory } from '../server/inventory-history.mjs';
import { attributeInventory } from '../server/inventory-attribution.mjs';
import { checkRegistrationChanges } from '../server/inventory-registration.mjs';

const output = process.env.ID_LAYOUT_QA_OUTPUT || root + '/.runtime/mailbox-registration-platform-20261111';
await mkdir(output, { recursive: true });
const actor = { id: 'platform-test-admin', name: '平台验收管理员', role: 'admin' };
const makeRow = (id, type = 'relay') => ({
  id, type, email: id + '@example.test', status: '正常', health: 'normal', inventoryState: 'used',
  used: true, version: 1, usageLinks: [], inventoryHistory: [], actualUsedAt: '2026-10-01 12:00',
  ...(type === 'relay' ? { parentMailboxId: 'parent-1', relayStatus: 'ACTIVE', remoteAliasId: id } : {})
});
const initial = () => ({
  mailboxes: [makeRow('relay-used'), { ...makeRow('relay-known'), claimId: 'linked-claim', claimBatchId: 'linked-batch', usageLinks: [
    { kind: 'registration', product: 'gpt', accountId: 'gpt-known', label: '已核实 ChatGPT 注册', time: '2026-10-01 12:00' }
  ] }, makeRow('google-used', 'google'), makeRow('microsoft-used', 'microsoft'),
  ...Array.from({ length: 22 }, (_, i) => makeRow('relay-page-' + i))],
  accounts: [{ ...makeRow('gpt-known', 'gpt'), email: 'relay-known@example.test', registered: '2026-10-01T12:00',
    health: 'dead', healthChangedAt: '2026-10-02 12:00', emailType: 'relay', source: '自己注册' }],
  batches: [{ id: 'linked-batch', kind: 'mail', actorId: actor.id, actorName: actor.name, purpose: '注册 GPT',
    time: '2026-10-01 11:00', items: [{ id: 'linked-claim', assetId: 'relay-known', type: 'relay',
      email: 'relay-known@example.test', status: 'used', usedAt: '2026-10-01 12:00' }] }],
  returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: [],
  appleRelay: { parents: [{ id: 'parent-1', remotePrimaryId: '1', email: 'parent@example.test', status: 'ACTIVE' }], events: [], imports: [] }
});
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of [1440, 1024, 901, 900, 768, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    let document = initial(), version = 1, saves = 0, fail = false, hold = null;
    const requests = await interceptDesign(context, { actor, localFixtures: {}, skipRechargeAssets: true });
    await context.route(origin + '/api/local/inventory', async route => {
      if (route.request().method() === 'PUT') {
        if (fail) return route.fulfill({ status: 503, json: { error: '合成保存失败' } });
        const input = route.request().postDataJSON();
        if (input.version !== version) return route.fulfill({ status: 409, json: { error: '版本已变化' } });
        const error = prepareMailboxPlatformMarks(document, input.data, input.action, actor) ||
          attributeInventory(document, input.data, actor, input.action) || checkInventoryHistory(document, input.data) ||
          checkRegistrationChanges(document, input.data, input.action);
        if (error) return route.fulfill({ status: 409, json: { error } });
        document = input.data; version++; saves++;
        if (hold) await hold;
      }
      return route.fulfill({ json: { version, data: document } });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.goto(origin + '/#/mailboxes/relay');
    await page.locator('[data-action="relay-tab"][data-tab="aliases"]').click();
    await page.locator('[data-action="relay-alias-more"][data-id="relay-used"]:visible').waitFor();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const drawer = page.locator('#drawer');
    const open = async id => {
      await page.locator(`[data-action="relay-alias-more"][data-id="${id}"]:visible`).click();
      await page.locator(`[data-action="inventory-mailbox-platform"][data-id="${id}"]:visible`).click();
      await drawer.getByRole('heading', { name: '标记注册平台', exact: true }).waitFor();
    };
    const save = async () => {
      await drawer.getByRole('button', { name: '保存标记', exact: true }).click();
    };
    const measure = async state => {
      await settle(page);
      const geometry = await page.evaluate(() => {
        const form = document.querySelector('#inventory-mailbox-platform-form');
        const fields = [...(form?.querySelectorAll('.field') || [])].filter(el => el.checkVisibility()).map(el => {
          const label = el.querySelector('label'), control = el.querySelector('input:not([type=hidden]),select');
          if (!label || !control) return null;
          const a = label.getBoundingClientRect(), b = control.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(label);
          const text = range.getBoundingClientRect();
          return { label: label.textContent, leftOfControl: a.right <= b.left + 1,
            labelCenter: text.y + text.height / 2, controlCenter: b.y + b.height / 2 };
        }).filter(Boolean);
        return { overflow: document.documentElement.scrollWidth > innerWidth + 1, fields };
      });
      assert.equal(geometry.overflow, false, `${width}/${theme}/${state}: 横向溢出`);
      await writeFile(output + '/latest-geometry.json', JSON.stringify({ width, theme, state, ...geometry }, null, 2));
      await page.screenshot({ path: output + '/latest.png' });
      for (const field of geometry.fields) {
        assert(field.leftOfControl, `${width}/${theme}/${state}: 标签必须在控件左侧`);
        assert(Math.abs(field.labelCenter - field.controlCenter) <= 2, '首行控件与标签对齐：' + JSON.stringify(field));
      }
      results.push({ width, theme, state, ...geometry });
    };
    assert(await page.locator('th').filter({ hasText: '注册平台' }).count());
    assert(await page.getByText('平台未登记', { exact: true }).count());
    const row = id => page.locator('tr').filter({ has: page.locator(`[data-action="relay-alias-more"][data-id="${id}"]`) });
    const expand = async id => {
      const control = row(id).locator('[data-action="table-mobile-toggle"]');
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click();
    };
    await expand('relay-known');
    await row('relay-known').getByRole('button', { name: 'gpt-known', exact: true }).click();
    await drawer.getByRole('button', { name: '查看邮箱领用批次', exact: true }).waitFor();
    await drawer.getByRole('button', { name: '查看来源邮箱', exact: true }).click();
    await drawer.getByRole('heading', { name: '关联账号', exact: true }).waitFor();
    assert.match(await drawer.innerText(), /账号状态\s*死号/);
    assert.match(await drawer.innerText(), /账号状态变更时间\s*2026-10-02 12:00/);
    await drawer.locator('[data-action="drawer-close"]').last().click();
    await measure('used-list');
    await open('relay-used');
    assert.equal(await drawer.locator('option[value="gemini"]').count(), 0);
    await drawer.getByRole('button', { name: '保存标记', exact: true }).click();
    await drawer.getByText('请选择已核实的注册平台', { exact: true }).waitFor();
    assert.equal(saves, 0);
    await drawer.locator('#inventory-platform-product').selectOption('claude');
    await measure('platform-drawer');
    if ([1440, 390].includes(width)) await page.screenshot({ path: `${output}/drawer-${width}-${theme}.png` });
    await drawer.locator('[data-action="inventory-close"]').click();
    await open('relay-used');
    assert.equal(await drawer.locator('#inventory-platform-product').inputValue(), 'claude');
    if (width === 1440 && theme === 'light') {
      fail = true;
      await save();
      await page.getByText('本次操作未保存，请检查本机服务后重试', { exact: true }).waitFor();
      assert.equal(await drawer.locator('#inventory-platform-product').inputValue(), 'claude');
      assert.equal(saves, 0);
      fail = false;
    }
    await save();
    await drawer.waitFor({ state: 'hidden' });
    assert.equal(saves, 1);
    assert.equal(document.mailboxes[0].usageLinks[0].product, 'claude');
    assert.equal(document.mailboxes[0].actualUsedAt, '2026-10-01 12:00');
    await expand('relay-used');
    await row('relay-used').getByText('Claude', { exact: true }).waitFor();
    await row('relay-used').getByText('账号待关联', { exact: true }).waitFor();
    await row('relay-used').locator('[data-action="relay-alias-more"]').click();
    assert.equal(await page.locator('[data-action="inventory-mailbox-platform"][data-id="relay-used"]:visible').count(), 0);
    await page.keyboard.press('Escape');
    await measure('single-platform');
    if ([1440, 390].includes(width)) await page.screenshot({ path: `${output}/list-${width}-${theme}.png` });
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.locator('[data-action="relay-alias-more"][data-id="relay-page-21"]:visible').waitFor();
    await measure('last-page');
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await page.locator('#relay-search').fill('Claude');
    await page.waitForFunction(() => document.querySelectorAll('[data-action="relay-alias-more"]').length === 1);
    await measure('platform-search');
    await page.locator('#relay-search').fill('no-such-platform-fixture');
    await page.waitForFunction(() => document.querySelectorAll('[data-action="relay-alias-more"]').length === 0);
    await measure('empty-search');
    await page.locator('#relay-search').fill('');
    await page.locator('[data-action="relay-alias-more"][data-id="relay-used"]:visible').waitFor();

    if (width === 1440 && theme === 'light') {
      // A late response may not clear edits made after its submission snapshot.
      await open('relay-page-0');
      await drawer.locator('#inventory-platform-product').selectOption('gpt');
      let release;
      hold = new Promise(resolve => { release = resolve; });
      const submitted = page.waitForRequest(request => request.url() === origin + '/api/local/inventory' && request.method() === 'PUT');
      await save();
      await submitted;
      await drawer.locator('#inventory-platform-product').selectOption('grok');
      release(); hold = null;
      await page.getByText('本次提交已保存，后续填写的内容已保留', { exact: true }).waitFor();
      assert.equal(await drawer.locator('#inventory-platform-product').inputValue(), 'grok');
      await drawer.locator('[data-action="inventory-close"]').click();

      // A real reload reads the saved synthetic document, rather than a view-only label.
      await page.reload();
      await page.locator('[data-action="relay-tab"][data-tab="aliases"]').click();
      await row('relay-page-0').getByText('ChatGPT', { exact: true }).waitFor();
      assert.equal(document.mailboxes.find(row => row.id === 'relay-page-0').usageLinks.length, 1);
      for (const type of ['google', 'microsoft']) {
        await page.evaluate(type => { location.hash = '#/mailboxes/' + type; }, type);
        await page.locator('[data-action="inventory-tab"][data-tab="used"]').click();
        await page.locator(`[data-action="inventory-more"][data-id="${type}-used"]:visible`).click();
        await page.locator(`[data-action="inventory-mailbox-platform"][data-id="${type}-used"]:visible`).click();
        await drawer.locator('#inventory-platform-product').selectOption(type === 'google' ? 'gpt' : 'grok');
        await save();
        await drawer.waitFor({ state: 'hidden' });
        assert.equal(document.mailboxes.find(row => row.id === type + '-used').usageLinks.length, 1);
      }

      const claimed = { ...makeRow('new-registration', 'google'), inventoryState: 'claimed',
        claimId: 'claim-new', claimBatchId: 'batch-new' };
      document.mailboxes.push(claimed);
      document.batches.push({ id: 'batch-new', kind: 'mail', actorId: actor.id, actorName: actor.name,
        purpose: '注册 Gemini', time: '2026-11-10 10:00', items: [{ id: 'claim-new', assetId: claimed.id,
          email: claimed.email, type: 'google', status: 'pending', claimedAt: '2026-11-10 10:00' }] });
      version++;
      await page.goto(origin + '/#/workspace/extractions/batch-new');
      await page.reload();
      const selection = page.locator('input[type="checkbox"][data-select="inventory-claims"]');
      await selection.first().check();
      await page.locator('[data-action="inventory-claim-use"]').click();
      await drawer.locator('#inventory-use-purpose').selectOption('注册 Gemini');
      await drawer.locator('#inventory-use-result').fill('已核实外部注册成功');
      await drawer.getByRole('button', { name: '核对使用结果', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
      assert.equal(document.mailboxes.find(row => row.id === claimed.id).usageLinks[0].product, 'gemini');
      assert.equal(document.batches.at(-1).items[0].status, 'used');

      const writesBeforeDuplicates = saves;
      const duplicateMessage = '该邮箱已用于注册 ChatGPT，关联账号 gpt-known';
      await page.goto(origin + '/#/accounts/grok');
      await page.locator('#main [data-action="inventory-add"]').click();
      await drawer.locator('#inventory-email').fill('RELAY-KNOWN@example.test');
      await drawer.locator('button[form="inventory-asset-form"][type="submit"]').click();
      await drawer.getByText(duplicateMessage, { exact: true }).waitFor();
      await drawer.locator('[data-action="inventory-close"]').click();
      await page.locator('#main [data-action="inventory-import"]').click();
      await drawer.locator('#inventory-import-content').fill('邮箱,账号登录方式\nrelay-known@example.test,邮箱登录');
      await drawer.getByRole('button', { name: '检查并预览', exact: true }).click();
      await drawer.getByText(duplicateMessage, { exact: true }).waitFor();
      assert.equal(await drawer.locator('[data-action="inventory-import-confirm"]').isDisabled(), true);
      assert.equal(saves, writesBeforeDuplicates);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(requests.external, []);
    assert.deepEqual(requests.unavailable, []);
    await context.close();
  }
  await writeFile(output + '/browser-results.json', JSON.stringify(results, null, 2));
  console.log(`邮箱注册平台：${results.length} 个离线布局状态及保存、失败重试、草稿、迟到响应和回读验证通过；无服务、数据库或外网请求。`);
} finally { await browser.close(); }
