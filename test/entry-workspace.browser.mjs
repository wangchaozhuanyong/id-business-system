import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

test('录入工作台：两列、近期分组、长资料与刷新草稿隔离', { timeout: 150_000 }, async t => {
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
  fixture.commerce.data.customers = Array.from({ length: 12 }, (_, i) => ({
    id: `entry-customer-${i}`, name: i === 0 ? '林先生 · 企业订阅' : `示例客户 ${i + 1}`,
    active: true, version: 1, createdAt: i === 11 ? '' : new Date(clock - Math.floor(i / 2) * 86_400_000 - i * 60_000).toISOString(),
    ...(i % 2 ? { phone: '+60 12 345 6789' } : { wechat: i === 0 ? 'customer_' + 'long_contact_'.repeat(5) : 'sample_wechat_' + i }),
    tags: [], source: '客户推荐'
  }));
  fixture.commerce.data.orders = products.flatMap((product, p) => fixture.commerce.data.customers.map((customer, i) => ({
    ...sample, id: `entry-order-${p}-${i}`, orderNo: `DEMO-${p}-${i}`, product, plan: plans[p],
    customerId: customer.id, createdAt: customer.createdAt, email: `sample-${p}-${i}@example.test`,
    wechat: '', customerPhone: '', qq: '', whatsapp: '', telegram: '', source: '管理员手工', taskId: '',
    createdById: actor.id, createdBy: actor.name
  })));
  fixture.commerce.data.tenants = [{ id: 'entry-tenant', name: '示例租户', phone: '+60 11 222 3333', createdAt: '2026-11-09 19:00', active: true, version: 1 }];
  fixture['auth/session'] = { actor, configured: true };
  fixture['auth/order-owners'] = { items: [actor] };
  fixture['auth/display-names'] = { items: [actor] };
  fixture['card-types'] = { version: 1, items: [{ id: 'entry-type', name: '订阅业务卡', active: true }], assignments: {} };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles' });
  const mock = await interceptDesign(context, { actor, localFixtures: fixture });
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
    await page.locator('#commerce-entry-records').waitFor();
    await settle(page);
  };
  const checks = [];
  const geometry = async (width, route, dark) => {
    const result = await page.evaluate(() => {
      const root = document.querySelector('.commerce-entry-columns');
      const form = root.querySelector(':scope > .form-panel').getBoundingClientRect();
      const history = root.querySelector('.entry-records').getBoundingClientRect();
      const findings = [];
      for (const control of root.querySelectorAll('input:not([type=hidden]),select,textarea,button,summary')) {
        if (!control.checkVisibility()) continue;
        const rect = control.getBoundingClientRect();
        const parent = control.closest('.field-control,.entry-record,.panel-heading,.form-footer')?.getBoundingClientRect();
        if (parent && (rect.left < parent.left - 1 || rect.right > parent.right + 1)) findings.push(`控件越界：${control.id || control.textContent.trim()}`);
      }
      for (const field of root.querySelectorAll('.field')) {
        if (!field.checkVisibility()) continue;
        const label = field.querySelector(':scope > label');
        const control = field.querySelector(':scope > .field-control');
        if (label && control && label.getBoundingClientRect().right > control.getBoundingClientRect().left + 1) findings.push(`标签覆盖：${label.textContent}`);
      }
      for (const text of root.querySelectorAll('.entry-record-heading strong,.entry-record-contacts dd,.entry-record-plan,.order-value-readout')) {
        if (!text.checkVisibility()) continue;
        if (text.scrollWidth > text.clientWidth + 1) findings.push(`文字横向裁切：${text.className}`);
      }
      return { findings, overflow: document.documentElement.scrollWidth > innerWidth, sideBySide: history.left >= form.right, formWidth: form.width, recordWidth: history.width };
    });
    assert.deepEqual(result.findings, [], `${width} ${route} ${dark}`);
    assert.equal(result.overflow, false, `${width} ${route}`);
    assert.equal(result.sideBySide, width >= 1440, `${width} 记录区应按可用宽度放置`);
    checks.push({ width, route, dark, ...result });
  };
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.locator('#commerce-entry-records').waitFor();

  await t.test('真实录入时间分组、业务隔离、已填写渠道与详情', async () => {
    const history = page.locator('#commerce-entry-records');
    assert.equal(await history.locator('.entry-record').count(), 10);
    assert.deepEqual((await history.locator('.entry-record-day h3').allTextContents()).slice(0, 2), ['今日2 条', '昨日2 条']);
    assert((await history.locator('.entry-record-plan').allTextContents()).every(text => text === 'GPT · Plus'));
    const first = history.locator('.entry-record').first();
    assert.deepEqual(await first.locator('dt').allTextContents(), ['微信']);
    await history.locator('.entry-record').last().scrollIntoViewIfNeeded();
    const lastAction = await history.locator('.entry-record').last().getByRole('button').boundingBox();
    const scrollport = await history.locator('.entry-record-list').boundingBox();
    assert(lastAction && lastAction.y >= scrollport.y && lastAction.y + lastAction.height <= scrollport.y + scrollport.height, '滚动后最后一条操作应完整可见');
    await history.locator('.entry-record-list').evaluate(node => { node.scrollTop = 0; });
    await page.locator('#commerce-email').fill('unfinished@example.test');
    await first.getByRole('button', { name: '查看林先生 · 企业订阅的录入记录' }).click();
    await page.locator('#drawer[open]').waitFor();
    await page.locator('#drawer [data-action="drawer-close"]').last().click();
    assert.equal(await page.locator('#commerce-email').inputValue(), 'unfinished@example.test');
    await go('workspace/order/claude');
    const labels = await history.locator('.entry-record-plan').allTextContents();
    assert(labels.some(x => x.startsWith('Claude Pro')) && labels.some(x => x.startsWith('Claude Max')));
    assert(labels.every(x => x.startsWith('Claude')));
    await go('customers/new');
    assert.equal(await history.locator('.entry-record-plan').count(), 0);
    assert.deepEqual(await history.locator('.entry-record').nth(1).locator('dt').allTextContents(), ['联系电话']);
  });

  await t.test('长资料、布局与所有录入入口的深浅主题', async () => {
    for (const width of [1920, 1440, 1280, 1024, 900, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const dark of [false, true]) {
        if (await page.evaluate(() => document.documentElement.dataset.theme === 'dark') !== dark) await page.locator('#theme-toggle').click();
        for (const route of ['workspace/order/gpt', 'workspace/order/claude', 'workspace/order/gemini', 'workspace/order/grok', 'customers/new', 'customers/new/tenant']) {
          await go(route);
          if (route === 'workspace/order/claude') {
            await page.locator('#commerce-proMaterialMode').selectOption('manual_card');
            await page.locator('#commerce-proCardNumber').fill('4242424242424242');
            await page.locator('#commerce-proCardSerial').fill('SERIAL-' + '0123456789'.repeat(8));
            if (width >= 1024) {
              const a = await page.locator('#commerce-proCardNumber').boundingBox();
              const b = await page.locator('#commerce-proCardSerial').boundingBox();
              assert(Math.abs(a.y - b.y) <= 1, '银行卡号和卡序列号应一行两个');
            }
            await page.locator('[data-commerce-field="proCardSerial"] .order-value-readout').waitFor();
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
  });

  await t.test('刷新成功和失败都保留输入、焦点之外的表单节点与旧记录', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await go('customers/new');
    await page.locator('#commerce-contact-name').fill('尚未保存的客户');
    await page.evaluate(() => { window.entryFormBeforeRefresh = document.querySelector('#commerce-contact-form'); });
    delayRead = true;
    fixture.commerce.data.customers.unshift({ id: 'new-readback', name: '刚录入的客户', wechat: 'new_customer', createdAt: '2026-11-10 12:01', active: true, version: 1 });
    await page.getByRole('button', { name: '刷新最近录入记录' }).click();
    await page.locator('[data-entry-record-id="new-readback"]').waitFor();
    assert.equal(await page.locator('#commerce-contact-name').inputValue(), '尚未保存的客户');
    assert(await page.evaluate(() => window.entryFormBeforeRefresh === document.querySelector('#commerce-contact-form')));
    failRead = true;
    await page.getByRole('button', { name: '刷新最近录入记录' }).click();
    await page.locator('[data-entry-error]:not([hidden])').waitFor();
    assert.equal(await page.locator('[data-entry-record-id="new-readback"]').count(), 1);
    assert.equal(await page.locator('#commerce-contact-name').inputValue(), '尚未保存的客户');
    failRead = false;
    fixture.commerce.data.customers = [{ id: 'unknown-time', name: '<img src=x onerror=alert(1)>', active: true }];
    await page.getByRole('button', { name: '刷新最近录入记录' }).click();
    await page.locator('[data-entry-record-id="unknown-time"]').waitFor();
    assert.equal(await page.locator('.entry-record img').count(), 0);
    assert.equal(await page.locator('.entry-record-day h3').textContent(), '时间未记录1 条');
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
          await page.locator('#commerce-product').selectOption('Claude Pro');
          await page.locator('#commerce-payment').selectOption('银行卡');
          for (const mode of ['manual_card', 'pool_card', 'tenant_card', 'people', 'none']) {
            await page.locator('#commerce-proMaterialMode').selectOption(mode);
            await settle(page);
            await geometry(width, route, true);
          }
          await page.locator('#commerce-product').selectOption('Claude Max');
        }
        if (/\/(gpt|claude)$/.test(route)) await page.locator('#commerce-payment').selectOption('苹果内购');
        else {
          await page.locator('#commerce-plan').selectOption(route.endsWith('/gemini') ? 'Google AI Ultra 20x' : 'SuperGrok Heavy');
          await page.locator('#commerce-billingChannel').selectOption('app_store');
        }
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
