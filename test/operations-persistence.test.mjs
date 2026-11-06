import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(
  new URL('../frontend/operations-prototype.js', import.meta.url),
  'utf8'
);
const initialCosts = {
  version: 1,
  currency: 'CNY',
  claudeBankFeeMyr: '100',
  claudeAccountCostMyr: '50',
  gmailCostCny: '15',
  appleCostCny: '25',
  microsoftCostCny: '5',
  appleDiscount: '0.8',
  cardIssueUsd: '0.5',
  cardPercent: '0.008',
  cardPerPaymentUsd: '0.3'
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  let stored = { version: 0, data: null };
  const audits = [];
  return {
    api: {
      async load(domain) {
        assert.equal(domain, 'settings');
        return structuredClone(stored);
      },
      async save(domain, version, data, { action, summary }) {
        assert.equal(domain, 'settings');
        if (version !== stored.version) {
          throw Object.assign(new Error('Version mismatch'), { status: 409 });
        }
        stored = { version: version + 1, data: structuredClone(data) };
        audits.unshift({
          at: '2026-11-05T08:10:00Z',
          domain,
          action,
          summary,
          version: stored.version
        });
        return structuredClone(stored);
      },
      async audit() {
        return structuredClone(audits);
      }
    },
    get stored() {
      return stored;
    }
  };
}

function browser(localData, route = 'settings/mail-types') {
  let seq = 0;
  let costs = { ...initialCosts };
  let confirmation;
  const notices = [];
  const state = { route, drafts: new Map(), query: '', page: 1 };
  const modules = [];
  const API = {
    state,
    modules: {
      commerce: {
        getCostSettings: () => ({ ...costs }),
        replaceCostSettings: (snapshot) => {
          costs = { ...snapshot };
          return true;
        }
      }
    },
    collections: { accounts: [], mailboxes: [] },
    money: {
      units: (value) => Number(value),
      compare: (a, b) => Number(a) - Number(b)
    },
    esc: String,
    button: String,
    tag: String,
    field: () => '',
    input: () => '',
    select: () => '',
    titleInfo: () => '',
    header: String,
    empty: String,
    table: () => '',
    pagination: () => '',
    pageRows: (rows) => rows,
    notify: (message) => notices.push(message),
    setError: () => {},
    newId: (prefix) => prefix + '-' + ++seq,
    readForm: (form) => form.values,
    readDraft: (form) => ({ ...form.values }),
    confirmAction: (_title, _message, cb) => {
      confirmation = cb;
    },
    closeDrawer: () => {},
    render: () => {}
  };
  runInNewContext(source, {
    window: { IDDesignAPI: API, IDDesignModules: modules, IDLocalData: localData },
    document: { querySelector: () => null, querySelectorAll: () => [] }
  });
  return {
    state,
    module: modules[0],
    operations: API.modules.operations,
    notices,
    get costs() {
      return costs;
    },
    accept: async () => {
      confirmation();
      await flush();
    }
  };
}

const form = (id, values) => ({
  id, values, isConnected: true,
  dataset: id === 'ops-mail-type-form'
    ? { opsDraft: `operations:mail-type:${values['ops-type-id'] || 'new'}` }
    : {}
});

test('mailbox classification and cost rules survive reload, with local audit records', async () => {
  const store = fixture();
  const first = browser(store.api);
  assert.equal(await first.operations.loadSettings(), true);
  first.module.onSubmit(
    form('ops-mail-type-form', {
      'ops-type-id': 'google',
      'ops-type-version': '0',
      'ops-type-label': '本机谷歌邮箱',
      'ops-type-enabled': '启用'
    })
  );
  await first.accept();
  assert.equal(store.stored.version, 1);
  assert.equal(
    first.operations.getMailboxTypes().find((item) => item.id === 'google').label,
    '本机谷歌邮箱'
  );

  first.state.route = 'settings/costs';
  const values = Object.fromEntries(
    Object.entries({ ...initialCosts, claudeBankFeeMyr: '125' }).map(([key, value]) => [
      'ops-cost-' + key,
      String(value)
    ])
  );
  first.module.onSubmit(form('ops-cost-form', values));
  await first.accept();
  assert.equal(store.stored.version, 2);
  assert.equal(first.costs.claudeBankFeeMyr, '125');

  const reopened = browser(store.api, 'settings/audit');
  assert.equal(await reopened.operations.loadSettings(), true);
  assert.equal(reopened.costs.version, 2);
  assert.equal(reopened.costs.claudeBankFeeMyr, '125');
  reopened.module.afterRender();
  await flush();
  assert.equal(reopened.operations.getAudit().length, 2);
  assert.equal(reopened.operations.getAudit()[0].action, '保存费用规则');
  assert.equal(reopened.operations.getAudit()[0].actor, '本机操作');
  assert.equal(reopened.operations.getAudit()[0].time, '2026-11-05 16:10:00');
});

test('a stale settings page cannot overwrite a newer version', async () => {
  const store = fixture();
  const first = browser(store.api);
  const stale = browser(store.api);
  await Promise.all([first.operations.loadSettings(), stale.operations.loadSettings()]);
  first.module.onSubmit(
    form('ops-mail-type-form', {
      'ops-type-id': 'google',
      'ops-type-version': '0',
      'ops-type-label': '先保存',
      'ops-type-enabled': '启用'
    })
  );
  await first.accept();
  stale.module.onSubmit(
    form('ops-mail-type-form', {
      'ops-type-id': 'google',
      'ops-type-version': '0',
      'ops-type-label': '不应覆盖',
      'ops-type-enabled': '启用'
    })
  );
  await stale.accept();
  assert.equal(store.stored.version, 1);
  assert.equal(
    stale.operations.getMailboxTypes().find((item) => item.id === 'google').label,
    '先保存'
  );
  assert.match(stale.notices.at(-1), /其他页面已更新配置/);
});
