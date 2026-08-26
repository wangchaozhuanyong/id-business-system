import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { Amount4, Rate8 } from '../runtime/public-api';
import { IdBusinessV2OrderBalanceReturnService } from './id-business-v2-order-balance-return.service';

const orderId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const createdAt = new Date('2026-08-26T12:00:00.000Z');

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: orderId,
    orderNo: 'V220260826UPGRADE001',
    customerId: '33333333-3333-4333-8333-333333333333',
    serviceOptionId: '44444444-4444-4444-8444-444444444444',
    accountId,
    settlementPlatformOptionId: null,
    platformOrderNo: null,
    websiteAccountEncrypted: null,
    websiteAccountHash: null,
    websiteAccountMasked: null,
    websiteAccountSearchTokens: [],
    receivedAmount: Amount4.from('100'),
    receivedOriginalAmount: Amount4.from('100'),
    receivedCurrency: 'CNY',
    receivedFxRateToCny: Rate8.one(),
    receivedFxSnapshotId: null,
    receivedFinanceAccountId: null,
    receivedAt: createdAt,
    platformFeeAmount: Amount4.zero(),
    accountCostAmount: Amount4.zero(),
    appliedAccountCostAmount: Amount4.zero(),
    accountSource: 'inventory',
    sourceSoldOrderId: null,
    accountDisposition: 'retained',
    balanceAmount: Amount4.from('90'),
    balanceCurrencyCode: 'USD',
    balanceCostAmount: Amount4.from('90'),
    transferredBalanceCostAmount: Amount4.zero(),
    appliedBalanceCostAmount: Amount4.from('90'),
    refundCostAmount: null,
    profitAmount: Amount4.from('10'),
    status: 'completed',
    statusChangedAt: createdAt,
    openedAt: createdAt,
    dueAt: null,
    idempotencyKey: 'order-entry-key',
    remark: null,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    customer: { id: 'customer-1', name: '测试客户' },
    serviceOption: {
      id: 'service-1',
      code: 'plus',
      name: 'Plus',
      parent: null
    },
    account: {
      id: accountId,
      appleIdEncrypted: 'encrypted',
      appleIdMasked: 'us***@example.com',
      countryOption: {
        id: 'country-us',
        code: 'US',
        name: '美国',
        currencyCode: 'USD'
      }
    },
    sourceSoldOrder: null,
    settlementPlatform: null,
    createdBy: null,
    locks: [],
    balanceReturns: [],
    ...overrides
  };
}

describe('IdBusinessV2OrderBalanceReturnService', () => {
  const repository = {
    findOrder: vi.fn()
  };
  const service = new IdBusinessV2OrderBalanceReturnService(
    new IdBusinessV2BalanceCalculatorService(),
    {} as never,
    {} as never,
    repository as never,
    {} as never
  );

  it('keeps sales revenue and changes profit from 10 to 45 when 35 of cost is recovered', async () => {
    repository.findOrder.mockResolvedValueOnce(makeOrder());

    const result = await service.preview(orderId, { returnedBalanceAmount: '35' });

    expect(result).toMatchObject({
      currencyCode: 'USD',
      returnedBalanceAmount: '35',
      restoredBalanceCostAmount: '35',
      restoredAppliedBalanceCostAmount: '35',
      originalProfitAmount: '10',
      adjustedProfitAmount: '45',
      profitIncreaseAmount: '35',
      costReturnsToCompany: true,
      revenueChanged: false
    });
  });

  it('uses the original ID currency snapshot for a Japanese ID', async () => {
    repository.findOrder.mockResolvedValueOnce(
      makeOrder({
        balanceCurrencyCode: 'JPY',
        account: {
          ...makeOrder().account,
          countryOption: {
            id: 'country-jp',
            code: 'JP',
            name: '日本',
            currencyCode: 'JPY'
          }
        }
      })
    );

    const result = await service.preview(orderId, { returnedBalanceAmount: '35' });

    expect(result.currencyCode).toBe('JPY');
  });

  it('does not inflate company profit when the returned balance belongs to a customer-owned ID', async () => {
    repository.findOrder.mockResolvedValueOnce(
      makeOrder({
        accountSource: 'customer_owned',
        appliedBalanceCostAmount: Amount4.zero(),
        profitAmount: Amount4.from('100')
      })
    );

    const result = await service.preview(orderId, { returnedBalanceAmount: '35' });

    expect(result.restoredBalanceCostAmount).toBe('35');
    expect(result.restoredAppliedBalanceCostAmount).toBe('0');
    expect(result.adjustedProfitAmount).toBe('100');
    expect(result.costReturnsToCompany).toBe(false);
  });
});
