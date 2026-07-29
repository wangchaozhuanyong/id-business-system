import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2AccountsService } from './id-business-v2-accounts.service';

const operator = {
  id: '20000000-0000-4000-8000-000000000001',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

const country = { id: 'country-1', code: 'us', name: '美国' };
const status = { id: 'status-1', code: 'normal', name: '正常', isSystem: true };
const supplier = { id: 'supplier-1', code: 'supplier-a', name: '供应商 A' };

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'account-1',
    appleIdEncrypted: 'encrypted-apple-id',
    appleIdHash: 'hash:user@example.com',
    appleIdMasked: 'us***@example.com',
    passwordEncrypted: 'encrypted-password',
    phoneEncrypted: 'encrypted-phone',
    phoneHash: 'hash:13800138000',
    phoneMasked: '138****8000',
    phoneTail: '00138000',
    securityInfoEncrypted: 'encrypted-security',
    countryOptionId: country.id,
    statusOptionId: status.id,
    supplierOptionId: supplier.id,
    currentBalance: new Prisma.Decimal(0),
    balanceCostAmount: new Prisma.Decimal(0),
    purchaseCost: new Prisma.Decimal(35),
    recordStatus: 'active',
    remark: null,
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
    createdAt: new Date('2026-07-26T00:00:00.000Z'),
    updatedAt: new Date('2026-07-26T00:00:00.000Z'),
    deletedAt: null,
    countryOption: country,
    statusOption: status,
    supplierOption: supplier,
    ...overrides
  };
}

describe('IdBusinessV2AccountsService', () => {
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2Account: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    idBusinessV2BalanceLedger: {
      create: vi.fn(),
      findUnique: vi.fn()
    },
    sensitiveAccessLog: {
      create: vi.fn(),
      createMany: vi.fn()
    },
    $queryRaw: vi.fn()
  };
  const auditLogsService = { create: vi.fn() };
  const encryptionService = {
    encrypt: vi.fn(),
    decrypt: vi.fn(),
    hash: vi.fn()
  };
  const optionsService = {
    requireActiveOption: vi.fn()
  };
  const service = new IdBusinessV2AccountsService(
    prisma as never,
    auditLogsService as never,
    encryptionService as never,
    optionsService as never,
    new IdBusinessV2BalanceCalculatorService()
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (
        input: Array<Promise<unknown>> | ((transaction: typeof prisma) => Promise<unknown>)
      ) => (typeof input === 'function' ? input(prisma) : Promise.all(input))
    );
    encryptionService.encrypt.mockImplementation((value: string | null) =>
      value ? `encrypted:${value}` : null
    );
    encryptionService.hash.mockImplementation((value: string | null) =>
      value ? `hash:${value}` : null
    );
    encryptionService.decrypt.mockImplementation((value: string | null) => {
      if (value === 'encrypted-apple-id') return 'user@example.com';
      if (value === 'encrypted-password') return 'secret-password';
      if (value === 'encrypted-phone') return '13800138000';
      if (value === 'encrypted-security') return 'security answer';
      return null;
    });
    optionsService.requireActiveOption
      .mockResolvedValueOnce(country)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(supplier);
    auditLogsService.create.mockResolvedValue({ id: 'audit-1' });
  });

  it('lists IDs by stable business order without exposing a numeric sort value', async () => {
    prisma.idBusinessV2Account.findMany.mockResolvedValue([makeAccount()]);
    prisma.idBusinessV2Account.count.mockResolvedValue(1);

    const result = await service.list({});

    expect(result.items[0]).not.toHaveProperty('sortOrder');
    expect(prisma.idBusinessV2Account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }]
      })
    );
  });

  it('encrypts every sensitive field and exposes only masked values', async () => {
    prisma.idBusinessV2Account.findFirst.mockResolvedValue(null);
    prisma.idBusinessV2Account.create.mockResolvedValue(makeAccount());

    const result = await service.create(
      {
        appleId: 'User@Example.com',
        password: 'secret-password',
        phone: '13800138000',
        securityInfo: 'security answer',
        countryOptionId: country.id,
        statusOptionId: status.id,
        supplierOptionId: supplier.id,
        purchaseCost: '35'
      },
      operator
    );

    expect(encryptionService.encrypt).toHaveBeenCalledWith('user@example.com');
    expect(encryptionService.encrypt).toHaveBeenCalledWith('secret-password');
    expect(encryptionService.encrypt).toHaveBeenCalledWith('13800138000');
    expect(encryptionService.encrypt).toHaveBeenCalledWith('security answer');
    expect(result.appleIdMasked).toBe('us***@example.com');
    expect(JSON.stringify(result)).not.toContain('encrypted-apple-id');
    expect(JSON.stringify(auditLogsService.create.mock.calls)).not.toContain('secret-password');
  });

  it('creates an opening-balance ledger entry with the account in one transaction', async () => {
    prisma.idBusinessV2Account.findFirst.mockResolvedValue(null);
    prisma.idBusinessV2Account.create.mockResolvedValue(
      makeAccount({
        currentBalance: new Prisma.Decimal(20),
        balanceCostAmount: new Prisma.Decimal(70)
      })
    );

    await service.create(
      {
        appleId: 'User@Example.com',
        countryOptionId: country.id,
        statusOptionId: status.id,
        currentBalance: '20',
        balanceCostAmount: '70'
      },
      operator
    );

    expect(prisma.idBusinessV2Account.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentBalance: expect.objectContaining({ toString: expect.any(Function) }),
          balanceCostAmount: expect.objectContaining({ toString: expect.any(Function) })
        })
      })
    );
    expect(prisma.idBusinessV2BalanceLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryType: 'opening_balance',
          direction: 'credit',
          balanceAmount: expect.objectContaining({ toString: expect.any(Function) }),
          costAmount: expect.objectContaining({ toString: expect.any(Function) }),
          balanceBefore: '0',
          costBefore: '0',
          remark: 'ID 新增期初余额'
        })
      })
    );
  });

  it('writes an immutable manual adjustment when balance targets change', async () => {
    const existing = makeAccount({
      currentBalance: new Prisma.Decimal(20),
      balanceCostAmount: new Prisma.Decimal(70)
    });
    const updated = makeAccount({
      currentBalance: new Prisma.Decimal(15),
      balanceCostAmount: new Prisma.Decimal(45)
    });
    prisma.idBusinessV2Account.findFirst.mockResolvedValue(existing);
    prisma.idBusinessV2BalanceLedger.findUnique.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([
      {
        id: existing.id,
        currentBalance: existing.currentBalance,
        balanceCostAmount: existing.balanceCostAmount
      }
    ]);
    prisma.idBusinessV2Account.update.mockResolvedValue(updated);

    const result = await service.update(
      existing.id,
      {
        currentBalance: '15',
        balanceCostAmount: '45',
        expectedCurrentBalance: '20',
        expectedBalanceCostAmount: '70',
        balanceAdjustmentReason: '人工核对修正',
        balanceAdjustmentIdempotencyKey: 'account-adjustment-00000001'
      },
      operator
    );

    expect(result.currentBalance).toBe('15');
    expect(result.balanceCostAmount).toBe('45');
    expect(prisma.idBusinessV2BalanceLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryType: 'manual_adjustment',
          direction: 'adjustment',
          balanceBefore: expect.objectContaining({ toString: expect.any(Function) }),
          balanceAfter: expect.objectContaining({ toString: expect.any(Function) }),
          costBefore: expect.objectContaining({ toString: expect.any(Function) }),
          costAfter: expect.objectContaining({ toString: expect.any(Function) }),
          remark: '人工核对修正'
        })
      })
    );
  });

  it('rejects a duplicate encrypted Apple ID hash', async () => {
    prisma.idBusinessV2Account.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(
      service.create({
        appleId: 'user@example.com',
        countryOptionId: country.id,
        statusOptionId: status.id
      })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.idBusinessV2Account.create).not.toHaveBeenCalled();
  });

  it('writes a sensitive access log when revealing a password', async () => {
    prisma.idBusinessV2Account.findFirst.mockResolvedValue(makeAccount());

    const result = await service.revealSecret(
      'account-1',
      { field: 'password', reason: '执行客户续费' },
      operator,
      { ip: '127.0.0.1', userAgent: 'vitest' }
    );

    expect(result.value).toBe('secret-password');
    expect(prisma.sensitiveAccessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          module: 'id_business_v2_account',
          fieldName: 'password',
          accessReason: '执行客户续费'
        })
      })
    );
    expect(JSON.stringify(auditLogsService.create.mock.calls)).not.toContain('secret-password');
  });

  it('rejects a secret reveal without the field permission', async () => {
    await expect(
      service.revealSecret(
        'account-1',
        { field: 'password', reason: '测试' },
        { ...operator, roles: [], permissions: ['apple.account.view'] }
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('soft deletes and disables an ID record', async () => {
    prisma.idBusinessV2Account.findFirst.mockResolvedValue(makeAccount());
    prisma.idBusinessV2Account.update.mockResolvedValue(
      makeAccount({ deletedAt: new Date(), recordStatus: 'disabled' })
    );

    await expect(service.remove('account-1', operator)).resolves.toEqual({ deleted: true });
    expect(prisma.idBusinessV2Account.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
          recordStatus: 'disabled'
        })
      })
    );
  });

  it('exports every matching row without decrypting sensitive fields and writes an audit log', async () => {
    prisma.idBusinessV2Account.count.mockResolvedValue(1);
    prisma.idBusinessV2Account.findMany.mockResolvedValue([makeAccount()]);

    const result = await service.exportRows({ statusOptionId: status.id }, operator);

    expect(result.total).toBe(1);
    expect(result.containsSensitiveFields).toBe(false);
    expect(result.items[0]?.appleIdMasked).toBe('us***@example.com');
    expect(JSON.stringify(result)).not.toContain('secret-password');
    expect(encryptionService.decrypt).not.toHaveBeenCalled();
    expect(auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'id_business_v2.account.export',
        afterData: expect.objectContaining({
          count: 1,
          containsSensitiveFields: false
        })
      })
    );
  });

  it('imports valid rows, keeps row-level failures and writes a summary audit log', async () => {
    const createSpy = vi
      .spyOn(service, 'create')
      .mockResolvedValueOnce({ id: 'account-1' } as never)
      .mockRejectedValueOnce(new ConflictException('该 Apple ID 已存在'));

    try {
      const result = await service.importRows(
        {
          rows: [
            {
              rowNumber: 2,
              appleId: 'first@example.com',
              countryOptionId: country.id,
              statusOptionId: status.id
            },
            {
              rowNumber: 7,
              appleId: 'duplicate@example.com',
              countryOptionId: country.id,
              statusOptionId: status.id
            }
          ]
        },
        operator
      );

      expect(result).toEqual({
        totalCount: 2,
        successCount: 1,
        failedCount: 1,
        failures: [{ rowNumber: 7, reason: '该 Apple ID 已存在' }]
      });
      expect(auditLogsService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'id_business_v2.account.import',
          afterData: expect.objectContaining({
            totalCount: 2,
            successCount: 1,
            failedCount: 1,
            failedRowNumbers: [7]
          })
        })
      );
    } finally {
      createSpy.mockRestore();
    }
  });
});
