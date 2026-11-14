import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import test from 'node:test';
import { interceptDesign, origin, root } from './helpers/offline-design.mjs';
import { createFinanceCollection } from '../server/finance/collection-service.mjs';
import { createFinanceCollectionHandler } from '../server/finance/collection-route.mjs';
import { automaticProvider } from '../modules/finance/accounting.mjs';

test('汇率四栏目、设置草稿、版本冲突、采集记录与事件更新，桌面手机深浅主题', { timeout: 120_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const actor = { id: 'fx-fixture-admin', name: '合成管理员', role: 'super' };
  let now = Date.parse('2026-11-07T09:00:00Z'), document = { version: 0, data: null }, providerCalls = 0;
  const store = {
    featureDocument: () => structuredClone(document),
    saveFeatureDocument: (_domain, version, data) => {
      assert.equal(version, document.version);
      document = { version: version + 1, data: structuredClone(data) }; return structuredClone(document);
    }, load: () => ({ version: 0, data: { orders: [] } })
  };
  const collection = createFinanceCollection({ store, provider: automaticProvider.id, clock: () => now,
    fetchQuote: async () => {
      providerCalls++;
      return Response.json({ date: new Date(now).toISOString().slice(0, 10),
        cny: { cny: 1, myr: 0.625, usd: 0.125, php: 8, clp: 125, idr: 2500, egp: 6.25 } });
    }
  });
  t.after(() => collection.close());
  await collection.collect('manual', actor);
  const seed = document.data.runs[0];
  document.data.runs = Array.from({ length: 25 }, (_, i) => ({ ...structuredClone(seed), id: 'fxr-fixture-' + i,
    status: i % 2 ? 'unchanged' : 'updated', actorName: i === 24 ? '最后一条人员' : actor.name }));
  document.version++;
  const handle = createFinanceCollectionHandler({ collection, publicOrigin: origin });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const { external } = await interceptDesign(context, { localFixtures: fixture, actor, changeEvents: true });
  await context.addInitScript(version => {
    const fetch = window.fetch.bind(window);
    window.fxBoot = crypto.randomUUID();
    window.fetch = (url, options) => {
      if (new URL(String(url), location.href).pathname !== '/api/local/change-events') return fetch(url, options);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.emitFxVersion = version => controller.enqueue(new TextEncoder().encode('event: change\ndata: ' + JSON.stringify({ schema: 1, versions: { 'finance-rates': String(version) } }) + '\n\n'));
        controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: ' + JSON.stringify({ schema: 1, versions: { 'finance-rates': String(version) } }) + '\n\n'));
      } }), { headers: { 'content-type': 'text/event-stream' } }));
    };
  }, document.version);
  let page, rejectReads = false, releaseSettings, delaySettings = false, reads = 0;
  let settingsRefreshInterruption;
  let delayLastRunPage = false;
  const lastRunPageStarted = Promise.withResolvers();
  const lastRunPageReleased = Promise.withResolvers();
  t.after(lastRunPageReleased.resolve);
  const actions = [], errors = [];
  await context.route('**/api/local/finance/collection*', async route => {
    const request = route.request();
    if (request.method() === 'GET') {
      reads++;
      if (rejectReads) return route.fulfill({ status: 503, json: { error: '合成读取失败，请重试' } });
      const params = new URL(request.url()).searchParams;
      if (settingsRefreshInterruption && params.get('tab') === 'settings' && document.data.settings.version === 3) {
        const interruption = settingsRefreshInterruption;
        settingsRefreshInterruption = undefined;
        interruption.started.resolve();
        await interruption.release.promise;
      }
      if (delayLastRunPage && params.get('tab') === 'runs' && params.get('page') === '2') {
        delayLastRunPage = false;
        lastRunPageStarted.resolve();
        await lastRunPageReleased.promise;
      }
    }
    const command = request.postData() ? JSON.parse(request.postData()) : undefined;
    const deferVersionEvent = settingsRefreshInterruption && command?.action === 'settings' && command.version === 2;
    if (command) actions.push(command.action);
    const body = Readable.from(request.postData() ? [Buffer.from(request.postData())] : []);
    Object.assign(body, { method: request.method(), url: new URL(request.url()).pathname + new URL(request.url()).search, headers: request.headers() });
    let status, headers, result;
    await handle(body, { writeHead(code, values) { status = code; headers = values; }, end(value) { result = value; } }, actor);
    if (delaySettings && command?.action === 'settings') await new Promise(resolve => { releaseSettings = resolve; });
    await route.fulfill({ status, headers, body: result });
    if (command && command.action !== 'cleanup-preview' && !deferVersionEvent) await page.evaluate(version => window.emitFxVersion?.(version), document.version);
  });
  page = await context.newPage(); page.setDefaultTimeout(7000);
  page.on('pageerror', failure => errors.push(failure.message));
  const go = async route => {
    await page.evaluate(route => window.IDDesignAPI.go(route), route);
    await page.locator('#main[data-layout-route="' + route + '"]').waitFor();
  };
  const tab = name => page.getByRole('tab', { name, exact: true }).click();
  const listAction = async name => {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.isVisible()) return button.click();
    await page.locator('#main .fx-toolbar [data-action="mobile-list-actions"]').click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  };
  const financePager = page.locator('#main nav[data-pagination]');
  const jumpPage = async number => {
    await financePager.locator('.pagination-jump summary').click();
    const target = financePager.locator('[data-pagination-target]');
    await target.fill(String(number));
    await target.press('Enter');
  };
  const confirm = () => page.locator('#confirm-dialog[open] [data-action="confirm-accept"]').click();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.goto(origin + '/#/settings/exchange-rates');
  await page.locator('table[data-table="fx-rates"] tbody tr').filter({ hasText: '美元' }).waitFor();
  await page.locator('table[data-table="fx-rates"] tbody tr').filter({ hasText: '埃及镑 EGP' }).waitFor();
  assert.equal(await page.locator('table[data-table="fx-rates"] tbody tr').count(), 6);
  const boot = await page.evaluate(() => window.fxBoot);
  const stable = reads;
  await page.evaluate(version => window.emitFxVersion(version), document.version);
  await settle(); assert.equal(reads, stable, '相同版本不重读');

  await tab('采集记录');
  await page.locator('table[data-table="fx-runs"] tbody tr[data-row-id="fxr-fixture-0"]').waitFor();
  assert.equal(await financePager.locator('[data-pagination-size]').inputValue(), '20');
  const firstFrame = await page.locator('table[data-table="fx-runs"]').locator('..').boundingBox();
  delayLastRunPage = true;
  await jumpPage(2);
  await lastRunPageStarted.promise;
  assert.equal(await financePager.getAttribute('data-page'), '1');
  assert.equal(await page.locator('tr[data-row-id="fxr-fixture-0"]').isVisible(), true);
  lastRunPageReleased.resolve();
  await page.locator('tr[data-row-id="fxr-fixture-24"]').waitFor();
  assert.equal(await page.locator('table[data-table="fx-runs"] tbody tr').count(), 5);
  const lastFrame = await page.locator('table[data-table="fx-runs"]').locator('..').boundingBox();
  assert(lastFrame.height >= firstFrame.height - 1, '最后一页保留表格框架高度');
  await page.locator('tr[data-row-id="fxr-fixture-24"]').getByRole('button', { name: '详情', exact: true }).click();
  await page.locator('#drawer[open]').getByText('最后一条人员', { exact: true }).waitFor();
  await page.locator('#drawer[open]').getByRole('button', { name: '关闭', exact: true }).click();
  await tab('当前汇率');
  await page.locator('table[data-table="fx-rates"] tbody tr').filter({ hasText: '美元' }).waitFor();
  await financePager.locator('[data-pagination-size]').selectOption('50');
  await tab('采集记录');
  await page.locator('tr[data-row-id="fxr-fixture-24"]').waitFor();
  assert.equal(await financePager.locator('[data-pagination-size]').inputValue(), '20');
  assert.equal(await financePager.getAttribute('data-page'), '2');
  rejectReads = true;
  await financePager.locator('[data-pagination-size]').selectOption('50');
  await page.getByRole('alert').getByText('合成读取失败，请重试').waitFor();
  assert.equal(await financePager.getAttribute('data-page'), '2');
  assert.equal(await financePager.locator('[data-pagination-size]').inputValue(), '20');
  assert.equal(await page.locator('tr[data-row-id="fxr-fixture-24"]').isVisible(), true);
  rejectReads = false;
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page.locator('tr[data-row-id="fxr-fixture-19"]').waitFor();
  assert.equal(await financePager.getAttribute('data-page'), '1');
  assert.equal(await financePager.locator('[data-pagination-size]').inputValue(), '50');
  await financePager.locator('[data-pagination-size]').selectOption('10');
  await page.locator('tr[data-row-id="fxr-fixture-19"]').waitFor({ state: 'detached' });
  await page.locator('#fx-query').fill('没有匹配资料');
  await page.getByRole('heading', { name: '暂无符合条件的汇率记录' }).waitFor();
  await listAction('清空筛选');
  await page.locator('tr[data-row-id="fxr-fixture-0"]').waitFor();

  await tab('采集设置'); await page.locator('#fx-settings-form').waitFor();
  await page.waitForFunction(() => document.querySelector('#fx-progress')?.hidden);
  await page.locator('#fx-schedule').selectOption('interval');
  await page.locator('#fx-interval').fill('90');
  assert.equal(await page.locator('#fx-interval').inputValue(), '90');
  await page.locator('#fx-currencies').click();
  await page.locator('#fx-currency-search').fill('美 USD');
  assert.equal(await page.locator('.fx-currency-options label:visible').count(), 1);
  await page.locator('.fx-currency-options input[value="USD"]').uncheck();
  await page.keyboard.press('Escape');
  await tab('运行状态');
  await page.getByRole('heading', { name: '近 7 天', exact: true }).waitFor();
  await tab('采集设置');
  assert.equal(await page.locator('#fx-interval').inputValue(), '90');
  assert.equal(await page.locator('.fx-currency-options input[value="USD"]').isChecked(), false);
  await go('mailboxes/google'); await go('settings/exchange-rates');
  assert.equal(await page.locator('#fx-interval').inputValue(), '90');
  await page.locator('#fx-currencies').click();
  await page.locator('.fx-currency-options input[value="USD"]').check();
  await page.keyboard.press('Escape');

  delaySettings = true;
  await page.getByRole('button', { name: '保存采集设置', exact: true }).click();
  assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
  await page.waitForFunction(() => document.querySelector('#fx-settings-form [type="submit"]')?.disabled);
  while (!releaseSettings) await new Promise(resolve => setTimeout(resolve, 10));
  await page.locator('#fx-interval').fill('120');
  delaySettings = false; releaseSettings();
  await page.waitForFunction(() => !document.querySelector('#fx-settings-form [type="submit"]')?.disabled && document.querySelector('[name="fx-version"]')?.value === '2');
  assert.equal(document.data.settings.intervalMinutes, 90);
  assert.equal(await page.locator('#fx-interval').inputValue(), '120', '迟到保存不清除后续编辑');
  const interruptedRefresh = { started: Promise.withResolvers(), release: Promise.withResolvers() };
  t.after(interruptedRefresh.release.resolve);
  settingsRefreshInterruption = interruptedRefresh;
  await page.getByRole('button', { name: '保存采集设置', exact: true }).click();
  await interruptedRefresh.started.promise;
  const changesBefore = await page.evaluate(() => window.IDChangeSync.status().changes);
  await page.evaluate(version => window.emitFxVersion(version), document.version);
  await page.waitForFunction(count => window.IDChangeSync.status().changes > count, changesBefore);
  interruptedRefresh.release.resolve();
  await page.waitForFunction(() => document.querySelector('[name="fx-version"]')?.value === '3' && !document.querySelector('#fx-settings-form [type="submit"]')?.disabled);
  assert.equal(document.data.settings.intervalMinutes, 120);
  assert.equal(await page.evaluate(() => window.IDDesignAPI.state.drafts.has('finance-collection-settings')), false, '只清理成功的提交快照');

  // An external settings edit must cause an explicit conflict, then a deliberate rebase.
  const { version, ...settings } = document.data.settings;
  collection.saveSettings(version, { ...settings, intervalMinutes: 180 }, actor);
  await page.locator('#fx-interval').fill('240');
  await page.getByRole('button', { name: '保存采集设置', exact: true }).click();
  await page.locator('#fx-settings-error').getByText(/设置已更新/).waitFor();
  assert.equal(await page.locator('#fx-interval').inputValue(), '240');
  await page.getByRole('button', { name: '核对最新设置', exact: true }).click(); await confirm();
  assert.equal(await page.locator('[name="fx-version"]').inputValue(), '4');
  assert.equal(await page.locator('#fx-interval').inputValue(), '240');
  await page.getByRole('button', { name: '预览清理', exact: true }).click();
  await page.locator('#confirm-dialog[open]').getByRole('button', { name: '取消', exact: true }).click();
  assert(!actions.includes('cleanup'), '预览或取消不删除记录');
  await page.getByRole('button', { name: '设置变更记录', exact: true }).click();
  await page.locator('table[data-table="fx-settings-history"] tbody tr').first().waitFor();
  await page.getByRole('button', { name: '查看变更', exact: true }).first().click();
  await page.locator('#drawer[open]').getByText('120 → 180', { exact: true }).waitFor();
  await page.locator('#drawer[open]').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '返回采集设置', exact: true }).click();
  assert.equal(await page.locator('#fx-interval').inputValue(), '240');

  const output = (process.env.ID_LAYOUT_QA_OUTPUT || root + '/backups/fx-collection-settings-20261107') + '/';
  await mkdir(output, { recursive: true });
  await page.locator('#toast').waitFor({ state: 'hidden' });
  for (const width of [1440, 768, 390, 320]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    const fieldsAligned = await page.locator('#fx-settings-form .field').evaluateAll(fields => fields.every(field => {
      const label = field.querySelector(':scope > label'), control = field.querySelector(':scope > .field-control');
      if (!label || !control) return true;
      return label.getBoundingClientRect().right <= control.getBoundingClientRect().left + 1;
    }));
    assert(fieldsAligned, '窄屏字段标签仍在控件左侧');
    const overviewAligned = await page.locator('.fx-overview > div').evaluateAll(cards => {
      const textTop = node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().top; };
      return cards.every((card, i) => !cards.slice(0, i).some(previous =>
        Math.abs(previous.getBoundingClientRect().top - card.getBoundingClientRect().top) < 1 &&
        (Math.abs(textTop(previous.querySelector('span')) - textTop(card.querySelector('span'))) > 1 ||
          Math.abs(textTop(previous.querySelector('strong')) - textTop(card.querySelector('strong'))) > 1)));
    });
    assert(overviewAligned, '总览并排标题和值的实际文字对齐');
    await page.locator('summary[aria-label="查看采集币种说明"]').click();
    await page.locator('.field-title-help[open] .title-description:popover-open').waitFor();
    const bounds = await page.locator('.field-title-help[open] .title-description').boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width, JSON.stringify({ width, dark, bounds }));
    await page.locator('summary[aria-label="查看采集币种说明"]').click();
    await page.locator('#fx-currencies').click();
    await settle();
    const popup = await page.locator('#fx-currency-popover').boundingBox();
    assert(popup.x >= 0 && popup.x + popup.width <= width && popup.y >= 0 && popup.y + popup.height <= 1000, JSON.stringify({ width, dark, popup }));
    if (width <= 900) assert((await page.locator('.fx-currency-options label').first().boundingBox()).height >= 44);
    await page.keyboard.press('Escape');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if ((width === 1440 && !dark) || (width === 390 && dark)) {
      await page.evaluate(() => window.scrollTo(0, 0)); await settle();
      await page.screenshot({ path: output + 'settings-' + width + (dark ? '-dark' : '-light') + '.png', fullPage: true });
    }
    if (width <= 390) {
      await tab('采集记录');
      await page.locator('tr[data-row-id="fxr-fixture-0"]').waitFor();
      assert.equal(await financePager.locator('[data-pagination-size]').inputValue(), '10');
      await jumpPage(3);
      await page.locator('tr[data-row-id="fxr-fixture-24"]').waitFor();
      await tab('运行状态'); await tab('采集记录');
      await page.locator('tr[data-row-id="fxr-fixture-24"]').waitFor();
      assert.equal(await page.evaluate(() => window.IDDesignAPI.state.page), 3, '切页签返回保留分页');
      await page.locator('#fx-query').fill('没有匹配资料');
      await page.getByRole('heading', { name: '暂无符合条件的汇率记录' }).waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await listAction('清空筛选');
      await page.locator('tr[data-row-id="fxr-fixture-0"]').waitFor();
      await tab('采集设置');
    }
  }
  await tab('当前汇率');
  await page.locator('table[data-table="fx-rates"] tbody tr').filter({ hasText: '美元' }).waitFor();
  await listAction('列设置');
  await page.locator('#drawer[open]').getByText('每 1 原币兑人民币', { exact: true }).waitFor();
  await page.locator('#drawer[open] [data-action="drawer-close"]').first().click();
  rejectReads = true;
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page.getByRole('alert').getByText('合成读取失败，请重试').waitFor();
  const failedReads = reads;
  await settle(); assert.equal(reads, failedReads, '失败后不自动重复请求');
  assert.equal(await page.locator('table[data-table="fx-rates"] tbody tr').count(), 6);
  rejectReads = false;
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#fx-progress:not([hidden])'));
  now += 3_600_000;
  await page.getByRole('button', { name: '立即采集', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#fx-progress:not([hidden])') && !document.querySelector('[data-action="fx-collect"]').disabled);
  assert.equal(providerCalls, 2);
  assert.equal(document.data.quotes.length, 1, '同日相同报价只保留一个批次');
  assert.equal(document.data.runs[0].status, 'unchanged');
  const beforePush = reads;
  document.version++;
  document.data.quotes[0].rates.USD = '7.77777777';
  await page.evaluate(version => window.emitFxVersion(version), document.version);
  const usdRow = page.locator('table[data-table="fx-rates"] tbody tr').filter({ hasText: '美元 USD' });
  await usdRow.locator('[data-column="rate"]').filter({ hasText: '7.77777777' }).waitFor({ state: 'attached' });
  const expand = usdRow.locator('[data-action="table-mobile-toggle"]');
  if (await expand.isVisible()) await expand.click();
  await usdRow.locator('[data-column="rate"]').getByText('7.77777777', { exact: true }).waitFor();
  assert.equal(reads, beforePush + 1, '新版本只触发一次相关读取');
  assert.equal(await page.evaluate(() => window.fxBoot), boot, '没有整页刷新');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  const employeeContext = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await interceptDesign(employeeContext, { localFixtures: fixture, actor: { ...actor, role: 'employee' } });
  let employeeReads = 0;
  await employeeContext.route('**/api/local/finance/collection*', request => { employeeReads++; return request.abort(); });
  const employeePage = await employeeContext.newPage();
  await employeePage.goto(origin + '/#/settings/exchange-rates');
  await employeePage.getByRole('heading', { name: '当前账号无权打开此页面', exact: true }).waitFor();
  assert.equal(await employeePage.locator('#sidebar a[href="#/settings/exchange-rates"]').count(), 0);
  assert.equal(employeeReads, 0);
});
