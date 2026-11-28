import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, toggleDesignTheme } from './helpers/offline-design.mjs';

test('super-admin receives a spoken pending order, defers, finds it again and confirms the chosen attempt', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const actor = { id:'qa-super', email:'admin@example.test', name:'管理员', role:'super', active:true };
  for (const [width, dark] of [[1440,false],[390,true]]) await t.test(String(width), async () => {
    const ctx = await browser.newContext({ viewport:{width,height:850} });
    try {
      await interceptDesign(ctx,{ actor, localFixtures:{}, changeEvents:true, skipRechargeAssets:true });
      await ctx.addInitScript(() => {
        window.spoken = [];
        Object.defineProperty(window,'speechSynthesis',{value:{speak: phrase => window.spoken.push(phrase.text)}});
        Object.defineProperty(window,'SpeechSynthesisUtterance',{value:class { constructor(text) { this.text = text; } }});
        const original = window.fetch.bind(window);
        window.fetch = (input,options) => {
          if (new URL(String(input),location.href).pathname !== '/api/local/change-events') return original(input,options);
          return Promise.resolve(new Response(new ReadableStream({start(controller) {
            window.emitPaymentVersion = (type,version) => controller.enqueue(new TextEncoder().encode('event: ' + type +
              '\ndata: ' + JSON.stringify({schema:1,versions:{'recharge-activity':version,'payment-approvals':version}}) + '\n\n'));
            window.emitPaymentVersion('snapshot','first');
          }}),{headers:{'Content-Type':'text/event-stream'}}));
        };
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(6000);
      const errors = []; page.on('pageerror',e => errors.push(e.message));
      const actions = [], item = { id:'aa11bb22-1111-2222-3333-aabbccddeeff', plan:'plus', email:'a•••@example.test',
        codeTail:'1111',jobTail:'qwerty',currency:'PHP',amount:'0.00',expires:Date.now()+120000 };
      let rows = [];
      await page.route('**/api/local/recharge-activity**', r => r.fulfill({json:{items:[],unread:0,page:1,pages:1,coverage:'ready'}}));
      await page.route('**/api/admin/payment-approvals**', r => {
        if (r.request().method() === 'POST') { actions.push(r.request().url().split('/').slice(-2)); rows=[]; }
        return r.fulfill({json:{items:rows}});
      });
      await page.goto(origin+'/#/workspace/order/gpt');
      await page.waitForFunction(() => typeof window.emitPaymentVersion === 'function' && window.IDPaymentApprovals);
      if (dark) await toggleDesignTheme(page);
      rows = [item]; await page.evaluate(() => window.emitPaymentVersion('change','second'));
      const popup = page.locator('#payment-approval-toast'), drawer = page.locator('#drawer');
      await popup.getByRole('button',{name:'确认付款',exact:true}).waitFor();
      assert.match(await popup.innerText(),/PHP 0\.00/);
      const box = await popup.boundingBox(); assert(box.x >= 0 && box.x+box.width <= width && box.y>0);
      await page.waitForFunction(() => window.spoken.length === 1);
      await popup.getByRole('button',{name:'稍后处理'}).click();
      assert.deepEqual(actions,[]);
      await page.locator('#recharge-activity-toggle').evaluate(el => el.click());
      await drawer.getByRole('button',{name:'待确认付款',exact:true}).click();
      await drawer.getByRole('button',{name:'确认付款',exact:true}).click();
      await drawer.getByText('暂无待确认付款。').waitFor();
      assert.deepEqual(actions,[[item.id,'approve']]);
      assert.equal(await page.evaluate(() => window.spoken.length),1);
      assert.deepEqual(errors,[]);
    } finally { await ctx.close(); }
  });
});


test('the system configuration tab reads, changes and confirms the actual saved mode', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  await interceptDesign(context);
  let mode = { automatic: false, version: 0 };
  const page = await context.newPage();
  await page.route('**/api/admin/payment-approvals/mode', route => {
    if (route.request().method() === 'PUT') {
      const input = route.request().postDataJSON();
      assert.equal(input.version, mode.version);
      mode = { automatic: input.automatic, version: mode.version + 1 };
    }
    return route.fulfill({ json: mode });
  });
  await page.goto(origin + '/#/online-recharge/chatgpt');
  await page.locator('button[data-view="config"]').click();
  const frame = page.frameLocator('#main iframe:not([hidden])');
  const field = frame.locator('#payment-automatic');
  await frame.getByText('逐单人工确认', { exact: true }).waitFor({ timeout: 7000 });
  assert.equal(await field.isChecked(), false);
  const help = frame.locator('#payment-approval-config details');
  await help.locator('summary').click();
  assert.equal(await help.getAttribute('open'), '');
  await page.keyboard.press('Escape');
  assert.equal(await help.getAttribute('open'), null);
  await field.check();
  await frame.getByRole('button', { name: '保存付款模式' }).click();
  await frame.getByText('新单自动付款', { exact: true }).waitFor({ timeout: 7000 });
  assert.deepEqual(mode, { automatic: true, version: 1 });
});
