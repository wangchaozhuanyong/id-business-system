import { demoOrders } from './reconcile-demo.mjs';
import { migrationInputSchema } from './migration-input.mjs';

export function migrationDemo() {
  const demo = demoOrders();
  const bank = demo.commerce.orders[1];
  const apple = demo.commerce.orders[3];
  const toRecord = (order, overrides = {}) => ({
    id: order.id, orderNo: order.orderNo, plan: 'plus', businessType: 'renewal',
    paymentMethod: order.payment === '银行卡' ? 'bank_card' : 'apple_in_app',
    cardId: order.cardId, appleAccountId: order.appleIdId,
    paidAmount: order.paidAmount, paidCurrency: order.paidCurrency,
    saleAmount: order.saleAmount, saleCurrency: order.saleCurrency,
    paidConfirmed: true, receiptConfirmed: true, costConfirmed: true,
    feeRuleVersion: order.costSettings.version,
    costBasis: 'standard', openedAt: '2026-11-03T04:00:00.000Z',
    dueAt: '2026-12-03T04:00:00.000Z', cancelledAt: null,
    customerRefundTotal: '70',
    ...overrides
  });
  const evidence = {
    orderId: bank.id,
    feeRule: { version: 1, paymentFeeRate: '0.008', fixedFeeUsd: '0.3', cardOpeningFeeUsd: '0.5' },
    emailCost: { amount: '0', currency: 'CNY' },
    issueFeeSnapshot: { ...bank.issueFeeSnapshot, cardId: bank.cardId },
    customerRefunds: bank.refunds.map((refund) => ({ ...refund, orderId: bank.id })),
    bankReturns: bank.bankReturns.map((refund) => ({ ...refund, orderId: bank.id })),
    fxSnapshot: bank.fxSnapshot
  };
  const appleId = apple.appleIdId;
  return {
    schema: migrationInputSchema,
    orders: [
      { kind: 'legacy-id-business-order', order: {
        id: bank.id, orderNo: 'QA-LEGACY-ORDER', receivedOriginalAmount: '50.00',
        receivedCurrency: 'MYR', receivedFxRateToCny: '1.6'
      } },
      { kind: 'gpt-subscription-v2', order: toRecord(bank), evidence },
      { kind: 'gpt-subscription-v2', order: toRecord(bank, {
        id: 'QA-UNKNOWN', orderNo: 'QA-UNKNOWN', customerRefundTotal: '0',
        feeRuleVersion: null, effectiveCostCny: '100', originalProfitCny: '150'
      }), evidence: { orderId: 'QA-UNKNOWN', rates: { USD: '7.2' } } },
      { kind: 'gpt-subscription-v2', order: toRecord(apple, { customerRefundTotal: '60' }), evidence: {
        orderId: apple.id, emailCost: { amount: '15', currency: 'CNY' }, fxSnapshot: apple.fxSnapshot,
        apple: {
          allocation: demo.appleBalance.allocations.find((row) => row.orderId === apple.id),
          refunds: [{
            id: 'qa-a2', orderId: apple.id, appleAccountId: appleId,
            customerRefundAmount: '60', customerRefundCurrency: 'MYR', expectedAppleReturnUsd: '7',
            returnStatus: 'received', receivedLedgerEntryId: 'qa-apple-posted',
            customerRefundedAt: '2026-11-04T04:00:00.000Z', receivedAt: '2026-11-05T04:00:00.000Z',
            reversalLedgerEntryId: null, reversedAt: null
          }],
          walletEntries: [
            { appleAccountId: appleId, entry: {
              id: 'charge-QA-APPLE-RECEIVED', subscriptionOrderId: apple.id, amountUsd: '20',
              entryType: 'subscription_apple_charge', direction: 'debit'
            } },
            { appleAccountId: appleId, entry: {
              id: 'qa-apple-posted', subscriptionOrderId: apple.id, amountUsd: '7',
              entryType: 'subscription_apple_return', direction: 'credit'
            } }
          ]
        }
      } }
    ]
  };
}
