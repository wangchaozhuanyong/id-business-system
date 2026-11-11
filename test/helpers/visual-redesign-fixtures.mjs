import { createOrderSnapshot } from '../../modules/finance/accounting.mjs';
const clock = Date.now();
const instant = day => new Date(clock + day * 86_400_000).toISOString();
const orders = Array.from({ length: 28 }, (_, i) => {
  const order = {
    id: 'visual-order-' + i, orderNo: 'DEMO-' + String(i + 1).padStart(4, '0'), product: 'GPT', plan: 'Plus',
    customerId: 'visual-customer-' + i, email: 'sample' + i + '@example.test', payment: '银行卡',
    paymentId: '000000', cardId: 'visual-card-' + i, paidAmount: '1000', paidCurrency: 'PHP',
    saleAmount: '250', saleCurrency: 'CNY', createdAt: instant(-(i % 7)), start: instant(-(i % 7)),
    expiry: instant(30 - (i % 7)), costBasis: 'standard', receiptConfirmed: true,
    paidConfirmed: true, costConfirmed: true,
    costSettings: { version: 1, cardPercent: '0.008', cardPerPaymentUsd: '0.3', cardIssueUsd: '0.5' },
    issueFeeSnapshot: { applied: true, cardId: 'visual-card-' + i, amountUsd: '0.5' }, refunds: [], bankReturns: []
  };
  order.fxSnapshot = createOrderSnapshot({
    source: '离线视觉合成凭据', at: instant(-40), expiresAt: instant(1),
    rates: { MYR: '1.6', USD: '7.2', PHP: '0.125' }
  }, order, clock);
  return order;
});
export const fixtures = {
  commerce: { version: 1, data: { orders, customers: orders.map((o, i) => ({
    id: o.customerId, name: '示例客户 ' + (i + 1), email: o.email, createdAt: o.createdAt
  })) } },
  inventory: { version: 1, data: {
    mailboxes: Array.from({ length: 24 }, (_, i) => ({ id: 'visual-mail-' + i,
      email: 'mail' + i + '@example.test', type: i % 5 ? 'google' : 'relay',
      inventoryState: i % 7 ? 'available' : 'claimed', health: i === 7 ? 'dead' : 'normal' })),
    accounts: Array.from({ length: 15 }, (_, i) => ({ id: 'visual-account-' + i,
      email: 'account' + i + '@example.test', type: i % 3 ? 'gpt' : 'claude',
      registered: instant(-40), inventoryState: i % 5 ? 'available' : 'claimed' })), batches: []
  } },
  appleBalance: { version: 1, data: { refunds: [{ id: 'visual-refund', status: 'pending' }] } }
};
