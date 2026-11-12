import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, toggleDesignTheme } from './helpers/offline-design.mjs';

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
      let reads = 0;
      await context.route(prefix, route => {
        reads++;
        return route.fulfill({ json: { success: true, cards, planPolicy: policy } });
      });
      await context.route(prefix + '/plan-policy', async route => {
        assert.equal(route.request().method(), 'PUT');
        const command = route.request().postDataJSON();
        writes.push(command);
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
      const box = await dialog.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1;
      });
      assert.equal(box, true);
      await dialog.getByRole('checkbox', { name: 'Pro 500' }).check();
      policy = { ...policy, version: 1 };
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
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
