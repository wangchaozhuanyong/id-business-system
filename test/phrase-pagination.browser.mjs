import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('default phrase order is paged and can be adjusted across a page boundary', { timeout: 20_000 }, async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const phrases = Array.from({ length: 23 }, (_, index) => ({
    id: 'phrase-' + (index + 1), title: '合成话术 ' + (index + 1), text: '测试内容', deleted: false
  }));
  const deleted = { id: 'deleted', title: '已删除话术', text: '测试内容', deleted: true };
  phrases.splice(4, 0, deleted);
  let snapshot = { version: 1, data: { shortcuts: [], phrases } };
  await interceptDesign(context, { localFixtures: {} });
  await context.route(origin + '/api/local/toolbox', route => {
    if (route.request().method() === 'PUT') {
      const { version, data } = route.request().postDataJSON();
      assert.equal(version, snapshot.version);
      snapshot = { version: version + 1, data };
    } else assert.equal(route.request().method(), 'GET');
    return route.fulfill({ json: snapshot });
  });
  const page = await context.newPage();
  await page.goto(origin + '/#/overview');
  await page.getByRole('button', { name: '话术文案', exact: true }).click();
  const drawer = page.locator('#drawer');
  const list = drawer.locator('#ops-phrase-list');
  const pager = drawer.locator('[data-pagination="operations-phrases"]');
  await list.locator('[data-phrase-id="phrase-10"]').waitFor();
  assert.equal(await list.locator('[data-phrase-id]').count(), 10);
  assert.equal(await pager.getAttribute('data-total'), '23');
  assert.equal(await drawer.locator('#ops-phrase-sort').inputValue(), 'custom');
  const keyboard = list.getByRole('button', { name: '调整顺序：合成话术 10', exact: true });
  await keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('[data-pagination="operations-phrases"]')?.dataset.page === '2');
  assert.equal(await list.locator('[data-phrase-id]').first().getAttribute('data-phrase-id'), 'phrase-10');
  assert(await keyboard.evaluate(node => node === document.activeElement));
  assert.equal(snapshot.data.phrases.filter(row => !row.deleted)[9].id, 'phrase-11');
  assert.equal(snapshot.data.phrases[4].id, 'deleted');
  await list.getByLabel('更多：合成话术 10', { exact: true }).click();
  await list.getByRole('button', { name: '上移', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-pagination="operations-phrases"]')?.dataset.page === '1');
  assert.equal(await list.locator('[data-phrase-id]').last().getAttribute('data-phrase-id'), 'phrase-10');

  const source = list.getByRole('button', { name: '调整顺序：合成话术 1', exact: true });
  const target = list.locator('[data-phrase-id="phrase-2"]');
  await source.dragTo(target);
  await page.waitForFunction(() => document.querySelector('#ops-phrase-list [data-phrase-id]')?.dataset.phraseId === 'phrase-2');
  assert.equal(snapshot.data.phrases[4].id, 'deleted');
  assert.equal(snapshot.data.phrases[0].id, 'phrase-2');
});
