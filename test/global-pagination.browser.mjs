import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('shared pagination remains compact for 10,000 records and restores each list', { timeout: 55_000 }, async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url), 'utf8'));
  const template = fixture.commerce.data.customers[0];
  fixture.commerce.data.customers = Array.from({ length: 10_000 }, (_, index) => ({
    ...template, id: 'pagination-fixture-' + index, name: '分页样本 ' + String(index).padStart(5, '0')
  }));
  await interceptDesign(context, { localFixtures: fixture });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const pager = page.locator('#main [data-pagination="main-list"]');
  const rows = page.locator('#main tbody tr[data-row-id]');
  const viewport = page.locator('#main .table-viewport');
  const size = pager.getByRole('combobox', { name: '每页条数' });
  const previous = pager.getByRole('button', { name: '上一页' });
  const next = pager.getByRole('button', { name: '下一页' });
  const jump = async (number) => {
    const summary = pager.locator('summary');
    const height = (await pager.boundingBox()).height;
    await summary.click();
    const popup = await pager.locator('.pagination-jump-controls').boundingBox();
    assert(popup.y + popup.height <= (await summary.boundingBox()).y);
    assert.equal((await pager.boundingBox()).height, height);
    await checkVisibleBounds();
    const input = pager.getByRole('spinbutton', { name: '跳至页码' });
    await input.fill(String(number));
    await input.press('Enter');
    await page.locator(`#main [data-pagination="main-list"][data-page="${number}"]`).waitFor();
  };
  const goto = async (route) => {
    await page.evaluate((route) => { location.hash = '#/' + route; }, route);
    await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
  };
  const checkVisibleBounds = async () => {
    assert(await pager.evaluate((node) => {
      const { left, right } = node.getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth &&
        [...node.querySelectorAll('button, select, summary')].filter((control) => control.getClientRects().length)
          .every((control) => {
            const bounds = control.getBoundingClientRect();
            return bounds.left >= left - 1 && bounds.right <= right + 1;
          });
    }));
  };
  const checkSingleRow = async (includeCount) => {
    const centers = await pager.evaluate((node, includeCount) => {
      const elements = node.querySelectorAll(
        (includeCount ? '.pagination-count, ' : '') + 'select, summary, button[data-pagination-page]'
      );
      return [...elements].filter((element) => element.checkVisibility()).map((element) => {
        const { top, height } = element.getBoundingClientRect();
        return top + height / 2;
      });
    }, includeCount);
    assert(Math.max(...centers) - Math.min(...centers) <= 1, JSON.stringify(centers));
  };

  await page.goto(origin + '/#/customers/list');
  await rows.first().waitFor();
  assert.equal(await size.inputValue(), '20');
  assert.equal(await size.locator('option:checked').textContent(), '20条/页');
  assert.equal(await rows.count(), 20);
  assert.equal(await previous.isDisabled(), true);
  assert.equal(await pager.locator('.pagination-pages button').count(), 7);
  assert.match(await pager.locator('.pagination-count').textContent(), /10,000 条 · 第 1–20 条/);
  await checkSingleRow(true);
  await checkVisibleBounds();
  const originalHeight = (await viewport.boundingBox()).height;
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.waitForFunction(height => document.querySelector('#main .table-viewport').clientHeight >= height + 178, originalHeight);
  assert(Math.abs((await viewport.boundingBox()).height - originalHeight - 180) <= 2);
  assert((await pager.boundingBox()).y + (await pager.boundingBox()).height <= 1080);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(height => Math.abs(document.querySelector('#main .table-viewport').clientHeight - height) <= 1, originalHeight);
  const beforeScroll = await viewport.evaluate((element) => ({
    header: element.querySelector('thead').getBoundingClientRect().top,
    page: scrollY, scrollable: element.scrollHeight > element.clientHeight
  }));
  const footer = await pager.boundingBox();
  assert(beforeScroll.scrollable);
  assert(footer.y + footer.height <= 900);
  await viewport.hover();
  await page.mouse.wheel(0, 260);
  await page.waitForFunction(() => document.querySelector('#main .table-viewport').scrollTop > 0);
  const afterScroll = await viewport.evaluate((element) => ({
    header: element.querySelector('thead').getBoundingClientRect().top,
    page: scrollY, scrollable: element.scrollHeight > element.clientHeight
  }));
  assert.deepEqual(afterScroll, beforeScroll);
  assert.deepEqual(await pager.boundingBox(), footer);
  const rowOffset = await viewport.evaluate((element) => element.scrollTop);
  await page.evaluate(() => window.IDDesignAPI.render());
  assert.equal(await viewport.evaluate((element) => element.scrollTop), rowOffset);
  await pager.locator('summary').click();
  await pager.locator('[data-pagination-target]').press('Escape');
  assert.equal(await pager.locator('details').getAttribute('open'), null);
  assert(await pager.locator('summary').evaluate((node) => node === document.activeElement));
  await jump(250);
  assert.equal(await viewport.evaluate((element) => element.scrollTop), 0);
  assert.match(await pager.locator('.pagination-count').textContent(), /4,981–5,000/);
  assert.equal(await pager.locator('.pagination-ellipsis').count(), 2);
  assert.equal(await pager.locator('.pagination-pages button').count(), 7);
  await size.selectOption('50');
  assert.equal(await pager.getAttribute('data-page'), '1');
  assert.equal(await rows.count(), 50);
  await jump(7);
  await goto('orders/gpt');
  await size.waitFor();
  assert.equal(await size.inputValue(), '20');
  await goto('customers/list');
  await rows.first().waitFor();
  assert.equal(await size.inputValue(), '50');
  assert.equal(await pager.getAttribute('data-page'), '7');
  const search = page.locator('#main .search-field input').first();
  const populatedHeight = (await viewport.boundingBox()).height;
  await search.fill('不存在的分页样本');
  assert.equal(await rows.count(), 0);
  assert.equal((await viewport.boundingBox()).height, populatedHeight);
  await search.clear();

  await page.setViewportSize({ width: 320, height: 850 });
  assert.equal(await pager.locator('.pagination-pages').isVisible(), false);
  assert((await next.boundingBox()).height >= 44);
  await checkSingleRow(false);
  await checkVisibleBounds();
  assert(await viewport.evaluate(element => element.scrollHeight <= element.clientHeight + 1));
  await size.selectOption('10');
  await jump(1000);
  assert.equal(await next.isDisabled(), true);
  assert.match(await pager.locator('.pagination-count').textContent(), /9,991–10,000/);
  await search.fill('分页样本 00005');
  assert.equal(await pager.getAttribute('data-page'), '1');
  assert.equal(await rows.count(), 1);
  assert.equal(await pager.locator('button[data-pagination-page]').count(), 0);
  await search.fill('不存在的分页样本');
  assert.equal(await rows.count(), 0);
  assert.match(await pager.locator('.pagination-count').textContent(), /共 0 条/);
  assert.deepEqual(errors, []);
});
