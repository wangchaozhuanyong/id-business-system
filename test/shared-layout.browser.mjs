import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startCodexdaichongDemoSite } from '../modules/recharge/codexdaichong/demo-site.mjs';
import { toggleDesignTheme, interceptDesign, origin as offlineOrigin } from './helpers/offline-design.mjs';

// Geometry assertions cover the user-visible regressions; no business writes are allowed.
test('shared layouts preserve alignment, readable controls and stable navigation', { timeout: 120_000 }, async (t) => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const playwright = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const { chromium } = playwright.default || playwright;
  const offline = process.env.ID_LAYOUT_QA_OFFLINE === '1';
  const host = offline ? { url: offlineOrigin + '/' } : await startCodexdaichongDemoSite(0);
  if (!offline) t.after(() => new Promise(resolve => {
    host.server.close(resolve);
    host.server.closeAllConnections();
  }));
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  if (offline) await interceptDesign(page.context(), { localFixtures: {} });
  page.setDefaultTimeout(6000);
  const origin = new URL(host.url).origin;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (!offline) await page.route('**/*', route => {
    const request = route.request();
    return new URL(request.url()).origin === origin && ['GET', 'HEAD'].includes(request.method())
      ? route.continue() : route.abort();
  });
  const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const go = async route => {
    await page.evaluate(route => { location.hash = '#/' + route; }, route);
    await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
    await settled();
  };
  const theme = async dark => {
    if (await page.evaluate(() => document.documentElement.dataset.theme === 'dark') !== dark)
      await toggleDesignTheme(page);
    await settled();
  };
  const box = selector => page.locator(selector).boundingBox();
  const aligned = (a, b, message) => assert(Math.abs(a.y - b.y) <= 1, message);
  const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), page.url());
  const frame = () => page.frameLocator('#main > [data-page-region]:not([hidden]) .recharge-integration__content iframe:not([hidden])');
  const region = page.locator('#main > .design-page-region:visible');
  const centeredPages = new Set([
    'data', 'data/sheets', 'settings/monitoring', 'settings/accounts',
    'settings/mail-types', 'settings/costs', 'settings/payment-countries'
  ]);
  const checkPageWidth = async route => {
    const bounds = await region.evaluate(node => {
      const main = node.parentElement;
      const shell = main.getBoundingClientRect(), body = node.getBoundingClientRect();
      const style = getComputedStyle(main);
      const start = shell.left + parseFloat(style.paddingLeft);
      const end = shell.right - parseFloat(style.paddingRight);
      return { width: body.width, usable: end - start, start: body.left - start, end: end - body.right };
    });
    const width = centeredPages.has(route) ? Math.min(1320, bounds.usable) : bounds.usable;
    const inset = (bounds.usable - width) / 2;
    const label = `${route} 预期宽度 ${width}px，实际 ${JSON.stringify(bounds)}`;
    assert(Math.abs(bounds.width - width) <= 1, label);
    assert(Math.abs(bounds.start - inset) <= 1 && Math.abs(bounds.end - inset) <= 1, label);
    await noOverflow();
  };
  await page.goto(origin + '/#/workspace/order/gpt');

  await t.test('page widths use either the full workspace or the common centered width', async () => {
    const check = async route => {
      await go(route);
      await checkPageWidth(route);
    };
    const routes = await page.evaluate(() => window.IDDesignAPI.navigation.flatMap(group => group[2].map(item => item[1])));
    await page.setViewportSize({ width: 1920, height: 960 });
    for (const route of new Set([...routes, ...centeredPages, 'monitor'])) await check(route);
    await page.locator('#nav-toggle').click();
    await check('data');
    await page.locator('#nav-toggle').click();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of [...centeredPages, 'monitor', 'plugins/websites', 'orders/gpt']) await check(route);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await t.test('mailbox category loading, errors and result counts keep the same width', { skip: !offline }, async () => {
    const route = 'settings/mail-types';
    const settingsEndpoint = '**/api/local/settings';
    const release = Promise.withResolvers();
    const mailboxTypes = Array.from({ length: 25 }, (_, index) => ({
      id: `layout-category-${index + 1}`, label: `布局测试分类 ${index + 1}`, enabled: true
    }));
    let response = { status: 503, json: { error: '布局测试读取失败' } };
    const serveSettings = async request => {
      assert.equal(request.request().method(), 'GET');
      await release.promise;
      await request.fulfill(response);
    };
    const check = async () => {
      await settled();
      await checkPageWidth(route);
      const card = await region.locator(':scope > .panel').boundingBox();
      const outer = await region.boundingBox();
      assert(Math.abs(card.x - outer.x) <= 1 && Math.abs(card.width - outer.width) <= 1, '邮箱分类卡片应与居中容器等宽');
    };
    await go(route);
    await page.route(settingsEndpoint, serveSettings);
    try {
      await page.setViewportSize({ width: 1920, height: 960 });
      await page.reload();
      await region.getByText('正在读取本机设置', { exact: true }).waitFor();
      await check();
      release.resolve();
      await region.getByText('本机设置读取失败', { exact: true }).waitFor();
      await check();
      response = { json: { version: 1, data: { mailboxTypes } } };
      await region.getByRole('button', { name: '重新读取', exact: true }).click();
      const search = region.getByRole('textbox', { name: '搜索当前列表' });
      for (const width of [1920, 1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const dark of [false, true]) {
          await theme(dark);
          for (const [query, count] of [['', 20], ['layout-category-25', 1], ['没有匹配的分类', 0]]) {
            await search.fill(query);
            await page.waitForFunction(count => document.querySelectorAll('#main tr[data-row-id]').length === count, count);
            await check();
          }
        }
      }
    } finally {
      release.resolve();
      await page.unroute(settingsEndpoint, serveSettings);
      await page.setViewportSize({ width: 1440, height: 900 });
      await theme(false);
    }
  });

  await t.test('the sidebar expands at most one group on selection and navigation', async () => {
    const sidebar = page.locator('#sidebar');
    const expandedGroups = () => sidebar.locator('.nav-heading[aria-expanded="true"]')
      .evaluateAll(buttons => buttons.map(button => button.dataset.group));
    await go('accounts/claude');
    assert.deepEqual(await expandedGroups(), ['账号管理']);
    assert.equal(await sidebar.locator('.nav-children').count(), 1);
    assert.equal(await sidebar.locator('a[href="#/accounts/claude"]').getAttribute('aria-current'), 'page');

    const mailboxes = sidebar.getByRole('button', { name: '邮箱管理', exact: true });
    await mailboxes.press('Enter');
    assert.deepEqual(await expandedGroups(), ['邮箱管理']);
    assert.equal(await sidebar.locator('a[href="#/accounts/claude"]').count(), 0);
    assert(await mailboxes.evaluate(button => document.activeElement === button));
    await page.evaluate(() => window.IDDesignAPI.render());
    assert.deepEqual(await expandedGroups(), ['邮箱管理']);
    await mailboxes.press('Space');
    assert.deepEqual(await expandedGroups(), []);

    await mailboxes.click();
    await sidebar.getByRole('link', { name: '谷歌邮箱', exact: true }).click();
    await page.waitForURL(origin + '/#/mailboxes/google');
    assert.deepEqual(await expandedGroups(), ['邮箱管理']);
    await page.goBack();
    await page.locator('#main[data-layout-route="accounts/claude"]').waitFor();
    assert.deepEqual(await expandedGroups(), ['账号管理']);
  });

  await t.test('GPT and Claude order columns align and narrow labels remain usable', async () => {
    for (const width of [2040, 1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const dark of [false, true]) {
        await theme(dark);
        for (const product of ['gpt', 'claude']) {
          await go(`workspace/order/${product}`);
          await page.locator('#commerce-payment').selectOption('银行卡');
          await page.locator('#commerce-proMaterialMode').selectOption(product === 'claude' ? 'tenant_card' : '');
          await settled();
          const groups = await page.locator('.order-financial-group').evaluateAll(nodes =>
            nodes.map(n => n.getBoundingClientRect().top));
          if (groups[0] === groups[1]) {
            aligned(await box('#commerce-paidAmount'), await box('#commerce-saleAmount'), '代付与售卖金额控件不齐');
            aligned(await box('label[for="commerce-paidAmount"]'), await box('label[for="commerce-saleAmount"]'), '代付与售卖标签不齐');
          }
          assert((await box('#commerce-expiry')).y > (await box('#commerce-paidAmount')).y, '订阅周期应独立于金额区');
          const formWidth = await page.locator('.commerce-entry-columns > .form-panel > form').evaluate(node => {
            const style = getComputedStyle(node);
            return node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          });
          if (width >= 1440) assert(formWidth >= 640, '宽屏录单为双列表单保留足够正文宽度');
          if (formWidth >= 640) {
            aligned(await box('#commerce-payment'), await box('#commerce-proMaterialMode'), '支付方式与填写方式应同排');
            aligned(await box('label[for="commerce-payment"]'), await box('label[for="commerce-proMaterialMode"]'), '第一行标签不齐');
            const next = product === 'claude' ? 'tenantId' : 'cardId';
            aligned(await box('#commerce-cardTypeId'), await box(`#commerce-${next}-picker`), '银行卡类型与下一步控件应同排');
            aligned(await box('label[for="commerce-cardTypeId"]'), await box(`label[for="commerce-${next}-picker"]`), '第二行标签不齐');
            if (product === 'claude')
              aligned(await box('#commerce-cardId-picker'), await box('#commerce-tenantCardNumber'), '租户银行卡选择与卡号输入应同排');
            else aligned(await box('#commerce-paymentId'), await box('#commerce-proCardSerial'), '卡尾号与序列号应同排');
          }
          await page.locator('#commerce-payment').selectOption('苹果内购');
          assert(await page.locator('#commerce-appleIdId-picker').isVisible());
          await noOverflow();
          const leftLabels = await page.locator('.field:visible').evaluateAll(nodes => nodes.every(n => {
            const label = n.querySelector(':scope > label');
            const control = n.querySelector(':scope > .field-control');
            return !label || !control || label.getBoundingClientRect().right <= control.getBoundingClientRect().left + 1;
          }));
          assert(leftLabels, '窄屏标签必须仍在控件左侧');
        }
      }
    }
  });

  await t.test('title notes escape clipped panels and drawers without moving fields', async () => {
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await go('customers/new');
      assert.equal(await page.locator('.tabs[aria-label="录入类型"]').count(), 0, '客户与租户通过独立侧栏入口访问');
      const before = await box('#commerce-contact-name');
      await page.locator('summary[aria-label="查看联系方式说明"]').click();
      await page.locator('.title-description:popover-open').waitFor();
      const bounds = await box('.title-description:popover-open');
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width, '说明越过视口');
      assert.deepEqual(await box('#commerce-contact-name'), before, '说明展开推动表单');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.title-help[open]').count(), 0);
      await page.evaluate(() => {
        const api = window.IDDesignAPI;
        api.openDrawer('布局验证', '仅用于隔离验证的长说明。'.repeat(12), api.field('测试字段', 'layout-field', api.input('layout-field')));
      });
      await page.locator('#drawer .title-help summary').click();
      await page.locator('#drawer .title-description:popover-open').waitFor();
      const drawerNote = await box('#drawer .title-description:popover-open');
      assert(drawerNote.x >= 0 && drawerNote.x + drawerNote.width <= width);
      await page.locator('#drawer [data-action="drawer-close"]').click();
    }
  });

  await t.test('field label text starts at the left edge in workspaces and drawers', async () => {
    const assertLabels = async (form, context) => {
      const fields = form.locator('.field > :is(label, dt.field-label):visible');
      await fields.first().waitFor();
      const positions = await fields.evaluateAll(labels => labels.map(label => {
        const text = document.createRange();
        text.selectNodeContents(label);
        const field = label.parentElement.getBoundingClientRect();
        return { label: label.textContent, delta: text.getBoundingClientRect().left - field.left };
      }));
      assert(positions.every(({ delta }) => Math.abs(delta) <= 1),
        `${context} 字段文字应对齐字段行左边缘 ${JSON.stringify(positions)}`);
    };
    for (const width of [1440, 901, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const dark of [false, true]) {
        await theme(dark);
        for (const [route, selector] of [
          ['workspace/account-extract', '#inventory-extract-form'],
          ['customers/new', '#commerce-contact-form'],
          ['workspace/order/gpt', '#commerce-order-form']
        ]) {
          await go(route);
          await assertLabels(page.locator(selector), `${route} ${width} ${dark}`);
        }
        await page.evaluate(() => {
          const api = window.IDDesignAPI;
          api.openDrawer('字段布局验证', '',
            api.field('姓名', 'layout-name', api.input('layout-name'), true, '姓名说明。') +
            api.field('业务记录备注', 'layout-memo', api.input('layout-memo')));
        });
        const drawer = page.locator('#drawer[open]');
        await assertLabels(drawer, `抽屉 ${width} ${dark}`);
        const help = drawer.locator('.field-title-help summary');
        const geometry = await help.evaluate(trigger => {
          const field = trigger.closest('.field');
          const range = document.createRange();
          range.selectNodeContents(field.querySelector('label'));
          const labelEnd = range.getBoundingClientRect().right;
          const control = field.querySelector('.field-control').getBoundingClientRect();
          const bounds = trigger.getBoundingClientRect();
          return { gap: bounds.left - labelEnd, limit: control.left - bounds.right, size: bounds.width };
        });
        assert(geometry.gap >= -1 && geometry.gap <= 1 && geometry.limit >= 0, '说明按钮紧跟标签并留在控件左侧');
        assert(geometry.size >= (width <= 900 ? 44 : 36));
        const before = await drawer.locator('#layout-name').boundingBox();
        await help.press('Enter');
        await drawer.locator('.title-description:popover-open').waitFor();
        assert.deepEqual(await drawer.locator('#layout-name').boundingBox(), before);
        await page.keyboard.press('Escape');
        assert.equal(await drawer.locator('.field-title-help[open]').count(), 0);
        await drawer.locator('[data-action="drawer-close"]').click();
      }
    }
  });

  await t.test('field instructions stay beside labels while validation remains below controls', async () => {
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const dark of [false, true]) {
        await theme(dark);
        await go('workspace/order/claude');
        await page.locator('#commerce-payment').selectOption('银行卡');
        await page.locator('#commerce-proMaterialMode').selectOption('tenant_card');
        const field = page.locator('[data-commerce-field="cardId"]:visible');
        const help = field.locator('.field-title-help');
        const trigger = help.locator('summary');
        const note = help.locator('.title-description');
        await field.scrollIntoViewIfNeeded();
        assert.equal(await help.getAttribute('open'), null, '说明默认收起');
        assert.equal(await field.locator('.field-control > .field-help').count(), 0, '控件下方不常驻使用说明');
        await page.evaluate(() => window.IDDesignAPI.setError('commerce-cardId', '请选择租户银行卡'));
        const error = field.locator('.field-error');
        assert(await error.isVisible(), '校验错误仍直接显示');
        const geometry = await field.evaluate(node => {
          const rect = element => element.getBoundingClientRect().toJSON();
          const label = node.querySelector('label');
          const text = document.createRange();
          text.selectNodeContents(label);
          return { label: text.getBoundingClientRect().toJSON(),
            trigger: rect(node.querySelector('.field-title-help summary')),
            control: rect(node.querySelector('.commerce-picker-trigger')),
            error: rect(node.querySelector('.field-error')) };
        });
        assert(geometry.label.right <= geometry.trigger.left + 1, '说明按钮位于字段文字右侧');
        assert(geometry.trigger.right <= geometry.control.left, '说明按钮不占用输入区域');
        assert(geometry.error.top >= geometry.control.bottom, '校验错误位于控件下方');
        if (width <= 900) assert(geometry.trigger.width >= 44 && geometry.trigger.height >= 44, '手机帮助按钮触控区至少 44px');
        await trigger.focus();
        await settled();
        const before = await field.locator('.field-control').boundingBox();
        await page.keyboard.press('Enter');
        await help.locator('.title-description:popover-open').waitFor();
        assert.match(await note.innerText(), /先选租户再搜索/);
        const bounds = await note.boundingBox();
        assert(bounds.x >= 0 && bounds.x + bounds.width <= width, '字段说明浮层不越过视口');
        assert.deepEqual(await field.locator('.field-control').boundingBox(), before, '说明展开不推动控件或错误');
        await page.keyboard.press('Escape');
        assert.equal(await help.getAttribute('open'), null);
        assert(await trigger.evaluate(node => document.activeElement === node), 'Escape 返回帮助按钮');
        await trigger.click();
        await help.locator('.title-description:popover-open').waitFor();
        await page.locator('#commerce-cardId-picker').click();
        assert.equal(await help.getAttribute('open'), null, '点击外部关闭说明');
        await page.keyboard.press('Escape');
        await noOverflow();
      }
    }
  });

  await t.test('active inventory tabs remain visible after repeated rerender', async () => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await go('mailboxes/google');
      for (const last of [true, false, true]) {
        const target = last ? page.locator('.tabs .tab').filter({ hasText: '解封中' }).first()
          : page.locator('.tabs .tab').first();
        await target.click();
        await settled();
        assert(await page.locator('.tabs').first().evaluate(n => {
          const active = n.querySelector('.active').getBoundingClientRect();
          const bounds = n.getBoundingClientRect();
          return active.left >= bounds.left - 1 && active.right <= bounds.right + 1;
        }), '当前页签被藏到滚动区外');
      }
    }
  });

  await t.test('long-page return restores reading position; empty rates do not reserve a sidebar', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await go('workspace/order/gpt');
    const entry = page.locator('#commerce-order-form');
    const before = await entry.evaluate(form => {
      form.scrollTop = 220;
      return form.scrollTop;
    });
    assert(before > 0);
    await page.evaluate(() => window.IDDesignAPI.render());
    assert.equal(await entry.evaluate(form => form.scrollTop), before);
    await go('customers/new');
    await go('workspace/order/gpt');
    assert.equal(await entry.evaluate(form => form.scrollTop), before);
    await go('settings/costs');
    assert.equal(await page.locator('.side-panel').count(), 0);
    assert.match(await page.locator('#main').innerText(), /暂无汇率报价/);
    const form = await box('.form-panel');
    const main = await box('#main');
    assert(form.width > main.width - 70, '空侧栏仍挤压费用表单');
  });

  await t.test('relay filters and actions align in two rows and empty guidance stays inside the table', async () => {
    await page.setViewportSize({ width: 1591, height: 900 });
    await go('mailboxes/relay');
    await page.getByRole('tab', { name: '隐藏邮箱管理' }).click();
    const toolbar = page.locator('.relay-alias-toolbar');
    const table = page.locator('table[data-table="relay-aliases"]');
    const viewport = page.locator('.table-viewport:has(table[data-table="relay-aliases"])');
    const assertEmptyGuidance = async () => {
      const { left, right, textLeft, textRight } = await viewport.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const guidance = node.querySelector('.empty-state p').getBoundingClientRect();
        return {
          left: bounds.left, right: bounds.left + node.clientWidth,
          textLeft: guidance.left, textRight: guidance.right
        };
      });
      assert(textLeft >= left && textRight <= right, '空状态操作说明不应被表格横向裁切');
      assert(Math.abs((textLeft + textRight - left - right) / 2) <= 2, '空状态说明应在可见区域居中');
    };
    await table.getByRole('heading', { name: '请先添加 Apple 主邮箱' }).waitFor();
    assert.equal(await toolbar.evaluate(node => node.parentElement.querySelectorAll(':scope > .toolbar').length), 1);
    assert.equal(await table.getByText('可调整搜索或筛选条件。', { exact: true }).count(), 0);
    for (const width of [2048, 1591, 1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const dark of [false, true]) {
        await theme(dark);
        assert.deepEqual(await toolbar.evaluate(node => {
          const style = getComputedStyle(node);
          return [style.paddingBlockStart, style.paddingBlockEnd];
        }), ['12px', '12px'], '隐藏邮箱工具栏应采用共用内距');
        const controls = await toolbar.evaluate(node => {
          const middle = element => element.top + element.height / 2;
          return [...node.querySelectorAll('button, input, select, .relay-status-group > span')].filter(control => control.checkVisibility()).map(control => {
            const range = document.createRange();
            range.selectNodeContents(control);
            const bounds = control.getBoundingClientRect();
            return {
              y: middle(control.matches('span') ? range.getBoundingClientRect() : bounds),
              left: bounds.left, right: bounds.right, height: bounds.height,
              label: control.matches('span'), row: [...node.children].indexOf(control.closest('.relay-alias-row'))
            };
          });
        });
        if (width >= 1440) {
          const centers = [0, 1].map(row => controls.filter(c => c.row === row).map(c => c.y));
          assert(centers.every(row => row.length && Math.max(...row) - Math.min(...row) <= 2), '每行按钮和状态文字应居中对齐');
          assert(Math.min(...centers[1]) > Math.max(...centers[0]) + 28, '使用和资料状态应在两行');
          const parent = await box('#relay-filter-parent');
          const action = await box('[data-action="relay-parent-add"]');
          assert(Math.abs(parent.x + parent.width - action.x - action.width) <= 1, '主邮箱筛选与末个操作右边缘应对齐');
        }
        assert(controls.every(c => c.left >= 0 && c.right <= width), '工具栏控件越过视口');
        if (width <= 390)
          assert(controls.filter(c => !c.label).every(c => c.height >= 44), '手机控件触控高度不足');
        await assertEmptyGuidance();
        await viewport.evaluate(node => { node.scrollLeft = node.scrollWidth; });
        await assertEmptyGuidance();
        await viewport.evaluate(node => { node.scrollLeft = 0; });
        await noOverflow();
      }
    }
    await theme(false);
  });

  await t.test('recharge navigation stays on one row and frames never show an intermediate default height', async () => {
    await go('online-recharge/chatgpt');
    await frame().locator('#querySection').waitFor();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const toolbar = await box('#main > [data-page-region]:not([hidden]) .recharge-integration__toolbar');
      assert(toolbar.height < 90, '充值导航不应占多行');
      const button = await box('#main > [data-page-region]:not([hidden]) .recharge-integration__toolbar > button');
      assert(button.x + button.width <= width, '刷新不可被挤出视口');
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const target of ['dashboard', 'query', 'dashboard']) {
      const before = await box('iframe:not([hidden])');
      const samples = page.evaluate(() => new Promise(resolve => {
        const records = [];
        const end = performance.now() + 600;
        function tick() {
          records.push(document.querySelector('iframe:not([hidden])')?.getBoundingClientRect().height || 0);
          if (performance.now() < end) requestAnimationFrame(tick); else resolve(records);
        }
        tick();
      }));
      await page.locator(`button[data-view="${target}"]`).click();
      await frame().locator(target === 'query' ? '#querySection' : '#dashboard.active').waitFor();
      const heights = await samples;
      const after = await box('iframe:not([hidden])');
      assert(heights.every(h => h > 0 && h <= Math.max(before.height, after.height) + 1), JSON.stringify(heights));
    }
    const oldFrame = await page.locator('iframe:not([hidden])').evaluateHandle(n => n);
    await page.route('**/integrations/codexdaichong/status', route => route.fulfill({ status: 503, body: '{}' }), { times: 1 });
    await page.locator('[data-action="ops-integrated-refresh"]').click();
    await page.locator('#main > [data-page-region]:not([hidden]) .recharge-integration__view[aria-busy="false"]').waitFor();
    assert(await page.locator('iframe:not([hidden])').evaluate((n, old) => n === old, oldFrame), '刷新失败应保留原内容');
    await oldFrame.dispose();
  });

  await t.test('recharge work areas reach the footer and keep long logs inside the reader', async () => {
    const desktop = { width: 1680, height: 1060 };
    let entries = [];
    const logRoute = '**/integrations/codexdaichong/api/admin/runtime-logs?*';
    const mockLogs = route => route.fulfill({
      json: {
        success: true,
        entries: new URL(route.request().url()).searchParams.has('tail') ? entries : [],
        nextAfter: entries.length
      }
    });
    await page.route(logRoute, mockLogs);
    const select = view => page.locator(`button[data-view="${view}"]`).click();
    const measure = async selector => {
      const area = frame().locator(selector);
      await area.waitFor();
      await settled();
      return area.evaluate(node => {
        const hostFrame = window.frameElement;
        const host = hostFrame.ownerDocument.defaultView;
        const main = hostFrame.closest('main');
        const footer = main.nextElementSibling;
        const end = host.innerHeight - footer.offsetHeight - parseFloat(host.getComputedStyle(main).paddingBottom);
        const rect = node.getBoundingClientRect();
        return {
          gap: end - hostFrame.getBoundingClientRect().bottom - host.scrollY,
          width: rect.width, height: rect.height, frameWidth: innerWidth,
          overflow: document.documentElement.scrollWidth > innerWidth,
          pageHeight: host.document.documentElement.scrollHeight
        };
      });
    };
    const fit = (bounds, minimum) => {
      assert(Math.abs(bounds.gap) <= 2, JSON.stringify(bounds));
      assert(bounds.height >= minimum && bounds.width >= bounds.frameWidth - 100 && !bounds.overflow, JSON.stringify(bounds));
    };
    try {
      await page.setViewportSize(desktop);
      await theme(false);
      await go('online-recharge/chatgpt');
      await select('query');
      fit(await measure('[data-recharge-query] .recharge-card'), 600);
      await frame().getByRole('tab', { name: '批量查询', exact: true }).click();
      const batch = await measure('#batchQueryInput');
      assert(Math.abs(batch.gap) <= 2 && batch.height >= 400 && !batch.overflow, JSON.stringify(batch));
      await frame().getByRole('tab', { name: '单个查询', exact: true }).click();

      for (const [view, selector, minimum] of [
        ['dashboard', '#dashboard.active', 700],
        ['checkout_debug', '#checkout_debug.active .runtime-log-pre-wrap', 270],
        ['cancel_renewal', '#cancel_renewal.active #cancel_renewal_session', 550],
        ['runtime_logs', '#runtime_logs.active .runtime-log-pre-wrap', 650]
      ]) {
        await select(view);
        fit(await measure(selector), minimum);
      }

      const log = '#runtime_logs.active .runtime-log-pre-wrap';
      const before = await measure(log);
      entries = Array.from({ length: 120 }, (_, index) => ({ text: `离线日志第 ${index + 1} 行` }));
      await frame().locator('#runtime_log_refresh_btn').click();
      await frame().getByText(/离线日志第 120 行/).waitFor();
      const atEnd = () => frame().locator(log).evaluate(node =>
        node.scrollTop > 0 && Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 1);
      assert(await atEnd(), '新日志滚动到日志区底部');
      assert.deepEqual(await measure(log), before, '日志增长不撑高外页');

      await page.setViewportSize({ width: 390, height: 844 });
      await theme(true);
      fit(await measure(log), 300);
      assert(await atEnd(), '缩窗使日志换行后仍跟随最新一条');
      await noOverflow();
      await frame().locator('#runtime_log_autoscroll').uncheck();
      await frame().locator(log).evaluate(node => { node.scrollTop = 0; });
      await Promise.all([
        page.waitForResponse(response => response.url().includes('/admin/runtime-logs?tail=1')),
        frame().locator('#runtime_log_refresh_btn').click()
      ]);
      await settled();
      assert.equal(await frame().locator(log).evaluate(node => node.scrollTop), 0);

      await page.setViewportSize({ width: 1440, height: 460 });
      const short = await measure(log);
      assert(short.height >= 200 && short.pageHeight > 460 && !short.overflow, JSON.stringify(short));
      await frame().locator('#runtime_log_refresh_btn').scrollIntoViewIfNeeded();
      assert(await frame().locator('#runtime_log_refresh_btn').isVisible());
    } finally {
      await page.unroute(logRoute, mockLogs);
      await theme(false);
    }
  });

  await t.test('recharge log tables scroll within their containers with readable single-line headings', async () => {
    await page.setViewportSize({ width: 390, height: 900 });
    await go('settings/login-logs');
    await page.locator('[data-action="ops-login-log-tab"][data-tab="recharge"]').click();
    await frame().locator('#admin_login_logs.active').waitFor();
    const tables = await frame().locator('#admin_login_logs table').evaluateAll(nodes => nodes.map(n => ({
      scroll: getComputedStyle(n.parentElement).overflowX,
      headings: [...n.querySelectorAll('th')].map(th => ({ height: th.getBoundingClientRect().height, wrapping: getComputedStyle(th).whiteSpace }))
    })));
    assert.equal(tables.length, 2);
    for (const table of tables) {
      assert.equal(table.scroll, 'auto');
      assert(table.headings.every(th => th.height < 60 && th.wrapping === 'nowrap'));
    }
    await noOverflow();
  });
  await t.test('summary strips distribute all metrics evenly without a fixed four-column limit', async () => {
    await go('mailboxes/google');
    await page.evaluate(() => {
      const fixture = document.createElement('section');
      fixture.id = 'summary-layout-fixture';
      document.getElementById('main').append(fixture);
    });
    try {
      for (const width of [1440, 1024, 901, 900, 768, 720, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const dark of [false, true]) {
          await theme(dark);
          for (const count of [1, 3, 4, 5]) {
            const boxes = await page.evaluate(count => {
              const fixture = document.getElementById('summary-layout-fixture');
              fixture.innerHTML = window.IDDesignAPI.summary(Array.from({ length: count }, (_, i) =>
                ['统计项目' + (i + 1), 12345 + i, '个']));
              return [...fixture.querySelectorAll('.summary-item')].map(node => node.getBoundingClientRect().toJSON());
            }, count);
            assert.equal(boxes.length, count);
            assert(boxes.every(item => item.left >= 0 && item.right <= width), '统计不能溢出视口');
            if (width > 900) {
              for (const item of boxes) {
                aligned(item, boxes[0], '桌面统计不因项数变化而提前换行');
                assert(Math.abs(item.width - boxes[0].width) <= 1, '统计按实际项数等宽排列');
              }
            } else if (count % 2 && count > 1) {
              assert(Math.abs(boxes.at(-1).right - boxes[1].right) <= 1, '窄屏奇数项末行完整铺开');
              assert(boxes.at(-1).top >= boxes.at(-2).bottom, '统计行之间不得重叠');
            }
            await noOverflow();
          }
        }
      }
    } finally {
      await page.evaluate(() => document.getElementById('summary-layout-fixture')?.remove());
    }
  });
  assert.deepEqual(errors, []);
});
