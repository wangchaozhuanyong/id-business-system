import { createOrderSnapshot } from '../../modules/finance/accounting.mjs';

export const demoClock = Date.parse('2026-11-05T06:00:00Z');

export function demoOrders() {
  const order = (id, fields) => ({
    id, orderNo: id, product: 'GPT', payment: '银行卡',
    start: '2026-11-03T12:00', cardId: 'fixture-card',
    paidAmount: '1000', paidCurrency: 'PHP', saleAmount: '250', saleCurrency: 'CNY',
    paidConfirmed: true, receiptConfirmed: true, costConfirmed: true, costBasis: 'standard',
    costSettings: { version: 1, cardPercent: '0.008', cardPerPaymentUsd: '0.3' },
    issueFeeSnapshot: { applied: true, amountUsd: '0.5' },
    refunds: [], bankReturns: [],
    ...fields
  });
  const quote = {
    source: '隔离核对凭据 FX-01',
    at: '2026-11-03T09:00', expiresAt: '2026-11-03T18:00',
    rates: { MYR: '1.6', USD: '7.2', PHP: '0.125', CLP: '0.008', IDR: '0.0004' }
  };
  const freeze = (order, snapshotInput = quote) => ({
    ...order, fxSnapshot: createOrderSnapshot(snapshotInput, order, demoClock)
  });
  const missing = order('QA-NO-FX', {
    paidAmount: '5000', paidCurrency: 'CLP',
    // Old flat rate values are insufficient evidence for accounting.
    rates: { CLP: '0.008' }
  });
  const bank = freeze(order('QA-BANK', {
    refunds: [
      { id: 'qa-r1', amount: '50', currency: 'CNY' },
      { id: 'qa-r2', amount: '20', currency: 'CNY' }
    ],
    bankReturns: [{ id: 'qa-b1', amount: '200', currency: 'PHP', cardId: 'fixture-card' }]
  }));
  const appleOrder = (id, refundId) => freeze(order(id, {
    product: 'Claude Pro', payment: '苹果内购', appleIdId: 'fixture-wallet',
    paidCurrency: 'USD', paidAmount: '20', saleAmount: '150', saleCurrency: 'MYR',
    costSettings: { version: 2, appleDiscount: '0.8' },
    emailCostAmount: '15', emailCostCurrency: 'CNY',
    refunds: [{ id: refundId, amount: '60', currency: 'MYR' }]
  }));
  const pending = appleOrder('QA-APPLE-PENDING', 'qa-a1');
  const received = appleOrder('QA-APPLE-RECEIVED', 'qa-a2');
  const idr = freeze(order('QA-IDR', {
    paidAmount: '200000', paidCurrency: 'IDR', saleAmount: '20000', saleCurrency: 'CLP',
    costBasis: 'actual', actualCostAmount: '100000', actualCostCurrency: 'IDR',
    costSettings: { version: 3 }
  }), { ...quote, source: '隔离核对凭据 FX-02', rates: { ...quote.rates, MYR: '2' } });
  return {
    commerce: { orders: [missing, bank, pending, received, idr] },
    appleBalance: {
      allocations: [pending, received].map((row) => ({
        orderId: row.id, appleIdId: row.appleIdId, amount: '20',
        returned: row.id === received.id ? '7' : '0'
      })),
      refunds: [pending, received].map((row) => ({
        id: row.refunds[0].id, orderId: row.id, appleIdId: row.appleIdId, amount: '7',
        status: row.id === received.id ? 'received' : 'pending'
      })),
      movements: [
        ...[pending, received].map((row) => ({
          id: 'charge-' + row.id, orderId: row.id, appleIdId: row.appleIdId,
          amount: '-20', kind: 'order-charge'
        })),
        { id: 'qa-apple-posted', orderId: received.id, appleIdId: received.appleIdId,
          refundId: 'qa-a2', amount: '7', kind: 'apple-refund' }
      ]
    }
  };
}
