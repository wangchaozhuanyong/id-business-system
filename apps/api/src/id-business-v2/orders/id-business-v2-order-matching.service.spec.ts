import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2OrderMatchingService } from './id-business-v2-order-matching.service';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

const serviceOptionId = '11111111-1111-4111-8111-111111111111';
const categoryOptionId = '22222222-2222-4222-8222-222222222222';
const countryOptionId = '33333333-3333-4333-8333-333333333333';
const accountId = '55555555-5555-4555-8555-555555555555';
const evaluatedAccountAt = new Date('2026-07-26T12:00:00.000Z');

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function makeServiceContext() {
  return {
    id: serviceOptionId,
    code: 'service_chatgpt_plus',
    name: 'ChatGPT Plus',
    parent: {
      id: categoryOptionId,
      code: 'category_ai',
      name: 'AI 服务'
    },
    countryOption: {
      id: countryOptionId,
      code: 'country_us',
      name: '美国'
    }
  };
}

function makeCountry() {
  return {
    id: countryOptionId,
    code: 'country_us',
    name: '美国'
  };
}

function makeAccount() {
  return {
    id: accountId,
    appleIdEncrypted: 'encrypted-apple-id',
    appleIdMasked: 'us***@example.com',
    currentBalance: decimal('25'),
    balanceCostAmount: decimal('150'),
    purchaseCost: decimal('20'),
    updatedAt: evaluatedAccountAt,
    countryOption: makeCountry(),
    statusOption: {
      id: '66666666-6666-4666-8666-666666666666',
      code: 'normal',
      name: '正常'
    }
  };
}

describe('IdBusinessV2OrderMatchingService', () => {
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2Option: {
      findFirst: vi.fn()
    },
    idBusinessV2Account: {
      count: vi.fn(),
      findMany: vi.fn()
    },
    idBusinessV2AccountLock: {
      findFirst: vi.fn()
    },
    idBusinessV2Activation: {
      findFirst: vi.fn()
    }
  };
  const balanceCalculator = {
    calculateAverageCost: vi.fn(),
    calculateConsumption: vi.fn()
  };
  const fieldEncryptionService = {
    hash: vi.fn(),
    decrypt: vi.fn()
  };
  const sensitiveAccessService = {
    resolveDisplayMode: vi.fn()
  };
  const service = new IdBusinessV2OrderMatchingService(
    new IdBusinessV2OrdersRepository(prisma as never),
    balanceCalculator as never,
    fieldEncryptionService as never,
    sensitiveAccessService as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(makeServiceContext());
    prisma.idBusinessV2Account.count
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2);
    prisma.idBusinessV2Account.findMany.mockResolvedValue([makeAccount()]);
    prisma.idBusinessV2AccountLock.findFirst.mockResolvedValue(null);
    prisma.idBusinessV2Activation.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations)
    );
    balanceCalculator.calculateAverageCost.mockReturnValue(decimal('6'));
    balanceCalculator.calculateConsumption.mockReturnValue({
      costAmount: decimal('120')
    });
    fieldEncryptionService.hash.mockReturnValue('apple-id-search-hash');
    fieldEncryptionService.decrypt.mockReturnValue('user@example.com');
    sensitiveAccessService.resolveDisplayMode.mockResolvedValue('masked');
  });

  it('derives the country from the active service tree and returns only real eligible candidates', async () => {
    const result = await service.findCandidates({
      serviceOptionId,
      balanceAmount: '20',
      limit: '10'
    });

    expect(prisma.idBusinessV2Option.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: serviceOptionId,
          type: 'service',
          status: 'active',
          deletedAt: null
        })
      })
    );
    expect(result).toMatchObject({
      criteria: {
        country: {
          id: countryOptionId,
          name: '美国'
        },
        requiredBalance: '20',
        requiredStatusCode: 'normal'
      },
      counts: {
        activeInCountry: 5,
        normalStatus: 4,
        sufficientBalance: 3,
        available: 2
      },
      selectedCandidateId: accountId,
      items: [
        {
          id: accountId,
          appleIdMasked: 'us***@example.com',
          country: {
            id: countryOptionId,
            name: '美国'
          },
          currentBalance: '25',
          estimatedBalanceCostAmount: '120',
          averageCost: '6',
          balanceAfterMatch: '5'
        }
      ]
    });
  });

  it('returns the policy-selected account value without exposing ciphertext', async () => {
    sensitiveAccessService.resolveDisplayMode.mockResolvedValue('full');

    const result = await service.findCandidates(
      {
        serviceOptionId,
        balanceAmount: '20'
      },
      {
        id: '77777777-7777-4777-8777-777777777777',
        username: 'admin',
        displayName: '管理员',
        roles: ['admin'],
        permissions: []
      }
    );

    expect(result.items[0]).toMatchObject({
      appleIdMasked: 'us***@example.com',
      displayAppleId: 'user@example.com'
    });
    expect(JSON.stringify(result)).not.toContain('encrypted-apple-id');
  });

  it('maps a Cloudflare runtime decimal before applying Amount4 subtraction', async () => {
    const runtimeCurrentBalance = {
      toString: () => '25',
      minus: vi.fn((value: unknown) => {
        if (typeof value !== 'string') {
          throw new Error(`[DecimalError] Invalid argument: ${String(value)}`);
        }
        return decimal('25').minus(value);
      })
    };
    prisma.idBusinessV2Account.findMany.mockResolvedValue([
      {
        ...makeAccount(),
        currentBalance: runtimeCurrentBalance
      }
    ]);

    const result = await service.findCandidates({
      serviceOptionId,
      balanceAmount: '20'
    });

    expect(runtimeCurrentBalance.minus).not.toHaveBeenCalled();
    expect(result.items[0]?.balanceAfterMatch).toBe('5');
  });

  it('searches eligible candidates manually without selecting one automatically', async () => {
    const result = await service.searchManualCandidates({
      serviceOptionId,
      balanceAmount: '20',
      keyword: 'Target@Example.com',
      limit: 10
    });

    const findManyCall = prisma.idBusinessV2Account.findMany.mock.calls[0]?.[0];
    expect(fieldEncryptionService.hash).toHaveBeenCalledWith('target@example.com');
    expect(findManyCall).toMatchObject({
      where: {
        countryOptionId,
        currentBalance: {
          gte: '20'
        },
        activations: {
          none: expect.objectContaining({
            status: 'active',
            renewedBy: { is: null },
            serviceOption: {
              is: {
                type: 'service',
                parentId: categoryOptionId
              }
            }
          })
        },
        OR: [
          {
            appleIdMasked: {
              contains: 'Target@Example.com',
              mode: 'insensitive'
            }
          },
          {
            appleIdHash: 'apple-id-search-hash'
          },
          {
            appleIdSearchTokens: {
              hasEvery: ['apple-id-search-hash']
            }
          },
          {
            soldByOrder: {
              is: {
                orderNo: {
                  contains: 'Target@Example.com',
                  mode: 'insensitive'
                }
              }
            }
          }
        ]
      },
      take: 10
    });
    expect(result.selectedCandidateId).toBeNull();
    expect(result.items[0]?.id).toBe(accountId);
  });

  it('uses the balance calculator consumption result for the estimated order cost', async () => {
    balanceCalculator.calculateConsumption.mockReturnValue({
      costAmount: decimal('150')
    });

    const result = await service.findCandidates({
      serviceOptionId,
      balanceAmount: '25'
    });

    expect(balanceCalculator.calculateConsumption).toHaveBeenCalledOnce();
    const [snapshot, requestedAmount] = balanceCalculator.calculateConsumption.mock.calls[0] ?? [];
    expect(snapshot?.currentBalance.toString()).toBe('25');
    expect(snapshot?.balanceCostAmount.toString()).toBe('150');
    expect(requestedAmount?.toString()).toBe('25');
    expect(result.items[0]?.estimatedBalanceCostAmount).toBe('150');
  });

  it('filters normal active accounts by country UUID, balance, global locks, and same-service locks', async () => {
    await service.findCandidates({
      serviceOptionId,
      balanceAmount: '20'
    });

    const findManyCall = prisma.idBusinessV2Account.findMany.mock.calls[0]?.[0];
    expect(findManyCall).toMatchObject({
      where: {
        deletedAt: null,
        recordStatus: 'active',
        countryOptionId,
        statusOption: {
          is: {
            type: 'id_status',
            code: 'normal',
            status: 'active',
            deletedAt: null
          }
        },
        currentBalance: {
          gte: '20'
        },
        locks: {
          none: {
            status: 'active',
            expiresAt: {
              gt: expect.any(Date)
            },
            OR: [
              {
                lockScope: 'global'
              },
              {
                lockScope: 'by_service',
                serviceOptionId
              }
            ]
          }
        }
      },
      take: 20,
      orderBy: [
        {
          currentBalance: 'asc'
        },
        {
          updatedAt: 'asc'
        },
        {
          id: 'asc'
        }
      ]
    });
  });

  it('excludes active unrenewed same-category activations from automatic matching', async () => {
    await service.findCandidates({
      serviceOptionId,
      balanceAmount: '20'
    });

    const findManyCall = prisma.idBusinessV2Account.findMany.mock.calls[0]?.[0];
    expect(findManyCall).toMatchObject({
      where: {
        activations: {
          none: {
            status: 'active',
            renewedBy: { is: null },
            serviceOption: {
              is: {
                type: 'service',
                parentId: categoryOptionId
              }
            },
            OR: [
              { dueAt: null },
              {
                dueAt: {
                  gt: expect.any(Date)
                }
              }
            ]
          }
        }
      }
    });
  });

  it('uses the earliest lock or same-category activation expiry as the revalidation time', async () => {
    const lockExpiresAt = new Date('2026-08-01T00:00:00.000Z');
    const activationDueAt = new Date('2026-07-30T00:00:00.000Z');
    prisma.idBusinessV2AccountLock.findFirst.mockResolvedValue({ expiresAt: lockExpiresAt });
    prisma.idBusinessV2Activation.findFirst.mockResolvedValue({ dueAt: activationDueAt });

    const result = await service.findCandidates({
      serviceOptionId,
      balanceAmount: '20'
    });

    expect(result.revalidateAt).toBe(activationDueAt);
    expect(prisma.idBusinessV2Activation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'active',
          renewedBy: { is: null },
          serviceOption: {
            is: {
              type: 'service',
              parentId: categoryOptionId
            }
          },
          dueAt: {
            gt: expect.any(Date)
          },
          account: {
            is: expect.objectContaining({
              countryOptionId,
              currentBalance: {
                gte: '20'
              }
            })
          }
        }),
        orderBy: {
          dueAt: 'asc'
        }
      })
    );
  });

  it('does not expose encrypted account fields, hashes, passwords, or lock tokens', async () => {
    prisma.idBusinessV2Account.findMany.mockResolvedValue([
      {
        ...makeAccount(),
        appleIdEncrypted: 'encrypted-apple-id',
        appleIdHash: 'apple-id-hash',
        passwordEncrypted: 'encrypted-password',
        lockToken: 'secret-lock-token'
      }
    ]);

    const result = await service.findCandidates({
      serviceOptionId,
      balanceAmount: '20'
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('encrypted-apple-id');
    expect(serialized).not.toContain('apple-id-hash');
    expect(serialized).not.toContain('encrypted-password');
    expect(serialized).not.toContain('secret-lock-token');
  });

  it('returns exact eligibility counts and no selected account when every candidate is locked', async () => {
    prisma.idBusinessV2Account.count
      .mockReset()
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(0);
    prisma.idBusinessV2Account.findMany.mockResolvedValue([]);

    const result = await service.findCandidates({
      serviceOptionId,
      balanceAmount: '20'
    });

    expect(result.counts).toEqual({
      activeInCountry: 5,
      normalStatus: 4,
      sufficientBalance: 3,
      available: 0
    });
    expect(result.selectedCandidateId).toBeNull();
    expect(result.items).toEqual([]);
  });

  it('rejects services without a complete active country tree', async () => {
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(null);

    await expect(
      service.findCandidates({
        serviceOptionId,
        balanceAmount: '20'
      })
    ).rejects.toThrow('业务不存在、已停用或没有完整的国家和分类');
    expect(prisma.idBusinessV2Account.count).not.toHaveBeenCalled();
  });

  it('does not perform a second name-based country mapping query', async () => {
    await service.findCandidates({
      serviceOptionId,
      balanceAmount: '20'
    });

    expect(prisma.idBusinessV2Option.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.idBusinessV2Account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          countryOptionId
        })
      })
    );
  });

  it('keeps matching by country UUID after the country is renamed', async () => {
    prisma.idBusinessV2Option.findFirst.mockResolvedValue({
      ...makeServiceContext(),
      countryOption: {
        ...makeCountry(),
        name: '美国1'
      }
    });
    prisma.idBusinessV2Account.findMany.mockResolvedValue([
      {
        ...makeAccount(),
        countryOption: {
          ...makeCountry(),
          name: '美国1'
        }
      }
    ]);

    const result = await service.findCandidates({
      serviceOptionId,
      balanceAmount: '20'
    });

    expect(prisma.idBusinessV2Account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          countryOptionId
        })
      })
    );
    expect(result.criteria.country.name).toBe('美国1');
    expect(result.items[0]?.country.name).toBe('美国1');
  });

  it('rejects invalid service IDs, balances, and limits before querying candidates', async () => {
    await expect(
      service.findCandidates({
        serviceOptionId: 'invalid',
        balanceAmount: '20'
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.findCandidates({
        serviceOptionId,
        balanceAmount: '0'
      })
    ).rejects.toThrow('消耗余额必须大于 0');
    await expect(
      service.findCandidates({
        serviceOptionId,
        balanceAmount: '20.00001'
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.findCandidates({
        serviceOptionId,
        balanceAmount: '20',
        limit: '51'
      })
    ).rejects.toThrow('候选数量必须是 1 到 50 的整数');
    expect(prisma.idBusinessV2Account.findMany).not.toHaveBeenCalled();
  });

  it('rejects an oversized manual search term before querying or hashing it', async () => {
    await expect(
      service.searchManualCandidates({
        serviceOptionId,
        balanceAmount: '20',
        keyword: 'a'.repeat(256)
      })
    ).rejects.toThrow('ID 搜索词过长');
    expect(fieldEncryptionService.hash).not.toHaveBeenCalled();
    expect(prisma.idBusinessV2Account.findMany).not.toHaveBeenCalled();
  });
});
