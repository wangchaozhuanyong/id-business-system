import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ActivationStatusService } from '../activations/public-api';
import { V2CommandTransactionManager } from '../runtime/public-api';
import { IdBusinessV2RenewalWarningService } from './id-business-v2-renewal-warning.service';
import { IdBusinessV2RenewalsService } from './id-business-v2-renewals.service';
import { IdBusinessV2RenewalsRepository } from './persistence/id-business-v2-renewals.repository';

const customerId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const serviceOptionId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-07-26T12:00:00.000Z');

function makeRenewal() {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    orderId: '55555555-5555-4555-8555-555555555555',
    customerId,
    accountId,
    serviceOptionId,
    openedAt: new Date('2026-06-26T12:00:00.000Z'),
    dueAt: new Date('2026-07-27T10:00:00.000Z'),
    status: 'active',
    statusChangedAt: now,
    remark: null,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
    order: {
      id: '55555555-5555-4555-8555-555555555555',
      orderNo: 'V220260726TEST001',
      websiteAccountMasked: 'cu***@example.com'
    },
    customer: {
      id: customerId,
      name: '测试客户'
    },
    account: {
      id: accountId,
      appleIdMasked: 'us***@example.com',
      currentBalance: new Prisma.Decimal('18.5'),
      balanceCostAmount: new Prisma.Decimal('42.25'),
      recordStatus: 'active',
      countryOption: {
        id: '66666666-6666-4666-8666-666666666666',
        code: 'us',
        name: '美国'
      }
    },
    serviceOption: {
      id: serviceOptionId,
      code: 'chatgpt-plus',
      name: 'ChatGPT Plus',
      parent: {
        id: '77777777-7777-4777-8777-777777777777',
        name: 'AI 服务'
      }
    }
  };
}

describe('IdBusinessV2RenewalsService', () => {
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2Activation: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn()
    },
    idBusinessV2Customer: {
      findMany: vi.fn()
    },
    idBusinessV2Account: {
      findMany: vi.fn()
    },
    idBusinessV2Option: {
      findMany: vi.fn()
    },
    idBusinessV2RenewalWarningSetting: {
      findUnique: vi.fn()
    }
  };
  const statusService = new IdBusinessV2ActivationStatusService();
  const repository = new IdBusinessV2RenewalsRepository(prisma as never);
  const warningService = new IdBusinessV2RenewalWarningService(
    repository,
    new V2CommandTransactionManager(prisma as never)
  );
  const service = new IdBusinessV2RenewalsService(repository, statusService, warningService);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    prisma.idBusinessV2Activation.findMany.mockResolvedValue([makeRenewal()]);
    prisma.idBusinessV2Activation.count.mockResolvedValue(1);
    prisma.idBusinessV2Activation.findFirst.mockResolvedValue(null);
    prisma.idBusinessV2RenewalWarningSetting.findUnique.mockResolvedValue(null);
    prisma.idBusinessV2Customer.findMany.mockResolvedValue([{ id: customerId, name: '测试客户' }]);
    prisma.idBusinessV2Account.findMany.mockResolvedValue([
      { id: accountId, appleIdMasked: 'us***@example.com' }
    ]);
    prisma.idBusinessV2Option.findMany.mockResolvedValue([
      {
        id: serviceOptionId,
        code: 'chatgpt-plus',
        name: 'ChatGPT Plus',
        parent: null
      }
    ]);
    prisma.$transaction.mockImplementation(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations)
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns real masked renewal rows with the current Decimal balance', async () => {
    const result = await service.listWorkbench({});

    expect(result).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 20,
      evaluatedAt: now,
      items: [
        {
          orderNo: 'V220260726TEST001',
          customer: {
            name: '测试客户'
          },
          account: {
            appleIdMasked: 'us***@example.com',
            currentBalance: '18.5',
            balanceCostAmount: '42.25'
          },
          maskedWebsiteAccount: 'cu***@example.com',
          status: {
            code: 'due_within_23_hours',
            label: '23小时内到期'
          },
          warningState: 'upcoming',
          withinActionWindow: true
        }
      ],
      warningSummary: {
        warningDays: 3,
        upcomingCount: 1,
        expiredCount: 1,
        totalCount: 2
      }
    });
    expect(JSON.stringify(result)).not.toContain('Encrypted');
    expect(JSON.stringify(result)).not.toContain('Hash');
  });

  it('defaults to the configured warning window or expired and applies pagination and sorting', async () => {
    await service.listWorkbench({
      page: '2',
      pageSize: '10',
      sortBy: 'currentBalance',
      sortOrder: 'desc'
    });

    const call = prisma.idBusinessV2Activation.findMany.mock.calls[0]?.[0];
    expect(call.skip).toBe(10);
    expect(call.take).toBe(10);
    expect(call.orderBy).toEqual([{ account: { currentBalance: 'desc' } }, { id: 'asc' }]);
    expect(call.where.AND[1]).toEqual({
      renewedBy: {
        is: null
      },
      OR: [
        { status: 'expired' },
        {
          status: 'active',
          dueAt: {
            not: null,
            lte: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
          }
        }
      ]
    });
  });

  it('uses the shared non-overlapping status window with relation and date filters', async () => {
    await service.listWorkbench({
      customerId,
      accountId,
      serviceOptionId,
      dueStatus: 'due_within_23_hours',
      dueFrom: '2026-07-26',
      dueTo: '2026-07-27',
      keyword: '测试'
    });

    const call = prisma.idBusinessV2Activation.findMany.mock.calls[0]?.[0];
    expect(call.where.AND[0]).toEqual(
      expect.objectContaining({
        customerId,
        accountId,
        serviceOptionId,
        account: undefined
      })
    );
    expect(call.where.AND[1]).toEqual({
      AND: [
        {
          renewedBy: { is: null },
          status: 'active',
          dueAt: {
            gt: new Date(now.getTime() + 60 * 60 * 1000),
            lte: new Date(now.getTime() + 23 * 60 * 60 * 1000)
          }
        },
        {
          dueAt: {
            gte: new Date('2026-07-26T00:00:00.000Z'),
            lte: new Date('2026-07-27T23:59:59.999Z')
          }
        }
      ]
    });
    expect(call.where.AND[0].OR).toContainEqual({
      order: {
        is: {
          displaySnapshot: {
            is: {
              OR: [
                { customerName: { contains: '测试', mode: 'insensitive' } },
                { serviceName: { contains: '测试', mode: 'insensitive' } },
                { accountLabel: { contains: '测试', mode: 'insensitive' } }
              ]
            }
          }
        }
      }
    });
  });

  it('allows an arbitrary date range for viewing without widening the seven-day action window', async () => {
    prisma.idBusinessV2Activation.findMany.mockResolvedValueOnce([
      {
        ...makeRenewal(),
        dueAt: new Date('2026-08-05T12:00:00.000Z')
      }
    ]);

    const result = await service.listWorkbench({
      dueFrom: '2026-08-01',
      dueTo: '2026-08-10'
    });

    const call = prisma.idBusinessV2Activation.findMany.mock.calls[0]?.[0];
    expect(call.where.AND[1]).toEqual({
      AND: [
        {
          renewedBy: { is: null },
          OR: [
            { status: 'expired' },
            {
              status: 'active',
              dueAt: {
                not: null
              }
            }
          ]
        },
        {
          dueAt: {
            gte: new Date('2026-08-01T00:00:00.000Z'),
            lte: new Date('2026-08-10T23:59:59.999Z')
          }
        }
      ]
    });
    expect(result.items[0]).toMatchObject({
      status: {
        code: 'active',
        label: '正常'
      },
      warningState: null,
      withinActionWindow: false
    });
  });

  it('supports an upcoming-warning-only filter and rejects malformed flags', async () => {
    await service.listWorkbench({ warningOnly: 'true' });

    const call = prisma.idBusinessV2Activation.findMany.mock.calls[0]?.[0];
    expect(call.where.AND[1]).toEqual({
      renewedBy: { is: null },
      status: 'active',
      dueAt: {
        gt: now,
        lte: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
      }
    });
    await expect(service.listWorkbench({ warningOnly: 'yes' })).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('returns only masked filter options linked to actionable renewals', async () => {
    const result = await service.listFilterOptions();

    expect(result).toEqual({
      customers: [{ id: customerId, name: '测试客户' }],
      accounts: [{ id: accountId, appleIdMasked: 'us***@example.com' }],
      services: [
        {
          id: serviceOptionId,
          code: 'chatgpt-plus',
          name: 'ChatGPT Plus',
          parent: null
        }
      ]
    });
    const optionCall = prisma.idBusinessV2Option.findMany.mock.calls[0]?.[0];
    expect(optionCall.where).toEqual(
      expect.objectContaining({
        type: 'service',
        activationsByService: {
          some: expect.objectContaining({
            renewedBy: { is: null },
            OR: expect.any(Array)
          })
        }
      })
    );
    expect(JSON.stringify(result)).not.toContain('appleIdEncrypted');
  });

  it('rejects unsupported statuses, malformed ids and invalid date ranges before querying', async () => {
    await expect(service.listWorkbench({ dueStatus: 'active' })).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(service.listWorkbench({ accountId: 'not-a-uuid' })).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(
      service.listWorkbench({ dueFrom: '2026-07-28', dueTo: '2026-07-27' })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
