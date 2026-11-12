import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

async function check() {
  const suffix = /^id_redesign_codexdaichong_test_release_([0-9a-f]{12})$/.exec(process.env.DB_NAME || '')?.[1];
  const password = readFileSync(0, 'utf8').trim();
  if (!suffix || process.env.DB_USER !== 'canary_' + suffix || !/^[0-9a-f]{64}$/.test(password))
    throw new Error('Isolated canary required');
  process.env.DB_PASSWORD = password;
  const require = createRequire('/candidate/.runtime/codexdaichong/package.json');
  const store = require('./mysql-store.js');
  const card = index => ({
    card_number: '00000000000071' + String(index).padStart(2, '0'),
    card_expiry: '12/30',
    card_cvc: '000'
  });
  const [identity] = await store.runQuery('SELECT DATABASE() AS db, CURRENT_USER() AS account');
  assert.equal(identity.db, process.env.DB_NAME);
  assert.equal(identity.account.split('@')[0], process.env.DB_USER);

  assert.deepEqual((await store.readCardPlanPool()).planPolicy, { version: 0, strict: false });
  const plus = await store.importCards([card(1), card(1)], { version: 0, allowedPlans: ['plus'] });
  assert.deepEqual([plus.imported, plus.assignedPlans, plus.skipped, plus.planPolicy.version], [1, 1, 1, 1]);
  const pro = await store.importCards([card(1), card(2)], { version: 1, allowedPlans: ['pro100'] });
  assert.deepEqual([pro.imported, pro.assignedPlans, pro.skipped, pro.planPolicy.version], [1, 1, 1, 2]);
  await store.importCards([card(3)]);
  const pool = await store.readCardPlanPool();
  assert.deepEqual(pool.rows.map(row => row.plan_value), ['plus', 'pro100', null]);
  assert.equal(await store.hasAvailableCard('pro500'), true);
  assert.deepEqual(await store.saveCardPlanPolicy({ version: 2, strict: true }), { version: 3, strict: true });
  await assert.rejects(store.saveCardPlanPolicy({ version: 2, strict: false }), { status: 409 });
  assert.equal(await store.hasAvailableCard('pro500'), false);

  const concurrent = await Promise.all([
    store.reserveCard('canary-pro-1', 'pro100'),
    store.reserveCard('canary-pro-2', 'pro100')
  ]);
  const selected = concurrent.filter(Boolean);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, pool.rows[1].id);
  assert.equal(await store.reserveCard('canary-pro-retry', 'pro100'), null);
  await assert.rejects(store.saveCardPlanPolicy({
    version: 3, cardIds: [selected[0].id], allowedPlans: ['plus']
  }), { status: 409 });
  const plusCard = await store.reserveCard('canary-plus', 'plus');
  assert.equal(plusCard?.id, pool.rows[0].id);
  await store.releaseCard(plusCard.id);
  await store.releaseCard(selected[0].id);

  await store.runQuery(`CREATE TRIGGER card_plan_canary_reject BEFORE INSERT ON app_config FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic assignment rejection'`);
  await assert.rejects(store.importCards([card(4)], { version: 3, allowedPlans: ['pro100'] }),
    /synthetic assignment rejection/);
  const after = await store.readCardPlanPool();
  assert.deepEqual(after.rows.map(row => row.id), pool.rows.map(row => row.id));
  assert.deepEqual(after.planPolicy, { version: 3, strict: true });
}

try {
  await check();
  console.log('card_plan_mysql_transactions_passed');
  process.exit(0);
} catch {
  process.exit(1);
}
