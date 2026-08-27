import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  createV2DeletePreviewFingerprint
} from '../runtime/public-api';
import { IdBusinessV2OptionQuery } from './id-business-v2-option-query';
import { IdBusinessV2OptionsService } from './id-business-v2-options.service';
import { IdBusinessV2OptionRepository } from './persistence/id-business-v2-option.repository';

const operator = {
  id: '20000000-0000-4000-8000-000000000001',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['data.dictionary.manage']
};

const zeroOptionImpact = {
  dependentServiceCount: 0,
  accountReferenceCount: 0,
  activeAccountCount: 0,
  customerReferenceCount: 0,
  giftCardReferenceCount: 0,
  orderReferenceCount: 0,
  activeOrderCount: 0,
  activationReferenceCount: 0,
  activeActivationCount: 0,
  supplierWalletCount: 0,
  financeExpenseCount: 0,
  financeInflowCount: 0
};

function deleteFingerprint(option: ReturnType<typeof makeOption>, impact = zeroOptionImpact) {
  return createV2DeletePreviewFingerprint('option', option.id, option.updatedAt, impact);
}

function makeOption(
  overrides: Partial<{
    id: string;
    type:
      | 'id_status'
      | 'customer_source'
      | 'customer_tag'
      | 'country'
      | 'business_category'
      | 'service'
      | 'id_supplier'
      | 'topup_supplier'
      | 'gift_card_name'
      | 'settlement_platform'
      | 'expense_category'
      | 'income_category';
    code: string;
    name: string;
    uniqueKey: string;
    parentId: string | null;
    countryOptionId: string | null;
    businessAmount: Prisma.Decimal | null;
    currencyCode: string | null;
    fixedFee: Prisma.Decimal;
    percentageFee: Prisma.Decimal;
    sortOrder: number;
    status: 'active' | 'disabled';
    isSystem: boolean;
    remark: string | null;
    createdByUserId: string | null;
    updatedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    parent: { id: string; type: 'country' | 'business_category'; name: string } | null;
    countryOption: {
      id: string;
      type: 'country';
      code: string;
      name: string;
      currencyCode: string;
    } | null;
    _count: { children: number; servicesByCountry: number; accountsByCountry: number };
  }> = {}
) {
  return {
    id: '10000000-0000-4000-8000-000000000010',
    type: 'customer_tag' as const,
    code: 'customer_tag_test',
    name: '测试标签',
    uniqueKey: 'customer_tag:root:测试标签',
    parentId: null,
    countryOptionId: null,
    businessAmount: null,
    currencyCode: null,
    fixedFee: new Prisma.Decimal(0),
    percentageFee: new Prisma.Decimal(0),
    sortOrder: 10,
    status: 'active' as const,
    isSystem: false,
    remark: null,
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
    createdAt: new Date('2026-07-26T00:00:00.000Z'),
    updatedAt: new Date('2026-07-26T00:00:00.000Z'),
    deletedAt: null,
    parent: null,
    countryOption: null,
    _count: { children: 0, servicesByCountry: 0, accountsByCountry: 0 },
    ...overrides
  };
}

describe('IdBusinessV2OptionsService', () => {
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2Option: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    },
    idBusinessV2Account: {
      count: vi.fn()
    },
    idBusinessV2Customer: { count: vi.fn() },
    idBusinessV2GiftCard: { count: vi.fn() },
    idBusinessV2Order: { count: vi.fn() },
    idBusinessV2Activation: { count: vi.fn() },
    idBusinessV2TopupSupplierAccount: {
      count: vi.fn(),
      updateMany: vi.fn()
    },
    idBusinessV2FinanceExpense: { count: vi.fn() },
    idBusinessV2FinanceInflow: { count: vi.fn() },
    auditLog: {
      create: vi.fn()
    }
  };
  const service = new IdBusinessV2OptionsService(
    new IdBusinessV2OptionRepository(prisma as never),
    new IdBusinessV2OptionQuery(new IdBusinessV2OptionRepository(prisma as never)),
    new V2CommandTransactionManager(prisma as never),
    new V2TransactionalAuditService()
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });
    prisma.idBusinessV2Account.count.mockResolvedValue(0);
    prisma.idBusinessV2Customer.count.mockResolvedValue(0);
    prisma.idBusinessV2GiftCard.count.mockResolvedValue(0);
    prisma.idBusinessV2Order.count.mockResolvedValue(0);
    prisma.idBusinessV2Activation.count.mockResolvedValue(0);
    prisma.idBusinessV2TopupSupplierAccount.count.mockResolvedValue(0);
    prisma.idBusinessV2FinanceExpense.count.mockResolvedValue(0);
    prisma.idBusinessV2FinanceInflow.count.mockResolvedValue(0);
    prisma.idBusinessV2Option.findMany.mockResolvedValue([]);
    prisma.idBusinessV2TopupSupplierAccount.updateMany.mockResolvedValue({ count: 0 });
    prisma.idBusinessV2Option.updateMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation(
      async (work: Array<Promise<unknown>> | ((tx: typeof prisma) => Promise<unknown>)) =>
        typeof work === 'function' ? work(prisma) : Promise.all(work)
    );
  });

  it('exposes all workbook option types and fixed status codes', () => {
    const result = service.listTypes();

    expect(result.items).toHaveLength(12);
    expect(result.items.some((item) => item.type === 'gift_card_name')).toBe(true);
    expect(result.items.some((item) => item.type === 'expense_category')).toBe(true);
    expect(result.items.some((item) => item.type === 'income_category')).toBe(true);
    expect(result.items.some((item) => item.type === 'id_region')).toBe(false);
    expect(result.items.find((item) => item.type === 'service')).toMatchObject({
      parentType: 'business_category',
      requiresCountry: true,
      supportsBusinessAmount: true
    });
    expect(result.items.find((item) => item.type === 'business_category')?.parentType).toBeNull();
    expect(result.systemStatusCodes).toEqual(['normal', 'frozen']);
  });

  it('loads the default first page for all option types in one transaction', async () => {
    prisma.idBusinessV2Option.findMany.mockImplementation(
      ({ where }: { where: { type: ReturnType<typeof makeOption>['type'] } }) =>
        Promise.resolve([
          makeOption({
            id: `option-${where.type}`,
            type: where.type,
            code: `${where.type}_test`,
            name: `${where.type} 测试项`,
            uniqueKey: `${where.type}:root:test`
          })
        ])
    );
    prisma.idBusinessV2Option.groupBy.mockResolvedValue([
      { type: 'id_status', _count: { _all: 2 } },
      { type: 'customer_source', _count: { _all: 3 } }
    ]);

    const result = await service.listDefaultPages();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.idBusinessV2Option.findMany).toHaveBeenCalledTimes(12);
    expect(prisma.idBusinessV2Option.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          type: 'country',
          deletedAt: null
        },
        take: 20,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
      })
    );
    expect(prisma.idBusinessV2Option.groupBy).toHaveBeenCalledWith({
      by: ['type'],
      where: {
        deletedAt: null
      },
      _count: {
        _all: true
      }
    });
    expect(Object.keys(result)).toHaveLength(12);
    expect(result.id_status).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(result.customer_source).toMatchObject({ total: 3, page: 1, pageSize: 20 });
    expect(result.country.items[0]).toMatchObject({
      type: 'country',
      name: 'country 测试项'
    });
    expect(result.settlement_platform.total).toBe(0);
    expect(result.gift_card_name.total).toBe(0);
  });

  it('loads several selector types with one current database query', async () => {
    prisma.idBusinessV2Option.findMany.mockResolvedValue([
      {
        id: 'country-us',
        type: 'country',
        code: 'country_us',
        name: '美国',
        status: 'active',
        parentId: null,
        countryOptionId: null,
        businessAmount: null,
        currencyCode: 'USD',
        parent: null,
        countryOption: null
      },
      {
        id: 'status-normal',
        type: 'id_status',
        code: 'normal',
        name: '正常',
        status: 'active',
        parentId: null,
        countryOptionId: null,
        businessAmount: null,
        currencyCode: null,
        parent: null,
        countryOption: null
      }
    ]);

    const result = await service.listSelectorGroups(['country', 'id_status', 'id_supplier']);

    expect(prisma.idBusinessV2Option.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.idBusinessV2Option.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'active',
          deletedAt: null,
          OR: expect.arrayContaining([
            expect.objectContaining({ type: 'country' }),
            expect.objectContaining({ type: 'id_status' }),
            expect.objectContaining({ type: 'id_supplier' })
          ])
        })
      })
    );
    expect(result.country.items).toHaveLength(1);
    expect(result.country.items[0]).toMatchObject({ status: 'active' });
    expect(result.id_status.items).toHaveLength(1);
    expect(result.id_supplier.items).toEqual([]);
  });

  it('includes disabled selectors only when explicitly requested', async () => {
    prisma.idBusinessV2Option.findMany.mockResolvedValue([
      {
        id: 'supplier-active',
        type: 'id_supplier',
        code: 'supplier_active',
        name: '启用供应商',
        status: 'active',
        parentId: null,
        countryOptionId: null,
        businessAmount: null,
        currencyCode: null,
        parent: null,
        countryOption: null
      },
      {
        id: 'supplier-disabled',
        type: 'id_supplier',
        code: 'supplier_disabled',
        name: '停用供应商',
        status: 'disabled',
        parentId: null,
        countryOptionId: null,
        businessAmount: null,
        currencyCode: null,
        parent: null,
        countryOption: null
      }
    ]);

    const result = await service.listSelectors('id_supplier', undefined, 'true');

    expect(prisma.idBusinessV2Option.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: 'id_supplier',
          status: undefined,
          deletedAt: null
        })
      })
    );
    expect(result.items).toEqual([
      expect.objectContaining({ id: 'supplier-active', status: 'active' }),
      expect.objectContaining({ id: 'supplier-disabled', status: 'disabled' })
    ]);
  });

  it('rejects invalid include-disabled selector flags', async () => {
    await expect(service.listSelectors('id_supplier', undefined, 'yes')).rejects.toThrow(
      '包含停用选项参数格式无效'
    );
    expect(prisma.idBusinessV2Option.findMany).not.toHaveBeenCalled();
  });

  it('requires an active option of the exact requested type', async () => {
    const country = {
      id: '10000000-0000-4000-8000-000000000030',
      type: 'country' as const,
      code: 'country_us',
      name: '美国',
      parentId: null
    };
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(country);

    await expect(service.requireActiveOption(country.id, 'country', '国家')).resolves.toEqual(
      country
    );
    expect(prisma.idBusinessV2Option.findFirst).toHaveBeenCalledWith({
      where: {
        id: country.id,
        type: 'country',
        status: 'active',
        deletedAt: null
      },
      select: {
        id: true,
        type: true,
        code: true,
        name: true,
        parentId: true
      }
    });
  });

  it('rejects unavailable options and preserves requested order for option collections', async () => {
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(null);

    await expect(
      service.requireActiveOption(
        '10000000-0000-4000-8000-000000000031',
        'customer_source',
        '客户来源'
      )
    ).rejects.toThrow('客户来源不存在或已停用');

    const tagA = {
      id: '10000000-0000-4000-8000-000000000032',
      type: 'customer_tag' as const,
      code: 'customer_tag_a',
      name: '标签 A',
      parentId: null
    };
    const tagB = {
      id: '10000000-0000-4000-8000-000000000033',
      type: 'customer_tag' as const,
      code: 'customer_tag_b',
      name: '标签 B',
      parentId: null
    };
    prisma.idBusinessV2Option.findMany.mockResolvedValue([tagA, tagB]);

    await expect(
      service.requireActiveOptions([tagB.id, tagA.id, tagB.id], 'customer_tag', '客户标签')
    ).resolves.toEqual([tagB, tagA]);
  });

  it('creates a service with a global category, country, amount, and derived currency', async () => {
    const category = {
      id: '10000000-0000-4000-8000-000000000021',
      type: 'business_category' as const,
      name: 'AI服务'
    };
    const country = {
      id: '10000000-0000-4000-8000-000000000020',
      type: 'country' as const,
      code: 'country_us',
      name: '美国',
      currencyCode: 'USD'
    };
    const created = makeOption({
      type: 'service',
      name: 'ChatGPT Plus',
      parentId: category.id,
      parent: category,
      countryOptionId: country.id,
      countryOption: country,
      businessAmount: new Prisma.Decimal('20'),
      uniqueKey: `service:${country.id}:${category.id}:chatgpt plus`
    });
    prisma.idBusinessV2Option.findFirst
      .mockResolvedValueOnce(category)
      .mockResolvedValueOnce(country)
      .mockResolvedValueOnce(null);
    prisma.idBusinessV2Option.create.mockResolvedValue(created);

    const result = await service.create(
      {
        type: 'service',
        name: 'ChatGPT Plus',
        parentId: category.id,
        countryOptionId: country.id,
        businessAmount: '20',
        sortOrder: 20
      },
      operator
    );

    expect(prisma.idBusinessV2Option.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'service',
          parentId: category.id,
          countryOptionId: country.id,
          businessAmount: '20',
          name: 'ChatGPT Plus',
          sortOrder: 20
        })
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'id_business_v2.option.create',
          objectId: created.id,
          userId: operator.id
        })
      })
    );
    expect(result.parent?.name).toBe('AI服务');
    expect(result.country?.name).toBe('美国');
    expect(result.currencyCode).toBe('USD');
  });

  it('rejects a child option when the required parent is unavailable', async () => {
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(null);

    await expect(
      service.create({
        type: 'service',
        name: 'ChatGPT Plus',
        parentId: '10000000-0000-4000-8000-000000000099',
        countryOptionId: '10000000-0000-4000-8000-000000000020',
        businessAmount: '20'
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.idBusinessV2Option.create).not.toHaveBeenCalled();
  });

  it('rejects fees on option types other than settlement platforms', async () => {
    await expect(
      service.create({
        type: 'id_supplier',
        name: '供应商A',
        fixedFee: '1.5'
      })
    ).rejects.toThrow('只有结算平台可以设置手续费');
  });

  it('stores settlement fees as decimal strings', async () => {
    const created = makeOption({
      type: 'settlement_platform',
      name: '平台A',
      fixedFee: new Prisma.Decimal('0.5'),
      percentageFee: new Prisma.Decimal('1.25'),
      uniqueKey: 'settlement_platform:root:平台a'
    });
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(null);
    prisma.idBusinessV2Option.create.mockResolvedValue(created);

    const result = await service.create({
      type: 'settlement_platform',
      name: '平台A',
      fixedFee: '0.500',
      percentageFee: '1.250'
    });

    expect(prisma.idBusinessV2Option.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fixedFee: '0.5',
          percentageFee: '1.25'
        })
      })
    );
    expect(result.fixedFee).toBe('0.5');
    expect(result.percentageFee).toBe('1.25');
  });

  it('keeps option write and audit in the same awaited transaction', async () => {
    const created = makeOption({
      type: 'settlement_platform',
      name: '平台B',
      uniqueKey: 'settlement_platform:root:平台b'
    });
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(null);
    prisma.idBusinessV2Option.create.mockResolvedValue(created);
    prisma.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(
      service.create({ type: 'settlement_platform', name: '平台B' }, operator)
    ).rejects.toThrow('audit unavailable');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.idBusinessV2Option.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('returns a conflict for a non-idempotent uniqueness race without replaying the write', async () => {
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(null);
    prisma.idBusinessV2Option.create.mockRejectedValueOnce({ code: 'P2002' });

    await expect(
      service.create({ type: 'settlement_platform', name: '平台C' }, operator)
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.idBusinessV2Option.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('prevents editing a system fixed status', async () => {
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(
      makeOption({
        type: 'id_status',
        code: 'normal',
        name: '正常',
        uniqueKey: 'id_status:root:正常',
        isSystem: true
      })
    );

    await expect(service.update('system-normal', { name: '可用' }, operator)).rejects.toThrow(
      '系统固定选项不能修改或删除'
    );
    expect(prisma.idBusinessV2Option.update).not.toHaveBeenCalled();
  });

  it('prevents disabling a parent that has active children', async () => {
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(
      makeOption({
        type: 'country',
        name: '美国',
        uniqueKey: 'country:root:美国',
        currencyCode: 'USD',
        _count: { children: 0, servicesByCountry: 1, accountsByCountry: 0 }
      })
    );
    prisma.idBusinessV2Option.count.mockResolvedValue(1);

    await expect(
      service.update('country-us', { status: 'disabled' }, operator)
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.idBusinessV2Option.update).not.toHaveBeenCalled();
  });

  it('soft deletes a business category and its dependent services', async () => {
    const category = makeOption({
      type: 'business_category',
      name: 'AI服务',
      uniqueKey: 'business_category:root:ai服务'
    });
    const dependentService = makeOption({
      id: '10000000-0000-4000-8000-000000000011',
      type: 'service',
      name: 'ChatGPT Plus',
      uniqueKey: 'service:country:category:chatgpt plus',
      parentId: category.id
    });
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(category);
    prisma.idBusinessV2Option.findMany.mockResolvedValue([dependentService]);
    prisma.idBusinessV2Option.update.mockResolvedValue({});

    await expect(
      service.remove(
        'category-ai',
        deleteFingerprint(category, { ...zeroOptionImpact, dependentServiceCount: 1 }),
        operator
      )
    ).resolves.toEqual({
      deleted: true,
      cascadedServiceCount: 1,
      disabledSupplierWalletCount: 0
    });
    expect(prisma.idBusinessV2Option.update).toHaveBeenCalledWith({
      where: { id: dependentService.id },
      data: expect.objectContaining({
        uniqueKey: `deleted:${dependentService.id}:${dependentService.uniqueKey}`,
        status: 'disabled',
        deletedAt: expect.any(Date)
      })
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ objectId: dependentService.id })
      })
    );
  });

  it('prevents disabling a country that is still used by an active ID', async () => {
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(
      makeOption({
        type: 'country',
        name: '美国',
        uniqueKey: 'country:root:美国',
        currencyCode: 'USD',
        _count: { children: 0, servicesByCountry: 0, accountsByCountry: 1 }
      })
    );
    prisma.idBusinessV2Option.count.mockResolvedValue(0);
    prisma.idBusinessV2Account.count.mockResolvedValue(1);

    await expect(service.update('country-us', { status: 'disabled' }, operator)).rejects.toThrow(
      '该国家仍有 ID 资料使用，不能停用'
    );
    expect(prisma.idBusinessV2Option.update).not.toHaveBeenCalled();
  });

  it('rejects deleting a country that still has an active ID reference', async () => {
    const country = makeOption({
      type: 'country',
      name: '美国',
      uniqueKey: 'country:root:美国',
      currencyCode: 'USD',
      _count: { children: 0, servicesByCountry: 0, accountsByCountry: 1 }
    });
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(country);
    prisma.idBusinessV2Account.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    prisma.idBusinessV2Option.update.mockResolvedValue({});

    await expect(
      service.remove(
        'country-us',
        deleteFingerprint(country, {
          ...zeroOptionImpact,
          accountReferenceCount: 1,
          activeAccountCount: 1
        }),
        operator
      )
    ).rejects.toThrow('仍有 1 个启用 ID 引用该选项');
    expect(prisma.idBusinessV2Option.update).not.toHaveBeenCalled();
  });

  it('returns a deterministic delete preview and reports every blocking dependency', async () => {
    const serviceOption = makeOption({ type: 'service', name: 'ChatGPT Plus' });
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(serviceOption);
    prisma.idBusinessV2Order.count.mockResolvedValueOnce(4).mockResolvedValueOnce(2);
    prisma.idBusinessV2Activation.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);

    const result = await service.getDeletePreview(serviceOption.id);

    expect(result).toMatchObject({
      entityId: serviceOption.id,
      canDelete: false,
      impact: {
        orderReferenceCount: 4,
        activeOrderCount: 2,
        activationReferenceCount: 3,
        activeActivationCount: 1
      },
      blockingReasons: [
        '仍有 2 个进行中订单引用该选项或其业务',
        '仍有 1 个活动开通记录引用该选项或其业务'
      ]
    });
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(prisma.idBusinessV2Activation.count).toHaveBeenNthCalledWith(2, {
      where: {
        serviceOptionId: { in: [serviceOption.id] },
        status: 'active',
        order: { is: { balanceReturns: { none: { status: 'active' } } } }
      }
    });
  });

  it('rejects a delete when dependencies changed after the preview', async () => {
    const option = makeOption();
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(option);

    await expect(service.remove(option.id, '0'.repeat(64), operator)).rejects.toBeInstanceOf(
      ConflictException
    );

    expect(prisma.idBusinessV2Option.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('disables supplier wallets when deleting a top-up supplier', async () => {
    const supplier = makeOption({
      id: '10000000-0000-4000-8000-000000000020',
      type: 'topup_supplier',
      code: 'supplier-a',
      name: '加卡供应商 A',
      uniqueKey: 'topup_supplier:root:加卡供应商 a'
    });
    prisma.idBusinessV2Option.findFirst.mockResolvedValue(supplier);
    prisma.idBusinessV2TopupSupplierAccount.updateMany.mockResolvedValue({ count: 2 });
    prisma.idBusinessV2Option.update.mockResolvedValue({});

    await expect(
      service.remove('supplier-a', deleteFingerprint(supplier), operator)
    ).resolves.toEqual({
      deleted: true,
      cascadedServiceCount: 0,
      disabledSupplierWalletCount: 2
    });
    expect(prisma.idBusinessV2TopupSupplierAccount.updateMany).toHaveBeenCalledWith({
      where: {
        supplierOptionId: '10000000-0000-4000-8000-000000000020',
        status: 'active'
      },
      data: {
        status: 'disabled',
        disabledByOptionDeletionAt: expect.any(Date),
        updatedByUserId: operator.id
      }
    });
  });
});
