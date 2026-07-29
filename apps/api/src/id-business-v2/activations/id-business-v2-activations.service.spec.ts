import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ActivationStatusService } from './id-business-v2-activation-status.service';
import { IdBusinessV2ActivationsService } from './id-business-v2-activations.service';

const activationId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const customerId = '33333333-3333-4333-8333-333333333333';
const accountId = '44444444-4444-4444-8444-444444444444';
const serviceId = '55555555-5555-4555-8555-555555555555';
const openedAt = new Date('2026-07-26T12:00:00.000Z');
const dueAt = new Date('2026-08-26T12:00:00.000Z');

function makeActivation() {
  return {
    id: activationId,
    orderId,
    customerId,
    accountId,
    serviceOptionId: serviceId,
    openedAt,
    dueAt,
    status: 'active',
    statusChangedAt: openedAt,
    remark: '开通记录',
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: openedAt,
    updatedAt: openedAt,
    order: {
      id: orderId,
      orderNo: 'V220260726TEST001',
      status: 'completed',
      websiteAccountMasked: 'cu***@example.com',
      receivedAmount: new Prisma.Decimal('100'),
      profitAmount: new Prisma.Decimal('37')
    },
    customer: {
      id: customerId,
      name: '测试客户'
    },
    account: {
      id: accountId,
      appleIdMasked: 'us***@example.com',
      countryOption: {
        id: '66666666-6666-4666-8666-666666666666',
        code: 'us',
        name: '美国'
      }
    },
    serviceOption: {
      id: serviceId,
      code: 'chatgpt-plus',
      name: 'ChatGPT Plus',
      parent: null
    }
  };
}

describe('IdBusinessV2ActivationsService', () => {
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2Activation: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn()
    }
  };
  const service = new IdBusinessV2ActivationsService(
    prisma as never,
    new IdBusinessV2ActivationStatusService()
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.idBusinessV2Activation.findMany.mockResolvedValue([makeActivation()]);
    prisma.idBusinessV2Activation.count.mockResolvedValue(1);
    prisma.idBusinessV2Activation.findUnique.mockResolvedValue(makeActivation());
    prisma.$transaction.mockImplementation(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations)
    );
  });

  it('returns masked activation records and serialized Decimal evidence', async () => {
    const result = await service.list({
      keyword: '测试客户',
      sortBy: 'openedAt',
      sortOrder: 'desc'
    });

    expect(result.items[0]).toMatchObject({
      id: activationId,
      order: {
        orderNo: 'V220260726TEST001',
        receivedAmount: '100',
        profitAmount: '37'
      },
      maskedWebsiteAccount: 'cu***@example.com',
      account: {
        appleIdMasked: 'us***@example.com'
      },
      storedStatus: 'active'
    });
    expect(JSON.stringify(result)).not.toContain('websiteAccountEncrypted');
    expect(prisma.idBusinessV2Activation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }]
      })
    );
  });

  it('builds a non-overlapping due-window query matching the server-side status', async () => {
    const result = await service.list({
      dueStatus: 'due_within_23_hours'
    });

    const call = prisma.idBusinessV2Activation.findMany.mock.calls[0]?.[0];
    expect(call.where.AND).toEqual([
      {
        status: 'active',
        dueAt: {
          gt: expect.any(Date),
          lte: expect.any(Date)
        }
      }
    ]);
    const range = call.where.AND[0].dueAt;
    const evaluatedAt = new Date(result.evaluatedAt);
    expect(range.gt.getTime() - evaluatedAt.getTime()).toBe(60 * 60 * 1000);
    expect(range.lte.getTime() - evaluatedAt.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('starts the seven-day query after the 23-hour status boundary', async () => {
    const result = await service.list({
      dueStatus: 'due_within_7_days'
    });

    const call = prisma.idBusinessV2Activation.findMany.mock.calls[0]?.[0];
    const range = call.where.AND[0].dueAt;
    const evaluatedAt = new Date(result.evaluatedAt);
    expect(range.gt.getTime() - evaluatedAt.getTime()).toBe(23 * 60 * 60 * 1000);
    expect(range.lte.getTime() - evaluatedAt.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
