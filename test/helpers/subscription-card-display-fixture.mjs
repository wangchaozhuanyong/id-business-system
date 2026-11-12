import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createCardManagementHandler } from '../../server/card-management.mjs';
import { projectSubscriptions, renewalCardKey } from '../../server/subscription-management.mjs';

export const cardDisplayOrigin = 'https://design-layout.invalid';
export const cardDisplayActor = { id: 'card-display-admin', name: '合成管理员', role: 'admin' };
export const cardDisplayTime = Date.parse('2026-11-12T04:00:00Z');
export const syntheticCards = {
  shared: '4242424242424242', sameTail: '4000000000004242', archived: '5555555555554444',
  replacement: '4000000000000002', frozen: '6011111111111117'
};

export function cardDisplayFixture() {
  const base = { version: 1, product: 'GPT', plan: 'Plus', payment: '银行卡', source: '管理员手工',
    customerId: 'display-customer', businessType: '续费', accountSource: '客户自有',
    start: '2026-10-12T12:00:00+08:00', expiry: '2026-12-12T12:00:00+08:00',
    paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active',
    paidAmount: '20', paidCurrency: 'USD', saleAmount: '100', saleCurrency: 'CNY' };
  const make = (id, details) => ({ ...base, id, orderNo: 'TEST-' + id,
    email: id + '@example.test', ...details });
  const manual = (id, number, serial, type = 'wise') => make(id, { cardId: '', proMaterialMode: 'manual_card',
    proCardNumber: number, paymentId: number.slice(-4), proCardSerial: serial,
    cardTypeId: type, cardTypeName: type === 'wise' ? 'wise潘' : 'vccwc999' });
  const orders = [
    manual('manual', syntheticCards.shared, '0007-A'),
    make('pool', { cardId: 'recharge:7', paymentId: '4242', proCardSerial: '0007-B' }),
    make('same-tail', { cardId: 'recharge:8', paymentId: '4242', proCardSerial: '0008' }),
    make('archive', { cardId: 'recharge:9', paymentId: '4444', proCardSerial: '0009' }),
    make('missing', { cardId: 'recharge:10', paymentId: '1234' }),
    make('conflict', { cardId: 'recharge:11', paymentId: '4242', proCardNumber: syntheticCards.shared,
      proCardSerial: 'WRONG-SERIAL' }),
    manual('preferred', syntheticCards.shared, 'OLD-SERIAL'),
    manual('replacement-source', syntheticCards.replacement, '0012', 'vcc'),
    make('frozen', { cardId: 'recharge:12', paymentId: '1117', proCardSerial: 'FRZ-0001' })
  ];
  orders.push({ ...orders[0], id: 'manual-history', orderNo: 'TEST-manual-history',
    start: '2026-09-12T12:00:00+08:00', expiry: '2026-10-12T12:00:00+08:00' });
  const fingerprint = number => /^\d{12,19}$/.test(number || '')
    ? createHash('sha256').update(number).digest('hex') : '';
  const snapshots = {
    commerce: { version: 1, data: { orders, customers: [{ id: 'display-customer', name: '合成客户', active: true }],
      tenants: [], operating: [], rentBatches: [], logs: [] } },
    inventory: { version: 1, data: { accounts: [], mailboxes: [], batches: [], returnRecords: [],
      importRecords: [], registrationRecords: [], tableSettings: [], undo: [] } },
    subscriptions: { version: 1, data: { renewalCards: {} } },
    mailboxes: { version: 1, data: { items: [] } }
  };
  const preferred = projectSubscriptions(snapshots, cardDisplayTime).find(row => row.account === 'preferred@example.test');
  snapshots.subscriptions.data.renewalCards[renewalCardKey(preferred.id, preferred.series[0].key)] = {
    number: syntheticCards.replacement, last4: '0002'
  };
  const documents = {
    'card-types': { version: 1, data: { items: [{ id: 'wise', name: 'wise潘', active: true },
      { id: 'vcc', name: 'vccwc999', active: true }],
    assignments: { 'recharge:7': 'wise', 'recharge:8': 'vcc', 'recharge:12': 'vcc' } } },
    'order-card-archive': { version: 1, data: { cards: { 'recharge:9': { number: syntheticCards.archived, last4: '4444' } } } },
    'order-card-freeze': { version: 1, data: { items: [{ id: 'frozen-card', orderId: 'frozen', cardIds: ['recharge:12'],
      fingerprint: fingerprint(syntheticCards.frozen), last4: '1117', typeName: 'vccwc999',
      frozenAt: '2026-11-11T04:00:00Z', frozenBy: '合成管理员', reason: '合成冻结记录', poolState: 'stopped' }] } }
  };
  const audits = [], reads = [];
  const store = {
    load: domain => snapshots[domain] || { version: 0, data: {} },
    featureDocument: domain => documents[domain] || { version: 0, data: {} },
    orderCardFingerprint: fingerprint,
    withSubscriptions: (_actor, operation) => operation(snapshots),
    auditFeature: (domain, version, event) => audits.push({ domain, version, ...event })
  };
  const client = { async get(path) {
    reads.push(path);
    if (path !== '/api/admin/cards') throw new Error('Unexpected synthetic request');
    return { cards: [[7, syntheticCards.shared], [8, syntheticCards.sameTail],
      [11, syntheticCards.sameTail], [12, syntheticCards.frozen]].map(([id, number]) =>
      ({ id, card_number: number, last4: number.slice(-4), card_cvc: 'SYNTHETIC-CVC', is_active: id === 12 ? 0 : 1 })) };
  } };
  const handler = createCardManagementHandler({ store, client, publicOrigin: cardDisplayOrigin, clock: () => cardDisplayTime });
  async function request({ details = true, actor = cardDisplayActor, requestOrigin = cardDisplayOrigin,
    path = '/api/local/subscription-card-status', command } = {}) {
    const req = Object.assign(Readable.from(command ? [Buffer.from(JSON.stringify(command))] : []), {
      method: command ? 'POST' : 'GET', url: path + (!command && details ? '?includeDetails=1' : ''),
      headers: { origin: requestOrigin, 'content-type': 'application/json' } });
    let status, headers, body;
    await handler(req, { writeHead(code, values) { status = code; headers = values; },
      end(value) { body = JSON.parse(value); } }, path, actor);
    return { status, headers, body };
  }
  return { snapshots, documents, orders, audits, reads, request };
}
