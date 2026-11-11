import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { pageAuditRows } from '../server/local-business.mjs';

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
          id: stored.version,
          at: '2026-11-05T08:10:00Z',
          domain,
          action,
          summary,
          version: stored.version
        });
        return structuredClone(stored);
      },
      async auditPage(params) {
        return pageAuditRows(audits, new URLSearchParams(params));
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
  const listeners = new Map();
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
    withActionFeedback: (_node, operation) => operation(),
    render: () => {}
  };
  runInNewContext(source, {
    window: { IDDesignAPI: API, IDDesignModules: modules, IDLocalData: localData, IDPagination: { defaultPageSize: 20 } },
    document: {
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: (name, listener) => listeners.set(name, listener)
    }
  });
  return {
    state,
    module: modules[0],
    operations: API.modules.operations,
    notices,
    paginate: (detail) => listeners.get('id-pagination-change')?.({ detail }),
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

test('audit navigation ignores late responses and keeps the last displayed page when refresh fails', async () => {
  const store = fixture();
  const requests = [];
  store.api.auditPage = (params) => new Promise((resolve, reject) => requests.push({ params, resolve, reject }));
  const browserState = browser(store.api, 'settings/audit');
  browserState.module.afterRender();
  const page = (id) => ({ items: [{ id }], page: 1, pageSize: 10, total: 1, snapshot: 100 });
  requests[0].resolve(page('original'));
  await flush();
  assert.equal(browserState.operations.getAudit()[0].id, 'original');

  browserState.paginate({ id: 'operations-login', page: 2, pageSize: 10 });
  assert.equal(requests.length, 1);
  browserState.paginate({ id: 'operations-audit', page: 2, pageSize: 10 });
  assert.equal(requests[1].params.snapshot, 100);
  browserState.module.onInput({ id: 'ops-list-search', value: '新版搜索' });
  assert.equal(requests[2].params.page, 1);
  assert.equal(requests[2].params.query, '新版搜索');
  assert.equal(requests[2].params.snapshot, undefined);
  requests[2].resolve(page('filtered'));
  requests[1].resolve(page('late'));
  await flush();
  assert.equal(browserState.operations.getAudit()[0].id, 'filtered');

  const refresh = browserState.operations.refreshAudit();
  assert.equal(requests[3].params.query, '新版搜索');
  assert.equal(requests[3].params.snapshot, undefined);
  requests[3].reject(new Error('network unavailable'));
  assert.equal(await refresh, false);
  assert.equal(browserState.operations.getAudit()[0].id, 'filtered');

  browserState.paginate({ id: 'operations-audit', page: 2, pageSize: 20 });
  requests[4].reject(new Error('page unavailable'));
  await flush();
  browserState.module.onClick('ops-audit-refresh', { dataset: {} });
  assert.equal(requests[5].params.page, 2);
  assert.equal(requests[5].params.pageSize, 20);
  assert.equal(requests[5].params.snapshot, 100);
  assert.equal(browserState.operations.getAudit()[0].id, 'filtered');
  requests[5].reject(Object.assign(new Error('access revoked'), { status: 403 }));
  await flush();
  assert.equal(browserState.operations.getAudit().length, 0);
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
