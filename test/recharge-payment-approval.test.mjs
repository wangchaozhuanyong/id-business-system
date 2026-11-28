import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { authorizeSubmit, checkoutQuote, createPaymentApprovals } from '../modules/recharge/codexdaichong/payment-approval.mjs';
import { handleApproval, approvalPath } from '../modules/recharge/codexdaichong/payment-approval-api.mjs';
import { createApprovalNotifications } from '../server/recharge-approval-notifications.mjs';
import { telegramText } from '../server/monitoring-policy.mjs';

const jobKey = '1830000000000-abcdefghijkl', plan = 'plus';
function fixture(amount = '1.00') {
  let time = 10_000, tail = Promise.resolve(), owns = true;
  const config = new Map(), operations = [], messages = [], card = { id: 1, owner: 'fixture', deadline: time + 150_000 };
  const db = { async execute(sql, args) {
    if (sql.startsWith('SELECT id FROM card_assets')) return [owns ? [{ id: 1 }] : []];
    if (sql.startsWith('SELECT job_key FROM task_logs')) return [[{ job_key: jobKey }]];
    if (sql.startsWith('SELECT config_value')) return [config.has(args[0]) ? [{ config_value: config.get(args[0]) }] : []];
    if (sql.startsWith('INSERT')) { assert(!config.has(args[0])); config.set(args[0], args[1]); return [{}]; }
    if (sql.startsWith('UPDATE app_config')) {
      assert(config.has(args[2])); config.delete(args[2]); config.set(args[0], args[1]); return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE task_logs')) { messages.push(args[0]); return [{ affectedRows: 1 }]; }
    if (sql.startsWith('SELECT c.config_value')) return [[...config].filter(([k]) => k.startsWith('paya/open/'))
      .map(([,config_value]) => ({ config_value, tail: 'ABCD', token_preview: 'user@example.test' }))];
    throw Error('unexpected SQL');
  } };
  const approvals = createPaymentApprovals(work => {
    const next = tail.then(() => work(db)); tail = next.catch(() => {}); return next;
  }, () => time);
  const options = { approvals, plan, jobKey, card, currentPage: () => 'checkout-A', now: () => time,
    readQuote: async () => ({ amount, currency: 'USD' }), emit: marker => operations.push(marker) };
  return { approvals, config, options, messages, operations, loseCard() { owns = false; },
    setAmount(value) { amount = value; }, advance(ms) { time += ms; } };
}

test('quote binds only an explicit current total and currency, including an explicit zero', () => {
  for (const [line, amount, currency] of [['Total due today\n₱1,234.50','1234.50','PHP'],
    ['今日应付：EGP 0.00','0.00','EGP'], ['Due today $0.00 USD','0.00','USD'],
    ['Due today 99.00 EGP','99.00','EGP']]) assert.deepEqual(checkoutQuote(line), { amount, currency });
  for (const line of ['Free trial','Due today $5.00','Monthly price USD 30','Due today USD 1.001',
    'Due today EUR 0.00\nDue today EUR 6.00','Due today €1.20 USD']) assert.equal(checkoutQuote(line), null);
});

test('mode defaults to manual, old admissions cannot be released by re-enabling, concurrent writes conflict', async () => {
  const { approvals } = fixture();
  assert.deepEqual(await approvals.policy(), { automatic: false, version: 0 });
  assert.equal(await approvals.automaticAllowed(0), false);
  const writes = await Promise.allSettled([approvals.setPolicy(true,0,'admin-A'), approvals.setPolicy(true,0,'admin-B')]);
  assert.equal(writes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(await approvals.automaticAllowed(1), true);
  await approvals.setPolicy(false,1,'admin-B'); await approvals.setPolicy(true,2,'admin-B');
  assert.equal(await approvals.automaticAllowed(1), false);
  assert.equal(await approvals.automaticAllowed(3), true);
});

test('a real pending transition always precedes consent and two operators can consume one submission only', async () => {
  const f = fixture('0.00');
  let id;
  const passed = await authorizeSubmit({ ...f.options, wait: async () => {
    const [item] = await f.approvals.list(); id = item.id;
    assert.equal(item.amount, '0.00'); assert.equal(item.email, 'u•••@example.test');
    const results = await Promise.allSettled(['one','two'].map(actor => f.approvals.decide(id,'approved',actor)));
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  } });
  assert.equal(passed, true);
  assert.equal(f.messages.length, 1);
  assert.equal(JSON.parse(f.config.get('paya/audit/' + id)).state, 'consumed');
  await assert.rejects(f.approvals.finish(id,'consumed',{ amount:'0.00', currency:'USD' }));
  assert.deepEqual(await f.approvals.list(), []);
});

test('price change creates a new confirmation, cancellation, expiry, lost reservation and debug all prevent submission', async () => {
  for (const scenario of ['price','expiry','cancel','card','navigation','debug']) {
    const f = fixture(); let count = 0, page = 'initial';
    const result = await authorizeSubmit({ ...f.options, debug: scenario === 'debug', currentPage: () => page, wait: async () => {
      const [row] = await f.approvals.list(); ++count;
      if (scenario === 'expiry') return f.advance(120_001);
      if (scenario === 'navigation') { page = 'next'; return; }
      if (scenario === 'price' && count === 1) f.setAmount('2.00');
      if (scenario === 'card') f.loseCard();
      return f.approvals.decide(row.id, scenario === 'cancel' || count === 2 ? 'cancelled' : 'approved','operator');
    } });
    assert.equal(result, false, scenario);
    assert.equal(count, scenario === 'debug' ? 0 : scenario === 'price' ? 2 : 1, scenario);
    assert.equal([...f.config.values()].some(v => JSON.parse(v).state === 'consumed'), false);
  }
});

test('manual pending survives enabling automatic and a retried card needs its own confirmation', async () => {
  const f = fixture(); let opens = 0;
  const wait = async () => {
    const [item] = await f.approvals.list(); ++opens;
    if (opens === 1) await f.approvals.setPolicy(true,0,'operator');
    await f.approvals.decide(item.id, opens === 1 ? 'approved' : 'cancelled','operator');
  };
  assert.equal(await authorizeSubmit({ ...f.options, wait }), true);
  assert.equal(await authorizeSubmit({ ...f.options, wait }), false);
  assert.equal(await authorizeSubmit({ ...f.options, admissionVersion: 1, wait }), true);
  assert.equal(opens, 2);
});

test('approval HTTP operations enforce the authenticated role, service boundary, and reject stale or malformed decisions', async () => {
  const f = fixture(), row = await f.approvals.open(jobKey, plan, { amount:'0.00',currency:'USD' },130_000);
  const call = async (actor, url, body, method = 'POST') => {
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method,url,headers:{ 'content-type':'application/json' } });
    const res = { writeHead(code) { this.code = code; }, end() {} };
    await handleApproval(req, res, actor, f.approvals); return res.code;
  };
  const path = approvalPath + '/' + row.id + '/approve', actor = { id:'super', admin:true, sensitive:true };
  assert.equal(await call({ ...actor, sensitive:false },path,'{}'),403);
  assert.equal(await call({ ...actor, id:'order-reconciliation' },path,'{}'),403);
  assert.equal(await call(actor,path,'{"automatic":true}'),400);
  assert.equal(await call(actor,path,'{}'),200);
  assert.equal(await call(actor,path,'{}'),409);
});

test('notifications use live pending rows and one Telegram event per confirmation; customer data stays off the channel', async () => {
  let events = [], calls = 0, items = [];
  const notifier = createApprovalNotifications({ list: async () => ({ items }),
    observe: rows => events.push(...rows), publish: () => { calls++; } });
  items = [{id:'one', email:'private@example.test', expires:Date.now()+10_000}];
  await notifier.collect(); await notifier.collect();
  assert.equal(events.length,1); assert.equal(events[0].scope,'one');
  const body = telegramText({ ...events[0], at: Date.now() },'https://example.test');
  assert.match(body,/等待确认付款/); assert.doesNotMatch(body,/private|token|approve\//i);
  items = []; await notifier.collect();
  assert.equal(calls,2); notifier.close();
});

