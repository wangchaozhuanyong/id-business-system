import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

const feature = 'claude-google-subscriptions';
const path = '/api/local/' + feature;
const entry = '/#/data-management/' + feature;
const fixturePath = new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url);
const actor = { id: 'synthetic-admin', name: '合成管理员', role: 'admin' };
const now = '2026-11-09T02:00:00.000Z';
const revision = 'synthetic-list-revision';
const statuses = ['active', 'missing', 'expired', 'disabled', 'auth_failed', 'conflict'];
const statusLabels = ['有效', '未登记', '已过期', '已停用', '授权失败', '资料冲突'];
const longValueIndex = 3;
const longEmail = 'synthetic-long-' + 'abc'.repeat(14) + '@example.test';
const longPassword = 'SYNTHETIC-LONG-PASSWORD-' + 'aB9'.repeat(38);
const longTotp = 'SYNTHETIC-LONG-TOTP-' + 'ABCDE234'.repeat(8);
const longQueryCode = 'SYNTHETIC-LONG-QUERY-' + 'Q7xY'.repeat(18);
const rows = Array.from({ length: 51 }, (_, index) => {
  const nearExpiry = index === 7;
  const codeStatus = nearExpiry ? 'active' : statuses[index % statuses.length];
  const operatorId = 'synthetic-operator-' + (index % 2);
  const operatorName = index % 2 ? '合成录入员工乙' : '合成录入员工甲';
  const samePerson = index === 6;
  return {
    id: 'synthetic-order-' + index,
    email: index === longValueIndex ? longEmail : 'google-subscription-' + index + '@example.test',
    password: index === longValueIndex ? longPassword : index % 6 === 5 ? '' : 'SYNTHETIC-PASSWORD-' + index,
    totp: index === longValueIndex ? longTotp : index % 6 === 5 ? '' : 'SYNTHETIC-2FA-' + index,
    queryCode: index === longValueIndex ? longQueryCode
      : ['missing', 'conflict'].includes(codeStatus) ? '' : 'SYNTHETIC-QUERY-' + index,
    codeStatus,
    expiresAt: nearExpiry ? '2026-11-09T02:00:10.000Z'
      : codeStatus === 'expired' ? '2026-11-07T02:00:00.000Z'
      : codeStatus === 'active' ? '2026-11-12T02:00:00.000Z' : null,
    remainingDays: nearExpiry ? 1 : codeStatus === 'expired' ? 0 : codeStatus === 'active' ? 3 : null,
    operatorId,
    operatorName,
    ownerId: samePerson ? operatorId : 'synthetic-owner-' + (index % 3),
    ownerName: samePerson ? operatorName : index % 3 ? '合成归属员工乙' : '合成归属员工甲',
    credentialStatus: index % 6 === 5 ? 'conflict' : 'available'
  };
});

function listResult({ query = '', status, page, pageSize }, overrides) {
  const keyword = query.trim().toLowerCase();
  const matches = rows.filter((row) =>
    (!status || status === 'all' || row.codeStatus === status) &&
    (!keyword || [row.email, row.operatorName, row.ownerName].some((value) => value.toLowerCase().includes(keyword)))
  );
  return { items: matches.slice((page - 1) * pageSize, page * pageSize)
    .map((row) => ({ ...row, ...overrides.get(row.id) })),
    total: matches.length, page, pageSize, revision, now };
}

function copyResult(row, mode, settings) {
  const omitted = [];
  const lines = ['邮箱账号：' + row.email];
  const add = (label, value) => value ? lines.push(label + '：' + value) : omitted.push(label);
  if (mode === 2) {
    add('邮箱密码', row.password);
    add('邮箱 2FA', row.totp);
  }
  add('买家查询码', row.codeStatus === 'active' ? row.queryCode : '');
  const suffix = settings['copy' + mode];
  if (suffix) lines.push(suffix);
  return { text: lines.join('\n'), omitted };
}

test('Claude 谷歌订阅管理读取记录、分页筛选及安全复制', { timeout: 90_000 }, async (t) => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const module = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
  const { chromium } = module.default || module;
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());

  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
    await t.test(width + 'px ' + theme, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN' });
      try {
        const localFixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
        const mock = await interceptDesign(context, { localFixtures, actor });
        await context.addInitScript(() => {
          window.qaCopies = [];
          Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: async (text) => { window.qaCopies.push(text); } }
          });
        });
        const listCalls = [];
        const copyCalls = [];
        const settingsWrites = [];
        const overrides = new Map();
        let settings = { version: 1, copy1: '原合成后缀一', copy2: '原合成后缀二' };
        let holdCopy = null;
        let holdList = null;
        await context.route(origin + path + '/list', async (route) => {
          assert.equal(route.request().method(), 'POST');
          const command = route.request().postDataJSON();
          listCalls.push(command);
          if (holdList && command.query === holdList.query) {
            const current = holdList;
            current.started.resolve();
            await current.release.promise;
            await route.fulfill({ json: listResult(command, overrides) }).catch(() => {});
            current.finished.resolve();
            return;
          }
          return route.fulfill({ json: listResult(command, overrides) });
        });
        await context.route(origin + path + '/copy', async (route) => {
          assert.equal(route.request().method(), 'POST');
          const command = route.request().postDataJSON();
          copyCalls.push(command);
          assert.equal(command.revision, revision);
          assert.ok([1, 2].includes(command.mode));
          const base = rows.find((record) => record.id === command.id);
          assert.ok(base);
          const row = { ...base, ...overrides.get(base.id) };
          if (holdCopy) {
            const current = holdCopy;
            current.started.resolve();
            await current.release.promise;
            await route.fulfill({ json: copyResult(row, command.mode, settings) }).catch(() => {});
            current.finished.resolve();
            return;
          }
          return route.fulfill({ json: copyResult(row, command.mode, settings) });
        });
        await context.route(origin + path + '/copy-settings', (route) => {
          if (route.request().method() === 'GET') return route.fulfill({ json: settings });
          assert.equal(route.request().method(), 'PUT');
          const command = route.request().postDataJSON();
          settingsWrites.push(command);
          assert.equal(command.version, settings.version);
          settings = { version: settings.version + 1, copy1: command.copy1, copy2: command.copy2 };
          return route.fulfill({ json: settings });
        });
        const page = await context.newPage();
        if (width === 1440 && theme === 'light') await page.clock.install({ time: new Date(now) });
        page.setDefaultTimeout(6500);
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(origin + entry);
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        const featureRegion = page.locator('#' + feature);
        const row = (index) => featureRegion.locator('tbody tr[data-row-id="' + rows[index].id + '"]');
        const copy = (index, mode) => row(index).locator('[data-action="claude-google-copy"][data-mode="' + mode + '"]');
        const status = featureRegion.locator('#claude-google-code-status');
        const search = featureRegion.locator('#claude-google-query');
        const searchFor = async (value) => {
          await search.fill(value);
          await search.press('Enter');
        };
        await row(0).waitFor();
        const defaultStatus = await status.inputValue();
        assert.equal(await page.locator('.nav-child[href="#/data-management/' + feature + '"]').count(), 1);
        assert.equal(await page.getByRole('heading', { name: 'Claude 谷歌订阅管理', exact: true }).count(), 1);
        const attribution = (index) => row(index).locator('td[data-column="operatorName"]');
        const operationCell = attribution(0);
        await operationCell.waitFor();
        assert.deepEqual((await operationCell.innerText()).split('\n'),
          [rows[0].operatorName, '归属：' + rows[0].ownerName], '不同人员在操作人列分两行显示');
        assert.equal(await featureRegion.getByRole('columnheader', { name: /归属/ }).count(), 0);
        const samePersonCell = attribution(6);
        await samePersonCell.getByText(rows[6].operatorName, { exact: true }).waitFor();
        assert.equal((await samePersonCell.innerText()).trim(), rows[6].operatorName, '同一个人只显示操作人姓名');
        await row(0).getByText(rows[0].password, { exact: true }).waitFor();
        await row(0).getByText(rows[0].totp, { exact: true }).waitFor();
        const remaining = (index) => row(index).locator('td[data-column="remainingDays"]');
        await remaining(0).getByText('3 天', { exact: true }).waitFor();
        assert.equal((await remaining(1).innerText()).trim(), '—');
        assert.equal((await remaining(2).innerText()).trim(), '0 天');
        for (const [index, value] of statuses.entries()) {
          assert.equal(await status.locator('option[value="' + value + '"]').count(), 1);
          await row(index).getByText(statusLabels[index], { exact: true }).waitFor();
        }
        if (width === 390) {
          const longValues = { email: longEmail, password: longPassword, totp: longTotp, queryCode: longQueryCode };
          for (const [field, value] of Object.entries(longValues)) {
            const button = row(longValueIndex).locator(
              '[data-action="claude-google-value"][data-field="' + field + '"]'
            );
            await button.scrollIntoViewIfNeeded();
            assert.equal(await button.evaluate((element) => {
              const text = element.querySelector('span');
              return element.getBoundingClientRect().height >= 44 && text.scrollWidth > text.clientWidth;
            }), true, field + ' 可触控且表格中缩略显示');
            await button.click();
            const drawer = page.locator('#drawer[open]');
            const fullValue = drawer.locator('#claude-google-full-value');
            await fullValue.waitFor();
            assert.equal(await fullValue.inputValue(), value);
            assert.equal(await fullValue.evaluate((area) => area.readOnly), true);
            const captured = await fullValue.elementHandle();
            await drawer.getByRole('button', { name: '关闭', exact: true }).click();
            await drawer.waitFor({ state: 'hidden' });
            await page.waitForFunction((area) => !area.value && !area.textContent, captured);
            await captured.dispose();
          }
        }
        for (const mode of [1, 2]) {
          const action = copy(0, mode);
          await action.scrollIntoViewIfNeeded();
          assert.equal(await action.evaluate((button) => {
            const rect = button.getBoundingClientRect();
            const table = button.closest('.table-viewport')?.getBoundingClientRect();
            return rect.width > 0 && rect.left >= (table?.left ?? 0) - 1 &&
              rect.right <= Math.min(innerWidth, table?.right ?? innerWidth) + 1;
          }), true);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        const initial = listCalls[0];
        assert.equal(initial.page, 1);
        assert.ok(initial.pageSize < rows.length);

        if (width === 1440 && theme === 'light') {
          await remaining(7).getByText('1 天', { exact: true }).waitFor();
          const beforeExpiry = listCalls.length;
          await page.clock.fastForward(10_050);
          await row(7).getByText('已过期', { exact: true }).waitFor();
          assert.equal((await remaining(7).innerText()).trim(), '0 天');
          assert.equal(listCalls.length, beforeExpiry, '已展示的查询码到期时就地更新');

          const next = featureRegion.getByRole('button', { name: '下一页', exact: true });
          await next.click();
          await row(initial.pageSize).waitFor();
          assert.equal(listCalls.at(-1).page, 2);
          await status.selectOption('expired');
          await row(2).waitFor();
          assert.equal(listCalls.at(-1).page, 1);
          assert.equal(listCalls.at(-1).status, 'expired');
          assert.equal(await row(0).count(), 0);
          await copy(2, 2).click();
          await page.waitForFunction((expected) => window.qaCopies.at(-1) === expected, copyResult(rows[2], 2, settings).text);
          assert.deepEqual(copyCalls.at(-1), { id: rows[2].id, mode: 2, revision });
          assert.equal(await page.evaluate(() => window.qaCopies.at(-1).includes('SYNTHETIC-QUERY-2')), false);

          await status.selectOption(defaultStatus);
          await row(0).waitFor();
          await searchFor(rows[1].operatorName);
          await row(0).waitFor({ state: 'hidden' });
          await row(1).waitFor();
          assert.equal(listCalls.at(-1).query, rows[1].operatorName);
          await searchFor(rows[0].ownerName);
          await row(1).waitFor({ state: 'hidden' });
          await row(0).waitFor();
          assert.equal(listCalls.at(-1).query, rows[0].ownerName);
          await searchFor('');
          await row(1).waitFor();
          await status.selectOption('active');
          await row(0).waitFor();
          await page.locator('[data-action="claude-google-copy-settings"]:visible').click();
          const form = page.locator('#claude-google-copy-settings-form');
          const copy1 = form.locator('#claude-google-copy1');
          const copy2 = form.locator('#claude-google-copy2');
          await form.locator('button[type="submit"]:enabled').waitFor();
          assert.equal(await copy1.inputValue(), settings.copy1);
          assert.equal(await copy2.inputValue(), settings.copy2);
          await copy1.fill('新合成后缀一');
          await copy2.fill('新合成后缀二\n第二行');
          await form.locator('button[type="submit"]').click();
          await form.waitFor({ state: 'hidden' });
          assert.deepEqual(settingsWrites, [{ version: 1, copy1: '新合成后缀一', copy2: '新合成后缀二\n第二行' }]);

          await copy(0, 1).click();
          const mode1 = copyResult(rows[0], 1, settings).text;
          await page.waitForFunction((expected) => window.qaCopies.at(-1) === expected, mode1);
          assert.ok(!mode1.includes(rows[0].password) && !mode1.includes(rows[0].totp));
          assert.deepEqual(copyCalls.at(-1), { id: rows[0].id, mode: 1, revision });
          await copy(0, 2).click();
          await page.waitForFunction((expected) => window.qaCopies.at(-1) === expected, copyResult(rows[0], 2, settings).text);
          assert.deepEqual(copyCalls.at(-1), { id: rows[0].id, mode: 2, revision });

          const beforeRotation = listCalls.length;
          const rotatedCode = 'SYNTHETIC-ROTATED-QUERY';
          overrides.set(rows[0].id, { queryCode: rotatedCode });
          await page.evaluate((id) => window.IDDesignModules.find((module) => module.id === id)
            .onDataChanges(['tools/mailbox-pool']), feature);
          await row(0).getByText(rotatedCode, { exact: false }).waitFor();
          assert.equal(listCalls.length, beforeRotation + 1, '邮箱池变化触发订阅表重新读取');
          assert.equal((await row(0).innerText()).includes(rows[0].queryCode), false);

          holdList = { query: rows[0].email, started: Promise.withResolvers(), release: Promise.withResolvers(), finished: Promise.withResolvers() };
          try {
            await searchFor(holdList.query);
            await holdList.started.promise;
            await searchFor(rows[6].email);
            await row(6).waitFor();
            await row(0).waitFor({ state: 'hidden' });
            holdList.release.resolve();
            await holdList.finished.promise;
            await settle(page);
            assert.equal(await row(0).count(), 0, '迟到的搜索不能覆盖新搜索结果');
          } finally {
            holdList.release.resolve();
          }

          holdCopy = { started: Promise.withResolvers(), release: Promise.withResolvers(), finished: Promise.withResolvers() };
          try {
            const copies = await page.evaluate(() => window.qaCopies.length);
            await copy(6, 2).click();
            await holdCopy.started.promise;
            await page.goto(origin + '/#/data-management/bank-cards');
            await featureRegion.waitFor({ state: 'detached' });
            holdCopy.release.resolve();
            await holdCopy.finished.promise;
            await settle(page);
            assert.equal(await page.evaluate(() => window.qaCopies.length), copies, '切页后迟到的复制结果不能改剪贴板');
          } finally {
            holdCopy.release.resolve();
          }
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(mock.external, []);
      } finally {
        await context.close();
      }
    });
  }
});

test('员工直达 Claude 谷歌订阅管理不读取敏感列表', { timeout: 30_000 }, async (t) => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const module = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
  const { chromium } = module.default || module;
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const localFixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
  await interceptDesign(context, {
    localFixtures, actor: { id: 'synthetic-employee', name: '合成员工', role: 'employee' }
  });
  let reads = 0;
  await context.route(origin + path + '/**', (route) => {
    reads++;
    return route.fulfill({ status: 403, json: { error: '无权限' } });
  });
  const page = await context.newPage();
  await page.goto(origin + entry);
  await page.getByText('当前账号无权打开此页面', { exact: true }).waitFor();
  await settle(page);
  assert.equal(await page.locator('.nav-child[href="#/data-management/' + feature + '"]').count(), 0);
  assert.equal(await page.locator('[data-action="claude-google-copy"]').count(), 0);
  assert.equal(reads, 0);
});
