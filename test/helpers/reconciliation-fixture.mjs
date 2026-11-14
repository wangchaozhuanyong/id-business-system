// Synthetic records only. This fixture never opens a database or an HTTP server.
export function reconciliationFixture(count = 1) {
  const number = '0000000000002468', otherNumber = '0000000000001357';
  const types = { version: 2, data: { items: [{ id: 'vcc', name: '样例虚拟卡', active: true },
    { id: 'wise', name: '样例 Wise 卡', active: true }], assignments: { 'recharge:1': 'vcc', 'recharge:2': 'wise' } } };
  const archive = { version: 1, data: { cards: {} } };
  const state = { failCards: false, failBilling: false,
    cards: [{ id: 1, card_number: number, last4: '2468' }, { id: 2, card_number: otherNumber, last4: '1357' }],
    records: Array.from({ length: count }, (_, index) => ({ id: index + 1,
      payment_time: new Date(Date.UTC(2026, 10, 14, 6, -index)).toISOString(),
      card_number: index % 2 ? otherNumber : number, card_last4: index % 2 ? '1357' : '2468',
      email: 'recharge-' + (index + 1) + '@example.test',
      plan_type: ['plus', 'pro100', 'pro200', 'pro500'][index % 4],
      amount: index % 3 === 1 ? '0.00' : '20.00', currency: 'USD',
      status: ['success', 'failed', 'pending'][index % 3],
      stripe_session_id: 'cs_test_reconciliation_' + (index + 1),
      error_code: index % 3 === 1 ? 'card_declined' : '' })) };
  const calls = [];
  const client = { async get(path) {
    calls.push(path);
    const url = new URL(path, 'https://fixture.invalid');
    if (url.pathname === '/api/admin/cards') {
      if (state.failCards) throw new Error('fixture pool unavailable');
      return { cards: structuredClone(state.cards) };
    }
    if (url.pathname !== '/api/admin/billing') throw new Error('unexpected fixture request');
    if (state.failBilling) throw new Error('fixture billing unavailable');
    const p = url.searchParams;
    const time = value => value ? Date.parse(value.replace(' ', 'T') + 'Z') : undefined;
    const since = time(p.get('start_date')), until = time(p.get('end_date'));
    const rows = state.records.filter(row => (!p.get('card_last4') || row.card_last4 === p.get('card_last4')) &&
      (!p.get('plan_type') || row.plan_type === p.get('plan_type')) && (!p.get('status') || row.status === p.get('status')) &&
      (since === undefined || Date.parse(row.payment_time) >= since) && (until === undefined || Date.parse(row.payment_time) <= until));
    const page = Number(p.get('page') || 1);
    return { records: structuredClone(rows.slice((page - 1) * 20, page * 20)), total: rows.length };
  } };
  const store = { featureDocument(name) {
    if (name === 'card-types') return structuredClone(types);
    if (name === 'order-card-archive') return structuredClone(archive);
    throw new Error('unexpected fixture document');
  } };
  return { state, client, store, types, archive, calls, number, otherNumber };
}
