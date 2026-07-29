import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ActivationStatusService } from '../activations/public-api';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2ManualRenewalService } from './id-business-v2-manual-renewal.service';

const activationId = '11111111-1111-4111-8111-111111111111';
const sourceOrderId = '22222222-2222-4222-8222-222222222222';
const targetOrderId = '33333333-3333-4333-8333-333333333333';
const accountId = '44444444-4444-4444-8444-444444444444';
const customerId = '55555555-5555-4555-8555-555555555555';
const serviceOptionId = '66666666-6666-4666-8666-666666666666';
const countryOptionId = '77777777-7777-4777-8777-777777777777';
const categoryOptionId = '88888888-8888-4888-8888-888888888888';
const settlementPlatformOptionId = '99999999-9999-4999-8999-999999999999';
const ledgerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const resultActivationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const now = new Date('2026-07-26T12:00:00.000Z');
const sourceOpenedAt = new Date('2026-06-30T12:00:00.000Z');
const sourceDueAt = new Date('2026-07-30T12:00:00.000Z');
const nextOpenedAt = new Date('2026-07-30T12:00:00.000Z');
const nextDueAt = new Date('2026-08-30T12:00:00.000Z');
const operator = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.renewal_task.update', 'apple.order.create']
};

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function makeDto(overrides: Record<string, unknown> = {}) {
  return {
    serviceOptionId,
    settlementPlatformOptionId,
    platformOrderNo: 'RENEW-PLATFORM-1001',
    receivedAmount: '100',
    balanceAmount: '20',
    openedAt: nextOpenedAt.toISOString(),
    dueAt: nextDueAt.toISOString(),
    idempotencyKey: 'manual-renewal-request-1001',
    remark: '客户已确认续费',
    ...overrides
  };
}

function makeSourceActivation(overrides: Record<string, unknown> = {}) {
  return {
    id: activationId,
    orderId: sourceOrderId,
    customerId,
    accountId,
    serviceOptionId,
    openedAt: sourceOpenedAt,
    dueAt: sourceDueAt,
    status: 'active',
    order: {
      id: sourceOrderId,
      orderNo: 'V220260630SOURCE001',
      status: 'completed',
      deletedAt: null,
      websiteAccountEncrypted: 'v1:encrypted-website',
      websiteAccountHash: 'website-account-hash',
      websiteAccountMasked: 'cu***@example.com'
    },
    account: {
      id: accountId,
      appleIdMasked: 'us***@example.com',
      countryOptionId,
      recordStatus: 'active',
      deletedAt: null,
      countryOption: {
        id: countryOptionId,
        code: 'us',
        name: '美国'
      },
      statusOption: {
        code: 'normal',
        status: 'active',
        deletedAt: null
      }
    },
    ...overrides
  };
}

describe('IdBusinessV2ManualRenewalService', () => {
  const tx = {
    $queryRaw: vi.fn(),
    idBusinessV2Order: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn()
    },
    idBusinessV2Activation: {
      findFirst: vi.fn(),
      create: vi.fn()
    },
    idBusinessV2Option: {
      findFirst: vi.fn()
    },
    idBusinessV2AccountLock: {
      findFirst: vi.fn()
    },
    idBusinessV2BalanceLedger: {
      create: vi.fn()
    },
    idBusinessV2Account: {
      update: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    }
  };
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2Order: {
      findUnique: vi.fn()
    },
    idBusinessV2Option: {
      findMany: vi.fn()
    }
  };
  const orderEntryService = {
    createManualRenewalOrderInTransaction: vi.fn()
  };
  const ordersService = {
    get: vi.fn()
  };
  const service = new IdBusinessV2ManualRenewalService(
    prisma as never,
    new IdBusinessV2ActivationStatusService(),
    new IdBusinessV2BalanceCalculatorService(),
    orderEntryService as never,
    ordersService as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    tx.idBusinessV2Order.findUnique.mockResolvedValue(null);
    tx.$queryRaw.mockResolvedValueOnce([{ id: activationId }]).mockResolvedValueOnce([
      {
        id: accountId,
        currentBalance: decimal('30'),
        balanceCostAmount: decimal('90'),
        purchaseCost: decimal('15')
      }
    ]);
    tx.idBusinessV2Activation.findFirst.mockResolvedValue(makeSourceActivation());
    tx.idBusinessV2Option.findFirst.mockResolvedValue({
      id: serviceOptionId,
      countryOption: {
        id: countryOptionId,
        code: 'us-country',
        name: '美国'
      }
    });
    tx.idBusinessV2AccountLock.findFirst.mockResolvedValue(null);
    tx.idBusinessV2Order.findFirst.mockResolvedValue(null);
    orderEntryService.createManualRenewalOrderInTransaction.mockResolvedValue({
      order: {
        id: targetOrderId,
        orderNo: 'V220260726RENEW001'
      },
      platformFeeAmount: decimal('3')
    });
    tx.idBusinessV2BalanceLedger.create.mockImplementation(async ({ data }) => ({
      id: ledgerId,
      ...data,
      createdAt: now
    }));
    tx.idBusinessV2Activation.create.mockImplementation(async ({ data }) => ({
      id: resultActivationId,
      ...data,
      createdAt: now
    }));
    ordersService.get.mockResolvedValue({
      id: targetOrderId,
      orderNo: 'V220260726RENEW001',
      status: 'completed',
      receivedAmount: '100',
      platformFeeAmount: '3',
      balanceAmount: '20',
      balanceCostAmount: '60',
      profitAmount: '37'
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('atomically creates the renewal order, deducts balance and creates an activation', async () => {
    const result = await service.create(activationId, makeDto(), operator);

    expect(orderEntryService.createManualRenewalOrderInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        customerId,
        serviceOptionId,
        accountId,
        websiteAccountEncrypted: 'v1:encrypted-website',
        websiteAccountHash: 'website-account-hash',
        websiteAccountMasked: 'cu***@example.com',
        receivedAmount: decimal('100'),
        balanceAmount: decimal('20'),
        openedAt: nextOpenedAt,
        dueAt: nextDueAt
      }),
      operator
    );
    expect(tx.idBusinessV2BalanceLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: targetOrderId,
        accountId,
        entryType: 'order_consumption',
        direction: 'debit',
        balanceBefore: decimal('30'),
        balanceAfter: decimal('10'),
        costBefore: decimal('90'),
        costAfter: decimal('30'),
        costAmount: decimal('60')
      })
    });
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith({
      where: {
        id: accountId
      },
      data: {
        currentBalance: decimal('10'),
        balanceCostAmount: decimal('30'),
        updatedByUserId: operator.id
      }
    });
    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith({
      where: {
        id: targetOrderId
      },
      data: expect.objectContaining({
        balanceCostAmount: decimal('60'),
        profitAmount: decimal('37'),
        status: 'completed'
      })
    });
    expect(tx.idBusinessV2Activation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: targetOrderId,
        renewedFromActivationId: activationId,
        customerId,
        accountId,
        serviceOptionId,
        autoRenewalStatus: 'unknown'
      })
    });
    expect(result).toMatchObject({
      balance: {
        before: '30',
        consumed: '20',
        after: '10',
        consumedCost: '60'
      },
      profitAmount: '37',
      idempotentReplay: false,
      executionBoundary: {
        manualAccountingCompleted: true,
        systemBalanceConsumed: true,
        activationCreated: true,
        externalSubscriptionActionPerformed: false,
        nextStep: 'completed'
      }
    });
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain('v1:encrypted-website');
    expect(JSON.stringify(result)).not.toContain('website-account-hash');
  });

  it('replays a completed request without creating another order or deducting balance again', async () => {
    tx.idBusinessV2Order.findUnique.mockResolvedValue({
      id: targetOrderId,
      customerId,
      serviceOptionId,
      accountId,
      settlementPlatformOptionId,
      platformOrderNo: 'RENEW-PLATFORM-1001',
      receivedAmount: decimal('100'),
      platformFeeAmount: decimal('3'),
      balanceAmount: decimal('20'),
      balanceCostAmount: decimal('60'),
      profitAmount: decimal('37'),
      status: 'completed',
      openedAt: nextOpenedAt,
      dueAt: nextDueAt,
      remark: '客户已确认续费',
      deletedAt: null,
      activation: {
        id: resultActivationId,
        orderId: targetOrderId,
        customerId,
        accountId,
        serviceOptionId,
        openedAt: nextOpenedAt,
        dueAt: nextDueAt,
        status: 'active',
        createdAt: now
      },
      balanceLedger: [
        {
          id: ledgerId,
          orderId: targetOrderId,
          accountId,
          entryType: 'order_consumption',
          direction: 'debit',
          balanceAmount: decimal('20'),
          costAmount: decimal('60'),
          balanceBefore: decimal('30'),
          balanceAfter: decimal('10'),
          costBefore: decimal('90'),
          costAfter: decimal('30'),
          averageCostBefore: decimal('3'),
          averageCostAfter: decimal('3'),
          createdAt: now
        }
      ]
    });

    const result = await service.create(activationId, makeDto(), operator);

    expect(result.idempotentReplay).toBe(true);
    expect(result.balance.after).toBe('10');
    expect(orderEntryService.createManualRenewalOrderInTransaction).not.toHaveBeenCalled();
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Activation.create).not.toHaveBeenCalled();
  });

  it('rejects insufficient balance before creating any order or ledger', async () => {
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: activationId }])
      .mockResolvedValueOnce([
        {
          id: accountId,
          currentBalance: decimal('10'),
          balanceCostAmount: decimal('30'),
          purchaseCost: decimal('15')
        }
      ]);

    await expect(service.create(activationId, makeDto())).rejects.toThrow(
      '扣减余额不能超过当前余额'
    );
    expect(orderEntryService.createManualRenewalOrderInTransaction).not.toHaveBeenCalled();
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
  });

  it('rejects a service from another country and an overlapping renewal period', async () => {
    tx.idBusinessV2Option.findFirst.mockResolvedValueOnce({
      id: serviceOptionId,
      countryOption: {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        code: 'ca-country',
        name: '加拿大'
      }
    });
    await expect(service.create(activationId, makeDto())).rejects.toThrow(
      '续费业务所属国家与当前 ID 国家不一致'
    );

    tx.$queryRaw.mockReset().mockResolvedValueOnce([{ id: activationId }]);
    tx.idBusinessV2Option.findFirst.mockResolvedValueOnce({
      id: serviceOptionId,
      countryOption: {
        id: countryOptionId,
        code: 'us-country',
        name: '美国'
      }
    });
    await expect(
      service.create(
        activationId,
        makeDto({ openedAt: new Date(sourceDueAt.getTime() - 1).toISOString() })
      )
    ).rejects.toThrow('续费开始时间不能早于原到期时间');
  });

  it('rejects malformed and non-actionable source records before financial writes', async () => {
    await expect(service.create('not-a-uuid', makeDto())).rejects.toBeInstanceOf(
      BadRequestException
    );

    tx.idBusinessV2Activation.findFirst.mockResolvedValueOnce(null);
    await expect(service.create(activationId, makeDto())).rejects.toBeInstanceOf(NotFoundException);
    expect(orderEntryService.createManualRenewalOrderInTransaction).not.toHaveBeenCalled();
  });

  it('rejects another active order lock', async () => {
    tx.idBusinessV2AccountLock.findFirst.mockResolvedValueOnce({ id: 'active-lock' });
    await expect(service.create(activationId, makeDto())).rejects.toThrow('该 ID 已被其他订单占用');
  });

  it('rejects the same renewal period even when a new idempotency key is used', async () => {
    tx.idBusinessV2Order.findFirst.mockResolvedValueOnce({
      id: targetOrderId,
      orderNo: 'V220260726RENEW001'
    });

    await expect(
      service.create(
        activationId,
        makeDto({
          idempotencyKey: 'manual-renewal-request-1002'
        }),
        operator
      )
    ).rejects.toThrow('相同续费周期的订单 V220260726RENEW001 已完成，请勿重复扣款');
    expect(orderEntryService.createManualRenewalOrderInTransaction).not.toHaveBeenCalled();
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
  });

  it('returns active services and settlement platforms as manual renewal options', async () => {
    prisma.idBusinessV2Option.findMany
      .mockResolvedValueOnce([
        {
          id: settlementPlatformOptionId,
          code: 'wechat',
          name: '微信',
          fixedFee: decimal('1.5'),
          percentageFee: decimal('2.25')
        }
      ])
      .mockResolvedValueOnce([
        {
          id: serviceOptionId,
          code: 'plus',
          name: 'Plus',
          businessAmount: decimal('20'),
          parent: {
            id: categoryOptionId,
            name: 'AI订阅'
          },
          countryOption: {
            id: countryOptionId,
            code: 'US',
            name: '美国',
            currencyCode: 'USD'
          }
        }
      ]);

    await expect(service.listOptions()).resolves.toEqual({
      settlementPlatforms: [
        {
          id: settlementPlatformOptionId,
          code: 'wechat',
          name: '微信',
          fixedFee: '1.5',
          percentageFee: '2.25'
        }
      ],
      services: [
        {
          id: serviceOptionId,
          code: 'plus',
          name: 'Plus',
          category: {
            id: categoryOptionId,
            name: 'AI订阅'
          },
          country: {
            id: countryOptionId,
            code: 'US',
            name: '美国',
            currencyCode: 'USD'
          },
          businessAmount: '20',
          currencyCode: 'USD'
        }
      ]
    });
  });

  it('maps a concurrent unique collision without matching idempotency evidence to conflict', async () => {
    prisma.$transaction.mockRejectedValue({ code: 'P2002' });
    prisma.idBusinessV2Order.findUnique.mockResolvedValue(null);

    await expect(service.create(activationId, makeDto())).rejects.toThrow(
      new ConflictException('平台订单号已存在或续费刚被其他请求处理，请刷新后核对')
    );
  });
});
