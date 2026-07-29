import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2CustomersService } from './id-business-v2-customers.service';

const operator = {
  id: '20000000-0000-4000-8000-000000000001',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

const source = { id: 'source-1', code: 'wechat', name: '微信' };
const tag = { id: 'tag-1', code: 'vip', name: '重点客户' };
const serviceOption = {
  id: 'service-1',
  code: 'chatgpt',
  name: 'ChatGPT Plus',
  parent: { id: 'category-1', name: 'AI 服务' }
};

function makeCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'customer-1',
    name: '测试客户',
    phoneEncrypted: 'encrypted-phone',
    phoneHash: 'phone-hash',
    phoneMasked: '138****8000',
    phoneTail: '00138000',
    wechat: 'wx-test',
    sourceOptionId: source.id,
    recordStatus: 'active',
    remark: null,
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
    createdAt: new Date('2026-07-26T00:00:00.000Z'),
    updatedAt: new Date('2026-07-26T00:00:00.000Z'),
    deletedAt: null,
    sourceOption: source,
    tags: [{ customerId: 'customer-1', optionId: tag.id, createdAt: new Date(), option: tag }],
    services: [
      {
        customerId: 'customer-1',
        optionId: serviceOption.id,
        createdAt: new Date(),
        option: serviceOption
      }
    ],
    ...overrides
  };
}

describe('IdBusinessV2CustomersService', () => {
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2Customer: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    sensitiveAccessLog: {
      create: vi.fn()
    }
  };
  const auditLogsService = { create: vi.fn() };
  const encryptionService = {
    encrypt: vi.fn(),
    decrypt: vi.fn(),
    hash: vi.fn()
  };
  const optionsService = {
    requireActiveOption: vi.fn(),
    requireActiveOptions: vi.fn()
  };
  const service = new IdBusinessV2CustomersService(
    prisma as never,
    auditLogsService as never,
    encryptionService as never,
    optionsService as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations)
    );
    encryptionService.encrypt.mockImplementation((value: string | null) =>
      value ? `encrypted:${value}` : null
    );
    encryptionService.hash.mockImplementation((value: string | null) =>
      value ? `hash:${value}` : null
    );
    encryptionService.decrypt.mockReturnValue('13800138000');
    optionsService.requireActiveOption.mockResolvedValue(source);
    optionsService.requireActiveOptions
      .mockResolvedValueOnce([tag])
      .mockResolvedValueOnce([serviceOption]);
    auditLogsService.create.mockResolvedValue({ id: 'audit-1' });
  });

  it('lists customers by stable business order without exposing a numeric sort value', async () => {
    prisma.idBusinessV2Customer.findMany.mockResolvedValue([makeCustomer()]);
    prisma.idBusinessV2Customer.count.mockResolvedValue(1);

    const result = await service.list({});

    expect(result.items[0]).not.toHaveProperty('sortOrder');
    expect(prisma.idBusinessV2Customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }]
      })
    );
  });

  it('encrypts customer phone, stores option relations and keeps plaintext out of audit', async () => {
    prisma.idBusinessV2Customer.create.mockResolvedValue(makeCustomer());

    const result = await service.create(
      {
        name: '测试客户',
        phone: '138 0013 8000',
        sourceOptionId: source.id,
        tagOptionIds: [tag.id],
        serviceOptionIds: [serviceOption.id]
      },
      operator
    );

    expect(encryptionService.encrypt).toHaveBeenCalledWith('13800138000');
    expect(prisma.idBusinessV2Customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phoneEncrypted: 'encrypted:13800138000',
          phoneHash: 'hash:13800138000',
          sourceOptionId: source.id,
          tags: { create: [{ optionId: tag.id }] },
          services: { create: [{ optionId: serviceOption.id }] }
        })
      })
    );
    expect(result.maskedPhone).toBe('138****8000');
    expect(JSON.stringify(result)).not.toContain('encrypted-phone');
    expect(JSON.stringify(auditLogsService.create.mock.calls)).not.toContain('13800138000');
  });

  it('writes a sensitive access log when revealing a phone', async () => {
    prisma.idBusinessV2Customer.findFirst.mockResolvedValue(makeCustomer());

    const result = await service.revealPhone('customer-1', { reason: '处理客户续费' }, operator, {
      ip: '127.0.0.1',
      userAgent: 'vitest'
    });

    expect(result.phone).toBe('13800138000');
    expect(prisma.sensitiveAccessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          module: 'id_business_v2_customer',
          fieldName: 'phone',
          accessReason: '处理客户续费'
        })
      })
    );
    expect(JSON.stringify(auditLogsService.create.mock.calls)).not.toContain('13800138000');
  });

  it('rejects phone reveal without the sensitive permission', async () => {
    await expect(
      service.revealPhone(
        'customer-1',
        { reason: '测试' },
        { ...operator, roles: [], permissions: ['customer.view'] }
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('soft deletes a customer and writes an audit log', async () => {
    prisma.idBusinessV2Customer.findFirst.mockResolvedValue(makeCustomer());
    prisma.idBusinessV2Customer.update.mockResolvedValue(makeCustomer({ deletedAt: new Date() }));

    await expect(service.remove('customer-1', operator)).resolves.toEqual({ deleted: true });
    expect(prisma.idBusinessV2Customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deletedAt: expect.any(Date)
        })
      })
    );
    expect(auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'id_business_v2.customer.delete' })
    );
  });
});
