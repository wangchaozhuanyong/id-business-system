import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { Amount4, Rate8 } from '../runtime/public-api';
import {
  appendUpgradeBalanceReturnActivationRemark,
  removeUpgradeBalanceReturnActivationRemark
} from './id-business-v2-order-balance-return-support';
import { IdBusinessV2OrderBalanceReturnService } from './id-business-v2-order-balance-return.service';

const orderId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const balanceReturnId = '55555555-5555-4555-8555-555555555555';
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

  it('ends the original activation when an upgrade balance return is recorded', async () => {
    const activation = {
      id: '66666666-6666-4666-8666-666666666666',
      orderId,
      renewedFromActivationId: null,
      customerId: '33333333-3333-4333-8333-333333333333',
      accountId,
      serviceOptionId: '44444444-4444-4444-8444-444444444444',
      openedAt: createdAt,
      dueAt: new Date('2026-09-16T12:00:00.000Z'),
      status: 'active',
      statusChangedAt: createdAt,
      autoRenewalStatus: 'unknown',
      autoRenewalChangedAt: null,
      remark: '原开通备注',
      createdByUserId: null,
      updatedByUserId: null,
      createdAt,
      updatedAt: createdAt
    };
    const balanceReturn = {
      id: balanceReturnId,
      orderId,
      accountId,
      activeKey: orderId,
      status: 'active',
      currencyCode: 'USD',
      returnedBalanceAmount: Amount4.from('35'),
      restoredBalanceCostAmount: Amount4.from('35'),
      restoredAppliedBalanceCostAmount: Amount4.from('35'),
      originalProfitAmount: Amount4.from('10'),
      adjustedProfitAmount: Amount4.from('45'),
      balanceLedgerEntryId: 'ledger-return',
      financeJournalId: 'journal-return',
      idempotencyKey: `upgrade_return:${orderId}:record-upgrade-return-1`,
      reason: 'Plus 升级 Pro',
      createdByUserId: null,
      createdAt,
      reversalBalanceLedgerEntryId: null,
      reversalFinanceJournalId: null,
      reversalIdempotencyKey: null,
      reversalReason: null,
      reversedByUserId: null,
      reversedAt: null
    };
    const commandRepository = {
      findBalanceReturnReplay: vi.fn().mockResolvedValue(null),
      lockOrder: vi.fn().mockResolvedValue(makeOrder()),
      findActiveBalanceReturn: vi.fn().mockResolvedValue(null),
      findLedgerByOrderAndType: vi.fn((_tx: unknown, _orderId: string, entryType: string) =>
        entryType === 'order_consumption'
          ? {
              id: 'ledger-consumption',
              accountId,
              direction: 'debit',
              reversalOfEntryId: null,
              balanceAmount: Amount4.from('90'),
              costAmount: Amount4.from('90')
            }
          : null
      ),
      lockAccount: vi.fn().mockResolvedValue({
        id: accountId,
        currentBalance: Amount4.zero(),
        balanceCostAmount: Amount4.zero(),
        currencyCode: 'USD',
        ownershipTransferredAt: null,
        lossReportedAt: null
      }),
      findActivationByOrder: vi.fn().mockResolvedValue(activation),
      createBalanceLedger: vi.fn().mockResolvedValue({ id: 'ledger-return' }),
      updateAccount: vi.fn().mockResolvedValue({}),
      updateOrder: vi.fn().mockResolvedValue({}),
      createBalanceReturn: vi.fn().mockResolvedValue(balanceReturn),
      updateActivation: vi.fn().mockResolvedValue({}),
      appendAudit: vi.fn().mockResolvedValue({})
    };
    const financePostingService = {
      post: vi.fn().mockResolvedValue({ id: 'journal-return' })
    };
    const ordersService = { get: vi.fn().mockResolvedValue(makeOrder()) };
    const transactionManager = {
      execute: vi.fn(async (command: (tx: unknown, context: { businessTime: Date }) => unknown) =>
        command({}, { businessTime: createdAt })
      )
    };
    const commandService = new IdBusinessV2OrderBalanceReturnService(
      new IdBusinessV2BalanceCalculatorService(),
      financePostingService as never,
      ordersService as never,
      commandRepository as never,
      transactionManager as never
    );

    await commandService.record(orderId, {
      returnedBalanceAmount: '35',
      reason: 'Plus 升级 Pro',
      idempotencyKey: 'record-upgrade-return-1'
    });

    expect(commandRepository.updateActivation).toHaveBeenCalledWith(
      expect.anything(),
      orderId,
      expect.objectContaining({
        status: 'cancelled',
        statusChangedAt: createdAt,
        remark: expect.stringContaining(`退币记录 ${balanceReturnId}`)
      })
    );
    expect(commandRepository.appendAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'id_business_v2.activation.cancel_by_upgrade_balance_return',
        objectId: activation.id
      })
    );
  });

  it('restores the original activation when the return is reversed without a later upgrade', async () => {
    const activationRemark = appendUpgradeBalanceReturnActivationRemark(
      '原开通备注',
      balanceReturnId,
      'Plus 升级 Pro'
    );
    const activation = {
      id: '66666666-6666-4666-8666-666666666666',
      orderId,
      accountId,
      serviceOptionId: '44444444-4444-4444-8444-444444444444',
      status: 'cancelled',
      statusChangedAt: createdAt,
      remark: activationRemark
    };
    const balanceReturn = {
      id: balanceReturnId,
      orderId,
      accountId,
      activeKey: orderId,
      status: 'active',
      currencyCode: 'USD',
      returnedBalanceAmount: Amount4.from('35'),
      restoredBalanceCostAmount: Amount4.from('35'),
      restoredAppliedBalanceCostAmount: Amount4.from('35'),
      originalProfitAmount: Amount4.from('10'),
      adjustedProfitAmount: Amount4.from('45'),
      balanceLedgerEntryId: 'ledger-return',
      financeJournalId: 'journal-return',
      idempotencyKey: `upgrade_return:${orderId}:record-upgrade-return-1`,
      reason: 'Plus 升级 Pro',
      createdByUserId: null,
      createdAt,
      reversalBalanceLedgerEntryId: null,
      reversalFinanceJournalId: null,
      reversalIdempotencyKey: null,
      reversalReason: null,
      reversedByUserId: null,
      reversedAt: null
    };
    const reversedBalanceReturn = {
      ...balanceReturn,
      activeKey: null,
      status: 'reversed',
      reversalBalanceLedgerEntryId: 'ledger-reversal',
      reversalFinanceJournalId: 'journal-reversal',
      reversalIdempotencyKey: `upgrade_return_reverse:${orderId}:reverse-upgrade-return-1`,
      reversalReason: '登记有误',
      reversedAt: createdAt
    };
    const commandRepository = {
      findBalanceReturnReversalReplay: vi.fn().mockResolvedValue(null),
      lockOrder: vi.fn().mockResolvedValue(
        makeOrder({
          balanceCostAmount: Amount4.from('55'),
          appliedBalanceCostAmount: Amount4.from('55'),
          profitAmount: Amount4.from('45')
        })
      ),
      findActiveBalanceReturn: vi.fn().mockResolvedValue(balanceReturn),
      findActivationByOrder: vi.fn().mockResolvedValue(activation),
      findServiceCategory: vi.fn().mockResolvedValue({ parentId: 'category-chatgpt' }),
      findActiveCategoryActivationForAccount: vi.fn().mockResolvedValue(null),
      findActiveCategoryOrderLockForAccount: vi.fn().mockResolvedValue(null),
      lockAccount: vi.fn().mockResolvedValue({
        id: accountId,
        currentBalance: Amount4.from('35'),
        balanceCostAmount: Amount4.from('35'),
        lossReportedAt: null
      }),
      createBalanceLedger: vi.fn().mockResolvedValue({ id: 'ledger-reversal' }),
      updateAccount: vi.fn().mockResolvedValue({}),
      updateOrder: vi.fn().mockResolvedValue({}),
      reverseBalanceReturn: vi.fn().mockResolvedValue(reversedBalanceReturn),
      updateActivation: vi.fn().mockResolvedValue({}),
      appendAudit: vi.fn().mockResolvedValue({})
    };
    const financePostingService = {
      reverse: vi.fn().mockResolvedValue({ id: 'journal-reversal' })
    };
    const ordersService = { get: vi.fn().mockResolvedValue(makeOrder()) };
    const transactionManager = {
      execute: vi.fn(async (command: (tx: unknown, context: { businessTime: Date }) => unknown) =>
        command({}, { businessTime: createdAt })
      )
    };
    const commandService = new IdBusinessV2OrderBalanceReturnService(
      new IdBusinessV2BalanceCalculatorService(),
      financePostingService as never,
      ordersService as never,
      commandRepository as never,
      transactionManager as never
    );

    await commandService.reverse(orderId, {
      reason: '登记有误',
      idempotencyKey: 'reverse-upgrade-return-1'
    });

    expect(commandRepository.findActiveCategoryActivationForAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId,
        categoryOptionId: 'category-chatgpt',
        editingOrderId: orderId
      })
    );
    expect(commandRepository.findActiveCategoryOrderLockForAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId,
        categoryOptionId: 'category-chatgpt',
        excludedOrderId: orderId
      })
    );
    expect(commandRepository.updateActivation).toHaveBeenCalledWith(
      expect.anything(),
      orderId,
      expect.objectContaining({
        status: 'active',
        statusChangedAt: createdAt,
        remark: '原开通备注'
      })
    );
  });

  it('blocks reversal of a legacy return when the ID already has a later category activation', async () => {
    const balanceReturn = {
      id: balanceReturnId,
      orderId,
      accountId,
      activeKey: orderId,
      status: 'active',
      currencyCode: 'USD',
      returnedBalanceAmount: Amount4.from('35'),
      restoredBalanceCostAmount: Amount4.from('35'),
      restoredAppliedBalanceCostAmount: Amount4.from('35'),
      originalProfitAmount: Amount4.from('10'),
      adjustedProfitAmount: Amount4.from('45'),
      balanceLedgerEntryId: 'ledger-return',
      financeJournalId: 'journal-return',
      idempotencyKey: `upgrade_return:${orderId}:legacy-record`,
      reason: 'Plus 升级 Pro',
      createdByUserId: null,
      createdAt,
      reversalBalanceLedgerEntryId: null,
      reversalFinanceJournalId: null,
      reversalIdempotencyKey: null,
      reversalReason: null,
      reversedByUserId: null,
      reversedAt: null
    };
    const commandRepository = {
      findBalanceReturnReversalReplay: vi.fn().mockResolvedValue(null),
      lockOrder: vi.fn().mockResolvedValue(
        makeOrder({
          balanceCostAmount: Amount4.from('55'),
          appliedBalanceCostAmount: Amount4.from('55'),
          profitAmount: Amount4.from('45')
        })
      ),
      findActiveBalanceReturn: vi.fn().mockResolvedValue(balanceReturn),
      lockAccount: vi.fn().mockResolvedValue({
        id: accountId,
        currentBalance: Amount4.from('35'),
        balanceCostAmount: Amount4.from('35'),
        lossReportedAt: null
      }),
      findActivationByOrder: vi.fn().mockResolvedValue({
        id: 'legacy-activation',
        orderId,
        accountId,
        serviceOptionId: '44444444-4444-4444-8444-444444444444',
        status: 'active',
        statusChangedAt: createdAt,
        remark: '修复发布前的原开通记录'
      }),
      findServiceCategory: vi.fn().mockResolvedValue({ parentId: 'category-chatgpt' }),
      findActiveCategoryActivationForAccount: vi.fn().mockResolvedValue({ id: 'pro-activation' }),
      findActiveCategoryOrderLockForAccount: vi.fn().mockResolvedValue(null),
      createBalanceLedger: vi.fn()
    };
    const commandService = new IdBusinessV2OrderBalanceReturnService(
      new IdBusinessV2BalanceCalculatorService(),
      { reverse: vi.fn() } as never,
      { get: vi.fn() } as never,
      commandRepository as never,
      {
        execute: vi.fn(async (command: (tx: unknown, context: { businessTime: Date }) => unknown) =>
          command({}, { businessTime: createdAt })
        )
      } as never
    );

    await expect(
      commandService.reverse(orderId, {
        reason: '登记有误',
        idempotencyKey: 'reverse-legacy-upgrade-return'
      })
    ).rejects.toThrow('该 ID 已有后续同类业务订单或开通，不能撤销升级退币');
    expect(commandRepository.createBalanceLedger).not.toHaveBeenCalled();
  });
});

describe('upgrade balance return activation remark', () => {
  it('restores the exact prior remark when the matching return is reversed', () => {
    const appended = appendUpgradeBalanceReturnActivationRemark(
      '原开通备注',
      balanceReturnId,
      'Plus\n升级 Pro'
    );

    expect(appended).toContain('Plus 升级 Pro');
    expect(removeUpgradeBalanceReturnActivationRemark(appended, balanceReturnId)).toEqual({
      matched: true,
      remark: '原开通备注'
    });
  });

  it('does not remove a remark written by another return record', () => {
    const appended = appendUpgradeBalanceReturnActivationRemark(
      '原开通备注',
      balanceReturnId,
      'Plus 升级 Pro'
    );

    expect(
      removeUpgradeBalanceReturnActivationRemark(appended, '77777777-7777-4777-8777-777777777777')
    ).toEqual({ matched: false, remark: appended });
  });
});
