import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as orderOpening from './order-opening.mjs';
import * as renewalReminders from '../modules/orders/renewal-reminders.mjs';

const source = await readFile(new URL('./commerce-prototype.js', import.meta.url), 'utf8');

test('银行卡价格与类型的变动触发重新读取，失败时通知同步层重试', async () => {
  const reads = { estimates: 0, types: 0, status: 0, renders: 0 };
  let unavailable = false;
  const modules = [];
  const api = { state: { route: 'subscriptions/bank-cards', demoOrders: [], drafts: new Map() }, modules: {}, money: {},
    render: () => { reads.renders++; } };
  const data = {
    actor: () => ({ id: 'synthetic-admin', role: 'admin' }),
    subscriptionCardEstimates: async () => {
      reads.estimates++;
      if (unavailable) throw new Error('合成读取失败');
      return { items: [] };
    },
    subscriptionCardStatus: async () => { reads.status++; return { items: [], frozen: [] }; },
    cardTypes: async () => { reads.types++; return { version: reads.types, items: [], assignments: {} }; }
  };
  runInNewContext(source, {
    window: { IDOrderOpening: orderOpening, IDRenewalReminders: renewalReminders, IDDesignAPI: api, IDDesignModules: modules, IDLocalData: data },
    document: { querySelector: () => null },
    structuredClone: globalThis.structuredClone,
    Date, Map, Set, WeakMap, Promise, Intl
  });
  const commerce = modules.find(module => module.id === 'commerce');
  await commerce.onDataChanges(['settings', 'card-types', 'finance-rates']);
  assert.equal(reads.estimates, 1);
  assert.equal(reads.types, 1);
  assert.equal(reads.status, 1);
  assert.equal(reads.renders, 1);

  unavailable = true;
  assert.equal(await commerce.onDataChanges(['finance-rates']), false);
  assert.equal(reads.estimates, 2);
  assert.equal(reads.types, 2);
  unavailable = false;
  assert.notEqual(await commerce.onDataChanges(['finance-rates']), false);
  assert.equal(reads.estimates, 3);
  await commerce.onDataChanges(['order-card-freeze']);
  assert.equal(reads.status, 4);
});
