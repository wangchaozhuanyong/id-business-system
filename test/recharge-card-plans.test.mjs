import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { prepareCodexdaichong } from '../modules/recharge/codexdaichong/prepare.mjs';

let fixture, storeCode;
before(async () => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  fixture = await mkdtemp(join(runtime, 'card-plan-tests-'));
  const engine = await prepareCodexdaichong(join(fixture, 'engine'));
  storeCode = await readFile(join(engine, 'mysql-store.js'), 'utf8');
});
after(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }); });

function section(start, end) {
  const first = storeCode.indexOf(start), last = storeCode.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return storeCode.slice(first, last);
}

const policyKey = 'id_recharge_card_plan_policy';
const assignmentPrefix = 'id_recharge_card_plans:';
const card = (id, fields = {}) => ({
  id, is_active: 1, in_use: 0, status: '正常', cooldown_until: null, usage_count: 0,
  card_number: 'synthetic-card-' + id, ...fields
});
function memoryStore(cards, { strict = false, rules = {}, assignmentFailure = false } = {}) {
  let state = {
    cards, config: { [policyKey]: JSON.stringify({ version: 0, strict }),
      ...Object.fromEntries(Object.entries(rules).map(([id, plans]) => [assignmentPrefix + id, plans])) }
  };
  const locks = [];
  const available = (db, params) => {
    const [plan, prefix, fallback] = params;
    assert.equal(prefix, assignmentPrefix);
    return db.cards.filter(row => row.is_active === 1 && row.in_use === 0 && row.status === '正常' &&
      !row.cooldown_until && (Object.hasOwn(db.config, prefix + row.id)
        ? db.config[prefix + row.id].split(',').includes(plan) : fallback === 1))
      .sort((a, b) => a.usage_count - b.usage_count || a.id - b.id).slice(0, 1);
  };
  async function runQuery(sql, params, { connection }) {
    assert(connection, 'read is inside the same transaction');
    const db = connection.state;
    if (/^SELECT config_value/.test(sql)) {
      assert.equal(params[0], policyKey);
      locks.push(sql.endsWith('FOR UPDATE') ? 'policy-write' : 'policy-read');
      return [{ config_value: db.config[policyKey] }];
    }
    if (/^SELECT id,\s*in_use/.test(sql)) {
      assert.match(sql, /FOR UPDATE$/);
      locks.push('card-edit');
      return db.cards.filter(row => params.includes(row.id));
    }
    if (/^SELECT card_number/.test(sql)) return db.cards.filter(row => params.includes(row.card_number));
    assert.match(sql, /FIND_IN_SET/);
    assert.match(sql, /cooldown_until IS NULL OR cooldown_until < NOW/);
    return available(db, params);
  }
  async function runExecute(sql, params, { connection }) {
    const db = connection.state;
    if (/^INSERT INTO card_assets/.test(sql)) {
      const id = Math.max(0, ...db.cards.map(row => row.id)) + 1;
      db.cards.push(card(id, { card_number: params[0] }));
      return { insertId: id };
    }
    if (/^INSERT INTO app_config/.test(sql)) {
      if (assignmentFailure) throw new Error('synthetic assignment failed');
      for (let i = 0; i < params.length; i += 2) db.config[params[i]] = params[i + 1];
      return { affectedRows: params.length / 2 };
    }
    assert.match(sql, /^UPDATE app_config/);
    db.config[params[1]] = params[0];
    return { affectedRows: 1 };
  }
  const withTransaction = async callback => {
    const draft = structuredClone(state);
    const result = await callback({ state: draft, async query(sql, params) {
      if (/^SELECT/.test(sql)) {
        assert.match(sql, /FIND_IN_SET/);
        assert.match(sql, /FOR UPDATE SKIP LOCKED$/);
        assert.match(sql, /ORDER BY usage_count ASC/);
        locks.push('card-reserve');
        return [available(draft, params)];
      }
      assert.match(sql, /^UPDATE card_assets/);
      draft.cards.find(row => row.id === params[1]).in_use = 1;
      return [{ affectedRows: 1 }];
    } });
    state = draft;
    return result;
  };
  const api = runInNewContext(
    section('const CARD_PLAN_POLICY_KEY', '/**\n * Reserve one card ID') +
    section('async function importCards(cards,', '// ─── Region Selector') +
    '\n({ hasAvailableCard, reserveCard, saveCardPlanPolicy, importCards })',
    { runQuery, runExecute, withTransaction,
      CANONICAL_PLAN_TYPES: ['plus', 'pro100', 'pro200', 'pro500'],
      validateCard: row => ({ valid: /^\d+$/.test(row.card_number), errors: ['invalid'] }) }
  );
  return { ...api, state: () => state, locks };
}

test('precheck, first reservation and replacement exclude wrong-plan, locked and cooling cards', async () => {
  const store = memoryStore([
    card(1), card(2), card(3, { usage_count: 2 }), card(4, { cooldown_until: 'future' }),
    card(5, { in_use: 1 }), card(6, { status: '已报废' }), card(7)
  ], { strict: true, rules: { 1: 'plus', 2: 'pro500', 3: 'pro500,pro200', 4: 'pro500', 5: 'pro500', 6: 'pro500' } });
  assert.equal(await store.hasAvailableCard('pro100'), false);
  assert.equal(await store.hasAvailableCard('pro500'), true);
  assert.equal((await store.reserveCard('job', 'pro500')).id, 2);
  assert.equal((await store.reserveCard('job', 'pro500')).id, 3);
  assert.equal(await store.reserveCard('job', 'pro500'), null);
  assert.equal((await store.reserveCard('low', 'plus')).id, 1);
  assert.deepEqual(store.locks.slice(2, 4), ['policy-read', 'card-reserve']);
});

test('legacy mode only admits unassigned cards and cannot bypass an explicit restriction', async () => {
  const store = memoryStore([card(1), card(2, { usage_count: 1 })], { rules: { 1: 'pro500' } });
  assert.equal((await store.reserveCard('low', 'plus')).id, 2);
  assert.equal(await store.hasAvailableCard('plus'), false);
  assert.equal((await store.reserveCard('high', 'pro500')).id, 1);
});

test('configuration writes reject stale or in-use cards and use one version for a batch', async () => {
  const store = memoryStore([card(1), card(2), card(3, { in_use: 1 })]);
  await assert.rejects(store.saveCardPlanPolicy({ version: 0, cardIds: [1, 3], allowedPlans: ['plus'] }),
    error => error.status === 409);
  assert.equal(store.state().config[assignmentPrefix + '1'], undefined);
  const saved = await store.saveCardPlanPolicy({ version: 0, cardIds: [1, 2], allowedPlans: ['pro500', 'pro200'] });
  assert.equal(saved.version, 1);
  assert.equal(store.state().config[assignmentPrefix + '2'], 'pro200,pro500');
  await assert.rejects(store.saveCardPlanPolicy({ version: 0, strict: true }), error => error.status === 409);
  await assert.rejects(store.saveCardPlanPolicy({ version: 1, cardIds: [1], allowedPlans: ['unknown'] }),
    error => error.status === 400);
  assert.equal((await store.saveCardPlanPolicy({ version: 1, strict: true })).strict, true);
  assert.equal(await store.hasAvailableCard('plus'), false);
});

test('a batch assigns only inserted cards and rolls back inserts when its assignment fails', async () => {
  const input = [{ card_number: '4242424242424242' }, { card_number: '5555555555554444' }, { card_number: 'bad' }];
  const previous = card(1, { card_number: input[0].card_number });
  const store = memoryStore([previous], { strict: true, rules: { 1: 'plus' } });
  const result = await store.importCards(input, { version: 0, allowedPlans: ['pro500'] });
  assert.deepEqual([result.imported, result.skipped, result.failed, result.assignedPlans], [1, 1, 1, 1]);
  assert.equal(store.state().config[assignmentPrefix + '1'], 'plus');
  assert.equal(store.state().config[assignmentPrefix + '2'], 'pro500');
  assert.equal((await store.reserveCard('high', 'pro500')).id, 2);
  const retry = await store.importCards(input, { version: 1, allowedPlans: ['pro100'] });
  assert.equal(retry.imported, 0);
  assert.equal(retry.planPolicy.version, 1);
  assert.equal(store.state().config[assignmentPrefix + '2'], 'pro500');
  const failed = memoryStore([previous], { strict: true, assignmentFailure: true });
  await assert.rejects(failed.importCards(input, { version: 0, allowedPlans: ['pro500'] }), /synthetic assignment failed/);
  assert.equal(failed.state().cards.length, 1);
  assert.equal(JSON.parse(failed.state().config[policyKey]).version, 0);
});
