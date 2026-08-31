import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Prisma as MysqlPrisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2AccountBalanceAdjustmentService } from './id-business-v2-account-balance-adjustment.service';
import { IdBusinessV2AccountsService } from './id-business-v2-accounts.service';
import { IdBusinessV2AccountsRepository } from './persistence/id-business-v2-accounts.repository';

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
    soldByOrderId: null,
    soldAt: null,
    lossReportedAt: null,
    recordStatus: 'active',
    disabledReason: null,
    disabledAt: null,
    remark: null,
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
    createdAt: new Date('2026-07-26T00:00:00.000Z'),
    updatedAt: new Date('2026-07-26T00:00:00.000Z'),
    deletedAt: null,
    countryOption: country,
    statusOption: status,
    supplierOption: supplier,
    soldByOrder: null,
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
      update: vi.fn(),
      updateMany: vi.fn()
    },
    idBusinessV2BalanceLedger: {
      create: vi.fn(),
      findUnique: vi.fn()
    },
    idBusinessV2TopupSupplierLedger: {
      create: vi.fn()
    },
    idBusinessV2TopupSupplierAccount: {
      update: vi.fn()
    },
    idBusinessV2FinanceAccount: {
      findUnique: vi.fn()
    },
    idBusinessV2FinanceFxRateSnapshot: {
      findUnique: vi.fn()
    },
    sensitiveAccessLog: {
      create: vi.fn(),
      createMany: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    },
    $queryRaw: vi.fn()
  };
  const encryptionService = {
    encrypt: vi.fn(),
    decrypt: vi.fn(),
    hash: vi.fn()
  };
  const optionsService = {
    requireActiveOption: vi.fn()
  };
  const financeFxService = {
    resolve: vi.fn().mockResolvedValue({
      id: null,
      rateToCny: new Prisma.Decimal(1),
      source: 'cny_fixed'
    })
  };
  const financePostingService = {
    post: vi.fn().mockResolvedValue({ id: 'finance-journal-1' })
  };
  const balanceCalculator = new IdBusinessV2BalanceCalculatorService();
  const transactionManager = new V2CommandTransactionManager(prisma as never);
  const transactionalAudit = new V2TransactionalAuditService();
  const repository = new IdBusinessV2AccountsRepository(prisma as never);
  const balanceAdjustmentService = new IdBusinessV2AccountBalanceAdjustmentService(
    balanceCalculator,
    financePostingService as never,
    transactionManager,
    transactionalAudit,
    repository
  );
  const sensitiveAccessService = {
    resolveDisplayModes: vi.fn().mockResolvedValue({
      'account.apple_id': 'masked',
      'account.phone': 'masked'
    }),
    authorize: vi.fn().mockResolvedValue({
      mode: 'direct',
      approvalId: null,
      reason: '角色权限直接查看'
    })
  };
  const service = new IdBusinessV2AccountsService(
    repository,
    encryptionService as never,
    optionsService as never,
    balanceCalculator,
    financeFxService as never,
    financePostingService as never,
    transactionManager,
    transactionalAudit,
    balanceAdjustmentService,
    sensitiveAccessService as never
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
    prisma.auditLog.create.mockResolvedValue({ id: 'audit-transactional-1' });
    prisma.idBusinessV2BalanceLedger.create.mockImplementation(async ({ data }) => ({
      id: 'balance-ledger-adjustment-1',
      ...data,
      createdAt: new Date('2026-07-26T12:30:00.000Z')
    }));
    prisma.idBusinessV2Account.updateMany.mockResolvedValue({ count: 1 });
    prisma.idBusinessV2FinanceFxRateSnapshot.findUnique.mockResolvedValue({
      currency: 'MYR',
      rateToCny: new Prisma.Decimal('2'),
      expiresAt: null
    });
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

  it('uses mutually exclusive lifecycle filters for the disabled ID category', async () => {
    prisma.idBusinessV2Account.findMany.mockResolvedValue([]);
    prisma.idBusinessV2Account.count.mockResolvedValue(0);

    await service.list({ lifecycle: 'disabled' });

    expect(prisma.idBusinessV2Account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          soldByOrderId: null,
          lossReportedAt: null,
          recordStatus: 'disabled'
        })
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
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('secret-password');
  });

  it('rejects using a top-up supplier wallet to purchase an ID', async () => {
    const supplierWalletId = '44444444-4444-4444-8444-444444444444';
    financeFxService.resolve.mockResolvedValueOnce({
      id: '55555555-5555-4555-8555-555555555555',
      rateToCny: new MysqlPrisma.Decimal('2'),
      source: 'manual'
    });
    await expect(
      service.create(
        {
          appleId: 'purchase@example.com',
          countryOptionId: country.id,
          statusOptionId: status.id,
          supplierOptionId: supplier.id,
          purchaseCurrency: 'MYR',
          purchaseOriginalAmount: '10',
          purchaseFxRateToCny: '2',
          purchaseManualRateReason: '人工采购汇率',
          purchaseCost: '20',
          purchaseSupplierAccountId: supplierWalletId
        },
        operator
      )
    ).rejects.toThrow('ID 采购只能使用自有资金账户');
    expect(prisma.idBusinessV2Account.create).not.toHaveBeenCalled();
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
          currentBalance: '20',
          balanceCostAmount: '70'
        })
      })
    );
    expect(prisma.idBusinessV2BalanceLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryType: 'opening_balance',
          direction: 'credit',
          balanceAmount: '20',
          costAmount: '70',
          balanceBefore: '0',
          costBefore: '0',
          remark: 'ID 新增期初余额'
        })
      })
    );
  });

  it('rejects the whole create command when finance posting fails before audit', async () => {
    prisma.idBusinessV2Account.findFirst.mockResolvedValue(null);
    prisma.idBusinessV2Account.create.mockResolvedValue(makeAccount());
    financePostingService.post.mockRejectedValueOnce(new Error('finance unavailable'));

    await expect(
      service.create(
        {
          appleId: 'finance-failure@example.com',
          countryOptionId: country.id,
          statusOptionId: status.id,
          purchaseCost: '35'
        },
        operator,
        { requestId: 'account-create-finance-failure' }
      )
    ).rejects.toThrow('finance unavailable');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects the whole create command when transactional audit fails', async () => {
    prisma.idBusinessV2Account.findFirst.mockResolvedValue(null);
    prisma.idBusinessV2Account.create.mockResolvedValue(makeAccount());
    prisma.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(
      service.create(
        {
          appleId: 'audit-failure@example.com',
          countryOptionId: country.id,
          statusOptionId: status.id,
          purchaseCost: '35'
        },
        operator,
        { requestId: 'account-create-audit-failure' }
      )
    ).rejects.toThrow('audit unavailable');
    expect(financePostingService.post).toHaveBeenCalled();
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
    prisma.idBusinessV2Account.findFirst
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(updated);
    prisma.idBusinessV2BalanceLedger.findUnique.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([
      {
        id: existing.id,
        currentBalance: existing.currentBalance,
        balanceCostAmount: existing.balanceCostAmount,
        soldByOrderId: null,
        lossReportedAt: null
      }
    ]);

    const result = await service.update(
      existing.id,
      {
        expectedUpdatedAt: existing.updatedAt.toISOString(),
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
          balanceBefore: '20',
          balanceAfter: '15',
          costBefore: '70',
          costAfter: '45',
          remark: '人工核对修正'
        })
      })
    );
  });

  it('adjusts database Decimal persisted balances without cross-runtime methods', async () => {
    const existing = makeAccount({
      currentBalance: new MysqlPrisma.Decimal('20'),
      balanceCostAmount: new MysqlPrisma.Decimal('70')
    });
    const updated = makeAccount({
      currentBalance: new MysqlPrisma.Decimal('15'),
      balanceCostAmount: new MysqlPrisma.Decimal('45')
    });
    prisma.idBusinessV2Account.findFirst
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(updated);
    prisma.idBusinessV2BalanceLedger.findUnique.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([
      {
        id: existing.id,
        currentBalance: new MysqlPrisma.Decimal('20'),
        balanceCostAmount: new MysqlPrisma.Decimal('70'),
        soldByOrderId: null,
        lossReportedAt: null
      }
    ]);

    const result = await service.update(
      existing.id,
      {
        expectedUpdatedAt: existing.updatedAt.toISOString(),
        currentBalance: '15',
        balanceCostAmount: '45',
        expectedCurrentBalance: '20',
        expectedBalanceCostAmount: '70',
        balanceAdjustmentReason: 'MySQL 回归修正',
        balanceAdjustmentIdempotencyKey: 'account-adjustment-mysql-0001'
      },
      operator
    );

    expect(result).toMatchObject({ currentBalance: '15', balanceCostAmount: '45' });
    expect(prisma.idBusinessV2BalanceLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ balanceBefore: '20', costBefore: '70' })
      })
    );
  });

  it('allows balance and cost adjustments for a sold ID and posts the cost movement', async () => {
    const existing = makeAccount({
      currentBalance: new Prisma.Decimal(20),
      balanceCostAmount: new Prisma.Decimal(70),
      soldByOrderId: '99999999-9999-4999-8999-999999999999',
      soldAt: new Date('2026-07-26T01:00:00.000Z'),
      soldByOrder: {
        id: '99999999-9999-4999-8999-999999999999',
        orderNo: 'V220260726SOLD001'
      }
    });
    prisma.idBusinessV2Account.findFirst.mockResolvedValueOnce(existing).mockResolvedValueOnce(
      makeAccount({
        ...existing,
        currentBalance: new Prisma.Decimal(15),
        balanceCostAmount: new Prisma.Decimal(45)
      })
    );
    prisma.idBusinessV2BalanceLedger.findUnique.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([
      {
        id: existing.id,
        currentBalance: existing.currentBalance,
        balanceCostAmount: existing.balanceCostAmount,
        soldByOrderId: existing.soldByOrderId,
        lossReportedAt: null
      }
    ]);

    await expect(
      service.update(
        existing.id,
        {
          expectedUpdatedAt: existing.updatedAt.toISOString(),
          currentBalance: '15',
          balanceCostAmount: '45',
          expectedCurrentBalance: '20',
          expectedBalanceCostAmount: '70',
          balanceAdjustmentReason: '尝试调整',
          balanceAdjustmentIdempotencyKey: 'account-adjustment-sold-0001'
        },
        operator
      )
    ).resolves.toMatchObject({ currentBalance: '15', balanceCostAmount: '45', saleState: 'sold' });
    expect(prisma.idBusinessV2BalanceLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accountId: existing.id,
          direction: 'adjustment',
          balanceAmount: '5',
          costAmount: '25',
          balanceBefore: '20',
          balanceAfter: '15',
          costBefore: '70',
          costAfter: '45'
        })
      })
    );
    expect(financePostingService.post).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        journalType: 'manual_adjustment',
        lines: expect.arrayContaining([
          expect.objectContaining({ accountCode: 'gift_card_inventory', direction: 'credit' }),
          expect.objectContaining({ accountCode: 'manual_adjustment', direction: 'debit' })
        ])
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
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('secret-password');
  });

  it('does not decrypt or log a secret when the current policy requires approval', async () => {
    prisma.idBusinessV2Account.findFirst.mockResolvedValue(makeAccount());
    sensitiveAccessService.authorize.mockRejectedValueOnce(
      new ForbiddenException('该字段需要管理员批准后才能查看')
    );

    await expect(
      service.revealSecret('account-1', { field: 'password' }, operator)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(encryptionService.decrypt).not.toHaveBeenCalled();
    expect(prisma.sensitiveAccessLog.create).not.toHaveBeenCalled();
  });

  it('does not append the audit when sensitive access logging fails', async () => {
    prisma.idBusinessV2Account.findFirst.mockResolvedValue(makeAccount());
    prisma.sensitiveAccessLog.create.mockRejectedValueOnce(new Error('sensitive log unavailable'));

    await expect(
      service.revealSecret('account-1', { field: 'password', reason: '执行客户续费' }, operator, {
        requestId: 'account-reveal-sensitive-log-failure'
      })
    ).rejects.toThrow('sensitive log unavailable');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
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

  it('requires a reason and retains the ID when disabling it', async () => {
    const disabled = makeAccount({
      recordStatus: 'disabled',
      disabledReason: '暂不投入使用',
      disabledAt: new Date('2026-08-08T00:00:00.000Z')
    });
    prisma.$queryRaw.mockResolvedValue([{ id: 'account-1' }]);
    prisma.idBusinessV2Account.findFirst
      .mockResolvedValueOnce(makeAccount())
      .mockResolvedValueOnce(disabled);

    await expect(
      service.changeRecordStatus(
        'account-1',
        {
          expectedUpdatedAt: makeAccount().updatedAt.toISOString(),
          recordStatus: 'disabled',
          reason: '暂不投入使用'
        },
        operator
      )
    ).resolves.toMatchObject({
      id: 'account-1',
      recordStatus: 'disabled',
      disabledReason: '暂不投入使用'
    });
    expect(prisma.idBusinessV2Account.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recordStatus: 'disabled',
          disabledReason: '暂不投入使用',
          disabledAt: expect.any(Date)
        })
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'id_business_v2.account.disable' })
      })
    );
  });

  it('allows disabling a sold ID without clearing its ownership', async () => {
    const soldAccount = makeAccount({
      soldByOrderId: '80000000-0000-4000-8000-000000000001',
      soldByOrder: {
        id: '80000000-0000-4000-8000-000000000001',
        orderNo: 'V220260801SOLD001'
      }
    });
    prisma.$queryRaw.mockResolvedValue([{ id: 'account-1' }]);
    prisma.idBusinessV2Account.findFirst.mockResolvedValueOnce(soldAccount).mockResolvedValueOnce(
      makeAccount({
        ...soldAccount,
        recordStatus: 'disabled',
        disabledReason: '售后暂停',
        disabledAt: new Date('2026-07-26T12:00:00.000Z')
      })
    );

    await expect(
      service.changeRecordStatus(
        'account-1',
        {
          expectedUpdatedAt: soldAccount.updatedAt.toISOString(),
          recordStatus: 'disabled',
          reason: '售后暂停'
        },
        operator
      )
    ).resolves.toMatchObject({
      saleState: 'sold',
      soldByOrder: expect.objectContaining({ id: soldAccount.soldByOrderId }),
      recordStatus: 'disabled'
    });
    expect(prisma.idBusinessV2Account.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recordStatus: 'disabled', disabledReason: '售后暂停' })
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
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'id_business_v2.account.export',
          afterData: expect.objectContaining({
            count: 1,
            containsSensitiveFields: false
          })
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
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'id_business_v2.account.import',
            afterData: expect.objectContaining({
              totalCount: 2,
              successCount: 1,
              failedCount: 1,
              failedRowNumbers: [7]
            })
          })
        })
      );
    } finally {
      createSpy.mockRestore();
    }
  });
});
