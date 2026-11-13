import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  automaticProvider,
  createOrderSnapshot,
  snapshotAction
} from '../modules/finance/accounting.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { startPreview } from '../server/preview.mjs';

const privateNote = 'local_fixture_secret_not_for_audit';
const inventory = {
  mailboxes: [{ id: 'mail-1', password: privateNote }],
  accounts: [],
  batches: [],
  returnRecords: [],
  importRecords: [],
  registrationRecords: [],
  tableSettings: [],
  undo: []
};
const commerce = {
  customers: [],
  tenants: [],
  orders: [],
  operating: [],
  rentBatches: [],
  logs: []
};

test('local database persists across reopening, encrypts records and rolls back an entire conflicting batch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'id-business-local-'));
  const path = join(directory, 'business.sqlite');
  let store = createLocalBusinessStore(path);
  try {
    assert.deepEqual(store.load('inventory'), { version: 0, data: null });
    store.saveBatch([
      {
        domain: 'inventory',
        version: 0,
        data: inventory,
        action: privateNote,
        summary: privateNote
      }
    ]);
    assert.throws(
      () =>
        store.saveBatch([
          { domain: 'commerce', version: 0, data: commerce },
          { domain: 'inventory', version: 0, data: { ...inventory, mailboxes: [] } }
        ]),
      (error) => error.status === 409
    );
    assert.deepEqual(store.load('commerce'), { version: 0, data: null });
    assert.equal(store.audit().length, 1);
    assert.ok(!JSON.stringify(store.audit()).includes(privateNote));
    store.close();
    store = undefined;
    assert.ok(!(await readFile(path)).includes(Buffer.from(privateNote)));
    store = createLocalBusinessStore(path);
    assert.deepEqual(store.load('inventory'), { version: 1, data: inventory });
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('only local-data mode mounts the persistence client, and browser writes must come from its origin', async () => {
  const { server, url } = await startPreview(0, { databasePath: ':memory:' });
  const api = url + 'api/local/inventory';
  try {
    const home = await fetch(url);
    const html = await home.text();
    assert.match(html, /src="\/local-data\.js"/);
    assert.match(html, /<title>AI订阅管理系统 · 独立本机测试<\/title>/);
    assert.equal((await fetch(url + 'local-data.js')).status, 200);
    const publicPage = await fetch(url + 'mailbox-query');
    assert.equal(publicPage.status, 200);
    assert.match(publicPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(publicPage.headers.get('content-security-policy'), /img-src 'self'/);
    const mailboxHtml = await publicPage.text();
    assert.match(mailboxHtml, /apple-relay-public\.js/);
    assert.match(mailboxHtml, /src="\/brand\/ai-subscription-mark\.png"/);
    const bitLogin = await fetch(url + 'integrations/bitbrowser/local-login');
    assert.equal(bitLogin.status, 200);
    assert.match(bitLogin.headers.get('content-security-policy'), /img-src 'self'/);
    assert.match(await bitLogin.text(), /href="\/brand\/favicon-32\.png"/);
    const [favicon, brandFavicon] = await Promise.all(
      ['favicon.ico', 'brand/favicon-32.png'].map((path) => fetch(url + path))
    );
    assert.equal(favicon.status, 200);
    assert.equal(brandFavicon.status, 200);
    assert.equal(favicon.headers.get('content-type'), 'image/png');
    assert.deepEqual(await favicon.arrayBuffer(), await brandFavicon.arrayBuffer());
    assert.equal(
      (
        await fetch(url + 'api/local/apple-relay/public-query', {
          method: 'POST',
          headers: { Origin: new URL(url).origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ queryCode: 'TEST-CODE' })
        })
      ).status,
      503
    );
    assert.equal((await fetch(api, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const save = (origin, version) =>
      fetch(api, {
        method: 'PUT',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, data: inventory })
      });
    assert.equal((await save('https://untrusted.test', 0)).status, 403);
    const [a, b] = await Promise.all([save(new URL(url).origin, 0), save(new URL(url).origin, 0)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal((await fetch(api).then((response) => response.json())).version, 1);
    const audit = await fetch(url + 'api/local/audit').then((response) => response.json());
    assert.equal(audit.length, 1);
    assert.equal(audit[0].domain, 'inventory');
    assert.ok(!JSON.stringify(audit).includes(privateNote));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Apple orders and balance movements commit together and retain the original inventory identity', () => {
  const store = createLocalBusinessStore(':memory:');
  const apple = { id: 'apple-id', type: 'apple', status: '正常', appStoreRegion: 'US', appleOpeningBalance: '250.0000' };
  const order = {
    id: 'order-1',
    product: 'Gemini', plan: 'Google AI Pro', businessType: '首次开通', customerId: 'fixture-customer',
    email: 'subscription@example.test', subscriptionSeries: 'google_ai', loginMethod: 'google',
    billingChannel: 'app_store', billingCycle: 'month', billingCountry: '美国', billingReceipt: 'fixture-transaction',
    entitlementStatus: 'pending', autoRenew: 'unknown', appleGoogleVerified: true,
    costBasis: 'standard', saleCurrency: 'CNY',
    payment: '苹果内购',
    paidConfirmed: true,
    paidCurrency: 'USD',
    paidAmount: '20.0000',
    appleIdId: apple.id,
    refunds: []
  };
  const orderWrite = {
    domain: 'commerce',
    version: 0,
    data: { ...commerce, customers: [{ id: order.customerId, name: '合成客户' }], orders: [order] }
  };
  const debit = {
    id: 'charge',
    kind: 'order-charge',
    orderId: order.id,
    appleIdId: apple.id,
    amount: '-20.0000',
    before: '250.0000',
    after: '230.0000',
    versionAfter: 3
  };
  const ledger = {
    wallets: [{ id: apple.id, currency: 'USD', balance: '230.0000', version: 3 }],
    allocations: [
      {
        appleIdId: apple.id,
        orderId: order.id,
        amount: '20.0000',
        returned: '0.0000'
      }
    ],
    movements: [debit],
    refunds: []
  };
  try {
    store.saveBatch([
      { domain: 'inventory', version: 0, data: { ...inventory, mailboxes: [apple] } }
    ]);
    store.saveBatch([{ domain: 'settings', version: 0, data: { costSettings: {}, mailboxTypes: [],
      applePaidPrices: { Gemini: { 'Google AI Pro': { US: '20' } } } } }]);
    ledger.movements.unshift(...store.load('appleBalance').data.movements);
    assert.throws(() => store.saveBatch([orderWrite]), /同时保存余额扣款/);
    assert.throws(
      () =>
        store.saveBatch([
          orderWrite,
          {
            domain: 'appleBalance',
            version: 1,
            data: { ...ledger, wallets: [{ ...ledger.wallets[0], balance: '250.0000' }] }
          }
        ]),
      /余额必须由流水核对/
    );
    assert.equal(store.load('commerce').version, 0);
    assert.equal(store.load('appleBalance').version, 1);
    store.saveBatch([orderWrite, { domain: 'appleBalance', version: 1, data: ledger }]);
    assert.equal(store.load('appleBalance').data.wallets[0].balance, '230.0000');
    assert.throws(
      () =>
        store.saveBatch([
          { domain: 'inventory', version: 1, data: { ...inventory, mailboxes: [] } }
        ]),
      /付款占用或绑定|已有余额流水/
    );
    const invalidHistory = structuredClone(ledger);
    invalidHistory.movements[0].reason = '被覆盖';
    assert.throws(
      () => store.saveBatch([{ domain: 'appleBalance', version: 2, data: invalidHistory }]),
      /原有苹果 ID 余额流水不能改写/
    );
  } finally {
    store.close();
  }
});

test('configured local mode gates business routes and saves the actual session actor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'id-business-session-'));
  const authPath = join(directory, 'auth.json');
  const adminPassword = 'isolated-fixture-only-password';
  let server;
  let requestsToRecharge = 0;
  let financeRequests = 0;
  const seconds = Math.floor(Date.now() / 1000);
  const rechargeUpstream = createServer((request, response) => {
    if (request.url !== '/api/public/runtime' || !request.headers['x-id-recharge-assertion'])
      return response.writeHead(404).end();
    requestsToRecharge++;
    response.writeHead(200).end(
      JSON.stringify({
        success: true,
        runtime: { active_foreground_jobs: 0, max_foreground_jobs: 1 }
      })
    );
  });
  try {
    rechargeUpstream.listen(0, '127.0.0.1');
    await once(rechargeUpstream, 'listening');
    const preview = await startPreview(0, {
      databasePath: ':memory:',
      authPath,
      rechargeConfig: {
        upstreamUrl: `http://127.0.0.1:${rechargeUpstream.address().port}`,
        secret: 'fixture-only-recharge-shared-secret'
      },
      financeProvider: automaticProvider.id,
      financeFetch: async () => {
        financeRequests++;
        return Response.json({
          date: new Date(seconds * 1000).toISOString().slice(0, 10),
          cny: { cny: 1, myr: 0.625, usd: 0.125, php: 8, clp: 125, idr: 2500, egp: 6.25 }
        });
      }
    });
    server = preview.server;
    const { url } = preview;
    assert.equal((await fetch(url + 'api/local/inventory')).status, 200);
    assert.equal((await fetch(url + 'integrations/codexdaichong/status')).status, 401);
    await initializeLocalAdmin(authPath, {
      email: 'root@example.test',
      name: '本机测试管理员',
      password: adminPassword
    });
    const origin = new URL(url).origin;
    const request = (path, { cookie, data, method = 'GET' } = {}) =>
      fetch(url + path, {
        method,
        headers: {
          ...(cookie && { Cookie: cookie }),
          ...(data && { Origin: origin, 'Content-Type': 'application/json' })
        },
        body: data && JSON.stringify(data)
      });
    const login = async (email, password) => {
      const response = await request('api/local/auth/login', {
        method: 'POST',
        data: { email, password }
      });
      assert.equal(response.status, 200);
      return {
        cookie: response.headers.get('set-cookie').split(';', 1)[0],
        actor: (await response.json()).actor
      };
    };
    const guestHtml = await (await request('')).text();
    assert.match(guestHtml, /id-local-auth.*required/);
    assert.doesNotMatch(guestHtml, /src="\.\/commerce-prototype\.js/);
    assert.doesNotMatch(guestHtml, /src="\/assets\/finance\/browser\.mjs/);
    assert.equal((await request('api/local/inventory')).status, 401);
    assert.equal((await request('api/local/toolbox')).status, 401);
    assert.equal((await request('api/local/apple-relay/status')).status, 401);
    assert.equal(
      (
        await request('api/local/apple-relay/public-query', {
          method: 'POST',
          data: { queryCode: 'TEST-CODE' }
        })
      ).status,
      503
    );
    const admin = await login('root@example.test', adminPassword);
    const monitorPath = 'api/local/tools/website-monitor';
    const probe = { method: 'POST', data: { url: 'http://127.0.0.1:1234/' } };
    assert.equal((await request(monitorPath, probe)).status, 401);
    const privateTarget = await request(monitorPath, { ...probe, cookie: admin.cookie });
    assert.equal(privateTarget.status, 400);
    assert.match((await privateTarget.json()).error, /公开网站/);
    const signedInHtml = await (await request('', { cookie: admin.cookie })).text();
    assert.match(signedInHtml, /id-local-actor/);
    assert.match(signedInHtml, /src="\/assets\/finance\/browser\.mjs/);
    assert.match(signedInHtml, /id-finance-auto-quote/);
    const recharge = await request('integrations/codexdaichong/status', { cookie: admin.cookie });
    assert.deepEqual(await recharge.json(), { ready: true, admin: true });
    assert.equal(requestsToRecharge, 1);

    const employeePassword = 'isolated-fixture-employee-password';
    const created = await request('api/local/auth/employees', {
      cookie: admin.cookie,
      method: 'POST',
      data: {
        email: 'employee@example.test',
        name: '测试普通员工',
        role: 'employee',
        password: employeePassword
      }
    });
    assert.equal(created.status, 201);
    const employee = await login('employee@example.test', employeePassword);
    assert.equal((await request('api/local/inventory', { cookie: employee.cookie })).status, 200);
    assert.equal((await request('api/local/commerce', { cookie: employee.cookie })).status, 200);
    const personal = await request('api/local/toolbox', {
      cookie: employee.cookie,
      method: 'PUT',
      data: {
        version: 0,
        data: {
          shortcuts: [
            { id: 'private-shortcut', name: '本人工作网址', url: 'https://example.test/' }
          ],
          phrases: []
        }
      }
    });
    assert.equal(personal.status, 200);
    assert.equal((await personal.json()).data.shortcuts[0].name, '本人工作网址');
    const adminTools = await (await request('api/local/toolbox', { cookie: admin.cookie })).json();
    assert.deepEqual(adminTools.data.shortcuts, []);
    for (const path of [
      'api/local/audit',
      'api/local/auth/employees',
      'api/local/order-cards',
      'api/local/tenant-cards',
      'api/local/order-sync',
      'api/local/apple-relay/status',
      'integrations/bitbrowser/local-login',
      'api/local/finance/auto-snapshot',
      'integrations/codexdaichong/status'
    ]) {
      assert.equal((await request(path, { cookie: employee.cookie })).status, 403, path);
    }
    assert.equal(
      (
        await request('api/local/commerce', {
          cookie: employee.cookie,
          method: 'PUT',
          data: { version: 0, data: commerce }
        })
      ).status,
      403
    );

    const saved = await request('api/local/commerce', {
      cookie: admin.cookie,
      method: 'PUT',
      data: {
        version: 0,
        action: '新增资料',
        data: {
          ...commerce,
          orders: [
            {
              id: 'fx-integrated',
              orderNo: 'fx-integrated',
              version: 1,
              product: 'GPT',
              plan: 'Plus',
              businessType: '续费',
              email: '',
              payment: '银行卡',
              start: new Date((seconds - 120) * 1000).toISOString(),
              paidAmount: '100',
              paidCurrency: 'PHP',
              saleAmount: '25',
              saleCurrency: 'CNY',
              costBasis: 'standard',
              costSettings: { version: 1 },
              refunds: [],
              bankReturns: []
            }
          ],
          customers: [
            {
              id: 'fixture-1',
              version: 1,
              createdById: 'forged',
              createdBy: 'forged',
              updatedById: 'forged'
            }
          ]
        }
      }
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).data.customers[0].createdById, admin.actor.id);
    const freeze = () =>
      request('api/local/finance/auto-snapshot', {
        method: 'POST',
        cookie: admin.cookie,
        data: { orderId: 'fx-integrated', version: 1 }
      });
    const frozen = await freeze();
    assert.ok([200, 409].includes(frozen.status), await frozen.clone().text());
    const stored = await (await request('api/local/commerce', { cookie: admin.cookie })).json();
    assert.equal(stored.data.orders[0].fxSnapshot.kind, 'automatic');
    assert.equal((await freeze()).status, 409);
    assert.equal(financeRequests, 1);
    const audit = await (await request('api/local/audit', { cookie: admin.cookie })).json();
    assert.ok([admin.actor.name, '汇率采集任务'].includes(audit[0].actorName));
    assert.ok(audit.some((record) => record.action === 'auth_employee_create'));
    assert.ok(
      audit.some(
        (record) => record.action === 'toolbox_save' && record.actorId === employee.actor.id
      )
    );
    assert.ok(!JSON.stringify(audit).includes(adminPassword));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (rechargeUpstream.listening) await new Promise((resolve) => rechargeUpstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('shared business store mounts and enforces the finance snapshot write contract', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const start = new Date(Date.now() - 2 * 3600000).toISOString();
    const order = {
      id: 'order-fx',
      version: 1,
      product: 'GPT',
      payment: '银行卡',
      paidAmount: '100',
      paidCurrency: 'PHP',
      saleAmount: '25',
      saleCurrency: 'CNY',
      start,
      costBasis: 'standard',
      costSettings: { version: 1 },
      refunds: [],
      bankReturns: []
    };
    const before = { ...commerce, orders: [order] };
    const snapshot = createOrderSnapshot(
      {
        source: '测试汇率登记',
        at: new Date(Date.now() - 3 * 3600000).toISOString(),
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        rates: { MYR: '1.6', PHP: '0.125', USD: '7.2' }
      },
      order
    );
    const next = {
      ...before,
      logs: [{ id: 'event-fx', type: snapshotAction, entityId: order.id }],
      orders: [
        {
          ...order,
          fxSnapshot: snapshot,
          version: 2,
          updatedAt: start,
          updatedBy: '测试操作员',
          updatedById: 'test'
        }
      ]
    };
    store.saveBatch([{ domain: 'commerce', version: 0, data: before }]);
    assert.throws(
      () => store.saveBatch([{ domain: 'commerce', version: 1, data: next }]),
      /汇率登记操作/
    );
    const [saved] = store.saveBatch(
      [
        {
          domain: 'commerce',
          version: 1,
          data: next,
          action: snapshotAction
        }
      ],
      { actor: { id: 'actual-tester', name: '实际操作人' } }
    );
    assert.equal(saved.data.orders[0].updatedById, 'actual-tester');
    assert.equal(store.audit()[0].action, snapshotAction);
    assert.throws(
      () => store.saveBatch([{ domain: 'commerce', version: 2, data: before }]),
      /不可覆盖或删除/
    );
  } finally {
    store.close();
  }
});

test('客户标签设置兼容旧设置写入，停用后保留历史标签并拒绝新分配', () => {
  const store = createLocalBusinessStore(':memory:');
  const settings = { mailboxTypes: [], costSettings: {} };
  const saveOptions = (version, data) =>
    store.saveBatch([{ domain: 'settings', version, data, action: 'customer_tags_save' }]);
  const saveCustomers = (version, customers) =>
    store.saveBatch([{ domain: 'commerce', version, data: { ...commerce, customers } }]);
  try {
    assert.throws(
      () => saveOptions(0, { ...settings, customerTags: ['VIP', 'vip'] }),
      (error) => error.status === 400
    );
    saveOptions(0, { ...settings, customerTags: ['企业客户', '复购客户'] });
    const existing = { id: 'customer-1', name: '客户一', tags: ['企业客户', '复购客户'] };
    saveCustomers(0, [existing]);
    saveOptions(1, settings);
    assert.deepEqual(store.load('settings').data.customerTags, existing.tags);
    saveOptions(2, { ...settings, customerTags: ['复购客户'] });
    assert.throws(
      () => saveCustomers(1, [existing, { id: 'customer-2', tags: ['企业客户'] }]),
      (error) => error.status === 409 && error.message.includes('客户标签')
    );
    saveCustomers(1, [{ ...existing, name: '客户一改名' }]);
    assert.deepEqual(store.load('commerce').data.customers[0].tags, existing.tags);
    assert.ok(store.audit().some((entry) => entry.action === 'customer_tags_save'));
  } finally {
    store.close();
  }
});
