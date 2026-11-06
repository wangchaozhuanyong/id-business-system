import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startPreview } from '../server/preview.mjs';

test('库存、隐藏邮箱和苹果余额表单保留草稿、隔离类型并保护迟到保存', { timeout: 90_000 }, async (t) => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const host = await startPreview(0, { databasePath: ':memory:' });
  const origin = new URL(host.url).origin;
  let browser;
  let releaseSave = () => {};
  t.after(async () => {
    releaseSave();
    await browser?.close();
    host.server.closeAllConnections();
    await new Promise(resolve => host.server.close(resolve));
  });
  const asset = (id, type, extra = {}) => ({
    id, type, email: `${id}@example.test`, password: 'isolated-fixture-only', phone: 'fixture',
    status: '正常', health: 'normal', source: '自己注册', country: '美国', version: 1,
    inventoryState: 'available', used: false, usageLinks: [], inventoryHistory: [], ...extra
  });
  const inventory = {
    mailboxes: [asset('qa-google', 'google'), asset('qa-claimed', 'google', {
      inventoryState: 'claimed', used: true, claimId: 'qa-claim', claimBatchId: 'qa-batch'
    }), asset('qa-apple', 'apple'), ...['a', 'b'].map(suffix => asset(`qa-relay-${suffix}`, 'relay', {
      parentMailboxId: 'qa-parent', relayStatus: 'ACTIVE', aliasId: `qa-relay-${suffix}`
    }))],
    accounts: [],
    batches: [{ id: 'qa-batch', kind: 'mail', actorId: 'local-operator', actorName: '隔离测试',
      purpose: '注册 GPT', items: [{ id: 'qa-claim', assetId: 'qa-claimed', email: 'qa-claimed@example.test',
        status: 'pending', taskId: '', registrationId: '', orderId: '' }] }],
    returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: [],
    appleRelay: { parents: [{ id: 'qa-parent', email: 'qa-parent@example.test', status: 'ACTIVE',
      days: 30, version: 1 }], imports: [], events: [] }
  };
  const seeded = await fetch(host.url + 'api/local/inventory', { method: 'PUT',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 0, data: inventory }) });
  assert.equal(seeded.status, 200);
  browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());
  await page.route('**/api/local/apple-relay/*', route => {
    const operation = new URL(route.request().url()).pathname.split('/').at(-1);
    const result = operation === 'status'
      ? { configured: true, parentIds: ['qa-parent'], aliasIds: ['qa-relay-a', 'qa-relay-b'], codeQueryConfigured: true }
      : operation === 'mails'
        ? { items: [{ id: 'qa-mail', parentId: 'qa-parent', aliasId: 'qa-relay-a', subject: '隔离测试邮件', version: 1 }] }
        : null;
    assert(result, `本测试不执行收件或查询码写入：${operation}`);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  const go = async route => {
    await page.evaluate(route => window.IDDesignAPI.go(route), route);
    await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
  };
  const close = () => page.evaluate(() => window.IDDesignAPI.closeDrawer());
  const action = (module, action, data = {}) => page.evaluate(({ module, action, data }) => {
    window.IDDesignModules.find(item => item.id === module).onClick(action, { dataset: data });
  }, { module, action, data });
  await page.goto(host.url + '#/mailboxes/google');
  await page.waitForFunction(() => window.IDDesignAPI?.collections.mailboxes.some(row => row.id === 'qa-google'));

  await t.test('库存新增类型分别保留，注册及使用抽屉关闭和切页后恢复', async () => {
    await action('inventory', 'inventory-add-type', { type: 'gpt' });
    await page.locator('#inventory-email').fill('gpt-draft@example.test');
    await page.locator('#inventory-notes').fill('GPT 独立草稿');
    await page.locator('#inventory-asset-type').selectOption('claude');
    assert.equal(await page.locator('#inventory-email').inputValue(), '');
    await page.locator('#inventory-email').fill('claude-draft@example.test');
    await page.locator('#inventory-notes').fill('Claude 独立草稿');
    await page.locator('#inventory-asset-type').selectOption('gpt');
    assert.equal(await page.locator('#inventory-email').inputValue(), 'gpt-draft@example.test');
    assert.equal(await page.locator('#inventory-notes').inputValue(), 'GPT 独立草稿');
    await page.locator('#inventory-asset-type').selectOption('claude');
    assert.equal(await page.locator('#inventory-notes').inputValue(), 'Claude 独立草稿');
    await close();
    await go('workspace/account-submit');
    await action('inventory', 'inventory-add-type', { type: 'gpt' });
    await page.locator('#inventory-notes').fill('工作台 GPT 草稿');
    await page.locator('#inventory-asset-type').selectOption('claude');
    assert.equal(await page.locator('#inventory-notes').inputValue(), '');
    await page.locator('#inventory-notes').fill('工作台 Claude 草稿');
    await page.locator('#inventory-asset-type').selectOption('gpt');
    assert.equal(await page.locator('#inventory-notes').inputValue(), '工作台 GPT 草稿');
    assert.equal(await page.locator('#inventory-asset-type').inputValue(), 'gpt');
    await close();
    await go('mailboxes/google');
    await action('inventory', 'inventory-register', { id: 'qa-google' });
    await page.locator('#inventory-registration-product').selectOption('claude');
    await page.locator('#inventory-registration-result').selectOption('待核对');
    await go('customers/list');
    await go('mailboxes/google');
    await action('inventory', 'inventory-register', { id: 'qa-google' });
    assert.equal(await page.locator('#inventory-registration-product').inputValue(), 'claude');
    assert.equal(await page.locator('#inventory-registration-result').inputValue(), '待核对');
    await close();
    await page.evaluate(() => window.IDDesignAPI.getSelection('inventory-claims').add('qa-claim'));
    await action('inventory', 'inventory-claim-use');
    await page.locator('#inventory-use-purpose').selectOption('其他');
    await page.locator('#inventory-use-result').fill('等待登记的外部使用结果');
    await close();
    await action('inventory', 'inventory-claim-use');
    assert.equal(await page.locator('#inventory-use-purpose').inputValue(), '其他');
    assert.equal(await page.locator('#inventory-use-result').inputValue(), '等待登记的外部使用结果');
    await close();
  });

  await t.test('隐藏邮箱搜索、重置有效天数和邮件分配保留普通输入', async () => {
    const connected = page.waitForResponse(response => response.url().endsWith('/apple-relay/status'));
    await go('mailboxes/relay');
    await connected;
    await page.evaluate(() => window.IDDesignAPI.modules.appleRelay.openAliasImport());
    await page.locator('#relay-parent-search').fill('qa-parent');
    await page.locator('#relay-content').fill('draft@privaterelay.appleid.com');
    await close();
    await page.evaluate(() => window.IDDesignAPI.modules.appleRelay.openAliasImport());
    assert.equal(await page.locator('#relay-parent-search').inputValue(), 'qa-parent');
    assert.equal(await page.locator('#relay-content').inputValue(), 'draft@privaterelay.appleid.com');
    await close();
    await action('apple-relay', 'relay-live-code-reset', { kind: 'parent', id: 'qa-parent' });
    await page.locator('#relay-code-days').selectOption('180');
    await close();
    await action('apple-relay', 'relay-live-code-reset', { kind: 'parent', id: 'qa-parent' });
    assert.equal(await page.locator('#relay-code-days').inputValue(), '180');
    await close();
    await action('apple-relay', 'relay-tab', { tab: 'mails' });
    await page.getByText('隔离测试邮件', { exact: true }).waitFor();
    await action('apple-relay', 'relay-mail-reassign', { id: 'qa-mail' });
    await page.locator('#relay-assign-alias').selectOption('qa-relay-b');
    await close();
    await action('apple-relay', 'relay-mail-reassign', { id: 'qa-mail' });
    assert.equal(await page.locator('#relay-assign-alias').inputValue(), 'qa-relay-b');
    await close();
  });

  await t.test('余额草稿保留最初版本，不用后续余额响应替换', async () => {
    await go('accounts/apple-balances');
    await action('apple-balance', 'apple-adjust', { id: 'qa-apple' });
    const version = await page.locator('[name="apple-version"]').inputValue();
    await page.locator('#apple-amount').fill('5');
    await page.locator('#apple-reason').fill('尚未提交的余额说明');
    await close();
    await page.evaluate(() => window.IDDesignAPI.modules.appleBalance.applyCommittedBalance({ version: 2,
      data: { wallets: [{ id: 'qa-apple', balance: '10.0000', currency: 'USD', version: 2 }],
        allocations: [], refunds: [], movements: [] } }));
    await action('apple-balance', 'apple-adjust', { id: 'qa-apple' });
    assert.equal(await page.locator('[name="apple-version"]').inputValue(), version);
    assert.equal(await page.locator('#apple-amount').inputValue(), '5');
    assert.equal(await page.locator('#apple-reason').inputValue(), '尚未提交的余额说明');
    await close();
    const replaceRefund = version => page.evaluate(version => {
      window.IDDesignAPI.modules.appleBalance.applyCommittedBalance({ version, data: {
        wallets: [{ id: 'qa-apple', balance: '10.0000', currency: 'USD', version }],
        allocations: [{ orderId: 'qa-order', appleIdId: 'qa-apple', amount: '10.0000', returned: '0.0000', version }],
        refunds: [{ id: 'qa-refund', orderId: 'qa-order', appleIdId: 'qa-apple', orderNo: 'QA-ORDER',
          amount: '5.0000', status: 'pending', corrections: [], version }], movements: []
      } });
    }, version);
    await replaceRefund(3);
    await action('apple-balance', 'apple-pending-edit', { id: 'qa-refund' });
    await page.locator('#apple-pending-amount').fill('4');
    await page.locator('#apple-pending-reason').fill('保留回款更正原因');
    await close();
    await replaceRefund(4);
    await action('apple-balance', 'apple-pending-edit', { id: 'qa-refund' });
    for (const field of ['apple-pending-version', 'apple-pending-ledger-version', 'apple-pending-wallet-version'])
      assert.equal(await page.locator(`[name="${field}"]`).inputValue(), '3');
    assert.equal(await page.locator('#apple-pending-amount').inputValue(), '4');
    assert.equal(await page.locator('#apple-pending-reason').inputValue(), '保留回款更正原因');
    await close();
  });

  await t.test('库存保存迟到保留后续输入，并沿用自己的已提交版本继续保存', async () => {
    let acknowledged;
    const saved = new Promise(resolve => { acknowledged = resolve; });
    const released = new Promise(resolve => { releaseSave = resolve; });
    await page.route('**/api/local/inventory', async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      acknowledged();
      await released;
      await route.fulfill({ response });
    });
    await go('mailboxes/google');
    await action('inventory', 'inventory-edit', { id: 'qa-google' });
    await page.locator('#inventory-notes').fill('本次提交说明');
    await page.locator('[form="inventory-asset-form"][type="submit"]').click();
    await page.locator('[data-action="confirm-accept"]').click();
    await saved;
    await page.locator('#inventory-notes').fill('保存等待时继续填写的说明');
    releaseSave();
    await page.getByText('本次提交已保存，后续填写的内容已保留', { exact: true }).waitFor();
    assert(await page.locator('#inventory-asset-form').isVisible());
    assert.equal(await page.locator('#inventory-notes').inputValue(), '保存等待时继续填写的说明');
    await close();
    await action('inventory', 'inventory-edit', { id: 'qa-google' });
    assert.equal(await page.locator('#inventory-notes').inputValue(), '保存等待时继续填写的说明');
    const stored = await (await page.request.get(host.url + 'api/local/inventory')).json();
    const firstSaved = stored.data.mailboxes.find(row => row.id === 'qa-google');
    assert.equal(firstSaved.notes, '本次提交说明');
    assert.equal(await page.locator('[name="inventory-version"]').inputValue(), String(firstSaved.version));
    await page.locator('[form="inventory-asset-form"][type="submit"]').click();
    await page.locator('[data-action="confirm-accept"]').click();
    await page.locator('#inventory-asset-form').waitFor({ state: 'hidden' });
    const final = await (await page.request.get(host.url + 'api/local/inventory')).json();
    const finalAsset = final.data.mailboxes.find(row => row.id === 'qa-google');
    assert.equal(finalAsset.notes, '保存等待时继续填写的说明');
    assert.equal(finalAsset.version, firstSaved.version + 1);
    assert.equal(await page.evaluate(() => window.IDDesignAPI.state.drafts.has('inventory-edit:qa-google')), false);
  });
  assert.deepEqual(errors, []);
});
