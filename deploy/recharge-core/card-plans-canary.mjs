import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

let stage = 0;

async function check() {
  stage = 1;
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

  stage = 2;
  assert.deepEqual((await store.readCardPlanPool()).planPolicy, { version: 0, strict: false, reuseLimits: null });
  const plus = await store.importCards([card(1), card(1)], { version: 0, allowedPlans: ['plus'] });
  assert.deepEqual([plus.imported, plus.assignedPlans, plus.skipped, plus.planPolicy.version], [1, 1, 1, 1]);
  const pro = await store.importCards([card(1), card(2)], { version: 1, allowedPlans: ['pro100'] });
  assert.deepEqual([pro.imported, pro.assignedPlans, pro.skipped, pro.planPolicy.version], [1, 1, 1, 2]);
  await store.importCards([card(3)]);
  const pool = await store.readCardPlanPool();
  assert.deepEqual(pool.rows.map(row => row.plan_value), ['plus', 'pro100', null]);
  stage = 3;
  assert.equal(await store.hasAvailableCard('pro500'), true);
  assert.deepEqual(await store.saveCardPlanPolicy({ version: 2, strict: true }),
    { version: 3, strict: true, reuseLimits: null });
  await assert.rejects(store.saveCardPlanPolicy({ version: 2, strict: false }), { status: 409 });
  assert.equal(await store.hasAvailableCard('pro500'), false);

  stage = 4;
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

  stage = 5;
  await store.runQuery(`CREATE TRIGGER card_plan_canary_reject BEFORE INSERT ON app_config FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic assignment rejection'`);
  try {
    await assert.rejects(store.importCards([card(4)], { version: 3, allowedPlans: ['pro100'] }),
      /synthetic assignment rejection/);
  } finally {
    await store.runQuery('DROP TRIGGER card_plan_canary_reject');
  }
  const after = await store.readCardPlanPool();
  assert.deepEqual(after.rows.map(row => row.id), pool.rows.map(row => row.id));
  assert.deepEqual(after.planPolicy, { version: 3, strict: true, reuseLimits: null });

  stage = 6;
  await store.saveCardPlanPolicy({ version: 3, cardIds: [plusCard.id], allowedPlans: ['plus', 'pro200'] });
  const reuseLimits = { plus: 2, pro100: 1, pro200: 1, pro500: 1 };
  await assert.rejects(store.saveCardPlanPolicy({ version: 4, reuseLimits: { ...reuseLimits, plus: 0 } }), { status: 400 });
  await assert.rejects(store.saveCardPlanPolicy({ version: 4, reuseLimits, strict: false }), { status: 400 });
  const policy = await store.saveCardPlanPolicy({ version: 4, reuseLimits });
  assert.deepEqual(policy, { version: 5, strict: true, reuseLimits });
  assert.deepEqual(await store.saveCardPlanPolicy({ version: 5, reuseLimits }), policy);
  await assert.rejects(store.saveCardPlanPolicy({ version: 4, reuseLimits }), { status: 409 });

  stage = 7;
  const pro200 = await store.reserveCard('canary-reuse-pro200', 'pro200');
  assert.equal(pro200?.id, plusCard.id);
  await store.recordCardUsage(pro200.id);
  await store.releaseCard(pro200.id);
  assert.equal(await store.hasAvailableCard('pro200'), false);
  assert.equal(await store.reserveCard('canary-reuse-pro200-retry', 'pro200'), null);
  stage = 8;
  assert.equal(await store.hasAvailableCard('plus'), true);
  const reuse = await store.reserveCard('canary-reuse-plus', 'plus');
  assert.equal(reuse?.id, plusCard.id);
  await store.recordCardUsage(reuse.id);
  await store.releaseCard(reuse.id);
  assert.equal(await store.hasAvailableCard('plus'), false);
  assert.equal(await store.reserveCard('canary-reuse-plus-retry', 'plus'), null);
  assert.deepEqual((await store.readCardPlanPool()).planPolicy, policy);
  stage = 9;
  assert.deepEqual((await store.saveCardPlanPolicy({ version: 5, strict: false })).reuseLimits, reuseLimits);
  await store.saveCardPlanPolicy({ version: 6, reuseLimits: { ...reuseLimits, plus: 3 } });
  const canUseAgain = await store.reserveCard('canary-reuse-after-raise', 'plus');
  // The unassigned card has a lower use count while strict mode is off.
  assert.equal(canUseAgain?.id, pool.rows[2].id);
  await store.releaseCard(canUseAgain.id);
  stage = 10;
  await store.saveCardPlanPolicy({ version: 7, strict: true });
  assert.equal((await store.reserveCard('canary-reuse-after-raise-strict', 'plus'))?.id, plusCard.id);
  await store.releaseCard(plusCard.id);
}

try {
  await check();
  console.log('card_plan_mysql_transactions_passed');
  process.exit(0);
} catch {
  // Emit only a bounded stage exit code so failures never leak credentials or SQL state.
  process.exit(10 + stage);
}
