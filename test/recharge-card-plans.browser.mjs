import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

async function editorLayout(dialog) {
  const layout = await dialog.evaluate(node => {
    const rect = element => element.getBoundingClientRect().toJSON();
    const style = getComputedStyle(document.documentElement);
    const footer = node.querySelector('footer');
    return {
      rect: rect(node), width: innerWidth,
      top: parseFloat(style.getPropertyValue('--embed-visible-top')) || 0,
      height: parseFloat(style.getPropertyValue('--embed-visible-height')) || innerHeight,
      background: getComputedStyle(node).backgroundColor,
      expectedBackground: getComputedStyle(document.querySelector('#cards .panel')).backgroundColor,
      overflow: node.scrollWidth > node.clientWidth + 1,
      target: rect(node.querySelector('.card-plan-target')),
      header: rect(node.querySelector('header')),
      close: rect(node.querySelector('#card_plan_close')),
      choices: [...node.querySelectorAll('label')].map(rect),
      footer: rect(footer), buttons: [...footer.querySelectorAll('button')].map(rect)
    };
  });
  assert.equal(layout.background, layout.expectedBackground, '弹层必须有与主题一致的不透明背景');
  assert.notEqual(layout.background, 'rgba(0, 0, 0, 0)');
  assert.equal(layout.overflow, false);
  assert(layout.rect.left >= 11 && layout.rect.right <= layout.width - 11, '弹层左右留白');
  assert(layout.rect.top >= layout.top + 11 && layout.rect.bottom <= layout.top + layout.height - 11,
    '弹层必须完整位于宿主可见区域内');
  assert(Math.abs((layout.rect.left + layout.rect.right) / 2 - layout.width / 2) < 2, '弹层横向居中');
  assert(Math.abs((layout.rect.top + layout.rect.bottom) / 2 - layout.top - layout.height / 2) < 2,
    '长嵌入页滚动后仍在可见区域居中');
  assert(layout.choices.every(rect => rect.height >= 44), '套餐整块选项至少 44px');
  assert(layout.close.top - layout.header.top >= 8 && layout.header.bottom - layout.close.bottom >= 8,
    '关闭按钮与标题分隔线保持距离');
  assert(layout.target.left > layout.rect.left && layout.target.right < layout.rect.right, '银行卡摘要没有裁切');
  assert(layout.rect.height < 520, '少量设置按内容高度显示，不拉成长页面');
  assert(layout.buttons.every(rect => rect.top - layout.footer.top >= 8 &&
    layout.footer.bottom - rect.bottom >= 8 && rect.bottom <= layout.rect.bottom - 8),
  '底部按钮不裁切，且与分隔线保持间距');
  return layout;
}

test('银行卡套餐可单张或批量保存，冲突保留草稿，严格模式独立启用', { timeout: 45_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const prefix = origin + '/integrations/codexdaichong/api/admin/cards';
  for (const width of [1440, 390]) {
    await t.test(String(width), async t => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      t.after(() => context.close());
      const traffic = await interceptDesign(context, {
        actor: { id: 'card-plan-operator', name: '离线超级管理员', role: 'super' },
        localFixtures: { 'card-types': { version: 1, items: [], assignments: {} } }
      });
      let policy = { version: 0, strict: false };
      const cards = [
        { id: 1, last4: '1111', allowed_plans: null },
        { id: 2, last4: '2222', allowed_plans: ['pro100'] },
        { id: 3, last4: '3333', allowed_plans: null }
      ];
      const writes = [];
      let reads = 0, pending, received;
      await context.route(prefix, route => {
        reads++;
        return route.fulfill({ json: { success: true, cards, planPolicy: policy } });
      });
      await context.route(prefix + '/plan-policy', async route => {
        assert.equal(route.request().method(), 'PUT');
        const command = route.request().postDataJSON();
        writes.push(command);
        if (pending) { received.resolve(); await pending.promise; }
        if (command.version !== policy.version)
          return route.fulfill({ status: 409, json: { success: false, message: '套餐设置已更新' } });
        if (command.cardIds) for (const id of command.cardIds)
          cards.find(card => card.id === id).allowed_plans = command.allowedPlans;
        policy = { version: policy.version + 1, strict: command.strict ?? policy.strict };
        return route.fulfill({ json: { success: true, planPolicy: policy } });
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/#/online-recharge/chatgpt');
      if (width === 390) await toggleDesignTheme(page);
      await page.locator('[data-action="ops-integrated-view"][data-view="cards"]').click();
      const frame = page.frameLocator('iframe[data-view="cards"]:visible');
      await frame.locator('#card_plan_summary').getByText(/未设置 2 张/).waitFor();
      await frame.locator('[data-card-plan-select][value="1"]').check();
      await frame.locator('[data-card-plan-select][value="2"]').check();
      await frame.getByRole('button', { name: '设置所选 2 张卡' }).click();
      const dialog = frame.getByRole('dialog', { name: '设置允许套餐' });
      await editorLayout(dialog);
      assert.equal(await dialog.locator('#card_plan_target').textContent(), '已选 2 张银行卡');
      assert.match(await dialog.locator('#card_plan_target_detail').textContent(), /1111.*2222/);
      assert.equal(await dialog.locator('#card_plan_selection').textContent(), '已选 0 / 4');
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      assert.equal(writes.length, 0, '空选择不发送保存请求');
      assert.equal(await dialog.locator('#card_plan_result').getAttribute('data-state'), 'error');
      await dialog.getByRole('checkbox', { name: 'Pro 500' }).check();
      assert.equal(await dialog.locator('#card_plan_selection').textContent(), '已选 1 / 4');
      policy = { ...policy, version: 1 };
      pending = Promise.withResolvers(); received = Promise.withResolvers();
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      await received.promise;
      assert(await dialog.getByRole('button', { name: '保存中…', exact: true }).isDisabled());
      assert(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled());
      assert(await dialog.getByRole('button', { name: '关闭套餐设置', exact: true }).isDisabled());
      assert(await dialog.getByRole('checkbox', { name: 'Pro 500' }).isDisabled());
      await dialog.locator('form').dispatchEvent('submit');
      await page.keyboard.press('Escape');
      assert(await dialog.isVisible(), '保存中不会被 Escape 关闭');
      assert.equal(writes.length, 1, '保存中防止重复提交');
      pending.resolve(); pending = undefined;
      await dialog.getByText(/套餐设置已更新/).waitFor();
      assert.equal(await dialog.getByRole('checkbox', { name: 'Pro 500' }).isChecked(), true);
      await dialog.getByRole('button', { name: '取消' }).click();
      await frame.getByRole('button', { name: '设置所选 2 张卡' }).click();
      assert.equal(await dialog.getByRole('checkbox', { name: 'Pro 500' }).isChecked(), true);
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      await frame.locator('[data-card-plan-edit="1"]').getByText('Pro 500').waitFor();
      await frame.locator('[data-card-plan-edit="2"]').getByText('Pro 500').waitFor();
      await frame.locator('[data-card-plan-edit="3"]').getByText('未设置').waitFor();
      assert.deepEqual(writes[1], { version: 1, cardIds: [1, 2], allowedPlans: ['pro500'] });
      await frame.locator('[data-card-plan-edit="2"]').click();
      assert.equal(await dialog.locator('#card_plan_target').textContent(), '•••• 2222');
      assert(await dialog.locator('#card_plan_target_detail').isHidden());
      await dialog.getByRole('checkbox', { name: 'Pro 500' }).uncheck();
      await dialog.getByRole('checkbox', { name: 'Plus', exact: true }).check();
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      await frame.locator('[data-card-plan-edit="2"]').getByText('Plus').waitFor();
      await frame.getByRole('button', { name: '仅使用已设置套餐的卡' }).click();
      await frame.locator('#admin_confirm_ok').click();
      await frame.locator('#card_plan_summary').getByText(/未设置的卡不参与自动取卡/).waitFor();
      assert.deepEqual(writes.at(-1), { version: 3, strict: true });
      assert.deepEqual(cards[0].allowed_plans, ['pro500']);
      const before = reads;
      policy = { ...policy, version: 5 };
      cards[2].allowed_plans = ['pro200'];
      const notify = () => page.locator('iframe[data-view="cards"]:visible').evaluate(frame => {
        frame.contentWindow.postMessage({ source: 'id-recharge-shell', type: 'data-change',
          scopes: ['recharge-card-plans'], cardPlanVersion: 'fixture:5' }, location.origin);
      });
      await notify();
      await frame.locator('[data-card-plan-edit="3"]').getByText('Pro 200').waitFor();
      assert.equal(reads, before + 1);
      await notify();
      await frame.locator('#card_plan_summary').evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(reads, before + 1);
      assert.deepEqual(errors, []);
      assert.deepEqual(traffic.external, []);
    });
  }
});

test('套餐弹层和导入共用控件覆盖深浅主题、嵌入与独立页、窄屏及滚动', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const evidence = [];
  for (const embedded of [true, false]) for (const theme of ['light', 'dark'])
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 900 },
      { width: 901, height: 900 }, { width: 900, height: 900 }, { width: 768, height: 900 }, { width: 390, height: 844 },
      { width: 320, height: 640 }, { width: 844, height: 390 }]) {
      const name = `${embedded ? 'embedded' : 'standalone'}-${theme}-${viewport.width}`;
      await t.test(name, async t => {
        const context = await browser.newContext({ viewport });
        t.after(() => context.close());
        const traffic = await interceptDesign(context, {
          actor: { id: 'card-plan-layout', name: '离线验收', role: 'super' },
          localFixtures: { 'card-types': { version: 1,
            items: [{ id: 'sample', name: '合成银行卡类型', active: true }], assignments: {} } }
        });
        let cards = [
          { id: 1, last4: '1111', allowed_plans: null, is_active: 1, status: '正常' },
          { id: 2, last4: '2222', allowed_plans: ['plus', 'pro100', 'pro200', 'pro500'], is_active: 1, status: '正常' }
        ];
        await context.route(origin + '/integrations/codexdaichong/api/admin/cards', route =>
          route.fulfill({ json: { success: true, cards, planPolicy: { version: 0, strict: false } } }));
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + (embedded ? '/#/online-recharge/chatgpt' : '/integrations/codexdaichong/admin?view=cards'));
        if (theme === 'dark') {
          if (embedded) await toggleDesignTheme(page);
          else await page.evaluate(() => { document.documentElement.dataset.idTheme = 'dark'; });
        }
        if (embedded) await page.locator('[data-action="ops-integrated-view"][data-view="cards"]').click();
        const scope = embedded ? page.frameLocator('iframe[data-view="cards"]:visible') : page;
        const trigger = scope.locator('[data-card-plan-edit="1"]');
        const dialog = scope.getByRole('dialog', { name: '设置允许套餐' });
        await trigger.click();
        await settle(page);
        const first = await editorLayout(dialog);
        assert.equal(await dialog.locator('#card_plan_target').textContent(), '•••• 1111');
        const help = dialog.getByLabel('查看设置允许套餐说明');
        assert.equal(await dialog.locator('.title-help').getAttribute('open'), null);
        const beforeHelp = await dialog.locator('#card_plan_options').boundingBox();
        await help.click();
        await dialog.locator('.title-description:popover-open').waitFor();
        assert.deepEqual(await dialog.locator('#card_plan_options').boundingBox(), beforeHelp, '标题说明不推动套餐选项');
        await page.keyboard.press('Escape');
        assert(await dialog.isVisible(), '有说明时 Escape 先关闭说明');
        assert.equal(await dialog.locator('.title-help').getAttribute('open'), null);
        if (viewport.width <= 900) {
          const helpBox = await help.boundingBox(), closeBox = await dialog.locator('#card_plan_close').boundingBox();
          assert(helpBox.width >= 44 && helpBox.height >= 44 && closeBox.width >= 44 && closeBox.height >= 44);
        }
        const plus = dialog.getByRole('checkbox', { name: 'Plus', exact: true });
        await dialog.locator('label').filter({ hasText: /^Plus$/ }).click();
        assert.equal(await plus.isChecked(), true, '选项整块可点击');
        if (viewport.height < 400) {
          const last = dialog.getByRole('checkbox', { name: 'Pro 500', exact: true });
          await last.check();
          assert(await last.isChecked(), '横屏下滚动内容区后仍能操作最后一个套餐');
          await last.uncheck();
        }
        await plus.focus();
        await page.keyboard.press('Tab');
        assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'Tab 导航到弹层内下一个控件');
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true, '关闭后焦点回到入口');
        await trigger.click();
        if (embedded) assert.equal(await plus.isChecked(), true, '宿主草稿保留 Escape 关闭前的选择');
        if (output) {
          await dialog.evaluate(() => document.activeElement?.blur());
          await page.screenshot({ path: join(output, name + '-editor.png') });
          await dialog.screenshot({ path: join(output, name + '-dialog.png') });
        }
        await dialog.getByRole('button', { name: '关闭套餐设置', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true);

        await scope.getByRole('button', { name: '批量导入', exact: true }).click();
        const plans = scope.locator('#card_pool_import_plans');
        for (const selector of ['#card_pool_import_box .import-box-header', '.card-pool-import-type > .title-with-help']) {
          const help = scope.locator(selector).locator('.title-help');
          const trigger = help.locator('summary');
          const control = scope.locator('#card_pool_import_type');
          assert.equal(await help.getAttribute('open'), null, '说明默认收起');
          await trigger.scrollIntoViewIfNeeded();
          const before = await control.boundingBox();
          await trigger.click();
          await help.locator('.title-description:popover-open').waitFor();
          assert.deepEqual(await control.boundingBox(), before, '说明打开不挤动导入控件');
          await page.keyboard.press('Escape');
          assert.equal(await help.getAttribute('open'), null);
        }
        await scope.locator('#card_pool_import_type').selectOption('sample');
        await plans.getByRole('checkbox', { name: 'Pro 200', exact: true }).check();
        const fields = await plans.evaluate(node => {
          const grid = node.querySelector('.card-plan-grid').getBoundingClientRect();
          const type = document.querySelector('#card_pool_import_type').getBoundingClientRect();
          const legend = node.querySelector('legend').getBoundingClientRect();
          const labelText = document.createRange();
          labelText.selectNodeContents(node.querySelector('legend'));
          const items = [...node.querySelectorAll('label')];
          return {
            aligned: Math.abs(grid.left - type.left) < 2 && (innerWidth <= 600
              ? labelText.getBoundingClientRect().bottom + 7 <= grid.top : legend.right + 8 <= grid.left),
            overflow: node.scrollWidth > node.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1,
            targets: items.every(item => {
              const box = item.getBoundingClientRect(), text = item.querySelector('span').getBoundingClientRect();
              return box.height >= 44 && box.left >= grid.left && box.right <= grid.right + 1 &&
                text.right <= box.right && text.bottom <= box.bottom;
            }),
            gap: document.querySelector('#card_pool_import_text').getBoundingClientRect().top - node.getBoundingClientRect().bottom
          };
        });
        assert.equal(fields.aligned, true, '套餐与银行卡类型保持相同标签和控件列');
        assert.equal(fields.overflow, false, '导入选项不产生页面横向溢出');
        assert.equal(fields.targets, true, '套餐文字完整，触控区足够');
        assert(fields.gap >= 8, '选项与粘贴框保持间距');
        if (output) await page.screenshot({ path: join(output, name + '-import.png'), fullPage: true });

        // A long import panel makes the row entry scroll out of its original position.
        await trigger.click();
        await settle(page);
        const scrolled = await editorLayout(dialog);
        if (viewport.height < 400) {
          await dialog.locator('#card_plan_result').evaluate(node => {
            node.textContent = '合成保存失败提示，保留所选套餐，请稍后重试。'.repeat(12);
          });
          await editorLayout(dialog);
          assert.equal(await dialog.locator('.card-plan-editor-body').evaluate(node => node.scrollHeight > node.clientHeight),
            true, '短屏长提示在内容区滚动');
        }
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        cards = [];
        await scope.locator('body').evaluate(() => loadCardPoolList());
        await scope.locator('#card_plan_summary').getByText(/未设置 0 张/).waitFor();
        assert.equal(await scope.locator('#card_plan_batch').isDisabled(), true);
        assert.equal(await plans.getByRole('checkbox', { name: 'Pro 200', exact: true }).isChecked(), true);
        assert.deepEqual(errors, []);
        assert.deepEqual(traffic.external, []);
        evidence.push({ name, viewport, first, scrolled, fields });
      });
    }
  if (output) await writeFile(join(output, 'layout.json'), JSON.stringify(evidence, null, 2));
});
