import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';

const settings = () => ({ mailboxTypes: [], costSettings: { currency: 'CNY' } });
const save = (store, version, data, action = 'customer_sources_save') =>
  store.saveBatch([{ domain: 'settings', version, data, action }]);

test('客户来源和标签共用设置文档，重开后保留并记录独立审计动作', async () => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'customer-options-test-'));
  const path = join(directory, 'business.sqlite');
  let store;
  try {
    store = createLocalBusinessStore(path);
    const data = {
      ...settings(),
      customerSources: ['客户推荐', '网站咨询'],
      customerTags: ['复购客户']
    };
    save(store, 0, data);
    assert.deepEqual(store.load('settings'), { version: 1, data });
    assert.equal(store.audit()[0].action, 'customer_sources_save');
    assert.match(store.audit()[0].summary, /保存客户来源设置/);
    store.close();
    store = undefined;
    store = createLocalBusinessStore(path);
    assert.deepEqual(store.load('settings'), { version: 1, data });
    assert.equal(store.audit()[0].action, 'customer_sources_save');
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('客户来源拒绝非法清单且失败不修改文档或审计', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    for (const customerSources of [
      null, '网站', {}, [1], [''], [' 网站'], ['网站 '], ['网\n站'], ['网\r站'],
      ['VIP', 'vip'], ['客户推荐', '客户推荐'], ['长'.repeat(41)],
      Array.from({ length: 101 }, (_, index) => `来源 ${index}`)
    ]) {
      assert.throws(
        () => save(store, 0, { ...settings(), customerSources }),
        (error) => error.status === 400 && error.message.includes('客户来源')
      );
    }
    assert.deepEqual(store.load('settings'), { version: 0, data: null });
    assert.equal(store.audit().length, 0);
    const maximum = Array.from({ length: 100 }, (_, index) => `${index}`.padEnd(40, '项'));
    save(store, 0, { ...settings(), customerSources: maximum });
    assert.deepEqual(store.load('settings').data.customerSources, maximum);
  } finally {
    store.close();
  }
});

test('旧设置载荷不清空来源或标签，显式空清单亦保留', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    save(store, 0, settings(), 'fee_rules_save');
    assert.equal(Object.hasOwn(store.load('settings').data, 'customerSources'), false);
    save(store, 1, { ...settings(), customerSources: ['网站'], customerTags: ['复购'] });
    save(store, 2, { ...settings(), costSettings: { currency: 'MYR' } }, 'fee_rules_save');
    assert.deepEqual(store.load('settings').data, {
      ...settings(), costSettings: { currency: 'MYR' }, customerSources: ['网站'], customerTags: ['复购']
    });
    save(store, 3, { ...settings(), customerSources: [] });
    assert.deepEqual(store.load('settings').data.customerTags, ['复购']);
    save(store, 4, { ...settings(), customerTags: [] }, 'customer_tags_save');
    save(store, 5, settings(), 'fee_rules_save');
    assert.deepEqual(store.load('settings').data.customerSources, []);
    assert.deepEqual(store.load('settings').data.customerTags, []);
  } finally {
    store.close();
  }
});

test('旧版本的来源写入返回 409，不覆盖新设置', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const data = { ...settings(), customerSources: ['网站'], customerTags: ['复购'] };
    save(store, 0, data);
    assert.throws(
      () => save(store, 0, { ...settings(), customerSources: ['旧页面来源'] }),
      (error) => error.status === 409
    );
    assert.deepEqual(store.load('settings'), { version: 1, data });
    assert.equal(store.audit().length, 1);
  } finally {
    store.close();
  }
});

test('移除来源不改写客户历史，也不阻止历史资料继续编辑', () => {
  const store = createLocalBusinessStore(':memory:');
  const commerce = {
    customers: [{ id: 'customer-1', name: '客户一', source: '旧来源' }],
    tenants: [], orders: [], operating: [], rentBatches: [], logs: []
  };
  try {
    save(store, 0, { ...settings(), customerSources: ['旧来源'] });
    store.saveBatch([{ domain: 'commerce', version: 0, data: commerce }]);
    save(store, 1, { ...settings(), customerSources: [] });
    assert.equal(store.load('commerce').data.customers[0].source, '旧来源');
    const updated = { ...commerce, customers: [{ ...commerce.customers[0], name: '客户一改名' }] };
    store.saveBatch([{ domain: 'commerce', version: 1, data: updated }]);
    assert.equal(store.load('commerce').data.customers[0].source, '旧来源');
  } finally {
    store.close();
  }
});
