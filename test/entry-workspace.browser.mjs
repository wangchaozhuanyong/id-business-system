import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { toggleDesignTheme, interceptDesign, origin, settle } from './helpers/offline-design.mjs';

test('录入工作台：宽表格、日期查询、独立分页与历史抽屉', { timeout: 150_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const clock = Date.parse('2026-11-10T04:00:00Z');
  const actor = { id: 'entry-qa', name: '离线录入员', role: 'super' };
  const products = ['GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok'];
  const plans = ['Plus', 'Pro', 'Max 5x', 'Google AI Pro', 'The X Subscription Premium'];
  const sample = fixture.commerce.data.orders[0];
  const contact = {
    wechat: 'qa_customer_"wechat"&id',
    phone: '+1 (202) 555-0102',
    qq: '08',
    whatsapp: '+1 (202) 555-0103',
    telegram: '@qa_customer_contact'
  };
  const orderWechat = 'qa_order_wechat_snapshot';
  const invalidChatLink = 'https://example.invalid/unknown-contact';
  fixture.commerce.data.customers = Array.from({ length: 12 }, (_, i) => ({
    id: `entry-customer-${i}`, name: i === 0 ? '林先生 · 企业订阅' : `示例客户 ${i + 1}`,
    active: true, version: 1, createdAt: i === 11 ? '' : new Date(clock - Math.floor(i / 2) * 86_400_000 - i * 60_000).toISOString(),
    ...(i % 2 ? { phone: '+60 12 345 6789' } : { wechat: i === 0 ? 'customer_' + 'long_contact_'.repeat(5) : 'sample_wechat_' + i }),
    ...(i === 1 ? contact : i === 2 ? { whatsapp: invalidChatLink, telegram: invalidChatLink } : {}),
    tags: [], source: '客户推荐', notes: i === 0 ? '隔离测试长备注 ' + '仅用于离线验收。'.repeat(40) : ''
  }));
  fixture.commerce.data.orders = products.flatMap((product, p) => fixture.commerce.data.customers.map((customer, i) => ({
    ...sample, id: `entry-order-${p}-${i}`, orderNo: `DEMO-${p}-${i}`, product, plan: plans[p],
    customerId: customer.id, createdAt: customer.createdAt, email: `sample-${p}-${i}@example.test`,
    wechat: i === 1 ? orderWechat : '', customerPhone: ' ', qq: '', whatsapp: '', telegram: '', source: '管理员手工', taskId: '',
    payment: i === 2 ? '' : i % 2 ? '苹果内购' : '银行卡',
    createdById: actor.id, createdBy: actor.name
  })));
  fixture.commerce.data.tenants = [{ id: 'entry-tenant', name: '示例租户', phone: '+60 11 222 3333', createdAt: '2026-11-09 19:00', active: true, version: 1 }];
  fixture['auth/session'] = { actor, configured: true };
  fixture['auth/order-owners'] = { items: [actor] };
  fixture['auth/display-names'] = { items: [actor] };
  fixture['card-types'] = { version: 1, items: [{ id: 'entry-type', name: '订阅业务卡', active: true }], assignments: {} };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles' });
  const mock = await interceptDesign(context, { actor, localFixtures: fixture, skipRechargeAssets: true });
  let failRead = false, delayRead = false;
  await context.route('**/api/local/commerce', async route => {
    assert.equal(route.request().method(), 'GET', '此诊断不应提交业务资料');
    if (delayRead) await new Promise(resolve => setTimeout(resolve, 300));
    return failRead ? route.fulfill({ status: 503, json: { error: 'offline-read-failure' } })
      : route.fulfill({ json: fixture.commerce });
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(clock);
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const go = async route => {
    await page.evaluate(route => { location.hash = '#/' + route; }, route);
    await page.locator('#commerce-entry-records').waitFor({ state: 'attached' });
    await settle(page);
  };
  const checks = [];
  const geometry = async (width, route, dark) => {
    const result = await page.evaluate(() => {
      const root = document.querySelector('.commerce-entry-columns');
      const formPanel = root.querySelector(':scope > section.panel');
      const form = formPanel.getBoundingClientRect();
      const records = root.querySelector('.entry-records');
      const history = records.getBoundingClientRect();
      const sideBySide = history.left >= form.right;
      const findings = [];
      const editor = formPanel.querySelector('form');
      const quickCustomer = editor.querySelector('.order-quick-customer');
      if (quickCustomer) {
        const bounds = quickCustomer.closest('.field-control').getBoundingClientRect();
        const disclosure = quickCustomer.closest('details');
        const controls = [editor.querySelector('#commerce-customerId-picker'), disclosure.querySelector('summary'),
          ...(disclosure.open ? quickCustomer.querySelectorAll('input, button') : [])];
        const positions = controls.map(control => control.getBoundingClientRect());
        if (positions.some(position => position.left < bounds.left - 1 || position.right > bounds.right + 1))
          findings.push('客户选择与快捷新增超出资料行');
        if (!disclosure.open && bounds.width >= 340 && Math.abs(positions[1].top - positions[0].top) > 3)
          findings.push('宽屏下客户选择与匹配或新增应同排');
        if (innerWidth <= 900 && positions.some(position => position.height < 44))
          findings.push('手机客户资料控件高度不足 44px');
      }
      const firstGroup = editor.querySelector('[data-commerce-section="01"] > .section-heading');
      if (firstGroup) {
        const start = formPanel.querySelector(':scope > .tabs')?.getBoundingClientRect().bottom ?? form.top;
        const heading = firstGroup.getBoundingClientRect();
        const topInset = heading.top + editor.scrollTop - start;
        const fieldGap = firstGroup.nextElementSibling.getBoundingClientRect().top - heading.bottom;
        if (topInset < 11 || topInset > 14 || Math.abs(heading.left - form.left - 17) > 1)
          findings.push('首组标题未贴合紧凑内边距');
        if (Math.abs(fieldGap - 8) > 1) findings.push('标题与首行字段间距不正确');
      }
      const bankTitle = editor.querySelector('.form-section h3');
      if (!firstGroup && bankTitle && Math.abs(bankTitle.getBoundingClientRect().left - form.left - 17) > 1)
        findings.push('银行卡标题应与表单正文左对齐');
      for (const group of editor.querySelectorAll('.order-financial-group')) {
        const bounds = group.getBoundingClientRect();
        const row = group.querySelector('.order-financial-heading');
        const heading = row.getBoundingClientRect();
        if (Math.abs(heading.top - bounds.top - 13) > 1 || Math.abs(heading.left - bounds.left - 13) > 1)
          findings.push('金额卡片标题未沿用紧凑内边距');
        if (row.querySelector('h3').getBoundingClientRect().top - bounds.top > 27)
          findings.push('换行的操作把金额或周期标题推离上边框');
      }
      if (sideBySide) {
        const save = root.querySelector(':scope > section.panel .form-footer .primary')?.getBoundingClientRect();
        const pager = root.querySelector('.entry-records nav[data-pagination]')?.getBoundingClientRect();
        if (Math.abs(form.bottom - history.bottom) > 1) findings.push('录入区与记录区底部未对齐');
        if (!save || save.bottom > form.bottom - 7 || save.top < form.top) findings.push('保存按钮超出录入区');
        if (!pager || Math.abs(history.bottom - pager.bottom) > 2) findings.push('分页未贴合记录区底部');
      }
      const heads = root.querySelectorAll('.entry-record-list th');
      for (const date of root.querySelectorAll('.entry-record-time .entry-record-primary')) {
        if (date.getClientRects().length && date.scrollWidth > date.clientWidth + 1)
          findings.push('提交日期在可见列内被截断');
      }
      const cells = root.querySelector('.entry-record-list tbody tr')?.querySelectorAll('td');
      if (cells?.length === heads.length) heads.forEach((head, i) => {
        if (Math.abs(head.getBoundingClientRect().left - cells[i].getBoundingClientRect().left) > 1) findings.push('表头与数据错列');
      });
      if (records.dataset.kind === 'order') {
        const viewport = records.querySelector('.table-viewport');
        const action = viewport.querySelector('th.table-actions');
        const detail = viewport.querySelector('td.table-actions button');
        const label = document.createRange();
        label.selectNodeContents(action);
        const { paddingLeft, paddingRight } = getComputedStyle(action);
        const contentWidth = Math.max(label.getBoundingClientRect().width, detail?.offsetWidth ?? 0);
        const naturalWidth = contentWidth + parseFloat(paddingLeft) + parseFloat(paddingRight);
        if (action.getBoundingClientRect().width > naturalWidth + 2) findings.push('详情列超出内容所需宽度');
        if (sideBySide) {
          if (form.width <= history.width) findings.push('并排时未优先分配表单宽度');
          if (detail) {
            const initial = detail.getBoundingClientRect();
            const viewportLeft = viewport.getBoundingClientRect().left;
            if (initial.left < viewportLeft || initial.right > viewportLeft + viewport.clientWidth + 1)
              findings.push('详情按钮超出可视表格');
            const scrollLeft = viewport.scrollLeft;
            viewport.scrollLeft = viewport.scrollWidth;
            if (Math.abs(detail.getBoundingClientRect().left - initial.left) > 1)
              findings.push('横向滚动时详情按钮移出固定位置');
            viewport.scrollLeft = scrollLeft;
          }
        }
      }
      for (const control of root.querySelectorAll('input:not([type=hidden]),select,textarea,button,summary')) {
        if (!control.checkVisibility()) continue;
        const rect = control.getBoundingClientRect();
        const parent = control.closest('.field-control,.panel-heading,.form-footer')?.getBoundingClientRect();
        if (parent && (rect.left < parent.left - 1 || rect.right > parent.right + 1)) findings.push(`控件越界：${control.id || control.textContent.trim()}`);
      }
      for (const field of root.querySelectorAll('.field')) {
        if (!field.checkVisibility()) continue;
        const label = field.querySelector(':scope > label');
        const control = field.querySelector(':scope > .field-control');
        if (label && control && label.getBoundingClientRect().right > control.getBoundingClientRect().left + 1) findings.push(`标签覆盖：${label.textContent}`);
      }
      for (const text of root.querySelectorAll('.order-value-readout')) {
        if (!text.checkVisibility()) continue;
        if (text.scrollWidth > text.clientWidth + 1) findings.push(`文字横向裁切：${text.className}`);
      }
      return { findings, overflow: document.documentElement.scrollWidth > innerWidth, sideBySide, formWidth: form.width, recordWidth: history.width };
    });
    assert.deepEqual(result.findings, [], `${width} ${route} ${dark}`);
    assert.equal(result.overflow, false, `${width} ${route}`);
    assert.equal(result.sideBySide, width >= 1440, `${width} 记录区应按可用宽度放置`);
    checks.push({ width, route, dark, ...result });
  };
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.locator('#commerce-entry-records').waitFor({ state: 'attached' });

  await t.test('单行表格、动态渠道列、套餐支付备注与业务隔离', async () => {
    const history = page.locator('#commerce-entry-records');
    assert.equal(await history.locator('[data-pagination]').getAttribute('data-page-size'), '20');
    assert.equal(await history.locator('tbody tr[data-row-id]').count(), 12);
    assert((await history.locator('td[data-column="plan"] .entry-record-primary').allTextContents()).every(text => text === 'GPT · Plus'));
    assert.deepEqual(await history.locator('thead th').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') || node.textContent.trim())),
      ['客户 / 联系方式', '套餐 / 支付方式', '备注', '提交时间', '操作']);
    assert.equal(await history.getByRole('columnheader', { name: 'QQ', exact: true }).count(), 0);
    assert.equal(await history.locator('[data-entry-record-contact]').first().textContent(), '微信：cu****t_');
    assert(!/QQ|WhatsApp|Telegram/.test(await history.locator('[data-entry-record-contact]').first().textContent()));
    const first = history.locator('tbody tr[data-row-id]').first();
    await page.locator('#commerce-email').fill('unfinished@example.test');
    await first.getByRole('button', { name: '查看林先生 · 企业订阅的录入记录' }).click();
    await page.locator('#drawer[open]').waitFor();
    await page.locator('#drawer [data-action="drawer-close"]').last().click();
    assert.equal(await page.locator('#commerce-email').inputValue(), 'unfinished@example.test');
    await go('workspace/order/claude');
    const labels = await history.locator('td[data-column="plan"]').allTextContents();
    assert(labels.some(x => x.startsWith('Claude Pro')) && labels.some(x => x.startsWith('Claude Max')));
    assert(labels.every(x => x.startsWith('Claude')));
    for (const route of ['workspace/order/gpt', 'workspace/order/claude', 'workspace/order/gemini', 'workspace/order/grok']) {
      await go(route);
      const values = await history.locator('[data-entry-record-payment]').allTextContents();
      assert.deepEqual([...new Set(values)].sort(), ['—', '苹果内购', '银行卡'].sort(), route + ' 显示已保存支付方式及缺失占位');
    }
    await go('customers/new');
    assert.equal(await history.getByRole('columnheader', { name: '支付方式', exact: true }).count(), 0);
    assert.match(await history.locator('td[data-column="plan"]').first().textContent(), /GPT · Plus.*Grok/);
    assert.match(await history.locator('td[data-column="notes"]').first().textContent(), /隔离测试长备注/);
    await history.locator('td[data-column="notes"]').first().getByRole('button').click();
    await page.locator('#drawer[open]').waitFor();
    assert((await page.locator('#drawer').textContent()).includes('仅用于离线验收。'.repeat(40)));
    await page.locator('#drawer [data-action="drawer-close"]').last().click();
    await go('customers/new/tenant');
    assert.equal(await history.getByRole('columnheader', { name: '支付方式', exact: true }).count(), 0);
  });

  await t.test('订单和客户近期记录脱敏，详情支持复制完整值与跳转', async () => {
    const history = page.locator('#commerce-entry-records');
    const drawer = page.locator('#drawer[open]');
    const closeDrawer = () => drawer.locator('[data-action="drawer-close"]').last().click();
    const property = label => drawer.locator('.property-row').filter({ has: page.getByText(label, { exact: true }) });
    const copy = async (label, value) => {
      await property(label).getByRole('button', { name: '复制' + label, exact: true }).click();
      await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, value);
    };
    const links = [
      ['WhatsApp', contact.whatsapp, 'https://wa.me/12025550103'],
      ['Telegram', contact.telegram, 'https://t.me/qa_customer_contact']
    ];
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    for (const [, , href] of links)
      await context.route(href, route => route.fulfill({ body: '离线聊天跳转目标' }));

    const routes = ['gpt', 'claude', 'claude', 'gemini', 'grok'].map((slug, index) => ({
      route: 'workspace/order/' + slug, rowId: `entry-order-${index}-1`, wechat: orderWechat, phoneLabel: '客户电话'
    }));
    routes.push({ route: 'customers/new', rowId: 'entry-customer-1', wechat: contact.wechat, phoneLabel: '联系电话' });
    try {
      for (const { route, rowId, wechat, phoneLabel } of routes) {
        const customerEntry = route === 'customers/new';
        if (customerEntry) await page.setViewportSize({ width: 390, height: 1000 });
        await go(route);
        if (customerEntry) await page.getByRole('tab', { name: '最近客户', exact: true }).click();
        const row = history.locator(`tr[data-row-id="${rowId}"]`);
        const summary = row.locator(customerEntry ? 'td[data-column="contact"]' : '[data-entry-record-contact]');
        if (!(await summary.isVisible())) await row.getByRole('button', { name: '更多资料' }).click();
        const maskedWechat = customerEntry ? 'qa****id' : 'qa****ot';
        assert.equal(await summary.textContent(),
          `联系电话：+1****02；微信：${maskedWechat}；QQ：****；WhatsApp：+1****03；Telegram：@q****ct`);
        assert.equal(await summary.locator('button, a, [title]').count(), 0);
        await row.locator('[data-action$="-detail"]').click();
        for (const [label, value] of [['微信', wechat], [phoneLabel, contact.phone], ['QQ', contact.qq]])
          assert.equal(await property(label).locator('strong').textContent(), value);
        for (const [label, value, href] of links) {
          const field = property(label);
          assert.equal(await field.locator('strong').textContent(), value);
          const link = field.getByRole('link', { name: `打开 ${label}（新标签页）` });
          assert.equal(await link.getAttribute('href'), href);
          assert.equal(await link.getAttribute('target'), '_blank');
          if (customerEntry) {
            assert((await link.boundingBox()).height >= 44);
            const [tab] = await Promise.all([context.waitForEvent('page'), link.click()]);
            await tab.waitForURL(href);
            await tab.close();
          }
        }
        if (route === 'workspace/order/gpt' || customerEntry) {
          await copy('微信', wechat);
          await copy(phoneLabel, contact.phone);
        }
        await closeDrawer();
      }
      await history.locator('tr[data-row-id="entry-customer-2"] [data-action="commerce-contact-detail"]').click();
      assert.equal(await drawer.locator('a.contact-detail-link').count(), 0);
      await copy('WhatsApp', invalidChatLink);
      await copy('Telegram', invalidChatLink);
      await closeDrawer();
    } finally {
      const formTab = page.getByRole('tab', { name: '填写资料', exact: true });
      if (await formTab.isVisible()) await formTab.click();
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await go('customers/new/tenant');
    assert.equal(await history.locator('td[data-column="contact"]').textContent(), '联系电话：+6****33');
    await history.locator('[data-action="commerce-contact-detail"]').click();
    await copy('联系电话', fixture.commerce.data.tenants[0].phone);
    await closeDrawer();
  });

  await t.test('四类订单的日期和分页独立操作，不更改录单草稿', async () => {
    for (const route of ['workspace/order/gpt', 'workspace/order/claude', 'workspace/order/gemini', 'workspace/order/grok']) {
      await go(route);
      const history = page.locator('#commerce-entry-records');
      const pager = history.locator('[data-pagination="commerce-entry-records"]');
      const claude = route.endsWith('/claude');
      await page.locator('#commerce-email').fill('pagination-draft@example.test');
      await pager.getByLabel('每页条数').selectOption('10');
      const payments = await history.locator('[data-entry-record-payment]').allTextContents();
      if (route.endsWith('/gpt')) {
        await page.locator('#commerce-payment').selectOption('苹果内购');
        assert.deepEqual(await history.locator('[data-entry-record-payment]').allTextContents(), payments, '左侧草稿不改变已保存订单的支付方式');
      }
      const frame = await history.locator('.table-viewport').boundingBox();
      await pager.getByRole('button', { name: '下一页', exact: true }).click();
      if (claude) await pager.getByRole('button', { name: '下一页', exact: true }).click();
      assert.equal(await history.locator('tbody tr[data-row-id]').count(), claude ? 4 : 2);
      assert.equal((await history.locator('.table-viewport').boundingBox()).height, frame.height);
      await history.getByRole('button', { name: '今日', exact: true }).click();
      assert.equal(await pager.getAttribute('data-total'), claude ? '4' : '2');
      await history.getByRole('button', { name: '昨日', exact: true }).click();
      assert.equal(await pager.getAttribute('data-total'), claude ? '4' : '2');
      await history.getByRole('button', { name: '选择日期', exact: true }).click();
      await history.getByLabel('开始日期', { exact: true }).fill('2026-11-08');
      await history.getByLabel('结束日期', { exact: true }).fill('2026-11-09');
      await history.getByRole('button', { name: '查询', exact: true }).click();
      assert.equal(await pager.getAttribute('data-total'), claude ? '8' : '4');
      assert.equal(await page.locator('#commerce-email').inputValue(), 'pagination-draft@example.test');
      await history.getByRole('button', { name: '全部', exact: true }).click();
    }
  });

  await t.test('独立分页、北京时间筛选、无结果和返回保留草稿', async () => {
    await go('customers/new');
    const history = page.locator('#commerce-entry-records');
    const pager = history.locator('[data-pagination="commerce-entry-records"]');
    await page.locator('#commerce-contact-name').fill('分页时保留的客户');
    await page.evaluate(() => { window.entryFormBeforeRefresh = document.querySelector('#commerce-contact-form'); });
    await pager.getByLabel('每页条数').selectOption('10');
    const frame = await history.locator('.table-viewport').boundingBox();
    const panel = await history.boundingBox();
    await pager.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await history.locator('tbody tr[data-row-id]').count(), 2);
    assert.equal(await pager.getAttribute('data-page'), '2');
    assert(await page.evaluate(() => window.entryFormBeforeRefresh === document.querySelector('#commerce-contact-form')));
    assert.equal((await history.locator('.table-viewport').boundingBox()).height, frame.height);
    await history.getByRole('button', { name: '今日', exact: true }).click();
    assert.equal(await pager.getAttribute('data-page'), '1');
    assert.equal(await pager.getAttribute('data-total'), '2');
    await history.getByRole('button', { name: '昨日', exact: true }).click();
    assert.equal(await pager.getAttribute('data-total'), '2');
    await history.getByRole('button', { name: '选择日期', exact: true }).click();
    await history.getByLabel('开始日期', { exact: true }).fill('2026-11-08');
    await history.getByLabel('结束日期', { exact: true }).fill('2026-11-07');
    await history.getByRole('button', { name: '查询', exact: true }).click();
    await history.locator('[data-entry-date-error]:not([hidden])').waitFor();
    assert.equal(await pager.getAttribute('data-total'), '2', '无效查询保留上一组记录');
    await history.getByLabel('结束日期', { exact: true }).fill('2026-11-09');
    await history.getByRole('button', { name: '查询', exact: true }).click();
    assert.equal(await pager.getAttribute('data-total'), '4');
    await go('workspace/order/gpt');
    await go('customers/new');
    assert.equal(await history.getByLabel('开始日期', { exact: true }).inputValue(), '2026-11-08');
    assert.equal(await pager.getAttribute('data-total'), '4');
    assert.equal(await page.locator('#commerce-contact-name').inputValue(), '分页时保留的客户');
    const filteredFrame = await history.locator('.table-viewport').boundingBox();
    await history.getByLabel('开始日期', { exact: true }).fill('2027-01-01');
    await history.getByLabel('结束日期', { exact: true }).fill('2027-01-02');
    await history.getByRole('button', { name: '查询', exact: true }).click();
    await history.getByText('所选时间暂无录入记录', { exact: true }).waitFor();
    assert.equal((await history.boundingBox()).height, panel.height, '日期工具栏展开时保持整个记录区高度');
    assert.equal((await history.locator('.table-viewport').boundingBox()).height, filteredFrame.height);
    await history.getByRole('button', { name: '全部', exact: true }).click();
    await pager.getByLabel('每页条数').selectOption('20');
    assert.equal(await history.locator('tbody tr[data-row-id]').count(), 12);
    assert.equal(await pager.getAttribute('data-total'), '12');
    await pager.getByLabel('每页条数').selectOption('10');
  });

  await t.test('关联订单与历史业务直接打开宽抽屉，详情不再嵌小表格', async () => {
    await go('customers/new');
    const first = page.locator('#commerce-entry-records tbody tr[data-row-id]').first();
    await first.getByRole('button', { name: '查看林先生 · 企业订阅的录入记录' }).click();
    assert.equal(await page.locator('#drawer table[data-table="commerce-contact-orders"],#drawer table[data-table="commerce-contact-services"]').count(), 0);
    await page.locator('#drawer [data-action="drawer-close"]').last().click();
    for (const [label, table] of [['关联订单', 'commerce-contact-orders'], ['历史开通业务', 'commerce-contact-services']]) {
      await first.getByRole('button', { name: label, exact: true }).click();
      const drawer = page.locator('#drawer[open]');
      assert.equal(await drawer.getAttribute('data-layout'), 'commerce-contact-records');
      assert((await drawer.boundingBox()).width >= 1000);
      await drawer.locator(`table[data-table="${table}"]`).waitFor();
      assert.equal(await drawer.locator('[data-pagination="commerce-contact-records"]').count(), 1);
      await drawer.locator('[data-action="drawer-close"]').last().click();
    }
    assert.equal(await page.locator('#commerce-contact-name').inputValue(), '分页时保留的客户');
  });

  await t.test('长资料、布局与所有录入入口的深浅主题', async () => {
    let clippedSerial = 0, readableSerial = 0;
    for (const width of [2300, 1920, 1440, 1280, 1024, 900, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const dark of [false, true]) {
        if (await page.evaluate(() => document.documentElement.dataset.theme === 'dark') !== dark) await toggleDesignTheme(page);
        for (const route of ['workspace/order/gpt', 'workspace/order/claude', 'workspace/order/gemini', 'workspace/order/grok', 'customers/new', 'customers/new/tenant']) {
          await go(route);
          if (route === 'workspace/order/claude') {
            await page.locator('#commerce-proMaterialMode').selectOption('manual_card');
            await page.locator('#commerce-proCardNumber').fill('4242424242424242');
            const serialInput = page.locator('#commerce-proCardSerial');
            const value = 'SERIAL-' + '0123456789'.repeat(8);
            await serialInput.fill(value);
            await settle(page);
            if ((await page.locator('.commerce-entry-columns > .form-panel').boundingBox()).width >= 700) {
              const payment = await page.locator('#commerce-payment').boundingBox();
              const mode = await page.locator('#commerce-proMaterialMode').boundingBox();
              const type = await page.locator('#commerce-cardTypeId').boundingBox();
              const number = await page.locator('#commerce-proCardNumber').boundingBox();
              const serial = await serialInput.boundingBox();
              assert(Math.abs(payment.y - mode.y) <= 1 && mode.x > payment.x, '支付方式与填写方式同排');
              assert(Math.abs(type.y - number.y) <= 1 && number.x > type.x && type.y >= mode.y + mode.height - 1,
                '银行卡类型与手填卡号在下一行对齐');
              assert(serial.y >= number.y + number.height - 1, '卡序列号在后续行完整可用');
            }
            const clipped = await serialInput.evaluate(input => {
              const style = getComputedStyle(input), measure = document.createElement('canvas').getContext('2d');
              measure.font = style.font;
              const available = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
              return measure.measureText(input.value).width > available + 1;
            });
            const readout = page.locator('[data-commerce-field="proCardSerial"] .order-value-readout');
            assert.equal(await serialInput.inputValue(), value);
            if (clipped) {
              await readout.waitFor();
              assert.equal(await readout.textContent(), value);
              clippedSerial++;
            } else {
              assert.equal(await readout.count(), 0, '序列号已完整显示时不重复回显');
              readableSerial++;
            }
          }
          await settle(page);
          await geometry(width, route, dark);
          if (output && [1440, 390].includes(width) && ['workspace/order/claude', 'customers/new'].includes(route)) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: join(output, `${route.split('/').at(-1)}-${width}-${dark ? 'dark' : 'light'}.png`), fullPage: true, animations: 'disabled' });
          }
        }
      }
    }
    assert(clippedSerial > 0 && readableSerial > 0, '同时覆盖序列号裁切和完整显示');
  });

  await t.test('千条和万条末页、历史表分页与北京时间日界线', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await go('customers/new');
    const history = page.locator('#commerce-entry-records');
    const pager = history.locator('[data-pagination="commerce-entry-records"]');
    const original = structuredClone(fixture.commerce.data);
    try {
      await pager.getByLabel('每页条数').selectOption('20');
      for (const total of [1001, 10001]) {
        fixture.commerce.data.customers = Array.from({ length: total }, (_, i) => ({
          ...original.customers[0], id: `dense-${i}`, name: `隔离分页客户 ${i}`, notes: '',
          createdAt: new Date(clock - i * 60_000).toISOString()
        }));
        await history.getByRole('button', { name: '刷新最近录入记录' }).click();
        await page.waitForFunction(total => document.querySelector('#commerce-entry-records [data-pagination]').dataset.total === String(total), total);
        await pager.locator('.pagination-jump summary:visible').click();
        await pager.getByLabel('跳至页码', { exact: true }).fill(String(Math.ceil(total / 20)));
        await pager.getByRole('button', { name: '跳转', exact: true }).click();
        assert.equal(await history.locator('tbody tr[data-row-id]').count(), 1);
        assert.equal(await history.locator('tbody tr[data-row-id]').getAttribute('data-row-id'), `dense-${total - 1}`);
        assert.equal(await pager.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
        await pager.getByLabel('每页条数').selectOption('50');
        assert.equal(await pager.getAttribute('data-page'), '1');
        assert.equal(await history.locator('tbody tr[data-row-id]').count(), 50);
        await pager.getByLabel('每页条数').selectOption('20');
      }
      fixture.commerce.data.customers = [
        ['2026-11-09T15:59:59.999Z', '昨天最后一刻'], ['2026-11-09T16:00:00Z', '今天第一刻'],
        ['2026-11-10T15:59:59.999Z', '今天最后一刻'], ['2026-11-10T16:00:00Z', '明天第一刻']
      ].map(([createdAt, name], i) => ({ ...original.customers[0], id: `midnight-${i}`, createdAt, name }));
      await history.getByRole('button', { name: '刷新最近录入记录' }).click();
      await page.waitForFunction(() => document.querySelector('#commerce-entry-records [data-pagination]').dataset.total === '4');
      await history.getByRole('button', { name: '今日', exact: true }).click();
      assert.equal(await pager.getAttribute('data-total'), '2');
      assert((await history.locator('td[data-column="name"]').allTextContents()).every(text => text.startsWith('今天')));
      await history.getByRole('button', { name: '昨日', exact: true }).click();
      assert.equal(await pager.getAttribute('data-total'), '1');
      assert.equal(await history.locator('td[data-column="name"]').textContent(), '昨天最后一刻');
      await history.getByRole('button', { name: '全部', exact: true }).click();
      fixture.commerce.data.customers = original.customers;
      fixture.commerce.data.orders = Array.from({ length: 23 }, (_, i) => ({
        ...original.orders[0], id: `history-${i}`, orderNo: `DEMO-HISTORY-${i}`,
        plan: `隔离历史套餐 ${i}`, paidConfirmed: true, start: '2026-11-09T10:00', expiry: '2026-12-09T10:00'
      }));
      await history.getByRole('button', { name: '刷新最近录入记录' }).click();
      await page.waitForFunction(() => document.querySelector('#commerce-entry-records [data-pagination]').dataset.total === '12');
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        if (width <= 900) await page.getByRole('tab', { name: '最近客户', exact: true }).click();
        for (const label of ['关联订单', '历史开通业务']) {
          await history.locator('tbody tr[data-row-id]').first().getByRole('button', { name: label, exact: true }).click();
          const drawer = page.locator('#drawer[open]');
          const nav = drawer.locator('[data-pagination="commerce-contact-records"]');
          assert.equal(await nav.getAttribute('data-total'), '23');
          if (width === 1440) await nav.getByRole('button', { name: '下一页', exact: true }).click();
          assert.equal(await nav.getAttribute('data-page'), '2', '重开抽屉保持自己的分页');
          assert.equal(await drawer.locator('tbody tr[data-row-id]').count(), 3);
          assert(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth));
          if (output) await page.screenshot({ path: join(output, `history-${label === '关联订单' ? 'orders' : 'services'}-${width}.png`), animations: 'disabled' });
          await drawer.locator('[data-action="drawer-close"]').last().click();
        }
      }
    } finally {
      fixture.commerce.data = original;
      await page.setViewportSize({ width: 1440, height: 1000 });
      await history.getByRole('button', { name: '全部', exact: true }).click();
      await history.getByRole('button', { name: '刷新最近录入记录' }).click();
      await page.waitForFunction(() => document.querySelector('#commerce-entry-records [data-pagination]').dataset.total === '12');
    }
  });

  await t.test('刷新成功和失败都保留输入、焦点之外的表单节点与旧记录', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await go('customers/new');
    await page.locator('#commerce-contact-name').fill('尚未保存的客户');
    await page.evaluate(() => { window.entryFormBeforeRefresh = document.querySelector('#commerce-contact-form'); });
    delayRead = true;
    fixture.commerce.data.customers.unshift({ id: 'new-readback', name: '刚录入的客户', wechat: 'new_customer', createdAt: '2026-11-10 12:01', active: true, version: 1 });
    await page.getByRole('button', { name: '刷新最近录入记录' }).click();
    await page.locator('#commerce-entry-records tr[data-row-id="new-readback"]').waitFor();
    assert.equal(await page.locator('#commerce-contact-name').inputValue(), '尚未保存的客户');
    assert(await page.evaluate(() => window.entryFormBeforeRefresh === document.querySelector('#commerce-contact-form')));
    failRead = true;
    await page.getByRole('button', { name: '刷新最近录入记录' }).click();
    await page.locator('[data-entry-error]:not([hidden])').waitFor();
    assert.equal(await page.locator('#commerce-entry-records tr[data-row-id="new-readback"]').count(), 1);
    assert.equal(await page.locator('#commerce-contact-name').inputValue(), '尚未保存的客户');
    failRead = false;
    fixture.commerce.data.customers = [{ id: 'unknown-time', name: '<img src=x onerror=alert(1)>', active: true }];
    await page.getByRole('button', { name: '刷新最近录入记录' }).click();
    await page.locator('#commerce-entry-records tr[data-row-id="unknown-time"]').waitFor();
    assert.equal(await page.locator('#commerce-entry-records img').count(), 0);
    assert.equal(await page.locator('#commerce-entry-records td[data-column="submittedAt"]').textContent(), '时间未记录');
    fixture.commerce.data.customers = [];
    await page.getByRole('button', { name: '刷新最近录入记录' }).click();
    await page.getByText('暂无录入记录', { exact: true }).waitFor();
    assert.equal(await page.locator('#commerce-contact-name').inputValue(), '尚未保存的客户');
  });
  await t.test('付款资料变体切换与窄屏长套餐仍完整可用', async () => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of ['workspace/order/claude', 'workspace/order/gpt', 'workspace/order/gemini', 'workspace/order/grok']) {
        await go(route);
        if (route.endsWith('/claude')) {
          await page.locator('#commerce-plan').selectOption('Pro');
          await page.locator('#commerce-payment').selectOption('银行卡');
          for (const mode of ['manual_card', 'pool_card', 'tenant_card', 'none']) {
            await page.locator('#commerce-proMaterialMode').selectOption(mode);
            await settle(page);
            await geometry(width, route, true);
          }
          await page.locator('#commerce-plan').selectOption('Max 5x');
        }
        if (/\/(gemini|grok)$/.test(route))
          await page.locator('#commerce-plan').selectOption(route.endsWith('/gemini') ? 'Google AI Ultra 20x' : 'SuperGrok Heavy');
        await page.locator('#commerce-payment').selectOption('苹果内购');
        await settle(page);
        assert(await page.locator('#commerce-appleIdId-picker').isVisible());
        await geometry(width, route, true);
      }
    }
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(mock.external, []);
  assert.deepEqual(mock.unavailable, []);
  if (output) await writeFile(join(output, 'geometry.json'), JSON.stringify(checks, null, 2));
});
