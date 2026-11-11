import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { createLocalBusinessStore } from '../server/local-business.mjs';

const source = await readFile(
  new URL('../frontend/commerce-prototype.js', import.meta.url),
  'utf8'
);
const appleSource = await readFile(
  new URL('../frontend/apple-balance-prototype.js', import.meta.url),
  'utf8'
);
const turn = () => new Promise((resolve) => setImmediate(resolve));
const moneyUnits = (amount) => {
  const value = String(amount);
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return (
    (BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'))) * (value.startsWith('-') ? -1n : 1n)
  );
};
const moneyFormat = (units) => {
  const magnitude = units < 0n ? -units : units;
  return `${units < 0n ? '-' : ''}${magnitude / 10000n}.${String(magnitude % 10000n).padStart(4, '0')}`;
};
const bankCard = { id: 'recharge:1', last4: '2345', active: true, status: '正常', usageCount: 0 };

function browser(store, appleAsset = null) {
  let confirm;
  const notices = [];
  const errors = new Map();
  const modules = [];
  const state = { route: 'customers/list', demoOrders: [], drafts: new Map() };
  const amountReferences = {
    '#commerce-paid-price-reference': { innerHTML: '' },
    '#commerce-sale-price-reference': { innerHTML: '' }
  };
  const bankOrderEntry = {
    isConnected: true,
    dataset: { commerceDraft: 'local-bank-entry' },
    elements: {
      'commerce-id': { value: '' },
      'commerce-plan': { value: 'Plus' },
      'commerce-businessType': { value: '续费' },
      'commerce-paidManual': { value: '' },
      'commerce-paidConfirmed': { checked: false },
      'commerce-paidCurrency': { value: 'PHP' },
      'commerce-paidAmount': { value: '' },
      'commerce-saleManual': { value: '' },
      'commerce-saleCurrency': { value: 'CNY' },
      'commerce-receiptConfirmed': { checked: false },
      'commerce-payment': { value: '银行卡' },
      'commerce-product': { value: 'GPT' },
      'commerce-cardId': { tagName: 'SELECT', value: bankCard.id, closest: () => null },
      'commerce-paymentId': { value: bankCard.last4 },
      'commerce-saleAmount': { value: '150' }
    },
    querySelector: (selector) => amountReferences[selector] || null
  };
  const api = {
    state,
    modules: {
      operations: { loadSettings: async () => true },
      ...(appleAsset && { inventory: { getAppleIds: () => [appleAsset] } })
    },
    money: {
      units: moneyUnits,
      formatUnits: moneyFormat,
      compare: (a, b) =>
        moneyUnits(a) > moneyUnits(b) ? 1 : moneyUnits(a) < moneyUnits(b) ? -1 : 0,
      add: (a, b) => moneyFormat(moneyUnits(a) + moneyUnits(b)),
      subtract: (a, b) => moneyFormat(moneyUnits(a) - moneyUnits(b))
    },
    canVisit: () => true,
    esc: String,
    addCalendarMonth: () => '2026-12-04T10:30',
    readForm: (form) => form.raw,
    setError: (field, message) => message ? errors.set(field, message) : errors.delete(field),
    options: (items) => JSON.stringify(items),
    render() {},
    button() {},
    titleInfo() {},
    table() {},
    openDrawer() {},
    newId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
    nowText: () => '2026-11-05 10:30',
    go: (route) => (state.route = route),
    notify: (message) => notices.push(message),
    confirmAction: (_title, _description, callback) => (confirm = callback)
  };
  const localData = {
    orderCards: async () => ({ items: [bankCard] }),
    load: async (domain) => store.load(domain),
    save: async (domain, version, data, { action }) =>
      store.saveBatch([{ domain, version, data: JSON.parse(JSON.stringify(data)), action }])[0],
    saveBatch: async (entries) => {
      try {
        return store.saveBatch(JSON.parse(JSON.stringify(entries)));
      } catch (error) {
        notices.push(error.message);
        throw error;
      }
    }
  };
  const context = {
    window: { IDDesignAPI: api, IDDesignModules: modules, IDLocalData: localData },
    document: {
      querySelector: (selector) => selector === '#commerce-order-form' && state.route === 'workspace/order/gpt'
        ? bankOrderEntry : null,
      querySelectorAll: () => [],
      getElementById: () => null
    },
    structuredClone,
    crypto
  };
  if (appleAsset) runInNewContext(appleSource, context);
  runInNewContext(source, context);
  const commerce = modules.find((module) => module.id === 'commerce');
  return {
    state,
    api,
    notices,
    ...api.modules.commerce,
    load: () => {
      commerce.afterRender();
      return turn();
    },
    async openBankOrderEntry() {
      state.route = 'workspace/order/gpt';
      commerce.afterRender();
      await turn();
      assert(JSON.parse(bankOrderEntry.elements['commerce-cardId'].innerHTML).some(([id]) => id === bankCard.id));
    },
    submit(id, fields) {
      commerce.onSubmit({
        id,
        raw: Object.fromEntries(
          Object.entries(fields).map(([key, val]) => [`commerce-${key}`, val])
        ),
        dataset: { commerceDraft: 'local-test-draft' },
        elements: { namedItem: () => null }
      });
    },
    submitCustomer(name, phone) {
      this.submit('commerce-contact-form', { kind: 'customer', name, phone });
    },
    confirm() {
      assert.equal(typeof confirm, 'function', `等待有效表单进入确认步骤：${[...errors.values()].join('、')}`);
      const callback = confirm;
      confirm = undefined;
      callback();
    }
  };
}

const orderFields = (customerId) => ({
  product: 'GPT',
  plan: 'Plus',
  businessType: '续费',
  email: 'customer@example.test',
  customerId,
  payment: '银行卡',
  cardId: bankCard.id,
  paymentId: bankCard.last4,
  paidAmount: '20',
  paidCurrency: 'USD',
  saleAmount: '150',
  saleCurrency: 'CNY',
  emailCostCurrency: 'CNY',
  actualCostCurrency: 'CNY',
  costBasis: 'standard',
  start: '2026-11-04T10:30',
  expiry: '2026-12-03T10:30',
  paidConfirmed: 'on',
  receiptConfirmed: 'on'
});

test('客户和银行卡独立订单在本机保存、重开后可读，旧标签页不能覆盖新记录', async () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const first = browser(store);
    const stale = browser(store);
    await Promise.all([first.load(), stale.load()]);
    assert.equal(first.getCustomers().length, 0);
    assert.equal(first.listOrders().length, 0);
    first.submitCustomer('本地测试客户', '111');
    first.confirm();
    assert.equal(first.getCustomers().length, 0, '持久化响应之前不显示成功记录');
    await turn();
    assert.equal(first.getCustomers()[0].createdBy, '本机操作员');

    stale.submitCustomer('并发标签页客户', '222');
    stale.confirm();
    await turn();
    assert.match(stale.notices.at(-1), /本次未保存/);
    assert.equal(stale.getCustomers()[0].name, '本地测试客户');
    assert.equal(store.audit().length, 1);

    await first.openBankOrderEntry();
    first.submit('commerce-order-form', orderFields(first.getCustomers()[0].id));
    await turn();
    first.confirm();
    await turn();
    const reopened = browser(store);
    await reopened.load();
    const [order] = reopened.listOrders();
    assert.equal(order.email, 'customer@example.test');
    assert.equal(order.businessType, '续费');
    assert.equal(order.claudeRenewalId, '');
    assert.equal(order.rateAt, '汇率来源尚未接入');
    assert.equal(order.createdBy, '本机操作员');
    assert.equal(order.cardId, bankCard.id);
    assert.equal(order.paymentId, bankCard.last4);
    assert.deepEqual(
      store.audit().map(({ action }) => action),
      ['新增独立订单', '新增资料']
    );

    reopened.submit('commerce-refund-form', {
      id: order.id,
      version: order.version,
      refundAmount: '50',
      refundReason: '已退给客户',
      refundAt: '2026-11-05T10:30'
    });
    reopened.confirm();
    await turn();
    const afterCustomerRefund = reopened.getOrder(order.id);
    const bankFields = {
      id: order.id,
      version: afterCustomerRefund.version,
      bankReturnAmount: '8',
      bankReturnReason: '银行卡已到账',
      bankReturnAt: '2026-11-05T11:30'
    };
    reopened.submit('commerce-bank-return-form', bankFields);
    reopened.confirm();
    await turn();
    reopened.submit('commerce-bank-return-form', bankFields);
    assert.match(reopened.notices.at(-1), /订单版本已变化/);
    const persistedOrder = store.load('commerce').data.orders[0];
    assert.deepEqual(
      persistedOrder.refunds.map(({ amount, currency }) => [amount, currency]),
      [['50.0000', 'CNY']]
    );
    assert.deepEqual(
      persistedOrder.bankReturns.map(({ amount, currency }) => [amount, currency]),
      [['8.0000', 'USD']]
    );
    assert.deepEqual(
      store
        .audit()
        .slice(0, 2)
        .map(({ action }) => action),
      ['银行卡回款登记', '退款登记']
    );
  } finally {
    store.close();
  }
});

test('成品订单和库存占用一起提交，库存版本冲突时两边都不会写入', async () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const tab = browser(store);
    await tab.load();
    tab.submitCustomer('成品客户', '333');
    tab.confirm();
    await turn();
    const account = {
      id: 'stock-local-a',
      type: 'gpt',
      email: 'stock@example.test',
      inventoryState: 'available',
      used: false,
      health: 'normal',
      status: '正常',
      usageLinks: [],
      version: 1
    };
    const inventory = {
      mailboxes: [],
      accounts: [account],
      batches: [],
      returnRecords: [],
      importRecords: [],
      registrationRecords: [],
      tableSettings: [],
      undo: []
    };
    let version = 1;
    let applied = 0;
    store.saveBatch([{ domain: 'inventory', version: 0, data: inventory }]);
    tab.api.modules.inventory = {
      listAvailableAccounts: () => [account],
      canCommitAccountSale: () => ({ ok: true }),
      prepareAccountSale: (accountId, { orderId, expectedVersion }) => {
        assert.equal(accountId, account.id);
        assert.equal(expectedVersion, account.version);
        return {
          ok: true,
          version,
          action: 'inventory_order_sale',
          data: {
            ...inventory,
            accounts: [
              {
                ...account,
                inventoryState: 'used',
                used: true,
                version: account.version + 1,
                usageLinks: [
                  {
                    kind: 'order-sale',
                    orderId,
                    label: `成品交付订单 ${orderId}`,
                    time: '2026-11-05 10:30'
                  }
                ]
              }
            ]
          }
        };
      },
      refreshLocalInventory: async () => (version = store.load('inventory').version),
      applyCommittedInventory: (result) => (applied = result.version)
    };
    const order = {
      ...orderFields(tab.getCustomers()[0].id),
      businessType: '成品交付',
      email: account.email
    };
    store.saveBatch([{ domain: 'inventory', version, data: inventory }]);
    await tab.openBankOrderEntry();
    tab.submit('commerce-order-form', order);
    await turn();
    tab.confirm();
    await turn();
    assert.match(tab.notices.at(-1), /本次未保存/);
    assert.equal(tab.listOrders().length, 0);
    assert.equal(applied, 0);
    assert.equal(store.load('commerce').version, 1);
    assert.deepEqual(store.load('inventory').data.accounts[0].usageLinks, []);

    tab.submit('commerce-order-form', order);
    await turn();
    tab.confirm();
    await turn();
    assert.equal(applied, 3);
    const [saved] = store.load('commerce').data.orders;
    assert.equal(saved.accountId, account.id);
    assert.equal(store.load('inventory').data.accounts[0].usageLinks[0].orderId, saved.id);
    assert.deepEqual(
      store
        .audit()
        .slice(0, 2)
        .map(({ action }) => action),
      ['inventory_order_sale', '新增独立订单']
    );
  } finally {
    store.close();
  }
});

test('苹果内购和余额一起提交，客户退款独立登记待回款，到账和重试保持原 ID 余额正确', async () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const asset = {
      id: 'apple-a',
      type: 'apple',
      appStoreRegion: 'US',
      email: 'apple@example.test',
      status: '正常',
      health: 'normal'
    };
    store.saveBatch([
      {
        domain: 'inventory',
        version: 0,
        data: {
          mailboxes: [asset],
          accounts: [],
          batches: [],
          returnRecords: [],
          importRecords: [],
          registrationRecords: [],
          tableSettings: [],
          undo: []
        }
      },
      { domain: 'settings', version: 0, data: { mailboxTypes: [], costSettings: {}, applePaidPrices: { Gemini: { 'Google AI Pro': { US: '20' } } } } }
    ]);
    const first = browser(store, asset);
    const ledger = first.api.modules.appleBalance;
    await first.load();
    await ledger.ensureReady();
    first.submitCustomer('苹果内购测试客户', '111');
    first.confirm();
    await turn();
    assert.equal((await ledger.adjust(asset.id, '250', { reason: '核实期初余额' })).ok, true);

    const stale = browser(store, asset);
    await stale.load();
    await stale.api.modules.appleBalance.ensureReady();
    const fields = {
      ...orderFields(first.getCustomers()[0].id),
      product: 'Gemini',
      plan: 'Google AI Pro',
      businessType: '首次开通',
      payment: '苹果内购',
      appleStoreRegion: 'US',
      billingChannel: 'app_store',
      billingCountry: '美国',
      billingReceipt: 'fixture-transaction',
      billingCycle: 'month',
      autoRenew: 'unknown',
      loginMethod: 'google',
      appleGoogleVerified: 'on',
      appleIdId: asset.id
    };
    stale.state.route = 'workspace/order';
    stale.submit('commerce-order-form', fields);
    await turn();
    assert.equal((await ledger.adjust(asset.id, '1', { reason: '核实新增余额' })).ok, true);
    stale.confirm();
    await turn();
    assert.match(stale.notices.at(-1), /本次未保存/);
    assert.equal(store.load('commerce').data.orders.length, 0);
    assert.equal(ledger.get(asset.id).balance, '251.0000');

    first.state.route = 'workspace/order';
    first.submit('commerce-order-form', fields);
    await turn();
    first.confirm();
    assert.equal(first.listOrders().length, 0);
    await turn();
    const [order] = first.listOrders();
    assert.equal(order.paymentId, asset.email);
    assert.equal(order.entitlementStatus, 'active');
    assert.equal(ledger.get(asset.id).balance, '231.0000');
    assert.equal(ledger.getOrderLedger(order.id).amount, '20.0000');

    first.submit('commerce-refund-form', {
      id: order.id,
      version: order.version,
      refundAmount: '100',
      refundAppleAmount: '7',
      refundReason: '客户实际退款',
      refundAt: '2026-11-05T10:30'
    });
    await turn();
    first.confirm();
    await turn();
    const [refund] = first.getOrder(order.id).refunds;
    const [pending] = ledger.listRefunds(order.id);
    assert.equal(refund.currency, 'CNY');
    assert.equal(refund.amount, '100.0000');
    assert.equal(pending.id, refund.id);
    assert.equal(pending.amount, '7.0000');
    assert.equal(pending.status, 'pending');
    assert.equal(ledger.get(asset.id).balance, '231.0000');

    const receipt = {
      version: pending.version,
      ledgerVersion: ledger.getOrderLedger(order.id).version,
      walletVersion: ledger.get(asset.id).version,
      confirmed: true,
      reason: '核实实际到账'
    };
    assert.equal((await ledger.receiveRefund(refund.id, receipt)).ok, true);
    assert.equal((await ledger.receiveRefund(refund.id, receipt)).ok, false);
    const reopened = browser(store, asset);
    await reopened.load();
    const reopenedLedger = reopened.api.modules.appleBalance;
    await reopenedLedger.ensureReady();
    assert.equal(reopened.getOrder(order.id).refunds[0].amount, '100.0000');
    assert.equal(reopenedLedger.get(asset.id).balance, '238.0000');
    assert.equal(reopenedLedger.listRefunds(order.id)[0].status, 'received');

    reopened.submit('commerce-order-form', {
      ...fields,
      id: order.id,
      version: reopened.getOrder(order.id).version,
      entitlementStatus: reopened.getOrder(order.id).entitlementStatus,
      paidAmount: '22',
      correctionReason: '已核对实扣金额'
    });
    await turn();
    reopened.confirm();
    await turn();
    assert.equal(reopenedLedger.get(asset.id).balance, '236.0000', reopened.notices.join('、'));
    const corrected = reopened.getOrder(order.id);
    reopened.submit('commerce-reversal-form', {
      id: order.id,
      version: corrected.version,
      reversalMode: 'undo',
      reversalReason: '已核实多扣金额退回',
      balanceReversalConfirmed: 'on'
    });
    await turn();
    reopened.confirm();
    await turn();
    assert.equal(reopenedLedger.get(asset.id).balance, '238.0000');
    assert.equal(reopened.getOrder(order.id).paidAmount, '20');
    assert.equal(reopenedLedger.listRefunds(order.id)[0].status, 'received');
    assert.equal(reopenedLedger.entries(asset.id).at(0).kind, 'order-reversal');
  } finally {
    store.close();
  }
});
