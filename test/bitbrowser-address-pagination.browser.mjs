import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { listBitBrowserAddresses } from '../server/bitbrowser-addresses.mjs';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

test('address pagination retains the active response and corrects an out-of-range page', { timeout: 30_000 }, async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const actor = { id: '11111111-1111-4111-8111-111111111111', name: '离线管理员', role: 'super' };
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  t.after(() => context.close());
  const { external } = await interceptDesign(context, { actor, localFixtures: { 'auth/session': { configured: true, actor } } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  let records = Array.from({ length: 121 }, (_, index) => ({
    id: 'fixture-' + index, line1: index + ' Fixture Avenue', status: 'unused',
    city: 'Portland', state: 'OR', postalCode: '97204', country: 'US',
    createdAt: new Date(Date.UTC(2026, 10, 9, 0, 0, index)).toISOString(), usedAt: null
  }));
  let delayPageTwo = false;
  let delaySizeChange = false;
  let unavailable = false;
  const sizeChangeStarted = Promise.withResolvers();
  const sizeChangeReleased = Promise.withResolvers();
  t.after(sizeChangeReleased.resolve);
  const delayed = Promise.withResolvers();
  const release = Promise.withResolvers();
  const released = Promise.withResolvers();
  t.after(release.resolve);
  await page.route('**/api/local/bitbrowser-addresses?*', async (route) => {
    const parameters = new URL(route.request().url()).searchParams;
    const request = { page: Number(parameters.get('page')), pageSize: Number(parameters.get('pageSize')) };
    requests.push(request);
    if (unavailable) return route.fulfill({ status: 503, json: { error: '地址读取暂时失败' } });
    const result = listBitBrowserAddresses(records, parameters);
    if (delaySizeChange && request.pageSize === 20) {
      delaySizeChange = false;
      sizeChangeStarted.resolve();
      await sizeChangeReleased.promise;
    }
    if (delayPageTwo && request.page === 2) {
      delayPageTwo = false;
      delayed.resolve();
      await release.promise;
      await route.fulfill({ json: result }).finally(released.resolve);
      return;
    }
    return route.fulfill({ json: result });
  });

  await page.goto(origin + '/#/recharge/start');
  const panel = page.getByRole('complementary', { name: '地址管理' });
  await panel.getByRole('heading', { name: '地址管理' }).waitFor();
  const pager = panel.locator('nav[data-pagination="bitbrowser-addresses"]');
  const rows = panel.locator('#bit-address-list tbody tr');
  const row = id => panel.locator(`#bit-address-list tr[data-row-id="fixture-${id}"]`);
  const jump = async number => {
    await pager.locator('.pagination-jump summary').click();
    await pager.locator('[data-pagination-target]').fill(String(number));
    await pager.getByRole('button', { name: '跳转', exact: true }).click();
  };

  await row(120).waitFor();
  assert.equal(await pager.locator('[data-pagination-size]').inputValue(), '10');
  assert.equal(await rows.count(), 10);
  await jump(13);
  await row(0).waitFor();
  assert.equal(await rows.count(), 1);
  assert.equal(await pager.getByRole('button', { name: '下一页' }).isDisabled(), true);
  delaySizeChange = true;
  await pager.locator('[data-pagination-size]').selectOption('20');
  await sizeChangeStarted.promise;
  assert.equal(await pager.getAttribute('data-page'), '13');
  assert.equal(await pager.locator('[data-pagination-size]').inputValue(), '10');
  assert.equal(await row(0).isVisible(), true);
  sizeChangeReleased.resolve();
  await row(120).waitFor();
  assert.equal(await rows.count(), 20);
  assert.deepEqual(requests.slice(0, 3), [
    { page: 1, pageSize: 10 }, { page: 13, pageSize: 10 }, { page: 1, pageSize: 20 }
  ]);

  delayPageTwo = true;
  await jump(2);
  await delayed.promise;
  await jump(3);
  await row(80).waitFor();
  release.resolve();
  await released.promise;
  await settle(page);
  assert.equal(await pager.getAttribute('data-page'), '3');
  assert.equal(await row(80).isVisible(), true);
  assert.equal(await row(100).count(), 0);

  const refresh = panel.getByRole('button', { name: '刷新', exact: true });
  records = records.slice(0, 21);
  await refresh.click();
  await row(0).waitFor();
  assert.equal(await rows.count(), 1);
  assert.equal(await pager.getAttribute('data-page'), '2');
  assert.deepEqual(requests.slice(-2), [{ page: 3, pageSize: 20 }, { page: 2, pageSize: 20 }]);
  unavailable = true;
  await refresh.click();
  await panel.getByText(/地址读取暂时失败/).waitFor();
  assert.equal(await row(0).isVisible(), true);
  assert.equal(await pager.getAttribute('data-page'), '2');
  const failedSize = page.waitForResponse(response =>
    new URL(response.url()).searchParams.get('pageSize') === '50' && response.status() === 503
  );
  await pager.locator('[data-pagination-size]').selectOption('50');
  await failedSize;
  await settle(page);
  assert.equal(await pager.locator('[data-pagination-size]').inputValue(), '20');
  assert.equal(await row(0).isVisible(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
